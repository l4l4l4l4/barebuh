// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Crash probe for the store tests. It migrates the database at BAREBUH_CRASH_DB, ingests the
// envelope files listed in BAREBUH_CRASH_DOCS (a JSON array of paths), then starts a write
// transaction that is never committed and exits non-zero without closing the database, exactly
// like a killed process. The test asserts that every committed record survived and that the
// uncommitted write was rolled back on the next open.
//
// Without BAREBUH_CRASH_DB the file does nothing, so it is inert when the test runner collects it.

import { readFileSync } from "node:fs";

import { migrateDatabase, openDatabase } from "../src/store/db.mjs";
import { ingestDocument } from "../src/store/records.mjs";

const databasePath = process.env.BAREBUH_CRASH_DB;
if (databasePath) {
  const documents = JSON.parse(process.env.BAREBUH_CRASH_DOCS);
  await migrateDatabase(databasePath);
  const db = openDatabase(databasePath);
  for (const path of documents) ingestDocument(db, readFileSync(path));
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO materialize_queue(station_id, enqueued_at) VALUES ('oradio:station:ed25519:probe-uncommitted', '2026-09-26T12:00:00Z')").run();
  process.exit(7);
}
