// Deleting an account: the SQL, kept apart from account-delete.ts with no imports so
// the node tests can run it on node:sqlite. ?1 is always the user id.

/** The days in which ops can undo a deletion; then the account's files, identities and usage rows go. */
export const RESTORE_DAYS = 7; // the default; config:retention.accountRestoreDays changes it (retention.ts)

/** What the ops page lists before anything is deleted. */
export const PREVIEW_SQL = {
  user: "SELECT id, handle, primary_email AS email, created_at, deleted_at, deleted_email, purged_at FROM users WHERE handle = ?1",
  topics: "SELECT id, name, status FROM rooms WHERE owner_id = ?1 AND status != 'deleted' ORDER BY created_at",
  // Files charged to the account; `elsewhere`: those in topics other people created (they go after the 7 days).
  files:
    "SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes, COALESCE(SUM(CASE WHEN r.owner_id IS NULL OR r.owner_id != ?1 THEN 1 ELSE 0 END), 0) AS elsewhere " +
    "FROM account_files a LEFT JOIN rooms r ON r.id = a.room_id WHERE a.user_id = ?1",
  tokens: "SELECT COUNT(*) AS n FROM agent_tokens WHERE user_id = ?1 AND revoked_at IS NULL",
  devices: "SELECT COUNT(*) AS n FROM devices WHERE user_id = ?1",
  push: "SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1",
  drive: "SELECT email, token_enc IS NOT NULL AS connected FROM drive_links WHERE user_id = ?1",
  creem: "SELECT subscription_id, period_end, canceled_at FROM entitlements WHERE user_id = ?1 AND provider = 'creem' AND status = 'active'",
  // Topics other people created where the account has someone (it is taken off their member lists).
  joined: "SELECT m.room_id FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ?1 AND r.owner_id != ?1 AND r.status != 'deleted'",
} as const;

/**
 * First, before anything is deleted: the row becomes a tombstone (?2 = now), which sign-in,
 * sessions, agent tokens and device approval all refuse, its tokens are revoked, and its devices, pending device codes and push go.
 * The entitlement stays, cancelled, so a later refund still finds the account by its subscription. Identities, file
 * space and usage rows stay for the 7 days (undo).
 */
export const ACCESS_SQL = [
  "UPDATE users SET deleted_at = ?2, deleted_email = primary_email, primary_email = 'deleted:' || id, display_name = NULL WHERE id = ?1 AND deleted_at IS NULL",
  // revoked, not deleted, so its computers are told why; the rows go with the purge
  "UPDATE agent_tokens SET revoked_at = ?2, revoked_reason = 'revoked' WHERE user_id = ?1 AND revoked_at IS NULL",
  "DELETE FROM devices WHERE user_id = ?1",
  "DELETE FROM device_codes WHERE user_id = ?1",
  "DELETE FROM push_muted_rooms WHERE endpoint IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ?1)",
  "DELETE FROM push_subscriptions WHERE user_id = ?1",
  "DELETE FROM push_test_limits WHERE user_id = ?1",
  "DELETE FROM calendar_tokens WHERE user_id = ?1", // the calendar address stops answering at once (it is a credential)
  "UPDATE entitlements SET status = 'canceled', canceled_at = COALESCE(canceled_at, ?2), updated_at = ?2 WHERE user_id = ?1 AND status != 'canceled'",
] as const;

/** Then, after its topics are deleted and it has left the others: its Drive rows (the authorization revoked at Google first). */
export const DRIVE_ROWS_SQL = [
  "DELETE FROM drive_files WHERE user_id = ?1",
  "DELETE FROM drive_rooms WHERE user_id = ?1",
  "DELETE FROM drive_links WHERE user_id = ?1",
] as const;

/**
 * What a deletion still has to do: topics it created that are not deleted yet, topics it is still listed in (a
 * row goes only once that topic has taken it off), a Drive link. The ops page shows them; the daily job retries them.
 */
export const LEFTOVER_SQL = {
  // A topic marked deleted whose deletion was cut short (purge_pending) is finished too.
  topics: "SELECT id FROM rooms WHERE owner_id = ?1 AND (status != 'deleted' OR purge_pending = 1) ORDER BY created_at",
  // `gone`: a topic deleted or never in D1, whose object has nothing to take it off.
  joined:
    "SELECT m.room_id, (r.id IS NULL OR r.status = 'deleted') AS gone FROM room_members m LEFT JOIN rooms r ON r.id = m.room_id " +
    "WHERE m.user_id = ?1 AND (r.owner_id IS NULL OR r.owner_id != ?1) ORDER BY m.room_id",
  drive: "SELECT 1 AS x FROM drive_links WHERE user_id = ?1",
} as const;

// Of a users row `u`: a topic it created is not deleted yet, it is still listed in someone else's topic, or Drive is linked.
const UNFINISHED =
  "(EXISTS (SELECT 1 FROM rooms r WHERE r.owner_id = u.id AND (r.status != 'deleted' OR r.purge_pending = 1)) OR " +
  "EXISTS (SELECT 1 FROM room_members m LEFT JOIN rooms r ON r.id = m.room_id WHERE m.user_id = u.id AND (r.owner_id IS NULL OR r.owner_id != u.id)) OR " +
  "EXISTS (SELECT 1 FROM drive_links d WHERE d.user_id = u.id))";

/** Deleted accounts with something left to do (no purge before it is done); the least recently tried first, so a few that keep failing do not hold up the rest. */
export const UNFINISHED_SQL = `SELECT id, handle FROM users u WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND ${UNFINISHED} ORDER BY COALESCE(deletion_tried_at, 0), deleted_at LIMIT 20`;

/**
 * Only one request deletes an account (a second tap two seconds later once cut the first one short): it
 * takes the account (?2 = now) unless another request took it in the last minute (?3 = now minus that minute). The
 * answer to the other one is the account's state. A deletion that stops before access went (Creem refused) lets go.
 */
export const CLAIM_SQL = "UPDATE users SET deletion_tried_at = ?2 WHERE id = ?1 AND deleted_at IS NULL AND (deletion_tried_at IS NULL OR deletion_tried_at < ?3)";
export const UNCLAIM_SQL = "UPDATE users SET deletion_tried_at = NULL WHERE id = ?1 AND deleted_at IS NULL";

/** The daily job tried this account (?2 = now). */
export const TRIED_SQL = "UPDATE users SET deletion_tried_at = ?2 WHERE id = ?1";

/**
 * Undo within the 7 days: the person can sign in again (identities are still there) and the files stay. The e-mail
 * comes back unless another account took it meanwhile. Deleted topics, tokens and the subscription do not.
 */
export const RESTORE_SQL =
  "UPDATE users SET deleted_at = NULL, primary_email = CASE WHEN NOT EXISTS (SELECT 1 FROM users o WHERE o.primary_email = users.deleted_email) THEN deleted_email ELSE primary_email END, " +
  "deleted_email = NULL, deletion_tried_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL AND purged_at IS NULL";

/** Accounts whose 7 days are over (?1 = the cutoff: now minus the 7 days), once nothing is left to do; the least recently tried first. */
export const PURGE_DUE_SQL = `SELECT id, handle FROM users u WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at < ?1 AND NOT ${UNFINISHED} ORDER BY COALESCE(deletion_tried_at, 0), deleted_at LIMIT 20`;

/** The files of such an account, by topic, to evict (the topics it created are long gone with theirs). */
export const PURGE_FILES_SQL = "SELECT room_id, file_id FROM account_files WHERE user_id = ?1 ORDER BY room_id LIMIT 2000";

/**
 * One topic's chunk of those files, once evicted there (?1 the account, ?2 the topic, ?3… the files): out of the
 * account index, and their own pages (/v/<fileId>, D1 file_rooms) gone too, so a deleted account's file is not
 * found rather than shown as cleared for space.
 */
export const purgeChunkSql = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `?${i + 3}`).join(",");
  return [`DELETE FROM account_files WHERE user_id = ?1 AND room_id = ?2 AND file_id IN (${ids})`, `DELETE FROM file_rooms WHERE room_id = ?2 AND file_id IN (${ids})`];
};

/**
 * Last, once its files are gone (?2 = now). The tombstone keeps only the handle and the times. Its pins on other
 * people's topics go here, not with access: an undo within the 7 days gets its list back as it was; the pins on its own
 * topics went with them (purgeRoomNow).
 */
export const PURGE_SQL = [
  "DELETE FROM identities WHERE user_id = ?1",
  "DELETE FROM agent_tokens WHERE user_id = ?1",
  "DELETE FROM account_files WHERE user_id = ?1",
  "DELETE FROM storage_usage WHERE user_id = ?1",
  "DELETE FROM upload_usage WHERE user_id = ?1",
  "DELETE FROM usage_daily WHERE user_id = ?1",
  "DELETE FROM activity_daily WHERE user_id = ?1",
  "DELETE FROM room_members WHERE user_id = ?1",
  "DELETE FROM pins WHERE user_id = ?1",
  "UPDATE users SET purged_at = ?2, deleted_email = NULL WHERE id = ?1",
] as const;

/** The values one of these statements takes: as many as its highest ?N (D1 and node:sqlite refuse extra ones). */
export function bindFor(sql: string, ...values: unknown[]): unknown[] {
  const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return values.slice(0, n);
}
