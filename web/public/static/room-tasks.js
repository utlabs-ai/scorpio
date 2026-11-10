(function () {
  "use strict";

  window.createRoomTasks = function (ctx) {
    "use strict";
    var $ = ctx.$, S = ctx.S, agentsRunning = ctx.agentsRunning, ago = ctx.ago, ask = ctx.ask, avatar = ctx.avatar, boot = ctx.boot, canWrite = ctx.canWrite, feed = ctx.feed, fill = ctx.fill, flash = ctx.flash, fmtTime = ctx.fmtTime, names = ctx.names, openPanel = ctx.openPanel, panels = ctx.panels, post = ctx.post, quotaNow = ctx.quotaNow, refreshPanel = ctx.refreshPanel, rowName = ctx.rowName, shownName = ctx.shownName, state = ctx.state, shell = ctx.shell, toast = ctx.toast, updateChips = ctx.updateChips, viewer = ctx.viewer, waitingOnMe = ctx.waitingOnMe;
    // The tasks' one setter (room-store.js): only the tasks write state.todo. It is used only on a write, so tasks
    // made without it (the goldens) still draw.
    var writeTodo = ctx.writeTodo;

    // ---------- the TODO under the message that opened it ("T6 · 要 kai 做", docs/api/tasks.md) ----------

    /**
     * The items a message carries, each with rel: source (it opened them) or result (it delivered them). A message that
     * only joined an item's thread (a person's reply, rel reply; a reply or a T number, rel thread) shows nothing
     * here and offers 「加到 TODO」, not 「看 T6」: the item keeps its own state.
     * The current list has the latest state for visible items; older items keep their message snapshot until their
     * detail is fetched by number.
     */
    function itemsOf(m) {
      var out = [], seen = {};
      function add(i, rel) {
        var k = i.id + ":" + rel;
        if (seen[k]) return;
        seen[k] = 1;
        var live = state.todo.items.find(function (x) { return x.id === i.id; }) || (doneFull && doneFull[i.id]);
        var x = Object.assign({}, live || i, { rel: rel });
        if (isDone(x.id)) x.status = "done"; // done ones come as ids
        out.push(x);
      }
      (m.todo || []).forEach(function (i) { if (i.rel !== "reply" && i.rel !== "thread") add(i, i.rel || "source"); });
      state.todo.items.forEach(function (i) {
        if (i.createdSeq === m.seq) add(i, "source");
        if (i.doneSeq === m.seq) add(i, "result");
      });
      return out;
    }
    function todoLine(m) {
      var list = itemsOf(m);
      if (!list.length) return "";
      return '<div class="todoline">' + list.map(function (i) {
        var me = i.assignee === state.me;
        var closed = i.status === "done" || i.rel === "result";
        var st = i.rel === "result" ? fill(S.tl_result, { id: i.id })
          : closed ? S.tl_done
          : i.status === "doing" ? (me ? S.youDoing : fill(S.tl_doing, { who: i.assignee || "" }))
          : i.assignee ? (me ? S.forYou : fill(S.tl_todo, { who: i.assignee })) : S.tl_nobody;
        var ring = closed ? 'done' : i.status === 'doing' ? 'doing' : me && i.rel === 'source' ? 'you' : i.blocked ? 'wait' : 'todo';
        return '<button type="button" class="ichip' + (me && i.rel === 'source' && !closed ? ' you' : '') +
          (closed ? ' closed' : '') + '" data-open-item="' + escapeHtml(i.id) + '"><span class="ck sm ' + ring + '"></span><b>' + escapeHtml(i.id) +
          '</b><span>· ' + escapeHtml(st) + '</span>' + (i.rel !== 'result' ? '<span class="t">' + escapeHtml(i.title || '') + '</span>' : '') +
          '<span class="chev">›</span></button>';
      }).join("") + "</div>";
    }
    /**
     * What a row's task line shows of each item, by id, as of the last refresh: an item whose entry changed is redrawn
     * under the messages it names (createdSeq, doneSeq, the message's own todo), and no other line (docs/web.md rule 2).
     */
    var drawnItems = {};
    function itemEntries() {
      var out = {};
      function put(i) { out[i.id] = { key: JSON.stringify([i.status, i.assignee, i.title, !!i.blocked, isDone(i.id)]), seqs: [i.createdSeq, i.doneSeq] }; }
      state.todo.items.forEach(put);
      if (doneFull) Object.keys(doneFull).forEach(function (id) { if (!out[id]) put(doneFull[id]); });
      return out;
    }
    /** After the TODO changed: the lines under the messages its changed items name, the chips, an open panel. */
    function refreshTodo() {
      var now = itemEntries(), was = drawnItems, changed = {}, seqs = {}, any = false;
      drawnItems = now;
      function mark(id) {
        any = changed[id] = true;
        [was[id], now[id]].forEach(function (e) { if (e) e.seqs.forEach(function (s) { if (s) seqs[s] = true; }); });
      }
      Object.keys(now).forEach(function (id) { if (!was[id] || was[id].key !== now[id].key) mark(id); });
      Object.keys(was).forEach(function (id) { if (!now[id]) mark(id); });
      // The window's rows only (room-feed.js keeps them bounded); a row is written only when its line changed.
      if (any) feed.querySelectorAll(".msg[data-seq]").forEach(function (el) {
        var m = state.bySeq.get(Number(el.dataset.seq));
        if (!m || m.fromKind === "system") return;
        if (seqs[m.seq] || (m.todo || []).some(function (i) { return changed[i.id]; })) redrawTodo(el, m);
      });
      updateChips();
      refreshPanel();
    }
    function redrawTodo(el, m) {
      var old = el.querySelector(".todoline"), html = todoLine(m);
      if ((old ? (old.drawn != null ? old.drawn : old.outerHTML) : "") === html) return;
      // The line sits first in the card's foot, above the delivery notes.
      if (old && html) old.insertAdjacentHTML("afterend", html);
      else if (html) {
        var foot = el.querySelector(".fm-foot");
        if (foot) foot.insertAdjacentHTML("afterbegin", html);
      }
      if (old) old.remove();
      var line = html && el.querySelector(".todoline");
      if (line) line.drawn = html;
    }

    /**
     * One item, read-only: people change the TODO by saying so in the room. The circle only shows the
     * state; an item under my name is marked done from its details (a tap on the circle finished it by mistake).
     */
    function itemHtml(it) {
      var pending = !!pendingDone[it.id];
      var status = pending ? "done" : it.status;
      var mine = it.assignee === state.me && it.status !== "done";
      var am = it.assignee && state.members.find(function (m) { return m.name === it.assignee; });
      var ring = status === 'done' ? 'done' : mine ? 'you' : status === 'doing' ? 'doing' : it.blocked ? 'wait' : 'todo';
      var bot = am && am.kind === 'agent' ? '<span class="ex">' + botStill(am.name, '', 's16') + '</span>' : '';
      var result = status === 'done' && it.doneSeq ? '<a href="#m' + it.doneSeq + '" data-jump="' + it.doneSeq + '">' + S.seeResult + '</a>' : '';
      // A row waiting on me says who asks and the first line of what they ask now
      var meta = status === 'done' ? ago(it.doneMs || it.updatedMs) : it.blocked ? escapeHtml(fill(S.waitsFor, { ids: (it.blockedBy || []).join('、') })) :
        it.assignee ? (mine ? (it.current ? '<b>' + lineWho(it.current.from) + '</b> ' + escapeHtml(it.current.line || '') : '') : escapeHtml(it.assignee)) : S.nobodyOn;
      return '<li class="it ' + ring + '" data-item="' + escapeHtml(it.id) + '">' +
        '<span class="ck ' + ring + '"></span>' +
        '<div class="t"><span class="id">' + escapeHtml(it.id) + '</span>' + escapeHtml(it.title) +
        (meta || result ? '<small class="itemmeta' + (mine && !it.blocked && it.current && status !== 'done' ? ' ask' : '') + '">' + meta + (result ? (meta ? ' · ' : '') + result : '') + '</small>' : '') + '</div>' + bot + '</li>';
    }

    var RECENT_DONE_MS = 24 * 60 * 60 * 1000;
    function visibleTodoItems() {
      var cutoff = Date.now() - RECENT_DONE_MS;
      return state.todo.items.filter(function (item) {
        return item.status !== 'done' || (item.doneMs != null && Number(item.doneMs) >= cutoff);
      });
    }

    function todoGroups() {
      var items = visibleTodoItems(), waiting = waitingOnMe();
      var mine = items.filter(function (item) { return item.assignee === state.me && item.status !== 'done' && !pendingDone[item.id]; });
      var doing = items.filter(function (item) { return item.status === 'doing' && item.assignee !== state.me && !pendingDone[item.id]; });
      var todo = items.filter(function (item) { return item.status === 'todo' && item.assignee !== state.me && !pendingDone[item.id]; });
      var mineDone = items.filter(function (item) { return item.status === 'done' || pendingDone[item.id]; });
      var done = mineDone, doneCount = mineDone.length;
      if (state.todo.done) {
        // The frame lists today's done items as ids; mine just finished (an answer, the undo window) may not be in it yet.
        var ids = state.todo.done.slice();
        mineDone.forEach(function (item) { if (ids.indexOf(item.id) < 0) ids.unshift(item.id); });
        doneCount = ids.length;
        done = ids.map(function (id) { return mineDone.find(function (item) { return item.id === id; }) || (doneFull && doneFull[id]); }).filter(Boolean);
      }
      var open = items.filter(function (item) { return item.status !== 'done' && !pendingDone[item.id]; });
      return { items: open, waiting: waiting, mine: mine, doing: doing, todo: todo, done: done, doneCount: doneCount };
    }

    function todoHtml() {
      var groups = todoGroups(), waiting = groups.waiting;
      var summary = fill(S.todoSummary, { waiting: waiting.count, running: agentsRunning(), doing: groups.doing.length, todo: groups.todo.length, done: groups.doneCount });
      var body = '';
      if (!groups.items.length && !waiting.stuck.length && !groups.doneCount) {
        body = '<p class="muted">' + S.todoEmpty + '</p>';
      } else {
        if (waiting.count) body += '<div class="grp you">' + escapeHtml(S.forYouH) + ' ' + waiting.count + '</div><ul class="items">' + waiting.stuck.map(function (m) {
          var approval = ctx.approvalFor && ctx.approvalFor(m.name);
          return '<li class="it you"><span class="ck you"></span>' +
            (approval ? '<button type="button" class="t apv-task-link" data-approval-link="' + escapeHtml(approval) + '">' : '<div class="t">') + escapeHtml(m.name) +
            '<span class="sub2">' + escapeHtml(approval ? S.apv.task : m.workReason || S.blockedAgent) + '</span>' + (approval ? '</button>' : '</div>') + '</li>';
        }).join('') + groups.mine.map(itemHtml).join('') + '</ul>';
        if (groups.doing.length) body += '<div class="grp">' + escapeHtml(S.doingH) + ' ' + groups.doing.length + '</div><ul class="items">' + groups.doing.map(itemHtml).join('') + '</ul>';
        var ready = groups.todo.filter(function (item) { return !item.blocked; }).length;
        if (groups.todo.length) body += '<div class="grp">' + escapeHtml(S.todoH) + ' ' + groups.todo.length + (ready < groups.todo.length ? ' · ' + escapeHtml(fill(S.readyN, { n: ready })) : '') + '</div><ul class="items">' + groups.todo.map(itemHtml).join('') + '</ul>';
        // Today's done ones fold: opening them fetches the full list when the frame only names them.
        if (groups.doneCount) {
          body += '<button type="button" class="grp grp-fold' + (doneOpen ? ' open' : '') + '" data-done-fold aria-expanded="' + doneOpen + '">' +
            S.doneToday + groups.doneCount + '<span class="chev" aria-hidden="true">›</span></button>';
          if (doneOpen) {
            if (groups.done.length) body += '<ul class="items">' + groups.done.map(itemHtml).join('') + '</ul>';
            if (groups.done.length < groups.doneCount) body += '<p class="muted grp-note">' + escapeHtml(doneError ? S.doneFailed : S.doneLoading) + '</p>';
          }
        }
      }
      return '<div class="fixed"><p class="nums">' + escapeHtml(summary) + '</p></div><div class="scroll">' + body + '</div>';
    }

    /** The main column as it should be: the feed, the jump pills, and the composer unless the topic is archived, out of messages, or only viewed (as applyRoom decides). */
    function renderMain() {
      feed.classList.remove('hidden');
      var q = quotaNow(), out = !state.room.archived && !viewer && q && q.used >= q.limit;
      $("composer").classList.toggle('hidden', state.room.archived || !!out || viewer);
      document.querySelector('.jumps').classList.remove('hidden');
    }
    var itemRequest = 0, itemShown = null, threadOpen = false, oldDescOpen = false;
    function closeItem() {
      itemRequest++;
      itemShown = null;
      ctx.clearPopEdit();
      $("item-scrim").classList.add('hidden');
      $("item-panel").classList.add('hidden');
      $("item-panel").innerHTML = '';
    }
    function openItem(id) {
      var request = ++itemRequest;
      var detailItems = visibleTodoItems();
      var it = detailItems.find(function (item) { return item.id === id; });
      threadOpen = oldDescOpen = false;
      if (it) showItem(it, detailItems, null);
      // The thread and its messages come only with the item's detail; search may point at an item outside the visible list.
      fetch('/r/' + boot.roomId + '/todo?item=' + encodeURIComponent(id), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.next || S.searchError); return j; }); })
        .then(function (j) {
          if (request !== itemRequest) return;
          if (it && ($("item-panel").classList.contains('hidden') || $("item-panel").dataset.itemId !== id)) return;
          showItem(j.item, detailItems, j);
        }, function (e) { if (request === itemRequest && !it) flash(e.message || S.searchError); });
    }
    /** Who said a line of a thread: 你, a person by nickname, an agent by role (its account only when not mine), as rows show them. */
    function lineWho(name) {
      if (name === state.me) return escapeHtml(S.you);
      var member = state.members.find(function (x) { return x.name === name; });
      return rowName(name, member ? member.kind : name.indexOf('@') > 0 ? 'agent' : 'human');
    }
    /** A message's first line as written (its first file's name when it has no text). */
    function firstLine(m) {
      if (!m) return '';
      var t = String(m.text || '').trim().split('\n')[0].replace(/\s+/g, ' ').trim();
      return t || (m.files || []).map(function (f) { return typeof f === 'string' ? f : f.name; }).join(' · ');
    }
    /** A message's text as plain words for an excerpt: its Markdown read, the blocks run together (its first file's name when it has no text). */
    function plainText(m) {
      var box = document.createElement('div');
      box.innerHTML = renderMarkdown(String(m.text || ''), names(), state.me);
      var parts = [];
      box.querySelectorAll('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6').forEach(function (el) { if (!el.querySelector('p, li')) parts.push(el.textContent); });
      var t = (parts.length ? parts.join(' ') : box.textContent).replace(/\s+/g, ' ').trim();
      return t || firstLine(m);
    }
    /**
     * The latest ask: its row's top line (who, #n, time) and the start of its text, three lines at most, on
     * the quote tint; the whole card is one tap to that message in the feed, which lights up. The message itself is read there.
     */
    function askCard(m) {
      return '<a class="tcur" href="#m' + m.seq + '" data-jump="' + m.seq + '"><span class="fm-av">' + avatar(m) + '</span><span class="fm-col"><span class="fm-top"><b class="who">' + rowName(m.from, m.fromKind, m.displayName) + '</b>' +
        '<span class="sp"></span><span class="seq">#' + m.seq + '</span><time>' + fmtTime(m.ts) + '</time><span class="chev" aria-hidden="true">›</span></span>' +
        '<span class="tx">' + escapeHtml(plainText(m)) + '</span></span></a>';
    }
    function threadFold(key, label, open, inner) {
      return '<div class="tfold"><button type="button" class="grp grp-fold' + (open ? ' open' : '') + '" data-tfold="' + key + '" aria-expanded="' + open + '">' + label +
        '<span class="chev" aria-hidden="true">›</span></button>' + (open ? inner : '') + '</div>';
    }
    /**
     * An item's detail is its thread: the latest ask (`current`) first and in full,
     * the assignee's answer under it while it waits, everything earlier folded to one line each with the title and assignee
     * changes between them, then who and what as before. detail: the item's GET (thread, messages, history), or null until it comes.
     */
    function showItem(it, detailItems, detail) {
      detailItems = detailItems || visibleTodoItems();
      itemShown = { it: it, detailItems: detailItems, detail: detail };
      var zh = boot.lang === 'zh', mine = it.assignee === state.me && it.status !== 'done';
      var stateName = it.status === 'done' ? S.tl_done : mine ? S.forYou : it.status === 'doing' ? S.doingH : it.blocked ? S.cantStart :
        it.assignee ? fill(S.tl_todo, { who: it.assignee }) : S.todoH;
      var ring = it.status === 'done' ? 'done' : mine ? 'you' : it.status === 'doing' ? 'doing' : it.blocked ? 'wait' : 'todo';
      var pre = (it.blockedBy || []).map(function (key) { return detailItems.find(function (item) { return item.id === key; }); }).filter(Boolean);
      var blocked = detailItems.filter(function (item) { return (item.blockedBy || []).indexOf(it.id) >= 0; });
      var row = function (label, content) { return '<dt>' + label + '</dt><dd>' + content + '</dd>'; };
      var itemLink = function (item) { return '<button type="button" data-item="' + escapeHtml(item.id) + '">' + escapeHtml(item.id + ' ' + item.title) + '</button>'; };
      var full = {};
      (detail && detail.messages || []).forEach(function (m) { full[m.seq] = { seq: m.seq, from: m.from, fromKind: m.kind, text: m.text, files: m.files, ts: m.ts }; });
      var msgOf = function (seq) { return full[seq] || state.bySeq.get(seq) || null; };
      var thread = detail ? it.thread || [] : null;
      // What they are asked now; with no such message (an item of their own) the item's source stands in.
      var leadSeq = it.current ? it.current.seq : it.createdSeq, lead = leadSeq ? msgOf(leadSeq) : null;
      var ask = !leadSeq ? '' : '<div class="tlbl">' + escapeHtml(S.askNow) + '</div>' + (lead ? askCard(lead) :
        '<a class="fm-q tcur-wait" href="#m' + leadSeq + '" data-jump="' + leadSeq + '"><b>' + lineWho(it.current ? it.current.from : it.createdBy || '') + '</b><span class="qs">#' + leadSeq + '</span>' +
        '<span class="qx">' + escapeHtml(it.current ? it.current.line || '' : '') + '</span></a>');
      // Only the assignee speaks after the ask: their latest message shows under it, and whom it waits for while it waits.
      var later = (thread || []).filter(function (t) { return t.seq > leadSeq; });
      var answer = it.reply ? { seq: it.reply.seq, from: it.reply.from } : later.length ? later[later.length - 1] : null;
      var answerHtml = !answer ? '' : '<a class="fm-q tans" href="#m' + answer.seq + '" data-jump="' + answer.seq + '"><b>' +
        (answer.from === state.me ? escapeHtml(S.youAnswered) : fill(escapeHtml(S.nameAnswered), { name: lineWho(answer.from) })) + '</b><span class="qs">#' + answer.seq + '</span>' +
        '<span class="qx">' + escapeHtml(firstLine(msgOf(answer.seq))) + '</span></a>' +
        // whom it waits for; not when that is the one who answered (their own task, answering a person: a task's closer is its creator)
        (it.reply && it.reply.closer && it.reply.closer !== it.reply.from ? '<p class="twait">' + fill(escapeHtml(S.waitingOn), { name: lineWho(it.reply.closer) }) + '</p>' : '');
      // Everything else, by time: the thread's messages one line each, and where the title or the assignee changed.
      var rows = [], said = 0;
      (thread || []).forEach(function (t) {
        if (t.seq === leadSeq || (answer && t.seq === answer.seq)) return;
        said++;
        rows.push({ ts: t.ts, html: '<a class="fm-q trow" href="#m' + t.seq + '" data-jump="' + t.seq + '"><b>' + lineWho(t.from) + '</b><span class="qs">#' + t.seq + '</span>' +
          '<span class="qx">' + escapeHtml(firstLine(msgOf(t.seq))) + '</span></a>' });
      });
      var title = null, assignee;
      (detail && detail.history || []).forEach(function (h) {
        var to = h.to || {};
        if (h.op === 'add') { title = to.title; assignee = to.assignee; return; }
        if (to.title != null && title != null && to.title !== title) rows.push({ ts: h.ms, html: '<p class="tchg">' + fill(escapeHtml(S.renamedTo), { name: lineWho(h.by), title: escapeHtml(to.title) }) + '</p>' });
        // taking it oneself is not a change to tell (task take)
        if (to.assignee !== undefined && assignee !== undefined && to.assignee !== assignee && to.assignee !== h.by) rows.push({ ts: h.ms, html: '<p class="tchg">' + fill(escapeHtml(S.gaveTo), { name: lineWho(h.by), who: to.assignee ? lineWho(to.assignee) : '—' }) + '</p>' });
        if (to.title != null) title = to.title;
        if (to.assignee !== undefined) assignee = to.assignee;
      });
      rows.sort(function (a, b) { return a.ts - b.ts; });
      var earlier = said ? threadFold('thread', escapeHtml(fill(S.earlierN, { n: said })), threadOpen, '<div class="trows">' + rows.map(function (r) { return r.html; }).join('') + '</div>') : '';
      // A description from before item threads is read only, folded; not when it only repeats the ask.
      var oldDesc = it.desc && (!lead || it.desc !== String(lead.text || '').slice(0, 8000)) ?
        threadFold('desc', escapeHtml(S.oldDesc), leadSeq ? oldDescOpen : !oldDescOpen, '<div class="desc md">' + renderMarkdown(it.desc, names(), state.me) + '</div>') : '';
      var result = it.doneSeq ? '<a href="#m' + it.doneSeq + '" data-jump="' + it.doneSeq + '">' + S.seeResult + '</a>' : '<span class="sub">' + S.itemNotYet + '</span>';
      var html = '<div class="grab"></div><header class="sh"><span class="sp"></span><button type="button" class="x" data-close-item aria-label="' + escapeHtml(S.itemClose) + '">×</button></header>' +
        '<div class="sbody"><div class="itemhead"><span class="ck sm ' + ring + '"></span><span>' + escapeHtml(stateName) + '</span><span class="id">· ' + escapeHtml(it.id) + '</span></div>' +
        '<h3>' + escapeHtml(it.title) + '</h3>' + ask + answerHtml + earlier + oldDesc + '<dl class="kv">' +
        row(S.itemFrom, shownName(it.createdBy || '')) +
        row(S.itemAssigned, it.assignee ? shownName(it.assignee) : S.tl_nobody) +
        row(S.itemNeeds, pre.length ? pre.map(itemLink).join(', ') : '<span class="sub">—</span>') +
        row(S.itemBlocks, blocked.length ? blocked.map(itemLink).join(', ') : '<span class="sub">—</span>') +
        row(S.itemDelivery, result) + '</dl>' +
        (mine && canWrite() ? '<div class="acts"><button type="button" class="btn wide primary" data-item-done="' + escapeHtml(it.id) + '">' + escapeHtml(S.itemDone) + '</button><button type="button" class="btn wide" data-close-item>' + escapeHtml(S.itemClose) + '</button></div>' : '') + '</div>';
      // Drawn again when its detail comes or a fold opens: where the reader was stays.
      var same = $("item-panel").dataset.itemId === it.id && !$("item-panel").classList.contains('hidden');
      var body = $("item-panel").querySelector('.sbody'), top = same && body ? body.scrollTop : 0;
      $("item-panel").innerHTML = html;
      $("item-panel").dataset.itemId = it.id;
      if (top) $("item-panel").querySelector('.sbody').scrollTop = top;
      $("item-scrim").classList.remove('hidden');
      $("item-panel").classList.remove('hidden');
    }
    function toggleThreadFold(key) {
      if (!itemShown) return;
      if (key === 'desc') oldDescOpen = !oldDescOpen;
      else threadOpen = !threadOpen;
      showItem(itemShown.it, itemShown.detailItems, itemShown.detail);
    }

    // ---------- marking my item done: sent after 5 seconds unless undone ----------

    var pendingDone = {};   // id -> timer

    function markDone(id) {
      if (pendingDone[id]) return;
      pendingDone[id] = setTimeout(function () {
        post("todo", { op: "done", id: id }).then(function (r) { takeAnswer(r.item); offerUnblocked(r.unblocked || []); }, function (e) { flash(e.next || e.message || String(e)); })
          .then(function () { delete pendingDone[id]; refreshTodo(); });
      }, 5000);
      showUndo(id);
      refreshTodo();
    }

    /*
     * Items as the answers to my own changes left them. The room's todo frame comes about a second after a
     * change, so the answer goes into the list at once; and a frame older than an answer (each change stamps
     * updatedMs) cannot put the old state back. Without this a delivered item came back for that second.
     */
    var answered = {}; // id -> item

    /*
     * Today's done items: the frame names them in `done`; the list itself is GET /r/:id/todo (the full one),
     * fetched when the person opens 已完成 and again while it is open whenever `done` gains an id. Open or folded is
     * remembered in this browser.
     */
    var doneOpen = false, doneFull = null, doneSeen = [], doneFetching = false, doneAgain = false, doneError = false;
    try { doneOpen = localStorage.getItem("scorpio.doneOpen") === "1"; } catch (e) {}
    function isDone(id) {
      return !!(state.todo.done && state.todo.done.indexOf(id) >= 0);
    }
    function doneMaybeStale() {
      if (!doneOpen || !state.todo.done) return;
      if (!doneFull || state.todo.done.some(function (id) { return doneSeen.indexOf(id) < 0; })) fetchDone();
    }
    function fetchDone() {
      if (doneFetching) { doneAgain = true; return; }
      doneFetching = true;
      var want = (state.todo.done || []).slice();
      fetch("/r/" + boot.roomId + "/todo", { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); })
        .then(function (j) {
          doneFull = {};
          (j.items || []).forEach(function (i) { if (i.status === "done") doneFull[i.id] = i; });
          doneSeen = want;
          doneError = false;
        }, function () { doneError = true; })
        .then(function () {
          doneFetching = false;
          if (doneAgain) { doneAgain = false; return fetchDone(); }
          refreshTodo();
        });
    }
    function toggleDone() {
      doneOpen = !doneOpen;
      try { localStorage.setItem("scorpio.doneOpen", doneOpen ? "1" : "0"); } catch (e) {}
      if (doneOpen && doneError) doneFull = null; // a tap after a failed fetch tries again
      doneMaybeStale();
      updateChips();
      refreshPanel();
    }
    function takeAnswer(item) {
      if (!item || !item.id) return;
      answered[item.id] = item;
      var had = false;
      var next = state.todo.items.map(function (x) { if (x.id !== item.id) return x; had = true; return item; });
      if (!had) next.push(item);
      writeTodo({ items: next, done: state.todo.done });
    }
    /** A frame's items, each kept unless an answer of mine is newer; an answer the frame has caught up with is let go.
     *  done: a frame that lists the id as done has caught up with an answer that finished it. */
    function newestItems(items, done) {
      (done || []).forEach(function (id) {
        if (!answered[id] || answered[id].status !== "done") return;
        // It leaves the frame's items for its done list: an open 已完成 keeps showing it until the refetch brings it.
        if (doneFull && !doneFull[id]) doneFull[id] = answered[id];
        delete answered[id];
      });
      return items.map(function (x) {
        var a = answered[x.id];
        if (!a) return x;
        if ((x.updatedMs || 0) >= (a.updatedMs || 0)) { delete answered[x.id]; return x; }
        return a;
      });
    }
    /** A hello or todo frame's list: kept as newestItems says, then the open 已完成 refetched if it fell behind. */
    function applyTodo(items, done) {
      writeTodo({ items: newestItems(items, done), done: done || null });
      doneMaybeStale();
    }

    function showUndo(id) {
      shell.status("undo", escapeHtml(fill(S.doneUndo, { title: itemTitle(id) })) + ' <button type="button" class="link" data-undo="' + id + '">' + S.undo + "</button>", { html: true, ms: 5200 });
    }

    /** After finishing an item: say which items can start now, and offer one @ message to their assignees. */
    function offerUnblocked(list) {
      if (!list.length) return;
      var who = list.map(function (u) { return u.assignee; }).filter(function (n, i, a) { return n && a.indexOf(n) === i; });
      var ids = list.map(function (u) { return u.id; }).join("、");
      shell.status("undo", escapeHtml(fill(S.canStart, { ids: ids })) +
        (who.length ? ' <button type="button" class="link" data-notify="' + escapeHtml(JSON.stringify({ who: who, list: list })) + '">' + escapeHtml(fill(S.notifyWho, { who: who.map(function (n) { return n.split("@")[0]; }).join("、") })) + "</button>" : ""), { html: true, ms: 15000 });
    }

    function itemTitle(id) {
      var it = state.todo.items.find(function (i) { return i.id === id; });
      return it ? it.title : id;
    }

    // ---------- the message menu's task items: see the tasks a message carries, or add one from it ----------

    function todoMenu(m) {
      var carried = itemsOf(m).map(function (i) { return i.id; }).filter(function (id, k, a) { return a.indexOf(id) === k; });
      if (carried.length) return [{ act: "seetodo", label: fill(S.menuSeeTodo, { ids: carried.join("、") }), icon: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="m8 12 2 2 5-5"/></svg>', run: function () { return openPanel("plan"); } }];
      if (canWrite()) return [{ act: "addtodo", label: S.menuAddTodo, hint: S.menuAddTodoHint, icon: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M12 9v6M9 12h6"/></svg>', run: function (m) { return addToTodo(m.seq); } }];
      return [];
    }

    /** 「加到 TODO」: the first sentence is a starting title; the person may shorten or change it. */
    function addToTodo(seq) {
      var m = state.bySeq.get(seq);
      if (!m) return;
      var line = String(m.text || '').replace(/^(\s*@[A-Za-z0-9_.@-]+)*\s*/, '').split('\n').map(function (x) { return x.trim(); }).find(Boolean) || '';
      var title = line || (m.files && m.files[0] && m.files[0].name) || '#' + seq;
      title = Array.from(title).length > 80 ? Array.from(title).slice(0, 79).join('') + '…' : title;
      ask(S.addTodoTitlePrompt, { input: title, inputLabel: S.addTodoTitleLabel, ok: S.menuAddTodo }).then(function (chosen) {
        if (!chosen) return;
        post("todo", { op: "add", from: seq, title: chosen }).then(function (r) {
          toast(fill(S.addedTodo, { id: r.item.id }));
        }).catch(function (err) { flash(err.next || err.message || String(err)); });
      });
    }

    ctx.rowHook('todo', todoLine);
    ctx.menuHook('todo', todoMenu);
    panels.tab('plan', {
      html: todoHtml, side: true, long: true,
      label: function () { var waiting = waitingOnMe().count; return escapeHtml(S.todoTab) + (waiting ? '<span class="n you">' + waiting + '</span>' : ''); },
    });
    return {
      applyTodo: applyTodo,
      closeItem: closeItem,
      itemsOf: itemsOf,
      markDone: markDone,
      openItem: openItem,
      pendingDone: pendingDone,
      refreshTodo: refreshTodo,
      renderMain: renderMain,
      todoHtml: todoHtml,
      toggleDone: toggleDone,
      toggleThreadFold: toggleThreadFold,
    };
  };
})();
