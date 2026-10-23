// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Writes a small signed station history (genesis plus one update) into the directory given as the
// first argument and prints the station ID, for CLI and packaging smoke tests. Without an argument
// the file does nothing, so the test runner can collect it safely.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSigner, recordIdOf, stationBody, stationRecord } from "./fixtures.mjs";

const directory = process.argv[2];
if (directory) {
  const signer = createSigner("station");
  const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Smoke Test FM", { streams: 2, tags: ["Jazz"], languages: ["en"] }) });
  const update = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Smoke Test FM renewed", { tags: ["Jazz", "Talk"] }) });
  writeFileSync(join(directory, "envelope-0.json"), JSON.stringify(genesis));
  writeFileSync(join(directory, "envelope-1.json"), JSON.stringify(update));
  console.log(signer.identity);
}
