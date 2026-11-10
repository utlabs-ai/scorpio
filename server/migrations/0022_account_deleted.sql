-- Deleting an account. The row stays as a tombstone so its handle is never given
-- out again; its e-mail moves to deleted_email for the 7 days in which ops can undo the deletion, and goes after.
-- purged_at: the 7 days are over and the account's files, identities and usage rows are gone.
-- deletion_tried_at: the daily job's last go at what its deletion left, or at its purge; the least recent goes first.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE users ADD COLUMN deleted_email TEXT;
ALTER TABLE users ADD COLUMN purged_at INTEGER;
ALTER TABLE users ADD COLUMN deletion_tried_at INTEGER;
CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;
