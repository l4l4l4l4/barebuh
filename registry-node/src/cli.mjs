#!/usr/bin/env node
// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { loadConfig } from "./config.mjs";
import { createRegistryServer } from "./http.mjs";
import { backupDatabase, checkDatabase, LATEST_SCHEMA_VERSION, migrateDatabase, openDatabase, restoreCheck } from "./store/db.mjs";

function usage() {
  console.error("usage: registry-node <serve|migrate|check-db|backup|restore-check|effective-config> [path]");
  process.exitCode = 2;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
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
