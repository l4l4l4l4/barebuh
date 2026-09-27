// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupDatabase, checkDatabase, migrateDatabase, openDatabase, restoreCheck } from "../src/store/db.mjs";

const migrationsDir = new URL("../migrations/", import.meta.url);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "barebuh-registry-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("migration creates the authoritative and projection schema with hardened pragmas", async t => {
  const directory = await temporaryDirectory(t);
  const databasePath = join(directory, "registry.sqlite3");

  const first = await migrateDatabase(databasePath, { migrationsDir });
  const second = await migrateDatabase(databasePath, { migrationsDir });
  assert.equal(first.applied, 1);
  assert.equal(second.applied, 0);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);

  using db = openDatabase(databasePath, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all().map(row => row.name);
  for (const table of ["records", "record_parents", "record_sources", "record_policy", "materialize_queue", "station_state", "station_projection", "station_fts"]) {
    assert.ok(tables.includes(table), `missing ${table}`);
  }
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.ok(db.prepare("PRAGMA compile_options").all().some(row => row.compile_options === "ENABLE_FTS5"));
  assert.deepEqual(checkDatabase(db), { foreignKeyViolations: [], quickCheck: "ok", schemaVersion: 1 });
});

test("migration hashes are immutable and newer databases are rejected", async t => {
  const directory = await temporaryDirectory(t);
  const databasePath = join(directory, "registry.sqlite3");
  const copiedMigrations = join(directory, "migrations");
  await import("node:fs/promises").then(({ cp }) => cp(migrationsDir, copiedMigrations, { recursive: true }));
  await chmod(copiedMigrations, 0o700);
  await migrateDatabase(databasePath, { migrationsDir: copiedMigrations });

  const migrationPath = join(copiedMigrations, "0001-initial.sql");
  await chmod(migrationPath, 0o600);
  await writeFile(migrationPath, `${await readFile(migrationPath, "utf8")}\n-- tampered\n`);
  await assert.rejects(migrateDatabase(databasePath, { migrationsDir: copiedMigrations }), /hash mismatch/u);

  using db = openDatabase(databasePath);
  db.exec("PRAGMA user_version = 99");
  await assert.rejects(migrateDatabase(databasePath, { migrationsDir }), /newer than this binary/u);
});

test("online backup is integrity-checked and restorable without network access", async t => {
  const directory = await temporaryDirectory(t);
  const databasePath = join(directory, "registry.sqlite3");
  const backupPath = join(directory, "registry.backup.sqlite3");
  await migrateDatabase(databasePath, { migrationsDir });

  const backupResult = await backupDatabase(databasePath, backupPath);
  assert.ok(backupResult.pages >= 1);
  assert.match(backupResult.sha256, /^[0-9a-f]{64}$/u);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  assert.deepEqual(await restoreCheck(backupPath), { foreignKeyViolations: [], quickCheck: "ok", schemaVersion: 1 });

  using tampered = openDatabase(backupPath);
  tampered.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
  tampered.close();
  await assert.rejects(restoreCheck(backupPath), /migration hash mismatch/u);
});
