-- Paying for Pro through Creem. A Pro that lapses archives every active room of
-- its owner but the one with the latest message, marked so that subscribing again brings them back; a room the owner
-- archived or restored by hand loses the mark.
ALTER TABLE rooms ADD COLUMN archived_reason TEXT;  -- null (by its owner) | downgrade

-- When the rooms were archived for this lapse (null while Pro, or before it lapsed): the daily job downgrades a Pro
-- whose paid period ran out with no webhook to say so, once.
ALTER TABLE entitlements ADD COLUMN downgraded_at INTEGER;

-- One row per Creem webhook event handled, so a retried delivery does nothing twice; kept 30 days.
CREATE TABLE billing_events (
  id         TEXT PRIMARY KEY,   -- Creem's evt_…
  type       TEXT NOT NULL,
  user_id    TEXT,
  created_at INTEGER NOT NULL    -- when Creem made it (ms)
);
