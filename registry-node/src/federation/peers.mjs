// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Explicit pull-peer pins and their bounded replication state, for the private pinned-federation
// mode (docs/registry-node-security-contract.md, mode PRIVATE_PINNED_FEDERATION).
//
// A peer row exists only because an operator pinned a node identity and an API base through
// `peer-add`. No code path in this module - or anywhere else - derives a pin from a network
// response, from a peer's node card, or from a discovery document: peer admission is explicit and
// non-transitive, and a peer's own peer list is never followed. Removing a pin removes the pull
// source; stored records and their provenance rows stay (they are immutable data, not peer state).
//
// Pin validation mirrors the listener rule: an absolute API base without credentials, query, or
// fragment, ending in "/". Non-loopback bases must use HTTPS because the wire contract is HTTPS
// (docs/protocol-mvp.md); loopback may use plain HTTP because the private listener itself is
// loopback HTTP and both ends are the same trust domain.
//
// The remaining columns are the bounded retry machinery, persisted so a restart cannot retry-storm
// a dead peer: a consecutive-failure count, an exponential backoff clock with jitter, and a
// circuit breaker. Every instant comes from the caller (`now`), so the whole state machine is
// deterministic under a test clock.

import { withTransaction } from "../store/db.mjs";

export const PEER_LIMITS = Object.freeze({
  maxPeers: 32,
  maxLabelBytes: 64,
  maxApiBaseBytes: 2048,
  maxCursorBytes: 4096,
  maxErrorBytes: 512,
  maxFailuresBeforeOpen: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 300_000,
  circuitCooldownMs: 900_000,
});

export const PEER_NODE_ID_PATTERN = /^oradio:node:ed25519:[A-Za-z0-9_-]{43}$/u;

const LABEL_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function loopbackOnly(url) {
  return LOOPBACK_HOSTS.has(url.hostname);
}

// The one place a pin, a cursor, or a failure record enters the store. Cursors are the peer's
// opaque tokens: they are stored verbatim but bounded, so a hostile peer cannot grow the row.
function boundedCursor(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > PEER_LIMITS.maxCursorBytes) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  return value;
}

export function normalizePeerPin({ nodeId, apiBase, label }) {
  if (typeof nodeId !== "string" || !PEER_NODE_ID_PATTERN.test(nodeId) || Buffer.from(nodeId.slice("oradio:node:ed25519:".length), "base64url").toString("base64url") !== nodeId.slice("oradio:node:ed25519:".length)) {
    throw new TypeError("nodeId must be a node identity (oradio:node:ed25519:<digest>)");
  }
  if (typeof label !== "string" || label.length === 0 || Buffer.byteLength(label, "utf8") > PEER_LIMITS.maxLabelBytes || !LABEL_PATTERN.test(label)) {
    throw new TypeError(`label must be 1-${PEER_LIMITS.maxLabelBytes} characters of [A-Za-z0-9._:-]`);
  }
  if (typeof apiBase !== "string" || Buffer.byteLength(apiBase, "utf8") > PEER_LIMITS.maxApiBaseBytes) {
    throw new TypeError(`apiBase must be at most ${PEER_LIMITS.maxApiBaseBytes} bytes`);
  }
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new TypeError("apiBase must be an absolute URL");
  }
  if (url.username || url.password) throw new TypeError("apiBase must not contain credentials");
  if (url.search || url.hash) throw new TypeError("apiBase must not contain a query or fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackOnly(url))) {
    throw new TypeError("apiBase must use HTTPS (plain HTTP is allowed only on loopback)");
  }
  if (!url.pathname.endsWith("/")) throw new TypeError("apiBase must end with a slash");
  return { nodeId, apiBase: url.href, label };
}

function rowToPeer(row) {
  if (!row) return null;
  return {
    nodeId: row.node_id,
    label: row.label,
    apiBase: row.api_base,
    pinnedAt: row.pinned_at,
    feedCursor: row.feed_cursor,
    checkpoint: row.checkpoint,
    snapshotCursor: row.snapshot_cursor,
    cursorUpdatedAt: row.cursor_updated_at,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures,
    backoffUntil: row.backoff_until,
    circuitOpenUntil: row.circuit_open_until,
    lastError: row.last_error,
    pagesCommitted: row.pages_committed,
    recordsStored: row.records_stored,
  };
}

function readPeerRow(db, nodeId) {
  return db.prepare("SELECT * FROM federation_peers WHERE node_id = ?").get(nodeId) ?? null;
}

export function readPeer(db, nodeId) {
  return rowToPeer(readPeerRow(db, nodeId));
}

// Bounded, deterministic listing for operators and tests: pin and state, never a payload.
export function listPeers(db) {
  return db.prepare("SELECT * FROM federation_peers ORDER BY node_id").all().map(rowToPeer);
}

export function addPeer(db, { nodeId, apiBase, label, now = new Date().toISOString() }) {
  const pin = normalizePeerPin({ nodeId, apiBase, label });
  return withTransaction(db, () => {
    if (readPeerRow(db, pin.nodeId) !== null) throw new Error(`peer is already pinned: ${pin.nodeId}`);
    const count = db.prepare("SELECT COUNT(*) AS count FROM federation_peers").get().count;
    if (count >= PEER_LIMITS.maxPeers) throw new Error(`at most ${PEER_LIMITS.maxPeers} peers can be pinned`);
    db.prepare("INSERT INTO federation_peers(node_id, label, api_base, pinned_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(pin.nodeId, pin.label, pin.apiBase, now, now);
    return readPeer(db, pin.nodeId);
  });
}

export function removePeer(db, nodeId, { now = new Date().toISOString() } = {}) {
  return withTransaction(db, () => db.prepare("DELETE FROM federation_peers WHERE node_id = ?").run(nodeId).changes > 0);
}

// The gate in front of every attempt: while a peer is in backoff or has an open circuit, the
// replicator performs no network I/O for it at all.
export function peerPullReady(peer, { nowMs }) {
  for (const [reason, until] of [["circuit_open", peer.circuitOpenUntil], ["backoff", peer.backoffUntil]]) {
    if (typeof until !== "string") continue;
    const untilMs = Date.parse(until);
    if (Number.isFinite(untilMs) && untilMs > nowMs) return { ready: false, reason, retryAt: until };
  }
  return { ready: true, reason: null, retryAt: null };
}

// Equal jitter: half the window plus a random fraction of the other half, so two peers that fail
// at the same instant do not return in lockstep, and the delay stays inside [raw/2, raw].
export function backoffDelayMs(failures, { random = Math.random, retryAfterMs = null, limits = PEER_LIMITS } = {}) {
  const raw = Math.min(limits.backoffBaseMs * 2 ** Math.min(Math.max(failures, 1) - 1, 20), limits.backoffMaxMs);
  const half = Math.floor(raw / 2);
  const jittered = half + Math.floor(random() * (raw - half));
  const honored = Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, limits.backoffMaxMs) : 0;
  return Math.max(jittered, honored, 1);
}

export function recordPeerAttempt(db, nodeId, now) {
  withTransaction(db, () => {
    db.prepare("UPDATE federation_peers SET last_attempt_at = ?, updated_at = ? WHERE node_id = ?").run(now, now, nodeId);
  });
}

// Commits one successfully verified feed page. `cursor` is the page's own resume point while more
// pages remain and the checkpoint (which covers the whole feed up to the cut) once the walk is
// done; both are the peer's opaque tokens, stored verbatim and bounded.
export function recordFeedPage(db, nodeId, { now, cursor, checkpoint, hasMore, stored = 0, pages = 1 }) {
  return withTransaction(db, () => {
    if (hasMore && typeof cursor !== "string") throw new TypeError("a non-final feed page must carry a cursor");
    const next = hasMore ? cursor : (checkpoint ?? cursor ?? null);
    db.prepare(`UPDATE federation_peers
                   SET feed_cursor = ?, checkpoint = ?, cursor_updated_at = ?, last_success_at = ?, last_error = NULL,
                       consecutive_failures = 0, backoff_until = NULL, circuit_open_until = NULL,
                       pages_committed = pages_committed + ?, records_stored = records_stored + ?, updated_at = ?
                 WHERE node_id = ?`)
      .run(boundedCursor(next, "feed cursor") ?? null, boundedCursor(checkpoint, "checkpoint") ?? null, now, now, pages, stored, now, nodeId);
    return readPeer(db, nodeId);
  });
}

// Commits one snapshot-recovery page. The feed cursor only advances on the final page, when the
// complete retained set has been imported: a crash or budget stop mid-snapshot resumes from the
// snapshot cursor on the next run instead of adopting a checkpoint that skipped data.
export function recordSnapshotPage(db, nodeId, { now, cursor, checkpoint, final, stored = 0, pages = 1 }) {
  return withTransaction(db, () => {
    const snapshotCursor = final ? null : boundedCursor(cursor, "snapshot cursor");
    const feedCursor = final ? boundedCursor(checkpoint ?? cursor, "checkpoint") : undefined;
    if (!final && snapshotCursor === null) throw new TypeError("a non-final snapshot page must carry a cursor");
    db.prepare(`UPDATE federation_peers
                   SET snapshot_cursor = ?, feed_cursor = COALESCE(?, feed_cursor), cursor_updated_at = ?,
                       last_success_at = ?, last_error = NULL, consecutive_failures = 0, backoff_until = NULL,
                       circuit_open_until = NULL, pages_committed = pages_committed + ?, records_stored = records_stored + ?,
                       updated_at = ?
                 WHERE node_id = ?`)
      .run(snapshotCursor ?? null, feedCursor ?? null, now, now, pages, stored, now, nodeId);
    return readPeer(db, nodeId);
  });
}

function boundedError(code, message) {
  const text = `${code}${message ? `: ${message}` : ""}`;
  return text.slice(0, PEER_LIMITS.maxErrorBytes);
}

// Records one failed attempt: the count opens the circuit at the declared threshold, and the
// backoff clock (with jitter, and honoring a bounded Retry-After) is persisted so the next run -
// even after a restart - waits instead of hammering.
export function recordPeerFailure(db, nodeId, { now, code, message = "", retryAfterMs = null, random = Math.random }) {
  return withTransaction(db, () => {
    const peer = readPeerRow(db, nodeId);
    if (peer === null) throw new Error(`unknown peer: ${nodeId}`);
    const consecutiveFailures = peer.consecutive_failures + 1;
    const delay = backoffDelayMs(consecutiveFailures, { random, retryAfterMs });
    const backoffUntil = new Date(Date.parse(now) + delay).toISOString();
    const circuitOpen = consecutiveFailures >= PEER_LIMITS.maxFailuresBeforeOpen;
    const circuitOpenUntil = circuitOpen ? new Date(Date.parse(now) + PEER_LIMITS.circuitCooldownMs).toISOString() : null;
    db.prepare(`UPDATE federation_peers
                   SET consecutive_failures = ?, backoff_until = ?, circuit_open_until = ?, last_error = ?, updated_at = ?
                 WHERE node_id = ?`)
      .run(consecutiveFailures, backoffUntil, circuitOpenUntil, boundedError(code, message), now, nodeId);
    return { consecutiveFailures, backoffUntil, circuitOpen, circuitOpenUntil };
  });
}
