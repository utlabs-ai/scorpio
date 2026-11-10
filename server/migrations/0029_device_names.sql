ALTER TABLE devices ADD COLUMN name TEXT;
ALTER TABLE devices ADD COLUMN note TEXT;
ALTER TABLE devices ADD COLUMN machine TEXT;
ALTER TABLE devices ADD COLUMN seat TEXT;
CREATE UNIQUE INDEX devices_seat ON devices(user_id, seat);
