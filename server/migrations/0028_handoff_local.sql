-- 「交接只存在 agent 的电脑上」 / Keep handoffs on agents' computers: while 1, the
-- account's agents' handoffs are not stored in the cloud (PUT answers handoff_local_only). Changed only by the person in
-- Settings (POST /settings/handoff). Reading and handoffs already stored are not affected.
ALTER TABLE users ADD COLUMN handoff_local INTEGER NOT NULL DEFAULT 0;
