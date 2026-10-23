// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Ingest behaviour is driven by the shared protocol fixtures and by boundary documents built at
// N and N+1 of every published limit. Rejected input must never touch the immutable store, the
// policy rows, the materialization queue, or the projection generation.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { BOUNDED_JSON_LIMITS, parseJsonStrict, STATION_TAG_MAX_BYTES } from "../../protocol/v1/lib/conformance.mjs";
import { stationRecordIssues } from "../src/store/dag.mjs";
import { INGEST_LIMITS, INGEST_STATUS, ingestDocument, loadStationRecordViews, setRecordPolicy } from "../src/store/records.mjs";
import {
  countRows,
  createRegistry,
  createSigner,
  digestOfUrl,
  nestedArrays,
  nodeCardRecord,
  observationRecord,
  policyRow,
  recordIdOf,
  stationBody,
  stationRecord,
  streamFor,
  streamUrl,
  VALIDATION_TIME,
} from "./fixtures.mjs";

const fixturesRoot = new URL("../../protocol/v1/fixtures/", import.meta.url);

function storeCounts(db) {
  return {
    records: countRows(db, "records"),
    provenance: countRows(db, "record_sources"),
    policy: countRows(db, "record_policy"),
    queue: countRows(db, "materialize_queue"),
    quarantine: countRows(db, "quarantine"),
    generation: db.prepare("SELECT generation FROM projection_meta WHERE singleton = 1").get().generation,
  };
}

// Station-local DAG issues of one record, exactly as the durable classification computes them.
function issuesOf(db, recordId, stationId) {
  const records = loadStationRecordViews(db, stationId);
  const byId = new Map(records.map(record => [record.recordId, record]));
  return stationRecordIssues(byId.get(recordId), byId);
}

function assertStoreUntouched(db, before, { quarantined = 0 } = {}) {
  const after = storeCounts(db);
  assert.equal(after.records, before.records, "records changed");
  assert.equal(after.provenance, before.provenance, "provenance changed");
  assert.equal(after.policy, before.policy, "policy changed");
  assert.equal(after.queue, before.queue, "queue changed");
  assert.equal(after.generation, before.generation, "projection generation changed");
  assert.equal(after.quarantine, before.quarantine + quarantined, "quarantine evidence count changed unexpectedly");
}

// Stands in for the materializer while only the ingest domain is under test: an active station
// projection with the given stream URLs and the genesis record as its visible winner.
function seedProjection(db, { stationId, recordId, urls }) {
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO station_state(station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at) VALUES (?, ?, ?, 'active', 0, 1, '2026-09-26T12:00:00Z')")
    .run(stationId, recordId, recordId);
  db.prepare("INSERT INTO station_projection(station_id, visible_record_id, winning_sequence, name, normalized_name, station_json, provenance_json, indexed_at, generation) VALUES (?, ?, 0, 'seeded', 'seeded', '{}', '[]', '2026-09-26T12:00:00Z', 1)")
    .run(stationId, recordId);
  for (const [ordinal, url] of urls.entries()) {
    db.prepare("INSERT INTO station_streams(station_id, ordinal, url, url_digest, transport, container, codec, bitrate_kbps) VALUES (?, ?, ?, ?, 'https', 'audio/mpeg', 'mp3', 128)")
      .run(stationId, ordinal, url, digestOfUrl(url));
  }
  db.exec("COMMIT");
}

test("golden protocol fixtures drive ingest: valid envelopes are stored, invalid ones are quarantined at their declared stage", async t => {
  const registry = await createRegistry(t);
  const manifest = parseJsonStrict(readFileSync(new URL("manifest.json", fixturesRoot)));
  for (const fixture of manifest.fixtures) {
    const bytes = readFileSync(new URL(fixture.file, fixturesRoot));
    const before = storeCounts(registry.db);
    const result = ingestDocument(registry.db, bytes, { validationTime: VALIDATION_TIME });
    if (fixture.valid) {
      assert.equal(result.status, INGEST_STATUS.stored, fixture.name);
      assert.equal(result.recordId, fixture.record_id, fixture.name);
      assert.equal(result.kind, fixture.kind, fixture.name);
      assert.equal(result.materializable, fixture.materializable ?? true, fixture.name);
      if (fixture.unsupported_critical) assert.deepEqual(result.unsupportedCritical, fixture.unsupported_critical, fixture.name);
      const after = storeCounts(registry.db);
      assert.equal(after.records, before.records + 1, fixture.name);
      assert.equal(after.quarantine, before.quarantine, fixture.name);
      if (fixture.kind === "observation") {
        // The valid observation references a station identity that this node has raw records for
        // (the fixtures share one key) but has never materialized, so it is stored and held.
        assert.equal(result.policyState, "quarantined", fixture.name);
        assert.equal(policyRow(registry.db, result.recordId).reasonCode, "observation_station_unresolved", fixture.name);
      }
    } else {
      assert.equal(result.status, INGEST_STATUS.quarantined, fixture.name);
      assert.equal(result.stage, fixture.stage, `${fixture.name}: ${result.message}`);
      assert.ok(result.message.includes(fixture.message_contains), `${fixture.name}: ${result.message}`);
      assertStoreUntouched(registry.db, before, { quarantined: 1 });
    }
  }
});

test("every published ingest limit passes at N and fails closed at N+1", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const parentIds = Array.from({ length: 9 }, (_, index) => `sha256:${String(index).padStart(2, "0")}${"A".repeat(41)}`);
  const longUrl = size => `https://stream.example.invalid/${"a".repeat(size - "https://stream.example.invalid/".length)}`;
  const cases = [
    { label: "station name bytes", limit: 200, build: size => stationRecord(signer, { sequence: 0, station: { ...stationBody(), name: "n".repeat(size) } }) },
    { label: "streams", limit: 16, build: size => stationRecord(signer, { sequence: 0, station: { name: "S", streams: Array.from({ length: size }, (_, index) => streamFor(streamUrl(index))) } }) },
    { label: "tags", limit: 32, build: size => stationRecord(signer, { sequence: 0, station: { ...stationBody(), tags: Array.from({ length: size }, (_, index) => `tag-${index}`) } }) },
    // The per-tag byte bound is the desktop client's parser bound: one oversized tag makes the
    // client drop the whole page, so a record containing one must fail here instead.
    { label: "tag bytes", limit: STATION_TAG_MAX_BYTES, build: size => stationRecord(signer, { sequence: 0, station: { ...stationBody(), tags: ["t".repeat(size)] } }) },
    { label: "languages", limit: 16, build: size => stationRecord(signer, { sequence: 0, station: { ...stationBody(), languages: Array.from({ length: size }, (_, index) => `en-${index}`) } }) },
    { label: "stream URL bytes", limit: 2048, build: size => stationRecord(signer, { sequence: 0, station: { name: "S", streams: [streamFor(longUrl(size))] } }) },
    { label: "parents", limit: 8, build: size => stationRecord(signer, { sequence: 1, parents: parentIds.slice(0, size), station: stationBody() }) },
  ];
  for (const testCase of cases) {
    const accepted = ingestDocument(registry.db, signer.bytes(testCase.build(testCase.limit)), { validationTime: VALIDATION_TIME });
    assert.equal(accepted.status, INGEST_STATUS.stored, `${testCase.label} at N=${testCase.limit}: ${accepted.message ?? ""}`);
    const before = storeCounts(registry.db);
    const rejected = ingestDocument(registry.db, signer.bytes(testCase.build(testCase.limit + 1)), { validationTime: VALIDATION_TIME });
    assert.equal(rejected.status, INGEST_STATUS.quarantined, `${testCase.label} at N+1`);
    assert.equal(rejected.stage, "validation", `${testCase.label} at N+1: ${rejected.message}`);
    assertStoreUntouched(registry.db, before, { quarantined: 1 });
  }
});

test("document and nesting bounds are enforced before any parsing or store work", async t => {
  const registry = await createRegistry(t);
  // The JSON document bound is exclusive at N: a 65,536-byte body reaches the parser (and fails
  // there because it is whitespace), while 65,537 bytes is stopped by the bounds gate.
  const before = storeCounts(registry.db);
  const atLimit = ingestDocument(registry.db, Buffer.alloc(INGEST_LIMITS.maxDocumentBytes, 0x20));
  assert.equal(atLimit.stage, "parse");
  const overLimit = ingestDocument(registry.db, Buffer.alloc(INGEST_LIMITS.maxDocumentBytes + 1, 0x20));
  assert.equal(overLimit.stage, "bounds");
  assert.equal(overLimit.reasonCode, "document_too_large");
  assertStoreUntouched(registry.db, before, { quarantined: 2 });

  // Nesting: find the deepest document the bounded parser accepts, then prove N+1 is refused by
  // both the parser and ingest without store effects. A nested array costs one level for its
  // element, so `nestedArrays(d)` reaches depth d + 1.
  let maximum = 0;
  while (true) {
    try {
      parseJsonStrict(JSON.stringify(nestedArrays(maximum + 1)));
      maximum += 1;
    } catch {
      break;
    }
  }
  assert.equal(maximum + 1, BOUNDED_JSON_LIMITS.max_depth);
  assert.throws(() => parseJsonStrict(JSON.stringify(nestedArrays(maximum + 1))), /depth limit/u);

  const signer = createSigner("station");
  const depth = count => signer.bytes(stationRecord(signer, { sequence: 0, station: stationBody(), extra: { future: nestedArrays(count) } }));
  let envelopeMaximum = 0;
  while (true) {
    const result = ingestDocument(registry.db, depth(envelopeMaximum + 1), { validationTime: VALIDATION_TIME });
    if (result.status !== INGEST_STATUS.stored) break;
    envelopeMaximum += 1;
  }
  assert.ok(envelopeMaximum > 0);
  const beforeDepth = storeCounts(registry.db);
  const tooDeep = ingestDocument(registry.db, depth(envelopeMaximum + 1), { validationTime: VALIDATION_TIME });
  assert.equal(tooDeep.stage, "parse", tooDeep.message);
  assert.match(tooDeep.message, /depth limit/u);
  assertStoreUntouched(registry.db, beforeDepth, { quarantined: 1 });
});

test("duplicate record IDs are idempotent: immutable bytes stay untouched and provenance advances", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const bytes = signer.bytes(stationRecord(signer, { sequence: 0, station: stationBody("Alpha") }));

  const first = ingestDocument(registry.db, bytes, { now: "2026-09-26T12:00:00Z", validationTime: VALIDATION_TIME, sourceId: "operator" });
  assert.equal(first.status, INGEST_STATUS.stored);
  const readRow = () => registry.db.prepare("SELECT canonical_payload, relay_envelope, proof_signature, inserted_at, materializable, unsupported_critical_json FROM records WHERE record_id = ?").get(first.recordId);
  const stored = readRow();

  const second = ingestDocument(registry.db, bytes, { now: "2026-09-26T12:05:00Z", validationTime: VALIDATION_TIME, sourceId: "operator" });
  assert.equal(second.status, INGEST_STATUS.duplicate);
  assert.equal(second.recordId, first.recordId);
  const after = readRow();
  assert.ok(Buffer.from(after.canonical_payload).equals(Buffer.from(stored.canonical_payload)));
  assert.ok(Buffer.from(after.relay_envelope).equals(Buffer.from(stored.relay_envelope)));
  assert.ok(Buffer.from(after.proof_signature).equals(Buffer.from(stored.proof_signature)));
  assert.equal(after.inserted_at, stored.inserted_at);
  assert.equal(countRows(registry.db, "records"), 1);

  const provenance = registry.db.prepare("SELECT source_kind, source_id, first_seen_at, last_seen_at, receipt_count FROM record_sources WHERE record_id = ?").all(first.recordId).map(row => ({ ...row }));
  assert.deepEqual(provenance, [{ source_kind: "local", source_id: "operator", first_seen_at: "2026-09-26T12:00:00Z", last_seen_at: "2026-09-26T12:05:00Z", receipt_count: 2 }]);
});

test("malformed and hostile documents leave the store, the queue, and the generation untouched", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const valid = stationRecord(signer, { sequence: 0, station: stationBody() });
  const flipped = `${valid.proof.signature[0] === "A" ? "B" : "A"}${valid.proof.signature.slice(1)}`;
  const withProof = proof => Buffer.from(JSON.stringify({ ...valid, proof }));
  const inputs = [
    ["not JSON at all", "parse"],
    ['{"payload":{"a":1,"a":2}}', "parse"],
    ['{"payload":{"sequence":9007199254740992}}', "parse"],
    [JSON.stringify({ future: nestedArrays(BOUNDED_JSON_LIMITS.max_depth + 4) }), "parse"],
    [JSON.stringify({ ...valid, payload: { ...valid.payload, protocol: "oradio/2" } }), "validation"],
    [withProof({ ...valid.proof, alg: "ES256" }), "validation"],
    [withProof({ ...valid.proof, signature: "!" }), "validation"],
    [withProof({ ...valid.proof, signature: flipped }), "validation"],
  ];
  for (const [input, stage] of inputs) {
    const before = storeCounts(registry.db);
    const result = ingestDocument(registry.db, input, { validationTime: VALIDATION_TIME });
    assert.equal(result.status, INGEST_STATUS.quarantined, JSON.stringify(input).slice(0, 80));
    assert.equal(result.stage, stage, `${JSON.stringify(input).slice(0, 80)}: ${result.message}`);
    assertStoreUntouched(registry.db, before, { quarantined: 1 });
  }
  const evidence = registry.db.prepare("SELECT failure_stage, reason_code, length(bounded_raw_envelope) AS size, expires_at FROM quarantine ORDER BY id").all().map(row => ({ ...row }));
  assert.equal(evidence.length, inputs.length);
  assert.ok(evidence.every(row => row.size > 0 && row.expires_at > "2026-01-01"));
});

test("orphan station records are stored immediately, promoted when parents arrive, and rules are enforced on arrival", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const other = createSigner("station");
  const otherGenesis = stationRecord(other, { sequence: 0, station: stationBody("Other") });
  const genesis = stationRecord(signer, { sequence: 0, station: stationBody("Alpha") });
  const update = stationRecord(signer, { sequence: 1, parents: [recordIdOf(genesis)], station: stationBody("Alpha renewed") });
  const rogue = stationRecord(signer, { sequence: 7, parents: [recordIdOf(genesis)], station: stationBody("Rogue") });
  const rogueChild = stationRecord(signer, { sequence: 8, parents: [recordIdOf(rogue)], station: stationBody("Rogue child") });
  const foreignParent = stationRecord(signer, { sequence: 1, parents: [recordIdOf(otherGenesis)], station: stationBody("Foreign parent") });

  // Everything except the genesis arrives before its parents exist: all of it is stored as
  // orphans and stays admitted.
  for (const envelope of [update, rogue, rogueChild, foreignParent, otherGenesis]) {
    const result = ingestDocument(registry.db, Buffer.from(JSON.stringify(envelope)), { validationTime: VALIDATION_TIME });
    assert.equal(result.status, INGEST_STATUS.stored, result.message ?? "");
  }
  assert.equal(policyRow(registry.db, recordIdOf(rogue)).reasonCode, "local_ingest");
  assert.deepEqual(issuesOf(registry.db, recordIdOf(update), signer.identity), ["parent_missing"]);

  // The genesis record completes three parent sets at once. The valid update stays admitted; the
  // sequence violation and the record referencing a foreign station are quarantined; the child of
  // the quarantined record is quarantined in the same call (fixpoint).
  const genesisResult = ingestDocument(registry.db, Buffer.from(JSON.stringify(genesis)), { validationTime: VALIDATION_TIME });
  assert.equal(genesisResult.status, INGEST_STATUS.stored);
  assert.deepEqual(policyRow(registry.db, recordIdOf(update)), { state: "admitted", reasonCode: "local_ingest" });
  assert.deepEqual(policyRow(registry.db, recordIdOf(rogue)), { state: "quarantined", reasonCode: "sequence_rule_violation" });
  assert.deepEqual(policyRow(registry.db, recordIdOf(rogueChild)), { state: "quarantined", reasonCode: "parent_invalid" });
  assert.deepEqual(policyRow(registry.db, recordIdOf(foreignParent)), { state: "quarantined", reasonCode: "parent_station_mismatch" });
  assert.deepEqual(issuesOf(registry.db, recordIdOf(update), signer.identity), []);
  assert.equal(loadStationRecordViews(registry.db, signer.identity).length, 5);
  assert.equal(countRows(registry.db, "materialize_queue"), 2, "each station is queued exactly once");
});

test("held records stay out of materialization until an administrator admits them", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const envelope = Buffer.from(JSON.stringify(stationRecord(signer, { sequence: 0, station: stationBody("Held") })));
  const held = ingestDocument(registry.db, envelope, { accept: false, validationTime: VALIDATION_TIME });
  assert.equal(held.status, INGEST_STATUS.stored);
  assert.equal(held.policyState, "quarantined");
  assert.equal(policyRow(registry.db, held.recordId).reasonCode, "held_for_admission");

  const admitted = setRecordPolicy(registry.db, held.recordId, "admitted");
  assert.equal(admitted.policy, "admitted");
  assert.equal(policyRow(registry.db, held.recordId).reasonCode, "admin_admitted");
  const suppressed = setRecordPolicy(registry.db, held.recordId, "suppressed");
  assert.equal(suppressed.policy, "suppressed");
  assert.throws(() => setRecordPolicy(registry.db, held.recordId, "invented"), /unsupported policy state/u);
  assert.throws(() => setRecordPolicy(registry.db, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "admitted"), /unknown record/u);
  assert.equal(countRows(registry.db, "materialize_queue"), 1);
});

test("observations outside the materialized station scope are stored but quarantined", async t => {
  const registry = await createRegistry(t);
  const station = createSigner("station");
  const node = createSigner("node");
  const genesis = stationRecord(station, { sequence: 0, station: stationBody("Scoped", { streams: 2 }) });
  const genesisBytes = Buffer.from(JSON.stringify(genesis));
  assert.equal(ingestDocument(registry.db, genesisBytes, { validationTime: VALIDATION_TIME }).status, INGEST_STATUS.stored);
  seedProjection(registry.db, { stationId: station.identity, recordId: recordIdOf(genesis), urls: [streamUrl(0), streamUrl(1)] });

  const cases = [
    { endpoint: { endpoint_index: 0 }, expected: "admitted" },
    { endpoint: { endpoint_index: 2 }, expected: "observation_endpoint_out_of_scope" },
    { endpoint: { stream_url_digest: digestOfUrl(streamUrl(1)) }, expected: "admitted" },
    { endpoint: { stream_url_digest: digestOfUrl("https://stream.example.invalid/other") }, expected: "observation_endpoint_out_of_scope" },
    { endpoint: { stream_url_digest: digestOfUrl(streamUrl(0)) }, expected: "admitted" },
  ];
  for (const testCase of cases) {
    const envelope = node.bytes(observationRecord(node, { stationId: station.identity, endpoint: testCase.endpoint }));
    const result = ingestDocument(registry.db, envelope, { validationTime: VALIDATION_TIME });
    assert.equal(result.status, INGEST_STATUS.stored, JSON.stringify(testCase.endpoint));
    const policy = policyRow(registry.db, result.recordId);
    if (testCase.expected === "admitted") assert.equal(policy.state, "admitted", JSON.stringify(testCase.endpoint));
    else {
      assert.equal(policy.state, "quarantined");
      assert.equal(policy.reasonCode, testCase.expected);
    }
  }

  // Unknown, unresolved, and tombstoned stations are distinct reasons. The payloads differ from
  // the cases above so each one is a new record rather than an idempotent duplicate.
  const unknown = ingestDocument(registry.db, node.bytes(observationRecord(node, { stationId: "oradio:station:ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", endpoint: { endpoint_index: 0 } })), { validationTime: VALIDATION_TIME });
  assert.equal(policyRow(registry.db, unknown.recordId).reasonCode, "observation_station_unknown");
  const setStationState = state => {
    registry.db.exec("BEGIN IMMEDIATE");
    registry.db.prepare("UPDATE station_state SET state = ? WHERE station_id = ?").run(state, station.identity);
    registry.db.exec("COMMIT");
  };
  setStationState("suppressed");
  const unresolved = ingestDocument(registry.db, node.bytes(observationRecord(node, { stationId: station.identity, endpoint: { endpoint_index: 0 }, extra: { latency_ms: 10 } })), { validationTime: VALIDATION_TIME });
  assert.equal(policyRow(registry.db, unresolved.recordId).reasonCode, "observation_station_unresolved");
  setStationState("tombstoned");
  const tombstoned = ingestDocument(registry.db, node.bytes(observationRecord(node, { stationId: station.identity, endpoint: { endpoint_index: 0 }, extra: { latency_ms: 11 } })), { validationTime: VALIDATION_TIME });
  assert.equal(policyRow(registry.db, tombstoned.recordId).reasonCode, "observation_station_tombstoned");
  assert.equal(countRows(registry.db, "materialize_queue"), 1, "observations never enqueue station work");
});

test("node cards are stored with provenance under their signed lifetime and never materialize", async t => {
  const registry = await createRegistry(t);
  const node = createSigner("node");
  const stored = ingestDocument(registry.db, node.bytes(nodeCardRecord(node)), { validationTime: VALIDATION_TIME });
  assert.equal(stored.status, INGEST_STATUS.stored);
  assert.equal(stored.kind, "node");
  assert.equal(stored.subjectId, node.identity);
  assert.equal(stored.stationId, null);
  assert.equal(stored.policyState, "admitted");
  assert.equal(countRows(registry.db, "materialize_queue"), 0);

  const before = storeCounts(registry.db);
  const expired = ingestDocument(registry.db, node.bytes(nodeCardRecord(node, { issuedAt: "2026-09-26T09:00:00Z", expiresAt: "2026-09-26T10:00:00Z" })), {
    now: "2026-09-26T12:20:00Z",
    validationTime: VALIDATION_TIME,
  });
  assert.equal(expired.status, INGEST_STATUS.quarantined);
  assert.equal(expired.stage, "validation");
  assert.match(expired.message, /expired/u);
  assertStoreUntouched(registry.db, before, { quarantined: 1 });
});

// Regression: the default freshness clock must already be the wire's second-precision instant. A
// millisecond clock quarantines every node card and observation the administrator CLI ingests, so
// those records can never be admitted or served.
test("the default freshness clock admits live node cards and observations", async t => {
  const registry = await createRegistry(t);
  const node = createSigner("node");
  const second = milliseconds => `${new Date(milliseconds).toISOString().slice(0, 19)}Z`;
  const now = Date.now();

  const card = ingestDocument(registry.db, node.bytes(nodeCardRecord(node, { issuedAt: second(now - 60_000), expiresAt: second(now + 3_600_000) })));
  assert.equal(card.status, INGEST_STATUS.stored, card.message ?? "");
  assert.equal(card.kind, "node");
  assert.equal(card.policyState, "admitted");

  const station = createSigner("station");
  const genesis = stationRecord(station, { sequence: 0, station: stationBody("Fresh FM", { streams: 1 }) });
  assert.equal(ingestDocument(registry.db, station.bytes(genesis), { validationTime: VALIDATION_TIME }).status, INGEST_STATUS.stored);
  seedProjection(registry.db, { stationId: station.identity, recordId: recordIdOf(genesis), urls: [streamUrl(0)] });

  const observation = ingestDocument(registry.db, node.bytes(observationRecord(node, {
    stationId: station.identity,
    endpoint: { endpoint_index: 0 },
    observedAt: second(now - 60_000),
    expiresAt: second(now + 1_800_000),
  })));
  assert.equal(observation.status, INGEST_STATUS.stored, observation.message ?? "");
  assert.equal(policyRow(registry.db, observation.recordId).state, "admitted");
});

// Provenance identifiers are served in API responses, so they are bounded and validated at the
// boundary: a caller error fails loudly instead of storing an unbounded source record.
test("provenance source identifiers are bounded, validated, and stored verbatim when valid", async t => {
  const registry = await createRegistry(t);
  const station = createSigner("station");
  const bytes = station.bytes(stationRecord(station, { sequence: 0, station: stationBody("Source Bound FM") }));

  for (const sourceId of ["", "has space", "sla/sh", "ключ", "x".repeat(INGEST_LIMITS.maxSourceIdBytes + 1)]) {
    assert.throws(() => ingestDocument(registry.db, bytes, { sourceId }), TypeError, JSON.stringify(sourceId));
  }
  for (const sourceKind of ["", "has space", "x".repeat(33)]) {
    assert.throws(() => ingestDocument(registry.db, bytes, { sourceKind }), TypeError, JSON.stringify(sourceKind));
  }
  assert.equal(storeCounts(registry.db).records, 0, "a rejected source identifier must not store anything");

  // The documented shape still admits the kinds and identifiers peers and operators use.
  const stored = ingestDocument(registry.db, bytes, { sourceKind: "peer", sourceId: "node-a.example:8787" });
  assert.equal(stored.status, INGEST_STATUS.stored);
  assert.deepEqual(registry.db.prepare("SELECT source_kind, source_id FROM record_sources WHERE record_id = ?").all(stored.recordId).map(row => ({ ...row })), [{ source_kind: "peer", source_id: "node-a.example:8787" }]);
});

test("unknown non-critical members are preserved byte-for-byte and critical members block materialization", async t => {
  const registry = await createRegistry(t);
  const signer = createSigner("station");
  const body = stationBody("Extended", { future: { mode: "test" } });
  const extended = signer.bytes(stationRecord(signer, { sequence: 0, station: body }));
  const result = ingestDocument(registry.db, extended, { validationTime: VALIDATION_TIME });
  assert.equal(result.status, INGEST_STATUS.stored);
  assert.equal(result.materializable, true);
  const stored = registry.db.prepare("SELECT relay_envelope, canonical_payload FROM records WHERE record_id = ?").get(result.recordId);
  assert.ok(Buffer.from(stored.relay_envelope).equals(extended), "relay envelope bytes must round-trip unchanged");
  assert.deepEqual(parseJsonStrict(Buffer.from(stored.canonical_payload)).station.future, { mode: "test" });

  const criticalBytes = readFileSync(new URL("valid/critical-extension.json", fixturesRoot));
  const critical = ingestDocument(registry.db, criticalBytes, { validationTime: VALIDATION_TIME });
  assert.equal(critical.status, INGEST_STATUS.stored);
  assert.equal(critical.materializable, false);
  assert.deepEqual(critical.unsupportedCritical, ["future_feature"]);
  assert.deepEqual(policyRow(registry.db, critical.recordId), { state: "admitted", reasonCode: "local_ingest" });
  const unsupported = registry.db.prepare("SELECT unsupported_critical_json FROM records WHERE record_id = ?").get(critical.recordId);
  assert.equal(unsupported.unsupported_critical_json, '["future_feature"]');
});

test("store modules contain no network or process-probing code paths", () => {
  const storeDirectory = new URL("../src/store/", import.meta.url);
  const files = readdirSync(storeDirectory).filter(name => name.endsWith(".mjs"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const source = readFileSync(new URL(file, storeDirectory), "utf8");
    for (const forbidden of ["node:http", "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "fetch(", "XMLHttpRequest"]) {
      assert.ok(!source.includes(forbidden), `${file} must not reference ${forbidden}`);
    }
  }
});
