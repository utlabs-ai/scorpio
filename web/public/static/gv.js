// The topic's overview page (/r/<id>/view): what the map shows comes from two sources, each fact from one. The
// overview booted into the page (docs/api/topics.md "The overview") decides which cards exist, the lanes and their
// order, the order inside a lane, the lines and their widths, the ranking and the 方向 / 消息 counts: drawn once, never
// re-sorted while open. The topic's own live frames (hello, members, todo, message) give each card its state, its
// size (big: in the topic and online), its line, its computer and its open tasks, the person's 等你 count, and the
// motion: a message lights its line and runs a dot once. An event touches only what it changed (docs/web.md).
(function () {
  "use strict";
  var boot = JSON.parse(document.getElementById("boot").textContent);
  var S = boot.S, G = S.gv, O = boot.overview, me = boot.me, viewer = !boot.member;
  var $ = function (id) { return document.getElementById(id); };
  var REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var CLOCK = "\u0000scheduled"; // the clock node's key: no member can have this name
  // The shared facts as the topic page keeps them (room-store.js): each written only through its one setter.
  var store = window.createRoomStore({ me: me, members: [], todo: { items: [], done: null }, room: boot.room });
  var state = store.state, writeTodo = store.claim("todo");
  var map = $("gv-map"), board = $("gv-board"), lines = $("gv-lines"), fly = $("gv-fly"), side = $("gv-side");
  var NS = "http://www.w3.org/2000/svg";

  function fill(s, vars) { return s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ""; }); }
  function ago(ms) {
    if (!ms) return "";
    var sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 45) return S.justNow;
    if (sec < 3600) return fill(S.minAgo, { n: Math.round(sec / 60) });
    if (sec < 86400) return fill(S.hourAgo, { n: Math.round(sec / 3600) });
    return fill(S.dayAgo, { n: Math.round(sec / 86400) });
  }
  function clock(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.classList.remove("hidden");
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.classList.add("hidden"); }, 2000);
  }
  function closeItem() {
    roomMembers.clearPop();
    $("item-scrim").classList.add("hidden");
    $("item-panel").classList.add("hidden");
    $("item-panel").innerHTML = "";
  }
  function member(name) { return state.members.find(function (m) { return m.name === name; }); }
  /** A name as the topic page shows it: the viewer's own agents without @owner, everyone else in full (room-schedules.js). */
  function shown(n) { return n.includes("@") && n.split("@").slice(1).join("@") === me ? n.split("@")[0] : n; }
  // The member popup and its words come from the members panel's own code: presence, robots, the sheet. This page is
  // read only (no @, no edits), so canWrite is false and nothing posts.
  var roomMembers = window.createRoomMembers({
    $: $, S: S, ago: ago, ask: function () { return Promise.resolve(false); }, boot: boot, canWrite: function () { return false; }, clock: clock,
    closeItem: closeItem, fill: fill, flash: toast, isOwner: function () { return state.room.owner === me; },
    names: function () { return new Set(state.members.map(function (m) { return m.name; })); },
    openPanel: function () {}, panels: { tab: function () {}, kind: function () { return ""; }, sideView: function () { return ""; } },
    plainLines: function (t) { return String(t).replace(/\s*\n+\s*/g, " · "); }, post: function () { return Promise.reject({ next: "" }); },
    refreshPanel: function () {}, renderSide: function () {}, showTopic: function () {}, state: state, toast: toast, topicHtml: function () { return ""; },
    pendingDone: {}, writeMembers: store.claim("members"),
  });

  // ---------------------------------------------------------------- what the overview decided: nodes, lanes, lines, ranking
  var agents = {}, people = [], drawn = {}; // drawn: name -> { el, anchor, kind: 'agent' | 'person' | 'clock', present, lane }
  O.agents.forEach(function (a) { agents[a.name] = a; });
  people = [me].concat(O.people.map(function (p) { return p.name; }).filter(function (n) { return n !== me; }));
  var PAIR = {}; // "a\nb" -> n, a < b
  O.pairs.forEach(function (p) { PAIR[p.a + "\n" + p.b] = p.n; });
  O.scheduled.forEach(function (s) { PAIR[[CLOCK, s.to].sort().join("\n")] = s.n; });
  var emax = 1;
  Object.keys(PAIR).forEach(function (k) { emax = Math.max(emax, PAIR[k]); });
  function partners(name, k) {
    return Object.keys(PAIR).map(function (key) {
      var ab = key.split("\n"), i = ab.indexOf(name);
      return i < 0 || ab[1 - i] === CLOCK ? null : [ab[1 - i], PAIR[key]];
    }).filter(Boolean).sort(function (x, y) { return y[1] - x[1]; }).slice(0, k);
  }

  function present(m) { return !!m && m.status === "active" && m.online; }
  function working(m) { return !!m && roomMembers.isWorkingAgent(m); }
  /** The one line under a name: the role card's first line, else the title of its doing task, else its oldest todo. */
  function lineOf(m) {
    var card = m ? roomMembers.roleCardOf(m).text : "";
    if (card) return card.split(/\n/)[0];
    var mine = state.todo.items.filter(function (i) { return i.assignee === (m ? m.name : "") && i.status !== "done"; });
    var doing = mine.find(function (i) { return i.status === "doing"; }) || mine[0];
    return doing ? doing.title : "";
  }
  function hostOf(m) {
    if (!m || !m.host) return "";
    var seat = member(m.host);
    return seat ? roomMembers.computerOf(seat) : "";
  }
  function openIds(name) {
    return state.todo.items.filter(function (i) { return i.assignee === name && i.status !== "done"; }).map(function (i) { return i.id; });
  }
  function stateOf(m) {
    if (!m) return { text: "", cls: "" };
    if (m.status === "left") return { text: S.memberLeft, cls: "" };
    var stuck = m.online && !m.hostOfflineSince && m.work === "blocked";
    return { text: roomMembers.presence(m), cls: stuck ? "wait" : working(m) ? "live" : "" };
  }

  // ---------------------------------------------------------------- drawing
  var prev = {};
  function set(key, val, fn) { if (prev[key] === val) return false; prev[key] = val; fn(val); return true; }
  function squares(el, ids) {
    if (!el) return;
    set("sq:" + el.dataset.n, ids.join(","), function () {
      el.innerHTML = ids.map(function (id) { return '<i title="' + escapeHtml(id) + '"></i>'; }).join("");
    });
  }
  function cardHtml(name, big) {
    var m = member(name);
    if (!big) return '<span class="gv-dot" data-anchor></span><div class="gv-r1"><span class="gv-n">' + escapeHtml(shown(name)) + '</span><span class="gv-sqs" data-n="' + escapeHtml(name) + '"></span></div><div class="gv-ln"></div>';
    var pr = partners(name, 2);
    return '<span class="gv-av" data-anchor><i class="gv-ring"></i>' + (m ? roomMembers.robot(m, "big") : botSvg(name, "", "big")) + '</span>' +
      '<div class="gv-r1"><span class="gv-n">' + escapeHtml(shown(name)) + '</span><span class="gv-m"></span></div><div class="gv-ln"></div><div class="gv-mh"></div>' +
      '<div class="gv-pr">' + (pr.length ? escapeHtml(fill(G.at, { list: pr.map(function (p) { return shown(p[0]) + " " + p[1]; }).join(" · ") })) : "") + '</div>' +
      '<span class="gv-sqs" data-n="' + escapeHtml(name) + '"></span>';
  }
  /** A card's shape follows whether its agent is in the topic now; its fields follow the member's. Only changes are written. */
  function updateCard(name) {
    var d = drawn[name], m = member(name), big = present(m), el = d.el;
    if (set("big:" + name, big, function () {
      el.className = "gv-card " + (big ? "big" : "sm");
      el.innerHTML = cardHtml(name, big);
      d.anchor = el.querySelector("[data-anchor]");
      ["sq", "st", "ln", "mh", "wk", "gone"].forEach(function (k) { delete prev[k + ":" + name]; });
      needLines = true;
    })) d.present = big;
    set("gone:" + name, !m || m.status === "left" || !m.online, function (v) { el.classList.toggle("gone", v); });
    set("ln:" + name, lineOf(m), function (v) { el.querySelector(".gv-ln").textContent = v; });
    if (big) {
      var st = stateOf(m);
      set("st:" + name, st.text + "|" + st.cls, function () { var e = el.querySelector(".gv-m"); e.className = "gv-m " + st.cls; e.textContent = st.text; });
      set("mh:" + name, hostOf(m), function (v) { el.querySelector(".gv-mh").textContent = v; });
      set("wk:" + name, working(m), function (v) {
        el.classList.toggle("wk", v);
        var bot = el.querySelector("svg.bot");
        if (bot && m) botSetState(bot, botState(m, false));
      });
    }
    squares(el.querySelector(".gv-sqs"), openIds(name));
  }
  function card(name) {
    var el = document.createElement("article");
    el.className = "gv-card";
    el.dataset.n = name;
    el.title = name;
    drawn[name] = { el: el, anchor: null, kind: "agent", present: false, lane: agents[name] ? agents[name].lane : null };
    return el;
  }
  function laneSection(lane, stacked) {
    var sec = document.createElement("section");
    sec.className = "gv-lane" + (stacked ? " stacked" : "");
    sec.dataset.lane = lane === null ? "" : lane;
    sec.innerHTML = '<h2 class="gv-lt" data-lane-title>' + escapeHtml(lane === null ? G.noLane : lane) + '</h2><div class="gv-cards"></div>';
    return sec;
  }
  var lanesEl, stackEl;
  function drawBoard() {
    var left = document.createElement("div");
    left.className = "gv-left";
    people.forEach(function (name, i) {
      var p = document.createElement("div");
      p.className = "gv-person " + (i ? "other" : "me");
      p.dataset.n = name;
      p.innerHTML = '<span class="gv-pav" data-anchor>' + escapeHtml(name.slice(0, 1)) + (i ? "" : '<b class="gv-cnt" id="gv-cnt"></b>') + '</span><span class="gv-nm">' + escapeHtml(name) + '</span>' + (i ? "" : '<span class="gv-sqs you" data-n="' + escapeHtml(name) + '"></span>');
      left.appendChild(p);
      drawn[name] = { el: p, anchor: p.querySelector("[data-anchor]"), kind: "person" };
    });
    if (O.scheduled.length) {
      var c = document.createElement("div");
      c.className = "gv-clock";
      c.innerHTML = '<span class="gv-av" data-anchor><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><span class="gv-nm">' + escapeHtml(G.scheduled) + '</span>';
      left.appendChild(c);
      drawn[CLOCK] = { el: c, anchor: c.querySelector("[data-anchor]"), kind: "clock" };
    }
    lanesEl = document.createElement("div");
    lanesEl.className = "gv-lanes";
    stackEl = null;
    O.lanes.forEach(function (L) {
      var sec = laneSection(L.lane, L.stacked), cards = sec.querySelector(".gv-cards");
      L.agents.forEach(function (name) { cards.appendChild(card(name)); });
      if (L.stacked) {
        if (!stackEl) { stackEl = document.createElement("div"); stackEl.className = "gv-stack"; lanesEl.appendChild(stackEl); }
        stackEl.appendChild(sec);
      } else lanesEl.appendChild(sec);
    });
    board.innerHTML = "";
    board.appendChild(left);
    board.appendChild(lanesEl);
    if (!O.agents.length) {
      var empty = document.createElement("p");
      empty.className = "gv-empty";
      empty.textContent = G.empty;
      map.appendChild(empty);
    }
  }
  /** An agent not on the map that is in the topic now: at the end of its lane's column, or a new stacked lane. */
  function appendAgent(name, m) {
    var lane = m.lane || null;
    var sec = lanesEl.querySelector('.gv-lane[data-lane="' + CSS.escape(lane === null ? "" : lane) + '"]');
    if (!sec) {
      sec = laneSection(lane, true);
      if (!stackEl) { stackEl = document.createElement("div"); stackEl.className = "gv-stack"; lanesEl.appendChild(stackEl); }
      stackEl.appendChild(sec);
    }
    sec.querySelector(".gv-cards").appendChild(card(name));
    drawn[name].lane = lane;
    updateCard(name);
    var empty = map.querySelector(".gv-empty");
    if (empty) empty.remove();
  }

  // ---------------------------------------------------------------- lines: anyone who talked gets one, thicker = more
  var LINE = {}; // key -> { path, s, op }
  var needLines = false;
  function anchorPoint(name) {
    var d = drawn[name];
    if (!d || !d.anchor) return null;
    var r = d.anchor.getBoundingClientRect(), b = map.getBoundingClientRect();
    return { x: r.left - b.left + map.scrollLeft + r.width / 2, y: r.top - b.top + map.scrollTop + r.height / 2 };
  }
  function laneOf(name) { return drawn[name] && drawn[name].kind === "agent" ? drawn[name].lane : undefined; }
  function link(an, bn) {
    var a = anchorPoint(an), b = anchorPoint(bn);
    if (!a || !b) return null;
    if (laneOf(an) !== undefined && laneOf(an) === laneOf(bn)) {
      var bow = 22 + Math.abs(b.y - a.y) * .2;
      return { a: a, c1: { x: a.x - bow, y: a.y }, c2: { x: b.x - bow, y: b.y }, b: b };
    }
    if (Math.abs(a.x - b.x) < 2) return { a: a, c1: { x: a.x - 30, y: a.y }, c2: { x: b.x - 30, y: b.y }, b: b };
    var flip = a.x > b.x;
    if (flip) { var t = a; a = b; b = t; }
    var k = (b.x - a.x) * .5, s = { a: a, c1: { x: a.x + k, y: a.y }, c2: { x: b.x - k, y: b.y }, b: b };
    return flip ? rev(s) : s;
  }
  function rev(s) { return { a: s.b, c1: s.c2, c2: s.c1, b: s.a }; }
  function cd(s) { var f = function (p) { return p.x.toFixed(1) + " " + p.y.toFixed(1); }; return "M" + f(s.a) + "C" + f(s.c1) + " " + f(s.c2) + " " + f(s.b); }
  function cpt(s, t) { var u = 1 - t; return { x: u * u * u * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.b.x, y: u * u * u * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.b.y }; }
  function lineFor(key, n) {
    var ab = key.split("\n"), t = Math.sqrt(n / emax);
    var gone = ab.some(function (x) { return drawn[x] && drawn[x].kind === "agent" && !drawn[x].present; });
    return { ab: ab, w: .8 + t * 8, op: (gone ? .07 : .12) + (gone ? .16 : .3) * t };
  }
  /** Every line from the anchors as they are now: after the first draw, a card that changed size, or a resize. */
  function layoutLines() {
    needLines = false;
    var w = board.scrollWidth, h = board.scrollHeight;
    [lines, fly].forEach(function (svg) { svg.setAttribute("width", w); svg.setAttribute("height", h); });
    Object.keys(PAIR).sort(function (a, b) { return PAIR[a] - PAIR[b]; }).forEach(function (key) {
      var ab = key.split("\n"), L = LINE[key], s = link(ab[0], ab[1]), pa = anchorPoint(ab[0]);
      if (!s) { if (L) { L.path.remove(); delete LINE[key]; } return; }
      var f = lineFor(key, PAIR[key]);
      if (!L) {
        L = LINE[key] = { path: document.createElementNS(NS, "path"), s: s, op: f.op, from: 0, until: 0 };
        lines.appendChild(L.path);
      }
      L.s = s; L.op = f.op; L.aName = s.a.x === pa.x && s.a.y === pa.y ? ab[0] : ab[1]; // which end s.a is
      L.path.setAttribute("d", cd(s));
      L.path.setAttribute("stroke-width", f.w.toFixed(1));
      if (!L.until) L.path.setAttribute("stroke-opacity", f.op.toFixed(3));
    });
  }
  var layoutTimer = null;
  function relayout() { if (layoutTimer) return; layoutTimer = requestAnimationFrame(function () { layoutTimer = null; layoutLines(); }); }

  // ---------------------------------------------------------------- the ranking (fixed order) and the counts
  function drawSide() {
    side.innerHTML = '<div class="gv-hd">' + escapeHtml(G.activity) + '</div><table class="gv-rank">' + O.agents.map(function (a, i) {
      return '<tr data-n="' + escapeHtml(a.name) + '" title="' + escapeHtml(a.name) + '"><td class="i">' + (i + 1) + '</td><td class="nm">' + escapeHtml(shown(a.name)) + '</td><td class="r">' + a.activity + '</td><td class="r"><span class="gv-tag' + (a.lane ? "" : " none") + '">' + escapeHtml(a.lane || G.noLane) + '</span></td></tr>';
    }).join("") + "</table>";
  }
  function flash(el) { if (REDUCED || !el) return; el.classList.remove("fresh"); void el.offsetWidth; el.classList.add("fresh"); setTimeout(function () { el.classList.remove("fresh"); }, 650); }
  function counts(live) {
    set("c:lanes", O.lanes.filter(function (L) { return L.lane !== null; }).length, function (v) { $("gv-lanes").textContent = v; });
    set("c:messages", O.messages, function (v) { $("gv-messages").textContent = v; });
    set("c:working", state.members.filter(roomMembers.isWorkingAgent).length, function (v) { $("gv-working").textContent = v; });
    var onYou = viewer ? [] : openIds(me);
    if (set("c:onyou", onYou.length, function (v) {
      $("gv-onyou").textContent = v;
      var cnt = $("gv-cnt");
      if (cnt) { cnt.textContent = v || ""; cnt.classList.toggle("zero", !v); }
    }) && live) { flash($("gv-onyou")); flash($("gv-cnt")); }
    squares(document.querySelector('.gv-person.me .gv-sqs'), onYou);
  }
  function render(live) {
    Object.keys(drawn).forEach(function (name) { if (drawn[name].kind === "agent") updateCard(name); });
    counts(live);
    if (needLines) relayout();
  }

  // ---------------------------------------------------------------- a message: its line lights up, a dot runs from sender to the one @'d, once
  var flights = [], LIT = 650;
  function sampler(s) {
    var pts = [];
    for (var i = 0; i <= 48; i++) pts.push(cpt(s, i / 48));
    var L = [0];
    for (var j = 1; j < pts.length; j++) L.push(L[j - 1] + Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y));
    var tot = L[L.length - 1];
    return { len: tot, at: function (u) { var want = u * tot, k = 1; while (k < L.length - 1 && L[k] < want) k++; var f = (want - L[k - 1]) / ((L[k] - L[k - 1]) || 1); return { x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * f, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * f }; } };
  }
  var animating = false;
  function sendDot(a, b) {
    if (REDUCED || !drawn[a] || !drawn[b] || a === b) return;
    var key = [a, b].sort().join("\n"), L = LINE[key];
    if (!L) {
      // a pair with no line yet (their first message in the window): a thin one
      if (!PAIR[key]) PAIR[key] = 1;
      layoutLines();
      L = LINE[key];
      if (!L) return;
    }
    var s = L.aName === a ? L.s : rev(L.s);
    var sm = sampler(s), now = performance.now();
    var g = document.createElementNS(NS, "g"), parts = [];
    [[8, .28, 1], [2.2, .35], [2.6, .55], [3.6, 1]].forEach(function (c) {
      var e = document.createElementNS(NS, "circle");
      e.setAttribute("r", c[0]); e.setAttribute("opacity", c[1]);
      if (c[2]) { e.setAttribute("filter", "url(#gv-blur)"); e.setAttribute("class", "gv-blur"); }
      g.appendChild(e); parts.push(e);
    });
    fly.appendChild(g);
    var dur = Math.min(1250, Math.max(560, sm.len * 1.7));
    flights.push({ g: g, parts: parts, sm: sm, t0: now, dur: dur, L: L });
    L.until = Math.max(L.until || 0, now + dur + LIT);
    L.from = L.from && L.until > now ? L.from : now;
    L.path.classList.add("gv-lit");
    if (!animating) { animating = true; requestAnimationFrame(step); }
  }
  function step(now) {
    flights = flights.filter(function (f) {
      var u = (now - f.t0) / f.dur;
      if (u >= 1.15) { f.g.remove(); return false; }
      var e = function (x) { x = Math.max(0, Math.min(1, x)); return x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
      var lag = [0, .12, .06, 0];
      f.parts.forEach(function (c, i) { var p = f.sm.at(e(u - lag[i])); c.setAttribute("cx", p.x.toFixed(1)); c.setAttribute("cy", p.y.toFixed(1)); });
      f.g.setAttribute("opacity", u > 1 ? Math.max(0, 1 - (u - 1) / .15) : 1);
      return true;
    });
    var lit = 0;
    Object.keys(LINE).forEach(function (key) {
      var L = LINE[key];
      if (!L.until) return;
      var up = Math.min(1, (now - L.from) / 180), down = Math.max(0, Math.min(1, (L.until - now) / LIT)), k = Math.min(up, down);
      if (now >= L.until) { L.until = 0; L.from = 0; k = 0; L.path.classList.remove("gv-lit"); } else lit++;
      L.path.setAttribute("stroke-opacity", (L.op + (.85 - L.op) * k).toFixed(3));
    });
    if (flights.length || lit) requestAnimationFrame(step); else animating = false;
  }

  // ---------------------------------------------------------------- the panels: a card or a row opens the member's; a lane title its agents
  function showLane(lane) {
    var L = O.lanes.find(function (x) { return (x.lane === null ? "" : x.lane) === lane; });
    if (!L) return;
    var rows = L.agents.map(function (name) {
      var a = agents[name], m = member(name);
      return '<div class="gv-lrow" data-n="' + escapeHtml(name) + '" title="' + escapeHtml(name) + '">' + (m ? roomMembers.robot(m) : botSvg(name, "", "")) + '<span class="gv-n">' + escapeHtml(shown(name)) + '</span><span class="gv-sqs">' +
        openIds(name).map(function (id) { return '<i title="' + escapeHtml(id) + '"></i>'; }).join("") + '</span><span class="r">' + a.activity + '</span></div>';
    }).join("");
    roomMembers.popup('<div class="mhead"><div class="mw"><h3>' + escapeHtml(L.lane === null ? G.noLane : L.lane) + '</h3><div class="msub"><span>' + escapeHtml(G.activity) + ' ' + L.activity + '</span></div></div></div>' +
      '<div class="mlbl">' + escapeHtml(S.membersTab) + '</div>' + rows, "lane:" + lane);
  }
  function showNode(name) {
    if (name === CLOCK) return;
    if (member(name)) roomMembers.showMember(name, false);
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-close-item]") || e.target === $("item-scrim")) return closeItem();
    var title = e.target.closest("[data-lane-title]");
    if (title) return showLane(title.closest(".gv-lane").dataset.lane);
    var node = e.target.closest("[data-n]");
    if (node && !node.classList.contains("gv-sqs")) return showNode(node.dataset.n);
  });

  // ---------------------------------------------------------------- live: the topic's own frames
  var socket = window.createRoomSocket({
    roomId: boot.roomId, viewing: false, reconnecting: S.reconnecting,
    status: { status: function () {}, clear: function () {} },
    hello: function (f) {
      roomMembers.set(f.members);
      writeTodo({ items: (f.todo && f.todo.items) || [], done: null });
      render(false);
    },
    members: function (f) {
      roomMembers.set(f.members);
      // Only the cards whose fields changed are written; an agent not on the map that is now active gets a card.
      f.members.forEach(function (m) {
        if (m.kind !== "agent") return;
        if (drawn[m.name]) updateCard(m.name);
        else if (present(m)) appendAgent(m.name, m);
      });
      counts(true);
      if (needLines) relayout();
      roomMembers.refreshPopup();
    },
    removed: function () { location.href = "/r/" + encodeURIComponent(boot.roomId); },
    gone: function () { location.href = "/r/" + encodeURIComponent(boot.roomId); },
  });
  socket.on("todo", function (f) {
    writeTodo({ items: f.items || [], done: null });
    // the squares and the task-title line of every card (an item moved from one name to another touches two)
    Object.keys(drawn).forEach(function (name) {
      if (drawn[name].kind !== "agent") return;
      squares(drawn[name].el.querySelector(".gv-sqs"), openIds(name));
      set("ln:" + name, lineOf(member(name)), function (v) { drawn[name].el.querySelector(".gv-ln").textContent = v; });
    });
    counts(true);
  });
  socket.on("message", function (f) {
    var m = f.message;
    if (!m || m.fromKind === "system") return;
    var from = m.scheduled ? CLOCK : m.from;
    if (!drawn[from]) return;
    (m.mentions || []).forEach(function (to) { if (drawn[to]) sendDot(from, to); });
  });
  window.addEventListener("resize", relayout);

  // ---------------------------------------------------------------- go
  var defs = document.createElementNS(NS, "defs");
  defs.innerHTML = '<filter id="gv-blur" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>';
  fly.appendChild(defs);
  drawBoard();
  drawSide();
  render(false);
  layoutLines();
  socket.connect();
})();
