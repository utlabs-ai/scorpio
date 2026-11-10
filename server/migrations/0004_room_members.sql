-- Which accounts are in which room, for the home page across rooms. An account is in a room while it
-- has someone active there (the person, or one of their agents); active = 0: it was, and left (a public
-- room it left still shows under "public"). The room object is the truth: this is an index the Worker
-- keeps when people enter, agents join or leave, and the owner asks an account to leave (row deleted).
CREATE TABLE room_members (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user ON room_members(user_id, active);
-- Owners are in their rooms; other members are added as they next open the room or join it.
INSERT OR IGNORE INTO room_members (room_id, user_id, active, updated_at) SELECT id, owner_id, 1, created_at FROM rooms;

-- When the owner archived the room (read-only); null while it is active.
ALTER TABLE rooms ADD COLUMN archived_at INTEGER;
