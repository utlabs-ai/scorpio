-- The retention clock: a room quiet for 90 days is archived (archived_reason
-- 'retention', the column of 0009), archived 90 days it goes to the recycle bin, 30 days there it is purged.
-- active_at: the room's last counted message (the RoomDO writes it at the first one of each UTC day), or its creation
-- or last restore when later.
ALTER TABLE rooms ADD COLUMN active_at INTEGER;

-- Everything that exists when this ships starts its clock on that day, 2026-10-07 UTC (retention.ts RETENTION_SINCE):
-- the active rooms are quiet from then, the archived ones archived from then.
UPDATE rooms SET active_at = MAX(created_at, 1791331200000);
UPDATE rooms SET archived_at = 1791331200000 WHERE status = 'archived' AND archived_at < 1791331200000;

-- What the daily job looks for, oldest first.
CREATE INDEX rooms_quiet ON rooms (active_at) WHERE status = 'active';
CREATE INDEX rooms_archived ON rooms (archived_at) WHERE status = 'archived';
