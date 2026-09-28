-- Copyright 2026 Barebuh contributors
-- SPDX-License-Identifier: GPL-3.0-or-later

-- Schema 3 adds explicit pull peers for private pinned federation (docs/registry-node-security-
-- contract.md, mode PRIVATE_PINNED_FEDERATION). Immutable records, provenance, policy, and the
-- projection are untouched by this migration.
--
-- `federation_peers` is operator state, not replicated data:
--   * a row exists only because an operator pinned that node identity and API base explicitly
--     (pull sources are explicit pins; peer-of-peer admission is forbidden), so there is no code
--     path that creates a row from a network response or from another peer's card;
--   * the pin columns (`label`, `api_base`) are local configuration; the remaining columns are the
--     bounded per-peer replication state: the peer's opaque feed cursor, the in-progress snapshot
--     recovery cursor, monotonic counters, and the backoff/circuit-breaker clock.
--
-- Cursor columns are bounded text: the store never holds an unbounded peer-supplied token, and an
-- over-long cursor is rejected before it is written. Timestamps are local RFC 3339 instants, so
-- they sort and compare as strings; the wire format is never stored here.

CREATE TABLE federation_peers (
  node_id TEXT PRIMARY KEY CHECK(length(node_id) BETWEEN 1 AND 128),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
  api_base TEXT NOT NULL CHECK(length(api_base) BETWEEN 8 AND 2048),
  pinned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  feed_cursor TEXT CHECK(feed_cursor IS NULL OR length(feed_cursor) <= 4096),
  checkpoint TEXT CHECK(checkpoint IS NULL OR length(checkpoint) <= 4096),
  snapshot_cursor TEXT CHECK(snapshot_cursor IS NULL OR length(snapshot_cursor) <= 4096),
  cursor_updated_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  backoff_until TEXT,
  circuit_open_until TEXT,
  last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 512),
  pages_committed INTEGER NOT NULL DEFAULT 0 CHECK(pages_committed >= 0),
  records_stored INTEGER NOT NULL DEFAULT 0 CHECK(records_stored >= 0)
) STRICT;
