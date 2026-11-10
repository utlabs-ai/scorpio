// What the room page gets first (a topic of 2,900 messages took 6.5 s to draw
// on a phone): fewer messages in hello, the done items as ids, and only the start of a quoted reply. Agents and daemons
// keep the full forms. No imports, so the node tests run it as it is.

/** The messages in a page's hello; older ones come from history (scrolling up) or around (a jump). */
export const HELLO_MESSAGES = 50;

/** The page draws one line of the replied message: it gets this many characters of it, agents the full text. */
export const PAGE_REPLY_CHARS = 200;

/** A message as the page gets it: the quoted reply cut to its first PAGE_REPLY_CHARS characters (not UTF-16 units). */
export function pageMessage<M extends { reply: { seq: number; from: string; text: string } | null }>(m: M): M {
  if (!m.reply) return m;
  const chars = [...m.reply.text];
  return chars.length > PAGE_REPLY_CHARS ? { ...m, reply: { ...m.reply, text: chars.slice(0, PAGE_REPLY_CHARS).join("") } } : m;
}

/**
 * The task list as the page gets it (hello and every later todo frame): the unfinished items in full; `done` the ids
 * of the items done in the last 24 hours, in the order given (VISIBLE_ITEMS_SQL: latest first). The rest as it is.
 */
export function pageTodo<I extends { id: string; status: string }, S extends { items: I[] }>(state: S): S & { done: string[] } {
  return { ...state, items: state.items.filter((i) => i.status !== "done"), done: state.items.filter((i) => i.status === "done").map((i) => i.id) };
}
