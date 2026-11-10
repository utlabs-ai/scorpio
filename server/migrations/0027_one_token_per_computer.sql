-- One live token per computer: from now on a new token for a computer revokes its
-- older ones (device.ts deviceToken). The ones from before: for each account and device id, every live token but the
-- newest is revoked now. Data only; tokens with no device id (from before 10-04) are left alone.
UPDATE agent_tokens SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE revoked_at IS NULL AND device_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM agent_tokens n
      WHERE n.user_id = agent_tokens.user_id AND n.device_id = agent_tokens.device_id AND n.revoked_at IS NULL
        AND (n.created_at > agent_tokens.created_at OR (n.created_at = agent_tokens.created_at AND n.id > agent_tokens.id))
   );
