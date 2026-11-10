// The message feed on the topic page: the row and its hooks, the list, history and jumps, read state, the message menu
// and its hooks, selection, the link menu, and the listeners on the feed.
(function () {
  "use strict";

  // The window (docs/web.md rule 1): the page holds a contiguous slice of rows around what is on screen, and memory a
  // bounded slice of messages around them; what lies beyond is drawn again from memory, or fetched, when the reader comes.
  var ROWS = 200, ROWS_MAX = 260;   // rows on the page: trimmed back to ROWS once they pass ROWS_MAX
  var MSGS = 800, MSGS_MAX = 1000;  // messages in memory (and in the held latest feed): likewise
  var STEP = 50;                    // rows drawn from memory at a time when the reader reaches an edge of the window
  var EDGE = 300;                   // px from the top or bottom where scrolling reaches for more

  window.createRoomFeed = function (ctx) {
    var $ = ctx.$, RECEIPT = ctx.RECEIPT, S = ctx.S, arrived = ctx.arrived, boot = ctx.boot, callBack = ctx.callBack, canWrite = ctx.canWrite, copy = ctx.copy, editSend = ctx.editSend, feed = ctx.feed, fill = ctx.fill, flash = ctx.flash, openItem = ctx.openItem, openPanel = ctx.openPanel, openSchedule = ctx.openSchedule, outEl = ctx.outEl, outbox = ctx.outbox, ownerOf = ctx.ownerOf, panels = ctx.panels, placeInvite = ctx.placeInvite, placeOutbox = ctx.placeOutbox, post = ctx.post, retrySend = ctx.retrySend, setReply = ctx.setReply, shownName = ctx.shownName, state = ctx.state, toast = ctx.toast, updateChips = ctx.updateChips, viewer = ctx.viewer;
    // The feed's setters for the messages, bySeq, cursor and mentionUnread (room-store.js): only the feed writes them.
    // Each is read when it is called, so a feed made without them (the goldens) still draws.
    var writeFeed = ctx.writeFeed;
    // ctx.overlayChanged (room-overlay-history.js's changed()): select mode is a phone overlay with no element of its
    // own, so the feed says when it starts and ends. Read when called, like writeFeed.
    // The feed's own read state.
    var firstLoad = true;
    var oldest = null;        // the earliest seq in memory; 1 or null when there is nothing earlier
    var dividerAt = null;     // seq the "unread" line sits above (0: none), fixed when the page first loads
    var firstUnread = null;   // when I last read before the page's first message: where 「↑ 第一条未读」 goes
    // "↓ N new": how many arrived below while the reader was away from the latest, how many of them for me, and the
    // highest seq counted (seqs only grow, so nothing is counted twice).
    var newBelow = 0, newForMe = 0, newTo = 0;
    // The rows on the page: the messages from win.first to win.last (seqs; null with none), every one of them drawn.
    var win = { first: null, last: null };
    var pos = new Map();      // seq → its index in state.messages
    reindex();
    var formeRows = [];       // the seqs of the window's rows for me, in order (只看 @我 reads them, not the rows)
    // What the reader did to a row, kept by seq so a row drawn again shows it the same way.
    var unfolded = new Set(); // long messages opened with 展开全文
    var nowrap = new Map();   // seq → the indexes of its code blocks with wrapping turned off
    // Message times: every row has its time, hidden but for about one a screen. seq → shown or not,
    // decided once from where the rows sit and kept, so a row drawn again or back in the window shows the same.
    var timeShown = new Map(), timeWidth = null;

    // ---------- row hooks: what other domains add to a message ----------
    // Each slot has one owner. The feed fixes where each goes, whatever order the factories register in; an empty
    // slot adds nothing. systemText(ev): a system line's text, before the feed's own. chips(m), card(m): inside the
    // body, after the text, in that order. buttons, schedule, todo, notes (m, row): the foot, in that order. receipt(m):
    // {phase, label} for a read line not yet read. notesRedraw(m, el): delivery notes drawn again when the read lines
    // refresh. drawn(m, el): a message's row was just made (not yet on the page), for what watches its own elements.
    // buttonsChanged(m, el): only who chose which button changed; true when the row's buttons were redrawn in place.
    var hooks = {}, FOOT = ["buttons", "memo", "schedule", "todo", "notes"];
    function rowHook(slot, fn) {
      if (hooks[slot]) throw new Error("row hook " + slot + " is already registered");
      hooks[slot] = fn;
    }
    function hook(slot, a, b) {
      return hooks[slot] ? hooks[slot](a, b) : "";
    }

    function names() {
      return new Set(state.members.map(function (m) { return m.name; }));
    }
    function fmtTime(ts) {
      var d = new Date(ts), now = new Date();
      var hm = d.toLocaleTimeString(boot.lang === "zh" ? "zh-CN" : undefined, { hour: "2-digit", minute: "2-digit" });
      if (d.toDateString() === now.toDateString()) return hm;
      return d.toLocaleDateString(boot.lang === "zh" ? "zh-CN" : undefined, { month: "numeric", day: "numeric" }) + " " + hm;
    }
    /** The full time atop a message's menu: 11月2日 周一 11:04, Mon, Nov 2, 11:04 AM; the year when it is not this year's. */
    function fullTime(ts) {
      var d = new Date(ts), loc = boot.lang === "zh" ? "zh-CN" : "en"; // the page's language, not the browser's
      var year = d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined;
      var hm = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
      if (boot.lang === "zh") return d.toLocaleDateString(loc, { year: year, month: "long", day: "numeric" }) + " " + d.toLocaleDateString(loc, { weekday: "short" }) + " " + hm;
      return d.toLocaleDateString(loc, { weekday: "short", year: year, month: "short", day: "numeric" }) + ", " + hm;
    }
    /** The tag after a name: only daemons get one; an agent is shown by its robot in front of the name. */
    function kindLabel(k) {
      return k === "host" ? "host" : "";
    }
    function avatar(m) {
      if (m.fromKind === 'scheduled') return '<span class="pav sched-av" aria-hidden="true"><span class="ic-clock"></span></span>';
      if (m.fromKind === 'agent') return botStill(m.from, '', 's16'); // drawn once, never changes
      if (m.fromKind === 'host') return daemonSvg('', 's16');
      if (m.fromKind === 'human') {
        var member = state.members.find(function (x) { return x.name === m.from; });
        var name = m.displayName || (member && member.displayName) || (m.from === state.me && boot.meDisplayName) || m.from;
        return '<span class="pav' + (m.from === state.me ? ' me' : '') + '">' + escapeHtml(name.slice(0, 1).toLowerCase()) + '</span>';
      }
      return '';
    }

    function validMentions(m) {
      if (!m.validMentions) m.validMentions = renderMarkdown.mentionedNames(m.text, new Set(m.mentions || []));
      return m.validMentions;
    }
    /** Addressed to me: an @ to me, or someone else's @ to one of my agents (it is not woken; I am told instead). */
    function mentionsMe(m) {
      if (m.fromKind === "system" || m.from === state.me) return false;
      var mentioned = validMentions(m);
      if (mentioned.indexOf(state.me) >= 0) return true;
      return mentioned.some(function (n) { return n !== state.me && ownerOf(n) === state.me; }) && ownerOf(m.scheduled && m.scheduled.by || m.from) !== state.me;
    }
    function forMe(m) {
      return (m.broadcast && m.fromKind !== "system" && m.from !== state.me) || mentionsMe(m);
    }
    // Read receipts, counted only for the people a message is for: everyone @'d, or for a broadcast
    // everyone in the room. Unread names are listed, read ones are not: the question is who has not seen it.
    function readersOf(m) {
      if (viewer) return { total: 0, read: 0, unread: [] };
      var audience = m.broadcast
        ? state.members.filter(function (x) { return x.status === "active" && x.kind !== "host"; })
        : state.members.filter(function (x) { return validMentions(m).indexOf(x.name) >= 0; });
      audience = audience.filter(function (x) { return x.name !== m.from; });
      var unread = audience.filter(function (x) { return !(Number(x.cursor) >= m.seq); }).map(function (x) { return x.name; });
      return { total: audience.length, read: audience.length - unread.length, unread: unread };
    }
    function readLine(m, line) {
      if (viewer || !line) return;
      var r = readersOf(m);
      var label, phase;
      if (!r.total) { label = S.sent || S.sending; phase = "sent"; }
      if (r.total === 1) {
        label = r.unread.length ? S.unreadOne : S.readOne;
        phase = r.unread.length ? "sent" : "read";
      } else if (!r.unread.length) {
        if (r.total) { label = S.readAll; phase = "read"; }
      } else if (r.total) {
        label = fill(S.readSome, { n: r.read, total: r.total, who: r.unread.join(", ") });
        phase = "sent";
      }
      if (phase !== 'read') {
        var delivery = hook('receipt', m);
        if (delivery) { phase = delivery.phase; label = delivery.label; }
      }
      if (line.shown === phase + "\n" + label) return; // unchanged: no write
      line.shown = phase + "\n" + label;
      line.className = "rc " + phase;
      line.innerHTML = RECEIPT + '<span>' + escapeHtml(label) + '</span>';
    }
    /** After the members changed: the read lines of the window's rows, each written only when it changed. */
    function refreshReadLines() {
      feed.querySelectorAll(".msg[data-seq]").forEach(function (el) {
        var m = state.bySeq.get(Number(el.dataset.seq));
        if (m && m.fromKind !== "system") {
          readLine(m, el.querySelector(".rc"));
          if (el.querySelector('.bring')) hook('notesRedraw', m, el);
        }
      });
    }
    /** One member's cursor moved from `from` to `to`: only the window's rows between them that they are an audience of. */
    function readLinesMoved(name, from, to) {
      from = Number(from) || 0;
      to = Number(to) || 0;
      if (viewer || win.first == null || from === to) return;
      var lo = Math.max(Math.min(from, to), win.first - 1), hi = Math.min(Math.max(from, to), win.last);
      for (var i = indexAfter(lo); i < state.messages.length && state.messages[i].seq <= hi; i++) {
        var m = state.messages[i], el = m.fromKind !== "system" && $("m" + m.seq);
        if (!el) continue;
        var notes = el.querySelector('.bring');
        if (!notes && !audienceHas(m, name)) continue;
        readLine(m, el.querySelector(".rc"));
        if (notes) hook('notesRedraw', m, el);
      }
    }
    function audienceHas(m, name) {
      if (name === m.from) return false;
      if (!m.broadcast) return validMentions(m).indexOf(name) >= 0;
      return state.members.some(function (x) { return x.name === name && x.status === "active" && x.kind !== "host"; });
    }
    /** The index of the first message in memory past seq. */
    function indexAfter(seq) {
      var lo = 0, hi = state.messages.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (state.messages[mid].seq <= seq) lo = mid + 1; else hi = mid; }
      return lo;
    }
    /** A message's files changed (one went): its card is drawn again. */
    function filesChanged(seq, files) {
      var m = state.bySeq.get(seq), el = $("m" + seq);
      if (!m) return;
      m.files = files;
      if (el) swapRow(el, m);
    }
    /**
     * A message_update frame (who chose which button): the message in memory takes the new copy, and its row,
     * when the page has one, shows it: only its buttons when nothing else changed (a card's frame stays as it is),
     * else the whole row drawn again. Found by seq; nothing else is looked at (docs/web.md rule 2).
     */
    function updated(m) {
      var mine = state.bySeq.get(m.seq), el = $("m" + m.seq);
      // A message's text and card never change after it is sent; the frame's copy also lacks what the first one carried
      // (delivery), so the two are compared on what the row shows, not as a whole.
      var onlyButtons = !!mine && mine.text === m.text && JSON.stringify(mine.card || null) === JSON.stringify(m.card || null);
      if (mine) Object.assign(mine, m);
      if (heldLatest) {
        var lo = 0, hi = heldLatest.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (heldLatest[mid].seq < m.seq) lo = mid + 1; else hi = mid; }
        if (heldLatest[lo] && heldLatest[lo].seq === m.seq) Object.assign(heldLatest[lo], m);
      }
      if (el && !(onlyButtons && hook('buttonsChanged', mine, el))) swapRow(el, mine || m);
    }
    /** After my cursor moved: count what is addressed to me past it, when everything past it is in memory. */
    function recountMentions() {
      if ((oldest != null && state.cursor + 1 < oldest) || heldLatest) return;
      var n = 0;
      for (var i = indexAfter(state.cursor); i < state.messages.length; i++) if (mentionsMe(state.messages[i])) n++;
      writeFeed.mentionUnread(n);
      if (panels.kind() === "at") openPanel("at");
    }
    function lastSeq() { return state.messages.length ? state.messages[state.messages.length - 1].seq : 0; }
    function filter() { return ctx.mentionFilter && ctx.mentionFilter(); }
    function filtered() { var f = filter(); return f && f.active(); }
    /** The last row the reader can have seen at the bottom: the window's last, or its last for me with 只看 @我 on. */
    function latestShown() {
      if (!filtered()) return win.last || 0;
      return formeRows.length ? formeRows[formeRows.length - 1] : 0;
    }
    var markTimer = null;
    function maybeMark() {
      clearTimeout(markTimer);
      if (viewer || document.visibilityState !== "visible" || !nearBottom()) return;
      var last = latestShown();
      if (last <= state.cursor) return;
      markTimer = setTimeout(function () {
        if (viewer || document.visibilityState !== "visible" || !nearBottom() || latestShown() !== last) return;
        post("mark", { upTo: last }).then(function (r) {
          writeFeed.cursor(Math.max(state.cursor, r.cursor));
          recountMentions();
          updateChips();
        }).catch(function () {});
      }, 700);
    }

    // ---------- one message: a row ----------
    // No card and no bubble: an avatar column, one top line (name … #n · time · ✓), the text exactly as written, and a bottom
    // line only when something bulky hangs under it (the tasks it made, delivery notes). A hairline between rows. Every row
    // has its avatar and name, a run from one sender too (rows without them read as broken). Every row has
    // its time, hidden but for about one a screen (placeTimes), the row under the mouse and the row whose menu is open.
    // Actions: long-press on a phone, ⋯ on hover with a mouse.
    var FOLD_CHARS = 360, FOLD_LINES = 9;
    /** A sender as the row shows it: a person by nickname; an agent or a daemon by role, its account only when it is not mine. */
    function rowName(from, fromKind, displayName) {
      if (fromKind === 'scheduled' || from === 'scheduled') return escapeHtml(S.sched.seat);
      if (from === state.me) return escapeHtml(boot.meDisplayName || from);
      if (fromKind === 'human') return shownName(from, displayName);
      var at = String(from).indexOf('@');
      if (at < 0) return escapeHtml(from);
      return escapeHtml(from.slice(0, at)) + (ownerOf(from) === state.me ? '' : '<small class="acct">' + escapeHtml(from.slice(at)) + '</small>');
    }
    function rowTop(m, receipt) {
      return '<header class="fm-top"><b class="who">' + rowName(m.from, m.fromKind, m.displayName) + '</b>' +
        (m.broadcast ? '<span class="tag bc">' + S.broadcast + '</span>' : '') +
        '<span class="sp"></span><button type="button" class="seq" data-copyseq="' + m.seq + '">#' + m.seq + '</button>' +
        '<time>' + fmtTime(m.ts) + '</time>' + (receipt ? '<span class="rc"></span>' : '') +
        '<button type="button" class="dots" data-menu="' + m.seq + '" aria-haspopup="menu" aria-label="' + escapeHtml(S.menuLabel) + '">⋯</button></header>';
    }
    /** The message it answers, inside the row: who, #n, and the start of that text as written. */
    function quoteHtml(reply) {
      if (!reply) return "";
      var q = (reply.text || "").replace(/\s+/g, " ").trim() || S.picOnly;
      var who = reply.from === state.me ? escapeHtml(S.you) : rowName(reply.from, null, reply.displayName);
      return '<a class="fm-q" href="#m' + reply.seq + '" data-jump="' + reply.seq + '"><b>' + who + '</b><span class="qs">#' + reply.seq + '</span><span class="qx">' + escapeHtml(q) + '</span></a>';
    }
    /** Pane text is escaped directly so its Markdown and HTML stay visible as text. */
    function screenHtml(m) {
      if (!m.screen) return '';
      return '<div class="md pane-screen"><div class="codeblock"><div class="codeactions"><button type="button" class="wrapcode" data-wrapcode aria-pressed="true">' + escapeHtml(S.wrapOn) + '</button><button type="button" class="copycode" data-copycode>' + escapeHtml(S.copy) + '</button></div><pre class="code"><code>' + escapeHtml(m.screen.text) + '</code></pre></div>' +
        (m.screen.hidden > 0 ? '<p class="hint">' + escapeHtml(S.screenHidden) + '</p>' : '') + '</div>';
    }

    /** The text as written; a long one folds (展开全文). Then its screen, pictures and files. */
    function msgBody(m) {
      var t = String(m.text || ""), long = !unfolded.has(m.seq) && (t.length > FOLD_CHARS || t.split("\n").length > FOLD_LINES);
      return '<div class="body md' + (long ? ' fm-fold' : '') + '">' + renderMarkdown(t, names(), state.me) + '</div>' +
        (long ? '<button type="button" class="fm-more" data-unfold>' + escapeHtml(S.showAll) + '</button>' : '') + screenHtml(m) + hook('chips', m) + hook('card', m);
    }

    function renderMessage(m) {
      var el = document.createElement(m.fromKind !== 'system' && m.from === state.me ? 'article' : 'div');
      el.dataset.seq = m.seq;
      el.id = "m" + m.seq;
      if (m.fromKind === "system") {
        el.className = "msg system sys";
        var ev = m.event || {};
        el.textContent = hook('systemText', ev) || (ev.type === "join" ? fill(S.joined, { name: ev.name }) : ev.type === "leave" ? fill(S.leftRoom, { name: ev.name })
          : ev.type === "renamed" ? fill(S.sysRenamed, { from: ev.from, to: ev.to })
          : ev.type === "topic_renamed" ? fill(S.sysTopicRenamed, { by: ev.by, to: ev.to })
          : ev.type === "logged_out" ? fill(S.sysLoggedOut, { device: ev.device })
          : ev.type === "evicted" && ev.files ? fill(S.evicted, { n: ev.files.length, name: ev.name, names: evictedNames(ev.files) }) : m.text);
        return el;
      }
      var mine = m.from === state.me;
      var receipt = mine || (m.fromKind === 'agent' && ownerOf(m.from) === state.me) || (m.scheduled && ownerOf(m.scheduled.by) === state.me);   // mine, my agents' and my schedules' delivery
      var row = { receipt: receipt };
      el.className = "msg fm" + (mine ? " mine" : "") + (forMe(m) ? " forme" : "") + (timeShown.get(m.seq) ? " t-show" : "");
      el.innerHTML = '<div class="fm-av">' + avatar(m) + '</div><div class="fm-col">' + rowTop(m, receipt) +
        quoteHtml(m.reply) + msgBody(m) + '<div class="fm-foot">' + FOOT.map(function (slot) { return hook(slot, m, row); }).join('') + '</div></div>';
      if (receipt) readLine(m, el.querySelector(".rc"));
      if (nowrap.has(m.seq)) el.querySelectorAll(".codeblock").forEach(function (block, i) { if (nowrap.get(m.seq).has(i)) wrapCode(block, false); });
      hook('drawn', m, el);
      return el;
    }
    /** The files an eviction line names: the first five, then "…". */
    function evictedNames(files) {
      var names = files.slice(0, 5).map(function (f) { return f.name; }).join(S.evictedJoin);
      return files.length > 5 ? names + S.evictedMore : names;
    }

    /** The first message at least partly visible in the feed, and how far its top is from the feed's top. */
    function anchor(onlyMe) {
      var top = feed.getBoundingClientRect().top;
      var els = feed.querySelectorAll(".msg[data-seq]");
      var previous = null;
      for (var i = 0; i < els.length; i++) {
        if (onlyMe && !els[i].classList.contains('forme')) continue;
        var r = els[i].getBoundingClientRect();
        if (r.bottom <= r.top) continue;
        var a = { seq: els[i].dataset.seq, off: r.top - top };
        if (r.bottom > top) return a;
        previous = a;
      }
      return onlyMe ? previous : null;
    }
    function restore(a) {
      var el = a && feed.querySelector('.msg[data-seq="' + a.seq + '"]');
      if (el && el.getBoundingClientRect().bottom > el.getBoundingClientRect().top)
        feed.scrollTop += el.getBoundingClientRect().top - feed.getBoundingClientRect().top - a.off;
    }
    /** The top of the feed: a button for earlier messages while there are any (scrolling up loads them too). */
    function topControl() {
      var more = document.createElement("button");
      more.className = "more";
      more.type = "button";
      more.id = "earlier";
      more.textContent = loadingEarlier ? S.loadingEarlier : S.earlier;
      more.onclick = function () { loadEarlier(); };
      return more;
    }
    /** Something lies above the window: in memory, or on the server. */
    function above() { return win.first != null && pos.get(win.first) > 0; }
    function refreshTop() {
      var more = $("earlier");
      var f = filter(), want = filtered() ? f.hasMore() || above() : above() || !!(oldest && oldest > 1);
      if (more && !want) more.remove();
      else if (!more && want) {
        more = topControl();
        feed.insertBefore(more, feed.firstChild);
      }
      if (more) more.textContent = (filtered() ? f.loading() : loadingEarlier) ? S.loadingEarlier : S.earlier;
    }
    function dividerEl() {
      var d = document.createElement("div");
      d.className = "divider";
      d.id = "unread";
      d.textContent = S.unread;
      return d;
    }

    // ---------- message times: about one a screen ----------
    // A screen is the feed's height. From the top down, the first row shows its time; after it, a row whose top is a
    // screen or more below the top of the last row showing one. System lines have no time and do not count. Each row's
    // answer is kept by seq: new rows at the bottom go on from the last one showing, earlier rows put in above go up
    // from the first one showing, and nothing decided changes until everything is placed again (full): the first
    // drawing, a new width of the feed (rows wrap anew), the whole feed drawn again. A new height alone (a phone's
    // keyboard, a taller composer) keeps what was decided, and only later decisions use it, so times do not jump
    // while someone types. Heights that change later (a picture loading, 展开全文) are not followed either: about one
    // a screen is enough.
    function placeTimes(full) {
      var h = feed.clientHeight;
      if (!h) return; // not laid out (hidden): placed when it gets a size
      if (full) { timeShown.clear(); timeWidth = feed.clientWidth; }
      var rows = [], tops = [];
      feed.querySelectorAll(".msg[data-seq]").forEach(function (el) {
        if (el.classList.contains("fm")) rows.push(el);
      });
      var top = function (i) {
        if (tops[i] === undefined) { var r = rows[i].getBoundingClientRect(); tops[i] = r.bottom > r.top ? r.top : null; }
        return tops[i];
      };
      var seqOf = function (i) { return Number(rows[i].dataset.seq); };
      var got = new Map(), i, first = -1;
      for (i = 0; i < rows.length && first < 0; i++) if (timeShown.has(seqOf(i))) first = i;
      if (first > 0) {
        // Rows put in above: up from the first one showing (or the first decided when none on the page shows).
        var a = first;
        for (i = first; i < rows.length && timeShown.has(seqOf(i)); i++) if (timeShown.get(seqOf(i))) { a = i; break; }
        var at = top(a);
        for (i = first - 1; i >= 0 && at != null; i--) {
          if (top(i) == null) continue; // hidden (只看 @我): decided once it shows
          var up = at - top(i) >= h;
          got.set(seqOf(i), up);
          if (up) at = top(i);
        }
      }
      // Down: rows not yet decided, from the last one showing above them.
      var last = first < 0 ? null : first;
      for (i = Math.max(first, 0); i < rows.length; i++) {
        var seq = seqOf(i);
        if (timeShown.has(seq)) { if (timeShown.get(seq)) last = i; continue; }
        if (top(i) == null) continue;
        var show = last == null || top(last) == null || top(i) - top(last) >= h;
        got.set(seq, show);
        if (show) last = i;
      }
      // Written after every top is read, so the reads do not wait on a layout each.
      rows.forEach(function (el, k) {
        var s = seqOf(k);
        if (got.has(s)) timeShown.set(s, got.get(s));
        el.classList.toggle("t-show", !!timeShown.get(s));
      });
    }
    /** The feed got a new width (a window resized, a phone turned): every time placed again. */
    function feedResized() {
      if (feed.clientWidth !== timeWidth) placeTimes(true);
    }

    // ---------- the window: drawing rows, and taking them away again ----------
    function reindex() {
      pos = new Map();
      state.messages.forEach(function (m, i) { pos.set(m.seq, i); });
    }
    function formeAdd(seq) {
      var i = formeRows.length;
      while (i > 0 && formeRows[i - 1] > seq) i--;
      if (formeRows[i - 1] !== seq) formeRows.splice(i, 0, seq);
    }
    function formeDrop(seq) {
      var i = formeRows.indexOf(seq);
      if (i >= 0) formeRows.splice(i, 1);
    }
    /** The rows of state.messages[from..to], the unread line above its message. */
    function rowsFor(from, to) {
      var frag = document.createDocumentFragment();
      for (var i = from; i <= to; i++) {
        var m = state.messages[i];
        if (m.seq === dividerAt) frag.appendChild(dividerEl());
        frag.appendChild(renderMessage(m));
        if (forMe(m)) formeAdd(m.seq);
      }
      return frag;
    }
    /** A row drawn again in its place (its message changed). */
    function swapRow(el, m) {
      el.replaceWith(renderMessage(m));
      if (win.first == null || m.seq < win.first || m.seq > win.last) return; // a sparse row of 只看 @我
      formeDrop(m.seq);
      if (forMe(m)) formeAdd(m.seq);
    }
    /** A row leaves the page: its menu or selection closes, the unread line above it goes with it. */
    function dropRow(seq) {
      var el = $("m" + seq);
      if (!el) return;
      if (menuSeq === seq) closeMenu();
      if (selSeq === seq) exitSelect();
      if (seq === dividerAt && $("unread")) $("unread").remove();
      el.remove();
      formeDrop(seq);
    }
    /**
     * Past ROWS_MAX rows: back to ROWS, taken from the end far from the reader (end: "top" or "bottom"), never a row on
     * screen; what the reader looks at stays put. With 只看 @我 the rows between two on screen stay, so the window may
     * then hold up to what memory holds until the reader moves.
     */
    function trimRows(end) {
      if (win.first == null) return;
      var lo = pos.get(win.first), hi = pos.get(win.last);
      if (hi - lo + 1 <= ROWS_MAX) return;
      var a = anchor(), at = a && pos.has(Number(a.seq)) ? pos.get(Number(a.seq)) : null, i;
      if (end === "top") {
        var keep = Math.min(hi - ROWS + 1, at == null ? hi : at);
        for (i = lo; i < keep; i++) dropRow(state.messages[i].seq);
        win.first = state.messages[keep].seq;
        restore(a);
        refreshTop();
        placeInvite();
      } else {
        var last = lo + ROWS - 1, bottom = feed.getBoundingClientRect().bottom;
        // The last row on screen: from the anchor down, over the window's rows only.
        for (i = at == null ? lo : at; i <= hi; i++) {
          var el = $("m" + state.messages[i].seq);
          if (el.getBoundingClientRect().top >= bottom) break;
          if (i > last) last = i;
        }
        for (i = hi; i > last; i--) dropRow(state.messages[i].seq);
        win.last = state.messages[Math.min(last, hi)].seq;
      }
    }
    /**
     * Past MSGS_MAX messages in memory: back to MSGS, taken from the end far from the window; the far top is fetched again
     * when the reader comes back to it. A latest end taken away waits as the held latest feed, as after a jump.
     */
    function trimData() {
      var n = state.messages.length;
      if (n <= MSGS_MAX) return;
      var lo = win.first == null ? n : pos.get(win.first), hi = win.first == null ? n - 1 : pos.get(win.last), gone;
      if (lo >= n - 1 - hi) {
        gone = state.messages.slice(0, Math.min(n - MSGS, lo));
        writeFeed.messages(state.messages.slice(gone.length));
        oldest = state.messages[0].seq;
      } else {
        gone = state.messages.slice(Math.max(MSGS, hi + 1));
        writeFeed.messages(state.messages.slice(0, n - gone.length));
        if (!heldLatest) heldLatest = gone.slice(-MSGS);
      }
      gone.forEach(function (m) { if (state.bySeq.get(m.seq) === m) state.bySeq.delete(m.seq); });
      reindex();
      refreshTop();
      placeInvite();
    }
    /** New messages past the last in memory (seq order) join it. */
    function takeLater(list) {
      var last = lastSeq();
      list.forEach(function (m) {
        if (m.seq <= last) return;
        state.messages.push(m);
        state.bySeq.set(m.seq, m);
        pos.set(m.seq, state.messages.length - 1);
        last = m.seq;
      });
    }
    /**
     * The window drawn anew: around focus (a seq in memory) when it lies above the latest rows, else the latest ROWS.
     * The first time, the unread line is placed and the feed opens at it.
     */
    function renderAll(focus) {
      var atBottom = nearBottom(), a = firstLoad ? null : anchor();
      feed.innerHTML = "";
      formeRows = [];
      // The "unread" line goes above the first message for me that arrived since I last read, decided once per page load.
      if (firstLoad && dividerAt == null) {
        if (oldest > 1 && state.cursor + 1 < oldest) {
          // I last read before the messages the page got first (the latest 50): a line over the first of them would
          // hide that more unread ones sit above it, so there is no line, and 「↑ 第一条未读」 goes to them (around).
          dividerAt = 0;
          firstUnread = state.cursor + 1;
        } else {
          var first = state.messages.find(function (m) { return m.seq > state.cursor && m.from !== state.me && m.fromKind !== "system"; });
          dividerAt = first ? first.seq : 0;
        }
      }
      var n = state.messages.length, at = pos.get(focus != null ? focus : firstLoad ? dividerAt : null);
      var lo = Math.max(0, n - ROWS);
      if (at != null && at < lo) lo = Math.max(0, at - ROWS / 2);
      var hi = Math.min(n - 1, lo + ROWS - 1);
      win.first = n ? state.messages[lo].seq : null;
      win.last = n ? state.messages[hi].seq : null;
      if (above() || (oldest && oldest > 1)) feed.appendChild(topControl());
      if (!n && !outbox.length) {
        var empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = S.empty;
        feed.appendChild(empty);
      }
      if (n) feed.appendChild(rowsFor(lo, hi));
      feed.appendChild(outEl);
      placeTimes(true);
      outbox.slice().forEach(function (o) { if (o.seq && state.bySeq.has(o.seq)) arrived(state.bySeq.get(o.seq)); });
      if (firstLoad) {
        // The unread line, or with unread ones older than the page's messages the first of these (so nothing unseen is marked read).
        var target = $("unread") || (firstUnread ? feed.querySelector(".msg[data-seq]") : null);
        if (target) target.scrollIntoView({ block: "start" });
        else feed.scrollTop = feed.scrollHeight;
        firstLoad = false;
      } else if (atBottom) feed.scrollTop = feed.scrollHeight;
      else restore(a);
      placeInvite();
      if (filter()) { filter().reset(); filter().sync(); refreshTop(); }
      updateChips();
      updateJump();
    }
    /** Earlier messages from the server go in above what is in memory, and on the page when the window starts there. */
    function prependOlder(list) {
      var a = anchor(), top = win.first == null || pos.get(win.first) === 0;
      var known = list.filter(function (m) { return !state.bySeq.has(m.seq); });
      setMessages(known.concat(state.messages));
      if (top && known.length) {
        var more = $("earlier");
        feed.insertBefore(rowsFor(0, known.length - 1), more ? more.nextSibling : feed.firstChild);
        win.first = known[0].seq;
        if (win.last == null) win.last = known[known.length - 1].seq;
        placeTimes();
      }
      var empty = feed.querySelector(".empty");
      if (empty && state.messages.length) empty.remove();
      refreshTop();
      placeInvite();
      restore(a);
      trimRows("bottom");
      trimData();
    }
    /**
     * The STEP messages in memory above the window go on the page above it; what the reader looks at stays put. With
     * 只看 @我 on, until one for me is drawn or memory has no more. True when it drew one the reader can see.
     */
    function growUp() {
      if (!above()) return false;
      var a = anchor(), only = filtered(), had = formeRows.length, lo = pos.get(win.first);
      do {
        var from = Math.max(0, lo - STEP), first = $("m" + win.first);
        feed.insertBefore(rowsFor(from, lo - 1), win.first === dividerAt && $("unread") ? $("unread") : first);
        win.first = state.messages[from].seq;
        lo = from;
      } while (only && lo > 0 && formeRows.length === had);
      placeTimes();
      refreshTop();
      restore(a);
      trimRows("bottom");
      return !only || formeRows.length > had;
    }
    /** The reader reached the bottom of the window: the next rows from memory, else the latest feed when it is held. */
    function reachBottom() {
      if (win.last == null) return;
      if (win.last !== lastSeq()) return growDown();
      if (!heldLatest) return;
      if (!joins(lastSeq(), heldLatest)) return loadLater();
      takeLater(heldLatest);
      heldLatest = null;
      if (win.last !== lastSeq()) growDown();
      trimData();
      updateJump();
    }
    /** The STEP messages in memory below the window go on the page below it. */
    function growDown() {
      var hi = pos.get(win.last), to = Math.min(state.messages.length - 1, hi + STEP);
      if (to <= hi) return;
      feed.insertBefore(rowsFor(hi + 1, to), outEl);
      win.last = state.messages[to].seq;
      placeTimes();
      trimRows("top");
    }
    var loadingLater = null;
    /** Between memory and the held latest feed: the next page from the server (/around just past memory). */
    function loadLater() {
      if (loadingLater) return loadingLater;
      var last = lastSeq(), token = jumping, held = heldLatest;
      var seq = held.length ? Math.min(last + 51, held[0].seq) : last + 51;
      loadingLater = fetch('/r/' + boot.roomId + '/around?seq=' + seq, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (a) {
          loadingLater = null;
          if (!a.ok || token !== jumping || lastSeq() !== last || heldLatest !== held) return false;
          var got = (a.j.messages || []).filter(function (m) { return m.seq > last; });
          if (!got.length) return false;
          if (joins(got[got.length - 1].seq, heldLatest)) {
            got = got.filter(function (m) { return !heldLatest.length || m.seq < heldLatest[0].seq; }).concat(heldLatest);
            heldLatest = null;
          }
          takeLater(got);
          growDown();
          trimData();
          updateJump();
          return true;
        }, function () { loadingLater = null; return false; });
      return loadingLater;
    }
    function append(m) {
      if (heldLatest) {
        var held = heldLatest[heldLatest.length - 1];
        if (!held || m.seq > held.seq) heldLatest.push(m);
        if (heldLatest.length > MSGS_MAX) heldLatest = heldLatest.slice(-MSGS);
        if (m.fromKind !== 'system') countBelow(m.seq, m);
        if (mentionsMe(m) && m.seq > state.cursor) writeFeed.mentionUnread(state.mentionUnread + 1);
        updateJump();
        return;
      }
      if (state.bySeq.has(m.seq)) return;
      addBelow(m);
      if (mentionsMe(m) && m.seq > state.cursor) writeFeed.mentionUnread(state.mentionUnread + 1);
      if (filter()) filter().sync();
      updateChips();
      updateJump();
      maybeMark();
    }
    /** A new message under the others: on the page while the window reaches the latest, else counted in "↓ N new". */
    function addBelow(m) {
      var atBottom = nearBottom(), touching = win.last == null || win.last === lastSeq();
      takeLater([m]);
      var empty = feed.querySelector(".empty");
      if (empty) empty.remove();
      arrived(m);
      placeOutbox();
      if (touching) {
        feed.insertBefore(renderMessage(m), outEl);
        if (forMe(m)) formeAdd(m.seq);
        if (win.first == null) win.first = m.seq;
        win.last = m.seq;
        placeTimes();
        // The far end: whichever has more of the page beyond the screen (a reader at the bottom keeps the bottom).
        trimRows(feed.scrollTop > feed.scrollHeight - feed.scrollTop - feed.clientHeight ? "top" : "bottom");
      }
      // Only a reader at the bottom is carried along, also by what they send themselves: someone
      // replying from up in the history stays where they are, and their own message counts in "↓ N new".
      if (atBottom && touching) feed.scrollTop = feed.scrollHeight;
      else if (m.fromKind !== "system") countBelow(m.seq, m);
      trimData();
    }
    function setMessages(list) {
      writeFeed.messages(list.slice().sort(function (a, b) { return a.seq - b.seq; }));
      writeFeed.bySeq(new Map(state.messages.map(function (m) { return [m.seq, m]; })));
      reindex();
      oldest = state.messages.length ? state.messages[0].seq : null;
    }

    // ---------- the frames that bring my read state and the messages: room.js calls these in its own order ----------

    /** The hello frame's me: where I read up to and how many messages addressed to me lie past it. */
    function helloMe(me) {
      writeFeed.cursor(me.cursor != null ? me.cursor : Infinity); // a viewer has no cursor: nothing reads as unread
      writeFeed.mentionUnread(me.mentionUnread || 0);
    }
    /**
     * The hello frame's messages. The first one draws the feed. After a reconnect the page is matched to them by seq
     * instead of drawn again, so what the reader is looking at stays exactly as it was: a row is replaced
     * only when its message changed, one the page missed goes in its place, new ones come in below. The mention count
     * is the hello's own (helloMe), so nothing here adds to it.
     */
    function helloMessages(list) {
      var fresh = list || [];
      if (firstLoad) { setMessages(fresh); renderAll(); return; }
      // An older page is open after a jump (or the latest is already held back): the latest feed waits there.
      if (heldLatest) {
        var held = heldLatest, heldLast = held.length ? held[held.length - 1].seq : 0;
        countNew(heldLast, fresh);
        heldLatest = joins(heldLast, fresh) ? held.filter(function (m) { return !fresh.length || m.seq < fresh[0].seq; }).concat(fresh) : fresh;
        if (heldLatest.length > MSGS_MAX) heldLatest = heldLatest.slice(-MSGS);
        updateJump();
        return;
      }
      var last = lastSeq();
      if (!joins(last, fresh)) {
        // More came in while away than one hello carries: the page stays, and the latest waits behind "↓ N new" as it
        // does after a jump. Only what is on the page can be marked read, so nothing in between is.
        countNew(last, fresh);
        heldLatest = fresh;
        updateJump();
        return;
      }
      var a = anchor(), atBottom = nearBottom(), before = state.bySeq, from = fresh.length ? fresh[0].seq : Infinity;
      var wf = win.first, wl = win.last, i;
      var inFresh = new Set(fresh.map(function (m) { return m.seq; }));
      if (wf != null) for (i = pos.get(wf); i <= pos.get(wl); i++) {
        var gone = state.messages[i];
        if (gone.seq >= from && !inFresh.has(gone.seq)) dropRow(gone.seq);
      }
      var onPage = fresh.filter(function (m) { return m.seq <= last; });
      setMessages(state.messages.filter(function (m) { return m.seq < from; }).concat(onPage));
      // Only the window has rows: a message outside it is in memory only.
      onPage.forEach(function (m) {
        if (wf == null || m.seq < wf || m.seq > wl) return;
        var old = before.get(m.seq), el = $("m" + m.seq);
        if (old && el) { if (!sameMessage(old, m)) swapRow(el, m); return; }
        var next = null;
        for (var k = pos.get(m.seq) + 1; !next && k < state.messages.length && state.messages[k].seq <= wl; k++) next = $("m" + state.messages[k].seq);
        var at = !next ? outEl : Number(next.dataset.seq) === dividerAt && $("unread") ? $("unread") : next;
        feed.insertBefore(renderMessage(m), at);
        if (forMe(m)) formeAdd(m.seq);
      });
      placeTimes();
      if (wf != null) {
        var kept = state.messages.filter(function (m) { return m.seq >= wf && m.seq <= wl; });
        win.first = kept.length ? kept[0].seq : null;
        win.last = kept.length ? kept[kept.length - 1].seq : null;
        if (!kept.length && state.messages.length) renderAll();
      }
      if (atBottom) feed.scrollTop = feed.scrollHeight;
      else restore(a);
      fresh.forEach(function (m) { if (m.seq > last) addBelow(m); });
      refreshReadLines();
      placeInvite();
      updateChips();
      updateJump();
      maybeMark();
    }
    /** fresh continues a feed that ends at last: nothing between them is missing. */
    function joins(last, fresh) {
      return !last || !fresh.length || fresh[0].seq <= last + 1;
    }
    /** One message (m, or only its seq when no page carried it) arrived below the reader: "↓ N new" counts it once. */
    function countBelow(seq, m) {
      if (seq <= newTo) return;
      newTo = seq;
      newBelow++;
      if (m && forMe(m)) newForMe++;
    }
    /** "↓ N new" counts what came after last: the messages of fresh, and the ones between that no hello carried. */
    function countNew(last, fresh) {
      if (last && fresh.length && fresh[0].seq - 1 > Math.max(last, newTo)) {
        newBelow += fresh[0].seq - 1 - Math.max(last, newTo);
        newTo = fresh[0].seq - 1;
      }
      fresh.forEach(function (m) { if (m.seq > last && m.fromKind !== "system") countBelow(m.seq, m); });
    }
    /** The same message as the server sends it; validMentions is the page's own note on it. */
    function sameMessage(a, b) {
      var own = function (k, v) { return k === "validMentions" ? undefined : v; };
      return JSON.stringify(a, own) === JSON.stringify(b, own);
    }
    /** The cursor frame for me (I read in another tab): my cursor only moves forward. */
    function myCursor(cursor) {
      writeFeed.cursor(Math.max(state.cursor, cursor));
      recountMentions();
    }
    /** The /mentions answer's count of unread messages addressed to me. */
    function unreadFromMentions(n) { writeFeed.mentionUnread(n); }

    var loadingEarlier = null;
    /** Earlier rows: from memory first, else the page of messages before the earliest one in memory; one request at a time. */
    function loadEarlier() {
      if (filtered()) return filter().loadEarlier();
      if (growUp()) return Promise.resolve(true);
      if (loadingEarlier) return loadingEarlier;
      if (!oldest || oldest <= 1) return Promise.resolve(false);
      loadingEarlier = fetch("/r/" + boot.roomId + "/history?before=" + oldest, { headers: { accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var got = j.messages || [];
          loadingEarlier = null;
          if (!got.length) { oldest = 1; refreshTop(); return false; }
          prependOlder(got);
          return true;
        }, function () { loadingEarlier = null; refreshTop(); return false; });
      refreshTop();
      return loadingEarlier;
    }

    // ---------- "↓ Latest" / "↓ N new": shown while the reader is away from the bottom; "↩ Back" above it after a jump ----------
    /** The reader is at the bottom of the latest message: the window reaches it and nothing is held. */
    function atLatest() {
      return nearBottom() && !heldLatest && (win.last == null || win.last === lastSeq());
    }
    function updateJump() {
      var j = $("jump");
      if (atLatest()) newBelow = newForMe = 0;
      var n = filtered() ? newForMe : newBelow;
      j.classList.toggle("hidden", !n && atLatest());
      j.classList.toggle("new", n > 0);
      j.textContent = n ? fill(S.newBelow, { n: n }) : S.toLatest;
      var b = $("back");
      b.classList.toggle("hidden", !trail.length);
      b.textContent = S.backJump;
      var fu = $("jump-unread");
      if (fu) {
        // Gone once used, or once scrolling up has brought the first unread onto the page.
        if (firstUnread && win.first != null && win.first <= firstUnread) firstUnread = null;
        fu.classList.toggle("hidden", !firstUnread || !!heldLatest);
        fu.textContent = S.firstUnread;
      }
      var at = $("jump-at");
      at.classList.toggle("hidden", !state.mentionUnread);
      at.textContent = "@" + S.you + " " + state.mentionUnread + " ↓";
    }
    function jumpDown() {
      newJump();
      if (heldLatest) showLatest();
      else if (win.last !== lastSeq()) renderAll();
      newBelow = newForMe = 0;
      trail = [];
      feed.scrollTop = feed.scrollHeight;
      updateJump();
      maybeMark();
    }
    function unreadForMe() {
      var out = [];
      for (var i = indexAfter(state.cursor); i < state.messages.length; i++) if (forMe(state.messages[i])) out.push(state.messages[i]);
      return out;
    }
    function nearBottom() {
      return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    }

    // ---------- jumps, and coming back from them ----------
    // Every jump (a #number, a quote, a pin, the @me list, a plan link, a search hit) first notes where the reader was;
    // "↩ Back" returns there, one jump at a time, like a reply chain in Telegram. "↓ Latest" is its own
    // button: going to the present drops the trail. Seeing a noted place again (scrolled back to by hand,
    // or still on screen after a short jump) takes it off the trail.
    // A message not on the page brings its page first, and the feed changes only once it has come: the latest feed when
    // it holds the message, otherwise the messages around it (/around), one request however far back it is.

    // [{seq, off, src, search, home}]: a card and how far its top was from the feed's top; src: the card the jump started
    // in. The card may be on another page than the one shown. search: the jump came from the search panel, which Back
    // opens again on a phone; home: from the home page's search, its query, where Back goes.
    var trail = [];
    var heldLatest = null; // the latest feed, kept up to date, while an older page shows
    var jumping = 0;       // the latest jump, Back or "↓ Latest": the answer for an earlier one is dropped
    function onScreen(el) {
      var f = feed.getBoundingClientRect(), r = el.getBoundingClientRect();
      return r.bottom > f.top + 8 && r.top < f.bottom - 8;
    }
    function placeOf(card) {
      if (!card || !onScreen(card)) return anchor();
      return { seq: card.dataset.seq, off: card.getBoundingClientRect().top - feed.getBoundingClientRect().top, src: Number(card.dataset.seq) };
    }
    function pruneTrail() {
      while (trail.length) {
        var spot = trail[trail.length - 1], el = $("m" + spot.seq);
        if (!el || !onScreen(el) || spot.search) break;
        trail.pop();
      }
    }
    function lightUp(el) {
      el.classList.remove("flash");
      void el.offsetWidth; // restart the animation when the same card is jumped to again
      el.classList.add("flash");
      clearTimeout(el.flashT);
      el.flashT = setTimeout(function () { el.classList.remove("flash"); }, 1700);
    }
    /** Scroll to a message and flash it. from: the card the jump starts in (none: the reader's place), noted for Back. */
    function jumpTo(seq, from) {
      go(seq, placeOf(from));
    }
    /** A jump from a search hit; fromHome: from the home page's search, opened on this page by its link. */
    function jumpSearch(seq, fromHome) {
      var spot = anchor() || { seq: null, off: 0 };
      spot.search = true;
      if (fromHome) spot.home = new URLSearchParams(location.search).get('fromSearch') || '';
      go(seq, spot);
    }
    /** A jump, Back or "↓ Latest" starts: one still waiting for its page is dropped, and its notice goes. */
    function newJump() {
      $("toast").classList.add("hidden");
      return ++jumping;
    }
    function go(seq, spot) {
      var token = newJump();
      if (!(seq >= 1)) return flash(fill(S.jumpNone, { n: seq }));
      // 只看 @我 hides the rest, and pages back through the @me list only: a jump to anything else turns it off first.
      if (filtered() && !($("m" + seq) && $("m" + seq).classList.contains("forme"))) filter().off();
      if ($("m" + seq)) return seek(seq, spot);
      var latest = heldLatest || state.messages;
      if (!latest.length || seq > latest[latest.length - 1].seq) return flash(fill(S.jumpNone, { n: seq }));
      // In memory but not on the page: the window is drawn around it, no request.
      if (pos.has(seq)) {
        renderAll(seq);
        return seek(seq, spot);
      }
      if (heldLatest && latest.some(function (m) { return m.seq === seq; })) {
        showLatest(seq);
        return seek(seq, spot);
      }
      showAround(seq, token, function () { seek(seq, spot); });
    }
    function seek(seq, spot) {
      var el = $("m" + seq);
      if (spot) { trail.push(spot); if (trail.length > 50) trail.shift(); }
      el.scrollIntoView({ block: el.offsetHeight < feed.clientHeight ? "center" : "start" });
      lightUp(el);
      pruneTrail();
      updateJump();
    }
    /** The held latest feed in memory again, the window around focus when one is given. */
    function showLatest(focus) {
      var latest = heldLatest;
      heldLatest = null;
      setMessages(latest);
      renderAll(focus);
    }
    /** The page around seq from the server; then() runs once it shows. The notice stays until the answer comes. */
    function showAround(seq, token, then) {
      toast(fill(S.jumpLoading, { n: seq }));
      clearTimeout(toast.t);
      fetch('/r/' + boot.roomId + '/around?seq=' + seq, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (a) {
          if (token !== jumping) return;
          $("toast").classList.add("hidden");
          if (!a.ok) return flash(fill(a.j.error === "message_not_found" ? S.jumpNone : S.jumpFailed, { n: seq }));
          // Taken as it is now: a message may have arrived while /around was in flight.
          if (!heldLatest) heldLatest = state.messages.slice();
          setMessages(a.j.messages || []);
          renderAll();
          then();
        })
        .catch(function () {
          if (token !== jumping) return;
          $("toast").classList.add("hidden");
          flash(fill(S.jumpFailed, { n: seq }));
        });
    }
    /** Back to where the last jump started, bringing its page first; the card it started in lights up. */
    function goBack() {
      var token = newJump(), spot = trail.pop();
      if (!spot) return updateJump();
      if (spot.home != null) { location.href = '/?search=' + encodeURIComponent(spot.home); return; }
      var seq = Number(spot.seq);
      function there() {
        restore(spot);
        var src = spot.src && $("m" + spot.src);
        if (src) lightUp(src);
        updateJump();
        if (spot.search && window.innerWidth <= 760) openPanel('search');
      }
      if ($("m" + spot.seq)) return there();
      if (pos.has(seq)) {
        renderAll(seq);
        return there();
      }
      if (heldLatest && heldLatest.some(function (m) { return m.seq === seq; })) {
        showLatest(seq);
        return there();
      }
      showAround(seq, token, there);
    }

    // ---------- the message menu: ⋯ on the card, right-click, or a long press on a phone ----------

    var menu = $("msgmenu"), menuScrim = $("msgmenu-scrim"), menuSeq = null, menuOpenedAt = 0, menuList = [];

    // Menu hooks: what other domains add to the menu. Each slot has one owner; fn(m) returns items
    // {act, label, hint?, icon, run(m)}. The feed fixes the order, whatever order the factories register in: compose
    // (reply, mention), todo (see Tn, add as task), a separator when either gave an item, then the feed's own copy, and
    // select where card text is locked.
    var menuHooks = {};
    function menuHook(slot, fn) {
      if (menuHooks[slot]) throw new Error("menu hook " + slot + " is already registered");
      menuHooks[slot] = fn;
    }

    function menuItems(m) {
      var items = [];
      ["compose", "todo", "memo"].forEach(function (slot) { if (menuHooks[slot]) items = items.concat(menuHooks[slot](m)); });
      if (items.length) items.push(null);
      items.push({ act: "copy", label: S.menuCopy, hint: S.menuCopyHint, icon: MENU_ICONS.copy, run: function (m) { return copy(m.text, S.copiedText); } });
      if (textLocked()) items.push({ act: "select", label: S.menuSelect, hint: S.menuSelectHint, icon: MENU_ICONS.select, run: function (m) { return enterSelect(m.seq); } });
      return items;
    }

    // Card text is locked only where a long press opens this menu (app.css: no hover, coarse pointer: a phone or
    // tablet), so "Select text" is offered only there; with a mouse or trackpad the words are dragged over.
    function textLocked() { return !!(window.matchMedia && matchMedia("(hover: none) and (pointer: coarse)").matches); }

    var MENU_ICONS = {
      copy: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>',
      select: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10M12 4v16M7 20h10"/></svg>'
    };

    /** at: {x, y} for a press or a click point, or {rect} of the ⋯ button. */
    function openMenu(seq, at) {
      var m = state.bySeq.get(seq), card = $("m" + seq);
      if (!m || !card || m.fromKind === "system") return;
      closeMenu();
      menuSeq = seq;
      menuOpenedAt = Date.now();
      menuList = menuItems(m);
      // On top, the full time: not an item (no role, nothing to choose or press), a line under it.
      menu.innerHTML = '<div class="mtime">' + escapeHtml(fullTime(m.ts)) + '</div>' + menuList.map(function (it) {
        if (!it) return '<div class="sep" role="separator"></div>';
        return '<button type="button" role="menuitem" class="" data-act="' + it.act + '">' + it.icon +
          '<span class="menu-copy"><span>' + escapeHtml(it.label) + "</span>" +
          (it.hint ? "<small>" + escapeHtml(it.hint) + "</small>" : "") + "</span></button>";
      }).join("");
      menu.style.visibility = "hidden";
      menu.classList.remove("hidden");
      if (window.matchMedia('(max-width: 760px)').matches) {
        // A phone: where the finger pressed too, above it when there is room, since the finger covers what is under it.
        menu.style.right = '';
        menu.style.bottom = '';
        menu.style.width = 'min(300px, calc(100vw - 24px))';
        var pw = menu.offsetWidth, ph = menu.offsetHeight, pvw = window.innerWidth, pvh = window.innerHeight, px, py;
        if (at.rect) { px = at.rect.right - pw; py = at.rect.bottom + 4 + ph > pvh - 12 ? at.rect.top - 4 - ph : at.rect.bottom + 4; }
        else { px = at.x - pw / 2; py = at.y - 24 - ph >= 12 ? at.y - 24 - ph : at.y + 24; }
        menu.style.left = Math.max(12, Math.min(px, pvw - pw - 12)) + 'px';
        menu.style.top = Math.max(12, Math.min(py, pvh - ph - 12)) + 'px';
      } else {
        menu.style.right = '';
        menu.style.bottom = '';
        menu.style.width = '';
        var w = menu.offsetWidth, h = menu.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, x, y;
        if (at.rect) {
          x = at.rect.right - w;
          y = at.rect.bottom + 4 + h > vh - 8 ? at.rect.top - 4 - h : at.rect.bottom + 4;
        } else {
          x = at.x - w / 2;
          y = at.y + 16 + h > vh - 8 ? at.y - 16 - h : at.y + 16;
          var head = (card.querySelector(".fm-top, .mh") || card).getBoundingClientRect();   // keep the name line readable (rows: .fm-top)
          if (y < head.bottom && y + h > head.top) y = head.bottom + 4 + h <= vh - 8 ? head.bottom + 4 : head.top - 4 - h;
        }
        menu.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
        menu.style.top = Math.max(8, Math.min(y, vh - h - 8)) + "px";
      }
      menu.style.visibility = "";
      card.classList.add("menued");
      document.body.classList.add("menuopen");
      menuScrim.classList.remove("hidden");
    }

    function closeMenu() {
      if (menuSeq == null) return;
      var card = $("m" + menuSeq);
      if (card) card.classList.remove("menued");
      document.body.classList.remove("menuopen");
      menu.classList.add("hidden");
      menuScrim.classList.add("hidden");
      menu.innerHTML = "";
      menuSeq = null;
    }

    /** The item as the open menu showed it: a task that arrives while the menu is open does not change what it does. */
    function menuAct(act, seq) {
      var m = state.bySeq.get(seq), it = menuList.find(function (x) { return x && x.act === act; });
      closeMenu();
      if (!m || !it) return;
      return it.run(m);
    }

    function cardOf(t) {
      var c = t && t.closest && t.closest(".msg[data-seq]");
      return c && !c.classList.contains("system") ? c : null;
    }

    // ---------- select mode: the card's own text becomes selectable, with copy / select all / reply ----------

    var selSeq = null;

    function selectBody(card) {
      var body = card.querySelector(".body");
      var r = document.createRange();
      r.selectNodeContents(body);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    function enterSelect(seq) {
      exitSelect();
      var card = $("m" + seq);
      if (!card) return;
      selSeq = seq;
      card.classList.add("selecting");
      var bar = document.createElement("div");
      bar.className = "selbar";
      bar.innerHTML = '<button type="button" data-sel="copy">' + S.selCopy + '</button><button type="button" data-sel="all">' + S.selAll + "</button>" +
        (canWrite() ? '<button type="button" data-sel="reply">' + S.selReply + "</button>" : "");
      card.querySelector(".fm-top").after(bar);
      var dots = card.querySelector(".dots");
      if (dots) { dots.textContent = S.selDone; dots.classList.add("done"); }
      card.scrollIntoView({ block: "nearest" });
      selectBody(card);
      if (ctx.overlayChanged) ctx.overlayChanged();
    }

    function exitSelect() {
      if (selSeq == null) return;
      var card = $("m" + selSeq);
      selSeq = null;
      if (ctx.overlayChanged) ctx.overlayChanged();
      if (!card) return;
      card.classList.remove("selecting");
      var bar = card.querySelector(".selbar");
      if (bar) bar.remove();
      var dots = card.querySelector(".dots");
      if (dots) { dots.textContent = "⋯"; dots.classList.remove("done"); }
      var sel = window.getSelection();
      if (sel && card.contains(sel.anchorNode)) sel.removeAllRanges();
    }

    /** The selected text when it lies in this card's body, else "". */
    function selectedIn(card) {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
      var body = card.querySelector(".body");
      return body && body.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString().trim() : "";
    }

    function selAct(act) {
      var seq = selSeq, card = $("m" + seq), m = state.bySeq.get(seq);
      if (!card || !m) return exitSelect();
      if (act === "all") return selectBody(card);
      var picked = selectedIn(card);
      if (act === "copy") return picked ? copy(picked, S.copiedSel) : copy(m.text, S.copiedText);
      if (act === "reply") {
        exitSelect();
        return setReply(seq, { mention: true, excerpt: picked || null });
      }
    }

    // ---------- links: a tap opens a small menu, Open first, then Copy link ----------

    var linkMenu = $("linkmenu"), linkOpen = false;

    function openLinkMenu(a, e) {
      closeMenu();
      closeLinkMenu();
      var href = a.href; // as the browser resolved it: exactly where Open goes, shown on top
      linkMenu.innerHTML = '<div class="addr">' + escapeHtml(href) + "</div>" +
        '<a role="menuitem" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer" data-linkopen><span>' + escapeHtml(S.linkOpen) + "</span></a>" +
        '<button type="button" role="menuitem" data-linkcopy><span>' + escapeHtml(S.linkCopy) + "</span></button>";
      linkMenu.dataset.href = href;
      linkMenu.style.visibility = "hidden";
      linkMenu.classList.remove("hidden");
      // Under the line of the link that was tapped (a long link wraps over several lines), else above it.
      var rects = Array.prototype.slice.call(a.getClientRects());
      var r = rects.find(function (x) { return e.clientY >= x.top - 2 && e.clientY <= x.bottom + 2; }) || rects[0] || a.getBoundingClientRect();
      var w = linkMenu.offsetWidth, h = linkMenu.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      var x = (e.clientX || r.left) - w / 2;
      var y = r.bottom + 6 + h <= vh - 8 ? r.bottom + 6 : r.top - 6 - h;
      linkMenu.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
      linkMenu.style.top = Math.max(8, Math.min(y, vh - h - 8)) + "px";
      linkMenu.style.visibility = "";
      linkOpen = true;
    }

    function closeLinkMenu() {
      if (!linkOpen) return;
      linkOpen = false;
      linkMenu.classList.add("hidden");
      linkMenu.innerHTML = "";
    }

    /** A code block's wrapping on or off, and its button saying which. */
    function wrapCode(block, on) {
      block.querySelector("pre.code").classList.toggle("nowrap", !on);
      var b = block.querySelector("[data-wrapcode]");
      b.setAttribute("aria-pressed", String(on));
      b.textContent = on ? S.wrapOn : S.wrapOff;
    }
    /** Clicks in message text: links, code block wrapping and copying. True when handled. */
    function textClick(e) {
      var wc = e.target.closest("[data-wrapcode]");
      if (wc) {
        var block = wc.closest(".codeblock"), on = block.querySelector("pre.code").classList.contains("nowrap");
        wrapCode(block, on);
        var row = feed.contains(block) && block.closest(".msg[data-seq]");
        if (row) {
          var seq = Number(row.dataset.seq), i = Array.prototype.indexOf.call(row.querySelectorAll(".codeblock"), block);
          var off = nowrap.get(seq) || new Set();
          if (on) off.delete(i); else off.add(i);
          if (off.size) nowrap.set(seq, off); else nowrap.delete(seq);
        }
        return true;
      }
      var cc = e.target.closest("[data-copycode]");
      if (cc) {
        var code = cc.closest(".codeblock").querySelector("code");
        copy(code ? code.textContent : "", S.copiedCode);
        return true;
      }
      var a = e.target.closest("a.lnk");
      // A modified or middle click keeps the browser's own behaviour (open in a new tab and the like).
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return false;
      e.preventDefault();
      openLinkMenu(a, e);
      return true;
    }

    // ---------- the feed's listeners: room.js calls listen() where it attached them before ----------

    function listen() {
      linkMenu.addEventListener("click", function (e) {
        if (e.target.closest("[data-linkcopy]")) {
          var href = linkMenu.dataset.href;
          closeLinkMenu();
          return copy(href, S.copiedLink);
        }
        // Open is a real link (the browser opens it in a new tab); the menu closes after it has gone.
        if (e.target.closest("[data-linkopen]")) setTimeout(closeLinkMenu, 0);
      });

      feed.addEventListener("click", function (e) {
        var unfold = e.target.closest("[data-unfold]");
        if (unfold) {
          unfolded.add(Number(unfold.closest(".msg[data-seq]").dataset.seq));
          unfold.previousElementSibling.classList.remove("fm-fold");
          unfold.remove();
          return;
        }
        var tick = e.target.closest(".fm-top .rc");
        if (tick) return toast(tick.textContent);
        var scheduled = e.target.closest("[data-schedule-id]");
        if (scheduled) return openSchedule(scheduled.dataset.scheduleId);
        if (textClick(e)) return;
        var rt = e.target.closest("[data-retry]");
        if (rt) return retrySend(rt.dataset.retry);
        var tk = e.target.closest("[data-takeover]");
        if (tk) return callBack(tk.dataset.takeover);
        var ed = e.target.closest("[data-edit]");
        if (ed) return editSend(ed.dataset.edit);
        var openedItem = e.target.closest('[data-open-item]');
        if (openedItem) return openItem(openedItem.dataset.openItem);
        var dm = e.target.closest("[data-menu]");
        if (dm) {
          var seq = Number(dm.dataset.menu);
          if (selSeq === seq) return exitSelect();
          if (menuSeq === seq) return closeMenu();
          return openMenu(seq, { rect: dm.getBoundingClientRect() });
        }
        var sb = e.target.closest("[data-sel]");
        if (sb) return selAct(sb.dataset.sel);
        var cs = e.target.closest("[data-copyseq]");
        if (cs) return copy("#" + cs.dataset.copyseq, fill(S.copiedSeq, { n: cs.dataset.copyseq }));
        var j = e.target.closest("[data-jump]");
        if (j) {
          e.preventDefault();
          jumpTo(Number(j.dataset.jump), cardOf(j));
        }
      });

      // A long press on a card opens its menu on touch screens (where card text is not selectable).
      // The release of a long press can click the menu or scrim that appeared under that finger.
      var press = null, ignoreLongPressClick = false;
      document.addEventListener('pointerdown', function () { ignoreLongPressClick = false; }, true);
      feed.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "mouse" || selSeq != null) return;
        var c = cardOf(e.target);
        if (!c || e.target.closest("a, button, img")) return;
        var p = { x: e.clientX, y: e.clientY, seq: Number(c.dataset.seq) };
        p.timer = setTimeout(function () { press = null; openMenu(p.seq, { x: p.x, y: p.y }); ignoreLongPressClick = true; }, 450);
        press = p;
      });
      function cancelPress() { if (press) { clearTimeout(press.timer); press = null; } }
      feed.addEventListener("pointermove", function (e) {
        if (press && (Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8)) cancelPress();
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) { feed.addEventListener(t, cancelPress); });
      // Right-click on a card (or the press that a phone reports as one): the same menu. The browser's own
      // menu stays for links, images, a card being selected, and text already selected in the card.
      feed.addEventListener("contextmenu", function (e) {
        var c = cardOf(e.target);
        if (!c) return;
        var seq = Number(c.dataset.seq);
        if (selSeq === seq || e.target.closest("a, img") || selectedIn(c)) return;
        e.preventDefault();
        var fromTouchPress = !!press;
        cancelPress();
        if (menuSeq !== seq) {
          openMenu(seq, { x: e.clientX, y: e.clientY });
          if (fromTouchPress) ignoreLongPressClick = true;
        }
      });
      document.addEventListener('click', function (e) {
        if (!ignoreLongPressClick) return;
        ignoreLongPressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }, true);
      menu.addEventListener("click", function (e) {
        var b = e.target.closest("[data-act]");
        if (b) menuAct(b.dataset.act, menuSeq);
      });
      menuScrim.addEventListener("click", closeMenu);
      document.addEventListener("click", function (e) {
        if (linkOpen && !e.target.closest("#linkmenu")) closeLinkMenu();
        if (menuSeq == null || e.target.closest("#msgmenu, [data-menu]")) return;
        // The click a phone sends right after a long press lands on the pressed card: not a dismissal.
        if (Date.now() - menuOpenedAt < 700 && cardOf(e.target) && Number(cardOf(e.target).dataset.seq) === menuSeq) return;
        closeMenu();
      }, true);

      var lastTop = 0;
      feed.addEventListener("scroll", function () {
        // Scrolling up (by the reader, not by the page) near the top loads earlier messages without a tap.
        var up = feed.scrollTop < lastTop, down = feed.scrollTop > lastTop;
        lastTop = feed.scrollTop;
        closeMenu();
        closeLinkMenu();
        cancelPress();
        if (up && feed.scrollTop < EDGE) loadEarlier();
        // Down near the window's bottom: the rows after it, from memory or the server (rule 1 of docs/web.md).
        if (down && feed.scrollHeight - feed.scrollTop - feed.clientHeight < EDGE) reachBottom();
        pruneTrail();
        updateJump();
        maybeMark();
      });
      $("jump").onclick = jumpDown;
      $("jump-at").onclick = function () {
        var unread = unreadForMe();
        if (unread.length) jumpTo(unread[0].seq);
        else openPanel("at");
      };
      $("back").onclick = goBack;
      if ($("jump-unread")) $("jump-unread").onclick = function () {
        var seq = firstUnread;
        firstUnread = null;
        updateJump();
        if (seq) jumpTo(seq);
      };
      document.addEventListener("visibilitychange", maybeMark);
      if (window.ResizeObserver) new ResizeObserver(feedResized).observe(feed);
    }

    return {
      // Sparse history is owned by the filter; only its lookup entries belong in the feed index.
      indexSparse: function (list) { list.forEach(function (m) { state.bySeq.set(m.seq, m); }); },
      dropSparse: function (list) { list.forEach(function (m) { if (state.bySeq.get(m.seq) === m) state.bySeq.delete(m.seq); }); },
      anchor: anchor,
      restore: restore,
      renderMessage: renderMessage,
      refreshTop: refreshTop,
      append: append,
      avatar: avatar,
      closeLinkMenu: closeLinkMenu,
      closeMenu: closeMenu,
      exitSelect: exitSelect,
      filesChanged: filesChanged,
      fmtTime: fmtTime,
      formeRows: function () { return formeRows.map(function (seq) { return $("m" + seq); }); },
      growUp: growUp,
      goBack: goBack,
      helloMe: helloMe,
      helloMessages: helloMessages,
      jumpDown: jumpDown,
      jumpSearch: jumpSearch,
      jumpTo: jumpTo,
      kindLabel: kindLabel,
      lastSeq: lastSeq,
      linkOpen: function () { return linkOpen; },
      listen: listen,
      loadEarlier: loadEarlier,
      maybeMark: maybeMark,
      menuHook: menuHook,
      menuOpen: function () { return menuSeq != null; },
      myCursor: myCursor,
      names: names,
      nearBottom: nearBottom,
      placeTimes: placeTimes,
      pruneTrail: pruneTrail,
      quoteHtml: quoteHtml,
      readLine: readLine,
      readLinesMoved: readLinesMoved,
      refreshReadLines: refreshReadLines,
      rowHook: rowHook,
      rowName: rowName,
      selecting: function () { return selSeq != null; },
      textClick: textClick,
      unreadForMe: unreadForMe,
      unreadFromMentions: unreadFromMentions,
      updateJump: updateJump,
      updated: updated,
    };
  };
})();
