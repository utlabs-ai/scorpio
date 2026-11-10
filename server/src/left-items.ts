// Nobody who left is on anything (docs/api/tasks.md, Leaving): when names stop being in the
// topic, the room sets their doing items back to todo in the same step. The assignee and blocked_by stay. No imports, so
// the node tests run the SQL as it is.

/** The doing items under these names; ?1 a JSON array of names. */
export const LEFT_DOING_SQL = "SELECT n FROM items WHERE status = 'doing' AND assignee IN (SELECT value FROM json_each(?1)) ORDER BY n";

/** One of them back to todo: ?1 n, ?2 who did it (the actor of the leave), ?3 when. */
export const LEFT_TODO_SQL = "UPDATE items SET status = 'todo', updated_by = ?2, updated_ms = ?3 WHERE n = ?1 AND status = 'doing'";
