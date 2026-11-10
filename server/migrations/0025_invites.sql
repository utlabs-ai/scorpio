-- Inviting friends: every account has one fixed invite code.
-- A new account that came by it records who invited it; when the friend's agent first joins a topic from a computer no
-- other account has used, the inviter gets 7 days of Pro (at most 5 a calendar month, UTC). Given days are kept apart:
-- banked while the inviter is on Pro, started otherwise.
ALTER TABLE users ADD COLUMN invite_code TEXT;          -- 6 characters of 23456789ABCDEFGHJKLMNPQRSTUVWXYZ, stored upper case; given on first need
ALTER TABLE users ADD COLUMN invited_by TEXT;           -- the inviter's user id
ALTER TABLE users ADD COLUMN invited_at INTEGER;
ALTER TABLE users ADD COLUMN invite_rewarded_at INTEGER; -- when the friend's use was judged (once)
ALTER TABLE users ADD COLUMN invite_reward TEXT;        -- granted | capped | none
ALTER TABLE users ADD COLUMN invite_eligible INTEGER;   -- 1: a new account whose e-mail and sign-in were checked unseen; only these take an invite
CREATE UNIQUE INDEX users_invite_code ON users (invite_code);
CREATE INDEX users_invited_by ON users (invited_by);

-- Given Pro days: balance = grants − uses − revokes. ref: the friend's user id, the entitlement it started, or a note.
CREATE TABLE invite_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,     -- grant | use | revoke
  days INTEGER NOT NULL,
  ref TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX invite_ledger_user ON invite_ledger (user_id, kind, at);
-- One grant per friend, whatever races (the reward is decided once).
CREATE UNIQUE INDEX invite_ledger_one_grant ON invite_ledger (user_id, ref) WHERE kind = 'grant';

-- E-mail addresses that ever had an account (keyed hash; never deleted, not by account deletion either): only an address
-- never seen counts as a new account for an invite.
-- Both the address as given and its canonical form (no +tag; Gmail without dots) are kept.
CREATE TABLE seen_emails (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
-- Sign-in identities (provider and its account id, keyed hash) that ever made an account: one Google or GitHub account
-- is a new account once.
CREATE TABLE seen_identities (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);

-- Computers by a keyed hash of their machine id, and the first account that got a token on each (never changed or deleted).
CREATE TABLE machine_hashes (hash TEXT PRIMARY KEY, first_user_id TEXT NOT NULL, first_seen INTEGER NOT NULL);
ALTER TABLE device_codes ADD COLUMN machine_hash TEXT;
ALTER TABLE devices ADD COLUMN machine_hash TEXT;

-- The ops page's daily Pro count by source gets the invite days (ops-data.ts PRO_SNAPSHOT_SQL).
ALTER TABLE pro_daily ADD COLUMN invite INTEGER NOT NULL DEFAULT 0;
