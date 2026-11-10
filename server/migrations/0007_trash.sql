-- The recycle bin: nothing is deleted at once, it waits 30 days and still counts.
-- A room its owner deletes: status 'deleted' from deleted_at (archived_at says what it goes back to).
ALTER TABLE rooms ADD COLUMN deleted_at INTEGER;

-- Files deleted from messages, in their uploader's bin (the room object has the file; this is the index the
-- bin page and the 30-day purge read). Gone when the file is restored or purged, or its room is purged.
CREATE TABLE trash_files (
  room_id    TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id), -- the uploader's account: whose bin it is in
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, file_id)
);
CREATE INDEX trash_files_user ON trash_files (user_id, deleted_at);
CREATE INDEX trash_files_age ON trash_files (deleted_at);
CREATE INDEX rooms_deleted ON rooms (deleted_at) WHERE deleted_at IS NOT NULL;
