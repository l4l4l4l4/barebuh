// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Crash probe for the federation tests. It runs one pull page through the real commit path and
// exits without committing, exactly like a process killed mid-page.
//
// Phases (BAREBUH_CRASH_PHASE):
//   * "uncommitted_page": the peer is pinned, a caller transaction is opened, one feed page is
//     committed into that transaction, and the process exits before COMMIT. The test asserts that
//     reopening the database shows neither the page's records nor an advanced cursor, and that a
//     replay of the same page converges.
//   * "mid_run": one page is committed for real through the same code path and the process exits
//     before the next page. The test asserts that a later run resumes from the committed cursor.
//
// Without BAREBUH_CRASH_DB the file does nothing, so it is inert when the test runner collects it.

import { readFileSync } from "node:fs";

import { readPeer } from "../src/federation/peers.mjs";
import { commitFeedPage } from "../src/federation/replicator.mjs";
import { openDatabase } from "../src/store/db.mjs";
import { recordIdOf } from "./fixtures.mjs";

const databasePath = process.env.BAREBUH_CRASH_DB;
if (databasePath) {
  const phase = process.env.BAREBUH_CRASH_PHASE;
  const nodeId = process.env.BAREBUH_CRASH_PEER;
  const cursor = process.env.BAREBUH_CRASH_CURSOR;
  const checkpoint = process.env.BAREBUH_CRASH_CHECKPOINT;
  const now = process.env.BAREBUH_CRASH_NOW;
  const items = JSON.parse(process.env.BAREBUH_CRASH_DOCS).map(path => {
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    return { envelope, record_id: recordIdOf(envelope) };
  });

  const db = openDatabase(databasePath);
  const peer = readPeer(db, nodeId);
  if (peer === null) {
    console.error(`crash probe: peer is not pinned: ${nodeId}`);
    process.exit(8);
  }

  if (phase === "uncommitted_page") {
    // The caller's transaction is the page boundary: everything commitFeedPage writes joins it, so
    // a kill before the outer COMMIT must leave nothing behind.
    db.exec("BEGIN IMMEDIATE");
    commitFeedPage(db, { checkpoint, cursor, hasMore: true, items, now, peer });
    process.exit(7);
  }

  if (phase === "mid_run") {
    // A real, committed page - the crash happens before the next page is even fetched.
    commitFeedPage(db, { checkpoint: cursor, cursor, hasMore: true, items, now, peer });
    process.exit(7);
  }

  console.error(`crash probe: unknown phase: ${phase}`);
  process.exit(8);
}
