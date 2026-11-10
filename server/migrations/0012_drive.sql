-- Backup to the person's own Google Drive: personal, not storage — the files stay in R2.

-- What each indexed file is, for its copy: the bytes (sha-256: one copy per distinct file) and the name it was uploaded
-- with. Written on upload; rows from before are filled from their rooms the first time a backup needs them.
ALTER TABLE account_files ADD COLUMN hash TEXT;
ALTER TABLE account_files ADD COLUMN name TEXT;

-- A person's connected Drive. token_enc is the refresh token, AES-GCM with the Worker secret DRIVE_TOKEN_KEY; it is
-- set to null the moment they disconnect (the row stays: what was copied where, for when they reconnect the same Drive).
CREATE TABLE drive_links (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  email          TEXT NOT NULL,      -- the Google account whose Drive it is
  token_enc      TEXT,               -- null: not connected
  folder_id      TEXT,               -- the Scorpio folder in that Drive (made by the first run)
  connected_at   INTEGER NOT NULL,
  last_backup_at INTEGER,            -- the last run that finished: every file copied, every room's export current
  wanted_at      INTEGER,            -- 「立即备份」 asked for a run since then (null: none asked)
  error          TEXT,               -- why backups stopped: revoked | full | folder_gone (null: going)
  error_at       INTEGER,
  running_until  INTEGER             -- one run per account at a time
);
CREATE INDEX drive_links_due ON drive_links (last_backup_at) WHERE token_enc IS NOT NULL AND error IS NULL;

-- Files copied to that Drive, once per distinct file (by hash).
CREATE TABLE drive_files (
  user_id   TEXT NOT NULL,
  hash      TEXT NOT NULL,
  drive_id  TEXT NOT NULL,
  room_id   TEXT NOT NULL,           -- where the copy was taken from (its folder is that room's)
  copied_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, hash)
);

-- Per room in that Drive: the folder its files go to (Scorpio/<room name>/) and its Markdown export
-- (Scorpio/<room name> (<roomId>).md), rewritten when the room has moved on since md_seq. The names are the room's
-- when each was last named, so a renamed room renames them.
CREATE TABLE drive_rooms (
  user_id     TEXT NOT NULL,
  room_id     TEXT NOT NULL,
  folder_id   TEXT,
  folder_name TEXT,
  md_id       TEXT,
  md_name     TEXT,
  md_seq      INTEGER,
  PRIMARY KEY (user_id, room_id)
);
