-- Latest daemon report per computer, from its host join. These are not live-presence signals.
ALTER TABLE devices ADD COLUMN daemon_version TEXT;
ALTER TABLE devices ADD COLUMN daemon_joined_at INTEGER;
ALTER TABLE devices ADD COLUMN rollback_bad_version TEXT;
ALTER TABLE devices ADD COLUMN rollback_bad_build TEXT;
ALTER TABLE devices ADD COLUMN rollback_at INTEGER;
