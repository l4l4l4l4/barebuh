// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

// The schema version this binary expects. It must equal the highest committed migration
// (db.test.mjs pins that invariant) and is what `serve` requires before it listens.
export const LATEST_SCHEMA_VERSION = 3;

const MIGRATION_PATTERN = /^(?<version>[0-9]{4})-(?<name>[a-z0-9-]+)\.sql$/u;
const SQLITE_LIMITS = Object.freeze({
  length: 2 * 1024 * 1024,
  sqlLength: 256 * 1024,
  column: 256,
  exprDepth: 100,
  compoundSelect: 16,
  functionArg: 32,
  attach: 0,
  likePatternLength: 4096,
  variableNumber: 1024,
  triggerDepth: 16,
});

function migrationsPath(value) {
  return value instanceof URL ? fileURLToPath(value) : resolve(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadMigrations(directory) {
  const path = migrationsPath(directory);
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const migrations = [];
  let expected = 1;
  for (const entry of entries) {
    const match = entry.name.match(MIGRATION_PATTERN);
    if (!match) throw new Error(`invalid migration filename: ${entry.name}`);
    const version = Number(match.groups.version);
    if (version !== expected) throw new Error(`migration sequence must be contiguous at ${entry.name}`);
    const bytes = await readFile(resolve(path, entry.name));
    migrations.push({ version, name: entry.name, sql: bytes.toString("utf8"), sha256: sha256(bytes) });
    ++expected;
  }
  if (migrations.length === 0) throw new Error("no migrations found");
  return migrations;
}

export function openDatabase(path, { readOnly = false } = {}) {
  const db = new DatabaseSync(path, {
    readOnly,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    defensive: true,
    timeout: 5000,
    limits: SQLITE_LIMITS,
  });
  db.enableLoadExtension(false);
  db.enableDefensive(true);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL;");
  if (!readOnly) db.exec("PRAGMA journal_mode = DELETE;");
  return db;
}

// Every write in the store runs inside BEGIN IMMEDIATE: the process may be killed at any point
// and SQLite's rollback journal guarantees that only fully committed state survives restart.
//
// A call made while a transaction is already open joins that transaction instead of opening a
// nested one (SQLite has no nested BEGIN): the caller that opened the transaction owns the
// commit, and an error anywhere rolls the whole thing back. This is what lets a page commit
// (federation/replicator.mjs) compose store writes and peer-cursor state into one atomic unit,
// and what lets the crash probe emulate a process killed mid-commit.
export function withTransaction(db, action) {
  if (db.isTransaction) return action();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function verifyMigrationLedger(db, migrations) {
  const currentVersion = migrations.at(-1).version;
  const databaseVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (databaseVersion > currentVersion) throw new Error(`database schema ${databaseVersion} is newer than this binary (${currentVersion})`);
  const applied = tableExists(db, "schema_migrations")
    ? db.prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version").all()
    : [];
  for (const row of applied) {
    const migration = migrations.find(item => item.version === row.version);
    if (!migration || migration.name !== row.name || migration.sha256 !== row.sha256) {
      throw new Error(`migration hash mismatch at version ${row.version}`);
    }
  }
  if (applied.length !== databaseVersion) throw new Error("schema migration ledger does not match user_version");
  return databaseVersion;
}

export function checkDatabase(db) {
  const quickRows = db.prepare("PRAGMA quick_check").all();
  const quickCheck = quickRows.map(row => row.quick_check).join(",");
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  const schemaVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (quickCheck !== "ok") throw new Error(`database quick_check failed: ${quickCheck}`);
  if (foreignKeyViolations.length !== 0) throw new Error("database foreign_key_check failed");
  return { foreignKeyViolations, quickCheck, schemaVersion };
}

export async function migrateDatabase(databasePath, { migrationsDir = new URL("../../migrations/", import.meta.url) } = {}) {
  const migrations = await loadMigrations(migrationsDir);
  const currentVersion = migrations.at(-1).version;
  await mkdir(dirname(resolve(databasePath)), { recursive: true, mode: 0o700 });
  using db = openDatabase(databasePath);
  await chmod(databasePath, 0o600);
  const databaseVersion = verifyMigrationLedger(db, migrations);

  let appliedCount = 0;
  for (const migration of migrations.filter(item => item.version > databaseVersion)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, sha256, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, migration.sha256, new Date().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      ++appliedCount;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  const checks = checkDatabase(db);
  return { applied: appliedCount, ...checks };
}

export async function restoreCheck(databasePath, { migrationsDir = new URL("../../migrations/", import.meta.url) } = {}) {
  const migrations = await loadMigrations(migrationsDir);
  using db = openDatabase(databasePath, { readOnly: true });
  const databaseVersion = verifyMigrationLedger(db, migrations);
  if (databaseVersion !== migrations.at(-1).version) throw new Error("backup schema is not current");
  return checkDatabase(db);
}

export async function backupDatabase(databasePath, destinationPath) {
  const finalPath = resolve(destinationPath);
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
  await rm(temporaryPath, { force: true });
  using db = openDatabase(databasePath, { readOnly: true });
  let completed = false;
  try {
    const pages = await backup(db, temporaryPath);
    await chmod(temporaryPath, 0o600);
    await restoreCheck(temporaryPath);
    const digest = sha256(await readFile(temporaryPath));
    await rename(temporaryPath, finalPath);
    completed = true;
    return { pages, sha256: digest };
  } finally {
    if (!completed) await rm(temporaryPath, { force: true });
  }
}
