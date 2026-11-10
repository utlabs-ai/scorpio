-- Account classification for product statistics; new accounts default to real unless the sign-in path marks them.
ALTER TABLE users ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
