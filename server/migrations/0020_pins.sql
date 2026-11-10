-- Topics a person pinned to the top of their list. Its own table, not a column on room_members:
-- a topic's creator need not have a member row. A pin goes when its topic is purged.
CREATE TABLE pins (
  user_id   TEXT NOT NULL REFERENCES users(id),
  room_id   TEXT NOT NULL REFERENCES rooms(id),
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
