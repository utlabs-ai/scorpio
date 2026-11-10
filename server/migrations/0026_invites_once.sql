-- Single-use invite codes. Each code is one inviter's and is used
-- once, by one new account. An account has at most one code not used yet (its current invite); a new one is drawn
-- when it is needed again and the month's invites are not all used. users.invite_code (0025) is no longer written:
-- an account's fixed code becomes its first code here the first time it is looked at (invite.ts collectFixed).
CREATE TABLE invites (
  code TEXT PRIMARY KEY,     -- 6 characters of 23456789ABCDEFGHJKLMNPQRSTUVWXYZ, upper case
  inviter_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_by TEXT,              -- the new account that signed up with it (or entered it within 7 days)
  used_at INTEGER
);
CREATE INDEX invites_inviter ON invites (inviter_id, used_at);
CREATE UNIQUE INDEX invites_one_open ON invites (inviter_id) WHERE used_at IS NULL;
-- This month's used invites are counted from users (invited_by, invited_at >= the 1st, UTC).
CREATE INDEX users_invited_month ON users (invited_by, invited_at);
