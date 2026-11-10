-- Calendar subscription (docs/api/schedules.md, Into a calendar): one token per account, part of its feed address.
-- Made when the person first opens the settings row, replaced by a reset, deleted with the account.
CREATE TABLE calendar_tokens (
  user_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
