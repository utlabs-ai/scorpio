-- A file's own address, /v/<fileId>: which room a file is in, so the link needs no room id.
-- Written on upload. Kept when the file goes (evicted, swept unsent) so its page can still say what became of it;
-- gone with its room's purge.
CREATE TABLE file_rooms (
  file_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL
);
CREATE INDEX file_rooms_room ON file_rooms (room_id);

-- Files already uploaded: the account index has every file still in a room.
INSERT OR IGNORE INTO file_rooms (file_id, room_id) SELECT file_id, room_id FROM account_files;
