// The room search drawer. Room state and navigation stay in room.js; this file owns query/results only.
(function () {
  "use strict";

  window.createRoomSearch = function (options) {
    var panel = options.panel, S = options.strings;
    var groups = { messages: [], todo: [], files: [], memo: [] }, hasMore = { messages: false, todo: false, files: false, memo: false };
    var query = "", active = false, loading = false, error = "", timer = null, generation = 0, scrollTop = 0;
    var loadingMore = {};
    var KINDS = ["human", "agent", "host", "system,scheduled"];
    var filters = { scope: "", by: "", kinds: KINDS.slice(), at: false, when: "all", since: "", until: "" };
    var listOpen = false, listQuery = "";
    var kinds = ["todo", "files", "memo", "messages"];

    function escapeHtml(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function messageFiltersApply() { return filters.scope === "" || filters.scope === "messages"; }
    function setScope(scope) {
      filters.scope = scope;
      if (scope !== "messages") { filters.kinds = KINDS.slice(); filters.at = false; }
    }
    function filterParams() {
      var params = new URLSearchParams();
      if (filters.scope) params.set("in", filters.scope);
      if (filters.by) params.set("by", filters.by);
      if (messageFiltersApply() && filters.kinds.length && filters.kinds.length !== 4) params.set("kind", filters.kinds.join(","));
      if (messageFiltersApply() && filters.at) params.set("at", "me");
      var range = rangeOf();
      ["since", "until"].forEach(function (key) {
        if (!range[key]) return;
        var parts = range[key].split("-").map(Number);
        params.set(key, String(new Date(parts[0], parts[1] - 1, parts[2] + (key === "until" ? 1 : 0)).getTime()));
      });
      return params;
    }
    function ready() {
      if (filterParams().size) return true;
      var compact = query.trim().replace(/\s/g, "");
      return /\p{Script=Han}/u.test(compact) || Array.from(compact).length >= 2;
    }
    function highlight(value) {
      var text = String(value || ""), low = text.toLocaleLowerCase();
      var terms = query.trim().split(/\s+/).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
      var out = "", pos = 0;
      while (pos < text.length) {
        var at = -1, len = 0;
        terms.forEach(function (term) {
          var i = low.indexOf(term.toLocaleLowerCase(), pos);
          if (i >= 0 && (at < 0 || i < at)) { at = i; len = term.length; }
        });
        if (at < 0) return out + escapeHtml(text.slice(pos));
        out += escapeHtml(text.slice(pos, at)) + "<mark>" + escapeHtml(text.slice(at, at + len)) + "</mark>";
        pos = at + len;
      }
      return out;
    }
    function time(ts) {
      return new Date(ts).toLocaleString(options.lang === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    function size(bytes) {
      return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : bytes >= 1024 ? Math.round(bytes / 1024) + " KB" : bytes + " B";
    }
    function row(kind, hit, index) {
      var heading;
      if (kind === "messages") heading = options.nameOf(hit.who) + " · " + time(hit.ts) + " · " + hit.id;
      else if (kind === "todo") {
        var status = hit.status === "done" ? S.tl_done : hit.assignee === options.me ? S.forYou : hit.status === "doing" ? S.searchStatusDoing : S.searchStatusWaiting;
        heading = hit.id + " · " + status + " · " + hit.title;
      } else if (kind === "memo") heading = hit.status === "long" ? hit.id : hit.status === "slot" ? hit.id : S.memo.retiredLabel.replace("{id}",hit.id);
      else heading = hit.title + " · " + size(hit.size);
      var detail = kind === "files" ? options.nameOf(hit.who) + " · " + S.searchFileIn + hit.id : hit.snippet;
      return '<button type="button" class="search-hit ' + kind + '" data-search-kind="' + kind + '" data-search-index="' + index + '">' +
        '<b>' + highlight(heading) + '</b><span>' + highlight(detail) + '</span></button>';
    }
    function renderResults() {
      if (!active) return;
      var box = panel.querySelector("#room-search-results");
      if (!box) return;
      var top = box.scrollTop || scrollTop;
      if (!query.trim() && !filterParams().size) { box.innerHTML = '<p class="search-note">' + escapeHtml(S.searchStart) + '</p>'; return; }
      if (!ready()) { box.innerHTML = '<p class="search-note">' + escapeHtml(S.searchShort) + '</p>'; return; }
      var html = "";
      if (error) html += '<p class="search-note error">' + escapeHtml(error) + '</p>';
      if (loading) html += '<p class="search-note">' + escapeHtml(S.searchLoading) + '</p>';
      kinds.forEach(function (kind) {
        var list = groups[kind] || [];
        if (!list.length) return;
        var label = kind === "messages" ? S.searchMessages : kind === "todo" ? S.searchTodo : kind === "memo" ? S.memo.tab : S.searchFiles;
        html += '<section class="search-group"><h3>' + escapeHtml(label) + ' ' + list.length + (hasMore[kind] ? "+" : "") + '</h3>' +
          list.map(function (hit, index) { return row(kind, hit, index); }).join("") +
          (hasMore[kind] ? '<button type="button" class="search-more" data-search-more="' + kind + '">' + escapeHtml(loadingMore[kind] ? S.searchLoading : S.searchMore) + '</button>' : '') + '</section>';
      });
      if (!html) html = '<p class="search-note">' + escapeHtml(S.searchEmpty) + '</p>';
      box.innerHTML = html;
      box.scrollTop = top;
      scrollTop = box.scrollTop;
    }
    function reset() {
      groups = { messages: [], todo: [], files: [], memo: [] };
      hasMore = { messages: false, todo: false, files: false, memo: false };
      loadingMore = {};
      error = "";
    }
    function request(kind) {
      if (!ready()) return;
      if (kind && loadingMore[kind]) return;
      var token = generation, params = filterParams();
      params.set("q", query.trim());
      params.set("limit", filters.scope === "memo" || kind === "memo" ? "60" : "20");
      if (kind) {
        var list = groups[kind], last = list[list.length - 1];
        if (!last || kind !== "memo" && !last.seq) { hasMore[kind] = false; return renderResults(); }
        params.set("in", kind);
        // A message can carry up to nine files. Include its seq again at a page boundary,
        // then remove the file IDs already shown so siblings on that message are not lost.
        if (kind !== "memo") params.set("before", String(kind === "files" ? last.seq + 1 : last.seq));
        loadingMore[kind] = true;
      } else loading = true;
      renderResults();
      fetch("/r/" + options.roomId + "/search?" + params, { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.next || S.searchError); return body; }); })
        .then(function (body) {
          if (token !== generation) return;
          if (kind) {
            var seen = new Set(groups[kind].map(function (hit) { return kind === "files" ? hit.fileId : hit.id; }));
            groups[kind] = kind === "memo" ? body.groups.memo || [] : groups[kind].concat((body.groups[kind] || []).filter(function (hit) { return !seen.has(kind === "files" ? hit.fileId : hit.id); }));
            hasMore[kind] = !!body.hasMore[kind];
            loadingMore[kind] = false;
          }
          else { groups = body.groups; hasMore = body.hasMore; loading = false; }
          error = "";
          renderResults();
        }, function (e) {
          if (token !== generation) return;
          loading = false; loadingMore[kind] = false;
          error = e.message || S.searchError;
          renderResults();
        });
    }
    function day(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
    // Presets are worked out when the search is sent, so 「今天」 picked yesterday still means today.
    function rangeOf() {
      if (filters.when === "custom") return { since: filters.since, until: filters.until };
      if (filters.when === "all") return { since: "", until: "" };
      var today = new Date(), back = filters.when === "7" ? 6 : filters.when === "30" ? 29 : 0;
      return { since: day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)), until: day(today) };
    }
    function preset(when) { filters.when = when; }
    function dateFace(value) {
      if (!value) return "";
      var p = value.split("-").map(Number), d = new Date(p[0], p[1] - 1, p[2]), same = p[0] === new Date().getFullYear();
      return d.toLocaleDateString(options.lang === "zh" ? "zh-CN" : "en-US", same ? { month: options.lang === "zh" ? "long" : "short", day: "numeric" } : { year: "numeric", month: options.lang === "zh" ? "long" : "short", day: "numeric" });
    }
    var CHECK = '<svg class="sf-ck" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.5 5"/></svg>';
    var CHEV = '<svg class="sf-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.6 6 7.6 9 4.6"/></svg>';
    var CAL = '<svg class="sf-cal" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>';
    function senderList() {
      var all = options.members ? options.members() : [], q = listQuery.trim().toLocaleLowerCase();
      var groups = [["human", S.searchPeople], ["agent", S.searchAgents], ["host", S.searchComputers]];
      var rows = '<button type="button" role="option" class="sf-opt' + (!filters.by ? " cur" : "") + '" data-sf-by="" aria-selected="' + !filters.by + '"><span class="sf-av sf-any"></span><span class="sf-nm">' + escapeHtml(S.searchSenderAny) + "</span>" + CHECK + "</button>";
      groups.forEach(function (g) {
        var list = all.filter(function (m) { return m.kind === g[0] && (!q || [m.name, m.displayName].some(function (v) { return String(v || "").toLocaleLowerCase().includes(q); })); });
        if (!list.length) return;
        rows += '<p class="sf-gh">' + escapeHtml(g[1]) + "</p>" + list.map(function (m) {
          var on = filters.by === m.name;
          return '<button type="button" role="option" class="sf-opt' + (on ? " cur" : "") + (m.status === "left" ? " left" : "") + '" data-sf-by="' + escapeHtml(m.name) + '" aria-selected="' + on + '">' + (options.avatar ? options.avatar({ from: m.name, fromKind: m.kind, displayName: m.displayName }) : "") + '<span class="sf-nm">' + escapeHtml(options.nameOf(m.name)) + "</span>" + CHECK + "</button>";
        }).join("");
      });
      var find = '<label class="searchfield sf-find"><span aria-hidden="true">⌕</span><input type="search" data-sf-find value="' + escapeHtml(listQuery) + '" placeholder="' + escapeHtml(S.filterMembers) + '" aria-label="' + escapeHtml(S.filterMembers) + '"></label>';
      return '<div class="sf-list" aria-label="' + escapeHtml(S.searchSender) + '">' + find + '<div class="sf-rows" id="search-senders" role="listbox" aria-label="' + escapeHtml(S.searchSender) + '">' + rows + "</div></div>";
    }
    function chip(attr, on, label, multi) {
      return '<button type="button" class="sf-chip' + (multi ? " multi" : "") + '" ' + attr + ' ' + (/role="radio"/.test(attr) ? "" : 'aria-pressed="' + on + '"') + '>' + (multi ? CHECK : "") + escapeHtml(label) + "</button>";
    }
    function controls() {
      var by = filters.by ? options.nameOf(filters.by) : S.searchSenderAny;
      var kinds = KINDS.map(function (k, i) {
        var on = messageFiltersApply() && filters.kinds.indexOf(k) >= 0;
        return chip('data-sf-kind="' + k + '"' + (!messageFiltersApply() ? ' disabled' : '') + (on && filters.kinds.length === 1 ? ' aria-disabled="true"' : ""), on, [S.searchPeople, S.searchAgents, S.searchComputers, S.searchSystem][i], true);
      }).join("");
      var scopes = [["", S.searchInAll], ["messages", S.searchMessages], ["todo", S.searchTodo], ["files", S.searchFiles], ["memo", S.memo.tab]].map(function (scope) {
        var on = filters.scope === scope[0];
        return chip('data-sf-in="' + scope[0] + '" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '"', on, scope[1]);
      }).join("");
      var whens = [["all", S.searchDateAll], ["today", S.searchDateToday], ["7", S.searchDate7], ["30", S.searchDate30], ["custom", S.searchDateCustom]].map(function (w) {
        return chip('data-sf-when="' + w[0] + '" role="radio" aria-checked="' + (filters.when === w[0]) + '" tabindex="' + (filters.when === w[0] ? 0 : -1) + '"', filters.when === w[0], w[1]);
      }).join("");
      var custom = filters.when !== "custom" ? "" : '<div class="sf-row"><span class="sf-lb"></span><div class="sf-range">' + ["since", "until"].map(function (key) {
        var v = filters[key], other = filters[key === "since" ? "until" : "since"];
        return '<label class="sf-date' + (v ? " has" : "") + '">' + CAL + '<span class="sf-dl">' + escapeHtml(key === "since" ? S.searchFrom : S.searchTo) + '</span><span class="sf-dv">' + escapeHtml(dateFace(v)) + '</span>' +
          '<input type="date" data-search-filter="' + key + '" value="' + v + '"' + (other ? (key === "since" ? ' max="' : ' min="') + other + '"' : "") + ' aria-label="' + escapeHtml(key === "since" ? S.searchFrom : S.searchTo) + '"><button type="button" class="sf-dx" data-sf-clear="' + key + '" aria-label="' + escapeHtml(S.searchClear) + '"><i><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg></i></button></label>';
      }).join('<span class="sf-dash" aria-hidden="true">–</span>') + "</div></div>";
      return '<div class="search-filters sf">' +
        '<div class="sf-row"><span class="sf-lb">' + escapeHtml(S.searchIn) + '</span><div class="sf-vals" role="radiogroup" aria-label="' + escapeHtml(S.searchIn) + '">' + scopes + "</div></div>" +
        '<div class="sf-row"><span class="sf-lb" id="search-sender-label">' + escapeHtml(S.searchSender) + '</span><div class="sf-vals sf-by"><button type="button" class="sf-pick' + (filters.by ? " set" : "") + '" data-sf-open="by" aria-controls="search-senders" aria-labelledby="search-sender-label search-sender-value" aria-haspopup="listbox" aria-expanded="' + listOpen + '"><span class="sf-pv" id="search-sender-value">' + escapeHtml(by) + "</span>" + CHEV + "</button>" +
        chip("data-search-at" + (!messageFiltersApply() ? " disabled" : ""), messageFiltersApply() && filters.at, S.searchAt) + (listOpen ? senderList() : "") + "</div></div>" +
        '<div class="sf-row"><span class="sf-lb" id="search-kind-label">' + escapeHtml(S.searchKind) + '</span><div class="sf-vals" role="group" aria-labelledby="search-kind-label">' + kinds + "</div></div>" +
        '<div class="sf-row"><span class="sf-lb">' + escapeHtml(S.searchDate) + '</span><div class="sf-vals" role="radiogroup" aria-label="' + escapeHtml(S.searchDate) + '">' + whens + "</div></div>" +
        custom + "</div>";
    }
    function redrawControls(focusSelector) {
      var box = panel.querySelector(".search-filters");
      if (box) box.outerHTML = controls();
      var target = focusSelector && panel.querySelector(focusSelector);
      if (target) target.focus();
    }
    function refilter(focusSelector, keepControls) {
      if (!keepControls) redrawControls(focusSelector);
      clearTimeout(timer); generation++; reset(); loading = false; scrollTop = 0;
      var box = panel.querySelector("#room-search-results");
      if (box) box.scrollTop = 0;
      renderResults();
      if (ready()) request();
    }
    function closeList(focus) {
      listOpen = false;
      redrawControls(focus ? "[data-sf-open]" : null);
    }
    function change(event) {
      var el = event.target, key = el.dataset.searchFilter;
      if (key !== "since" && key !== "until") return;
      filters[key] = el.value;
      filters.when = "custom";
      // Safari initializes an empty date when its picker opens. Keep that input alive so
      // updating its face does not dismiss the system picker in the same change event.
      panel.querySelectorAll("[data-search-filter]").forEach(function (input) {
        var field = input.dataset.searchFilter, other = filters[field === "since" ? "until" : "since"];
        var face = input.closest(".sf-date");
        face.classList.toggle("has", !!filters[field]);
        face.querySelector(".sf-dv").textContent = dateFace(filters[field]);
        if (other) input.setAttribute(field === "since" ? "max" : "min", other);
        else input.removeAttribute(field === "since" ? "max" : "min");
      });
      refilter(null, true);
    }
    function refresh() {
      if (active && !(document.activeElement && document.activeElement.matches("[data-search-filter]"))) {
        var focused = panel.querySelector("[data-sf-find]"), position = focused && focused.selectionStart;
        var keepFind = focused && document.activeElement === focused;
        redrawControls(keepFind ? "[data-sf-find]" : null);
        var next = panel.querySelector("[data-sf-find]");
        if (keepFind && next && position != null) next.setSelectionRange(position, position);
      }
      renderResults();
    }
    function open(initial) {
      active = true;
      if (initial != null && initial !== query) { query = initial; generation++; reset(); scrollTop = 0; }
      panel.innerHTML = '<div class="grab"></div><div class="searchbar"><label class="searchfield"><span aria-hidden="true">⌕</span><input id="room-search-input" type="search" maxlength="200" autocomplete="off" value="' + escapeHtml(query) + '" placeholder="' + escapeHtml(S.searchHint) + '" aria-label="' + escapeHtml(S.search) + '"></label>' +
        '<button type="button" class="search-cancel" data-search-close>' + escapeHtml(S.searchClose) + '</button></div>' + controls() + '<div id="room-search-results" class="search-results sbody"></div>';
      renderResults();
      panel.querySelector("#room-search-input").focus();
      if (ready() && !groups.messages.length && !groups.todo.length && !groups.files.length && !(groups.memo || []).length) request();
    }
    function closed() {
      var box = panel.querySelector('#room-search-results');
      if (box) scrollTop = box.scrollTop;
      active = false;
      listOpen = false;
      clearTimeout(timer);
      generation++;
      loading = false;
    }
    function input(event) {
      if (event.target.hasAttribute && event.target.hasAttribute("data-sf-find")) {
        listQuery = event.target.value;
        var rows = panel.querySelector(".sf-rows"), tmp = document.createElement("div");
        tmp.innerHTML = senderList();
        rows.replaceWith(tmp.querySelector(".sf-rows"));
        return;
      }
      if (event.target.id !== "room-search-input") return;
      query = event.target.value;
      clearTimeout(timer);
      generation++;
      reset();
      loading = false;
      scrollTop = 0;
      if (!query.trim() && !filterParams().size) {
        renderResults();
        timer = setTimeout(function () { if (!query.trim() && !filterParams().size) options.close(); }, 150);
        return;
      }
      var box = panel.querySelector('#room-search-results');
      if (box) box.scrollTop = 0;
      renderResults();
      if (ready()) timer = setTimeout(function () { request(); }, 180);
    }
    function click(event) {
      if (event.target.closest("[data-search-close]")) return options.close();
      var t = event.target.closest('[data-sf-open]');
      if (t) {
        listOpen = !listOpen; listQuery = "";
        return redrawControls(listOpen && window.innerWidth > 760 ? "[data-sf-find]" : "[data-sf-open]");
      }
      var pick = event.target.closest('[data-sf-by]');
      if (pick) { filters.by = pick.dataset.sfBy; listOpen = false; return refilter("[data-sf-open]"); }
      if (listOpen && !event.target.closest('.sf-list')) closeList(false);
      var scope = event.target.closest('[data-sf-in]');
      if (scope) { setScope(scope.dataset.sfIn); return refilter('[data-sf-in="' + filters.scope + '"]'); }
      var at = event.target.closest('[data-search-at]');
      if (at && !at.disabled) { filters.scope = "messages"; filters.at = !filters.at; return refilter("[data-search-at]"); }
      var k = event.target.closest('[data-sf-kind]');
      if (k && !k.disabled) {
        filters.scope = "messages";
        var i = filters.kinds.indexOf(k.dataset.sfKind);
        if (i >= 0 && filters.kinds.length === 1) return;
        if (i >= 0) filters.kinds.splice(i, 1); else filters.kinds.push(k.dataset.sfKind);
        return refilter('[data-sf-kind="' + k.dataset.sfKind + '"]');
      }
      var w = event.target.closest('[data-sf-when]');
      if (w) { preset(w.dataset.sfWhen); return refilter('[data-sf-when="' + w.dataset.sfWhen + '"]'); }
      var dx = event.target.closest('[data-sf-clear]');
      if (dx) {
        event.preventDefault(); filters[dx.dataset.sfClear] = "";
        return refilter('[data-search-filter="' + dx.dataset.sfClear + '"]');
      }
      var face = event.target.closest('.sf-date');
      if (face) {
        var key = face.querySelector('input').dataset.searchFilter;
        var date = panel.querySelector('[data-search-filter="' + key + '"]');
        if (date.showPicker) date.showPicker();
        return;
      }
      var more = event.target.closest("[data-search-more]");
      if (more) return request(more.dataset.searchMore);
      var button = event.target.closest("[data-search-kind]");
      if (!button) return;
      var kind = button.dataset.searchKind, hit = groups[kind][Number(button.dataset.searchIndex)];
      if (!hit) return;
      if (kind === "todo") return options.openItem(hit.id);
      if (kind === "memo") return options.openMemo(hit.id);
      if (window.innerWidth <= 760) options.close();
      options.jumpTo(hit.seq);
    }
    function keydown(event) {
      if (!active) return;
      if (listOpen && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); closeList(true); return;
      }
      var scope = event.target.closest('[data-sf-in]');
      if (scope && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        var scopes = ["", "messages", "todo", "files", "memo"], scopeIndex = scopes.indexOf(filters.scope);
        setScope(scopes[(scopeIndex + (event.key === "ArrowRight" ? 1 : scopes.length - 1)) % scopes.length]);
        return refilter('[data-sf-in="' + filters.scope + '"]');
      }
      var radio = event.target.closest('[data-sf-when]');
      if (radio && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        var values = ["all", "today", "7", "30", "custom"], index = values.indexOf(filters.when);
        preset(values[(index + (event.key === "ArrowRight" ? 1 : 4)) % values.length]);
        return refilter('[data-sf-when="' + filters.when + '"]');
      }
      if (listOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        var rows = Array.from(panel.querySelectorAll('[data-sf-by]')), index = rows.indexOf(event.target);
        var next = index < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        rows[next].focus();
      } else if (listOpen && event.key === "Enter" && event.target.hasAttribute('data-sf-by')) {
        event.preventDefault(); event.target.click();
      }
    }
    panel.addEventListener("keydown", keydown);
    document.addEventListener("click", function (event) {
      if (active && listOpen && !panel.contains(event.target)) closeList(false);
    }, true);
    return { open: open, closed: closed, input: input, click: click, change: change, refresh: refresh };
  };
})();
