-- A full file space evicts the oldest: to find an account's oldest files across its
-- rooms the server keeps an index of every file. The file itself lives in its room's object; this is a copy of who
-- uploaded it, when, and how many bytes of the room's object are charged to them (0 for a duplicate of bytes someone
-- else in the room stored first). Written on upload; cleared when the file goes (sent unsent, evicted, purged with
-- its room); the charge follows the room object's when it moves to another copy.
CREATE TABLE account_files (
  room_id     TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id), -- the uploader's account
  size        INTEGER NOT NULL,
  charged     INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, file_id)
);
CREATE INDEX account_files_age ON account_files (user_id, uploaded_at);

-- One eviction run per account at a time (two uploads finishing together must not each delete files for the other).
ALTER TABLE storage_usage ADD COLUMN evicting_until INTEGER;

-- A Pro that lapses keeps the 20 GB space until then (ms), then the free 1 GB applies.
ALTER TABLE entitlements ADD COLUMN grace_until INTEGER;
