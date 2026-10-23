// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Materializer behaviour: the shared DAG fixture, restart persistence, fork/merge/tombstone
// convergence, corruption detection and repair, bounded queue work, and crash safety.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { canonicalize, parseJsonStrict } from "../../protocol/v1/lib/conformance.mjs";
import { classifyStationRecords } from "../src/store/dag.mjs";
import { computeStationMaterialization } from "../src/store/dag.mjs";
import { checkDatabase, LATEST_SCHEMA_VERSION } from "../src/store/db.mjs";
import { compareSearchRows, drainMaterializeQueue, materializeStation, normalizeText, rebuildProjection, stationReport, storedStationSnapshot, verifyProjection } from "../src/store/materialize.mjs";
import { enqueueStation, INGEST_STATUS, ingestDocument, setRecordPolicy } from "../src/store/records.mjs";
import { countRows, createRegistry, createSigner, recordIdOf, stationBody, stationRecord, streamUrl, VALIDATION_TIME } from "./fixtures.mjs";

const cases = parseJsonStrict(readFileSync(new URL("../../protocol/v1/fixtures/interoperability-cases.json", import.meta.url)));

function ingest(registry, envelope, options = {}) {
  const { expect = INGEST_STATUS.stored, ...rest } = options;
  const result = ingestDocument(registry.db, Buffer.from(JSON.stringify(envelope)), { validationTime: VALIDATION_TIME, ...rest });
  assert.equal(result.status, expect, result.message ?? "");
  return result;
}

function lexicographicWinner(ids) {
  return [...ids].sort()[0];
}

// The fixture's labelled records, shaped exactly like the materializer's station view.
function labelled(ids) {
  return ids.map(id => {
    const record = cases.dag.records.find(item => item.id === id);
    return { recordId: id, kind: "station", subjectId: "oradio:station:ed25519:fixture", sequence: record.sequence, parents: record.parents, isTombstone: record.deleted, materializable: true, policy: "admitted" };
  });
}

test("the shared DAG fixture materializes exactly as the interoperability fixture expects", () => {
  const orphan = computeStationMaterialization(labelled(["B"]));
  assert.deepEqual(orphan.tips, []);
  assert.equal(orphan.state, "orphan_only");

  const promoted = computeStationMaterialization(labelled(["B", "G"]));
  assert.deepEqual(promoted.tips, ["B"]);
  assert.equal(promoted.forked, false);
  assert.equal(promoted.protocolWinner, "B");
  assert.equal(promoted.visibleWinner, "B");
  assert.equal(promoted.state, "active");

  const fork = computeStationMaterialization(labelled(["B", "G", "C"]));
  assert.deepEqual(fork.tips, cases.dag.expected.fork_tips);
  assert.equal(fork.forked, true);
  assert.equal(fork.protocolWinner, cases.dag.expected.fork_winner);

  const merged = computeStationMaterialization(labelled(["B", "G", "C", "M"]));
  assert.deepEqual(merged.tips, ["M"]);
  assert.equal(merged.protocolWinner, cases.dag.expected.merge_winner);

  const tombstoned = computeStationMaterialization(labelled(["B", "G", "C", "M", "T"]));
  assert.deepEqual(tombstoned.tips, cases.dag.expected.final_tips);
  assert.equal(tombstoned.protocolWinner, cases.dag.expected.final_winner);
  assert.equal(tombstoned.state, "tombstoned");

  // Input order must not matter: the same set converges to the same state.
  const orders = [
    cases.dag.arrival_order,
    [...cases.dag.arrival_order].reverse(),
    ["T", "M", "C", "B", "G"],
  ];
  const results = orders.map(order => computeStationMaterialization(labelled(order)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(classifyStationRecords(labelled(["B", "G", "C", "M", "T"])).valid.get("T"), true);
});

test("a station DAG materializes deterministically across restart: orphan, promotion, fork, merge, tombstone", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Alpha", { streams: 2, tags: ["Jazz", "jazz "], languages: ["en", "en-US"] }) });
  const forkA = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha A") });
  const forkB = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha B") });
  const merge = stationRecord(signer, { sequence: 2, parents: [recordIdOf(forkA), recordIdOf(forkB)], station: stationBody("Alpha merged") });
  const tombstone = stationRecord(signer, { sequence: 3, parents: [recordIdOf(merge)], station: { deleted: true } });

  // The first record is an orphan: stored and queued, but nothing is materialized.
  ingest(registry, forkA);
  assert.equal(drainMaterializeQueue(registry.db).processed, 1);
  let report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "orphan_only");
  assert.equal(report.projection, null);
  assert.deepEqual(report.tips, []);

  // The parent arrives: the orphan is promoted and the station becomes visible.
  ingest(registry, genesis);
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "active");
  assert.equal(report.state.visibleWinner, recordIdOf(forkA));
  assert.equal(report.projection.name, "Alpha A");
  assert.deepEqual(report.streams.map(stream => stream.url), [streamUrl(0)]);
  assert.deepEqual(report.tags.map(tag => tag.normalized), []);

  // Same-sequence divergence is a visible fork, and the winner is the smallest record ID.
  ingest(registry, forkB);
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.forked, 1);
  assert.deepEqual(report.tips, [recordIdOf(forkA), recordIdOf(forkB)].sort());
  assert.equal(report.state.visibleWinner, lexicographicWinner([recordIdOf(forkA), recordIdOf(forkB)]));

  // The merge resolves the fork.
  ingest(registry, merge);
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.forked, 0);
  assert.equal(report.state.visibleWinner, recordIdOf(merge));
  assert.equal(report.projection.name, "Alpha merged");

  // The tombstone wins, and the projection is removed.
  ingest(registry, tombstone);
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "tombstoned");
  assert.equal(report.state.visibleWinner, recordIdOf(tombstone));
  assert.equal(report.projection, null);
  assert.deepEqual(report.tips, [recordIdOf(tombstone)]);

  // Restart: the tombstone survives, and an older record cannot resurrect the station.
  registry.reopen();
  const older = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Zombie") });
  ingest(registry, older);
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "tombstoned");
  assert.equal(report.state.visibleWinner, recordIdOf(tombstone));
  assert.equal(report.state.forked, 1, "the older record is a second tip");
  assert.equal(report.projection, null);
  assert.equal(countRows(registry.db, "records"), 6, "every record stays stored, including the one that lost");
});

test("unsupported critical records are stored and relayed but never materialized", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const critical = stationRecord(signer, {
    sequence: 0,
    station: stationBody("Critical"),
    extra: { critical: ["future_feature"], future_feature: { mode: "test" } },
  });
  ingest(registry, critical);
  drainMaterializeQueue(registry.db);
  let report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "unsupported_critical");
  assert.equal(report.state.protocolWinner, null);
  assert.equal(report.projection, null);
  assert.deepEqual(report.tips, [recordIdOf(critical)], "the uninterpretable record is still the tip");

  // Two interpretable forks; a critical record that outranks them cannot win.
  const forkA = stationRecord(signer, { sequence: 1, parents: [recordIdOf(critical)], station: stationBody("A") });
  const forkB = stationRecord(signer, { sequence: 1, parents: [recordIdOf(critical)], station: stationBody("B") });
  const criticalTip = stationRecord(signer, {
    sequence: 2,
    parents: [recordIdOf(forkA)],
    station: stationBody("Critical tip"),
    extra: { critical: ["future_feature"], future_feature: { mode: "test" } },
  });
  for (const envelope of [forkA, forkB, criticalTip]) ingest(registry, envelope);
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "active");
  // forkA is no longer a tip (the uninterpretable record names it as a parent) and the only other
  // tip is not materializable, so the interpretable winner is forkB.
  assert.equal(report.state.visibleWinner, recordIdOf(forkB));
  assert.equal(report.state.protocolWinner, recordIdOf(forkB));
  assert.equal(report.projection.name, "B");
  assert.equal(report.state.forked, 1, "the uninterpretable tip keeps the fork visible");
  assert.deepEqual(report.tips, [recordIdOf(criticalTip), recordIdOf(forkB)].sort());
  assert.equal(countRows(registry.db, "records"), 4);
});

test("local suppression moves the visible winner but never hides the fork or the protocol winner", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Alpha") });
  const forkA = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha A") });
  const forkB = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha B") });
  for (const envelope of [genesis, forkA, forkB]) ingest(registry, envelope);
  drainMaterializeQueue(registry.db);

  const protocolWinner = lexicographicWinner([recordIdOf(forkA), recordIdOf(forkB)]);
  setRecordPolicy(registry.db, protocolWinner, "suppressed");
  drainMaterializeQueue(registry.db);
  let report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "active");
  assert.equal(report.state.protocolWinner, protocolWinner);
  assert.notEqual(report.state.visibleWinner, protocolWinner);
  assert.equal(report.state.forked, 1, "suppression never hides a fork");

  // Suppressing every tip leaves the station locally suppressed, and that survives restart.
  setRecordPolicy(registry.db, report.state.visibleWinner, "suppressed");
  drainMaterializeQueue(registry.db);
  registry.reopen();
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "suppressed");
  assert.equal(report.state.protocolWinner, protocolWinner);
  assert.equal(report.state.visibleWinner, null);
  assert.equal(report.projection, null);

  // Admitting a record again restores the projection.
  setRecordPolicy(registry.db, protocolWinner, "admitted");
  drainMaterializeQueue(registry.db);
  report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "active");
  assert.equal(report.state.visibleWinner, protocolWinner);
});

test("materialization is a no-op when the derived content did not change", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Stable", { tags: ["Jazz"] }) });
  const ingested = ingest(registry, genesis);
  const first = materializeStation(registry.db, signer.identity);
  assert.equal(first.changed, true);
  const stateRow = () => registry.db.prepare("SELECT generation, materialized_at FROM station_state WHERE station_id = ?").get(signer.identity);
  const meta = () => registry.db.prepare("SELECT generation FROM projection_meta WHERE singleton = 1").get().generation;
  const before = { state: { ...stateRow() }, meta: meta() };

  const second = materializeStation(registry.db, signer.identity);
  assert.equal(second.changed, false);
  assert.deepEqual(second.differences, []);
  assert.deepEqual({ state: { ...stateRow() }, meta: meta() }, before);

  // A duplicate ingest, a drain, and a restart all leave the projection untouched.
  ingest(registry, genesis, { expect: INGEST_STATUS.duplicate });
  drainMaterializeQueue(registry.db);
  registry.reopen();
  drainMaterializeQueue(registry.db);
  assert.deepEqual({ state: { ...stateRow() }, meta: meta() }, before);
  assert.equal(verifyProjection(registry.db).mismatches.length, 0);
  assert.equal(ingested.recordId, recordIdOf(genesis));
});

test("identical record sets materialize identically regardless of arrival order", async t => {
  const orderings = [
    ["genesis", "forkA", "forkB", "merge", "tombstone"],
    ["tombstone", "merge", "forkB", "forkA", "genesis"],
  ];
  const digests = [];
  for (const ordering of orderings) {
    const registry = await createRegistry(t);
    const signer = createSigner("station");
    const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Alpha", { streams: 2 }) });
    const forkA = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha A") });
    const forkB = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha B") });
    const merge = stationRecord(signer, { sequence: 2, parents: [recordIdOf(forkA), recordIdOf(forkB)], station: stationBody("Alpha merged") });
    const tombstone = stationRecord(signer, { sequence: 3, parents: [recordIdOf(merge)], station: { deleted: true } });
    const envelopes = { genesis, forkA, forkB, merge, tombstone };
    for (const name of ordering) ingest(registry, envelopes[name]);
    drainMaterializeQueue(registry.db);
    // Each registry signs with its own key, so record IDs differ between runs. Map every record ID
    // onto its sequence number to compare the two runs structurally.
    const sequences = new Map(registry.db.prepare("SELECT record_id, station_sequence FROM records WHERE subject_id = ?").all(signer.identity).map(row => [row.record_id, row.station_sequence]));
    const snapshot = storedStationSnapshot(registry.db, signer.identity);
    const labelled = id => (id === null ? null : sequences.get(id) ?? id);
    digests.push(canonicalize({
      state: snapshot.state === null ? null : { ...snapshot.state, protocolWinner: labelled(snapshot.state.protocolWinner), visibleWinner: labelled(snapshot.state.visibleWinner) },
      tips: snapshot.tips.map(labelled),
      projection: snapshot.projection === null ? null : { ...snapshot.projection, visibleRecordId: labelled(snapshot.projection.visibleRecordId) },
      fts: snapshot.fts,
    }));
    registry.close();
  }
  assert.equal(digests[0], digests[1]);
  assert.match(digests[0], /"state":"tombstoned"/u);
  assert.match(digests[0], /"visibleWinner":3/u, "the tombstone (sequence 3) is the visible winner in both runs");
});

test("corrupted projection rows are detected by verify and repaired deterministically by rebuild", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  ingest(registry, stationRecord(signer, { sequence: 0, station: stationBody("Alpha", { streams: 2, tags: ["Jazz"], country: "US" }) }));
  drainMaterializeQueue(registry.db);
  const reference = canonicalize(storedStationSnapshot(registry.db, signer.identity));
  assert.deepEqual(verifyProjection(registry.db), { checked: 1, materializerVersion: 2, mismatches: [] });

  const tamper = statements => {
    registry.db.exec("BEGIN IMMEDIATE");
    for (const statement of statements) registry.db.exec(statement);
    registry.db.exec("COMMIT");
  };
  tamper([
    "UPDATE station_projection SET name = 'tampered', normalized_name = 'tampered'",
    "UPDATE station_streams SET url = 'https://evil.example/x' WHERE ordinal = 0",
    "UPDATE station_fts SET tags = 'nonsense'",
    "UPDATE station_state SET state = 'suppressed', visible_record_id = NULL",
    "DELETE FROM station_tips",
  ]);
  const verification = verifyProjection(registry.db);
  assert.equal(verification.mismatches.length, 1);
  assert.deepEqual(verification.mismatches[0].differences, ["state", "tips", "projection", "streams", "fts"]);

  const generationBefore = registry.db.prepare("SELECT generation FROM station_state WHERE station_id = ?").get(signer.identity).generation;
  const rebuild = rebuildProjection(registry.db);
  assert.equal(rebuild.forced, false);
  assert.deepEqual(rebuild.changed, [signer.identity]);
  assert.deepEqual(verifyProjection(registry.db).mismatches, []);
  assert.equal(canonicalize(storedStationSnapshot(registry.db, signer.identity)), reference, "repair must reproduce the derived content exactly");
  assert.equal(registry.db.prepare("SELECT generation FROM station_state WHERE station_id = ?").get(signer.identity).generation, generationBefore + 1);
  const secondRebuild = rebuildProjection(registry.db);
  assert.deepEqual(secondRebuild.changed, [], "a clean rebuild is a no-op");
});

test("stray projection rows for stations without records are reconciled and materializer version changes force a rebuild", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  ingest(registry, stationRecord(signer, { sequence: 0, station: stationBody("Alpha") }));
  drainMaterializeQueue(registry.db);

  registry.db.exec("BEGIN IMMEDIATE");
  registry.db.prepare("INSERT INTO station_state(station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at) VALUES ('oradio:station:ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', NULL, NULL, 'orphan_only', 0, 1, '2026-09-26T12:00:00Z')").run();
  registry.db.exec("UPDATE projection_meta SET materializer_version = 1");
  registry.db.exec("COMMIT");
  const verification = verifyProjection(registry.db);
  assert.equal(verification.mismatches.length, 2);
  assert.equal(verification.mismatches.find(mismatch => mismatch.kind === "materializer_version").actual, 1);

  const rebuild = rebuildProjection(registry.db);
  assert.equal(rebuild.forced, true);
  assert.ok(rebuild.changed.includes(signer.identity));
  assert.deepEqual(verifyProjection(registry.db).mismatches, []);
  assert.equal(countRows(registry.db, "station_state"), 1, "the stray row is gone");
});

test("a queue drain is bounded and a failing station is recorded without losing other work", async t => {
  const registry = await createRegistry(t);
  const signers = [createSigner("station"), createSigner("station"), createSigner("station")];
  for (const signer of signers) ingest(registry, stationRecord(signer, { sequence: 0, station: stationBody(signer.identity) }));
  assert.equal(countRows(registry.db, "materialize_queue"), 3);
  assert.throws(() => drainMaterializeQueue(registry.db, { limit: 0 }), /positive safe integer/u);

  const first = drainMaterializeQueue(registry.db, { limit: 2 });
  assert.equal(first.processed, 2);
  assert.equal(first.failed, 0);
  assert.equal(first.remaining, 1);
  const second = drainMaterializeQueue(registry.db, { limit: 2 });
  assert.equal(second.processed, 1);
  assert.equal(second.remaining, 0);

  // Corrupt one station's immutable payload (simulating torn storage), re-queue it, and drain:
  // the failure is recorded and the row stays queued for the next attempt.
  registry.db.exec("BEGIN IMMEDIATE");
  registry.db.prepare("UPDATE records SET canonical_payload = x'6e6f742d6a736f6e' WHERE subject_id = ?").run(signers[0].identity);
  registry.db.exec("COMMIT");
  enqueueStation(registry.db, signers[0].identity, "2026-09-26T12:30:00Z");
  const failed = drainMaterializeQueue(registry.db, { limit: 10 });
  assert.equal(failed.failed, 1);
  assert.equal(failed.remaining, 1);
  const queueRow = registry.db.prepare("SELECT attempts, last_error FROM materialize_queue WHERE station_id = ?").get(signers[0].identity);
  assert.equal(queueRow.attempts, 1);
  assert.ok(queueRow.last_error.length > 0);
  assert.equal(countRows(registry.db, "station_state"), 3, "the other stations stay materialized");
});

test("a killed process cannot commit a partial station update and the committed backlog converges after restart", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Alpha") });
  const update = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha renewed") });
  const documents = [genesis, update].map((envelope, index) => {
    const path = join(registry.directory, `envelope-${index}.json`);
    writeFileSync(path, JSON.stringify(envelope));
    return path;
  });

  const probe = spawnSync(process.execPath, [fileURLToPath(new URL("crash-probe.mjs", import.meta.url))], {
    env: { ...process.env, BAREBUH_CRASH_DB: registry.databasePath, BAREBUH_CRASH_DOCS: JSON.stringify(documents) },
    encoding: "utf8",
  });
  assert.equal(probe.status, 7, probe.stderr || probe.stdout);

  registry.reopen();
  assert.deepEqual(checkDatabase(registry.db), { foreignKeyViolations: [], quickCheck: "ok", schemaVersion: LATEST_SCHEMA_VERSION });
  assert.equal(countRows(registry.db, "records"), 2, "committed records survived the kill");
  assert.equal(countRows(registry.db, "materialize_queue"), 1, "the probe's uncommitted queue row was rolled back; only the station is queued");
  assert.equal(countRows(registry.db, "station_state"), 0, "nothing was materialized by the probe");

  const drained = drainMaterializeQueue(registry.db);
  assert.equal(drained.processed, 1);
  const report = stationReport(registry.db, signer.identity);
  assert.equal(report.state.state, "active");
  assert.equal(report.state.visibleWinner, recordIdOf(update));
});

test("interoperable search ordering and search normalization", () => {
  const ordered = [...cases.search.candidates]
    .map(candidate => ({ score: candidate.score, normalizedName: normalizeText(candidate.name), stationId: candidate.id }))
    .sort(compareSearchRows);
  assert.deepEqual(ordered.map(candidate => candidate.stationId), cases.search.expected_order);

  assert.equal(normalizeText("Example É FM"), "example e fm");
  assert.equal(normalizeText("  Beyoncé   Live "), "beyonce live");
  assert.equal(normalizeText("JAZZ"), "jazz");
  assert.equal(normalizeText("İstanbul"), "istanbul");
});
