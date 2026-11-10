-- A full refund takes back what it paid for: refunded_at is when the subscription's Pro was ended by a
-- refund, so a later cancel or expiry of that same subscription cannot give the paid time back. A renewing write or
-- another subscription clears it.
ALTER TABLE entitlements ADD COLUMN refunded_at INTEGER;
