-- When a Creem subscription was canceled: it still runs to the end of the paid period, and the pricing and
-- settings pages say it will not renew. Null while it renews (and for trial and comp grants).
ALTER TABLE entitlements ADD COLUMN canceled_at INTEGER;

-- Subscriptions canceled before this column existed: the last event the webhook handled for them was a cancel.
UPDATE entitlements SET canceled_at = (
  SELECT b.created_at FROM billing_events b WHERE b.user_id = entitlements.user_id ORDER BY b.created_at DESC LIMIT 1
)
WHERE provider = 'creem' AND (
  SELECT b.type FROM billing_events b WHERE b.user_id = entitlements.user_id ORDER BY b.created_at DESC LIMIT 1
) IN ('subscription.canceled', 'subscription.scheduled_cancel', 'subscription.expired');
