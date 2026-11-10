-- Images uploaded per account per UTC day, for the daily upload limit (limits are config in KV).
CREATE TABLE upload_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  count   INTEGER NOT NULL DEFAULT 0, -- uploads accepted
  bytes   INTEGER NOT NULL DEFAULT 0, -- bytes actually stored (a duplicate stores nothing)
  PRIMARY KEY (user_id, day)
);

-- Bytes of images each account has stored (across rooms), for the per-account storage cap.
CREATE TABLE storage_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  bytes   INTEGER NOT NULL DEFAULT 0
);
