// The two queries behind the left column, kept free of imports so the tests can run them on node:sqlite.

/** Topics I own, am in, or visited while they are still public; with my pin. ?1 = my user id. */
export const VISIBLE_TOPIC_SQL = `(r.owner_id = ?1 OR rm.active = 1 OR (rm.user_id IS NOT NULL AND r.visibility = 'link'))`;

export const MY_TOPICS_SQL = `SELECT r.id, r.name, r.topic, r.owner_id = ?1 AS owned, rm.active AS active, r.archived_at, r.archived_reason, p.pinned_at
  FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?1 LEFT JOIN pins p ON p.room_id = r.id AND p.user_id = ?1
  WHERE ${VISIBLE_TOPIC_SQL} AND r.status IN ('active', 'archived')
  ORDER BY r.created_at DESC LIMIT 200`;

/** A topic I may pin: currently visible to me, not deleted. ?1 = my user id, ?2 = the topic. */
export const CAN_SEE_SQL = `SELECT 1 AS ok FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?1
  WHERE r.id = ?2 AND r.status IN ('active', 'archived') AND ${VISIBLE_TOPIC_SQL}`;
