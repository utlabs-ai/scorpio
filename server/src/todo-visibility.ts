/** The TODO list keeps completed items for a rolling day; storage and search retain older ones. */
export const VISIBLE_DONE_MS = 24 * 60 * 60_000;

export const VISIBLE_ITEMS_SQL = `SELECT * FROM items WHERE status IN ('todo', 'doing') OR (status = 'done' AND done_ms >= ?)
  ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
           CASE WHEN status = 'done' THEN -COALESCE(done_ms, updated_ms) ELSE n END`;

export const VISIBLE_COUNTS_SQL = "SELECT status, COUNT(*) AS k FROM items WHERE status IN ('todo', 'doing') OR (status = 'done' AND done_ms >= ?) GROUP BY status";
