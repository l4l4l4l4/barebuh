// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The bounded pull replicator and its peer state machine: explicit pins, identity proof, per-item
// verification, quarantine evidence, atomic page/cursor commits, budgets, deduplication,
// provenance, backoff/jitter/circuit breaking, peer isolation, and crash replay.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalize } from "../../protocol/v1/lib/conformance.mjs";
import { loadConfig } from "../src/config.mjs";
import { addPeer, listPeers, normalizePeerPin, PEER_LIMITS, readPeer, recordSnapshotPage, removePeer } from "../src/federation/peers.mjs";
import { PULL_LIMITS, pullPeer, pullPeers } from "../src/federation/replicator.mjs";
import { createRegistryServer } from "../src/http.mjs";
import { drainMaterializeQueue, stationReport } from "../src/store/materialize.mjs";
import { ingestDocument } from "../src/store/records.mjs";
import { stationResource } from "../src/store/views.mjs";
import { countRows, createRegistry, createSigner, nodeCardRecord, recordIdOf, stationBody, stationRecord, VALIDATION_TIME } from "./fixtures.mjs";

const NOW = VALIDATION_TIME;
const PEER_BASE = "https://peer.example/v1/";
const LIMITS = limits => ({ ...PULL_LIMITS, ...limits });
const deterministic = () => 0; // equal jitter with random()=0 is exactly half the backoff window

// ---------------------------------------------------------------------------------------------
// Scripted peers: a fetch implementation that answers from a plan and records every request, so a
// test can prove exactly which origins were contacted and in which order.
// ---------------------------------------------------------------------------------------------

function responseFrom({ status = 200, body, raw, headers = {} }) {
  const bytes = raw !== undefined ? Buffer.from(raw, "utf8") : body !== undefined ? Buffer.from(JSON.stringify(body), "utf8") : Buffer.alloc(0);
  return {
    status,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  };
}

function scriptedPeer(plan) {
  const requests = [];
  const fetchImpl = async href => {
    const url = new URL(href);
    requests.push(url);
    const spec = plan(url, requests);
    if (spec === undefined) throw new Error(`no scripted response for ${url.pathname}`);
    return responseFrom(spec);
  };
  return {
    fetchImpl,
    requests,
    urls: () => requests.map(request => request.href),
    paths: path => requests.filter(request => request.pathname === path),
  };
}

function pageBody(items, { checkpoint = "c1.checkpoint", nextCursor = null, hasMore = false } = {}) {
  return { items: items.map(({ envelope, recordId }) => ({ envelope, record_id: recordId })), has_more: hasMore, next_cursor: nextCursor, checkpoint };
}

function itemOf(envelope) {
  return { envelope, recordId: recordIdOf(envelope) };
}

// A station history plus a node card, all signed by locally generated keys.
function peerFixture({ count = 2, station = createSigner("station"), nodeSigner = createSigner("node"), card = {} } = {}) {
  const items = [];
  let parents = [];
  for (let sequence = 0; sequence < count; sequence += 1) {
    const envelope = stationRecord(station, { sequence, parents, station: stationBody(`Replicated FM ${sequence}`, { tags: ["replicated"] }) });
    parents = [recordIdOf(envelope)];
    items.push(itemOf(envelope));
  }
  return { station, nodeSigner, items, card: nodeCardRecord(nodeSigner, card) };
}

async function pinnedRegistry(t, { nodeId, label = "peer-a", apiBase = PEER_BASE, pin = true } = {}) {
  const registry = await createRegistry(t);
  if (pin) addPeer(registry.db, { nodeId, apiBase, label, now: NOW });
  return registry;
}

// ---------------------------------------------------------------------------------------------
// Pin admission
// ---------------------------------------------------------------------------------------------

test("peers are pinned by an operator only, with bounded validation and a hard quota", async t => {
  const registry = await createRegistry(t);
  const nodeSigner = createSigner("node");

  assert.deepEqual(normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "peer-a" }),
                   { nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "peer-a" });

  // A node identity must be a real node digest, not any string with the right prefix.
  assert.throws(() => normalizePeerPin({ nodeId: "oradio:node:ed25519:short", apiBase: PEER_BASE, label: "peer" }), /node identity/u);
  assert.throws(() => normalizePeerPin({ nodeId: `oradio:station:ed25519:${nodeSigner.identity.slice(-43)}`, apiBase: PEER_BASE, label: "peer" }), /node identity/u);
  assert.throws(() => normalizePeerPin({ nodeId: `oradio:node:ed25519:${nodeSigner.identity.slice(-43)}=`, apiBase: PEER_BASE, label: "peer" }), /node identity/u);

  // The wire contract is HTTPS; plain HTTP is loopback-only because that is the private listener.
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: "http://peer.example/v1/", label: "peer" }), /HTTPS/u);
  assert.equal(normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: "http://127.0.0.1:8080/v1/", label: "peer" }).apiBase, "http://127.0.0.1:8080/v1/");
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: "https://user:pass@peer.example/v1/", label: "peer" }), /credentials/u);
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: "https://peer.example/v1/?x=1", label: "peer" }), /query or fragment/u);
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: "https://peer.example/v1", label: "peer" }), /end with a slash/u);
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: "not a url", label: "peer" }), /absolute URL|end with a slash/u);
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "" }), /label/u);
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "bad label" }), /label/u);
  assert.throws(() => normalizePeerPin({ nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "x".repeat(PEER_LIMITS.maxLabelBytes + 1) }), /label/u);

  const peer = addPeer(registry.db, { nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "peer-a", now: NOW });
  assert.deepEqual(peer, {
    apiBase: PEER_BASE,
    backoffUntil: null,
    checkpoint: null,
    circuitOpenUntil: null,
    consecutiveFailures: 0,
    cursorUpdatedAt: null,
    feedCursor: null,
    label: "peer-a",
    lastAttemptAt: null,
    lastError: null,
    lastSuccessAt: null,
    nodeId: nodeSigner.identity,
    pagesCommitted: 0,
    pinnedAt: NOW,
    recordsStored: 0,
    snapshotCursor: null,
  });
  assert.throws(() => addPeer(registry.db, { nodeId: nodeSigner.identity, apiBase: PEER_BASE, label: "peer-a" }), /already pinned/u);

  // The quota is a hard bound on how many origins this node will ever talk to.
  assert.equal(PEER_LIMITS.maxPeers, 32);
  for (let index = 1; index < PEER_LIMITS.maxPeers; index += 1) {
    const signer = createSigner("node");
    addPeer(registry.db, { nodeId: signer.identity, apiBase: `https://peer-${index}.example/v1/`, label: `peer-${index}`, now: NOW });
  }
  assert.equal(listPeers(registry.db).length, PEER_LIMITS.maxPeers);
  const overflow = createSigner("node");
  assert.throws(() => addPeer(registry.db, { nodeId: overflow.identity, apiBase: "https://overflow.example/v1/", label: "overflow", now: NOW }), /at most 32 peers/u);

  // Unpinning removes the pull source only: stored records and their provenance are data, not peer
  // state, so they stay.
  assert.equal(removePeer(registry.db, nodeSigner.identity), true);
  assert.equal(removePeer(registry.db, nodeSigner.identity), false);
  assert.equal(readPeer(registry.db, nodeSigner.identity), null);
  assert.equal(listPeers(registry.db).length, PEER_LIMITS.maxPeers - 1);
});

// ---------------------------------------------------------------------------------------------
// The happy path against a real peer node
// ---------------------------------------------------------------------------------------------

test("a pinned peer is pulled through its card, feed, storage, projection, and provenance", async t => {
  const LATER = "2026-09-26T12:25:00Z";
  const peerSigner = createSigner("node");
  const station = createSigner("station");
  const genesis = stationRecord(station, { sequence: 0, station: stationBody("Replicated FM", { country: "RS", tags: ["jazz"] }) });
  const update = stationRecord(station, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Replicated FM HD", { country: "RS", tags: ["jazz"] }) });

  // A real peer node: its own migrated database, its own HTTP surface, its own node card.
  const peer = await createRegistry(t);
  for (const envelope of [nodeCardRecord(peerSigner, {}), genesis]) {
    assert.equal(ingestDocument(peer.db, Buffer.from(JSON.stringify(envelope)), { now: NOW, sourceId: "peer-fixture" }).status, "stored");
  }
  const peerConfig = loadConfig({
    BAREBUH_DATABASE_PATH: peer.databasePath,
    BAREBUH_FEDERATION_ENABLED: "true",
    BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION",
    BAREBUH_NODE_ID: peerSigner.identity,
    BAREBUH_PORT: "0",
    BAREBUH_PUBLIC_BASE_URL: "https://registry.example/",
  });
  const server = createRegistryServer({ config: peerConfig, db: peer.db, clock: () => NOW });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const local = await pinnedRegistry(t, { nodeId: peerSigner.identity, apiBase: `http://127.0.0.1:${server.address().port}/v1/` });
  const outcome = await pullPeer(local.db, peerSigner.identity, { now: NOW, random: deterministic });

  assert.deepEqual(outcome, {
    cursor_advanced: true,
    duplicates: 0,
    items: 1,
    nodeId: peerSigner.identity,
    pages: 1,
    quarantined: 0,
    snapshot_pages: 0,
    status: "pulled",
    stored: 1,
  });
  assert.equal(countRows(local.db, "records"), 1, "the peer's records are stored locally");
  assert.equal(countRows(local.db, "federation_peers"), 1, "pulling never pins another peer");

  // Provenance points at the peer.
  const sources = local.db.prepare("SELECT source_kind, source_id, COUNT(*) AS records FROM record_sources GROUP BY source_kind, source_id").all().map(row => ({ ...row }));
  assert.deepEqual(sources, [{ source_kind: "peer", source_id: peerSigner.identity, records: 1 }]);

  const drained = drainMaterializeQueue(local.db);
  assert.deepEqual({ processed: drained.processed, failed: drained.failed, remaining: drained.remaining }, { processed: 1, failed: 0, remaining: 0 });
  const report = stationReport(local.db, station.identity);
  assert.equal(report.state.state, "active");
  assert.equal(report.state.visibleWinner, recordIdOf(genesis));
  assert.equal(report.consistent, true);

  // No explicit receipt is stamped yet (the station had no projection row when the page was
  // committed), so the served receipt falls back to the local receipt time of the stored records.
  assert.equal(local.db.prepare("SELECT last_replication_at FROM station_state WHERE station_id = ?").get(station.identity).last_replication_at, null);
  assert.equal(stationResource(local.db, station.identity, { observerId: null, nowIso: NOW }).last_replication_at, NOW);

  // The peer publishes a new revision and the local node pulls it: the station already has a
  // projection row, so this page writes the explicit replication receipt.
  assert.equal(ingestDocument(peer.db, Buffer.from(JSON.stringify(update)), { now: LATER, sourceId: "peer-fixture" }).status, "stored");
  const second = await pullPeer(local.db, peerSigner.identity, { now: LATER, random: deterministic });
  assert.equal(second.status, "pulled");
  assert.equal(second.stored, 1);
  assert.equal(second.duplicates, 0);
  assert.equal(local.db.prepare("SELECT last_replication_at FROM station_state WHERE station_id = ?").get(station.identity).last_replication_at, LATER);
  assert.equal(drainMaterializeQueue(local.db).processed, 1);

  // The served station is a canonical copy of the signed payload, and the view reports the receipt
  // the replicator committed.
  const view = stationResource(local.db, station.identity, { observerId: null, nowIso: LATER });
  assert.equal(view.last_replication_at, LATER);
  assert.equal(view.winning_record_id, recordIdOf(update));
  assert.equal(canonicalize(view.station), canonicalize(update.payload.station));

  // A third pull is a no-op: the checkpoint is resumed, nothing is re-stored, and no generation
  // churns.
  const again = await pullPeer(local.db, peerSigner.identity, { now: LATER, random: deterministic });
  assert.deepEqual(again, {
    cursor_advanced: false,
    duplicates: 0,
    items: 0,
    nodeId: peerSigner.identity,
    pages: 1,
    quarantined: 0,
    snapshot_pages: 0,
    status: "up_to_date",
    stored: 0,
  });
  assert.equal(countRows(local.db, "records"), 2);
  assert.equal(local.db.prepare("SELECT last_replication_at FROM station_state WHERE station_id = ?").get(station.identity).last_replication_at, LATER);
  assert.equal(drainMaterializeQueue(local.db).processed, 0, "an idempotent re-pull queues no work");
  assert.deepEqual(verifyPeersRow(local.db, peerSigner.identity), {
    checkpoint: readPeer(local.db, peerSigner.identity).feedCursor,
    consecutiveFailures: 0,
    pagesCommitted: 3,
    recordsStored: 2,
  });
});

function verifyPeersRow(db, nodeId) {
  const peer = readPeer(db, nodeId);
  return { checkpoint: peer.checkpoint, consecutiveFailures: peer.consecutiveFailures, pagesCommitted: peer.pagesCommitted, recordsStored: peer.recordsStored };
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

test("the peer must prove the pinned identity before a single record is pulled", async t => {
  const peerSigner = createSigner("node");
  const otherSigner = createSigner("node");
  const fixture = peerFixture({ count: 1, nodeSigner: peerSigner });
  const local = await pinnedRegistry(t, { nodeId: peerSigner.identity });
  const cases = [
    { name: "unavailable card", card: { status: 503 }, code: "peer_card_unavailable" },
    { name: "wrong identity", card: { body: nodeCardRecord(otherSigner, {}) }, code: "peer_identity_mismatch" },
    { name: "not a node card", card: { body: fixture.items[0].envelope }, code: "peer_identity_mismatch" },
    { name: "expired card", card: { body: nodeCardRecord(peerSigner, { issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T11:00:00Z" }) }, code: "peer_card_invalid" },
    { name: "unsupported major", card: { body: nodeCardRecord(peerSigner, { extra: { supported_majors: [2] } }) }, code: "peer_unsupported_major" },
    { name: "not json", card: { raw: "<html>not json</html>" }, code: "peer_card_invalid" },
  ];

  for (const scenario of cases) {
    const scripted = scriptedPeer(url => {
      if (url.pathname === "/v1/node") return scenario.card;
      return { status: 200, body: pageBody(fixture.items) };
    });
    const outcome = await pullPeer(local.db, peerSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic });
    assert.equal(outcome.status, "failed", scenario.name);
    assert.equal(outcome.error.code, scenario.code, scenario.name);
    assert.equal(scripted.paths("/v1/records").length, 0, `${scenario.name}: the feed is never read before the identity is proven`);
    assert.equal(countRows(local.db, "records"), 0, scenario.name);
    assert.equal(readPeer(local.db, peerSigner.identity).feedCursor, null, scenario.name);
    assert.equal(readPeer(local.db, peerSigner.identity).consecutiveFailures, 1, scenario.name);
    removePeer(local.db, peerSigner.identity);
    addPeer(local.db, { nodeId: peerSigner.identity, apiBase: PEER_BASE, label: "peer-a", now: NOW });
  }
});

// ---------------------------------------------------------------------------------------------
// Item verification, quarantine evidence, and deduplication
// ---------------------------------------------------------------------------------------------

test("invalid items become bounded quarantine evidence while valid siblings are stored and deduplicated", async t => {
  const fixture = peerFixture({ count: 2 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  // A validly published ID over a mutated payload: the signature no longer verifies.
  const tamperedEnvelope = structuredClone(fixture.items[0].envelope);
  tamperedEnvelope.payload.station.name = "Tampered FM";
  const tampered = { envelope: tamperedEnvelope, recordId: recordIdOf(tamperedEnvelope) };
  // A published ID that does not match the recomputed one, and an item that is not even shaped like
  // a record.
  const wrongId = { envelope: fixture.items[1].envelope, recordId: `sha256:${"B".repeat(43)}` };
  const malformed = { envelope: "not an object", recordId: fixture.items[1].recordId };
  const page = pageBody([fixture.items[0], tampered, wrongId, malformed, fixture.items[1]], { checkpoint: "c1.checkpoint", nextCursor: "c1.page-2", hasMore: true });

  const scripted = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: fixture.card } : { body: page }));
  const outcome = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic, limits: LIMITS({ maxPagesPerRun: 1 }) });

  assert.equal(outcome.status, "budget_exhausted", "the walk continued past the page instead of failing it");
  assert.equal(outcome.stored, 2);
  assert.equal(outcome.duplicates, 0);
  assert.equal(outcome.quarantined, 3);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.page-2", "the page's cursor is committed with its records");

  // The valid records are stored once, even though one of them was published twice in the page.
  assert.equal(countRows(local.db, "records"), 2);
  assert.deepEqual(local.db.prepare("SELECT record_id FROM records ORDER BY ingest_seq").all().map(row => row.record_id), [fixture.items[0].recordId, fixture.items[1].recordId]);

  // Every invalid sibling is evidence: bounded bytes, stable reason codes, and the peer as source.
  const quarantined = local.db.prepare("SELECT source_kind, source_id, failure_stage, reason_code, length(bounded_raw_envelope) AS bytes, expires_at FROM quarantine ORDER BY reason_code").all().map(row => ({ ...row }));
  assert.deepEqual(quarantined, [
    { source_kind: "peer", source_id: fixture.nodeSigner.identity, failure_stage: "parse", reason_code: "peer_item_malformed", bytes: 0, expires_at: "2026-10-26T12:20:00.000Z" },
    { source_kind: "peer", source_id: fixture.nodeSigner.identity, failure_stage: "validation", reason_code: "record_id_mismatch", bytes: Buffer.byteLength(JSON.stringify(fixture.items[1].envelope)), expires_at: "2026-10-26T12:20:00.000Z" },
    { source_kind: "peer", source_id: fixture.nodeSigner.identity, failure_stage: "validation", reason_code: "validation_error", bytes: Buffer.byteLength(JSON.stringify(tamperedEnvelope)), expires_at: "2026-10-26T12:20:00.000Z" },
  ]);

  // Quarantine evidence is local: the tampered variant never becomes a record, so it can never be
  // served back to a consumer.
  assert.equal(local.db.prepare("SELECT COUNT(*) AS count FROM records WHERE record_id = ?").get(recordIdOf(tamperedEnvelope)).count, 0);
});

test("a duplicate page replay is deduplicated and never churns the projection", async t => {
  const fixture = peerFixture({ count: 2 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  const page = pageBody(fixture.items, { checkpoint: "c1.checkpoint" });
  const scripted = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: fixture.card } : { body: page }));

  const first = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic });
  assert.equal(first.stored, 2);
  const generation = local.db.prepare("SELECT generation FROM station_state WHERE station_id = ?").get(fixture.station.identity) ?? null;
  drainMaterializeQueue(local.db);
  const materialized = local.db.prepare("SELECT generation, state FROM station_state WHERE station_id = ?").get(fixture.station.identity);

  // The same page served again as a fresh walk stores nothing new: the records are
  // content-addressed, so a replayed page is idempotent.
  const replay = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic, limits: LIMITS({ maxPagesPerRun: 1 }) });
  assert.equal(replay.status, "up_to_date");
  assert.equal(replay.stored, 0);
  assert.equal(countRows(local.db, "records"), 2);
  assert.equal(countRows(local.db, "materialize_queue"), 0, "a replayed page queues no new materialization");
  assert.deepEqual(local.db.prepare("SELECT generation, state FROM station_state WHERE station_id = ?").get(fixture.station.identity), materialized);
  assert.equal(generation, null, "nothing was materialized before the drain");
  assert.equal(drainMaterializeQueue(local.db).processed, 0);
});

// ---------------------------------------------------------------------------------------------
// Corrupt pages, loops, and the pull budget
// ---------------------------------------------------------------------------------------------

test("a corrupt page fails the attempt atomically and feeds the backoff clock", async t => {
  const fixture = peerFixture({ count: 1 });
  const good = pageBody(fixture.items, { checkpoint: "c1.checkpoint" });
  const cases = [
    { name: "not json", response: { raw: "}{" }, code: "peer_invalid_response" },
    { name: "json array", response: { body: [1, 2, 3] }, code: "peer_invalid_response" },
    { name: "items not an array", response: { body: { ...good, items: "nope" } }, code: "peer_invalid_response" },
    { name: "too many items", response: { body: { ...good, items: [good.items[0], good.items[0], good.items[0]] } }, code: "peer_invalid_response", limits: { pageLimit: 2 } },
    { name: "has_more not a boolean", response: { body: { ...good, has_more: "no" } }, code: "peer_invalid_response" },
    { name: "missing checkpoint", response: { body: { ...good, checkpoint: null } }, code: "peer_invalid_response" },
    { name: "non-final page without cursor", response: { body: { ...good, has_more: true } }, code: "peer_invalid_response" },
    { name: "unbounded cursor", response: { body: { ...good, has_more: true, next_cursor: "c1." + "a".repeat(5000) } }, code: "peer_invalid_response" },
    { name: "server error", response: { status: 500, body: { error: { code: "internal_error" } } }, code: "peer_http_error" },
    { name: "unsupported status", response: { status: 304, body: {} }, code: "peer_http_error" },
    { name: "repeated cursor", response: { body: pageBody(fixture.items, { checkpoint: "c1.checkpoint", nextCursor: "c1.same", hasMore: true }) }, code: "peer_invalid_response", expectFetches: 2, records: 1, cursor: "c1.same" },
    { name: "response over the byte budget", response: { raw: JSON.stringify({ ...good, padding: "x".repeat(4096) }) }, code: "peer_response_too_large" },
  ];

  for (const scenario of cases) {
    const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
    const scripted = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: fixture.card } : scenario.response));
    const overrides = { ...(scenario.limits ?? {}), ...(scenario.code === "peer_response_too_large" ? { maxResponseBytes: 1024 } : {}) };
    const outcome = await pullPeer(local.db, fixture.nodeSigner.identity, {
      fetchImpl: scripted.fetchImpl,
      limits: LIMITS(overrides),
      now: NOW,
      random: deterministic,
    });

    assert.equal(outcome.status, "failed", scenario.name);
    assert.equal(outcome.error.code, scenario.code, scenario.name);
    assert.equal(outcome.consecutive_failures, 1, scenario.name);
    assert.equal(outcome.backoff_until, "2026-09-26T12:20:00.500Z", `${scenario.name}: half of the first backoff window with zero jitter`);
    assert.equal(outcome.circuit_open, false, scenario.name);
    assert.equal(scripted.paths("/v1/records").length, scenario.expectFetches ?? 1, `${scenario.name}: the walk stops at the bad page`);
    assert.equal(countRows(local.db, "records"), scenario.records ?? 0, `${scenario.name}: only fully committed pages are stored`);
    assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, scenario.cursor ?? null, scenario.name);
    assert.equal(readPeer(local.db, fixture.nodeSigner.identity).lastError, `${scenario.code}: ${outcome.error.message}`, scenario.name);
    assert.equal(countRows(local.db, "quarantine"), 0, `${scenario.name}: a corrupt page is not item-level evidence`);
  }
});

test("retry-after is honored, bounded, and never shorter than the local backoff", async t => {
  const fixture = peerFixture({ count: 1 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  const scripted = scriptedPeer(url => (url.pathname === "/v1/node"
    ? { body: fixture.card }
    : { status: 429, headers: { "retry-after": "2" }, body: { error: { code: "rate_limited" } } }));

  const outcome = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "peer_rate_limited");
  assert.equal(outcome.backoff_until, "2026-09-26T12:20:02.000Z", "the peer's bounded Retry-After wins over the local window");
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).backoffUntil, "2026-09-26T12:20:02.000Z");

  // While the backoff holds, the replicator performs no network I/O at all for this peer.
  const before = scripted.requests.length;
  const skipped = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: "2026-09-26T12:20:01Z", random: deterministic });
  assert.deepEqual(skipped, { nodeId: fixture.nodeSigner.identity, retry_at: "2026-09-26T12:20:02.000Z", status: "backoff", pages: 0, snapshot_pages: 0, items: 0, stored: 0, duplicates: 0, quarantined: 0, cursor_advanced: false });
  assert.equal(scripted.requests.length, before, "a peer in backoff is not contacted");

  // An absurd Retry-After is capped by the local maximum instead of pinning the peer for a week.
  const capped = scriptedPeer(url => (url.pathname === "/v1/node"
    ? { body: fixture.card }
    : { status: 429, headers: { "retry-after": "999999" }, body: { error: { code: "rate_limited" } } }));
  const cappedOutcome = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: capped.fetchImpl, now: "2026-09-26T12:20:03Z", random: deterministic });
  assert.equal(cappedOutcome.status, "failed");
  assert.equal(cappedOutcome.backoff_until, "2026-09-26T12:25:03.000Z", "the cooldown is capped at five minutes");
});

test("the pull budget bounds a runaway peer: page cap, item cap, and a cursor loop", async t => {
  const fixture = peerFixture({ count: 2 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  let page = 0;
  const generous = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    page += 1;
    const cursor = `c1.page-${page}`;
    return { body: pageBody(fixture.items, { checkpoint: cursor, nextCursor: cursor, hasMore: true }) };
  });

  const byPages = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: generous.fetchImpl, limits: LIMITS({ maxPagesPerRun: 3 }), now: NOW, random: deterministic });
  assert.equal(byPages.status, "budget_exhausted");
  assert.equal(byPages.pages, 3);
  assert.equal(byPages.items, 6);
  assert.equal(byPages.stored, 2);
  assert.equal(byPages.duplicates, 4);
  assert.equal(generous.paths("/v1/records").length, 3, "a peer that never ends cannot hold the worker");
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.page-3", "the last committed page is the resume point");

  // The next run resumes from that cursor instead of starting over.
  const resumed = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: generous.fetchImpl, limits: LIMITS({ maxPagesPerRun: 1 }), now: NOW, random: deterministic });
  assert.equal(resumed.status, "budget_exhausted");
  assert.equal(generous.requests.at(-1).searchParams.get("cursor"), "c1.page-3");

  // The item budget stops the walk even when every page is small.
  const pageLoop = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    const cursor = `c1.items-${Math.random()}`;
    return { body: pageBody(fixture.items, { checkpoint: cursor, nextCursor: cursor, hasMore: true }) };
  });
  const byItems = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: pageLoop.fetchImpl, limits: LIMITS({ maxItemsPerRun: 3 }), now: NOW, random: deterministic });
  assert.equal(byItems.status, "budget_exhausted");
  assert.equal(byItems.pages, 2);
  assert.equal(pageLoop.paths("/v1/records").length, 2);

  // A cursor that does not advance is a loop: the walk fails instead of spinning.
  const looping = scriptedPeer(url => (url.pathname === "/v1/node"
    ? { body: fixture.card }
    : { body: pageBody(fixture.items, { checkpoint: "c1.loop", nextCursor: "c1.loop", hasMore: true }) }));
  const looped = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: looping.fetchImpl, now: NOW, random: deterministic });
  assert.equal(looped.status, "failed");
  assert.equal(looped.error.code, "peer_invalid_response");
  assert.match(looped.error.message, /repeated its cursor/u);
  assert.equal(looping.paths("/v1/records").length, 2, "the loop is detected on the second identical cursor");
});

// ---------------------------------------------------------------------------------------------
// Snapshot recovery
// ---------------------------------------------------------------------------------------------

test("410 on the feed cursor recovers through a snapshot import and resumes from the checkpoint", async t => {
  const fixture = peerFixture({ count: 3 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  let feedCalls = 0;
  const scripted = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    if (url.pathname === "/v1/snapshot") {
      const cursor = url.searchParams.get("cursor");
      if (cursor === null) return { body: pageBody(fixture.items.slice(0, 2), { checkpoint: "c1.snapshot-final", nextCursor: "c1.snapshot-1", hasMore: true }) };
      assert.equal(cursor, "c1.snapshot-1");
      return { body: pageBody(fixture.items.slice(2), { checkpoint: "c1.snapshot-final", nextCursor: null, hasMore: false }) };
    }
    feedCalls += 1;
    if (feedCalls === 1) {
      // The recovery URL in the error is the peer's suggestion, and it is never followed: recovery
      // reuses the pinned base.
      return { status: 410, body: { error: { code: "cursor_expired", message: "expired", details: { snapshot: "https://hostile.example/v1/snapshot" } } } };
    }
    return { body: pageBody([], { checkpoint: "c1.snapshot-final" }) };
  });

  const outcome = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic });
  assert.equal(outcome.status, "pulled");
  assert.equal(outcome.snapshot_pages, 2);
  assert.equal(outcome.stored, 3);
  assert.equal(outcome.pages, 1);
  assert.equal(countRows(local.db, "records"), 3);

  // Every request went to the pinned origin - the hostile snapshot URL was ignored.
  assert.deepEqual([...new Set(scripted.urls().map(href => new URL(href).origin))], ["https://peer.example"]);

  const peer = readPeer(local.db, fixture.nodeSigner.identity);
  assert.equal(peer.snapshotCursor, null, "the completed import clears the snapshot cursor");
  assert.equal(peer.feedCursor, "c1.snapshot-final", "the snapshot checkpoint is the new feed resume point");
  assert.equal(peer.lastError, null);
  assert.equal(peer.consecutiveFailures, 0);
  assert.equal(scripted.requests.at(-1).searchParams.get("cursor"), "c1.snapshot-final", "the feed resumes from the checkpoint in the same run");
});

test("an interrupted snapshot import resumes from its cursor, and a rejected cursor restarts once", async t => {
  const fixture = peerFixture({ count: 3 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  const cursors = [];
  const scripted = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    if (url.pathname === "/v1/records") {
      // The feed only answers once a snapshot import has moved the cursor.
      const feedCursor = url.searchParams.get("cursor");
      if (feedCursor === null) return { status: 410, body: { error: { code: "cursor_expired", message: "expired", details: { snapshot: "https://peer.example/v1/snapshot" } } } };
      assert.equal(feedCursor, "c1.snapshot-final");
      return { body: pageBody([], { checkpoint: "c1.snapshot-final" }) };
    }
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    if (cursor === null) return { body: pageBody(fixture.items.slice(0, 2), { checkpoint: "c1.snapshot-final", nextCursor: "c1.snapshot-1", hasMore: true }) };
    if (cursor === "c1.snapshot-1") return { body: pageBody(fixture.items.slice(2), { checkpoint: "c1.snapshot-final", nextCursor: null, hasMore: false }) };
    return { status: 410, body: { error: { code: "cursor_expired", message: "expired", details: { snapshot: "https://peer.example/v1/snapshot" } } } };
  });

  // The first run stops at its snapshot page budget: the cursor state is kept so the import can
  // be resumed, and the feed cursor is not moved.
  const interrupted = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, limits: LIMITS({ maxSnapshotPages: 1 }), now: NOW, random: deterministic });
  assert.equal(interrupted.status, "recovering");
  assert.equal(interrupted.snapshot_pages, 1);
  assert.equal(interrupted.stored, 2);
  const midImport = readPeer(local.db, fixture.nodeSigner.identity);
  assert.equal(midImport.snapshotCursor, "c1.snapshot-1");
  assert.equal(midImport.feedCursor, null, "an unfinished import never advances the feed cursor");

  // The next run resumes from the stored snapshot cursor and finishes: the feed cursor only moves
  // on the final page, so no record can be skipped by a checkpoint that jumped ahead.
  const resumed = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic });
  assert.equal(resumed.status, "pulled");
  assert.deepEqual(cursors, [null, "c1.snapshot-1"], "the resumption asks for the stored snapshot cursor");
  assert.equal(countRows(local.db, "records"), 3);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.snapshot-final");

  // A snapshot cursor the peer rejects is restarted once from the first page.
  const restarted = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity, label: "peer-b" });
  recordSnapshotPage(restarted.db, fixture.nodeSigner.identity, { cursor: "c1.stale-snapshot", checkpoint: "c1.checkpoint", final: false, now: NOW });
  let sawStale = false;
  const restartScript = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    if (url.pathname === "/v1/records") {
      const feedCursor = url.searchParams.get("cursor");
      if (feedCursor === null) return { status: 410, body: { error: { code: "cursor_expired", message: "expired", details: { snapshot: "https://peer.example/v1/snapshot" } } } };
      return { body: pageBody([], { checkpoint: "c1.snapshot-final" }) };
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor === "c1.stale-snapshot") {
      sawStale = true;
      return { status: 410, body: { error: { code: "cursor_expired", message: "expired", details: { snapshot: "https://peer.example/v1/snapshot" } } } };
    }
    assert.equal(cursor, null, "the restart begins at the first snapshot page");
    return { body: pageBody(fixture.items, { checkpoint: "c1.snapshot-final", nextCursor: null, hasMore: false }) };
  });
  const recovered = await pullPeer(restarted.db, fixture.nodeSigner.identity, { fetchImpl: restartScript.fetchImpl, now: NOW, random: deterministic });
  assert.equal(sawStale, true);
  assert.equal(recovered.status, "pulled");
  assert.equal(recovered.stored, 3);
  assert.equal(readPeer(restarted.db, fixture.nodeSigner.identity).feedCursor, "c1.snapshot-final");

  // When the restart is rejected too, the attempt fails instead of looping.
  const doomed = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  recordSnapshotPage(doomed.db, fixture.nodeSigner.identity, { cursor: "c1.stale-snapshot", checkpoint: "c1.checkpoint", final: false, now: NOW });
  const alwaysGone = scriptedPeer(url => (url.pathname === "/v1/node"
    ? { body: fixture.card }
    : { status: 410, body: { error: { code: "cursor_expired", message: "expired", details: { snapshot: "https://peer.example/v1/snapshot" } } } }));
  const failed = await pullPeer(doomed.db, fixture.nodeSigner.identity, { fetchImpl: alwaysGone.fetchImpl, now: NOW, random: deterministic });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "peer_cursor_unusable");
  assert.equal(alwaysGone.paths("/v1/snapshot").length, 2, "one stale request plus one restart attempt");
  assert.equal(countRows(doomed.db, "records"), 0);
});

// ---------------------------------------------------------------------------------------------
// Backoff, jitter, and the circuit breaker
// ---------------------------------------------------------------------------------------------

test("backoff grows with jitter, the circuit breaker opens at the threshold, and success clears both", async t => {
  const fixture = peerFixture({ count: 1 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  const failing = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: fixture.card } : { status: 503, body: { error: { code: "unavailable" } } }));

  const delays = [];
  for (const now of ["2026-09-26T12:20:00Z", "2026-09-26T12:30:00Z", "2026-09-26T12:40:00Z"]) {
    const outcome = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: failing.fetchImpl, now, random: deterministic });
    delays.push(Date.parse(outcome.backoff_until) - Date.parse(now));
    assert.equal(outcome.circuit_open, delays.length >= PEER_LIMITS.maxFailuresBeforeOpen);
  }
  assert.deepEqual(delays, [500, 1000, 2000], "an exponential window with equal jitter");
  const open = readPeer(local.db, fixture.nodeSigner.identity);
  assert.equal(open.consecutiveFailures, 3);
  assert.equal(open.circuitOpenUntil, "2026-09-26T12:55:00.000Z");

  // While the circuit is open the peer is not contacted at all.
  const before = failing.requests.length;
  const skipped = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: failing.fetchImpl, now: "2026-09-26T12:50:00Z", random: deterministic });
  assert.equal(skipped.status, "circuit_open");
  assert.equal(skipped.retry_at, "2026-09-26T12:55:00.000Z");
  assert.equal(failing.requests.length, before, "an open circuit performs no network I/O");

  // After the cooldown the peer is tried again, and one success clears the failure state.
  const healthy = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: fixture.card } : { body: pageBody(fixture.items, { checkpoint: "c1.checkpoint" }) }));
  const recovered = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: healthy.fetchImpl, now: "2026-09-26T12:56:00Z", random: deterministic });
  assert.equal(recovered.status, "pulled");
  assert.deepEqual(verifyPeersRow(local.db, fixture.nodeSigner.identity), { checkpoint: "c1.checkpoint", consecutiveFailures: 0, pagesCommitted: 1, recordsStored: 1 });
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).backoffUntil, null);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).circuitOpenUntil, null);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).lastError, null);
});

// ---------------------------------------------------------------------------------------------
// Peer isolation and non-transitive admission
// ---------------------------------------------------------------------------------------------

test("peer failures are a bulkhead: one peer never aborts another pull, and no state is shared", async t => {
  const healthyFixture = peerFixture({ count: 2 });
  const failingFixture = peerFixture({ count: 1 });
  const rateLimitedFixture = peerFixture({ count: 1 });
  const local = await createRegistry(t);
  for (const [index, fixture] of [healthyFixture, failingFixture, rateLimitedFixture].entries()) {
    addPeer(local.db, { nodeId: fixture.nodeSigner.identity, apiBase: `https://peer-${index}.example/v1/`, label: `peer-${index}`, now: NOW });
  }

  const healthy = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: healthyFixture.card } : { body: pageBody(healthyFixture.items, { checkpoint: "c1.healthy" }) }));
  const broken = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: failingFixture.card } : { raw: "not json at all" }));
  const limited = scriptedPeer(url => (url.pathname === "/v1/node" ? { body: rateLimitedFixture.card } : { status: 429, headers: { "retry-after": "1" }, body: { error: { code: "rate_limited" } } }));

  const outcomes = await pullPeers(local.db, { now: NOW, random: deterministic, fetchImpl: href => {
    const url = new URL(href);
    if (url.hostname === "peer-0.example") return healthy.fetchImpl(href);
    if (url.hostname === "peer-1.example") return broken.fetchImpl(href);
    if (url.hostname === "peer-2.example") return limited.fetchImpl(href);
    throw new Error(`unexpected host: ${url.hostname}`);
  } });

  assert.equal(outcomes.length, 3);
  const byId = new Map(outcomes.map(outcome => [outcome.nodeId, outcome]));
  assert.equal(byId.get(healthyFixture.nodeSigner.identity).status, "pulled");
  assert.equal(byId.get(healthyFixture.nodeSigner.identity).stored, 2);
  assert.equal(byId.get(failingFixture.nodeSigner.identity).status, "failed");
  assert.equal(byId.get(failingFixture.nodeSigner.identity).error.code, "peer_invalid_response");
  assert.equal(byId.get(rateLimitedFixture.nodeSigner.identity).status, "failed");
  assert.equal(byId.get(rateLimitedFixture.nodeSigner.identity).error.code, "peer_rate_limited");

  // Only the healthy peer's records and provenance landed; the failing peers keep their own state.
  assert.equal(countRows(local.db, "records"), 2);
  const backoff = { [failingFixture.nodeSigner.identity]: "2026-09-26T12:20:00.500Z", [rateLimitedFixture.nodeSigner.identity]: "2026-09-26T12:20:01.000Z" };
  const rows = local.db.prepare("SELECT node_id, feed_cursor, consecutive_failures, backoff_until FROM federation_peers ORDER BY node_id").all().map(row => ({ ...row }));
  const healthyRow = rows.find(row => row.node_id === healthyFixture.nodeSigner.identity);
  assert.deepEqual(healthyRow, { node_id: healthyFixture.nodeSigner.identity, feed_cursor: "c1.healthy", consecutive_failures: 0, backoff_until: null });
  for (const row of rows.filter(candidate => candidate.node_id !== healthyFixture.nodeSigner.identity)) {
    assert.equal(row.feed_cursor, null);
    assert.equal(row.consecutive_failures, 1);
    assert.equal(row.backoff_until, backoff[row.node_id], `${row.node_id}: its own Retry-After or jitter window`);
  }

  // One named peer can be pulled on its own, and an unknown peer is a programming error, not a
  // silent no-op.
  const only = await pullPeers(local.db, { nodeId: healthyFixture.nodeSigner.identity, fetchImpl: healthy.fetchImpl, now: NOW, random: deterministic });
  assert.equal(only.length, 1);
  await assert.rejects(() => pullPeer(local.db, "oradio:node:ed25519:" + "A".repeat(43), { fetchImpl: healthy.fetchImpl, now: NOW }), /unknown peer/u);
});

test("a hostile peer cannot smuggle in another peer: admission is explicit and non-transitive", async t => {
  const fixture = peerFixture({ count: 1 });
  const smuggledSigner = createSigner("node");
  const smuggledCard = itemOf(nodeCardRecord(smuggledSigner, { extra: { api_bases: ["https://smuggled.example/v1/"] } }));
  // The hostile card claims other bases, and its feed carries a node card for a third node; the
  // payload it serves also lists peer-shaped metadata.
  const hostile = itemOf(stationRecord(fixture.station, {
    sequence: 1,
    parents: [fixture.items[0].recordId],
    station: stationBody("Hostile FM", { tags: ["replicated"] }),
  }));
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity, apiBase: "https://pinned.example/v1/" });
  const page = pageBody([smuggledCard, hostile], { checkpoint: "c1.checkpoint", nextCursor: "c1.next", hasMore: true });
  const scripted = scriptedPeer(url => (url.pathname === "/v1/node"
    ? { body: nodeCardRecord(fixture.nodeSigner, { extra: { api_bases: ["https://smuggled.example/v1/"], peers: ["oradio:node:ed25519:" + "C".repeat(43)] } }) }
    : { body: page }));

  const outcome = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic, limits: LIMITS({ maxPagesPerRun: 1 }) });
  assert.equal(outcome.status, "budget_exhausted");
  assert.equal(outcome.stored, 2);

  // Every request went to the pinned origin, in the pinned base path: nothing the peer said about
  // other bases, other peers, or recovery URLs was followed.
  assert.deepEqual([...new Set(scripted.urls().map(href => new URL(href).origin))], ["https://pinned.example"]);
  assert.deepEqual([...new Set(scripted.urls().map(href => new URL(href).pathname))], ["/v1/node", "/v1/records"]);

  // The smuggled node card is stored as a record (it is signed data, and node cards are part of
  // the feed), but it never becomes a pin: the peer table still holds exactly the operator's pin.
  assert.deepEqual(listPeers(local.db).map(peer => peer.nodeId), [fixture.nodeSigner.identity]);
  assert.deepEqual(local.db.prepare("SELECT record_id FROM records ORDER BY ingest_seq").all().map(row => row.record_id), [smuggledCard.recordId, hostile.recordId]);
  assert.equal(countRows(local.db, "records"), 2);
});

// ---------------------------------------------------------------------------------------------
// Crash replay
// ---------------------------------------------------------------------------------------------

test("a kill mid-page commits neither records nor cursor, and the replayed page converges", async t => {
  const fixture = peerFixture({ count: 2 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  const documents = fixture.items.map((item, index) => {
    const path = join(local.directory, `crash-envelope-${index}.json`);
    writeFileSync(path, JSON.stringify(item.envelope));
    return path;
  });

  const probe = spawnSync(process.execPath, [fileURLToPath(new URL("federation-crash-probe.mjs", import.meta.url))], {
    env: {
      ...process.env,
      BAREBUH_CRASH_CHECKPOINT: "c1.crash-checkpoint",
      BAREBUH_CRASH_CURSOR: "c1.crash-cursor",
      BAREBUH_CRASH_DB: local.databasePath,
      BAREBUH_CRASH_DOCS: JSON.stringify(documents),
      BAREBUH_CRASH_NOW: NOW,
      BAREBUH_CRASH_PEER: fixture.nodeSigner.identity,
      BAREBUH_CRASH_PHASE: "uncommitted_page",
    },
    encoding: "utf8",
  });
  assert.equal(probe.status, 7, probe.stderr || probe.stdout);

  // The page and its cursor were one transaction: the kill left neither.
  local.reopen();
  assert.equal(countRows(local.db, "records"), 0);
  assert.equal(countRows(local.db, "materialize_queue"), 0);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, null);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).checkpoint, null);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).lastSuccessAt, null);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).pagesCommitted, 0);

  // Replaying the same page after restart converges exactly once: content-addressed records make
  // the replay idempotent, and the cursor lands where the killed run would have put it.
  let pages = 0;
  const scripted = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    pages += 1;
    return { body: pageBody(fixture.items, { checkpoint: "c1.crash-checkpoint", nextCursor: `c1.crash-page-${pages}`, hasMore: true }) };
  });
  const replayed = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic, limits: LIMITS({ maxPagesPerRun: 1 }) });
  assert.equal(replayed.status, "budget_exhausted");
  assert.equal(replayed.stored, 2);
  assert.equal(countRows(local.db, "records"), 2);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.crash-page-1");
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).lastSuccessAt, NOW);

  // The same bytes served again are deduplicated instead of stored twice.
  const again = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic, limits: LIMITS({ maxPagesPerRun: 1 }) });
  assert.equal(again.stored, 0);
  assert.equal(again.duplicates, 2);
  assert.equal(countRows(local.db, "records"), 2);
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.crash-page-2");
});

test("a kill between pages leaves a committed cursor and the next run resumes from it", async t => {
  const fixture = peerFixture({ count: 3 });
  const local = await pinnedRegistry(t, { nodeId: fixture.nodeSigner.identity });
  const documents = [fixture.items[0]].map((item, index) => {
    const path = join(local.directory, `mid-run-envelope-${index}.json`);
    writeFileSync(path, JSON.stringify(item.envelope));
    return path;
  });

  const probe = spawnSync(process.execPath, [fileURLToPath(new URL("federation-crash-probe.mjs", import.meta.url))], {
    env: {
      ...process.env,
      BAREBUH_CRASH_CHECKPOINT: "c1.page-1",
      BAREBUH_CRASH_CURSOR: "c1.page-1",
      BAREBUH_CRASH_DB: local.databasePath,
      BAREBUH_CRASH_DOCS: JSON.stringify(documents),
      BAREBUH_CRASH_NOW: NOW,
      BAREBUH_CRASH_PEER: fixture.nodeSigner.identity,
      BAREBUH_CRASH_PHASE: "mid_run",
    },
    encoding: "utf8",
  });
  assert.equal(probe.status, 7, probe.stderr || probe.stdout);

  local.reopen();
  assert.equal(countRows(local.db, "records"), 1, "the committed page survived the kill");
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.page-1");

  // The next run resumes from the committed cursor: the first page is not fetched again, and the
  // remaining records are appended without duplicates.
  const scripted = scriptedPeer(url => {
    if (url.pathname === "/v1/node") return { body: fixture.card };
    assert.equal(url.searchParams.get("cursor"), "c1.page-1", "the walk resumes from the committed cursor");
    return { body: pageBody(fixture.items.slice(1), { checkpoint: "c1.done" }) };
  });
  const resumed = await pullPeer(local.db, fixture.nodeSigner.identity, { fetchImpl: scripted.fetchImpl, now: NOW, random: deterministic });
  assert.equal(resumed.status, "pulled");
  assert.equal(resumed.stored, 2);
  assert.equal(resumed.duplicates, 0);
  assert.equal(scripted.paths("/v1/records").length, 1);
  assert.deepEqual(local.db.prepare("SELECT record_id FROM records ORDER BY ingest_seq").all().map(row => row.record_id), fixture.items.map(item => item.recordId));
  assert.equal(readPeer(local.db, fixture.nodeSigner.identity).feedCursor, "c1.done");
});

// ---------------------------------------------------------------------------------------------
// The operator surface
// ---------------------------------------------------------------------------------------------

test("the replicator and the peer commands refuse to run outside the pinned-federation mode", async t => {
  const local = await createRegistry(t);
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const readOnly = { ...process.env, BAREBUH_DATABASE_PATH: local.databasePath, BAREBUH_PUBLIC_BASE_URL: "https://registry.example/" };

  const list = spawnSync(process.execPath, [cliPath, "peer-list"], { env: readOnly, encoding: "utf8" });
  assert.equal(list.status, 1);
  assert.match(list.stderr, /federation commands require the PRIVATE_PINNED_FEDERATION mode/u);

  const replicate = spawnSync(process.execPath, [cliPath, "replicate"], { env: readOnly, encoding: "utf8" });
  assert.equal(replicate.status, 1);
  assert.match(replicate.stderr, /PRIVATE_PINNED_FEDERATION/u);

  const federated = {
    ...readOnly,
    BAREBUH_FEDERATION_ENABLED: "true",
    BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION",
  };
  const empty = spawnSync(process.execPath, [cliPath, "peer-list"], { env: federated, encoding: "utf8" });
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { peers: [] });

  const fixture = peerFixture({ count: 1 });
  const added = spawnSync(process.execPath, [cliPath, "peer-add", fixture.nodeSigner.identity, PEER_BASE, "peer-a"], { env: federated, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).peer.nodeId, fixture.nodeSigner.identity);
  const listed = spawnSync(process.execPath, [cliPath, "peer-list"], { env: federated, encoding: "utf8" });
  assert.deepEqual(JSON.parse(listed.stdout).peers.map(peer => peer.nodeId), [fixture.nodeSigner.identity]);

  // `replicate` reports one outcome per pinned peer and fails closed on a failed pull.
  const replicated = spawnSync(process.execPath, [cliPath, "replicate"], { env: federated, encoding: "utf8" });
  assert.equal(replicated.status, 1, replicated.stderr);
  const report = JSON.parse(replicated.stdout);
  assert.equal(report.outcomes.length, 1);
  assert.equal(report.outcomes[0].status, "failed");
  assert.equal(report.outcomes[0].error.code, "peer_unreachable");
  assert.equal(report.materialized.processed, 0);

  const removed = spawnSync(process.execPath, [cliPath, "peer-remove", fixture.nodeSigner.identity], { env: federated, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout), { nodeId: fixture.nodeSigner.identity, removed: true });

  const usage = spawnSync(process.execPath, [cliPath, "peer-add", fixture.nodeSigner.identity], { env: federated, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: registry-node/u);
});
