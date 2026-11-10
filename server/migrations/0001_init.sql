-- Accounts, identities, agent tokens, device authorization, rooms.
-- Fields marked as reserved exist for later features and only carry defaults today.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,          -- account name; member names are built from it
  primary_email TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL
);

CREATE TABLE identities (
  provider   TEXT NOT NULL,                    -- google | github
  subject    TEXT NOT NULL,                    -- the provider's stable user id
  email      TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE agent_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  hash         TEXT NOT NULL UNIQUE,           -- sha-256 of the token; the token itself is only on the device
  device_name  TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'agent',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  issued_for   TEXT NOT NULL DEFAULT 'local'   -- reserved: local | cloud
);
CREATE INDEX agent_tokens_user ON agent_tokens(user_id);

CREATE TABLE device_codes (
  id           TEXT PRIMARY KEY,               -- sha-256 of device_code
  user_code    TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL,                  -- pending | approved | denied | redeemed
  user_id      TEXT REFERENCES users(id),      -- set on approval
  device_name  TEXT NOT NULL,
  cli_version  TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  interval     INTEGER NOT NULL,
  last_poll_at INTEGER
);
CREATE INDEX device_codes_expires ON device_codes(expires_at);

CREATE TABLE rooms (
  id         TEXT PRIMARY KEY,                 -- random, not enumerable
  owner_id   TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  topic      TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',  -- private | link
  status     TEXT NOT NULL DEFAULT 'active',   -- active | folded | archived | dissolved
  created_at INTEGER NOT NULL
);
CREATE INDEX rooms_owner ON rooms(owner_id, status);
