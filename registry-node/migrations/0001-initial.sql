-- Copyright 2026 Barebuh contributors
-- SPDX-License-Identifier: GPL-3.0-or-later

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE records (
  ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  station_sequence INTEGER,
  issued_at TEXT NOT NULL,
  canonical_payload BLOB NOT NULL,
  relay_envelope BLOB NOT NULL,
  proof_signature BLOB NOT NULL,
  materializable INTEGER NOT NULL CHECK(materializable IN (0, 1)),
  is_tombstone INTEGER NOT NULL CHECK(is_tombstone IN (0, 1)),
  unsupported_critical_json TEXT NOT NULL,
  inserted_at TEXT NOT NULL
) STRICT;

CREATE TABLE record_parents (
  child_record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  parent_record_id TEXT NOT NULL,
  PRIMARY KEY(child_record_id, ordinal),
  UNIQUE(child_record_id, parent_record_id)
) STRICT;

CREATE TABLE record_sources (
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  receipt_count INTEGER NOT NULL CHECK(receipt_count > 0),
  PRIMARY KEY(record_id, source_kind, source_id)
) STRICT;

CREATE TABLE record_policy (
  record_id TEXT PRIMARY KEY REFERENCES records(record_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('quarantined', 'admitted', 'suppressed')),
  reason_code TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE quarantine (
  id INTEGER PRIMARY KEY,
  raw_sha256 TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  failure_stage TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  bounded_raw_envelope BLOB,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE materialize_queue (
  station_id TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT
) STRICT;

CREATE TABLE station_tips (
  station_id TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE RESTRICT,
  PRIMARY KEY(station_id, record_id)
) STRICT;

CREATE TABLE station_state (
  station_id TEXT PRIMARY KEY,
  protocol_winning_record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE RESTRICT,
  visible_record_id TEXT REFERENCES records(record_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('active', 'tombstoned', 'suppressed', 'unsupported_critical', 'orphan_only')),
  forked INTEGER NOT NULL CHECK(forked IN (0, 1)),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  materialized_at TEXT NOT NULL,
  last_replication_at TEXT
) STRICT;

CREATE TABLE station_projection (
  station_id TEXT PRIMARY KEY,
  visible_record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE RESTRICT,
  winning_sequence INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  short_name TEXT,
  homepage TEXT,
  country TEXT,
  station_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0)
) STRICT;

CREATE TABLE station_streams (
  station_id TEXT NOT NULL REFERENCES station_projection(station_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  url TEXT NOT NULL,
  url_digest TEXT NOT NULL,
  transport TEXT,
  container TEXT,
  codec TEXT,
  bitrate_kbps INTEGER,
  PRIMARY KEY(station_id, ordinal)
) STRICT;

CREATE TABLE station_tags (
  station_id TEXT NOT NULL REFERENCES station_projection(station_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  PRIMARY KEY(station_id, normalized_tag)
) STRICT;

CREATE TABLE station_languages (
  station_id TEXT NOT NULL REFERENCES station_projection(station_id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  normalized_language TEXT NOT NULL,
  PRIMARY KEY(station_id, normalized_language)
) STRICT;

CREATE TABLE projection_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  materializer_version INTEGER NOT NULL CHECK(materializer_version > 0),
  rebuilt_at TEXT NOT NULL
) STRICT;

INSERT INTO projection_meta(singleton, generation, materializer_version, rebuilt_at)
VALUES (1, 0, 1, '1970-01-01T00:00:00.000Z');

CREATE VIRTUAL TABLE station_fts USING fts5(
  station_id UNINDEXED,
  name,
  short_name,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
