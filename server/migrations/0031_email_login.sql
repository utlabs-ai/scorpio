-- Email-code sign-in. D1 is the only authority for codes and send limits.
CREATE TABLE email_login_challenges (
  flow_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  next TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_expires_at INTEGER NOT NULL,
  flow_expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'replaced', 'consumed')),
  replaced_by TEXT,
  sent_at INTEGER,
  send_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX email_login_active_email ON email_login_challenges(email_key) WHERE state = 'active';
CREATE INDEX email_login_expiry ON email_login_challenges(flow_expires_at);

CREATE TABLE email_login_sends (
  id TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'failed')),
  provider_id TEXT,
  failure_category TEXT
);
CREATE INDEX email_login_sends_email ON email_login_sends(email_key, sent_at);
CREATE INDEX email_login_sends_ip ON email_login_sends(ip_key, sent_at);
CREATE INDEX email_login_sends_day ON email_login_sends(day, state);
