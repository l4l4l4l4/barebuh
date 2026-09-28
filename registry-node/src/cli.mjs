#!/usr/bin/env node
// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";

import { loadConfig } from "./config.mjs";
import { createRegistryServer } from "./http.mjs";
import { backupDatabase, checkDatabase, LATEST_SCHEMA_VERSION, migrateDatabase, openDatabase, restoreCheck } from "./store/db.mjs";
import { drainMaterializeQueue, materializeStation, rebuildProjection, stationReport, verifyProjection } from "./store/materialize.mjs";
import { INGEST_LIMITS, ingestDocument, setRecordPolicy } from "./store/records.mjs";

function usage() {
  console.error("usage: registry-node <serve|migrate|check-db|backup|restore-check|effective-config|ingest|drain|materialize|rebuild|check-projection|station|set-policy> [argument]");
  process.exitCode = 2;
}

// Write commands refuse to run when the schema is not current: operating on an older schema is how
// records and projections drift apart. The check is the same one `serve` performs.
function openCurrent(config) {
  const db = openDatabase(config.databasePath);
  const checks = checkDatabase(db);
  if (checks.schemaVersion !== LATEST_SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema ${checks.schemaVersion} is not current (expected ${LATEST_SCHEMA_VERSION}); run migrate first`);
  }
  return db;
}

// `-` reads the envelope from stdin, which keeps secrets out of the process list and out of the
// shell history. Stdin is bounded by the same limit the store enforces.
async function readInput(argument) {
  if (argument !== "-") return readFile(argument);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > INGEST_LIMITS.maxDocumentBytes) throw new Error(`stdin input exceeds the ${INGEST_LIMITS.maxDocumentBytes} byte ingest limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const [command, argument, second, third] = process.argv.slice(2);
  const config = loadConfig();
  switch (command) {
    case "effective-config":
      console.log(JSON.stringify(config, null, 2));
      return;
    case "migrate":
      console.log(JSON.stringify(await migrateDatabase(config.databasePath)));
      return;
    case "check-db": {
      using db = openDatabase(config.databasePath, { readOnly: true });
      console.log(JSON.stringify(checkDatabase(db)));
      return;
    }
    case "backup":
      if (!argument) return usage();
      console.log(JSON.stringify(await backupDatabase(config.databasePath, argument)));
      return;
    case "restore-check":
      if (!argument) return usage();
      console.log(JSON.stringify(await restoreCheck(argument)));
      return;
    case "ingest": {
      if (!argument) return usage();
      using db = openCurrent(config);
      const result = ingestDocument(db, await readInput(argument), { sourceId: second ?? "admin" });
      // Administrators ingest and materialize in one step; a future replicator will ingest and let
      // the queue drain instead.
      const materialized = result.kind === "station" && result.status !== "quarantined" ? materializeStation(db, result.stationId) : null;
      console.log(JSON.stringify({ ...result, materialized }));
      return;
    }
    case "drain": {
      using db = openCurrent(config);
      console.log(JSON.stringify(drainMaterializeQueue(db, second === undefined ? {} : { limit: Number(second) })));
      return;
    }
    case "materialize": {
      if (!argument) return usage();
      using db = openCurrent(config);
      console.log(JSON.stringify(materializeStation(db, argument)));
      return;
    }
    case "rebuild": {
      using db = openCurrent(config);
      console.log(JSON.stringify(rebuildProjection(db)));
      return;
    }
    case "check-projection": {
      using db = openCurrent(config);
      const report = verifyProjection(db);
      console.log(JSON.stringify(report, null, 2));
      if (report.mismatches.length > 0) process.exitCode = 1;
      return;
    }
    case "station": {
      if (!argument) return usage();
      using db = openCurrent(config);
      console.log(JSON.stringify(stationReport(db, argument), null, 2));
      return;
    }
    case "set-policy": {
      if (!argument || !second) return usage();
      using db = openCurrent(config);
      const record = setRecordPolicy(db, argument, second, third === undefined ? {} : { reasonCode: third });
      const materialized = record.kind === "station" ? materializeStation(db, record.subjectId) : null;
      console.log(JSON.stringify({ record: { recordId: record.recordId, kind: record.kind, subjectId: record.subjectId, policyState: record.policy }, materialized }));
      return;
    }
    case "serve": {
      const db = openDatabase(config.databasePath, { readOnly: true });
      const checks = checkDatabase(db);
      if (checks.schemaVersion !== LATEST_SCHEMA_VERSION) throw new Error("database schema is not current; run migrate first");
      const server = createRegistryServer({ config, db });
      server.on("close", () => db.close());
      server.listen(config.port, config.host, () => {
        const address = server.address();
        console.log(JSON.stringify({ event: "listening", address, mode: config.mode }));
      });
      return;
    }
    default:
      usage();
  }
}

await main();
