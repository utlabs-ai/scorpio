// The /spawn card owns its draft and parameter lists; the composer owns delivery.
(function () {
  "use strict";
  window.createSpawnCard = function (ctx) {
    var S = ctx.S, state = ctx.state, escape = ctx.escape, fill = ctx.fill, picker = ctx.picker;
    var fallback = {
      // Copy of server/src/spawn-config.ts; a validated server list replaces it on load.
      perm: [
        { id: "ask", label: {"en": "Ask me in Scorpio", "zh": "在 Scorpio 里问我"}, about: {"en": "Claude Code and Codex run with your own settings on your computer; when they ask for permission, it comes to you in Scorpio. If your Codex settings set no approval policy, --ask-for-approval on-request is added, so it asks you before leaving its sandbox.", "zh": "Claude Code 和 Codex 照你电脑上的配置运行，要申请权限时弹到 Scorpio 里给你答。Codex 配置里没设审批策略的，加 --ask-for-approval on-request，出沙箱前先来问你。"} },
        { id: "auto", label: {"en": "Approve for me", "zh": "代我审批"}, about: {"en": "Claude Code's auto mode (--permission-mode auto); Codex's auto-review (--approve-for-me). What they block is not sent to you.", "zh": "Claude Code 的 auto 模式（--permission-mode auto）；Codex 的自动审（--approve-for-me）。它们拦下的不问你。"} },
        { id: "all", label: {"en": "Allow everything", "zh": "全部放行"}, about: {"en": "Claude Code skips all permission checks (--dangerously-skip-permissions); Codex runs fully open (--ask-for-approval never --sandbox danger-full-access).", "zh": "Claude Code 跳过所有权限（--dangerously-skip-permissions）；Codex 完全放开（--ask-for-approval never --sandbox danger-full-access）。"}, note: {"en": "This agent skips every approval, as before. It applies to this session only and changes no setting on your computer.", "zh": "这个 agent 跳过所有审批，和以前一样。只管它这一次会话，不改你电脑上的设置。"} },
      ],
      claude: { models: [{ id: "claude-opus-5-5" }], efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"].map(function (id) { return { id: id }; }), default: { model: "claude-opus-5-5", effort: "medium" } },
      codex: { models: [{ id: "gpt-6.1-sol" }], efforts: ["low", "medium", "high", "xhigh"].map(function (id) { return { id: id }; }), default: { model: "gpt-6.1-sol", effort: "medium" } },
    };
    // Every key in the card reads these two scans of all the page's messages; work them out once per message list and daemon.
    var scanKey = null, scanned = null;
    function scan() {
      var last = state.messages[state.messages.length - 1], key = state.messages.length + ":" + (last ? last.seq : "") + ":" + seat;
      if (key !== scanKey) { scanKey = key; scanned = { history: commandHistory(), spawned: ctx.spawnedNames(state.messages, state.me) }; }
      return scanned;
    }
    function commandHistory() {
      var out = [];
      state.messages.forEach(function (m) {
        if (m.from !== state.me && ctx.ownerOf(m.from) !== state.me) return;
        var match = /^\s*((?:@[A-Za-z0-9_.@-]+\s+)+)\/spawn\s+(claude|codex)(?:\s+([\s\S]*))?$/i.exec(m.text || "");
        if (!match || !match[1].trim().split(/\s+/).some(function (n) { return ctx.hostSeat(n.slice(1)) && n.slice(1) === seat && ctx.hostSeat(n.slice(1)).owner === state.me; })) return;
        var tail = match[3] || "", name = null, dir = null;
        var named = /^([a-z][a-z0-9_-]{0,31})(?:\s+|$)/.exec(tail);
        if (named) { name = named[1]; tail = tail.slice(named[0].length); }
        var quoted = /^cwd="((?:\\.|[^"\\])*)"/.exec(tail);
        var bare = /^([/~～][^\s，。、；：！？]*)/.exec(tail);
        if (quoted) dir = quoted[1].replace(/\\(["\\])/g, "$1");
        else if (bare) dir = bare[1].replace(/^～/, "~");
        out.push({ name: name, dir: dir, ts: m.ts || 0 });
      });
      return out.reverse();
    }

    var config = null, loading = null, active = false, seat = null, field = null, query = "", hi = 0;
    var drafts = {}, draft, taskActive = false;
    function perms() { return (config || fallback).perm; }
    function permNote(id) {
      var entry = perms().find(function (p) { return p.id === id; });
      var builtin = fallback.perm.find(function (p) { return p.id === id; });
      return entry && entry.note && entry.note[ctx.lang] || builtin && builtin.note && builtin.note[ctx.lang] || fill(S.spPermOnceNote, { level: permLabel(id) });
    }
    function permLabel(id) {
      var entry = perms().find(function (p) { return p.id === id; }) || fallback.perm.find(function (p) { return p.id === id; });
      return entry ? entry.label[ctx.lang] : "";
    }
    function hasPerms() { var host = ctx.hostSeat(seat); return host && Array.isArray(host.perms) && host.perms.length > 0; }
    function inheritedPerm() { var left = takeover(); return left ? left.perm && left.perm.level : ctx.spawnPerm; }
    function firstPermTitle() {
      var level = permLabel(inheritedPerm());
      return level ? fill(takeover() ? S.spKeepLast : S.spAsSetNow, { level: level }) : takeover() ? S.spKeep : S.spAsSet;
    }
    function permissionNote() {
      if (!hasPerms()) return S.spPermOldDaemon;
      if (draft.perm) return fill(S.spPermOnceNote, { level: permLabel(draft.perm) });
      var level = permLabel(inheritedPerm());
      return level ? fill(takeover() ? S.spPermKeepNote : S.spPermAsSetNote, { level: level }) : takeover() ? S.spPermUnknownKeep : S.spPermUnknownSetting;
    }
    function hintHtml(text) { return escape(text).replace(/--[a-z-]+(?: [a-z-]+)?/g, function (flag) { return '<code>' + flag + '</code>'; }); }
    function options() { return (config || fallback)[draft.cli]; }
    function available(kind) {
      var host = ctx.hostSeat(seat);
      return !host || !Array.isArray(host.clis) || host.clis.some(function (c) { return c.kind === kind && c.installed; });
    }
    function load() {
      if (config) return Promise.resolve();
      if (loading) return loading;
      loading = fetch("/api/v1/config/spawn").then(function (r) { if (!r.ok) throw Error(r.status); return r.json(); }).then(function (j) {
        config = {};
        ["claude", "codex"].forEach(function (k) {
          var v = j[k];
          config[k] = v && Array.isArray(v.models) && v.models.length && Array.isArray(v.efforts) && v.efforts.length && v.default ? v : fallback[k];
        });
        config.perm = Array.isArray(j.perm) && j.perm.length && j.perm.every(function (p) {
          return p && /^(ask|auto|all)$/.test(p.id) && p.label && typeof p.label.en === "string" && p.label.en && typeof p.label.zh === "string" && p.label.zh;
        }) ? j.perm : fallback.perm;
        if (active) render();
      }).catch(function () { config = fallback; if (active) render(); });
      return loading;
    }
    function autoName() {
      var used = new Set(state.members.map(function (m) { return m.name.split("@")[0]; }).concat(Object.keys(scan().spawned)));
      var i = 1;
      while (used.has(draft.cli + "-" + i)) i++;
      return draft.cli + "-" + i;
    }
    function takeover() { return state.members.find(function (m) { return m.name === draft.name + "@" + state.me && m.kind === "agent" && m.status === "left"; }); }
    function lastDir() { var h = scan().history.find(function (h) { return h.name === draft.name; }); return h && h.dir; }
    function taskCount(m) { return ((state.todo && state.todo.items) || []).filter(function (t) { return t.assignee === m.name && t.status !== "done"; }).length; }
    function takeoverNote(m) {
      var count = taskCount(m);
      return S.spTakeover + (count ? " · " + fill(count === 1 ? S.spTaskOne : S.spTasks, { n: count }) : "") + (m.handoff ? " · " + S.spHandoff : "");
    }
    function value(key) { return key === "perm" ? (draft.perm ? permLabel(draft.perm) : takeover() ? S.spKeep : S.spAsSet) : key === "name" ? draft.name || autoName() : key === "dir" ? draft.dir || S.spWorkspace : key === "lane" ? draft.lane || (takeover() ? S.spKeep : S.laneNone) : key === "cli" ? draft.cli : draft[key] || options().default[key]; }
    function label(key) { return key === "cli" ? "CLI" : S[{ name: "spName", lane: "spLane", dir: "spDirectory", model: "spModel", effort: "spEffort", perm: "spPerm" }[key]]; }
    /** The lanes the topic's agents carry, active and left, each once, in order (the 「方向」 list; docs/api/topics.md). */
    function lanes() {
      var seen = new Set();
      state.members.forEach(function (m) { if (m.kind === "agent" && m.lane) seen.add(m.lane); });
      return Array.from(seen).sort(function (a, b) { return a.localeCompare(b); });
    }
    function parameter(key) {
      var def = key === "cli" ? !draft.cliPicked : !draft[key], left = takeover(), sub = "";
      if (left && key === "name") sub = takeoverNote(left);
      if (left && key === "lane" && !draft.lane) sub = S.spLaneKeep;
      if (left && key === "dir") {
        sub = lastDir() ? fill(S.spLastDir, { name: draft.name }) : fill(S.spNeedDir, { name: draft.name });
        if (!lastDir()) def = false;
      }
      return '<button type="button" class="spf p ' + key + (def ? ' def' : '') + (field === key ? ' on' : '') + '" data-field="' + key + '" aria-haspopup="listbox" aria-expanded="' + (field === key) + '"><span class="lab">' + escape(label(key)) + (def && key !== "cli" && key !== "perm" ? '<span class="d"> · ' + escape(S.spDefault) + '</span>' : '') + '</span><span class="v' + (key === "dir" && draft.dir ? ' mono' : '') + '">' + escape(value(key)) + '</span><svg class="cv" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>' + (sub ? '<span class="sub">' + escape(sub) + '</span>' : '') + '</button>';
    }
    function render() {
      var focus = picker.contains(document.activeElement) && document.activeElement.dataset.field;
      var taskFocused = document.activeElement === picker.querySelector("textarea"), start, end;
      if (taskFocused) { start = document.activeElement.selectionStart; end = document.activeElement.selectionEnd; }
      picker.innerHTML = '<div class="spc" role="dialog" aria-label="' + escape(S.spCardTitle) + '"><div class="spc-h"><b>' + escape(S.spCardTitle) + '</b><small>' + escape(fill(S.spSendTo, { computer: ctx.computerOf(ctx.hostSeat(seat)) })) + '</small><span class="esc" aria-hidden="true">Esc</span><button type="button" class="x" tabindex="-1" data-collapse aria-label="' + escape(S.spCollapse) + '">✕</button></div><div class="spf task' + (taskActive ? ' on' : '') + '"><label class="lab" for="sp-task">' + escape(S.spTask) + '</label><textarea rows="5" id="sp-task" placeholder="' + escape(S.spTaskHead) + '">' + escape(draft.task) + '</textarea></div><div class="spc-error" role="alert"' + (taskError() ? '' : ' hidden') + '>' + escape(taskError()) + '</div><div class="spc-ps' + (takeover() ? ' subs' : '') + '">' + ["cli", "name", "lane", "dir", "model", "effort"].concat(hasPerms() ? ["perm"] : []).map(parameter).join("") + '</div><p class="spc-note">' + escape(permissionNote()) + '</p><div class="spc-f"><span class="k">' + escape(fill(S.spCardKeys, { mod: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl" })) + '</span><button type="button" class="go" data-start' + (canStart() ? '' : ' disabled') + '>' + escape(S.spStart) + '</button></div></div>';
      if (field) renderList();
      if (taskFocused) { var t = picker.querySelector("textarea"); t.focus(); t.setSelectionRange(start, end); }
      else if (focus) picker.querySelector('[data-field="' + focus + '"]').focus();
    }
    function rows() {
      var out = [], current = draft[field] || "", history = scan().history;
      function add(v, title, note, disabled, group, two) { out.push({ value: v, title: title, note: note || "", disabled: !!disabled, group: group, two: two, cur: !disabled && current === v }); }
      if (field === "cli") {
        add("", S.spUseDefault, available("claude") ? "claude" : "codex");
        ["claude", "codex"].forEach(function (k) { add(k, k, available(k) ? k === "claude" ? "Claude Code" : "Codex" : fill(S.spNotInstalled, { host: ctx.computerOf(ctx.hostSeat(seat)) }), !available(k)); });
      } else if (field === "name") {
        add("", S.spUseDefault, fill(S.spNoNameNote, { name: autoName() }));
        // Every agent of mine that left, most recent first; the group title counts the ones listed.
        var mine = state.members.filter(function (m) { return m.kind === "agent" && m.owner === state.me && m.status === "left"; });
        if (/^[a-z][a-z0-9_-]{0,31}$/.test(query) && !mine.some(function (m) { return m.name.split("@")[0] === query; })) add(query, query, S.spNewNameNote, false, S.spNewNameGroup);
        var left = mine.filter(function (m) { return m.name.split("@")[0].startsWith(query); })
          .sort(function (a, b) { return (b.lastActive || 0) - (a.lastActive || 0); });
        left.forEach(function (m) {
          add(m.name.split("@")[0], m.name.split("@")[0], takeoverNote(m), false, S.spTakeoverGroup + " · " + left.length);
        });
        var names = scan().spawned;
        Object.keys(names).filter(function (n) { return names[n] === seat && n.startsWith(query) && !state.members.some(function (m) { return m.name === n + "@" + state.me; }); }).forEach(function (n) {
          var record = history.find(function (h) { return h.name === n; });
          add(n, n, fill(S.spSpawned, { time: record && record.ts ? new Date(record.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "" }), false, S.spSpawnedGroup);
        });
      } else if (field === "lane") {
        // No lane, or for a takeover the seat's own; every lane the topic has; a new word typed above (the daemon's rule for lane=).
        add("", takeover() ? S.spKeep : S.laneNone, takeover() ? S.spLaneKeep : "");
        var known = lanes();
        if (/^[^\s|'"]{1,32}$/u.test(query) && known.indexOf(query) < 0) add(query, query, "", false, S.laneNew);
        known.filter(function (l) { return l.indexOf(query) >= 0; }).forEach(function (l) { add(l, l, "", false, S.laneLabel); });
      } else if (field === "dir") {
        var seen = new Set();
        history.forEach(function (h) { if (h.dir && !seen.has(h.dir) && h.dir.startsWith(query)) { seen.add(h.dir); add(h.dir, h.dir, S.spUsedDir); } });
        if (/^[\/~]/.test(query) && !seen.has(query)) add(query, query, S.spUsePath);
        add("", S.spUseDefault, (takeover() && lastDir() ? lastDir() : S.spWorkspace + " · ~/.scorpio/topics/" + ctx.roomId + "/workspace"), !!takeover() && !lastDir());
        if (takeover() && !lastDir()) out[out.length - 1].note = fill(S.spNeedDir, { name: draft.name });
      } else if (field === "perm") {
        add("", firstPermTitle(), takeover() ? S.spPermTakeover : S.spPermSettings, false, null, true);
        ["all", "ask", "auto"].forEach(function (id) {
          var entry = perms().find(function (p) { return p.id === id; });
          if (entry) add(entry.id, entry.label[ctx.lang], entry.about && entry.about[ctx.lang], false, null, true);
        });
      } else {
        add("", S.spUseDefault, options().default[field]);
        options()[field + "s"].forEach(function (entry) { add(entry.id, entry.id, entry.about && entry.about[ctx.lang], false, null, true); });
      }
      // CLI always has a value, including when its default row is chosen.
      if (field === "cli") out.forEach(function (r, i) { r.cur = i === 0 ? !draft.cliPicked : !!draft.cliPicked && r.value === draft.cli; });
      return out;
    }
    function renderList() {
      var old = picker.querySelector(".spl"), focused = old && old.contains(document.activeElement), pos = focused && document.activeElement.selectionStart;
      if (old) old.remove();
      var list = document.createElement("div"); list.className = "spl"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label(field));
      var entries = rows(), group = null, filter = field === "name" || field === "dir" || field === "lane";
      var hint = field === "name" ? S.spNewName : field === "lane" ? S.laneNew : S.spTypeDir;
      list.innerHTML = (filter ? '<input class="sq" aria-label="' + escape(field === "name" ? S.spNewName : field === "lane" ? S.laneLabel : S.spDirectory) + '" placeholder="' + escape(hint) + '" value="' + escape(query) + '">' : '') + entries.map(function (r, i) {
        var heading = r.group && r.group !== group ? '<div class="gh">' + escape(r.group) + '</div>' : ''; group = r.group;
        var title = escape(r.title);
        if (field === "dir" && query && r.title.startsWith(query)) title = '<span class="hit">' + escape(query) + '</span>' + escape(r.title.slice(query.length));
        return heading + '<div role="option" tabindex="-1" aria-selected="' + r.cur + '" aria-disabled="' + r.disabled + '" data-option="' + i + '" class="it' + (r.cur ? ' cur' : '') + (r.two ? ' two' : '') + (i === hi ? ' hi' : '') + '">' + (r.value === "" ? '<span class="use">' + title + '</span>' : '<b' + (field === "dir" ? ' class="mono"' : '') + '>' + title + '</b>') + (r.note ? '<small>' + (field === 'perm' ? hintHtml(r.note) : escape(r.note)) + '</small>' : '') + '</div>';
      }).join("") + (field === "dir" ? '<div class="ft">' + escape(S.spTypeDir) + '</div>' : '');
      picker.appendChild(list); position();
      if (focused) { var q = list.querySelector("input"); q.focus(); q.setSelectionRange(pos, pos); }
    }
    function position() {
      if (!active || !field) return;
      var list = picker.querySelector(".spl"), b = picker.querySelector('[data-field="' + field + '"]').getBoundingClientRect(), p = picker.getBoundingClientRect();
      var phone = window.innerWidth <= 760, width = phone ? p.width - 20 : Math.min(Math.max(340, b.width), p.width - 20);
      list.style.width = width + "px";
      list.style.left = (phone ? 10 : Math.min(b.left - p.left, p.width - width - 10)) + "px";
      list.style.bottom = (p.bottom - b.top + 8) + "px";
      // The room above the field inside what is visible (a phone keyboard shrinks it), capped at 360px, or 60% on a phone.
      var view = window.visualViewport, height = view ? view.height : window.innerHeight, top = view ? view.offsetTop : 0;
      list.style.maxHeight = Math.max(80, Math.min(b.top - top - 20, phone ? height * 0.6 : 360)) + "px";
    }
    function openField(key) {
      taskActive = false;
      field = field === key ? null : key; query = ""; hi = 0;
      if (field) { var entries = rows(), index = entries.findIndex(function (r) { return r.cur && !r.disabled; }); hi = Math.max(0, index); }
      render();
      if (field && (field === "name" || field === "dir" || field === "lane")) picker.querySelector(".sq").focus();
    }
    function closeList() { var key = field; field = null; render(); if (key) picker.querySelector('[data-field="' + key + '"]').focus(); }
    function choose(index) {
      var r = rows()[index]; if (!r || r.disabled) return;
      var key = field;
      if (key === "cli") { draft.cli = r.value || (available("claude") ? "claude" : "codex"); draft.cliPicked = !!r.value; draft.model = draft.effort = ""; }
      else { draft[key] = key === "dir" && !r.value && takeover() ? lastDir() || "" : r.value; if (key === "name") { draft.dir = takeover() ? lastDir() || "" : ""; if (takeover()) draft.perm = ""; } }
      closeList();
    }
    function taskError() {
      var text = draft.task.trim();
      if (/^(model|effort|handoff|perm|lane)=/.test(text)) return S.spTaskLeadsWithArg;
      if (!draft.dir && /^(?:[/~～]|cwd=)/.test(text)) return S.spTaskLeadsWithPath;
      return "";
    }
    function canStart() { return !taskError() && !!draft.task.trim() && !(takeover() && !draft.dir && !lastDir()); }
    function commandText() {
      var words = ["@" + seat, "/spawn", draft.cli];
      var first = draft.task.trim().split(/\s+/)[0];
      if (draft.name) words.push(draft.name);
      else if (/^[A-Za-z0-9_.-]{1,62}$/.test(first)) words.push(autoName());
      if (draft.dir) words.push(/[\s"，。、；：！？]/.test(draft.dir) ? 'cwd="' + draft.dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : draft.dir);
      ["model", "effort"].forEach(function (key) { if (draft[key] && draft[key] !== options().default[key]) words.push(key + "=" + draft[key]); });
      if (hasPerms() && draft.perm) words.push("perm=" + draft.perm);
      if (draft.lane) words.push("lane=" + draft.lane);
      words.push(draft.task.trim()); return words.join(" ");
    }
    function start() { if (canStart()) ctx.send(commandText()); }
    function open(name) {
      seat = name; active = true; field = null; taskActive = true;
      draft = drafts[seat] || (drafts[seat] = { cli: available("claude") ? "claude" : "codex", name: "", lane: "", dir: "", model: "", effort: "", perm: "", task: "" });
      document.body.classList.add("sp-taskmode"); picker.classList.add("sp-card"); picker.classList.remove("hidden", "cmdl"); picker.dataset.mode = "spawn";
      render(); load();
      if (!ctx.isCoarse()) picker.querySelector("textarea").focus();
    }
    function close() { active = false; field = null; document.body.classList.remove("sp-taskmode"); picker.classList.remove("sp-card"); }
    picker.addEventListener("focusin", function (e) {
      if (active && e.target.id === "sp-task") { taskActive = true; e.target.parentElement.classList.add("on"); }
    });
    picker.addEventListener("focusout", function (e) {
      if (active && e.target.id === "sp-task") { taskActive = false; e.target.parentElement.classList.remove("on"); }
    });
    picker.addEventListener("input", function (e) {
      if (!active) return;
      if (e.target.id === "sp-task") { draft.task = e.target.value; picker.querySelector("[data-start]").disabled = !canStart(); var hint = picker.querySelector(".spc-error"); hint.textContent = taskError(); hint.hidden = !taskError(); }
      else if (e.target.classList.contains("sq")) { query = e.target.value; hi = (field === "name" || field === "lane") && query ? Math.max(0, rows().findIndex(function (r) { return r.value === query; })) : 0; renderList(); }
    });
    picker.addEventListener("click", function (e) {
      if (!active) return;
      var b = e.target.closest("[data-field], [data-option], [data-start], [data-collapse]");
      if (!b) return;
      if (b.hasAttribute("data-field")) openField(b.dataset.field);
      else if (b.hasAttribute("data-option")) choose(Number(b.dataset.option));
      else if (b.hasAttribute("data-start")) start();
      else ctx.collapse();
    });
    picker.addEventListener("keydown", function (e) {
      if (!active || e.isComposing) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (field) closeList(); else ctx.collapse(); return; }
      if (field && /^(ArrowDown|ArrowUp|Enter)$/.test(e.key)) {
        e.preventDefault();
        var entries = rows();
        if (e.key === "Enter") choose(hi);
        else { var step = e.key === "ArrowDown" ? 1 : -1; do { hi = (hi + step + entries.length) % entries.length; } while (entries[hi].disabled); renderList(); picker.querySelector('[data-option="' + hi + '"]').scrollIntoView({ block: "nearest" }); }
      } else if (e.target.dataset.field && /^(Enter| |ArrowDown)$/.test(e.key)) { e.preventDefault(); openField(e.target.dataset.field); }
      else if (field && e.key === "Tab") closeList();
    });
    document.addEventListener("pointerdown", function (e) { if (active && !picker.contains(e.target) && e.target !== ctx.input) ctx.collapse(); });
    window.addEventListener("resize", position);
    if (window.visualViewport) { window.visualViewport.addEventListener("resize", position); window.visualViewport.addEventListener("scroll", position); }
    return { open: open, close: close, isOpen: function () { return active; }, commandText: commandText, permissionNote: function (id) { return load().then(function () { return permNote(id); }); } };
  };
})();
