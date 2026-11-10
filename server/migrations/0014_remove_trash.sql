-- Retire the file recycle bin only when it has no old rows to strand.
-- Old deleted rooms, if any, keep their original 30-day purge clock (purge_pending = 0).
CREATE TABLE IF NOT EXISTS _trash_retire_guard (n INTEGER NOT NULL CHECK (n = 0));
DELETE FROM _trash_retire_guard;
INSERT INTO _trash_retire_guard SELECT COUNT(*) FROM trash_files;
DROP TABLE _trash_retire_guard;

-- A new delete is purged immediately; if storage is unavailable, the daily job retries it (1).
-- An old deleted room from before this deployment keeps the old schedule (0).
ALTER TABLE rooms ADD COLUMN purge_pending INTEGER NOT NULL DEFAULT 0;
DROP TABLE trash_files;
