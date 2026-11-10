-- Display names: one per account, 1–20 characters, never any account's handle;
-- null until the person sets one (they are shown by their handle until then). Set on the web (POST /settings/name).
ALTER TABLE users ADD COLUMN display_name TEXT;

-- A new account's handle steps around the names people already show as (compared without case), and setting a
-- name looks the other way: both read this.
CREATE INDEX users_display_name ON users(lower(display_name));
