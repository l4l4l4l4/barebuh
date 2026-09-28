// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared opaque-token codec for the local read model: the search cursor (./views.mjs) and the
// records-feed and snapshot cursors (./feed.mjs).
//
// A token is `c1.` plus base64url(canonical JSON). It is opaque to clients by contract
// (docs/protocol-mvp.md: "Cursors are opaque, origin-specific, feed/filter-bound, and may
// expire"), so the payload is never documented on the wire; the bindings that make a cursor
// single-use and origin-specific are enforced by the callers against their own state:
//
//   * `decodeCursorToken` enforces structure and lifetime only - it is the one place where the
//     token is parsed, so a hostile token can never reach feed-specific code as anything but a
//     bounded, well-formed object;
//   * the caller checks the feed name, the filter binding, and the position: a token minted by
//     another feed is answered `cursor_binding_mismatch`, and a position that no longer exists in
//     this store is answered with the caller's own recovery response (the records feed treats
//     both an expired and a stale cursor as `410 Gone` with a snapshot URL).
//
// Expiry is deliberately not decided here: the search API answers an expired cursor with
// `400 cursor_invalid` (as reviewed), while the records feed must answer `410 Gone` so a
// consumer knows to recover from a snapshot.

import { canonicalize, parseJsonStrict } from "../../../protocol/v1/lib/conformance.mjs";

// A request-time failure with a stable machine-readable code. The HTTP layer maps these into the
// shared JSON error envelope; everything else it does not recognize becomes a bounded 500.
export class ReadRequestError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "ReadRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const CURSOR_LIMITS = Object.freeze({
  maxCursorBytes: 4096,
  maxCursorOffset: 1_000_000,
  cursorLifetimeSeconds: 15 * 60,
});

const TOKEN_PATTERN = /^c1\.([A-Za-z0-9_-]+)$/u;
const FEED_NAME_PATTERN = /^[a-z]{1,16}$/u;
const SECOND_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

// Local timestamps are stored with millisecond precision; the wire profile uses second-precision
// RFC 3339 UTC instants (docs/protocol-mvp.md), which also compare correctly as plain strings.
export function secondInstant(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return `${new Date(milliseconds).toISOString().slice(0, 19)}Z`;
}

// The single expiry rule for every cursor this node mints: `issued at` plus one bounded lifetime.
export function cursorExpiry(nowIso) {
  const expiresAt = secondInstant(new Date(Date.parse(nowIso) + CURSOR_LIMITS.cursorLifetimeSeconds * 1000).toISOString());
  if (expiresAt === null) throw new TypeError("nowIso must be an ISO instant");
  return expiresAt;
}

export function cursorInvalid() {
  return new ReadRequestError(400, "cursor_invalid", "The cursor is invalid or has expired.");
}

export function encodeCursorToken(payload) {
  return `c1.${Buffer.from(canonicalize(payload), "utf8").toString("base64url")}`;
}

// Parses and structurally validates a token. `nowInstant`, when given, also enforces the expiry;
// the records feed omits it because an expired cursor is a distinct (410) response there.
export function decodeCursorToken(token, { nowInstant } = {}) {
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > CURSOR_LIMITS.maxCursorBytes) throw cursorInvalid();
  const match = TOKEN_PATTERN.exec(token);
  if (!match) throw cursorInvalid();
  let payload;
  try {
    const bytes = Buffer.from(match[1], "base64url");
    if (bytes.toString("base64url") !== match[1]) throw new Error("non-canonical encoding");
    payload = parseJsonStrict(bytes);
  } catch {
    throw cursorInvalid();
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw cursorInvalid();
  if (payload.v !== 1) throw cursorInvalid();
  if (typeof payload.feed !== "string" || !FEED_NAME_PATTERN.test(payload.feed)) throw cursorInvalid();
  if (typeof payload.expires_at !== "string" || !SECOND_INSTANT_PATTERN.test(payload.expires_at)) throw cursorInvalid();
  if (nowInstant !== undefined && payload.expires_at <= nowInstant) throw cursorInvalid();
  return payload;
}

// Both the search cursor and the records feed cursor are filter-bound by a normalized value list;
// a caller compares the caller-supplied filter with the token's binding through this helper so
// the two feeds cannot drift in how they canonicalize it.
export function cursorFilterMatches(tokenValue, expected) {
  return canonicalize(tokenValue) === canonicalize(expected);
}
