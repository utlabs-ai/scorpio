// The signed-in shell: the left column of topics on a computer (on /app, the topic page,
// settings and my data), the topic list on a phone's /app, the account menu, the big box and the new-topic form.
// The list comes from the page (/app) or /app/topics.json, again every 30 seconds while the page is in view.
(function () {
  "use strict";
  var bootEl = document.getElementById("sx-boot");
  if (!bootEl) return;
  var boot = JSON.parse(bootEl.textContent);
  var S = boot.S, zh = boot.lang === "zh";
  var IDLE_MS = 30 * 86400000, POLL_MS = 30000, CACHE = "sx.topics";
  var state = { topics: boot.topics, me: boot.me, binAfterDays: boot.binAfterDays, rank: null, searching: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fill(s, v) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return v[k] == null ? "" : v[k]; }); }

  // ---------- the list: groups, their order, and an order that holds still while the page is open ----------

  function seen(t) { return t.active || t.public; }
  function isIdle(t, at) { return !t.archived && t.known && at - t.lastMs >= IDLE_MS; }
  function groups(list) {
    var at = Date.now();
    var pinned = [], recent = [], idle = [], archived = [];
    list.forEach(function (t) {
      if (t.archived) { if (t.active) archived.push(t); return; }
      if (!seen(t)) return;
      if (t.pinnedAt) pinned.push(t);
      else if (isIdle(t, at)) idle.push(t);
      else recent.push(t);
    });
    var byLast = function (a, b) { return b.lastMs - a.lastMs; };
    pinned.sort(function (a, b) { return b.pinnedAt - a.pinnedAt; });
    // What waits on me first, the longest waiting at the top; then the most recently active.
    recent.sort(function (a, b) {
      var am = a.mine ? a.mineSince : Infinity, bm = b.mine ? b.mineSince : Infinity;
      return am - bm || byLast(a, b);
    });
    idle.sort(byLast);
    archived.sort(byLast);
    return { pinned: steady(pinned, "p"), recent: steady(recent, "r"), idle: idle, archived: archived };
  }
  /** The first order a group was shown in is kept until the page reloads; a topic new to the group goes on top. */
  function steady(list, g) {
    if (!state.rank) return list;
    var known = list.filter(function (t) { return state.rank[g + t.id] != null; });
    var fresh = list.filter(function (t) { return state.rank[g + t.id] == null; });
    known.sort(function (a, b) { return state.rank[g + a.id] - state.rank[g + b.id]; });
    return fresh.concat(known);
  }
  function remember(gs) {
    state.rank = {};
    gs.pinned.forEach(function (t, i) { state.rank["p" + t.id] = i; });
    gs.recent.forEach(function (t, i) { state.rank["r" + t.id] = i; });
  }

  function pill(t) {
    var label = fill(S.pillLabel, { mine: t.mine, working: t.working });
    return '<span class="sx-pill" title="' + esc(label) + '" aria-label="' + esc(label) + '"><span class="' + (t.mine ? "sx-y" : "") + '">' + esc(fill(S.pillYou, { n: t.mine })) +
      '</span><span class="' + (t.working ? "sx-d" : "") + '">' + esc(fill(S.pillWorking, { n: t.working })) + "</span></span>";
  }
  /** Messages I have not read there: a small count before the pill, red when one of them @s me.
   *  None on the topic I am looking at: the server knows where I read to, and the next refresh clears it. */
  function unread(t) {
    var n = t.unread || 0;
    if (!n || t.id === boot.current) return "";
    var at = t.mentionUnread || 0;
    var label = at ? fill(S.unreadAt, { n: n, m: at }) : fill(S.unread, { n: n });
    return '<span class="sx-unread' + (at ? " sx-you" : "") + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + (n > 99 ? "99+" : n) + "</span>";
  }
  /** Tasks open, nobody at work on them and nothing waiting on me: the row is amber, as on the old home page. */
  function stalled(t) { return t.open > 0 && !t.working && !t.mine; }
  function pub(t) { return t.public ? '<span class="sx-pub">' + esc(S.publicTag) + "</span>" : ""; }
  function firstLine(s) { return String(s || "").split("\n")[0]; }

  function row(t, phone) {
    var cls = "sx-trow" + (t.id === boot.current ? " sx-on" : "") + (stalled(t) ? " sx-stalled" : "");
    var dots = '<button type="button" class="sx-dots" data-sx-rowmenu="' + esc(t.id) + '" aria-label="' + esc(S.rowMenu) + '" aria-haspopup="menu">⋯</button>';
    if (phone) {
      return '<div class="' + cls + '" data-sx-id="' + esc(t.id) + '"><a class="sx-tlink" href="/r/' + encodeURIComponent(t.id) + '"><span class="sx-w"><span class="sx-nm">' + esc(t.name) + (t.public ? " " + pub(t) : "") +
        '</span><span class="sx-ds">' + esc(firstLine(t.desc)) + "</span></span>" + unread(t) + pill(t) + "</a></div>";
    }
    return '<div class="' + cls + '" data-sx-id="' + esc(t.id) + '"><a class="sx-tlink" href="/r/' + encodeURIComponent(t.id) + '"' + (t.id === boot.current ? ' aria-current="page"' : "") + '><span class="sx-nm">' + esc(t.name) + "</span>" + pub(t) + unread(t) + pill(t) + "</a>" + dots + "</div>";
  }
  function archivedRow(t) {
    var left = t.archivedAt != null && state.binAfterDays != null ? Math.max(0, Math.ceil((t.archivedAt + state.binAfterDays * 86400000 - Date.now()) / 86400000)) : null;
    return '<div class="sx-trow sx-arch" data-sx-id="' + esc(t.id) + '"><a class="sx-tlink" href="/r/' + encodeURIComponent(t.id) + '"><span class="sx-w"><span class="sx-nm">' + esc(t.name) + "</span>" +
      (left != null ? '<span class="sx-ds">' + esc(fill(S.binIn, { n: left })) + "</span>" : "") + '</span></a><button type="button" class="sx-btn sx-line sx-xs" data-sx-restore="' + esc(t.id) + '">' + esc(S.restore) + "</button></div>";
  }

  var FOLD_KEY = "sx.fold";
  var fold = {};
  try { fold = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") || {}; } catch (e) {}
  function folder(key, label, list, rowFn) {
    if (!list.length) return "";
    var open = !!fold[key] || list.some(function (t) { return t.id === boot.current; });
    return '<button type="button" class="sx-trow sx-more' + (open ? " sx-open" : "") + '" data-sx-fold="' + key + '" aria-expanded="' + open + '"><span class="sx-nm">' + esc(label) + " " + list.length + '</span><span class="sx-chev" aria-hidden="true">›</span></button>' +
      (open ? '<div class="sx-folded">' + list.map(rowFn).join("") + "</div>" : "");
  }

  function listHtml(gs, phone) {
    var r = function (t) { return row(t, phone); };
    var html = "";
    if (gs.pinned.length) html += '<div class="sx-grp">' + esc(S.pinned) + " " + gs.pinned.length + "</div>" + gs.pinned.map(r).join("");
    if (gs.recent.length) html += '<div class="sx-grp">' + esc(S.recent) + "</div>" + gs.recent.map(r).join("");
    if (!gs.pinned.length && !gs.recent.length && !gs.idle.length && !gs.archived.length) html += '<p class="sx-empty">' + esc(S.empty) + "</p>";
    html += folder("idle", S.idle, gs.idle, r) + folder("archived", S.archived, gs.archived, archivedRow);
    return html;
  }

  function meHtml() {
    var me = state.me;
    if (!me) return "";
    var shown = me.displayName || me.handle;
    var days = me.trialUntil ? Math.max(0, Math.ceil((me.trialUntil - Date.now()) / 86400000)) : null;
    return '<span class="sx-pav sx-me">' + esc(shown.slice(0, 1).toLowerCase()) + '</span><span class="sx-w"><b>' + esc(shown) + "</b>" +
      (days != null ? "<small>" + esc(fill(S.trial, { n: days })) + "</small>" : "") + '</span><svg class="sx-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>';
  }

  function render() {
    if (!state.topics || state.searching) return;
    var gs = groups(state.topics);
    if (!state.rank) remember(gs);
    var side = $("sx-list"), ph = $("sx-ph-groups"), me = $("sx-me");
    if (side) {
      var top = side.scrollTop;
      side.innerHTML = listHtml(gs, false);
      side.scrollTop = top;
    }
    if (ph) ph.innerHTML = listHtml(gs, true);
    if (me) me.innerHTML = meHtml();
  }
  function scrollToCurrent() {
    var on = document.querySelector("#sx-list .sx-trow.sx-on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
  }

  // ---------- keeping it fresh ----------

  var loading = null;
  function refresh() {
    if (loading) return loading;
    loading = fetch("/app/topics.json", { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) {
        state.topics = j.topics;
        state.me = j.me;
        state.binAfterDays = j.binAfterDays;
        try { sessionStorage.setItem(CACHE, JSON.stringify({ topics: j.topics, me: j.me, binAfterDays: j.binAfterDays })); } catch (e) {}
        render();
      })
      .catch(function () {})
      .then(function () { loading = null; });
    return loading;
  }
  if (!state.topics) {
    // Another page: what this tab saw last, at once, then the real list.
    try {
      var cached = JSON.parse(sessionStorage.getItem(CACHE) || "null");
      if (cached) { state.topics = cached.topics; state.me = cached.me; state.binAfterDays = cached.binAfterDays; }
    } catch (e) {}
    render();
    refresh().then(scrollToCurrent);
  } else {
    try { sessionStorage.setItem(CACHE, JSON.stringify({ topics: state.topics, me: state.me, binAfterDays: state.binAfterDays })); } catch (e) {}
    render();
  }
  scrollToCurrent();
  setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });

  // ---------- menus: a topic's (pin, unpin, archive) and the account's ----------

  var menu = document.createElement("div");
  menu.className = "sx-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.appendChild(menu);
  var menuFor = null;
  function closeMenu() { menu.hidden = true; menu.innerHTML = ""; menuFor = null; }
  function syncSideButtons(open) {
    $("sx-side").querySelector("[data-sx-side-collapse]").setAttribute("aria-expanded", String(open));
    document.querySelector("[data-sx-side-expand]").setAttribute("aria-expanded", String(open));
  }
  function setSideOpen(open) {
    if (!open) closeMenu();
    if (open) delete document.documentElement.dataset.scorpioSide;
    else document.documentElement.dataset.scorpioSide = "folded";
    syncSideButtons(open);
    try { localStorage.setItem("scorpio.leftOpen", open ? "1" : "0"); } catch (e) {}
    document.querySelector(open ? "[data-sx-side-collapse]" : "[data-sx-side-expand]").focus();
  }
  syncSideButtons(document.documentElement.dataset.scorpioSide !== "folded");
  function placeMenu(x, y, below) {
    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    var left = Math.max(8, Math.min(x, innerWidth - w - 8));
    var top = below ? Math.min(y, innerHeight - h - 8) : Math.max(8, y - h);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  function rowMenu(id, x, y) {
    var t = (state.topics || []).find(function (x) { return x.id === id; });
    if (!t || t.archived) return;
    menuFor = id;
    menu.innerHTML = '<button type="button" role="menuitem" data-sx-pin="' + esc(id) + '" data-sx-pinned="' + (t.pinnedAt ? "0" : "1") + '">' + esc(t.pinnedAt ? S.unpin : S.pin) + "</button>" +
      // only the topic's creator can archive it; members see pin alone
      (t.owned ? '<button type="button" role="menuitem" data-sx-archive="' + esc(id) + '">' + esc(S.archive) + "</button>" : "");
    placeMenu(x, y, true);
    menu.querySelector("button").focus();
  }
  function accountMenu(anchor) {
    if (menuFor === "account") return closeMenu();
    menuFor = "account";
    menu.innerHTML = '<a role="menuitem" href="/settings">' + esc(S.settings) + '</a><a role="menuitem" href="/settings#account">' + esc(S.plan) + '</a><a role="menuitem" href="/me/data">' + esc(S.myData) +
      '</a><a role="menuitem" class="sx-inv" href="/settings#invite">' + esc(S.invite) + '<i>' + esc(S.inviteTag) + '</i>' +
      '</a><form method="post" action="/logout"><button type="submit" role="menuitem">' + esc(S.signOut) + "</button></form>";
    var r = anchor.getBoundingClientRect();
    if (r.top > innerHeight / 2) placeMenu(r.left, r.top - 6, false);
    else placeMenu(r.right - menu.offsetWidth, r.bottom + 6, true);
  }
  function setPinned(id, pinned) {
    closeMenu();
    var t = (state.topics || []).find(function (x) { return x.id === id; });
    if (t) { t.pinnedAt = pinned ? Date.now() : null; state.rank = null; render(); }
    fetch("/app/pin", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify({ topicId: id, pinned: pinned }) })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) { if (t) t.pinnedAt = j.pinnedAt; render(); }, function () { refresh(); });
  }
  function restore(id, btn) {
    btn.disabled = true;
    fetch("/r/" + encodeURIComponent(id) + "/archive", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify({ archived: false }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; }); })
      .then(function () { state.rank = null; return refresh(); }, function (e) { btn.disabled = false; alert((e && e.next) || S.restoreFailed); });
  }

  /** The same question as the topic's settings, in our own dialog: resolves true for OK. */
  var dlgDone = null;
  function confirmDialog(text, ok) {
    if (dlgDone) dlgDone(false);
    var back = document.activeElement;
    var d = document.createElement("div");
    d.className = "sx-dlg";
    d.innerHTML = '<div class="sx-dlgbox" role="alertdialog" aria-modal="true"><p class="sx-q">' + esc(text) + '</p><div class="sx-btns">' +
      '<button type="button" class="sx-btn sx-sm sx-line" data-sx-dlg="0">' + esc(S.cancel) + '</button><button type="button" class="sx-btn sx-sm sx-primary" data-sx-dlg="1">' + esc(ok) + "</button></div></div>";
    document.body.appendChild(d);
    d.querySelector('[data-sx-dlg="1"]').focus();
    return new Promise(function (resolve) {
      dlgDone = function (v) {
        dlgDone = null;
        d.remove();
        if (back && back.focus) back.focus();
        resolve(v);
      };
      d.addEventListener("click", function (e) {
        var b = e.target.closest("[data-sx-dlg]");
        if (b) return dlgDone(b.dataset.sxDlg === "1");
        if (e.target === d) dlgDone(false); // a tap outside the box
      });
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && dlgDone) { e.stopPropagation(); dlgDone(false); }
  }, true);
  /** Archive from the list, as from the topic's settings; the row moves to Archived when the list comes back. */
  function archive(id) {
    closeMenu();
    return confirmDialog(fill(S.confirmArchive, { days: state.binAfterDays }), S.archive).then(function (ok) {
      if (!ok) return;
      return fetch("/r/" + encodeURIComponent(id) + "/archive", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify({ archived: true }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; }); })
        .then(function () { state.rank = null; return refresh(); }, function (e) { alert((e && e.next) || S.archiveFailed); });
    });
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest("[data-sx-side-collapse]")) return setSideOpen(false);
    if (t.closest("[data-sx-side-expand]")) return setSideOpen(true);
    if (!menu.hidden && !menu.contains(t) && !t.closest("[data-sx-rowmenu],[data-sx-account]")) closeMenu();
    var pin = t.closest("[data-sx-pin]");
    if (pin) return setPinned(pin.dataset.sxPin, pin.dataset.sxPinned === "1");
    var arc = t.closest("[data-sx-archive]");
    if (arc) return archive(arc.dataset.sxArchive);
    var dots = t.closest("[data-sx-rowmenu]");
    if (dots) {
      e.preventDefault();
      if (menuFor === dots.dataset.sxRowmenu) return closeMenu();
      var r = dots.getBoundingClientRect();
      return rowMenu(dots.dataset.sxRowmenu, r.left, r.bottom + 4);
    }
    var acc = t.closest("[data-sx-account]");
    if (acc) return accountMenu(acc);
    var f = t.closest("[data-sx-fold]");
    if (f) {
      fold[f.dataset.sxFold] = f.getAttribute("aria-expanded") !== "true";
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(fold)); } catch (er) {}
      return render();
    }
    var rs = t.closest("[data-sx-restore]");
    if (rs) return restore(rs.dataset.sxRestore, rs);
    if (t.closest("[data-sx-search]")) return openSearch();
  });
  // Right click on a computer, a long press on a phone: the topic's menu.
  document.addEventListener("contextmenu", function (e) {
    var r = e.target.closest && e.target.closest(".sx-trow[data-sx-id]");
    if (!r || r.classList.contains("sx-arch")) return;
    e.preventDefault();
    var box = r.getBoundingClientRect(), x = e.clientX, y = e.clientY;
    // where the press was; a contextmenu without a position (a keyboard's menu key) opens under the row
    if (!isFinite(x) || !isFinite(y) || (!x && !y)) { x = box.left + 24; y = box.bottom + 4; }
    rowMenu(r.dataset.sxId, x, y);
  });
  var press = null;
  document.addEventListener("touchstart", function (e) {
    var r = e.target.closest && e.target.closest(".sx-trow[data-sx-id]");
    if (!r || r.classList.contains("sx-arch")) return;
    var p = e.touches[0];
    press = setTimeout(function () { press = "fired"; rowMenu(r.dataset.sxId, p.clientX, p.clientY); }, 550);
  }, { passive: true });
  ["touchend", "touchmove", "touchcancel"].forEach(function (k) {
    document.addEventListener(k, function (e) {
      if (press === "fired" && k === "touchend") e.preventDefault(); // the long press opened the menu: no tap on the row
      if (press && press !== "fired") clearTimeout(press);
      press = null;
    }, { passive: false });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { if (!menu.hidden) closeMenu(); else if (state.searching) closeSearch(); }
  });

  // ---------- search: topic names and descriptions at once, then what was said in them ----------

  var searchTimer = null, searchSeq = 0;
  function openSearch() {
    var host = window.matchMedia("(min-width: 1024px)").matches ? $("sx-list") : $("sx-ph-groups");
    if (!host || state.searching) return;
    state.searching = { host: host, q: "", remote: null, loading: false, error: null };
    var bar = document.createElement("div");
    bar.className = "sx-searchbar";
    bar.innerHTML = '<label class="sx-searchfield"><svg class="sx-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" maxlength="200" autocomplete="off" placeholder="' +
      esc(S.searchPlaceholder) + '" aria-label="' + esc(S.search) + '"></label><button type="button" class="sx-link" data-sx-search-close>' + esc(S.searchCancel) + "</button>";
    host.parentNode.insertBefore(bar, host);
    state.searching.bar = bar;
    document.body.classList.add("sx-searching");
    var input = bar.querySelector("input");
    input.addEventListener("input", function () { searchInput(input.value); });
    bar.querySelector("[data-sx-search-close]").onclick = closeSearch;
    host.innerHTML = "";
    input.focus();
  }
  function closeSearch() {
    if (!state.searching) return;
    clearTimeout(searchTimer);
    state.searching.bar.remove();
    state.searching = null;
    document.body.classList.remove("sx-searching");
    render();
  }
  function searchInput(q) {
    var s = state.searching;
    s.q = q;
    s.remote = null;
    s.error = null;
    clearTimeout(searchTimer);
    var ready = q.trim().length >= 2 || /[㐀-鿿]/.test(q);
    s.loading = ready;
    searchRender();
    if (!ready) return;
    var mine = ++searchSeq;
    searchTimer = setTimeout(function () {
      fetch("/search?q=" + encodeURIComponent(q.trim()), { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); })
        .then(function (j) { if (mine === searchSeq && state.searching) { s.remote = j; s.loading = false; searchRender(); } },
          function () { if (mine === searchSeq && state.searching) { s.error = S.searchFailed; s.loading = false; searchRender(); } });
    }, 300);
  }
  function hl(text, words) {
    var out = esc(text);
    words.forEach(function (w) { if (w) out = out.split(esc(w)).join("<mark>" + esc(w) + "</mark>"); });
    return out;
  }
  function searchRender() {
    var s = state.searching;
    if (!s) return;
    var words = s.q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    var matches = words.length ? (state.topics || []).filter(function (t) {
      var text = (t.name + " " + (t.desc || "")).toLocaleLowerCase();
      return words.every(function (w) { return text.indexOf(w) >= 0; });
    }) : [];
    var html = matches.length ? '<div class="sx-grp">' + esc(fill(S.topicsN, { n: matches.length })) + "</div>" + matches.map(function (t) {
      return '<a class="sx-hit" href="/r/' + encodeURIComponent(t.id) + '"><b>' + hl(t.name, words) + "</b><span>" + hl(firstLine(t.desc) || "—", words) + "</span></a>";
    }).join("") : "";
    if (s.loading) html += '<p class="sx-note">' + esc(S.searching) + "</p>";
    if (s.error) html += '<p class="sx-note sx-bad">' + esc(s.error) + "</p>";
    if (s.remote) s.remote.rooms.forEach(function (room) {
      html += '<div class="sx-grp">' + esc(room.roomName) + " · " + room.results.length + (room.hasMore ? "+" : "") + "</div>" + room.results.map(function (hit) { return hitHtml(room, hit, words); }).join("") +
        (room.hasMore ? '<a class="sx-more-link" href="/r/' + encodeURIComponent(room.roomId) + "?search=" + encodeURIComponent(s.q.trim()) + '">' + esc(S.searchMore) + "</a>" : "");
    });
    if (!html && words.length && !s.loading) html = '<p class="sx-note">' + esc(S.noMatch) + "</p>";
    s.host.innerHTML = html;
  }
  function hitHtml(room, hit, words) {
    var q = "&fromSearch=" + encodeURIComponent(state.searching.q.trim());
    var href = "/r/" + encodeURIComponent(room.roomId) + (hit.type === "todo" ? "?item=" + encodeURIComponent(hit.id) : "?jump=" + encodeURIComponent(hit.seq)) + q;
    var head, detail;
    if (hit.type === "todo") {
      var st = hit.status === "done" ? S.stDelivered : state.me && hit.assignee === state.me.handle ? S.stYou : hit.status === "doing" ? S.stDoing : S.stWaiting;
      head = hit.id + " · " + st + " · " + hit.title;
      detail = hit.snippet;
    } else if (hit.type === "file") {
      head = hit.title;
      detail = fill(S.hitIn, { name: hit.id });
    } else {
      head = (hit.display || hit.who || "") + " · " + hit.id;
      detail = hit.snippet;
    }
    return '<a class="sx-hit" href="' + esc(href) + '"><b>' + hl(head || "", words) + "</b><span>" + hl(detail || "", words) + "</span></a>";
  }

  // ---------- /app: the big box, one sentence makes a topic ----------

  function createTopic(body, errEl, done) {
    errEl.hidden = true;
    return fetch("/rooms", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); })
      .then(function (j) { location.href = j.url; }, function (e) {
        errEl.textContent = (e && (e.message || e.next)) || fill(S.failed, { why: "" });
        errEl.hidden = false;
        done();
      });
  }
  var ask = document.querySelector("[data-sx-ask]");
  if (ask) {
    var box = ask.querySelector("textarea"), go = ask.querySelector(".sx-go"), askErr = document.querySelector("[data-sx-askerr]");
    var botSlot = document.querySelector("[data-sx-bot]");
    if (botSlot && window.botSvg) botSlot.outerHTML = window.botSvg("scorpio", "idle", "big");
    var sizeBox = function () {
      box.style.height = "auto";
      box.style.height = Math.min(box.scrollHeight, 320) + "px";
      go.classList.toggle("sx-off", !box.value.trim());
    };
    var busy = false;
    var send = function () {
      if (busy || !box.value.trim()) return;
      var n = chars(box.value);
      if (n > 2000) { askErr.textContent = n + " / 2000 · " + fill(S.over, { n: n - 2000 }); askErr.hidden = false; return; }
      busy = true;
      go.classList.add("sx-off");
      createTopic({ topic: box.value }, askErr, function () { busy = false; sizeBox(); });
    };
    box.addEventListener("input", sizeBox);
    box.addEventListener("keydown", function (e) {
      // Enter makes the topic; Shift+Enter is a new line; an input method choosing characters keeps its Enter.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
    });
    ask.addEventListener("submit", function (e) { e.preventDefault(); send(); });
    document.querySelectorAll("[data-sx-idea]").forEach(function (b) {
      b.onclick = function () { box.value = b.textContent; sizeBox(); box.focus(); };
    });
    if (window.matchMedia("(min-width: 1024px)").matches) box.focus();
    sizeBox();
  }

  // ---------- the new-topic form (a computer's middle, a phone's page) ----------

  var CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  function newCode() {
    var a = new Uint8Array(9), out = "";
    crypto.getRandomValues(a);
    for (var i = 0; i < 9; i++) out += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
    return out.slice(0, 3) + "-" + out.slice(3, 6) + "-" + out.slice(6);
  }
  function chars(s) { return Array.from(String(s).replace(/\r\n?/g, "\n").trim()).length; }
  document.querySelectorAll("[data-sx-newform]").forEach(function (form) {
    var name = form.querySelector("input[name=name]"), nameErr = name.parentNode.querySelector(".sx-err");
    var desc = form.querySelector("textarea"), count = form.querySelector("[data-sx-count]");
    var code = form.querySelector("[data-sx-code]"), sw = form.querySelector("[data-sx-public]"), codeFld = form.querySelector("[data-sx-codefld]");
    var submit = form.querySelector("button[type=submit]"), err = form.querySelector("[data-sx-formerr]");
    var counted = function () {
      var n = chars(desc.value);
      count.innerHTML = n > 2000 ? '<span class="sx-over">' + n + " / 2000 · " + esc(fill(S.over, { n: n - 2000 })) + "</span>" : n + " / 2000";
      submit.disabled = n > 2000;
      desc.style.height = "auto";
      desc.style.height = Math.min(Math.max(desc.scrollHeight + 2, 132), 360) + "px";
    };
    desc.addEventListener("input", counted);
    name.addEventListener("input", function () { name.removeAttribute("aria-invalid"); nameErr.hidden = true; });
    form.querySelector("[data-sx-newcode]").onclick = function () { code.textContent = newCode(); };
    sw.onclick = function () {
      var on = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(on));
      codeFld.classList.toggle("sx-dis", on);
      form.querySelector("[data-sx-newcode]").disabled = on;
    };
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!name.value.trim()) {
        name.setAttribute("aria-invalid", "true");
        nameErr.textContent = S.nameNeeded;
        nameErr.hidden = false;
        name.focus();
        return;
      }
      if (chars(desc.value) > 2000) return;
      var pub = sw.getAttribute("aria-checked") === "true";
      submit.disabled = true;
      var label = submit.textContent;
      submit.textContent = S.creating;
      createTopic({ name: name.value, topic: desc.value, code: pub ? "" : code.textContent.trim(), public: pub }, err, function () { submit.disabled = false; submit.textContent = label; });
    });
    counted();
    if (form.offsetParent) name.focus();
  });
})();
