-- Devices: a computer as the account knows it. device_id is random, made by the Scorpio package the
-- first time it is set up on a computer (~/.scorpio/config.json), sent with device authorization and
-- with the daemon's join; a new token for the same computer keeps the same device. The hostname is
-- only for display.
-- daemon_no: the computer's daemon seat, given the first time it runs a daemon, in the account's
-- order and never reused (1 is the seat "daemon", n >= 2 is "daemon-n").
CREATE TABLE devices (
  user_id     TEXT NOT NULL REFERENCES users(id),
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL,
  daemon_no   INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE UNIQUE INDEX devices_daemon_no ON devices(user_id, daemon_no);

ALTER TABLE device_codes ADD COLUMN device_id TEXT;
ALTER TABLE agent_tokens ADD COLUMN device_id TEXT;
