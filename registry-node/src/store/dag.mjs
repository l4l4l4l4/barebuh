// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Deterministic station-record DAG semantics for the private registry node.
//
// Everything in this module is a pure function of a station's stored record set. Materialization
// must not depend on receipt time, insertion order, or `issued_at` (docs/protocol-mvp.md,
// "Conflict resolution"), so the durable ingest classification and the materializer both call
// into this module instead of re-implementing the rules.
//
// Working definitions:
//
//   * a record is *valid* when every parent is stored, is a station record of the same station
//     identity, is itself valid, is not quarantined by local policy, and the sequence rule
//     holds: `sequence == 1 + max(parent.sequence)` for every non-genesis record. A single-parent
//     update and a merge use the same arithmetic; a merge additionally needs two or more parents;
//   * a *tip* is a valid record with no valid child;
//   * the *winner* is the tip with the greatest sequence and, on a tie, the lexicographically
//     smallest record ID (`sha256:...` strings compare byte-for-byte, so SQLite's BINARY
//     collation and JavaScript agree).
//
// The protocol text describes a merge as naming "two or more tips". Tip-ness is intentionally
// not re-checked: it is not a static property of an immutable DAG, because a record that is a
// tip when a merge arrives can stop being one later. Enforcing parent validity and the sequence
// rule keeps the winner a pure function of the final record set, which is what order-independent
// convergence requires. Records that break the rules stay stored (and relayable) but are
// excluded from tips.

export const RECORD_POLICY_STATES = Object.freeze(["quarantined", "admitted", "suppressed"]);

// Materialization states mirror the schema-2 CHECK constraint and docs/registry-node-security-contract.md
// (MOD-01): absence, local suppression, verified tombstone, unsupported critical semantics, and
// unfinished input stay distinct.
export const MATERIALIZATION_STATES = Object.freeze(["active", "tombstoned", "suppressed", "unsupported_critical", "orphan_only", "quarantined"]);

// Closed reason-code set. It is persisted in `record_policy` and reused for observations and
// quarantine evidence, so operators, tests, and later telemetry can rely on stable codes.
export const RECORD_REASONS = Object.freeze({
  valid: "valid",
  localIngest: "local_ingest",
  heldForAdmission: "held_for_admission",
  adminAdmitted: "admin_admitted",
  adminSuppressed: "admin_suppressed",
  policyHold: "record_quarantined",
  parentMissing: "parent_missing",
  parentStationMismatch: "parent_station_mismatch",
  parentInvalid: "parent_invalid",
  sequenceViolation: "sequence_rule_violation",
});

export function compareRecordIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Direct DAG issues of a single record. "parent_missing" means the record is an orphan: it stays
// stored and is re-evaluated when the parent arrives. A parent that is stored but quarantined, or
// that belongs to another station identity, permanently blocks the child.
export function stationRecordIssues(record, byId) {
  const issues = [];
  if (record.policy === "quarantined") issues.push(RECORD_REASONS.policyHold);
  if (record.parents.length === 0) {
    if (record.sequence !== 0) issues.push(RECORD_REASONS.sequenceViolation);
    return issues;
  }
  const parents = [];
  for (const parentId of record.parents) {
    const parent = byId.get(parentId);
    if (!parent) {
      issues.push(RECORD_REASONS.parentMissing);
      continue;
    }
    if (parent.kind !== "station" || parent.subjectId !== record.subjectId) {
      issues.push(RECORD_REASONS.parentStationMismatch);
      continue;
    }
    if (parent.policy === "quarantined") issues.push(RECORD_REASONS.parentInvalid);
    parents.push(parent);
  }
  if (parents.length !== record.parents.length) return issues;
  const maximum = Math.max(...parents.map(parent => parent.sequence));
  if (record.sequence !== maximum + 1) issues.push(RECORD_REASONS.sequenceViolation);
  return issues;
}

// Validity is computed in one ascending pass. Every rule-conforming parent has a strictly lower
// sequence than its child, so a parent's validity is always known before it is needed; records
// that break the sequence rule are excluded regardless of pass order.
export function classifyStationRecords(records) {
  const byId = new Map(records.map(record => [record.recordId, record]));
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence || compareRecordIds(left.recordId, right.recordId));
  const issues = new Map();
  const valid = new Map();
  for (const record of ordered) {
    const found = stationRecordIssues(record, byId);
    issues.set(record.recordId, found);
    valid.set(record.recordId, found.length === 0 && record.parents.every(parentId => valid.get(parentId) === true));
  }
  return { byId, valid, issues };
}

function winnerOf(candidates) {
  return [...candidates].sort((left, right) => right.sequence - left.sequence || compareRecordIds(left.recordId, right.recordId))[0] ?? null;
}

function materializationState({ records, valid, issues, tips, protocolWinner, visibleWinner }) {
  // Precedence is fixed so it is reproducible: a materialized visible winner, a suppressed
  // protocol winner, uninterpretable tips, local suppression, missing parents, then every other
  // blocked reason.
  if (visibleWinner) return visibleWinner.isTombstone ? "tombstoned" : "active";
  if (protocolWinner) return "suppressed";
  if (tips.some(record => !record.materializable)) return "unsupported_critical";
  if (records.some(record => record.policy === "suppressed")) return "suppressed";
  const blocked = records.filter(record => !valid.get(record.recordId));
  if (blocked.some(record => issues.get(record.recordId).includes(RECORD_REASONS.parentMissing))) return "orphan_only";
  if (blocked.length > 0) return "quarantined";
  return null;
}

// Computes the complete materialized view of one station from its stored records:
// tips (protocol-valid, unsupported-critical and suppressed records included so forks stay
// visible), the protocol winner (materializable tips), the locally visible winner (admitted
// materializable tips), and the state that explains what is materialized.
export function computeStationMaterialization(records) {
  if (records.length === 0) return { tips: [], forked: false, protocolWinner: null, visibleWinner: null, state: null };
  const { valid, issues } = classifyStationRecords(records);
  const eligible = records.filter(record => valid.get(record.recordId));
  const hasChild = new Set(eligible.flatMap(record => record.parents));
  const tips = eligible.filter(record => !hasChild.has(record.recordId)).sort((left, right) => compareRecordIds(left.recordId, right.recordId));
  const interpretable = tips.filter(record => record.materializable);
  const protocolWinner = winnerOf(interpretable);
  const visibleWinner = winnerOf(interpretable.filter(record => record.policy === "admitted"));
  return {
    tips: tips.map(record => record.recordId),
    forked: tips.length > 1,
    protocolWinner: protocolWinner?.recordId ?? null,
    visibleWinner: visibleWinner?.recordId ?? null,
    state: materializationState({ records, valid, issues, tips, protocolWinner, visibleWinner }),
  };
}
