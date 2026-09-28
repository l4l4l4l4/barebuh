// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Bounded pull replicator for private pinned federation.
//
// This is the consumer half of the records feed (docs/protocol-mvp.md, "Replication algorithm"):
// for an explicitly pinned peer it loads the last committed cursor, fetches one bounded page at a
// time, verifies every item independently, stores what verifies, quarantines what does not,
// commits the page and its cursor together, and stops when the peer says `has_more=false` or a
// local budget is exhausted.
//
// Trust boundary:
//   * pull sources are explicit local pins only (./peers.mjs). Nothing here reads a peer list, a
//     node card's `api_bases`, or a discovery document to create, follow, or trust another peer:
//     peer-of-peer admission is forbidden, so a hostile peer can advertise a thousand nodes and
//     this node will still talk only to the pinned origin. Every request is built under the pinned
//     API base (`peerUrl`), redirects are an error, and a snapshot URL from a peer response is
//     never followed - recovery reuses the pinned base;
//   * a peer must prove the pinned identity before any record is pulled: its node card is fetched
//     from the pinned origin, verified as a signed `oradio/1` envelope, and must name the pinned
//     node ID and support API major 1. The card is verified in memory and never stored;
//   * every record is re-verified locally with the protocol verifier - published record IDs are
//     recomputed, never trusted (docs/protocol-mvp.md: "Nodes MUST recompute the record ID and
//     MUST NOT trust one supplied by a peer");
//   * an invalid item becomes bounded quarantine evidence and the page still commits: a malformed
//     sibling never hides its valid neighbours and is never silently skipped, because it was
//     processed as evidence rather than dropped;
//   * a corrupt page (unparsable, wrong shape, oversized, repeated cursor) fails the attempt: no
//     record, projection, or cursor changes, and the failure feeds the peer's backoff clock.
//
// Resource bounds (effective values are reported by `effective-config` and `peer-list`):
//   * one bounded page request at a time per peer, with a request timeout and a decoded-body cap;
//   * pages, items, and snapshot pages per run are capped, so a peer cannot hold the worker;
//   * peers are pulled sequentially - one worker, no cross-peer coupling - and a failed peer
//     cannot abort another peer's pull or the run;
//   * backoff (exponential, jittered, `Retry-After`-aware), a consecutive-failure count, and a
//     circuit breaker are persisted per peer, so a restart cannot retry-storm a dead peer.
//
// Nothing in this module writes outside the local store, and nothing enables public writes,
// station probing, or any other network egress.

import { parseJsonStrict, validateEnvelope } from "../../../protocol/v1/lib/conformance.mjs";
import { secondInstant } from "../store/cursor.mjs";
import { withTransaction } from "../store/db.mjs";
import { INGEST_LIMITS, INGEST_STATUS, ingestVerifiedDocument, quarantineDocument } from "../store/records.mjs";
import { listPeers, peerPullReady, readPeer, recordFeedPage, recordPeerAttempt, recordPeerFailure, recordSnapshotPage } from "./peers.mjs";

export const PULL_LIMITS = Object.freeze({
  // Station history is what this milestone replicates and materializes. Observation replication
  // belongs to the health-trust milestone: remote observations never rank locally by default
  // (docs/protocol-mvp.md, "Health observation"), and their endpoint scope is checked against the
  // local projection at ingest time.
  kinds: Object.freeze(["station"]),
  pageLimit: 100, // requested page size; the peer's own cap is 1000
  maxResponseBytes: 1_048_576, // decoded body cap per peer response
  requestTimeoutMs: 10_000,
  maxPagesPerRun: 16,
  maxItemsPerRun: 2_000,
  maxSnapshotPages: 32,
  maxCursorBytes: 4096,
  userAgent: "barebuh-registry-node/0.0.1",
});

// The protocol's bound profile is written for one record; a page carries bounded records plus its
// own envelope, so the page profile is the same rules scaled to one bounded page. Each item's
// envelope is then re-parsed under the strict record profile before verification, so a member that
// only survives because of the page budget is still rejected per item.
const PAGE_PROFILE = Object.freeze({
  max_document_bytes: PULL_LIMITS.maxResponseBytes,
  max_depth: 20,
  max_object_members: 64,
  max_array_items: 1000,
  max_string_bytes: 65_536,
});

export const SUPPORTED_MAJOR = 1;

const RECORD_ID_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;

// A pull failure with a stable machine-readable code. Codes are operator-facing: they appear in
// `peer-list`/`replicate` output and in the peer's `last_error`, never raw peer payloads.
export class PullError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PullError";
    this.code = code;
    this.details = details;
  }
}

function pullError(code, message, details = null) {
  return new PullError(code, message, details);
}

function boundedMessage(value) {
  return String(value?.message ?? value).slice(0, 200);
}

function outcome(nodeId, status, fields = {}) {
  return { nodeId, status, pages: 0, snapshot_pages: 0, items: 0, stored: 0, duplicates: 0, quarantined: 0, cursor_advanced: false, ...fields };
}

function blankSummary() {
  return { pages: 0, snapshot_pages: 0, items: 0, stored: 0, duplicates: 0, quarantined: 0 };
}

// ---------------------------------------------------------------------------------------------
// HTTP: every request is pinned to the peer's origin, bounded in time and bytes, and never follows
// a redirect.
// ---------------------------------------------------------------------------------------------

function peerUrl(peer, path, params = {}) {
  const base = new URL(peer.apiBase);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw pullError("peer_origin_mismatch", "peer URL escapes the pinned origin");
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  }
  return url;
}

async function readBoundedBody(response, maxBytes) {
  if (response.body === null || response.body === undefined) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The connection is already failing; the abort below closes it either way.
      }
      throw pullError("peer_response_too_large", `peer response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function requestPeer(fetchImpl, url, { timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("peer request timed out")), timeoutMs);
  try {
    const response = await fetchImpl(url.href, {
      headers: { accept: "application/json", "user-agent": PULL_LIMITS.userAgent },
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    const bytes = await readBoundedBody(response, maxBytes);
    return { status: response.status, headers: response.headers, bytes };
  } catch (error) {
    if (error instanceof PullError) throw error;
    if (controller.signal.aborted) throw pullError("peer_timeout", `no response within ${timeoutMs} ms`);
    throw pullError("peer_unreachable", boundedMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMsOf(headers, nowMs) {
  const value = headers?.get?.("retry-after");
  if (typeof value !== "string") return null;
  if (/^[0-9]{1,6}$/u.test(value)) return Number(value) * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

// ---------------------------------------------------------------------------------------------
// Identity: the pinned node ID is only binding if the endpoint proves it.
// ---------------------------------------------------------------------------------------------

async function verifyPeerCard(fetchImpl, peer, { now, limits }) {
  const url = peerUrl(peer, "node");
  const { status, bytes } = await requestPeer(fetchImpl, url, { maxBytes: INGEST_LIMITS.maxDocumentBytes, timeoutMs: limits.requestTimeoutMs });
  if (status !== 200) throw pullError("peer_card_unavailable", `the peer answered ${status} for its node card`);
  let document;
  let verified;
  try {
    document = parseJsonStrict(bytes);
    verified = validateEnvelope(document, { validationTime: secondInstant(now) });
  } catch (error) {
    throw pullError("peer_card_invalid", boundedMessage(error));
  }
  if (verified.kind !== "node") throw pullError("peer_identity_mismatch", "the peer card is not a node card");
  if (document.payload.node_id !== peer.nodeId) throw pullError("peer_identity_mismatch", "the peer card does not match the pinned node identity");
  if (!document.payload.supported_majors.includes(SUPPORTED_MAJOR)) throw pullError("peer_unsupported_major", "the peer does not support API major 1");
  return verified;
}

// ---------------------------------------------------------------------------------------------
// Page handling
// ---------------------------------------------------------------------------------------------

function cursorOf(value, field, limits) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > limits.maxCursorBytes) {
    throw pullError("peer_invalid_response", `${field} must be null or a bounded non-empty string`);
  }
  return value;
}

// The page envelope is structural state the peer controls, so it is parsed and bounds-checked
// before any item is touched. Everything about a bad page is a failed attempt: no commit happens.
function readPage(bytes, { limits }) {
  let page;
  try {
    page = parseJsonStrict(bytes, PAGE_PROFILE);
  } catch (error) {
    throw pullError("peer_invalid_response", `page: ${boundedMessage(error)}`);
  }
  if (page === null || typeof page !== "object" || Array.isArray(page)) throw pullError("peer_invalid_response", "a page must be an object");
  if (!Array.isArray(page.items) || page.items.length > limits.pageLimit) throw pullError("peer_invalid_response", "items must be a bounded array");
  if (typeof page.has_more !== "boolean") throw pullError("peer_invalid_response", "has_more must be a boolean");
  const nextCursor = cursorOf(page.next_cursor, "next_cursor", limits);
  const checkpoint = cursorOf(page.checkpoint, "checkpoint", limits);
  if (page.has_more && nextCursor === null) throw pullError("peer_invalid_response", "a non-final page must carry a cursor");
  if (checkpoint === null) throw pullError("peer_invalid_response", "a page must carry a checkpoint");
  return { items: page.items, hasMore: page.has_more, nextCursor, checkpoint };
}

const ITEM_STAGES = Object.freeze({
  item_too_large: { stage: "bounds", reasonCode: "document_too_large" },
  item_malformed: { stage: "parse", reasonCode: "peer_item_malformed" },
  item_unparsable: { stage: "parse", reasonCode: "parse_error" },
  item_invalid: { stage: "validation", reasonCode: "validation_error" },
  item_id_mismatch: { stage: "validation", reasonCode: "record_id_mismatch" },
});

// Independently verifies one feed item: bounded JSON, canonical payload, self-certifying identity,
// Ed25519 proof, freshness rules, and a recomputed record ID that must equal the published one.
export function prepareItem(item, { validationTime }) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return { invalid: { code: "item_malformed" } };
  const envelope = item.envelope;
  if (typeof item.record_id !== "string" || !RECORD_ID_PATTERN.test(item.record_id) || envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { invalid: { code: "item_malformed" } };
  }
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (bytes.length > INGEST_LIMITS.maxDocumentBytes) return { invalid: { code: "item_too_large", bytes } };
  let document;
  try {
    document = parseJsonStrict(bytes);
  } catch (error) {
    return { invalid: { code: "item_unparsable", message: boundedMessage(error), bytes } };
  }
  let verified;
  try {
    verified = validateEnvelope(document, { validationTime });
  } catch (error) {
    return { invalid: { code: "item_invalid", message: boundedMessage(error), bytes } };
  }
  if (verified.recordId !== item.record_id) return { invalid: { code: "item_id_mismatch", bytes } };
  return { valid: { bytes, document, verified } };
}

function quarantineItem(db, invalid, { now, sourceKind, sourceId }) {
  const mapping = ITEM_STAGES[invalid.code] ?? ITEM_STAGES.item_invalid;
  quarantineDocument(db, invalid.bytes ?? Buffer.alloc(0), {
    stage: mapping.stage,
    reasonCode: mapping.reasonCode,
    message: invalid.message ?? invalid.code,
    sourceKind,
    sourceId,
    now,
  });
}

function applyItems(db, { items, validationTime, now, sourceKind, sourceId }) {
  const summary = { stored: 0, duplicates: 0, quarantined: 0, stations: new Set(), recordIds: [] };
  for (const item of items) {
    const prepared = prepareItem(item, { validationTime });
    if (prepared.invalid) {
      quarantineItem(db, prepared.invalid, { now, sourceKind, sourceId });
      summary.quarantined += 1;
      continue;
    }
    const { bytes, document, verified } = prepared.valid;
    const result = ingestVerifiedDocument(db, { accept: true, bytes, document, now, sourceId, sourceKind, verified });
    if (result.status === INGEST_STATUS.stored) summary.stored += 1;
    else summary.duplicates += 1;
    if (result.kind === "station") summary.stations.add(result.stationId);
    summary.recordIds.push(result.recordId);
  }
  return { ...summary, stations: [...summary.stations] };
}

// The replication receipt stamped on stations whose records this page added. It is local receipt
// time (never `issued_at`) and it is not part of the derived projection content, so an idempotent
// re-pull cannot churn a generation. Stations without a materialized row yet are stamped when they
// are materialized from the queued work instead.
function stampReplication(db, stations, now) {
  for (const stationId of stations) {
    db.prepare("UPDATE station_state SET last_replication_at = ? WHERE station_id = ?").run(now, stationId);
  }
}

// One feed page, committed atomically: records (or duplicates), quarantine evidence, the
// replication stamp, and the peer's cursor state all land in the same transaction, so a crash
// before COMMIT leaves neither a stored record nor an advanced cursor. Replaying the page after a
// crash is safe because record IDs are content-addressed and idempotent.
export function commitFeedPage(db, { peer, items, cursor, checkpoint, hasMore, now, validationTime = secondInstant(now) }) {
  return withTransaction(db, () => {
    const summary = applyItems(db, { items, now, sourceId: peer.nodeId, sourceKind: "peer", validationTime });
    stampReplication(db, summary.stations, now);
    const state = recordFeedPage(db, peer.nodeId, { checkpoint, cursor, hasMore, now, pages: 1, stored: summary.stored });
    return { ...summary, peer: state };
  });
}

// One snapshot-recovery page, committed under the same atomic rule. The feed cursor moves only on
// the final page, so an interrupted import resumes from the snapshot cursor and never adopts a
// checkpoint that skipped records.
export function commitSnapshotPage(db, { peer, items, cursor, checkpoint, final, now, validationTime = secondInstant(now) }) {
  return withTransaction(db, () => {
    const summary = applyItems(db, { items, now, sourceId: peer.nodeId, sourceKind: "peer", validationTime });
    stampReplication(db, summary.stations, now);
    const state = recordSnapshotPage(db, peer.nodeId, { checkpoint, cursor, final, now, pages: 1, stored: summary.stored });
    return { ...summary, peer: state };
  });
}

// ---------------------------------------------------------------------------------------------
// The pull loop
// ---------------------------------------------------------------------------------------------

function accumulate(total, part, { snapshot = false } = {}) {
  if (snapshot) total.snapshot_pages += part.snapshot_pages ?? 1;
  else total.pages += part.pages ?? 1;
  total.items += part.items ?? 0;
  total.stored += part.stored;
  total.duplicates += part.duplicates;
  total.quarantined += part.quarantined;
  return total;
}

// Imports the peer's complete retained set after its feed cursor was rejected (`410 Gone`), or
// resumes an import a previous run could not finish. A snapshot cursor the peer also rejects is
// restarted once per run from the first page; a second rejection fails the attempt.
async function recoverSnapshot(db, peer, { fetchImpl, limits, now, allowRestart }) {
  let cursor = peer.snapshotCursor;
  let restarted = false;
  const summary = blankSummary();
  while (summary.snapshot_pages < limits.maxSnapshotPages) {
    const url = peerUrl(peer, "snapshot", { cursor, kinds: limits.kinds.join(","), limit: limits.pageLimit });
    const { status, bytes } = await requestPeer(fetchImpl, url, { maxBytes: limits.maxResponseBytes, timeoutMs: limits.requestTimeoutMs });
    if (status === 410) {
      if (cursor === null || !allowRestart || restarted) throw pullError("peer_cursor_unusable", "the peer rejected the snapshot cursor");
      restarted = true;
      cursor = null;
      continue;
    }
    if (status !== 200) throw pullError("peer_http_error", `the peer answered ${status}`);
    const page = readPage(bytes, { limits });
    const commit = commitSnapshotPage(db, { checkpoint: page.checkpoint, cursor: page.nextCursor, final: !page.hasMore, items: page.items, now, peer });
    accumulate(summary, { ...commit, items: page.items.length }, { snapshot: true });
    if (!page.hasMore) return { ...summary, status: "recovered" };
    cursor = page.nextCursor;
  }
  return { ...summary, status: "recovering" };
}

async function pullFeed(db, peer, { fetchImpl, limits, now, summary = blankSummary() }) {
  let cursor = peer.feedCursor;
  let allowRecovery = true;
  while (summary.pages < limits.maxPagesPerRun && summary.items < limits.maxItemsPerRun) {
    const url = peerUrl(peer, "records", { cursor, kinds: limits.kinds.join(","), limit: limits.pageLimit });
    const { status, bytes, headers } = await requestPeer(fetchImpl, url, { maxBytes: limits.maxResponseBytes, timeoutMs: limits.requestTimeoutMs });
    if (status === 410) {
      if (!allowRecovery) throw pullError("peer_cursor_unusable", "the peer rejected the cursor again after a snapshot recovery");
      const recovered = await recoverSnapshot(db, peer, { allowRestart: true, fetchImpl, limits, now });
      accumulate(summary, recovered, { snapshot: true });
      if (recovered.status === "recovering") return outcome(peer.nodeId, "recovering", { ...summary });
      // The snapshot checkpoint is the feed resume point; continue inside the remaining budget.
      peer = readPeer(db, peer.nodeId);
      cursor = peer.feedCursor;
      allowRecovery = false;
      continue;
    }
    if (status === 429) throw pullError("peer_rate_limited", "the peer rate-limited this pull", { retryAfterMs: retryAfterMsOf(headers, Date.parse(now)) });
    if (status !== 200) throw pullError("peer_http_error", `the peer answered ${status}`);
    const page = readPage(bytes, { limits });
    if (page.hasMore && page.nextCursor === cursor) throw pullError("peer_invalid_response", "the peer repeated its cursor");
    const commit = commitFeedPage(db, { checkpoint: page.checkpoint, cursor: page.nextCursor, hasMore: page.hasMore, items: page.items, now, peer });
    accumulate(summary, { ...commit, items: page.items.length });
    if (!page.hasMore) return outcome(peer.nodeId, summary.stored > 0 ? "pulled" : "up_to_date", { ...summary, cursor_advanced: peer.feedCursor !== readPeer(db, peer.nodeId).feedCursor });
    cursor = page.nextCursor;
  }
  return outcome(peer.nodeId, "budget_exhausted", { ...summary, cursor_advanced: peer.feedCursor !== readPeer(db, peer.nodeId).feedCursor });
}

// Pulls one pinned peer: identity check, then (resuming) snapshot recovery or the feed walk. The
// failure path records the code, the consecutive-failure count, the jittered backoff clock, and -
// at the threshold - the circuit breaker, all persisted, and returns a bounded outcome instead of
// throwing, so one peer can never abort a multi-peer run.
export async function pullPeer(db, nodeId, options = {}) {
  const { fetchImpl = globalThis.fetch, now = new Date().toISOString(), random = Math.random, limits = PULL_LIMITS } = options;
  const peer = readPeer(db, nodeId);
  if (peer === null) throw new Error(`unknown peer: ${nodeId}`);
  const gate = peerPullReady(peer, { nowMs: Date.parse(now) });
  if (!gate.ready) return outcome(nodeId, gate.reason, { retry_at: gate.retryAt });
  recordPeerAttempt(db, nodeId, now);
  try {
    await verifyPeerCard(fetchImpl, peer, { limits, now });
    let state = readPeer(db, nodeId);
    // One outcome for the whole run: a snapshot import this run performed is part of it, so an
    // operator reading `stored`/`pulled` sees the records the run actually imported.
    const summary = blankSummary();
    if (state.snapshotCursor !== null) {
      const resumed = await recoverSnapshot(db, state, { allowRestart: true, fetchImpl, limits, now });
      accumulate(summary, resumed, { snapshot: true });
      if (resumed.status === "recovering") return outcome(nodeId, "recovering", { ...summary, recovering: true });
      state = readPeer(db, nodeId);
    }
    return await pullFeed(db, state, { fetchImpl, limits, now, summary });
  } catch (error) {
    const failure = error instanceof PullError ? error : pullError("peer_pull_failed", boundedMessage(error));
    const recorded = recordPeerFailure(db, nodeId, {
      code: failure.code,
      message: failure.message,
      now,
      random,
      retryAfterMs: failure.details?.retryAfterMs ?? null,
    });
    return outcome(nodeId, "failed", {
      backoff_until: recorded.backoffUntil,
      circuit_open: recorded.circuitOpen,
      consecutive_failures: recorded.consecutiveFailures,
      error: { code: failure.code, message: failure.message },
      retry_at: recorded.circuitOpenUntil ?? recorded.backoffUntil,
    });
  }
}

// Pulls every pinned peer, or one named peer, strictly sequentially. Peers are a bulkhead: the
// outcome of one is never an input to another, and a failing peer only consumes its own budget.
export async function pullPeers(db, options = {}) {
  const { nodeId = null, ...rest } = options;
  const peers = nodeId === null ? listPeers(db) : [readPeer(db, nodeId)].filter(peer => peer !== null);
  const outcomes = [];
  for (const peer of peers) outcomes.push(await pullPeer(db, peer.nodeId, rest));
  return outcomes;
}
