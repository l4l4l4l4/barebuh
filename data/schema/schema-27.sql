ALTER TABLE radio_channels ADD COLUMN country TEXT;
ALTER TABLE radio_channels ADD COLUMN tags TEXT;
ALTER TABLE radio_channels ADD COLUMN codec TEXT;
ALTER TABLE radio_channels ADD COLUMN policy_state TEXT;
ALTER TABLE radio_channels ADD COLUMN indexed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE radio_channels ADD COLUMN last_replication_at INTEGER NOT NULL DEFAULT 0;

UPDATE schema_version SET version=27;
