-- Pro trial cards: one use per code and per account in a batch.
CREATE TABLE trial_batches (
  id TEXT PRIMARY KEY,
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 365),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 500),
  note TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE trial_codes (
  code TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES trial_batches(id),
  created_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);
CREATE INDEX trial_codes_batch ON trial_codes (batch_id, used_at);
CREATE UNIQUE INDEX trial_codes_one_per_batch ON trial_codes (batch_id, used_by) WHERE used_by IS NOT NULL;
