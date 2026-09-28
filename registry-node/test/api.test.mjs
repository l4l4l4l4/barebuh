// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Integration tests for the registry read APIs: the signed node card, the well-known descriptor
// contract, station lookup, search (filters, deterministic ordering, opaque cursor binding, ETag),
// the health view, error envelopes, the disabled submission boundary, and read-only behaviour.
//
// The search-item validator mirrors the desktop client's response parser
// (src/radios/barebuhsearchparser.cpp, tests/src/barebuhservice_test.cpp); the field list is
// checked against the shared fixture file protocol/v1/fixtures/interoperability-cases.json.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalize, parseJsonStrict } from "../../protocol/v1/lib/conformance.mjs";
import { loadConfig } from "../src/config.mjs";
import { createRegistryServer, ROUTES } from "../src/http.mjs";
import { migrateDatabase, openDatabase } from "../src/store/db.mjs";
import { materializeStation } from "../src/store/materialize.mjs";
import { ingestDocument, setRecordPolicy } from "../src/store/records.mjs";
import { READ_LIMITS } from "../src/store/views.mjs";
import { createSigner, nodeCardRecord, observationRecord, recordIdOf, stationBody, stationRecord, VALIDATION_TIME } from "./fixtures.mjs";

const migrationsDir = new URL("../migrations/", import.meta.url);
const cases = parseJsonStrict(readFileSync(new URL("../../protocol/v1/fixtures/interoperability-cases.json", import.meta.url)));

const API_NOW = "2026-09-26T12:20:00Z";
const INGEST_NOW = "2026-09-26T12:10:00Z";
const SECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const RECORD_ID = /^sha256:[A-Za-z0-9_-]{43}$/u;
const STATION_ID = /^oradio:station:ed25519:[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POLICY_STATES = new Set(["admitted", "suppressed", "tombstoned", "unsupported_critical"]);
const HEALTH_STATES = new Set(["unknown", "ok", "degraded", "unreachable", "blocked"]);
const STORE_TABLES = ["records", "record_parents", "record_sources", "record_policy", "quarantine", "materialize_queue", "station_state", "station_projection", "station_streams", "station_tags", "station_languages", "station_tips", "station_fts"];

function digestOf(signer) {
  return signer.identity.slice("oradio:station:ed25519:".length);
}

function storeFingerprint(db) {
  const counts = STORE_TABLES.map(table => `${table}=${db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count}`);
  const meta = db.prepare("SELECT generation, materializer_version, rebuilt_at FROM projection_meta WHERE singleton = 1").get();
  return canonicalize({ counts, meta });
}

// The expected ordering is re-derived from the shared interoperability profile instead of from the
// implementation: score descending, normalized name ascending, station ID ascending, UTF-8 bytes.
function expectedOrder(rows) {
  return [...rows]
    .sort((left, right) => right.score - left.score || Buffer.compare(Buffer.from(left.normalizedName, "utf8"), Buffer.from(right.normalizedName, "utf8")) || Buffer.compare(Buffer.from(left.stationId, "utf8"), Buffer.from(right.stationId, "utf8")))
    .map(row => row.stationId);
}

async function startApi(t, { nodeId = null, now = API_NOW } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "barebuh-api-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "registry.sqlite3");
  await migrateDatabase(databasePath, { migrationsDir });
  const writer = openDatabase(databasePath);
  const clock = { now };
  const harness = {
    directory,
    databasePath,
    db: writer,
    clock,
    advance(seconds) {
      clock.now = new Date(Date.parse(clock.now) + seconds * 1000).toISOString();
    },
    ingest(envelope, options = {}) {
      return ingestDocument(writer, Buffer.from(JSON.stringify(envelope)), { now: INGEST_NOW, sourceId: "operator", validationTime: VALIDATION_TIME, ...options });
    },
  };
  t.after(() => writer.close());

  const db = openDatabase(databasePath, { readOnly: true });
  t.after(() => db.close());
  const config = loadConfig({ BAREBUH_DATABASE_PATH: databasePath, BAREBUH_PUBLIC_BASE_URL: "https://registry.example/", ...(nodeId === null ? {} : { BAREBUH_NODE_ID: nodeId }) });
  const server = createRegistryServer({ config, db, clock: () => clock.now });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  harness.base = `http://127.0.0.1:${server.address().port}`;
  harness.get = async (path, options = {}) => {
    const response = await fetch(`${harness.base}${path}`, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    let body = null;
    try { body = bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8")); } catch { body = null; }
    return { response, status: response.status, headers: Object.fromEntries(response.headers), bytes, text: bytes.toString("utf8"), body };
  };
  return harness;
}

// Publishes a genesis (or a caller-provided history) for a fresh station signer and materializes
// it, exactly the way an administrator publishes records today.
function publish(harness, { name, signer = createSigner("station"), sequence = 0, parents = [], station = {}, extra = {} } = {}) {
  const envelope = stationRecord(signer, { sequence, parents, station: stationBody(name, station), extra });
  const result = harness.ingest(envelope);
  assert.equal(result.status, "stored", result.message ?? "");
  const materialized = materializeStation(harness.db, signer.identity, { now: INGEST_NOW });
  return { signer, envelope, recordId: recordIdOf(envelope), materialized };
}

function observe(harness, nodeSigner, stationId, { observedAt = "2026-09-26T12:15:00Z", expiresAt = "2026-09-26T12:30:00Z", outcome = "ok", endpoint = { endpoint_index: 0 }, extra = {} } = {}) {
  const envelope = observationRecord(nodeSigner, { stationId, endpoint, observedAt, expiresAt, outcome, extra });
  const result = harness.ingest(envelope, { validationTime: observedAt });
  return { envelope, result, recordId: recordIdOf(envelope) };
}

test("route inventory exposes bounded read routes plus the refused submission boundary", () => {
  assert.deepEqual(ROUTES, [
    "GET /.well-known/open-radio-registry",
    "GET /health/live",
    "GET /health/ready",
    "GET /v1/node",
    "GET /v1/records",
    "GET /v1/snapshot",
    "GET /v1/search",
    "GET /v1/stations/{station-key-digest}",
    "GET /v1/health/{station-key-digest}",
    "POST /v1/records",
  ]);
});

test("the signed node card fails closed without a configured identity or an admitted card", async t => {
  const unconfigured = await startApi(t);
  const missingIdentity = await unconfigured.get("/v1/node");
  assert.equal(missingIdentity.status, 503);
  assert.equal(missingIdentity.body.error.code, "node_card_unavailable");
  assert.match(missingIdentity.body.request_id, REQUEST_ID);

  const nodeSigner = createSigner("node");
  const configured = await startApi(t, { nodeId: nodeSigner.identity });
  const missingCard = await configured.get("/v1/node");
  assert.equal(missingCard.status, 503);
  assert.equal(missingCard.body.error.code, "node_card_unavailable");

  // A card for a different node identity must never be served as this node's card.
  const foreignSigner = createSigner("node");
  const foreign = nodeCardRecord(foreignSigner, { issuedAt: "2026-09-26T11:00:00Z", expiresAt: "2026-09-26T13:00:00Z" });
  assert.equal(configured.ingest(foreign, { validationTime: "2026-09-26T11:30:00Z" }).status, "stored");
  const stillMissing = await configured.get("/v1/node");
  assert.equal(stillMissing.status, 503);
  assert.equal(stillMissing.body.error.code, "node_card_unavailable");
});

test("the signed node card is relayed byte-for-byte until its signed expiry", async t => {
  const nodeSigner = createSigner("node");
  const harness = await startApi(t, { nodeId: nodeSigner.identity });
  const card = nodeCardRecord(nodeSigner, { issuedAt: "2026-09-26T11:00:00Z", expiresAt: "2026-09-26T13:00:00Z" });
  const bytes = Buffer.from(JSON.stringify(card));
  const stored = harness.ingest(card, { validationTime: "2026-09-26T11:30:00Z" });
  assert.equal(stored.status, "stored");

  const response = await harness.get("/v1/node");
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, bytes);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["cache-control"], "public, max-age=300");
  assert.match(response.headers.etag, /^"[0-9a-f]{64}"$/u);

  const cached = await harness.get("/v1/node", { headers: { "if-none-match": response.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.bytes.length, 0);

  harness.advance(2401); // 13:00:01Z
  const expired = await harness.get("/v1/node");
  assert.equal(expired.status, 503);
  assert.equal(expired.body.error.code, "node_card_expired");
});

test("the station resource exposes the signed snapshot, provenance, policy, and freshness", async t => {
  const harness = await startApi(t);
  const { signer: published, recordId: publishedId } = publish(harness, {
    name: "Jazz Café FM",
    station: { streams: 2, tags: ["Jazz", "Smooth"], languages: ["en-US"], country: "US" },
  });

  const digest = digestOf(published);
  const response = await harness.get(`/v1/stations/${digest}`);
  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.station_id, published.identity);
  assert.equal(body.state, "active");
  assert.equal(body.policy_state, "admitted");
  assert.equal(body.winning_record_id, publishedId);
  assert.deepEqual(body.tips, [publishedId]);
  assert.equal(body.forked, false);
  assert.deepEqual(body.station, {
    name: "Jazz Café FM",
    country: "US",
    languages: ["en-US"],
    tags: ["Jazz", "Smooth"],
    streams: [
      { url: "https://stream.example.invalid/live-0", transport: "https", container: "audio/mpeg", codec: "mp3", bitrate_kbps: 128 },
      { url: "https://stream.example.invalid/live-1", transport: "https", container: "audio/mpeg", codec: "mp3", bitrate_kbps: 128 },
    ],
  });
  assert.deepEqual(body.provenance, { records: 1, sources: [{ kind: "local", id: "operator", records: 1 }], sources_total: 1 });
  assert.equal(body.indexed_at, INGEST_NOW.replace(".000Z", "Z"));
  assert.equal(body.last_replication_at, INGEST_NOW.replace(".000Z", "Z"));
  assert.equal(body.materialized_at, INGEST_NOW.replace(".000Z", "Z"));
  assert.deepEqual(body.health, { state: "unknown", expires_at: null, observed_at: null, outcome: null, observer: null, endpoint: null });

  // The digest form and the full station identity address the same resource.
  const byIdentity = await harness.get(`/v1/stations/${published.identity}`);
  assert.deepEqual(byIdentity.body, body);
});

test("station lookup distinguishes absence, non-materialized input, tombstones, and suppression", async t => {
  const harness = await startApi(t);
  const digest = digestOf(createSigner("station"));

  const absent = await harness.get(`/v1/stations/${digest}`);
  assert.equal(absent.status, 404);
  assert.equal(absent.body.error.code, "station_not_found");

  const orphanSigner = createSigner("station");
  const orphanParent = `sha256:${Buffer.alloc(32, 7).toString("base64url")}`;
  harness.ingest(stationRecord(orphanSigner, { sequence: 1, parents: [orphanParent], station: stationBody("Orphan FM") }));
  materializeStation(harness.db, orphanSigner.identity, { now: INGEST_NOW });
  const orphan = await harness.get(`/v1/stations/${digestOf(orphanSigner)}`);
  assert.equal(orphan.status, 404);
  assert.equal(orphan.body.error.code, "station_not_materialized");
  assert.deepEqual(orphan.body.error.details, { state: "orphan_only" });

  const quarantinedSigner = createSigner("station");
  const held = publish(harness, { name: "Held FM", signer: quarantinedSigner });
  // A local quarantine hold on the station's only record leaves the station without a
  // materialized view, which must stay distinguishable from absence.
  setRecordPolicy(harness.db, held.recordId, "quarantined", { now: INGEST_NOW });
  materializeStation(harness.db, quarantinedSigner.identity, { now: INGEST_NOW });
  const quarantined = await harness.get(`/v1/stations/${digestOf(quarantinedSigner)}`);
  assert.equal(quarantined.status, 404);
  assert.equal(quarantined.body.error.code, "station_not_materialized");
  assert.deepEqual(quarantined.body.error.details, { state: "quarantined" });

  const tombstoned = publish(harness, { name: "Doomed FM" });
  const tombstone = stationRecord(tombstoned.signer, { sequence: 1, parents: [tombstoned.recordId], station: { deleted: true } });
  harness.ingest(tombstone);
  materializeStation(harness.db, tombstoned.signer.identity, { now: INGEST_NOW });
  const gone = await harness.get(`/v1/stations/${digestOf(tombstoned.signer)}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.state, "tombstoned");
  assert.equal(gone.body.policy_state, "tombstoned");
  assert.equal(gone.body.winning_record_id, recordIdOf(tombstone));
  assert.equal(gone.body.station, null);
  assert.deepEqual(gone.body.health, { state: "unknown", expires_at: null, observed_at: null, outcome: null, observer: null, endpoint: null });

  const suppressed = publish(harness, { name: "Hidden FM" });
  setRecordPolicy(harness.db, suppressed.recordId, "suppressed", { now: INGEST_NOW });
  materializeStation(harness.db, suppressed.signer.identity, { now: INGEST_NOW });
  const hidden = await harness.get(`/v1/stations/${digestOf(suppressed.signer)}`);
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.state, "suppressed");
  assert.equal(hidden.body.policy_state, "suppressed");
  assert.equal(hidden.body.winning_record_id, null);
  assert.equal(hidden.body.station, null);

  const unsupported = publish(harness, { name: "Future FM", extra: { critical: ["future_feature"], future_feature: { mode: "test" } } });
  const uninterpreted = await harness.get(`/v1/stations/${digestOf(unsupported.signer)}`);
  assert.equal(uninterpreted.status, 200);
  assert.equal(uninterpreted.body.state, "unsupported_critical");
  assert.equal(uninterpreted.body.policy_state, "unsupported_critical");
  assert.equal(uninterpreted.body.station, null);
});

test("station keys and search pages enforce their documented bounds", async t => {
  const harness = await startApi(t);
  for (const key of ["not-a-key", "AAAA", `${"A".repeat(42)}=`, `${"A".repeat(44)}`]) {
    const response = await harness.get(`/v1/stations/${encodeURIComponent(key)}`);
    assert.equal(response.status, 400, key);
    assert.equal(response.body.error.code, "invalid_parameter");
  }
  assert.equal((await harness.get("/v1/stations/")).status, 400);
  assert.equal((await harness.get("/v1/stations/a/b")).status, 404);
  assert.equal((await harness.get("/v1/search/")).status, 404);

  const badPages = [
    ["/v1/search?limit=0", "limit", "out_of_bounds"],
    ["/v1/search?limit=1001", "limit", "out_of_bounds"],
    ["/v1/search?limit=10000", "limit", "out_of_bounds"],
    ["/v1/search?limit=abc", "limit", "invalid_value"],
    ["/v1/search?limit=6&limit=7", "limit", "duplicate_parameter"],
    ["/v1/search?frobnicate=1", "frobnicate", "unknown_parameter"],
    ["/v1/search?healthy=maybe", "healthy", "invalid_value"],
    ["/v1/search?country=usa", "country", "invalid_value"],
    ["/v1/search?country=%C3%9F", "country", "invalid_value"],
    [`/v1/search?q=${Array.from({ length: 9 }, (_, index) => `term${index}`).join("+")}`, "q", "too_many_terms"],
    [`/v1/search?q=${"x".repeat(65)}`, "q", "term_out_of_bounds"],
    [`/v1/search?tag=${Array.from({ length: READ_LIMITS.maxSearchFilterValues + 1 }, (_, index) => `t${index}`).join("&tag=")}`, "tag", "too_many_values"],
  ];
  for (const [path, parameter, reason] of badPages) {
    const response = await harness.get(path);
    assert.equal(response.status, 400, path);
    assert.equal(response.body.error.code, "invalid_parameter", path);
    assert.deepEqual(response.body.error.details, { parameter, reason }, path);
    assert.match(response.body.request_id, REQUEST_ID);
  }
});

test("search filters are bounded, ANDed across classes, and ORed within a class", async t => {
  const harness = await startApi(t);
  const alpha = publish(harness, { name: "Alpha FM", station: { tags: ["Jazz", "Smooth"], country: "US", languages: ["en"], streams: [{ url: "https://stream.example.invalid/alpha", transport: "https", container: "audio/mpeg", codec: "mp3", bitrate_kbps: 128 }] } });
  const beta = publish(harness, { name: "Beta Radio", station: { tags: ["Rock"], country: "DE", languages: ["de"], streams: [{ url: "https://stream.example.invalid/beta", transport: "https", container: "audio/aac", codec: "aac", bitrate_kbps: 128 }] } });
  const gamma = publish(harness, { name: "Gamma Jazz", station: { tags: ["Jazz"], country: "FR", languages: ["fr"], streams: [{ url: "https://stream.example.invalid/gamma", transport: "https", container: "audio/ogg", codec: "opus", bitrate_kbps: 96 }] } });

  const ids = async query => (await harness.get(`/v1/search?${query}`)).body.items.map(item => item.station_id).sort();
  assert.deepEqual(await ids("limit=64"), [alpha.signer.identity, beta.signer.identity, gamma.signer.identity].sort());
  assert.deepEqual(await ids("tag=jazz&limit=64"), [alpha.signer.identity, gamma.signer.identity].sort());
  assert.deepEqual(await ids("tag=jazz&tag=rock&limit=64"), [alpha.signer.identity, beta.signer.identity, gamma.signer.identity].sort());
  assert.deepEqual(await ids("tag=jazz&country=FR&limit=64"), [gamma.signer.identity]);
  assert.deepEqual(await ids("language=de&limit=64"), [beta.signer.identity]);
  assert.deepEqual(await ids("codec=opus&limit=64"), [gamma.signer.identity]);
  assert.deepEqual(await ids("country=fr&limit=64"), [gamma.signer.identity]);
  assert.deepEqual(await ids("country=DE&limit=64"), [beta.signer.identity]);
  assert.deepEqual(await ids("country=de&codec=opus&limit=64"), []);
  assert.deepEqual(await ids("q=gamma&limit=64"), [gamma.signer.identity]);
  assert.deepEqual(await ids("q=jazz&limit=64"), [alpha.signer.identity, gamma.signer.identity].sort());
  assert.deepEqual(await ids("q=jazz+rock&limit=64"), []);
  // A query with no searchable terms behaves exactly like no text filter.
  assert.deepEqual(await ids("q=%21%21%21&limit=64"), [alpha.signer.identity, beta.signer.identity, gamma.signer.identity].sort());
});

test("search ordering is deterministic and pagination preserves it", async t => {
  const harness = await startApi(t);
  const published = [
    publish(harness, { name: "Alpha FM", station: { tags: ["Jazz"] } }),
    publish(harness, { name: "alpha fm", station: { tags: ["Jazz"] } }),
    publish(harness, { name: "Éclair FM", station: { tags: ["Jazz"] } }),
    publish(harness, { name: "Zebra FM", station: { tags: ["Rock"] } }),
  ];

  const single = await harness.get("/v1/search?limit=1000");
  assert.equal(single.status, 200);
  const expected = expectedOrder(published.map(entry => ({
    stationId: entry.signer.identity,
    normalizedName: entry.envelope.payload.station.name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/gu, " ").trim(),
    score: 0,
  })));
  assert.deepEqual(single.body.items.map(item => item.station_id), expected);
  assert.equal(single.body.has_more, false);
  assert.equal(single.body.next_cursor, null);
  assert.equal(single.body.query_snapshot, (await harness.get("/v1/search?limit=1000")).body.query_snapshot);

  // Paging one at a time yields the same order and a stable query snapshot.
  const paged = [];
  let cursor = null;
  let pages = 0;
  let snapshot = null;
  do {
    const response = await harness.get(`/v1/search?limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    assert.equal(response.status, 200);
    paged.push(...response.body.items.map(item => item.station_id));
    snapshot = snapshot ?? response.body.query_snapshot;
    assert.equal(response.body.query_snapshot, snapshot);
    cursor = response.body.next_cursor;
    ++pages;
    assert.ok(pages <= 8, "pagination did not terminate");
  } while (cursor !== null);
  assert.deepEqual(paged, expected);
  assert.equal(pages, expected.length);
});

test("cursors are opaque, filter-bound, expiring, and validated before use", async t => {
  const harness = await startApi(t);
  publish(harness, { name: "Alpha FM", station: { tags: ["Jazz"] } });
  publish(harness, { name: "Beta FM", station: { tags: ["Rock"] } });
  publish(harness, { name: "Gamma FM", station: { tags: ["Rock"] } });

  const first = await harness.get("/v1/search?limit=1");
  const cursor = first.body.next_cursor;
  assert.equal(typeof cursor, "string");
  assert.match(cursor, /^c1\.[A-Za-z0-9_-]+$/u);

  // A cursor is bound to its feed and filter.
  const foreignFilter = await harness.get(`/v1/search?limit=1&tag=jazz&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(foreignFilter.status, 400);
  assert.equal(foreignFilter.body.error.code, "cursor_binding_mismatch");
  const withoutFilter = await harness.get(`/v1/search?limit=1&cursor=${encodeURIComponent(cursor)}&q=nothing`);
  assert.equal(withoutFilter.status, 400);
  assert.equal(withoutFilter.body.error.code, "cursor_binding_mismatch");

  // The same filter with a different page size is still the same query.
  const second = await harness.get(`/v1/search?limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.items.length, 2);
  assert.equal(second.body.has_more, false);
  assert.equal(second.body.query_snapshot, first.body.query_snapshot);
  const walked = [...first.body.items, ...second.body.items].map(item => item.station_id);
  const complete = (await harness.get("/v1/search?limit=1000")).body.items.map(item => item.station_id);
  assert.deepEqual(walked, complete);

  for (const bad of ["c1.!!!!", "c1.abc", "not-a-cursor", `c1.${Buffer.from("{}").toString("base64url")}`, `c1.${Buffer.from(canonicalize({ v: 1, feed: "search", filter: {}, offset: 0, snapshot: "s1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expires_at: "not-an-instant" })).toString("base64url")}`]) {
    const response = await harness.get(`/v1/search?limit=1&cursor=${encodeURIComponent(bad)}`);
    assert.equal(response.status, 400, bad);
    assert.equal(response.body.error.code, "cursor_invalid", bad);
  }

  harness.advance(READ_LIMITS.cursorLifetimeSeconds + 1);
  const expired = await harness.get(`/v1/search?limit=1&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, "cursor_invalid");
});

test("search responses are byte-deterministic, ETag-validated, and read-only", async t => {
  const harness = await startApi(t);
  publish(harness, { name: "Alpha FM", station: { tags: ["Jazz"] } });
  const before = storeFingerprint(harness.db);

  const first = await harness.get("/v1/search?limit=64");
  const second = await harness.get("/v1/search?limit=64");
  assert.equal(first.status, 200);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.headers.etag, second.headers.etag);
  assert.equal(first.headers["cache-control"], "no-store");

  const cached = await harness.get("/v1/search?limit=64", { headers: { "if-none-match": first.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.bytes.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);

  const multi = await harness.get("/v1/search?limit=64", { headers: { "if-none-match": `"other", W/${first.headers.etag}` } });
  assert.equal(multi.status, 304);
  const wildcard = await harness.get("/v1/search?limit=64", { headers: { "if-none-match": "*" } });
  assert.equal(wildcard.status, 304);
  const stale = await harness.get("/v1/search?limit=64", { headers: { "if-none-match": '"different"' } });
  assert.equal(stale.status, 200);

  assert.equal(storeFingerprint(harness.db), before, "read requests must not modify the store");
});

test("the health view reports the local badge, separate remote observations, and expiry to unknown", async t => {
  const localSigner = createSigner("node");
  const remoteSigner = createSigner("node");
  const harness = await startApi(t, { nodeId: localSigner.identity });
  const station = publish(harness, { name: "Probed FM", station: { streams: 2 } });

  const localOk = observe(harness, localSigner, station.signer.identity);
  assert.equal(localOk.result.status, "stored");
  // A newer remote observation must not move the local badge.
  const remoteBlocked = observe(harness, remoteSigner, station.signer.identity, { observedAt: "2026-09-26T12:16:00Z", expiresAt: "2026-09-26T12:40:00Z", outcome: "blocked" });
  assert.equal(remoteBlocked.result.status, "stored");
  // An out-of-scope endpoint is quarantined and never listed.
  const outOfScope = observe(harness, localSigner, station.signer.identity, { endpoint: { endpoint_index: 5 } });
  assert.equal(outOfScope.result.status, "stored");
  assert.equal(outOfScope.result.policyState, "quarantined");

  const digest = digestOf(station.signer);
  const stationView = await harness.get(`/v1/stations/${digest}`);
  assert.deepEqual(stationView.body.health, {
    state: "ok",
    expires_at: "2026-09-26T12:30:00Z",
    observed_at: "2026-09-26T12:15:00Z",
    outcome: "ok",
    observer: { node_id: localSigner.identity, scope: "local" },
    endpoint: { endpoint_index: 0 },
  });

  const health = await harness.get(`/v1/health/${digest}`);
  assert.equal(health.status, 200);
  assert.equal(health.body.station_id, station.signer.identity);
  assert.equal(health.body.state, "active");
  assert.deepEqual(health.body.aggregate, stationView.body.health);
  assert.deepEqual(health.body.counts, { admitted: 2, quarantined: 1, expired: 0, listed: 2 });
  assert.deepEqual(health.body.observations.map(observation => [observation.outcome, observation.state, observation.observer.scope]), [
    ["blocked", "blocked", "remote"],
    ["ok", "ok", "local"],
  ]);
  assert.equal(health.body.observations[0].record_id, remoteBlocked.recordId);

  // Ranking follows the local badge only.
  assert.deepEqual((await harness.get("/v1/search?healthy=true")).body.items.map(item => item.station_id), [station.signer.identity]);
  assert.deepEqual((await harness.get("/v1/search?healthy=false")).body.items, []);

  // Expiry turns the badge into `unknown` and never into a failure.
  harness.advance(3600);
  const expired = await harness.get(`/v1/health/${digest}`);
  assert.equal(expired.body.aggregate.state, "unknown");
  assert.equal(expired.body.aggregate.expires_at, "2026-09-26T12:30:00Z");
  assert.equal(expired.body.counts.expired, 2);
  assert.deepEqual((await harness.get("/v1/search?healthy=true")).body.items, []);
  assert.deepEqual((await harness.get("/v1/search?healthy=false")).body.items.map(item => item.station_id), [station.signer.identity]);

  const absent = await harness.get(`/v1/health/${digestOf(createSigner("station"))}`);
  assert.equal(absent.status, 404);
  assert.equal(absent.body.error.code, "station_not_found");
});

test("a search page satisfies the desktop client's response contract", async t => {
  const localSigner = createSigner("node");
  const harness = await startApi(t, { nodeId: localSigner.identity });
  const station = publish(harness, { name: "Client Contract FM", station: { streams: 2, tags: ["Jazz"], languages: ["en"], country: "US" } });
  observe(harness, localSigner, station.signer.identity);

  const page = (await harness.get("/v1/search?limit=64")).body;
  assert.ok(Array.isArray(page.items) && page.items.length <= 64);
  assert.equal(typeof page.has_more, "boolean");
  assert.ok(Object.hasOwn(page, "next_cursor"));
  assert.equal(page.has_more, false);
  assert.equal(page.next_cursor, null);
  assert.equal(typeof page.query_snapshot, "string");
  assert.ok(page.query_snapshot.trim().length > 0 && Buffer.byteLength(page.query_snapshot, "utf8") <= 1024);

  for (const item of page.items) {
    assert.match(item.station_id, STATION_ID);
    assert.match(item.winning_record_id, RECORD_ID);
    assert.ok(Array.isArray(item.tips) && item.tips.length > 0 && item.tips.length <= 32 && item.tips.every(tip => RECORD_ID.test(tip)));
    assert.equal(typeof item.forked, "boolean");
    assert.equal(typeof item.station, "object");
    assert.ok(item.station.name.trim().length > 0 && Buffer.byteLength(item.station.name, "utf8") <= 200);
    assert.ok(Array.isArray(item.station.streams) && item.station.streams.length > 0 && item.station.streams.length <= 16);
    for (const stream of item.station.streams) {
      const url = new URL(stream.url);
      assert.ok(["http:", "https:"].includes(url.protocol) && url.host !== "" && url.username === "" && url.hash === "");
      assert.ok(Buffer.byteLength(stream.url, "utf8") <= 2048);
      assert.equal(stream.transport, url.protocol.slice(0, -1));
      assert.ok(stream.codec.trim().length > 0 && Buffer.byteLength(stream.codec, "utf8") <= 64);
    }
    assert.ok(typeof item.provenance === "object" && item.provenance !== null);
    assert.ok(Buffer.byteLength(JSON.stringify(item.provenance), "utf8") <= 4096);
    assert.match(item.indexed_at, SECOND_INSTANT);
    assert.match(item.last_replication_at, SECOND_INSTANT);
    assert.ok(POLICY_STATES.has(item.policy_state));
    assert.equal(typeof item.health, "object");
    assert.ok(Object.hasOwn(item.health, "expires_at"));
    assert.ok(HEALTH_STATES.has(item.health.state));
    if (item.health.state === "unknown" && item.health.expires_at === null) {
      // The client maps this to health_expires_at = 0.
    } else {
      assert.match(item.health.expires_at, SECOND_INSTANT);
    }

    // Every field the offline cache fixture requires can be derived from one item.
    const cacheRow = {
      station_id: item.station_id,
      country: item.station.country ?? "",
      tags: item.station.tags ?? [],
      codec: item.station.streams[0].codec,
      indexed_at: item.indexed_at,
      last_replication_at: item.last_replication_at,
      policy_state: item.policy_state,
      health: item.health.state,
      health_expires_at: item.health.expires_at,
      etag: '"cache"',
      refreshed_at: item.indexed_at,
    };
    for (const field of cases.offline_cache.required_fields) assert.ok(Object.hasOwn(cacheRow, field), `missing cache field ${field}`);
  }
});

test("non-active stations never enter the search listing", async t => {
  const harness = await startApi(t);
  const active = publish(harness, { name: "Visible FM" });

  const tombstoned = publish(harness, { name: "Doomed FM" });
  harness.ingest(stationRecord(tombstoned.signer, { sequence: 1, parents: [tombstoned.recordId], station: { deleted: true } }));
  materializeStation(harness.db, tombstoned.signer.identity, { now: INGEST_NOW });

  const suppressed = publish(harness, { name: "Hidden FM" });
  setRecordPolicy(harness.db, suppressed.recordId, "suppressed", { now: INGEST_NOW });
  materializeStation(harness.db, suppressed.signer.identity, { now: INGEST_NOW });

  const unsupported = publish(harness, { name: "Future FM", extra: { critical: ["future_feature"], future_feature: {} } });

  const orphanSigner = createSigner("station");
  harness.ingest(stationRecord(orphanSigner, { sequence: 1, parents: [`sha256:${Buffer.alloc(32, 9).toString("base64url")}`], station: stationBody("Orphan FM") }));
  materializeStation(harness.db, orphanSigner.identity, { now: INGEST_NOW });

  const page = await harness.get("/v1/search?limit=1000");
  assert.deepEqual(page.body.items.map(item => item.station_id), [active.signer.identity]);
  const tombstoneView = await harness.get(`/v1/stations/${digestOf(tombstoned.signer)}`);
  assert.equal(tombstoneView.body.state, "tombstoned");
  const unsupportedView = await harness.get(`/v1/stations/${digestOf(unsupported.signer)}`);
  assert.equal(unsupportedView.body.state, "unsupported_critical");
});

test("submissions are refused before any body byte is read and cannot be enabled", async t => {
  const harness = await startApi(t);
  const station = publish(harness, { name: "Existing FM" });
  const before = storeFingerprint(harness.db);

  const envelope = stationRecord(createSigner("station"), { sequence: 0, station: stationBody("Submitted FM") });
  for (const headers of [{}, { authorization: "Bearer administrative-token" }, { "content-type": "application/json" }]) {
    const response = await harness.get("/v1/records", { method: "POST", headers, body: JSON.stringify(envelope) });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "submission_disabled");
    assert.match(response.body.request_id, REQUEST_ID);
    assert.equal(response.bytes.includes(Buffer.from("Submitted FM")), false);
  }

  // A large unread body must not keep the connection or the process busy.
  const large = await harness.get("/v1/records", { method: "POST", body: `{"filler":"${"x".repeat(200_000)}"}` });
  assert.equal(large.status, 403);
  assert.equal(large.body.error.code, "submission_disabled");

  assert.equal(storeFingerprint(harness.db), before, "refused submissions must not modify the store");
  const stillServing = await harness.get(`/v1/stations/${digestOf(station.signer)}`);
  assert.equal(stillServing.status, 200);

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await harness.get("/v1/records", { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD, POST");
  }
  const feed = await harness.get("/v1/records");
  assert.equal(feed.status, 404);
  assert.equal(feed.body.error.code, "not_found");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await harness.get("/v1/search", { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
});

test("HEAD requests are answered like GET without a body", async t => {
  const harness = await startApi(t);
  publish(harness, { name: "Head FM" });
  const get = await harness.get("/v1/search?limit=64");
  const head = await harness.get("/v1/search?limit=64", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.etag, get.headers.etag);
  assert.equal(head.headers["content-length"], String(get.bytes.length));
  const conditionalHead = await harness.get("/v1/search?limit=64", { method: "HEAD", headers: { "if-none-match": get.headers.etag } });
  assert.equal(conditionalHead.status, 304);
});

test("every failure uses the shared bounded error envelope", async t => {
  const harness = await startApi(t);
  const failures = [
    "/v1/unknown",
    "/v1/stations/not-a-key",
    "/v1/stations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "/v1/search?limit=0",
    "/v1/search?cursor=garbage",
    "/v1/records",
  ];
  for (const path of failures) {
    const response = await harness.get(path);
    assert.ok(response.status >= 400 && response.status < 600, path);
    assert.equal(typeof response.body.error.code, "string", path);
    assert.match(response.body.error.code, /^[a-z0-9_]+$/u, path);
    assert.ok(response.body.error.message.length > 0, path);
    assert.match(response.body.request_id, REQUEST_ID, path);
    assert.equal(response.text.includes("at Object."), false);
    assert.equal(Object.keys(response.body).sort().join(","), "error,request_id", path);
    assert.deepEqual(Object.keys(response.body.error).sort(), response.body.error.details ? ["code", "details", "message"] : ["code", "message"], path);
  }
});
