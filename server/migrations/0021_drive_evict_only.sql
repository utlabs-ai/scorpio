-- Drive takes only the files a full space is about to clear: no daily backup of every file,
-- no Markdown export of the rooms, no 「立即备份」. What a person's Drive already holds stays there, untouched.

-- The daily run's due list and its bookkeeping go.
DROP INDEX IF EXISTS drive_links_due;
ALTER TABLE drive_links DROP COLUMN wanted_at;
ALTER TABLE drive_links DROP COLUMN last_backup_at;

-- What the settings page shows instead: the last time files were copied before they went, and how many.
ALTER TABLE drive_links ADD COLUMN last_copy_at INTEGER;
ALTER TABLE drive_links ADD COLUMN last_copy_count INTEGER;

-- The rooms' Markdown exports (their files in Drive stay; nothing rewrites them any more). The room folders stay.
ALTER TABLE drive_rooms DROP COLUMN md_id;
ALTER TABLE drive_rooms DROP COLUMN md_name;
ALTER TABLE drive_rooms DROP COLUMN md_seq;

-- drive_files stays as it is: a file already copied (by an eviction, or by a daily run before this) is not copied again.
