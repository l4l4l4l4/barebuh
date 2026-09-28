// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Bounded signed-envelope ingest for the private registry node.
//
// Ingest is a local, administrator-only operation: the CLI is the only caller, and the HTTP
// listener keeps exposing no mutation route (AUTH-01 in docs/registry-node-security-contract.md).
// Every input is treated as hostile:
//
//   1. the raw document is bounded before parsing and then parsed with the protocol verifier
//      (protocol/v1/lib/conformance.mjs). Parsing, canonicalization, identity derivation, and
//      signature rules are never duplicated here (docs/adr/0002-private-registry-node.md);
//   2. verification failures become bounded quarantine evidence, never records;
//   3. an accepted envelope becomes exactly one immutable `records` row keyed by its recomputed
//      record ID. Canonical payload bytes, relay bytes, the proof, and prior provenance are never
//      rewritten afterwards; a repeated record ID only bumps provenance (idempotent duplicate);
//   4. station records also carry a durable local policy row. Sequence and parent rules are
//      re-evaluated for the whole station whenever a record arrives, including for orphans that
//      were waiting for their parents. Only permanent failures (sequence rule, parent owned by
//      another station identity, invalid parent) enter durable quarantine; a missing parent is
//      not a property of the record, so the record stays admitted and is held out of the
//      materialized view until the parent arrives. The affected station is always queued for
//      deterministic materialization;
//   5. observations are scoped to the station's materialized snapshot: an observation for an
//      unknown, unresolved, or tombstoned station, or for an endpoint the station does not list,
//      is stored but held under quarantine policy state.
//
// Nothing in this module performs network I/O.

import { createHash } from "node:crypto";

import { parseJsonStrict, validateEnvelope } from "../../../protocol/v1/lib/conformance.mjs";
import { classifyStationRecords, RECORD_REASONS, RECORD_POLICY_STATES, stationRecordIssues } from "./dag.mjs";
import { withTransaction } from "./db.mjs";

export const INGEST_LIMITS = Object.freeze({
  maxDocumentBytes: 65_536,
  maxQuarantineBytes: 65_536,
  quarantineRetentionSeconds: 30 * 24 * 60 * 60,
});

export const QUARANTINE_STAGES = Object.freeze(["bounds", "parse", "validation"]);

export const INGEST_STATUS = Object.freeze({ stored: "stored", duplicate: "duplicate", quarantined: "quarantined" });

// Reasons are closed codes; they are the only observation policy the store applies in this
// milestone. Health aggregation and remote observation trust belong to later work.
export const OBSERVATION_REASONS = Object.freeze({
  stationUnknown: "observation_station_unknown",
  stationUnresolved: "observation_station_unresolved",
  stationTombstoned: "observation_station_tombstoned",
  endpointOutOfScope: "observation_endpoint_out_of_scope",
});

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedMessage(error) {
  const message = typeof error?.message === "string" ? error.message : String(error);
  return message.slice(0, 512);
}

function subjectIdOf(payload, kind) {
  return kind === "node" ? payload.node_id : payload.station_id;
}

function sequenceOf(payload, kind) {
  return kind === "station" ? payload.sequence : null;
}

// `issued_at` column: the signed timestamp of the record. Observations have no `issued_at`, so
// their signed `observed_at` is stored instead.
function issuedAtOf(payload, kind) {
  return kind === "observation" ? payload.observed_at : payload.issued_at;
}

function isTombstoneOf(payload, kind) {
  return kind === "station" && payload.station.deleted === true;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    recordId: row.record_id,
    kind: row.kind,
    subjectId: row.subject_id,
    sequence: row.station_sequence,
    isTombstone: row.is_tombstone === 1,
    materializable: row.materializable === 1,
    policy: row.policy_state ?? "quarantined",
  };
}

export function readRecord(db, recordId) {
  return rowToRecord(db.prepare(`
    SELECT r.record_id, r.kind, r.subject_id, r.station_sequence, r.is_tombstone, r.materializable,
           p.state AS policy_state
      FROM records r LEFT JOIN record_policy p ON p.record_id = r.record_id
     WHERE r.record_id = ?`).get(recordId));
}

export function readRecordPayload(db, recordId) {
  const row = db.prepare("SELECT canonical_payload FROM records WHERE record_id = ?").get(recordId);
  if (!row) return null;
  return parseJsonStrict(Buffer.from(row.canonical_payload));
}

// Records of one station with their parents, ordered by (sequence, record ID) so every consumer
// sees the same deterministic view. Deliberately excludes `canonical_payload`: payload bytes are
// loaded per record only when the materializer actually needs the winner's snapshot.
export function loadStationRecordViews(db, stationId) {
  const rows = db.prepare(`
    SELECT r.record_id, r.kind, r.subject_id, r.station_sequence, r.is_tombstone, r.materializable,
           p.state AS policy_state
      FROM records r LEFT JOIN record_policy p ON p.record_id = r.record_id
     WHERE r.kind = 'station' AND r.subject_id = ?
     ORDER BY r.station_sequence, r.record_id`).all(stationId);
  const parents = new Map(rows.map(row => [row.record_id, []]));
  if (rows.length > 0) {
    // Joining back to `records` (instead of an IN list) keeps this query independent of the
    // number of records in a station history.
    const parentRows = db.prepare(`
      SELECT p.child_record_id, p.parent_record_id
        FROM record_parents p
        JOIN records r ON r.record_id = p.child_record_id
       WHERE r.kind = 'station' AND r.subject_id = ?
       ORDER BY p.child_record_id, p.ordinal`).all(stationId);
    for (const parent of parentRows) parents.get(parent.child_record_id).push(parent.parent_record_id);
  }
  return rows.map(row => ({ ...rowToRecord(row), parents: parents.get(row.record_id) }));
}

export function recordProvenance(db, recordId, { sourceKind, sourceId, now }) {
  db.prepare(`
    INSERT INTO record_sources(record_id, source_kind, source_id, first_seen_at, last_seen_at, receipt_count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(record_id, source_kind, source_id)
    DO UPDATE SET last_seen_at = excluded.last_seen_at, receipt_count = receipt_count + 1`)
    .run(recordId, sourceKind, sourceId, now, now);
}

// The durable work queue is keyed by station: a station is either pending or it is not. The first
// enqueue keeps its position so a burst cannot starve older work.
export function enqueueStation(db, stationId, now) {
  db.prepare("INSERT INTO materialize_queue(station_id, enqueued_at) VALUES (?, ?) ON CONFLICT(station_id) DO NOTHING")
    .run(stationId, now);
}

function setPolicyRow(db, recordId, state, reasonCode, now) {
  db.prepare("UPDATE record_policy SET state = ?, reason_code = ?, updated_at = ? WHERE record_id = ?")
    .run(state, reasonCode, now, recordId);
}

// Only permanent rule failures move a record into durable quarantine. A missing parent is not a
// property of the record: the record stays admitted (and out of the materialized view through the
// derived classification) until the parent arrives, and the rules are then re-evaluated.
const PERMANENT_POLICY_ISSUES = Object.freeze([RECORD_REASONS.sequenceViolation, RECORD_REASONS.parentStationMismatch, RECORD_REASONS.parentInvalid]);

// A parent that is stored under another subject (or is not a station record at all) can never
// become valid, but the station-local view alone cannot tell it apart from a parent that has not
// arrived yet. Both the durable classification and the materializer therefore consult the global
// record store for this check.
export function foreignParentRecordIds(db, records) {
  const known = new Set(records.map(record => record.recordId));
  const foreign = new Set();
  for (const record of records) {
    for (const parentId of record.parents) {
      if (!known.has(parentId) && readRecord(db, parentId) !== null) foreign.add(parentId);
    }
  }
  return foreign;
}

function childStationIds(db, recordId) {
  return db.prepare(`
    SELECT DISTINCT r.subject_id AS station_id
      FROM record_parents p
      JOIN records r ON r.record_id = p.child_record_id
     WHERE p.parent_record_id = ? AND r.kind = 'station'`).all(recordId).map(row => row.station_id);
}

// Sequence and parent rules are re-evaluated for every admitted record of the station until the
// classification reaches a fixpoint: quarantining a rule-breaking record can invalidate a child
// that references it, which can invalidate the next child, and so on. Each pass quarantines at
// least one record or the loop stops, so the bound is the number of records.
function reclassifyStationRecordPolicies(db, stationId, now) {
  const maximumPasses = db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind = 'station' AND subject_id = ?").get(stationId).count + 1;
  for (let pass = 0; pass < maximumPasses; ++pass) {
    const records = loadStationRecordViews(db, stationId);
    const { issues } = classifyStationRecords(records);
    const foreign = foreignParentRecordIds(db, records);
    const failures = [];
    for (const record of records) {
      if (record.policy !== "admitted") continue;
      const permanent = issues.get(record.recordId).filter(issue => PERMANENT_POLICY_ISSUES.includes(issue));
      if (record.parents.some(parentId => foreign.has(parentId))) permanent.unshift(RECORD_REASONS.parentStationMismatch);
      if (permanent.length > 0) failures.push({ record, reason: permanent[0] });
    }
    if (failures.length === 0) return;
    for (const { record, reason } of failures) setPolicyRow(db, record.recordId, "quarantined", reason, now);
  }
}

// An observation must reference an endpoint of the station's currently materialized snapshot.
// Scope is checked against the projection, not against a raw historical record, so a station that
// is tombstoned, suppressed, or unresolved cannot receive an endpoint-scoped observation.
export function applyObservationScope(db, recordId, payload, now) {
  const stationExists = Boolean(db.prepare("SELECT 1 FROM records WHERE kind = 'station' AND subject_id = ?").get(payload.station_id));
  const station = db.prepare("SELECT state FROM station_state WHERE station_id = ?").get(payload.station_id);
  let reason = null;
  if (!stationExists) reason = OBSERVATION_REASONS.stationUnknown;
  else if (!station || station.state !== "active") {
    reason = station && station.state === "tombstoned" ? OBSERVATION_REASONS.stationTombstoned : OBSERVATION_REASONS.stationUnresolved;
  } else {
    const endpoints = db.prepare("SELECT ordinal, url_digest FROM station_streams WHERE station_id = ? ORDER BY ordinal").all(payload.station_id);
    const { endpoint } = payload;
    const listed = endpoint.endpoint_index !== undefined
      ? endpoints.some(row => row.ordinal === endpoint.endpoint_index)
      : endpoints.some(row => row.url_digest === endpoint.stream_url_digest);
    if (!listed) reason = OBSERVATION_REASONS.endpointOutOfScope;
  }
  if (reason) setPolicyRow(db, recordId, "quarantined", reason, now);
  return reason;
}

function insertRecord(db, { document, verified, bytes, sourceKind, sourceId, now, accept }) {
  const { payload } = document;
  db.prepare(`
    INSERT INTO records(record_id, protocol, kind, subject_id, station_sequence, issued_at, canonical_payload,
                        relay_envelope, proof_signature, materializable, is_tombstone, unsupported_critical_json, inserted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    verified.recordId,
    payload.protocol,
    verified.kind,
    subjectIdOf(payload, verified.kind),
    sequenceOf(payload, verified.kind),
    issuedAtOf(payload, verified.kind),
    Buffer.from(verified.canonicalPayload, "utf8"),
    bytes,
    Buffer.from(document.proof.signature, "base64url"),
    verified.materializable ? 1 : 0,
    isTombstoneOf(payload, verified.kind) ? 1 : 0,
    JSON.stringify(verified.unsupportedCritical),
    now,
  );
  for (const [ordinal, parentId] of (payload.parents ?? []).entries()) {
    db.prepare("INSERT INTO record_parents(child_record_id, ordinal, parent_record_id) VALUES (?, ?, ?)")
      .run(verified.recordId, ordinal, parentId);
  }
  db.prepare("INSERT INTO record_policy(record_id, state, reason_code, updated_at) VALUES (?, ?, ?, ?)")
    .run(verified.recordId, accept ? "admitted" : "quarantined", accept ? RECORD_REASONS.localIngest : RECORD_REASONS.heldForAdmission, now);
  recordProvenance(db, verified.recordId, { sourceKind, sourceId, now });

  if (verified.kind === "station") {
    // A new station record can complete a parent set for children in this station and, in the
    // pathological cross-station case, for station records of another subject; both are
    // re-evaluated and queued.
    const affected = new Set([payload.station_id, ...childStationIds(db, verified.recordId)]);
    for (const stationId of affected) reclassifyStationRecordPolicies(db, stationId, now);
    for (const stationId of affected) enqueueStation(db, stationId, now);
  } else if (verified.kind === "observation") {
    applyObservationScope(db, verified.recordId, payload, now);
  }
}

function quarantineDocument(db, bytes, { stage, reasonCode, message, sourceKind, sourceId, now }) {
  const expiresAt = new Date(Date.parse(now) + INGEST_LIMITS.quarantineRetentionSeconds * 1000).toISOString();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO quarantine(raw_sha256, source_kind, source_id, failure_stage, reason_code, bounded_raw_envelope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256Hex(bytes), sourceKind, sourceId, stage, reasonCode, bytes.subarray(0, INGEST_LIMITS.maxQuarantineBytes), now, expiresAt);
  });
  return { status: INGEST_STATUS.quarantined, stage, reasonCode, message, sourceKind, sourceId, documentBytes: bytes.length };
}

function ingestResult(status, verified, record) {
  return {
    status,
    recordId: verified.recordId,
    kind: verified.kind,
    subjectId: record.subjectId,
    stationId: verified.kind === "node" ? null : record.subjectId,
    policyState: record.policy,
    materializable: verified.materializable,
    unsupportedCritical: verified.unsupportedCritical,
  };
}

// ingests one bounded signed envelope. `accept` is the local admission decision: the administrator
// CLI admits by default, while a future replicator ingests with `accept: false` and holds records
// for explicit admission. `validationTime` is the caller's clock for node-card and observation
// freshness; station records never expire.
export function ingestDocument(db, input, options = {}) {
  const {
    sourceKind = "local",
    sourceId = "admin",
    accept = true,
    now = new Date().toISOString(),
    validationTime = now,
  } = options;
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");

  if (bytes.length > INGEST_LIMITS.maxDocumentBytes) {
    return quarantineDocument(db, bytes, { stage: "bounds", reasonCode: "document_too_large", message: `document exceeds ${INGEST_LIMITS.maxDocumentBytes} bytes`, sourceKind, sourceId, now });
  }

  let document;
  try {
    document = parseJsonStrict(bytes);
  } catch (error) {
    return quarantineDocument(db, bytes, { stage: "parse", reasonCode: "parse_error", message: boundedMessage(error), sourceKind, sourceId, now });
  }

  let verified;
  try {
    verified = validateEnvelope(document, { validationTime });
  } catch (error) {
    return quarantineDocument(db, bytes, { stage: "validation", reasonCode: "validation_error", message: boundedMessage(error), sourceKind, sourceId, now });
  }

  const existing = readRecord(db, verified.recordId);
  if (existing) {
    withTransaction(db, () => recordProvenance(db, verified.recordId, { sourceKind, sourceId, now }));
    return ingestResult(INGEST_STATUS.duplicate, verified, existing);
  }

  const record = withTransaction(db, () => {
    insertRecord(db, { document, verified, bytes, sourceKind, sourceId, now, accept });
    return readRecord(db, verified.recordId);
  });
  return ingestResult(INGEST_STATUS.stored, verified, record);
}

// Local administrator policy change. Admission re-runs the rule classification and the
// observation scope check, and re-queues the station so the projection reflects the decision.
export function setRecordPolicy(db, recordId, state, options = {}) {
  const { reasonCode = null, now = new Date().toISOString() } = options;
  if (!RECORD_POLICY_STATES.includes(state)) throw new TypeError(`unsupported policy state: ${state}`);
  const record = readRecord(db, recordId);
  if (!record) throw new Error(`unknown record: ${recordId}`);
  const defaultReasons = { admitted: RECORD_REASONS.adminAdmitted, suppressed: RECORD_REASONS.adminSuppressed, quarantined: RECORD_REASONS.policyHold };
  return withTransaction(db, () => {
    setPolicyRow(db, recordId, state, reasonCode ?? defaultReasons[state], now);
    if (record.kind === "station") {
      if (state === "admitted") reclassifyStationRecordPolicies(db, record.subjectId, now);
      enqueueStation(db, record.subjectId, now);
    } else if (record.kind === "observation" && state === "admitted") {
      const payload = readRecordPayload(db, recordId);
      applyObservationScope(db, recordId, payload, now);
    }
    return readRecord(db, recordId);
  });
}
