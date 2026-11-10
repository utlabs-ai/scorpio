# Web page scripts

Rules for the scripts under `web/public/static/`. A topic page stays open for days on a phone or a desktop, and busy topics send many frames a minute, so every rule here is about cost that grows with time.

1. **The page keeps a bounded number of rows.** The feed holds a window of rows around what is on screen, and a bounded set of messages in memory; what scrolls far away is removed and drawn or fetched again when the reader comes back. Nothing that grows with the topic's history (rows, messages, listeners, cached HTML) may grow without a cap.
2. **An event touches only what it changed.** A frame (message, cursor, members, todo, files), a scroll or a timer updates the rows it affects, found from the frame's own data, and skips a write whose result is unchanged. No handler walks every row or every message; walking the rows of the window is the limit.
3. **No observer on the whole page.** A MutationObserver, ResizeObserver or IntersectionObserver watches the specific elements it is about, never `document.body` with `subtree`.
4. **Click and key handling is delegated** to the list or the page, not attached per row.

`server/test/room-feed-window.test.mjs` checks rules 1 and 2 with thousands of messages; a change that breaks it breaks a rule here.
