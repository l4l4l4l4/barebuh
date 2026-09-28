// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Read-only records feed and snapshot recovery views over the immutable record store.
//
// Boundary (docs/adr/0002-private-registry-node.md): this module owns SQL over `records`, the feed
// and snapshot query parsing, and the bounds of both. It never writes, never performs network I/O,
// and never re-verifies or re-derives protocol semantics - records are served exactly as the
// bounded ingest stored them (canonical payload bytes and the accepted relay envelope), and the
// consumer re-verifies every item independently (docs/protocol-mvp.md, "Record feed").
//
// Feed semantics:
//   * the feed is append-only over `records.ingest_seq` (AUTOINCREMENT, never deleted), so pages
//     are stable and a cursor is a position in that sequence, not a timestamp;
//   * a cursor is opaque, feed-bound, filter-bound (the normalized `kinds` list), and expires
//     after 15 minutes. An expired cursor - and a cursor whose anchor record no longer exists at
//     its position - are answered `410 Gone` with the snapshot URL to recover from;
//   * `next_cursor` is the resume point for the caller's own walk and is null on the final page;
//     `checkpoint` is the feed position that covers everything returned so far *and* everything
//     recorded before the page was cut, which is what a snapshot import resumes from;
//   * a page is capped by item count, by a response byte budget (at least one item is always
//     present), and the whole feed relays stored records only: quarantine evidence, local policy,
//     and projections are local state and never leave the node.
//
// Snapshot semantics: a snapshot pins `head_seq` (the newest position at the moment the snapshot
// started) and pages through the complete retained set at or below it. Later appends are outside
// the window, so a multi-page import is stable; the final page's checkpoint is the feed resume
// point. A consumer that already holds newer valid records keeps them: the union is monotone
// because records are content-addressed and idempotent.
//
// Both views bound their work before touching the store and serve only the closed error envelope
// vocabulary through ./cursor.mjs.

import { parseJsonStrict } from "../../../protocol/v1/lib/conformance.mjs";
import { cursorExpiry, cursorFilterMatches, cursorInvalid, decodeCursorToken, encodeCursorToken, ReadRequestError, secondInstant } from "./cursor.mjs";

export const FEED_LIMITS = Object.freeze({
  defaultLimit: 100,
  maximumLimit: 1000,
  maxKinds: 3,
  // A page's decoded record bytes plus JSON overhead; the final response is bounded by construction
  // (at most one record beyond the budget, so a single oversized record can never empty a page).
  maxResponseBytes: 1_048_576,
  maxCursorOffset: 1_000_000,
});

export const FEED_KINDS = Object.freeze(["station", "node", "observation"]);

const PARAMETERS = Object.freeze(["cursor", "kinds", "limit"]);
const RECORD_ID_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

function invalidParameter(parameter, reason) {
  const name = typeof parameter === "string" && SAFE_NAME_PATTERN.test(parameter) ? parameter : "unknown";
  return new ReadRequestError(400, "invalid_parameter", "A query parameter is invalid.", { parameter: name, reason });
}

function cursorBindingMismatch() {
  return new ReadRequestError(400, "cursor_binding_mismatch", "The cursor belongs to a different feed or filter.");
}

function cursorExpired(snapshotUrl) {
  return new ReadRequestError(410, "cursor_expired", "The cursor has expired; recover from a snapshot.", { snapshot: snapshotUrl });
}

function cursorStale(snapshotUrl) {
  return new ReadRequestError(410, "cursor_stale", "The cursor position no longer exists; recover from a snapshot.", { snapshot: snapshotUrl });
}

// The feed and the snapshot share one query surface (docs/protocol-mvp.md): `cursor`, `limit`, and
// the optional comma-separated `kinds` filter. Anything else, including duplicates, is rejected
// before the store is touched.
export function parseFeedQuery(searchParams) {
  const seen = new Map();
  for (const [name, value] of searchParams) {
    if (!PARAMETERS.includes(name)) throw invalidParameter(name, "unknown_parameter");
    seen.set(name, [...(seen.get(name) ?? []), value]);
  }
  for (const name of PARAMETERS) {
    if ((seen.get(name)?.length ?? 0) > 1) throw invalidParameter(name, "duplicate_parameter");
  }

  let limit = FEED_LIMITS.defaultLimit;
  const rawLimit = seen.get("limit")?.[0];
  if (rawLimit !== undefined) {
    if (!/^[0-9]{1,6}$/u.test(rawLimit)) throw invalidParameter("limit", "invalid_value");
    limit = Number(rawLimit);
    if (limit < 1 || limit > FEED_LIMITS.maximumLimit) throw invalidParameter("limit", "out_of_bounds");
  }

  let kinds = FEED_KINDS;
  const rawKinds = seen.get("kinds")?.[0];
  if (rawKinds !== undefined) {
    const values = rawKinds.split(",");
    if (values.length > FEED_LIMITS.maxKinds || values.some(value => !FEED_KINDS.includes(value))) throw invalidParameter("kinds", "invalid_value");
    const unique = [...new Set(values)];
    if (unique.length !== values.length) throw invalidParameter("kinds", "invalid_value");
    // Sorted and de-duplicated, so an equivalent reordered filter is accepted and the cursor
    // binding cannot be broken by member order (the same rule the search filter follows).
    kinds = unique.sort();
  }

  return { kinds, limit, cursor: seen.get("cursor")?.[0] ?? null };
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function recordsCursor({ kinds, afterSeq, anchor, expiresAt }) {
  return { anchor, after_seq: afterSeq, expires_at: expiresAt, feed: "records", kinds, v: 1 };
}

function snapshotCursor({ kinds, offset, headSeq, anchor, expiresAt }) {
  return { anchor, expires_at: expiresAt, feed: "snapshot", head_seq: headSeq, kinds, offset, v: 1 };
}

// Structural validation of a feed/snapshot token. Expiry is checked here (not in the shared
// decoder) because a feed cursor answers `410 Gone`, while the search API answers `400`.
function decodeFeedCursor(token, { nowInstant, feed, kinds, snapshotUrl }) {
  const payload = decodeCursorToken(token);
  if (payload.feed !== feed) throw cursorBindingMismatch();
  if (!Array.isArray(payload.kinds) || payload.kinds.length === 0 || payload.kinds.some(kind => typeof kind !== "string")) throw cursorInvalid();
  if (!cursorFilterMatches(payload.kinds, kinds)) throw cursorBindingMismatch();
  if (payload.expires_at <= nowInstant) throw cursorExpired(snapshotUrl);
  return payload;
}

function anchorRow(db, kinds, seq) {
  return db.prepare(`SELECT record_id FROM records WHERE ingest_seq = ? AND kind IN (${placeholders(kinds.length)})`).get(seq, ...kinds) ?? null;
}

// A cursor names its position by (sequence, record ID). The anchor is what makes the token
// origin-specific: the position must still exist here and still hold that record. A store that no
// longer has it is answered with the snapshot recovery contract instead of a shifted page.
function requireCurrentAnchor(db, { kinds, seq, anchor, snapshotUrl }) {
  if (seq === 0) {
    if (anchor !== null) throw cursorStale(snapshotUrl);
    return;
  }
  if (anchorRow(db, kinds, seq)?.record_id !== anchor) throw cursorStale(snapshotUrl);
}

function headRow(db, kinds) {
  return db.prepare(`SELECT ingest_seq, record_id FROM records WHERE kind IN (${placeholders(kinds.length)}) ORDER BY ingest_seq DESC LIMIT 1`).get(...kinds) ?? null;
}

// Serves rows as feed items under the page byte budget. The parser keeps protocol-level bounds on
// every served record even though the bytes were verified at ingest.
function boundedItems(rows, limit, { maxResponseBytes }) {
  const items = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows.slice(0, limit)) {
    const envelope = parseJsonStrict(Buffer.from(row.relay_envelope));
    const size = row.relay_envelope.length + 64;
    if (items.length > 0 && bytes + size > maxResponseBytes) {
      truncated = true;
      break;
    }
    items.push({ seq: row.ingest_seq, recordId: row.record_id, envelope });
    bytes += size;
  }
  return { items, truncated };
}

function pageItems(items) {
  return items.map(item => ({ envelope: item.envelope, record_id: item.recordId }));
}

// The byte budget is a parameter so the pagination rule is directly testable; the HTTP layer always
// passes the module's own bounds, so production behaviour is the default below.
export function recordsFeedPage(db, { kinds, limit, cursor, nowIso, snapshotUrl, limits = FEED_LIMITS }) {
  const nowInstant = secondInstant(nowIso);
  if (nowInstant === null) throw new TypeError("nowIso must be an ISO instant");
  const expiresAt = cursorExpiry(nowIso);

  let afterSeq = 0;
  let anchor = null;
  if (cursor !== null) {
    const payload = decodeFeedCursor(cursor, { nowInstant, feed: "records", kinds, snapshotUrl });
    if (!Number.isSafeInteger(payload.after_seq) || payload.after_seq < 0) throw cursorInvalid();
    if (payload.anchor !== null && !RECORD_ID_PATTERN.test(payload.anchor)) throw cursorInvalid();
    afterSeq = payload.after_seq;
    anchor = payload.anchor;
    requireCurrentAnchor(db, { kinds, seq: afterSeq, anchor, snapshotUrl });
  }

  const rows = db.prepare(`SELECT ingest_seq, record_id, relay_envelope FROM records WHERE kind IN (${placeholders(kinds.length)}) AND ingest_seq > ? ORDER BY ingest_seq LIMIT ?`)
    .all(...kinds, afterSeq, limit + 1);
  const { items, truncated } = boundedItems(rows, limit, limits);
  const last = items.at(-1) ?? null;
  const hasMore = last !== null && (truncated || rows.length > items.length);
  const head = headRow(db, kinds);
  return {
    items: pageItems(items),
    next_cursor: hasMore ? encodeCursorToken(recordsCursor({ kinds, afterSeq: last.seq, anchor: last.recordId, expiresAt })) : null,
    has_more: hasMore,
    checkpoint: encodeCursorToken(recordsCursor({ kinds, afterSeq: head?.ingest_seq ?? 0, anchor: head?.record_id ?? null, expiresAt })),
  };
}

export function snapshotPage(db, { kinds, limit, cursor, nowIso, snapshotUrl, limits = FEED_LIMITS }) {
  const nowInstant = secondInstant(nowIso);
  if (nowInstant === null) throw new TypeError("nowIso must be an ISO instant");
  const expiresAt = cursorExpiry(nowIso);

  let offset = 0;
  let headSeq = 0;
  let headAnchor = null;
  if (cursor !== null) {
    const payload = decodeFeedCursor(cursor, { nowInstant, feed: "snapshot", kinds, snapshotUrl });
    if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > FEED_LIMITS.maxCursorOffset) throw cursorInvalid();
    if (!Number.isSafeInteger(payload.head_seq) || payload.head_seq < 0) throw cursorInvalid();
    if (payload.anchor !== null && !RECORD_ID_PATTERN.test(payload.anchor)) throw cursorInvalid();
    offset = payload.offset;
    headSeq = payload.head_seq;
    headAnchor = payload.anchor;
    requireCurrentAnchor(db, { kinds, seq: headSeq, anchor: headAnchor, snapshotUrl });
  } else {
    const head = headRow(db, kinds);
    headSeq = head?.ingest_seq ?? 0;
    headAnchor = head?.record_id ?? null;
  }

  const rows = db.prepare(`SELECT ingest_seq, record_id, relay_envelope FROM records WHERE kind IN (${placeholders(kinds.length)}) AND ingest_seq <= ? ORDER BY ingest_seq LIMIT ? OFFSET ?`)
    .all(...kinds, headSeq, limit + 1, offset);
  const { items, truncated } = boundedItems(rows, limit, limits);
  const hasMore = items.length > 0 && (truncated || rows.length > items.length);
  return {
    items: pageItems(items),
    next_cursor: hasMore ? encodeCursorToken(snapshotCursor({ kinds, offset: offset + items.length, headSeq, anchor: headAnchor, expiresAt })) : null,
    has_more: hasMore,
    checkpoint: encodeCursorToken(recordsCursor({ kinds, afterSeq: headSeq, anchor: headAnchor, expiresAt })),
  };
}
