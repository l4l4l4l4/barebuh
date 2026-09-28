// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupDatabase, checkDatabase, LATEST_SCHEMA_VERSION, migrateDatabase, openDatabase, restoreCheck } from "../src/store/db.mjs";

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
  assert.equal(first.applied, 2);
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
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.ok(db.prepare("PRAGMA compile_options").all().some(row => row.compile_options === "ENABLE_FTS5"));
  assert.deepEqual(checkDatabase(db), { foreignKeyViolations: [], quickCheck: "ok", schemaVersion: 2 });
});

test("the committed schema version matches the highest migration and the ledger", async t => {
  const directory = await temporaryDirectory(t);
  const databasePath = join(directory, "registry.sqlite3");
  await migrateDatabase(databasePath, { migrationsDir });

  const files = (await readdir(migrationsDir)).filter(name => name.endsWith(".sql")).sort();
  assert.equal(files.at(-1).slice(0, 4), String(LATEST_SCHEMA_VERSION).padStart(4, "0"));

  using db = openDatabase(databasePath, { readOnly: true });
  const ledger = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(ledger.map(row => row.version), files.map((_, index) => index + 1));
  assert.equal(ledger.length, LATEST_SCHEMA_VERSION);
  // Derived-store indexes: orphan promotion looks up children by parent record ID.
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map(row => row.name);
  for (const index of ["records_kind_subject_idx", "record_parents_parent_idx", "station_projection_name_idx", "materialize_queue_order_idx"]) {
    assert.ok(indexes.includes(index), `missing ${index}`);
  }
});

test("schema-1 databases migrate to the materializer schema without rewriting stored state", async t => {
  const directory = await temporaryDirectory(t);
  const databasePath = join(directory, "registry.sqlite3");
  const schema1Migrations = join(directory, "migrations-1");
  await cp(migrationsDir, schema1Migrations, { recursive: true });
  await rm(join(schema1Migrations, "0002-materializer.sql"));

  // Build a schema-1 database and give it a station state row exactly as schema 1 allowed it.
  const first = await migrateDatabase(databasePath, { migrationsDir: schema1Migrations });
  assert.equal(first.applied, 1);
  using legacy = openDatabase(databasePath);
  legacy.exec("BEGIN IMMEDIATE");
  legacy.prepare("INSERT INTO records(record_id, protocol, kind, subject_id, station_sequence, issued_at, canonical_payload, relay_envelope, proof_signature, materializable, is_tombstone, unsupported_critical_json, inserted_at) VALUES (?, 'oradio/1', 'station', 'oradio:station:ed25519:x', 0, '2026-09-26T12:00:00Z', x'7b7d', x'7b7d', x'00', 1, 0, '[]', '2026-09-26T12:00:00Z')").run("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  legacy.prepare("INSERT INTO station_state(station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at) VALUES (?, ?, ?, 'active', 0, 3, '2026-09-26T12:00:00Z')")
    .run("oradio:station:ed25519:x", "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  legacy.exec("COMMIT");
  legacy.close();

  const upgraded = await migrateDatabase(databasePath, { migrationsDir });
  assert.equal(upgraded.applied, 1);
  assert.equal(upgraded.schemaVersion, 2);
  using db = openDatabase(databasePath, { readOnly: true });
  assert.deepEqual(db.prepare("SELECT station_id, state, generation, forked FROM station_state").all().map(row => ({ ...row })),
                   [{ station_id: "oradio:station:ed25519:x", state: "active", generation: 3, forked: 0 }]);

  // The rebuilt table accepts the schema-2 states and a null protocol winner, and still rejects
  // unknown states.
  using writable = openDatabase(databasePath);
  writable.exec("BEGIN IMMEDIATE");
  writable.prepare("INSERT INTO station_state(station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at) VALUES ('oradio:station:ed25519:y', NULL, NULL, 'quarantined', 0, 1, '2026-09-26T13:00:00Z')").run();
  writable.exec("COMMIT");
  assert.throws(() => writable.prepare("INSERT INTO station_state(station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at) VALUES ('z', NULL, NULL, 'invented', 0, 1, '2026-09-26T13:00:00Z')").run(), /CHECK/u);
});

test("migration hashes are immutable and newer databases are rejected", async t => {
  const directory = await temporaryDirectory(t);
  const databasePath = join(directory, "registry.sqlite3");
  const copiedMigrations = join(directory, "migrations");
  await cp(migrationsDir, copiedMigrations, { recursive: true });
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
  assert.deepEqual(await restoreCheck(backupPath), { foreignKeyViolations: [], quickCheck: "ok", schemaVersion: 2 });

  using tampered = openDatabase(backupPath);
  tampered.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
  tampered.close();
  await assert.rejects(restoreCheck(backupPath), /migration hash mismatch/u);
});
