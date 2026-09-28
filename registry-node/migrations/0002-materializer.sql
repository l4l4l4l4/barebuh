-- Copyright 2026 Barebuh contributors
-- SPDX-License-Identifier: GPL-3.0-or-later

-- Schema 2 introduces the deterministic station materializer. Immutable record bytes,
-- provenance, and the quarantine domain are untouched by this migration.
--
-- `station_state` is rebuilt for two reasons recorded in docs/registry-node-security-contract.md
-- (MOD-01) and docs/adr/0002-private-registry-node.md:
--   1. a station can exist without a protocol winner (orphan-only input, unsupported critical
--      members, local quarantine holds), so `protocol_winning_record_id` must be nullable;
--   2. materialization states `active`, `tombstoned`, `suppressed`, `unsupported_critical`,
--      and `orphan_only` stay distinct, and a station whose only records are quarantined needs
--      its own state instead of being reported as an orphan.
-- Stations without a materializable history are still, by definition, not materialized, and
-- the state column records why. The copy is a plain INSERT ... SELECT because every schema-1
-- row satisfies the schema-2 constraints.

ALTER TABLE station_state RENAME TO station_state_schema1;

CREATE TABLE station_state (
  station_id TEXT PRIMARY KEY,
  protocol_winning_record_id TEXT REFERENCES records(record_id) ON DELETE RESTRICT,
  visible_record_id TEXT REFERENCES records(record_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('active', 'tombstoned', 'suppressed', 'unsupported_critical', 'orphan_only', 'quarantined')),
  forked INTEGER NOT NULL CHECK(forked IN (0, 1)),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  materialized_at TEXT NOT NULL,
  last_replication_at TEXT
) STRICT;

INSERT INTO station_state (station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at, last_replication_at)
  SELECT station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at, last_replication_at
    FROM station_state_schema1;

DROP TABLE station_state_schema1;

-- Derived-store indexes. `record_parents` intentionally has no foreign key on the parent
-- column so valid orphans persist; the reverse lookup (children of a record that just
-- arrived) is the hot path of orphan promotion and needs its own index.
CREATE INDEX records_kind_subject_idx ON records(kind, subject_id);
CREATE INDEX record_parents_parent_idx ON record_parents(parent_record_id);
CREATE INDEX station_projection_name_idx ON station_projection(normalized_name, station_id);
CREATE INDEX materialize_queue_order_idx ON materialize_queue(enqueued_at, station_id);
