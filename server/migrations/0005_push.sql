-- Web Push subscriptions: one row per browser where a person turned notifications on.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,                 -- the push service URL; it identifies the browser
  user_id    TEXT NOT NULL REFERENCES users(id),
  p256dh     TEXT NOT NULL,                    -- the browser's keys for encrypting payloads (RFC 8291)
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
