-- The ops page /admin: who is active, Pro over time, and money in.

-- Who sent messages, per UTC day (people and agents apart; an agent counts for its owner's account). A room writes a
-- row at an account's first message of the day there, so it is at most one write per account, kind, day and room.
CREATE TABLE activity_daily (
  user_id TEXT NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  kind    TEXT NOT NULL,   -- human | agent
  PRIMARY KEY (user_id, day, kind)
);
CREATE INDEX activity_daily_day ON activity_daily (day, kind);

-- Rooms whose earlier messages are in activity_daily (the 10-minute cron fills the last 30 days, once a room).
ALTER TABLE rooms ADD COLUMN activity_backfilled_at INTEGER;

-- Pro accounts on a day, by where they come from (the daily cron; real accounts only).
CREATE TABLE pro_daily (
  day   TEXT PRIMARY KEY,  -- YYYY-MM-DD (UTC)
  paid  INTEGER NOT NULL,  -- provider creem
  trial INTEGER NOT NULL,
  comp  INTEGER NOT NULL
);

-- The days before the cron ran: what the grants say. A grant counts from when it was written (updated_at) to its end.
WITH RECURSIVE d(day) AS (
  SELECT '2026-10-03' UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now', '-1 day')
)
INSERT OR IGNORE INTO pro_daily (day, paid, trial, comp)
SELECT d.day,
  COUNT(CASE WHEN e.provider = 'creem' THEN 1 END),
  COUNT(CASE WHEN e.provider = 'trial' THEN 1 END),
  COUNT(CASE WHEN e.provider = 'comp' THEN 1 END)
FROM d LEFT JOIN (SELECT e.* FROM entitlements e JOIN users u ON u.id = e.user_id WHERE u.is_test = 0 AND e.plan = 'pro') e
  ON e.updated_at < (CAST(strftime('%s', d.day) AS INTEGER) + 86400) * 1000
 AND (e.period_end IS NULL OR e.period_end > (CAST(strftime('%s', d.day) AS INTEGER) + 86400) * 1000)
GROUP BY d.day;

-- Money in from Creem: one row per paid subscription period, a negative one per refund. Kept for good (billing_events
-- goes after 30 days and has no amounts). amount: cents, the product's price; mode: test (sandbox key) | live.
CREATE TABLE payments (
  id         TEXT PRIMARY KEY,   -- Creem's tran_… (paid) or ref_… (refund)
  user_id    TEXT,               -- null when the event named no account we know
  kind       TEXT NOT NULL,      -- paid | refund
  product    TEXT,
  amount     INTEGER NOT NULL,
  currency   TEXT NOT NULL,
  mode       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_at ON payments (created_at);
