-- One test notification per person per rolling minute, shared by all browser sessions.
CREATE TABLE push_test_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_at INTEGER NOT NULL
);
