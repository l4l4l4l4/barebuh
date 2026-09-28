// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The records feed and snapshot recovery views over HTTP: page shape, cursor bindings, expiry and
// staleness answers, the stable snapshot window, and the mode gate that keeps both routes absent
// in the default read-only mode.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize } from "../../protocol/v1/lib/conformance.mjs";
import { loadConfig } from "../src/config.mjs";
import { FEED_KINDS, recordsFeedPage, snapshotPage } from "../src/store/feed.mjs";
import { createRegistryServer } from "../src/http.mjs";
import { encodeCursorToken } from "../src/store/cursor.mjs";
import { migrateDatabase, openDatabase } from "../src/store/db.mjs";
import { ingestDocument } from "../src/store/records.mjs";
import { createSigner, nodeCardRecord, recordIdOf, stationBody, stationRecord, VALIDATION_TIME } from "./fixtures.mjs";

const migrationsDir = new URL("../migrations/", import.meta.url);
const FEDERATION_ENV = Object.freeze({
  BAREBUH_FEDERATION_ENABLED: "true",
  BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION",
});

async function startRegistry(t, { federation = true, documents = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "barebuh-feed-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "registry.sqlite3");
  await migrateDatabase(databasePath, { migrationsDir });

  const writer = openDatabase(databasePath);
  t.after(() => writer.close());
  const ingested = [];
  for (const [index, envelope] of documents.entries()) {
    const result = ingestDocument(writer, Buffer.from(JSON.stringify(envelope)), { now: VALIDATION_TIME, sourceId: `fixture-${index}` });
    ingested.push(result);
  }

  const db = openDatabase(databasePath, { readOnly: true });
  t.after(() => db.close());
  const clock = { now: VALIDATION_TIME };
  const config = loadConfig({
    ...(federation ? FEDERATION_ENV : {}),
    BAREBUH_DATABASE_PATH: databasePath,
    BAREBUH_PORT: "0",
    BAREBUH_PUBLIC_BASE_URL: "https://registry.example/",
  });
  const server = createRegistryServer({ config, db, clock: () => clock.now });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    clock,
    config,
    db,
    ingested,
    writer,
    async get(path) {
      const response = await fetch(`${base}${path}`);
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, headers: response.headers, body };
    },
  };
}

// A small mixed-kind fixture: two station histories plus one node card, ingested in this order.
function mixedDocuments() {
  const stationA = createSigner("station");
  const stationB = createSigner("station");
  const node = createSigner("node");
  const a0 = stationRecord(stationA, { sequence: 0, station: stationBody("Alpha FM", { tags: ["jazz"] }) });
  const a1 = stationRecord(stationA, { sequence: 1, parents: [recordIdOf(a0)], station: stationBody("Alpha FM renewed", { tags: ["jazz"] }) });
  const card = nodeCardRecord(node, {});
  const b0 = stationRecord(stationB, { sequence: 0, station: stationBody("Beta FM") });
  return { stationA, stationB, node, documents: [a0, a1, card, b0], a0, a1, card, b0 };
}

test("the feed and snapshot routes exist only in the pinned-federation mode and stay read-only", async t => {
  const fixture = mixedDocuments();
  const local = await startRegistry(t, { federation: false, documents: fixture.documents });

  assert.equal((await local.get("/v1/records")).status, 404);
  assert.equal((await local.get("/v1/snapshot")).status, 404);
  const descriptor = await local.get("/.well-known/open-radio-registry");
  assert.equal(descriptor.status, 200);
  assert.equal(descriptor.body.records, "https://registry.example/v1/records");

  const federated = await startRegistry(t, { documents: fixture.documents });
  const feed = await federated.get("/v1/records");
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(feed.body).sort(), ["checkpoint", "has_more", "items", "next_cursor"]);
  assert.equal(feed.body.items.length, 4);
  assert.equal(feed.body.has_more, false);
  assert.equal(feed.body.next_cursor, null);
  assert.equal(typeof feed.body.checkpoint, "string");

  // The submission boundary is still refused first, and mutations are still 405.
  const submit = await fetch(`${federated.base}/v1/records`, { method: "POST", body: "{}" });
  assert.equal(submit.status, 403);
  const refusal = await submit.json();
  assert.equal(refusal.error.code, "submission_disabled");
  assert.equal(refusal.error.message, "This node does not accept record submissions.");
  assert.match(refusal.request_id, /^[0-9a-f-]{36}$/u);
  assert.equal((await fetch(`${federated.base}/v1/records`, { method: "PUT" })).status, 405);
  assert.equal((await fetch(`${federated.base}/v1/snapshot`, { method: "DELETE" })).status, 405);
});

test("a full feed walk is exact, ordered, and byte-identical to the stored relay envelopes", async t => {
  const fixture = mixedDocuments();
  const registry = await startRegistry(t, { documents: fixture.documents });
  const expected = [fixture.a0, fixture.a1, fixture.card, fixture.b0].map(envelope => ({ recordId: recordIdOf(envelope), canonical: canonicalize(envelope.payload) }));

  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = await registry.get(`/v1/records?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    assert.equal(page.status, 200);
    for (const item of page.body.items) {
      seen.push(item);
      assert.match(item.record_id, /^sha256:[A-Za-z0-9_-]{43}$/u);
      assert.equal(recordIdOf(item.envelope), item.record_id, "the served envelope recomputes to the published record ID");
      assert.equal(canonicalize(item.envelope.payload), expected[seen.length - 1].canonical);
    }
    pages += 1;
    if (!page.body.has_more) {
      assert.equal(page.body.next_cursor, null);
      break;
    }
    assert.equal(typeof page.body.next_cursor, "string");
    cursor = page.body.next_cursor;
  }

  assert.equal(pages, 2);
  assert.deepEqual(seen.map(item => item.record_id), expected.map(item => item.recordId), "the walk returns every record exactly once, in ingest order");

  // A paused walk must not shift: an append between two pages is only visible after the resume
  // point, never inside the already-walked range.
  const first = await registry.get("/v1/records?limit=2");
  const late = stationRecord(fixture.stationB, { sequence: 1, parents: [recordIdOf(fixture.b0)], station: stationBody("Beta FM renewed") });
  ingestDocument(registry.writer, Buffer.from(JSON.stringify(late)), { now: VALIDATION_TIME, sourceId: "fixture-late" });
  const resumed = await registry.get(`/v1/records?limit=10&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.items.map(item => item.record_id), [recordIdOf(fixture.card), recordIdOf(fixture.b0), recordIdOf(late)]);
});

test("the kinds filter is order-insensitive, bound to the cursor, and bounded in size", async t => {
  const fixture = mixedDocuments();
  const registry = await startRegistry(t, { documents: fixture.documents });

  const stations = await registry.get("/v1/records?kinds=station&limit=10");
  assert.deepEqual(stations.body.items.map(item => item.record_id), [recordIdOf(fixture.a0), recordIdOf(fixture.a1), recordIdOf(fixture.b0)]);
  const reordered = await registry.get("/v1/records?kinds=node,station&limit=10");
  const reorderedAgain = await registry.get("/v1/records?kinds=station,node&limit=10");
  assert.equal(canonicalize(reordered.body.items.map(item => item.record_id)), canonicalize(reorderedAgain.body.items.map(item => item.record_id)));
  assert.equal(reordered.body.items.length, 4);

  // A cursor minted under a different filter is a binding mismatch, not a shifted page.
  const mismatch = await registry.get(`/v1/records?kinds=station&limit=1&cursor=${encodeURIComponent(reordered.body.checkpoint)}`);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, "cursor_binding_mismatch");
  assert.equal(mismatch.body.error.details ?? null, null, "details stay optional, and no position is leaked");

  // A snapshot cursor cannot drive the feed, and vice versa.
  const snapshot = await registry.get("/v1/snapshot?limit=1");
  const crossFeed = await registry.get(`/v1/records?limit=1&cursor=${encodeURIComponent(snapshot.body.next_cursor)}`);
  assert.equal(crossFeed.status, 400);
  assert.equal(crossFeed.body.error.code, "cursor_binding_mismatch");
  const crossFeedSnapshot = await registry.get(`/v1/snapshot?limit=1&cursor=${encodeURIComponent(snapshot.body.checkpoint)}`);
  assert.equal(crossFeedSnapshot.status, 400);
  assert.equal(crossFeedSnapshot.body.error.code, "cursor_binding_mismatch");

  const unknownParameter = await registry.get("/v1/records?since=2026-09-26T12:00:00Z");
  assert.equal(unknownParameter.status, 400);
  assert.equal(unknownParameter.body.error.code, "invalid_parameter");
  assert.deepEqual(unknownParameter.body.error.details, { parameter: "since", reason: "unknown_parameter" });
  const duplicate = await registry.get("/v1/records?limit=1&limit=2");
  assert.equal(duplicate.status, 400);
  assert.deepEqual(duplicate.body.error.details, { parameter: "limit", reason: "duplicate_parameter" });
  const tooLarge = await registry.get("/v1/records?limit=1001");
  assert.equal(tooLarge.status, 400);
  assert.deepEqual(tooLarge.body.error.details, { parameter: "limit", reason: "out_of_bounds" });
  const unknownKind = await registry.get("/v1/records?kinds=station,banana");
  assert.equal(unknownKind.status, 400);
  assert.deepEqual(unknownKind.body.error.details, { parameter: "kinds", reason: "invalid_value" });
  // Duplicated kinds would make the filter non-canonical, so it is rejected instead of normalized.
  const duplicatedKinds = await registry.get("/v1/records?kinds=station,station");
  assert.equal(duplicatedKinds.status, 400);
});

test("expired and stale cursors answer 410 with the snapshot recovery contract", async t => {
  const fixture = mixedDocuments();
  const registry = await startRegistry(t, { documents: fixture.documents });

  const first = await registry.get("/v1/records?limit=1");
  assert.equal(first.status, 200);
  const cursor = first.body.next_cursor;
  assert.equal((await registry.get(`/v1/records?limit=1&cursor=${encodeURIComponent(cursor)}`)).status, 200);

  // One second past the cursor lifetime the walk can no longer be resumed: the answer carries the
  // snapshot URL, and no record is served with it.
  registry.clock.now = "2026-09-26T12:36:00Z";
  const expired = await registry.get(`/v1/records?limit=1&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, "cursor_expired");
  assert.deepEqual(expired.body.error.details, { snapshot: "https://registry.example/v1/snapshot" });
  assert.equal(expired.body.items, undefined);

  // A token whose anchor no longer exists at that position is stale, not silently shifted.
  registry.clock.now = VALIDATION_TIME;
  const forged = encodeCursorToken({
    anchor: `sha256:${"A".repeat(43)}`,
    after_seq: 1,
    expires_at: "2026-09-26T13:00:00Z",
    feed: "records",
    kinds: ["node", "observation", "station"],
    v: 1,
  });
  const stale = await registry.get(`/v1/records?limit=10&kinds=node,observation,station&cursor=${encodeURIComponent(forged)}`);
  assert.equal(stale.status, 410);
  assert.equal(stale.body.error.code, "cursor_stale");
  assert.deepEqual(stale.body.error.details, { snapshot: "https://registry.example/v1/snapshot" });

  // A malformed token is a 400, never a 410 and never a page.
  const malformed = await registry.get("/v1/records?cursor=c1.not-base64url!");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "cursor_invalid");
});

test("a snapshot import is stable while the feed appends, and its checkpoint resumes the feed", async t => {
  const fixture = mixedDocuments();
  const registry = await startRegistry(t, { documents: fixture.documents });

  const first = await registry.get("/v1/snapshot?limit=2");
  assert.equal(first.status, 200);
  assert.equal(first.body.has_more, true);
  assert.deepEqual(first.body.items.map(item => item.record_id), [recordIdOf(fixture.a0), recordIdOf(fixture.a1)]);

  // Appends after the snapshot started are outside its window: the multi-page import stays stable
  // and cannot double-serve or skip a record because the head moved under it.
  const late = stationRecord(fixture.stationB, { sequence: 1, parents: [recordIdOf(fixture.b0)], station: stationBody("Beta FM renewed") });
  ingestDocument(registry.writer, Buffer.from(JSON.stringify(late)), { now: VALIDATION_TIME, sourceId: "fixture-late" });

  const second = await registry.get(`/v1/snapshot?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.has_more, false);
  assert.equal(second.body.next_cursor, null);
  assert.deepEqual(second.body.items.map(item => item.record_id), [recordIdOf(fixture.card), recordIdOf(fixture.b0)], "the late append is not part of the snapshot window");

  // The final checkpoint is a feed position that covers the snapshot and everything recorded
  // before the page was cut, so the resumed feed serves exactly the records after it.
  const resumed = await registry.get(`/v1/records?limit=10&cursor=${encodeURIComponent(second.body.checkpoint)}`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.items.map(item => item.record_id), [recordIdOf(late)]);

  // Snapshot and feed agree on the union: nothing is served twice and nothing is lost.
  const walk = new Set([...first.body.items, ...second.body.items].map(item => item.record_id));
  assert.equal(walk.size, 4);
  const all = await registry.get("/v1/records?limit=100");
  assert.equal(all.body.items.length, 5);
});

test("an empty store serves an empty final page and a usable checkpoint", async t => {
  const registry = await startRegistry(t);
  const feed = await registry.get("/v1/records");
  assert.deepEqual(feed.body, { items: [], next_cursor: null, has_more: false, checkpoint: feed.body.checkpoint });
  const snapshot = await registry.get("/v1/snapshot");
  assert.deepEqual(snapshot.body, { items: [], next_cursor: null, has_more: false, checkpoint: snapshot.body.checkpoint });
  const resumed = await registry.get(`/v1/records?cursor=${encodeURIComponent(feed.body.checkpoint)}`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.items, []);
});

test("the page byte budget stops a page early without ever emptying or truncating a record", async t => {
  const signer = createSigner("station");
  const documents = [];
  let parents = [];
  for (let sequence = 0; sequence < 5; sequence += 1) {
    const envelope = stationRecord(signer, { sequence, parents, station: stationBody(`Budget FM ${sequence}`, { tags: ["budget"] }) });
    parents = [recordIdOf(envelope)];
    documents.push(envelope);
  }
  const registry = await startRegistry(t, { documents });
  const expected = registry.ingested.map(result => result.recordId);
  const sizes = registry.db.prepare("SELECT length(relay_envelope) AS bytes FROM records ORDER BY ingest_seq").all().map(row => row.bytes + 64);
  const page = (cursor, budget) => recordsFeedPage(registry.db, { cursor, kinds: FEED_KINDS, limit: 100, limits: { maxResponseBytes: budget }, nowIso: VALIDATION_TIME, snapshotUrl: "https://registry.example/v1/snapshot" });

  // A budget that fits two records but not three stops each page at two and reports has_more, so
  // the walk resumes exactly where it stopped instead of overflowing the budget.
  const budget = 2 * Math.max(...sizes) + 8;
  const first = page(null, budget);
  assert.equal(first.items.length, 2);
  assert.equal(first.has_more, true);
  const second = page(first.next_cursor, budget);
  assert.equal(second.items.length, 2);
  assert.equal(second.has_more, true);
  const third = page(second.next_cursor, budget);
  assert.equal(third.items.length, 1);
  assert.equal(third.has_more, false);
  assert.equal(third.next_cursor, null);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.record_id), expected, "the walk is exact under a byte-budgeted page");

  // A budget smaller than a single record still serves that record: a page is never empty while
  // records remain, because at least one item is always present.
  const tiny = page(null, 16);
  assert.equal(tiny.items.length, 1);
  assert.equal(tiny.has_more, true);
  const tinySnapshot = snapshotPage(registry.db, { cursor: null, kinds: FEED_KINDS, limit: 100, limits: { maxResponseBytes: 16 }, nowIso: VALIDATION_TIME, snapshotUrl: "https://registry.example/v1/snapshot" });
  assert.equal(tinySnapshot.items.length, 1);
  assert.equal(tinySnapshot.has_more, true);
  assert.equal(tinySnapshot.items[0].record_id, expected[0]);

  // The snapshot walk under the same budget covers the whole retained set exactly once.
  const walk = [];
  let cursor = null;
  for (;;) {
    const snapshot = snapshotPage(registry.db, { cursor, kinds: FEED_KINDS, limit: 100, limits: { maxResponseBytes: budget }, nowIso: VALIDATION_TIME, snapshotUrl: "https://registry.example/v1/snapshot" });
    walk.push(...snapshot.items.map(item => item.record_id));
    if (!snapshot.has_more) break;
    cursor = snapshot.next_cursor;
  }
  assert.deepEqual(walk, expected);
});
