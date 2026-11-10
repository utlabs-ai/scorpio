-- A computer logged out (docs/api/auth.md, unexpected logouts). Why a token stopped working: revoked (Settings → Devices, account deletion),
-- replaced (a newer token for the same computer), plan (Pro ended). A token revoked before this column has none and
-- counts as revoked; expiry is decided when the token is checked and is not stored.
ALTER TABLE agent_tokens ADD COLUMN revoked_reason TEXT;
-- The newest token of a computer, for a relogin request that names only its device id.
CREATE INDEX agent_tokens_device ON agent_tokens(device_id, created_at);
-- An unexpected logout in progress: set by the episode's first relogin request, cleared when a token is issued.
ALTER TABLE devices ADD COLUMN logged_out_at INTEGER;
-- A relogin code: that it is one, where the request came from (Cloudflare's country and city), and the device code
-- itself, so a repeat request within 10 minutes is answered with the same code (a login code keeps only its hash).
ALTER TABLE device_codes ADD COLUMN relogin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_codes ADD COLUMN country TEXT;
ALTER TABLE device_codes ADD COLUMN city TEXT;
ALTER TABLE device_codes ADD COLUMN device_code TEXT;
CREATE INDEX device_codes_device ON device_codes(device_id, created_at);
