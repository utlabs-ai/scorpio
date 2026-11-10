-- Plans: which accounts are on Pro. No row, or one that has run out, is the free plan.
-- provider: creem (a subscription, written by its webhook) or comp (given by hand).
CREATE TABLE entitlements (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  plan            TEXT NOT NULL DEFAULT 'free',   -- free | pro
  status          TEXT NOT NULL DEFAULT 'active', -- active | canceled | past_due ...; only active counts
  period_end      INTEGER,                        -- ms; null = no end (comp)
  provider        TEXT NOT NULL DEFAULT 'comp',   -- creem | comp
  customer_id     TEXT,
  subscription_id TEXT,
  updated_at      INTEGER NOT NULL
);

-- Messages in the rooms an account owns, per UTC day: the Pro daily cap across rooms. Rooms report what
-- they counted every few messages, so this runs a little behind.
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,                -- YYYY-MM-DD (UTC)
  msgs    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Alerts for the people running the service (an account at its daily cap, a room's database over 1 GB):
-- one per kind and subject a day; the row is the record, a push goes to OPS_ACCOUNTS.
CREATE TABLE alerts (
  kind       TEXT NOT NULL,               -- account_day | room_db
  subject    TEXT NOT NULL,               -- an account handle or a room id
  day        TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject, day)
);
