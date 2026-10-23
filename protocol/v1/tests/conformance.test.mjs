// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BOUNDED_JSON_LIMITS, canonicalize, parseJsonStrict, STATION_TAG_MAX_BYTES, STATION_TAG_MAX_ITEMS, validateEnvelope } from "../lib/conformance.mjs";

const protocolRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const publicKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const identityDigest = "If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk";
const stationId = `oradio:station:ed25519:${identityDigest}`;
const nodeId = `oradio:node:ed25519:${identityDigest}`;
const rootKey = { kty: "OKP", crv: "Ed25519", x: publicKey };

const validStationEnvelope = {
  payload: {
    protocol: "oradio/1",
    kind: "station",
    station_id: stationId,
    sequence: 0,
    parents: [],
    issued_at: "2026-09-26T12:00:00Z",
    root_key: rootKey,
    station: {
      name: "Example É FM",
      short_name: "EXFM",
      homepage: "https://example.invalid/",
      languages: ["en-US"],
      country: "US",
      tags: ["jazz", "😀"],
      streams: [{
        url: "https://stream.example.invalid/live",
        transport: "https",
        container: "audio/mpeg",
        codec: "mp3",
        bitrate_kbps: 128,
      }],
    },
  },
  proof: {
    alg: "Ed25519",
    key_id: "root",
    signature: "1UY3xXJprKS4toix-RapD8D0_i96TUvbp1Lszi91zCwanPCLgShPVz8ZBlABj35JGgrTSDxnIx8NuMwW-4YnBA",
  },
};

const validNodeEnvelope = {
  payload: {
    protocol: "oradio/1",
    kind: "node",
    node_id: nodeId,
    root_key: rootKey,
    operator_url: "https://registry.example/operator",
    api_bases: ["https://registry.example/v1/"],
    supported_majors: [1],
    capabilities: ["records", "snapshot", "health-observations"],
    issued_at: "2026-09-26T12:00:00Z",
    expires_at: "2026-09-27T12:00:00Z",
  },
  proof: {
    alg: "Ed25519",
    key_id: "root",
    signature: "mE2AIPt4sFAgwsFPv79nP_YM53YRT_oQRR6b5kjRR_avI1BzvsW2qLtdGWVFwjzywBMPoboJ95Hgv6VQoF_7Dw",
  },
};

const validObservationEnvelope = {
  payload: {
    protocol: "oradio/1",
    kind: "observation",
    observer: { node_id: nodeId, root_key: rootKey },
    station_id: stationId,
    endpoint: { endpoint_index: 0 },
    observed_at: "2026-09-26T12:15:00Z",
    expires_at: "2026-09-26T12:30:00Z",
    outcome: "ok",
    latency_ms: 84,
    http_status: 200,
    final_url: "https://stream.example.invalid/live",
    content_type: "audio/mpeg",
    codec: "mp3",
    bitrate_kbps: 128,
  },
  proof: {
    alg: "Ed25519",
    key_id: "root",
    signature: "RVAOO2YgsAByYjHr75MwzYmaN5J75FIUPI3ZpDlvVp7AYDIvW2nvTOPcTUYJhENIV2kLEzvNriGg5S6qordyCw",
  },
};

test("RFC 8785 canonicalization sorts UTF-16 property names and uses ECMAScript numbers", () => {
  const value = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    1: "One",
    "😀": "Emoji: Grinning Face",
    "\u0080": "Control",
    ö: "Latin Small Letter O With Diaeresis",
  };

  assert.equal(
    canonicalize(value),
    "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
  );
  assert.equal(canonicalize({ numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27] }),
               "{\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27]}");
});

test("bounded I-JSON parsing rejects duplicate members and unsafe integers", () => {
  assert.deepEqual(parseJsonStrict('{"ok":true,"items":[1,2]}'), { ok: true, items: [1, 2] });
  const prototypeMember = parseJsonStrict('{"__proto__":{"polluted":true}}');
  assert.equal(Object.hasOwn(prototypeMember, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(prototypeMember), Object.prototype);
  assert.throws(() => parseJsonStrict('{"name":"first","name":"second"}'), /duplicate member name/);
  assert.throws(() => parseJsonStrict('{"sequence":9007199254740992}'), /safe integer/);
  assert.throws(() => parseJsonStrict('{"sequence":-1}'), /non-negative integer/);
  assert.throws(() => parseJsonStrict('{"bad":"\\ud800"}'), /Unicode scalar/);
  assert.throws(() => parseJsonStrict('{"bad":"\\u0000"}'), /C0 or C1 control/u);
});

test("station envelope verifies its identity, record ID, and Ed25519 proof", () => {
  const result = validateEnvelope(validStationEnvelope);
  assert.equal(result.kind, "station");
  assert.equal(result.recordId, "sha256:rE_Scy6U_N_OgySNH1GfMZUrG55X50TlXHHEj4DX148");
  assert.equal(
    result.canonicalPayload,
    '{"issued_at":"2026-09-26T12:00:00Z","kind":"station","parents":[],"protocol":"oradio/1","root_key":{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"},"sequence":0,"station":{"country":"US","homepage":"https://example.invalid/","languages":["en-US"],"name":"Example É FM","short_name":"EXFM","streams":[{"bitrate_kbps":128,"codec":"mp3","container":"audio/mpeg","transport":"https","url":"https://stream.example.invalid/live"}],"tags":["jazz","😀"]},"station_id":"oradio:station:ed25519:If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk"}',
  );
});

test("station semantics reject malformed genesis, unsafe URLs, and proof mutations", () => {
  const parentedGenesis = structuredClone(validStationEnvelope);
  parentedGenesis.payload.parents.push("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.throws(() => validateEnvelope(parentedGenesis), /genesis.*parents/u);

  const unsafeUrl = structuredClone(validStationEnvelope);
  unsafeUrl.payload.station.streams[0].url = "https://user:secret@stream.example.invalid/live";
  assert.throws(() => validateEnvelope(unsafeUrl), /userinfo/u);

  const falseTombstone = structuredClone(validStationEnvelope);
  falseTombstone.payload.station.deleted = false;
  assert.throws(() => validateEnvelope(falseTombstone), /deleted is reserved/u);

  const mutatedProof = structuredClone(validStationEnvelope);
  mutatedProof.proof.signature = `A${mutatedProof.proof.signature.slice(1)}`;
  assert.throws(() => validateEnvelope(mutatedProof), /invalid Ed25519 signature/u);
});

test("station tags are pinned to the desktop client's 64-byte bound", () => {
  // One byte past the bound is rejected by the semantic verifier even though the JSON Schema's
  // code-point maxLength would admit it: the desktop client measures UTF-8 bytes.
  const oversizedTag = structuredClone(validStationEnvelope);
  oversizedTag.payload.station.tags = [`${"x".repeat(61)}😀`];
  assert.equal(Buffer.byteLength(oversizedTag.payload.station.tags[0], "utf8"), STATION_TAG_MAX_BYTES + 1);
  assert.equal([...oversizedTag.payload.station.tags[0]].length <= 64, true);
  assert.throws(() => validateEnvelope(oversizedTag), /station\.tags\[0\] must be a non-empty bounded string/u);

  // A tag of exactly the bound passes payload validation: the envelope only fails at the
  // signature (the clone is unsigned), which proves the bound is inclusive.
  const boundaryTag = structuredClone(validStationEnvelope);
  boundaryTag.payload.station.tags = [`${"x".repeat(60)}😀`];
  assert.equal(Buffer.byteLength(boundaryTag.payload.station.tags[0], "utf8"), STATION_TAG_MAX_BYTES);
  assert.throws(() => validateEnvelope(boundaryTag), /invalid Ed25519 signature/u);
});

test("node envelope verifies identity, HTTPS metadata, lifetime, and signature", () => {
  assert.equal(validateEnvelope(validNodeEnvelope).kind, "node");
  assert.throws(
    () => validateEnvelope(validNodeEnvelope, { validationTime: "2026-09-27T12:00:01Z" }),
    /expired/u,
  );
  const insecure = structuredClone(validNodeEnvelope);
  insecure.payload.api_bases[0] = "http://registry.example/v1/";
  assert.throws(() => validateEnvelope(insecure), /HTTPS/u);
  const reversedLifetime = structuredClone(validNodeEnvelope);
  reversedLifetime.payload.expires_at = reversedLifetime.payload.issued_at;
  assert.throws(() => validateEnvelope(reversedLifetime), /expires_at.*later/u);
  const duplicateMajor = structuredClone(validNodeEnvelope);
  duplicateMajor.payload.supported_majors.push(1);
  assert.throws(() => validateEnvelope(duplicateMajor), /supported_majors.*duplicates/u);
});

test("observation envelope verifies observer identity, endpoint scope, and one-hour expiry", () => {
  assert.equal(validateEnvelope(validObservationEnvelope).kind, "observation");
  assert.equal(validateEnvelope(validObservationEnvelope, { validationTime: "2026-09-26T12:10:00Z" }).kind, "observation");
  assert.throws(
    () => validateEnvelope(validObservationEnvelope, { validationTime: "2026-09-26T12:09:59Z" }),
    /future clock skew/u,
  );
  assert.throws(
    () => validateEnvelope(validObservationEnvelope, { validationTime: "2026-09-26T12:30:01Z" }),
    /expired/u,
  );
  const ambiguousEndpoint = structuredClone(validObservationEnvelope);
  ambiguousEndpoint.payload.endpoint.stream_url_digest = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.throws(() => validateEnvelope(ambiguousEndpoint), /exactly one/u);
  const longLifetime = structuredClone(validObservationEnvelope);
  longLifetime.payload.expires_at = "2026-09-26T13:15:01Z";
  assert.throws(() => validateEnvelope(longLifetime), /one hour/u);
  const negativeLatency = structuredClone(validObservationEnvelope);
  negativeLatency.payload.latency_ms = -1;
  assert.throws(() => validateEnvelope(negativeLatency), /latency_ms.*range/u);
});

test("unsupported critical extensions verify but cannot be materialized", () => {
  const envelope = parseJsonStrict(readFileSync(join(protocolRoot, "fixtures", "valid", "critical-extension.json")));
  const result = validateEnvelope(envelope);
  assert.equal(result.kind, "station");
  assert.equal(result.materializable, false);
  assert.deepEqual(result.unsupportedCritical, ["future_feature"]);
});

test("versioned schemas describe station, node, and observation envelopes", () => {
  const names = ["station-envelope", "node-envelope", "observation-envelope"];
  for (const name of names) {
    const schema = parseJsonStrict(readFileSync(join(protocolRoot, "schemas", `${name}.schema.json`)));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, `https://barebuh.example/protocol/v1/schemas/${name}.schema.json`);
    assert.deepEqual(schema.required, ["payload", "proof"]);
    assert.equal(schema.properties.payload.$ref, `common.schema.json#/$defs/${name.replace("-envelope", "Payload")}`);
    assert.equal(schema.properties.proof.$ref, "common.schema.json#/$defs/proof");
  }
  const common = parseJsonStrict(readFileSync(join(protocolRoot, "schemas", "common.schema.json")));
  for (const definition of ["proof", "rootKey", "stationPayload", "nodePayload", "observationPayload"]) {
    assert.ok(common.$defs[definition], `missing schema definition ${definition}`);
  }
});

test("machine-readable limits match the bounded parser profile", () => {
  const limits = parseJsonStrict(readFileSync(join(protocolRoot, "limits.json")));
  assert.equal(limits.protocol, "oradio/1");
  assert.deepEqual(limits.bounded_json, BOUNDED_JSON_LIMITS);
  assert.equal(limits.observation.max_lifetime_seconds, 3600);
  assert.equal(limits.station.max_streams, 16);
  assert.equal(limits.station.max_tags, STATION_TAG_MAX_ITEMS);
  assert.equal(limits.station.max_tag_bytes, STATION_TAG_MAX_BYTES);
  assert.equal(limits.station.max_tag_bytes, 64);
});

test("offline runner accepts golden vectors and rejects malformed vectors", () => {
  const manifest = parseJsonStrict(readFileSync(join(protocolRoot, "fixtures", "manifest.json")));
  assert.equal(manifest.protocol, "oradio/1");
  assert.equal(manifest.validation_time, "2026-09-26T12:20:00Z");
  assert.ok(manifest.fixtures.filter(fixture => fixture.valid).length >= 3);
  assert.ok(manifest.fixtures.filter(fixture => !fixture.valid).length >= 6);

  const result = spawnSync(process.execPath, [join(protocolRoot, "conformance-runner.mjs")], {
    cwd: protocolRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /13 fixtures passed/u);
});

test("shared interoperability state machines execute every normative feasible case", () => {
  const cases = parseJsonStrict(readFileSync(join(protocolRoot, "fixtures", "interoperability-cases.json")));
  const definitions = new Map(cases.dag.records.map(record => [record.id, record]));
  const state = { records: new Map(), orphans: new Map() };
  const receive = id => {
    if (state.records.has(id) || state.orphans.has(id)) return;
    const record = definitions.get(id);
    if (record.parents.some(parent => !state.records.has(parent))) state.orphans.set(id, record);
    else state.records.set(id, record);
    let promoted = true;
    while (promoted) {
      promoted = false;
      for (const [orphanId, orphan] of state.orphans) {
        if (orphan.parents.every(parent => state.records.has(parent))) {
          state.orphans.delete(orphanId);
          state.records.set(orphanId, orphan);
          promoted = true;
        }
      }
    }
  };
  const tips = records => {
    const parents = new Set([...records.values()].flatMap(record => record.parents));
    return [...records.values()].filter(record => !parents.has(record.id)).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  };
  const winner = records => tips(records).sort((left, right) => right.sequence - left.sequence || (left.id < right.id ? -1 : 1))[0];

  receive(cases.dag.arrival_order[0]);
  assert.deepEqual([...state.orphans.keys()].sort(), cases.dag.expected.orphan_after_first);
  for (const id of cases.dag.arrival_order.slice(1, 3)) receive(id);
  assert.deepEqual(tips(state.records).map(record => record.id), cases.dag.expected.fork_tips);
  assert.equal(winner(state.records).id, cases.dag.expected.fork_winner);
  receive("M");
  assert.equal(winner(state.records).id, cases.dag.expected.merge_winner);
  for (const id of cases.dag.arrival_order.slice(4)) receive(id);
  assert.deepEqual(tips(state.records).map(record => record.id), cases.dag.expected.final_tips);
  assert.equal(winner(state.records).id, cases.dag.expected.final_winner);
  assert.equal(winner(state.records).deleted, true);
  assert.deepEqual([...state.records.keys()].sort(), cases.dag.expected.stored);

  const replay = cases.replication.crash_replay;
  const committed = { cursor: replay.initial_cursor, records: new Set() };
  const applyPage = (target, crashAfter) => {
    const transaction = { cursor: target.cursor, records: new Set(target.records) };
    replay.page.items.forEach((item, index) => {
      transaction.records.add(item);
      if (index === crashAfter) throw new Error("injected crash");
    });
    transaction.cursor = replay.page.next_cursor;
    return transaction;
  };
  assert.throws(() => applyPage(committed, replay.crash_after_item), /injected crash/u);
  assert.equal(committed.cursor, replay.expected_cursor_after_crash);
  assert.deepEqual([...committed.records], replay.expected_records_after_crash);
  const replayed = applyPage(committed, -1);
  assert.equal(replayed.cursor, replay.expected_cursor_after_replay);
  assert.deepEqual([...replayed.records].sort(), replay.expected_records_after_replay);

  const logs = { A: new Set(), B: new Set(), C: new Set() };
  for (const delivery of cases.replication.loop_deliveries) for (const id of delivery.items) logs[delivery.to].add(id);
  for (const [node, expected] of Object.entries(cases.replication.expected_loop_logs)) assert.deepEqual([...logs[node]].sort(), expected);

  const recovery = cases.replication.snapshot_recovery;
  const snapshot = new Set();
  const snapshotId = recovery.snapshot_pages[0].snapshot;
  let checkpoint = null;
  for (const page of recovery.snapshot_pages) {
    assert.equal(page.snapshot, snapshotId);
    for (const id of page.items) snapshot.add(id);
    if (!page.has_more) checkpoint = page.checkpoint;
  }
  const recovered = new Set([...recovery.local_records, ...snapshot]);
  assert.deepEqual([...recovered].sort(), recovery.expected_records);
  assert.equal(checkpoint, recovery.expected_cursor);
  assert.equal(winner(new Map([...recovered].map(id => [id, definitions.get(id)]))).id, recovery.expected_winner);

  const ordered = [...cases.search.candidates].sort((left, right) => right.score - left.score || Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)) || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  assert.deepEqual(ordered.map(item => item.id), cases.search.expected_order);
  for (const request of cases.search.requests) {
    const binding = cases.search.cursor_store[request.cursor];
    let error = null;
    let ids = null;
    if (!binding) error = "cursor_invalid";
    else if (binding.feed !== request.feed || canonicalize(binding.filter) !== canonicalize(request.filter)) error = "cursor_binding_mismatch";
    else ids = ordered.slice(binding.offset, binding.offset + 2).map(item => item.id);
    if (request.expected_error) assert.equal(error, request.expected_error);
    else assert.deepEqual(ids, request.expected_ids);
  }

  const cache = structuredClone(cases.http_cache.initial);
  for (const event of cases.http_cache.events) {
    const matchingValidator = event.url === cache.url && event.request_etag === cache.etag;
    let outcome;
    if (event.status === 304) outcome = matchingValidator ? "not_modified" : "failure";
    else {
      cache.url = event.url;
      cache.etag = event.response_etag;
      cache.rows = [...event.rows];
      outcome = "replaced";
    }
    assert.equal(outcome, event.expected);
  }
  assert.deepEqual(cache, cases.http_cache.expected_final);

  for (const observation of cases.endpoint_scope.observations) {
    const endpoint = observation.endpoint;
    const fields = ["endpoint_index", "stream_url_digest"].filter(field => Object.hasOwn(endpoint, field));
    const digests = cases.endpoint_scope.stream_urls.map(url => `sha256:${createHash("sha256").update(url).digest("base64url")}`);
    const accepted = fields.length === 1 && (fields[0] === "endpoint_index" ? endpoint.endpoint_index >= 0 && endpoint.endpoint_index < cases.endpoint_scope.stream_urls.length : digests.includes(endpoint.stream_url_digest));
    assert.equal(accepted ? "accepted" : "quarantined", observation.expected);
  }

  for (const extension of cases.extensions.cases) {
    const critical = extension.payload.critical ?? [];
    const missing = critical.find(member => !Object.hasOwn(extension.payload, member));
    if (extension.expected_error) {
      assert.ok(missing);
      assert.equal(extension.expected_error, "critical_member_missing");
      continue;
    }
    assert.equal(critical.length === 0, extension.expected_materializable);
    assert.deepEqual(extension.payload.future, extension.expected_preserved);
  }

  const offline = structuredClone(cases.offline_cache.initial);
  for (const row of offline.rows) for (const field of cases.offline_cache.required_fields) assert.ok(Object.hasOwn(row, field), `missing cache field ${field}`);
  const actual = {
    mode: "offline_stale",
    data_age: cases.offline_cache.now_epoch - offline.refreshed_at,
    row_ids: offline.rows.map(row => row.station_id).sort(),
    health: Object.fromEntries(offline.rows.map(row => [row.station_id, row.health_expires_at > 0 && row.health_expires_at <= cases.offline_cache.now_epoch ? "unknown" : row.health])),
    tombstones: offline.rows.filter(row => row.tombstone).map(row => row.station_id),
  };
  assert.deepEqual(actual, cases.offline_cache.expected);
});
