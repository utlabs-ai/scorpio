-- Per-browser push preferences: filter before sending, never send a silent push that shows nothing.
ALTER TABLE push_subscriptions ADD COLUMN todo_assigned INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN quota_warn INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN sound INTEGER NOT NULL DEFAULT 1;

CREATE TABLE push_muted_rooms (
  endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  PRIMARY KEY (endpoint, room_id)
);
