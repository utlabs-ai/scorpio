// The room page: message feed over a WebSocket, sending and marking over HTTP.
(function () {
  "use strict";
  var boot = JSON.parse(document.getElementById("boot").textContent);
  // A viewer (docs/api/topics.md): a public topic read without joining. Read only; 「加入」 takes the composer's place.
  var viewer = boot.member === false;
  var S = boot.S;
  var workspacePanel = window.createWorkspacePanel({ roomId: boot.roomId, me: boot.me, strings: boot.workspaceStrings });
  var $ = function (id) { return document.getElementById(id); };
  var feed = $("feed"), input = $("input"), panel = $("panel"), picker = $("picker"), statusEl = $("status");
  var shell = window.createRoomShell({ statusEl: statusEl });
  var panels;
  var socket = window.createRoomSocket({ roomId: boot.roomId, status: shell, reconnecting: S.reconnecting,
    hello: applyHello, members: applyMembers,
    removed: function () { removedFromRoom(false); }, gone: roomGone });
  renderMarkdown.labels.copy = S.copy;
  renderMarkdown.labels.wrapOn = S.wrapOn;

  // Every field is get-only here; each owner writes its own (room-store.js).
  var store = window.createRoomStore({
    me: boot.me,
    cursor: 0,
    messages: [],        // ascending by seq
    bySeq: new Map(),
    members: [],
    todo: { items: [], done: null }, // done: ids finished in the last 24 h; null from a server that sends them as items
    mentionUnread: 0,    // messages addressed to me past my cursor (the "@ N" chip)
    room: { id: boot.roomId, name: boot.roomName, topic: boot.topic, owner: boot.owner, code: null, public: !!boot.public, archived: !!boot.archived, archivedAt: boot.archivedAt == null ? null : boot.archivedAt, archivedReason: boot.archivedReason || null },
  });
  var state = store.state;
  var roomSearch = window.createRoomSearch({ roomId: boot.roomId, panel: panel, strings: S, lang: boot.lang, me: state.me,
    avatar: avatar, members: function () { return state.members; }, nameOf: nameText, close: closePanel, openItem: openItem, jumpTo: jumpSearch, openMemo: function (id) { roomMemo.show(id); } });

  function fill(s, vars) {
    return s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ""; });
  }
  // Names, presence, role cards, the member popup and its engine: room-members.js.
  function ownerOf() { return roomMembers.ownerOf.apply(this, arguments); }
  function shownName() { return roomMembers.shownName.apply(this, arguments); }
  function nameText() { return roomMembers.nameText.apply(this, arguments); }
  function myAgents() { return roomMembers.myAgents.apply(this, arguments); }
  function isWorkingAgent() { return roomMembers.isWorkingAgent.apply(this, arguments); }
  function shown() { return roomMembers.shown.apply(this, arguments); }
  function presence() { return roomMembers.presence.apply(this, arguments); }
  function robot() { return roomMembers.robot.apply(this, arguments); }
  function computerOf() { return roomMembers.computerOf.apply(this, arguments); }
  function showMember() { return roomMembers.showMember.apply(this, arguments); }
  function refreshPopup() { return roomMembers.refreshPopup.apply(this, arguments); }
  function saveCard() { return roomMembers.saveCard.apply(this, arguments); }
  function removeComputer() { return roomMembers.removeComputer.apply(this, arguments); }
  function toggleMemberFold() { return roomMembers.toggleMemberFold.apply(this, arguments); }
  function sizePop() { return roomMembers.sizePop.apply(this, arguments); }
  // The topic's own settings, invite, archive, quota note and room menu: room-settings.js.
  function plainLines() { return settings.plainLines.apply(this, arguments); }
  function topicHtml() { return settings.topicHtml.apply(this, arguments); }
  function showTopic() { return settings.showTopic.apply(this, arguments); }
  function saveTopic() { return settings.saveTopic.apply(this, arguments); }
  function saveName() { return settings.saveName.apply(this, arguments); }
  function placeInvite() { return settings.placeInvite.apply(this, arguments); }
  function showInvite() { return settings.showInvite.apply(this, arguments); }
  function setRoom() { return settings.setRoom.apply(this, arguments); }
  function applyRoom() { return settings.applyRoom.apply(this, arguments); }
  function quotaNow() { return settings.quotaNow.apply(this, arguments); }
  function setQuota() { return settings.setQuota.apply(this, arguments); }
  function showSettings() { return settings.showSettings.apply(this, arguments); }
  function sizeTopic() { return settings.sizeTopic.apply(this, arguments); }
  function settingsAct() { return settings.settingsAct.apply(this, arguments); }
  function setVisibility() { return settings.setVisibility.apply(this, arguments); }
  function restoreRoom() { return settings.restoreRoom.apply(this, arguments); }
  function renderRoomMenu() { return settings.renderRoomMenu.apply(this, arguments); }
  function closeRoomMenu() { return settings.closeRoomMenu.apply(this, arguments); }
  function roomGone() { return settings.roomGone.apply(this, arguments); }
  function removedFromRoom() { return settings.removedFromRoom.apply(this, arguments); }

  var RECEIPT = '<svg viewBox="0 0 18 12" aria-hidden="true"><circle class="ring" cx="6" cy="6" r="4.2"/><circle class="orb" cx="6" cy="1.8" r="1.5"/><path class="c1" pathLength="1" d="M1.6 6.3 4.7 9.4 10.6 2.8"/><path class="c2" pathLength="1" d="M7.9 8.6 8.7 9.4 14.6 2.8"/><g class="bang"><circle cx="6" cy="6" r="5.6"/><path d="M6 2.9v4.1M6 8.1v1.4"/></g></svg>';
  // A file's own page (/v/<id>): a new tab on a computer; inside the home-screen app the same window, since a
  // new tab there would leave the app for the browser, which is not signed in.
  var STANDALONE = window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  var PAGE_TARGET = STANDALONE ? "" : ' target="_blank" rel="noopener"';
  var GO_PAGE = '<svg class="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  var GO_DOWN = '<svg class="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>';
  function pageOf(f) { return "/v/" + encodeURIComponent(f.id); }
  /** A file that is not an image: its own page when that shows it (view: Markdown, plain text, SVG, HTML), else a download. */
  function fileLinkAttrs(f) {
    return f.view
      ? ' class="view" href="' + escapeHtml(pageOf(f)) + '"' + PAGE_TARGET + ' title="' + escapeHtml(S.openFile) + '"'
      : ' href="' + escapeHtml(f.url) + '" download="' + escapeHtml(f.name) + '" title="' + escapeHtml(S.download) + '"';
  }
  /** A picture: its link carries its page too, for the viewer's 「在新标签打开」 (lightbox.js). */
  function picAttrs(f) {
    return ' href="' + escapeHtml(f.url) + '" data-page="' + escapeHtml(pageOf(f)) + '" target="_blank" rel="noopener"';
  }
  /** Attachments: images shown in a grid; any other file a row to its own page or to download (docs/api/files.md). */
  function filesHtml(m) {
    if (!m.files || !m.files.length) return "";
    var pics = m.files.filter(isPic), other = m.files.filter(function (f) { return !isPic(f); });
    // One that went (evicted when its uploader's space was full, or deleted before that) keeps its place and says so; it is not fetched.
    return (pics.length ? '<div class="pics' + (pics.length === 1 ? " one" : "") + '">' + pics.map(function (f) {
      if (f.deleted) return '<a class="nopic gone" title="' + escapeHtml(f.name) + '"><span>' + escapeHtml(S.fileDeleted) + "</span></a>";
      return '<a' + picAttrs(f) + '><img src="' + escapeHtml(f.url) + '" alt="' + escapeHtml(f.name) + '" loading="lazy"></a>';
    }).join("") + "</div>" : "") + (other.length ? '<div class="files">' + other.map(function (f) {
      if (f.deleted) return '<a class="gone">' + fileRow(f.name, null) + '<span class="sz">' + escapeHtml(S.fileDeleted) + "</span></a>";
      return '<a' + fileLinkAttrs(f) + '>' + fileRow(f.name, f.size) + (f.view ? GO_PAGE : GO_DOWN) + "</a>";
    }).join("") + "</div>" : "");
  }
  function isPic(f) { return /^image\/(png|jpeg|gif|webp)$/.test(f.type || ""); }
  function isVideo(f) { return /^video\/(mp4|webm|quicktime)$/.test(f.type || ""); }
  function fileRow(name, size) {
    return '<span class="ic-file" aria-hidden="true"></span><span class="nm">' + escapeHtml(name || "file") + '</span>' + (size != null ? '<span class="sz">' + sizeText(size) + "</span>" : "");
  }
  function sizeText(n) {
    return n < 1024 ? n + " B" : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : n < 1073741824 ? (Math.round(n / 104857.6) / 10) + " MB" : (Math.round(n / 107374182.4) / 10) + " GB";
  }
  function extOf(name) { var m = /\.([A-Za-z0-9]{1,5})$/.exec(name || ""); return m ? m[1].toUpperCase() : ""; }

  function setReply() { return composer.setReply.apply(this, arguments); }
  function isTall() { return composer.isTall.apply(this, arguments); }
  function setTall() { return composer.setTall.apply(this, arguments); }
  function autosize() { return composer.autosize.apply(this, arguments); }
  function saveDraft() { return composer.saveDraft.apply(this, arguments); }
  function send() { return composer.send.apply(this, arguments); }
  function loadDraft() { return composer.loadDraft.apply(this, arguments); }
  function loadOutbox() { return composer.loadOutbox.apply(this, arguments); }
  function pump() { return composer.pump.apply(this, arguments); }
  function insertMention() { return composer.insertMention.apply(this, arguments); }
  function hidePicker() { return composer.hidePicker.apply(this, arguments); }
  function names() { return roomFeed.names.apply(this, arguments); }
  function fmtTime() { return roomFeed.fmtTime.apply(this, arguments); }
  function kindLabel() { return roomFeed.kindLabel.apply(this, arguments); }
  function avatar() { return roomFeed.avatar.apply(this, arguments); }
  function jumpTo() { return roomFeed.jumpTo.apply(this, arguments); }
  function jumpSearch() { return roomFeed.jumpSearch.apply(this, arguments); }
  function jumpDown() { return roomFeed.jumpDown.apply(this, arguments); }
  function goBack() { return roomFeed.goBack.apply(this, arguments); }
  function pruneTrail() { return roomFeed.pruneTrail.apply(this, arguments); }
  function nearBottom() { return roomFeed.nearBottom.apply(this, arguments); }
  function append() { return roomFeed.append.apply(this, arguments); }
  function maybeMark() { return roomFeed.maybeMark.apply(this, arguments); }
  function refreshReadLines() { return roomFeed.refreshReadLines.apply(this, arguments); }
  function readLine() { return roomFeed.readLine.apply(this, arguments); }
  function filesChanged() { return roomFeed.filesChanged.apply(this, arguments); }
  function updateJump() { return roomFeed.updateJump.apply(this, arguments); }
  function unreadForMe() { return roomFeed.unreadForMe.apply(this, arguments); }
  function lastSeq() { return roomFeed.lastSeq.apply(this, arguments); }
  function loadEarlier() { return roomFeed.loadEarlier.apply(this, arguments); }
  function rowName() { return roomFeed.rowName.apply(this, arguments); }
  function quoteHtml() { return roomFeed.quoteHtml.apply(this, arguments); }
  function closeMenu() { return roomFeed.closeMenu.apply(this, arguments); }
  function closeLinkMenu() { return roomFeed.closeLinkMenu.apply(this, arguments); }
  function exitSelect() { return roomFeed.exitSelect.apply(this, arguments); }
  function textClick() { return roomFeed.textClick.apply(this, arguments); }

  /** Pictures a size you can see (one up to 260 wide, two or three side by side), files as small chips with their type. */
  function fileChips(m) {
    if (!m.files || !m.files.length) return "";
    var pics = m.files.filter(isPic), videos = m.files.filter(isVideo), other = m.files.filter(function (f) { return !isPic(f) && !isVideo(f); });
    // .pics too: lightbox.js opens pictures inside .pics in the page, not in a new tab
    return (pics.length ? '<div class="pics fm-pics n' + Math.min(pics.length, 3) + '">' + pics.map(function (f) {
      if (f.deleted) return '<a class="nopic gone" title="' + escapeHtml(f.name) + '"><span>' + escapeHtml(S.fileDeleted) + "</span></a>";
      return '<a' + picAttrs(f) + '><img src="' + escapeHtml(f.url) + '" alt="' + escapeHtml(f.name) + '" loading="lazy"></a>';
    }).join("") + "</div>" : "") + videos.map(function (f) {
      if (f.deleted) return '<div class="fm-video gone"><span>' + escapeHtml(f.name) + ' · ' + escapeHtml(S.fileDeleted) + '</span></div>';
      return '<div class="fm-video"><video src="' + escapeHtml(f.url) + '" controls playsinline preload="metadata"></video><div class="fm-video-meta"><a href="' + escapeHtml(pageOf(f)) + '"' + PAGE_TARGET + '>' + escapeHtml(f.name) + '</a><a href="' + escapeHtml(f.url) + '" download="' + escapeHtml(f.name) + '">' + escapeHtml(S.download) + '</a></div></div>';
    }).join("") + (other.length ? '<div class="fm-files">' + other.map(function (f) {
      var ext = extOf(f.name) || "FILE", base = String(f.name || "file").replace(/\.[A-Za-z0-9]{1,5}$/, "");
      return '<a' + (f.deleted ? ' class="gone"' : fileLinkAttrs(f)) + '>' +
        '<span class="ext">' + escapeHtml(ext) + '</span><span class="nm">' + escapeHtml(base) + '</span><span class="sz">' +
        (f.deleted ? escapeHtml(S.fileDeleted) : sizeText(Math.max(f.size || 0, 1024))) + "</span>" + (f.deleted ? "" : f.view ? GO_PAGE : GO_DOWN) + "</a>";
    }).join("") + "</div>" : "");
  }

  /** Unfinished items under my name. */
  function myItems() {
    return state.todo.items.filter(function (i) { return i.assignee === state.me && i.status !== "done" && !pendingDone[i.id]; });
  }

  /** What is waiting on me: my agents stuck at a prompt, and TODO items under my name. */
  function waitingOnMe() {
    var stuck = myAgents().filter(function (m) { return m.online && m.work === "blocked"; });
    var items = myItems();
    return { stuck: stuck, items: items, count: stuck.length + items.length };
  }

  /** "3 agents running" for the task line and the pill label: one count, the pill's green number. */
  function agentsRunning() {
    var n = state.members.filter(isWorkingAgent).length;
    return fill(n === 1 ? S.agentsRunningOne : S.agentsRunning, { n: n });
  }

  // One TODO pill: needs me / agents working now.
  function updateChips() {
    if (mentionFeed) mentionFeed.label();
    var mine = unreadForMe();
    var w = waitingOnMe();
    var pb = $("btn-plan");
    var working = state.members.filter(isWorkingAgent).length;
    pb.innerHTML = '<span class="rg y' + (w.count ? '' : ' zero') + '"><b>' + w.count + '</b></span>' +
      '<span class="rg d' + (working ? '' : ' zero') + '"><b>' + working + '</b></span>';
    pb.setAttribute("aria-label", fill(S.todoChip, { mine: w.count, running: agentsRunning() }));
    updateJump();
    renderSide();
    document.title = (mine.length ? "(" + mine.length + ") " : "") + state.room.name;
  }

  // ---------- panels ----------

  function closePanel() { return panels.closePanel.apply(this, arguments); }

  function itemsOf() { return tasks.itemsOf.apply(this, arguments); }
  function refreshTodo() { return tasks.refreshTodo.apply(this, arguments); }

  function ago(ms) {
    if (!ms) return "";
    var sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 45) return S.justNow;
    if (sec < 3600) return fill(S.minAgo, { n: Math.round(sec / 60) });
    if (sec < 86400) return fill(S.hourAgo, { n: Math.round(sec / 3600) });
    return fill(S.dayAgo, { n: Math.round(sec / 86400) });
  }

  // ---------- the panel: Waiting on you / @me / TODO / Members ----------

  function setSideOpen() { return panels.setSideOpen.apply(this, arguments); }
  function renderSide() { return panels.renderSide.apply(this, arguments); }
  function openPanel() { return panels.openPanel.apply(this, arguments); }
  function togglePanel() { return panels.togglePanel.apply(this, arguments); }
  function refreshPanel() { return panels.refreshPanel.apply(this, arguments); }

  function flLive() { return files.flLive.apply(this, arguments); }
  function flHtml() { return files.flHtml.apply(this, arguments); }
  function flTyping() { return files.flTyping.apply(this, arguments); }
  function flAfter() { return files.flAfter.apply(this, arguments); }
  function flClick() { return files.flClick.apply(this, arguments); }

  function loadMentions() { return roomAt.loadMentions.apply(this, arguments); }
  function todoHtml() { return tasks.todoHtml.apply(this, arguments); }
  function renderMain() { return tasks.renderMain.apply(this, arguments); }
  function closeItem() { return tasks.closeItem.apply(this, arguments); }
  function openItem() { return tasks.openItem.apply(this, arguments); }
  function toggleThreadFold() { return tasks.toggleThreadFold.apply(this, arguments); }

  var pendingDone;
  function markDone() { return tasks.markDone.apply(this, arguments); }
  function toggleDone() { return tasks.toggleDone.apply(this, arguments); }

  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    var ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  }

  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.classList.remove("hidden");
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.classList.add("hidden"); }, 2000);
  }

  function copy(text, done) {
    return copyText(text).then(function () { toast(done); }, function () { flash(fill(S.copyFailed, { text: text })); });
  }

  function canWrite() { return !state.room.archived && !viewer; }

  function clock(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function isOwner() { return state.room.owner === state.me; }

  // ---------- asking before doing: our own dialog, not the browser's ----------

  var dialog = $("dialog"), dialogDone = null;

  /** Resolves true for OK, or the edited title when input is set. */
  function ask(text, opts) {
    opts = opts || {};
    if (dialogDone) dialogDone(false);
    dialog.innerHTML = '<div class="box">' + (opts.art ? '<div class="art">' + opts.art + "</div>" : "") + (opts.title ? '<h3 class="dialog-title">' + escapeHtml(opts.title) + '</h3>' : '') + '<p class="q">' + escapeHtml(text) + "</p>" + (opts.input !== undefined ? '<label class="title-entry"><span>' + escapeHtml(opts.inputLabel || '') + '</span><input type="text" maxlength="80" required value="' + escapeHtml(opts.input) + '"></label>' : '') + (opts.code ? '<pre class="cmd">' + escapeHtml(opts.code) + "</pre>" : "") + (opts.note ? '<p class="note">' + escapeHtml(opts.note) + "</p>" : "") +
      '<div class="btns"><button type="button" class="btn" data-dlg="0">' + escapeHtml(opts.cancel || S.cancel) + "</button>" +
      '<button type="button" class="btn ' + (opts.danger ? "dangerfill" : "primary") + '" data-dlg="1">' + escapeHtml(opts.ok || S.ok) + "</button></div></div>";
    dialog.classList.remove("hidden");
    var back = document.activeElement;
    if (!coarse) (opts.input !== undefined ? dialog.querySelector('input') : dialog.querySelector('[data-dlg="1"]')).focus();
    return new Promise(function (resolve) {
      dialogDone = function (v) {
        if (v && opts.input !== undefined) {
          var field = dialog.querySelector('input');
          field.value = field.value.trim();
          if (!field.reportValidity()) return field.focus();
          v = field.value;
        }
        dialogDone = null;
        dialog.classList.add("hidden");
        dialog.innerHTML = "";
        if (back && back.focus && !coarse) back.focus();
        resolve(v);
      };
      if (opts.input !== undefined) dialog.querySelector('input').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); dialogDone(true); }
      });
    });
  }
  dialog.addEventListener("click", function (e) {
    var b = e.target.closest("[data-dlg]");
    if (b && dialogDone) return dialogDone(b.dataset.dlg === "1");
    if (e.target === dialog && dialogDone) dialogDone(false); // a tap outside the box
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && dialogDone) { e.stopPropagation(); dialogDone(false); }
  }, true);

  function flash(text) {
    shell.status("error", text, { ms: 6000 });
  }

  // ---------- HTTP ----------

  function post(path, body) {
    return fetch("/r/" + boot.roomId + "/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    }).then(function (res) {
      return res.json().then(function (j) { if (!res.ok) throw j; return j; });
    });
  }

  /** post, given up after ms: rejects with an AbortError then. */
  function postWithin(path, body, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = ctl && setTimeout(function () { ctl.abort(); }, ms);
    return fetch("/r/" + boot.roomId + "/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal: ctl ? ctl.signal : undefined,
    }).then(function (res) {
      return res.json().then(function (j) { if (!res.ok) throw j; return j; }, function () { throw { error: "http_" + res.status, next: "HTTP " + res.status }; });
    }).then(function (j) { clearTimeout(t); return j; }, function (e) { clearTimeout(t); throw e; });
  }

  // ---------- live connection ----------

  var helloSeen = false;
  function applyHello(f) {
    feed.removeAttribute("aria-busy"); // the skeleton goes with renderAll's first pass
    roomFeed.helloMe(f.me);
    roomMembers.set(f.members);
    workspacePanel.members(f.members, f.me ? f.me.member : !viewer);
    schedules.frame(f.schedules);
    settings.knowMembers();
    setRoom(f.room);
    tasks.applyTodo(f.todo && f.todo.items || [], f.todo && f.todo.done);
    roomMemo.frame(f.memo);
    settings.setQuotaFromHello(f.quota);
    if (mentionFeed) mentionFeed.reset();
    roomFeed.helloMessages(f.messages); // after the TODO: a row's task line reads it
    if (mentionFeed) mentionFeed.sync();
    roomFeed.refreshTop();
    if (helloSeen) refreshTodo(); // rows kept from before the reconnect
    helloSeen = true;
    schedules.refresh();
    roomSearch.refresh(); // names may arrive after a search opened from the home page
    settings.reapplyQuota();
    if (openOnHello) { openPanel(openOnHello); openOnHello = null; }
    if (homeTarget) {
      if (homeTarget.item) openItem(homeTarget.item);
      else if (homeTarget.seq) {
        jumpSearch(homeTarget.seq, true);
        // This deep link is consumed. A refresh should load the current feed, not replay the old around slice.
        var clean = new URL(location.href);
        clean.searchParams.delete('jump');
        clean.searchParams.delete('fromSearch');
        history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
      }
      homeTarget = null;
    }
    maybeMark();
  }

  function applyMembers(f) {
    roomMembers.set(f.members);
    workspacePanel.members(f.members, f.me ? f.me.member : !viewer);
    schedules.composerChanged();
    roomSearch.refresh();
    updateChips();
    refreshReadLines();
    refreshPanel();
    refreshPopup();
    placeInvite();
  }

  socket.on("message", function (f) {
    append(f.message);
    if (f.message && f.message.files && f.message.files.length) flLive();
  });
  socket.on("message_update", function (f) {
    if (f.message) roomFeed.updated(f.message);
  });
  socket.on("cursor", function (f) {
    var who = state.members.find(function (x) { return x.name === f.name; }), was = who ? who.cursor : null;
    roomMembers.cursorMoved(f.name, f.cursor);
    if (f.name === state.me) { roomFeed.myCursor(f.cursor); }
    roomFeed.readLinesMoved(f.name, was, f.cursor); // only the rows between the old cursor and the new (docs/web.md rule 2)
    updateChips();
  });
  socket.on("memo", function (f) { roomMemo.frame(f); });
  socket.on("todo", function (f) {
    tasks.applyTodo(f.items || [], f.done);
    refreshTodo();
  });
  socket.on("files", function (f) {
    filesChanged(f.seq, f.files || []);
    flLive();
  });
  socket.on("quota", function (f) {
    settings.quotaFrame(f);
  });
  socket.on("room", function (f) {
    setRoom(f.room);
    roomMemo.refresh();
  });
  socket.on("deleted", function () { roomGone(); });
  socket.on("removed", function (f) { socket.stop(); removedFromRoom(f.by === state.me); });

  // ---------- wiring ----------

  panels = shell.panels({ panel: panel, $: $, S: S, escapeHtml: escapeHtml, renderMain: renderMain, roomSearch: roomSearch });
  panels.refresh('invite', showInvite);
  panels.refresh('settings', function () { if (document.activeElement !== $("set-topic")) showSettings(); });
  var composer = window.createRoomComposer({ $: $, RECEIPT: RECEIPT, S: S, ago: ago, append: append, ask: ask, avatar: avatar, boot: boot, canWrite: canWrite, clock: clock, computerOf: computerOf, extOf: extOf, feed: feed, fileRow: fileRow, fill: fill, flash: flash,
    input: input, isCoarse: function () { return coarse; }, lastSeq: lastSeq, myAgents: myAgents, names: names, nearBottom: nearBottom, ownerOf: ownerOf, picker: picker, post: post, postWithin: postWithin, presence: presence, quoteHtml: quoteHtml, quotaNow: quotaNow, readLine: readLine, rowName: rowName,
    setQuota: setQuota, shown: shown, shownName: shownName, sizeText: sizeText, state: state, textChanged: function () { schedules.composerChanged(); } });
  var roomFeed = window.createRoomFeed({ $: $, RECEIPT: RECEIPT, S: S, arrived: composer.arrived, overlayChanged: window.scorpioRoomOverlays.changed, boot: boot, callBack: composer.callBack, canWrite: canWrite, copy: copy, editSend: composer.editSend, feed: feed, fill: fill, flash: flash, openItem: openItem, openPanel: openPanel,
    openSchedule: function (id) { return schedules.openDetail(id); }, outEl: composer.outEl, outbox: composer.outbox, ownerOf: ownerOf, panels: panels, placeInvite: placeInvite, placeOutbox: composer.placeOutbox, post: post, retrySend: composer.retrySend, setReply: setReply, shownName: shownName, state: state, toast: toast, updateChips: updateChips, viewer: viewer, mentionFilter: function () { return mentionFeed; },
    writeFeed: { cursor: store.claim("cursor"), mentionUnread: store.claim("mentionUnread"), messages: store.claim("messages"), bySeq: store.claim("bySeq") } });
  // The row's files; the composer fills the delivery notes and the menu's reply and mention.
  roomFeed.rowHook('chips', fileChips);
  composer.hookFeed(roomFeed.rowHook, roomFeed.menuHook);
  // Reply buttons and chart cards: the foot's buttons, the body's card and its frame.
  window.createRoomAiCards({ S: S, boot: boot, state: state, feed: feed, fill: fill, avatar: avatar, rowName: rowName, fmtTime: fmtTime, canWrite: canWrite,
    post: post, append: append, flash: flash, refusal: composer.refusal, deliveryNotes: composer.deliveryNotes, rowHook: roomFeed.rowHook });
  var files = window.createRoomFiles({ $: $, GO_DOWN: GO_DOWN, GO_PAGE: GO_PAGE, S: S, boot: boot, clock: clock, closePanel: closePanel, dayText: composer.dayText, extOf: extOf, fileLinkAttrs: fileLinkAttrs, fill: fill, jumpTo: jumpTo, openPanel: openPanel, panel: panel, panels: panels, picAttrs: picAttrs, rowName: rowName, sizeText: sizeText });
  var roomMemo = window.createRoomMemo({ $: $, S: S, boot: boot, state: state, viewer: viewer, canWrite: canWrite, fill: fill, fmtTime: fmtTime, nameText: nameText, rowName: rowName, avatar: avatar, panels: panels, openPanel: openPanel, closePanel: closePanel, openItem: openItem, jumpTo: jumpTo, post: post, rowHook: roomFeed.rowHook, menuHook: roomFeed.menuHook, flash: flash });
  var tasks = window.createRoomTasks({ $: $, S: S, ago: ago, avatar: avatar, boot: boot, canWrite: canWrite, feed: feed, fill: fill, flash: flash, agentsRunning: agentsRunning, fmtTime: fmtTime, names: names, panels: panels, post: post, quotaNow: quotaNow, refreshPanel: refreshPanel, rowHook: roomFeed.rowHook, rowName: rowName, shownName: shownName, state: state, shell: shell, updateChips: updateChips, viewer: viewer, waitingOnMe: waitingOnMe, approvalFor: function (name) { return approvals && approvals.forAgent(name); }, clearPopEdit: function () { roomMembers.clearPop(); },
    ask: ask, toast: toast, openPanel: openPanel, menuHook: roomFeed.menuHook, writeTodo: store.claim("todo") });
  var roomAt = window.createRoomAt({ $: $, S: S, avatar: avatar, boot: boot, filesHtml: filesHtml, fill: fill, fmtTime: fmtTime, kindLabel: kindLabel, names: names, openPanel: openPanel, panels: panels, renderRoomMenu: renderRoomMenu, state: state, updateChips: updateChips,
    unreadFromMentions: function (n) { roomFeed.unreadFromMentions(n); } });
  var mentionFeed = viewer ? null : window.createRoomMentionFeed({ button: $('mention-only'), feed: feed, state: state,
    S: S, fill: fill, roomId: boot.roomId, rows: roomFeed, flash: flash, jumpTo: jumpTo });
  var roomMembers = window.createRoomMembers({ $: $, S: S, ago: ago, ask: ask, boot: boot, canWrite: canWrite, clock: clock, closeItem: closeItem, fill: fill, flash: flash, isOwner: isOwner, names: names, openPanel: openPanel,
    panels: panels, pendingDone: tasks.pendingDone, plainLines: plainLines, post: post, refreshPanel: refreshPanel, renderSide: renderSide, showTopic: showTopic, state: state, toast: toast, topicHtml: topicHtml, writeMembers: store.claim("members") });
  // The export sheet: room-export.js; opened from the settings' export section.
  var roomExport = window.createRoomExport({ $: $, S: S, boot: boot, fill: fill });
  var settings = window.createRoomSettings({ $: $, S: S, boot: boot, fill: fill, state: state, panel: panel, panels: panels, feed: feed, viewer: viewer, socket: socket, openExport: roomExport.open,
    post: post, ask: ask, toast: toast, flash: flash, copy: copy, copyText: copyText, clock: clock, canWrite: canWrite, isOwner: isOwner,
    closeMenu: closeMenu, exitSelect: exitSelect, nearBottom: nearBottom, updateChips: updateChips,
    refreshPanel: refreshPanel, openPanel: openPanel, renderSide: renderSide, closePanel: closePanel, loadMentions: loadMentions,
    shown: shown, names: names, shell: shell, roomMembers: roomMembers, mySeats: composer.mySeats, startSpawn: composer.startSpawn, writeRoom: store.claim("room"), atCount: function () { return roomAt.count(); } });
  pendingDone = tasks.pendingDone;
  var approvals = window.createRoomApprovals({ dock: $("approvals"), roomId: boot.roomId, S: S.apv, escape: escapeHtml, robot: botStill, ago: ago, flash: flash, errorText: S.reconnecting, closePanel: closePanel, changed: refreshTodo });
  socket.on("approvals", approvals.snapshot);

  var schedules = window.createRoomSchedules({ $: $, S: S, boot: boot, state: state, input: input, composer: composer, post: post, socket: socket, panels: panels, rowHook: roomFeed.rowHook,
    fill: fill, flash: flash, toast: toast, ask: ask, canWrite: canWrite, closePanel: closePanel, closeItem: closeItem,
    jumpTo: jumpTo, openPanel: openPanel,
    scheduleTabOpen: function () { return panels.kind() === 'schedules' && panels.isOpen() || window.matchMedia('(min-width: 761px)').matches && panels.sideOpen() && panels.sideView() === 'schedules'; },
    refreshScheduleViews: function () { if (panels.isOpen() && ['plan', 'schedules', 'members', 'files'].includes(panels.kind())) refreshPanel(); if (panels.sideOpen()) renderSide(); },
  });

  settings.listen();

  schedules.composerChanged();
  input.placeholder = S.placeholder;
  panel.addEventListener("change", function (e) {
    if (panels.kind() === 'search') return roomSearch.change(e);
    if (panels.kind() === 'schedules' && schedules.listChange(e)) return;
    if (e.target.name === "vis") setVisibility(e.target.value === "public");
  });
  // In a sheet the body scrolls (.sheet .sbody), not the panel, and scroll does not bubble: listen while capturing, and
  // read the end from whichever scrolled — the body, or the panel itself in the invite and settings views.
  panel.addEventListener("scroll", function (e) {
    closeLinkMenu();
    var el = e.target;
    if (el !== panel && !(el.parentNode === panel && el.classList.contains("sbody"))) return;
    if (panels.kind() === "at" && el.scrollHeight - el.scrollTop - el.clientHeight < 80) loadMentions(false);
  }, true);
  $("btn-plan").onclick = function () { togglePanel("plan"); };
  $("btn-search").onclick = function () { openPanel("search"); };
  statusEl.addEventListener("click", function (e) {
    var nt = e.target.closest("[data-notify]");
    if (nt) {
      var d = JSON.parse(nt.dataset.notify);
      var text = d.who.map(function (n) { return "@" + n; }).join(" ") + " " + fill(S.canStartMsg, {
        items: d.list.map(function (u) { return u.id + "「" + u.title + "」"; }).join("、"),
      });
      shell.clear("undo");
      return post("send", { text: text }).catch(function (err) { flash(err.next || String(err)); });
    }
    var u = e.target.closest("[data-undo]");
    if (!u) return;
    clearTimeout(pendingDone[u.dataset.undo]);
    delete pendingDone[u.dataset.undo];
    shell.clear("undo");
    refreshTodo(); // everything done redrew: the computer's side list and the 「等你」 count too, not only the phone's panel
  });
  composer.listen();
  // On a phone Enter is a new line, and the key says so; Send is the button. A keyboard sends with Enter.
  var coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  input.setAttribute("enterkeyhint", coarse ? "enter" : "send");
  roomFeed.listen();
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeMenu(); closeLinkMenu(); closeRoomMenu(); exitSelect(); }
  });
  window.addEventListener("resize", function () { closeMenu(); closeLinkMenu(); renderMain(); autosize(); });

  panel.addEventListener("click", function (e) {
    if (panels.kind() === 'search') return roomSearch.click(e);
    if (textClick(e)) return;
    if (e.target.closest("[data-close]")) return closePanel();
    if (panels.kind() === 'files' && flClick(e)) return;
    var t = e.target.closest("[data-tab]");
    if (t) return openPanel(t.dataset.tab);
    if (panels.kind() === 'schedules' && schedules.listClick(e)) return;
    if (e.target.closest("[data-invite]")) return showInvite();
    if (e.target.closest("[data-settings]")) return showSettings(null);
    if (roomMembers.filterClick(e)) return;
    var removeSeat = e.target.closest('[data-remove-computer]');
    if (removeSeat) return removeComputer(removeSeat.dataset.removeComputer);
    var foldMember = e.target.closest('[data-fold-member]');
    if (foldMember) return toggleMemberFold(foldMember.dataset.foldMember);
    if (e.target.closest("[data-restore]")) return restoreRoom();
    if (panels.kind() === "settings") return settingsAct(e);
    if (e.target.closest("[data-done-fold]")) return toggleDone();
    var detail = e.target.closest('[data-item]');
    if (detail) return openItem(detail.dataset.item);
    var jl = e.target.closest("a[data-jump]");
    if (jl) { e.preventDefault(); closePanel(); return jumpTo(Number(jl.dataset.jump)); }
    var pj = e.target.closest("li.pin[data-jump]");
    if (pj && !e.target.closest("a")) { closePanel(); return jumpTo(Number(pj.dataset.jump)); }
    if (e.target.closest("[data-topic]")) return showTopic(false);
    var li = e.target.closest("[data-name]");
    if (li && li.classList.contains('hascard')) return showMember(li.dataset.name, false);
  });
  panel.addEventListener('input', function (e) {
    if (panels.kind() === 'search') roomSearch.input(e);
    roomMembers.filterInput(e);
    if (e.target.id === 'set-topic' || e.target.id === 'set-name') sizeTopic();
  });
  $("panel-scrim").onclick = closePanel;
  $("item-scrim").onclick = closeItem;
  $("item-panel").addEventListener('input', function (e) { if (e.target.id === 'pop-edit') sizePop(); });
  $("item-panel").addEventListener('click', function (e) {
    if (textClick(e)) return;
    if (e.target.closest('[data-close-item]')) return closeItem();
    var at = e.target.closest('[data-at]');
    if (at) { closeItem(); closePanel(); return insertMention(at.dataset.at, false); }
    var edit = e.target.closest('[data-card-edit]');
    if (edit) return showMember(edit.dataset.cardEdit, true);
    var laneEdit = e.target.closest('[data-lane-edit]');
    if (laneEdit) return showMember(laneEdit.dataset.laneEdit, 'lane');
    var laneSave = e.target.closest('[data-lane-save]');
    if (laneSave) return roomMembers.saveLane(laneSave);
    if (e.target.closest('[data-topic-edit]')) return showTopic(true);
    if (e.target.closest('[data-name-edit]')) return showTopic('name');
    if (e.target.closest('[data-pop-cancel]')) return roomMembers.popEdit() === 'topic' || roomMembers.popEdit() === 'name' ? showTopic(false) : showMember(roomMembers.popEdit().slice(5), false);
    var nameSave = e.target.closest('[data-name-save]');
    if (nameSave) return saveName(nameSave);
    var cardSave = e.target.closest('[data-card-save]');
    if (cardSave) return saveCard(cardSave);
    var topicSave = e.target.closest('[data-topic-save]');
    if (topicSave) return saveTopic(topicSave);
    var fold = e.target.closest('[data-tfold]');
    if (fold) return toggleThreadFold(fold.dataset.tfold);
    var done = e.target.closest('[data-item-done]');
    if (done) { markDone(done.dataset.itemDone); closeItem(); return; }
    var item = e.target.closest('[data-item]');
    if (item) return openItem(item.dataset.item);
    var link = e.target.closest('[data-jump]');
    if (link) { e.preventDefault(); closeItem(); closePanel(); return jumpTo(Number(link.dataset.jump)); }
  });
  $("desktop-side").addEventListener('click', function (e) {
    if (e.target.closest('[data-side-close]')) return setSideOpen(false);
    var side = e.target.closest('[data-side]');
    if (side) return openPanel(side.dataset.side);
    if (panels.sideView() === 'schedules' && schedules.listClick(e)) return;
    if (panels.sideView() === 'files' && flClick(e)) return;
    if (e.target.closest('[data-invite]')) return showInvite();
    if (e.target.closest('[data-settings]')) return showSettings(null);
    if (roomMembers.filterClick(e)) return;
    var removeSeat = e.target.closest('[data-remove-computer]');
    if (removeSeat) return removeComputer(removeSeat.dataset.removeComputer);
    var foldMember = e.target.closest('[data-fold-member]');
    if (foldMember) return toggleMemberFold(foldMember.dataset.foldMember);
    if (e.target.closest('[data-done-fold]')) return toggleDone();
    var link = e.target.closest('[data-jump]');
    if (link) { e.preventDefault(); return jumpTo(Number(link.dataset.jump)); }
    var item = e.target.closest('[data-item]');
    if (item) return openItem(item.dataset.item);
    if (e.target.closest('[data-topic]')) return showTopic(false);
    var member = e.target.closest('[data-name]');
    if (member && member.classList.contains('hascard')) return showMember(member.dataset.name, false);
  });
  $('desktop-side').addEventListener('input', function (e) { roomMembers.filterInput(e); });
  $("desktop-side").addEventListener('change', function (e) {
    if (panels.sideView() === 'schedules') schedules.listChange(e);
  });

  // From the home page's "For you": the room opens on what is waiting on me, once the TODO has come.
  var openOnHello = location.hash === "#todo" ? "wait" : null;
  if (openOnHello) history.replaceState(history.state, "", location.pathname);
  // A notification tapped while this room is already open lands here too.
  window.addEventListener("hashchange", function () {
    if (location.hash !== "#todo") return;
    history.replaceState(history.state, "", location.pathname);
    openPanel("wait");
  });
  // A topic just made: its invite card is in the feed until an agent comes in.
  var inv = /[#&]invite=([^&]*)/.exec(location.hash);
  if (inv) {
    settings.setCode(decodeURIComponent(inv[1]) || null);
    history.replaceState(history.state, "", location.pathname);
  }
  // Keep the composer above the on-screen keyboard. Chrome on Android resizes the page itself
  // (interactive-widget=resizes-content in the viewport meta); iOS Safari only shrinks the visual
  // viewport and scrolls it, so size and shift the page to what is actually visible.
  if (window.visualViewport) {
    var vv = window.visualViewport;
    var fitViewport = function () {
      var stick = nearBottom();
      document.body.style.height = vv.height + "px";
      document.body.style.transform = vv.offsetTop ? "translateY(" + vv.offsetTop + "px)" : "";
      if (stick) feed.scrollTop = feed.scrollHeight;
    };
    vv.addEventListener("resize", fitViewport);
    vv.addEventListener("scroll", fitViewport);
    fitViewport();
  }

  var overlayHistory = window.scorpioRoomOverlays;
  // Each with the element it shows and hides; "tall" and "selection" have none and report through changed().
  overlayHistory.register("room-menu", function () { return !$('room-menu').classList.contains('hidden'); }, closeRoomMenu, $('room-menu'));
  overlayHistory.register("message-menu", roomFeed.menuOpen, closeMenu, $('msgmenu'));
  overlayHistory.register("link-menu", roomFeed.linkOpen, closeLinkMenu, $('linkmenu'));
  overlayHistory.register("panel", function () { return !panel.classList.contains('hidden'); }, closePanel, panel);
  overlayHistory.register("item", function () { return !$('item-panel').classList.contains('hidden'); }, closeItem, $('item-panel'));
  overlayHistory.register("reply", function () { return !$('replying').classList.contains('hidden'); }, function () { setReply(null); }, $('replying'));
  overlayHistory.register("tall", isTall, function () { setTall(false); });
  overlayHistory.register("picker", function () { return !picker.classList.contains('hidden'); }, hidePicker, picker);
  overlayHistory.register("selection", roomFeed.selecting, exitSelect);
  overlayHistory.register("dialog", function () { return dialogDone != null; }, function () { if (dialogDone) dialogDone(false); }, dialog);

  applyRoom();
  var draft = loadDraft();
  if (draft && draft.text) { input.value = draft.text; autosize(); schedules.composerChanged(); }
  if (draft && draft.reply) setReply(draft.reply.seq, { quiet: true, snap: draft.reply });

  loadOutbox();
  updateChips();
  var homeSearch = new URLSearchParams(location.search).get('search');
  if (homeSearch) openPanel('search', homeSearch);
  var homeParams = new URLSearchParams(location.search);
  var homeItem = homeParams.get('item'), homeSeq = Number(homeParams.get('jump'));
  var homeTarget = homeItem && /^T\d+$/.test(homeItem) ? { item: homeItem } : Number.isSafeInteger(homeSeq) && homeSeq > 0 ? { seq: homeSeq } : null;
  socket.connect();
  pump();
})();
