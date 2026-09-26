ALTER TABLE radio_channels ADD COLUMN station_id TEXT;
ALTER TABLE radio_channels ADD COLUMN provenance TEXT;
ALTER TABLE radio_channels ADD COLUMN health TEXT;
ALTER TABLE radio_channels ADD COLUMN forked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE radio_channels ADD COLUMN refreshed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE radio_channels ADD COLUMN health_expires_at INTEGER NOT NULL DEFAULT 0;

UPDATE schema_version SET version=26;
