// The topic page's members: names, presence, role cards, the member popup and its engine, the members panel with its
// folds, and removing a computer.
(function () {
  "use strict";

  window.createRoomMembers = function (ctx) {
    var $ = ctx.$, S = ctx.S, ago = ctx.ago, ask = ctx.ask, boot = ctx.boot, canWrite = ctx.canWrite, clock = ctx.clock, closeItem = ctx.closeItem, fill = ctx.fill, flash = ctx.flash, isOwner = ctx.isOwner, names = ctx.names, openPanel = ctx.openPanel, panels = ctx.panels,
      plainLines = ctx.plainLines, post = ctx.post, refreshPanel = ctx.refreshPanel, renderSide = ctx.renderSide, showTopic = ctx.showTopic, state = ctx.state, toast = ctx.toast, topicHtml = ctx.topicHtml;
    // The tasks' undo window: one object, made once by room-tasks.js.
    var pendingDone = ctx.pendingDone;
    // The members' one setter (room-store.js): only the members write state.members.
    var writeMembers = ctx.writeMembers;

    var memberQuery = "";
    function memberFilterHtml() {
      return '<label class="member-filter searchfield' + (memberQuery ? " has" : "") + '"><span aria-hidden="true">⌕</span><input type="search" data-member-filter value="' + escapeHtml(memberQuery) + '" placeholder="' + escapeHtml(S.filterMembers) + '" aria-label="' + escapeHtml(S.filterMembers) + '"><button type="button" class="sf-clear" data-member-clear aria-label="' + escapeHtml(S.searchClear) + '"><i><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg></i></button></label>';
    }
    function filterInput(event) {
      if (!event.target.hasAttribute('data-member-filter')) return;
      memberQuery = event.target.value;
      event.target.closest(".member-filter").classList.toggle("has", !!memberQuery);
      var root = event.target.closest('.sbody') || event.target.parentNode.parentNode;
      var list = root.querySelector('[data-filtered-members]');
      if (list) list.innerHTML = memberQuery.trim() ? filteredMembersHtml() : membersHtml();
    }
    function filterClick(event) {
      var clear = event.target.closest('[data-member-clear]');
      if (!clear) return false;
      event.preventDefault();
      var input = clear.closest('.member-filter').querySelector('input');
      input.value = "";
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    }
    function filteredMembersHtml() {
      var q = memberQuery.trim().toLocaleLowerCase();
      return '<ul class="seats">' + state.members.filter(function (m) {
        return shown(m) && [m.name, m.displayName, m.roleCard].some(function (v) { return String(v || '').toLocaleLowerCase().includes(q); });
      }).map(memberRow).join('') + '</ul>';
    }
    function membersPanelHtml() {
      return memberFilterHtml() + '<div data-filtered-members>' + (memberQuery.trim() ? filteredMembersHtml() : membersHtml()) + '</div>';
    }

    function ownerOf(name) {
      var m = state.members.find(function (x) { return x.name === name; });
      if (m) return m.owner;
      var i = name.lastIndexOf("@");
      return i > 0 ? name.slice(i + 1) : name;
    }
    function shownName(name, displayName) {
      var member = state.members.find(function (x) { return x.name === name; });
      var nick = displayName || (member && member.displayName) || (name === state.me && boot.meDisplayName);
      if (!nick || nick === name || name.indexOf("@") >= 0) return escapeHtml(name);
      return escapeHtml(nick) + '<small class="acct">（' + escapeHtml(name) + '）</small>';
    }
    function nameText(name) {
      var member = state.members.find(function (x) { return x.name === name; });
      var nick = member && member.displayName;
      return nick && nick !== name && name.indexOf('@') < 0 ? nick + '（' + name + '）' : name;
    }

    function myAgents() {
      return state.members.filter(function (m) { return m.kind === "agent" && m.owner === state.me && m.status === "active"; });
    }

    function isWorkingAgent(m) {
      return m.kind === 'agent' && m.status === 'active' && m.online && m.work === 'working' && !m.hostOfflineSince;
    }

    /** Only the account's own computers can take its commands. */
    function shown(m) {
      return m.kind !== "host" || m.owner === state.me;
    }

    /**
     * One word, only what the server really knows: a connected agent's work as its
     * daemon reports it, a person with the page open is online, and anyone else was last active some time ago.
     */
    function presence(m) {
      if (!m.online || (m.kind === "agent" && m.hostOfflineSince)) {
        if (m.kind === "agent" && m.hostOfflineSince) return fill(S.hostOffAgo, { t: ago(m.hostOfflineSince) });
        return m.lastActive ? fill(S.activeAgo, { t: ago(m.lastActive) }) : S.offline;
      }
      if (m.kind !== "agent") return S.online;
      if (m.work === "idle" && waitsOnMe(m)) return S.st_you;
      return isWorkingAgent(m) ? S.st_working : m.work === "blocked" ? S.st_blocked : S.st_idle;
    }

    /** An idle agent that opened an item on me that I have not done: it is waiting for me (the robot knocks on the glass). */
    function waitsOnMe(m) {
      return state.todo.items.some(function (i) { return i.createdBy === m.name && i.assignee === state.me && i.status !== "done" && !pendingDone[i.id]; });
    }
    function robot(m, size) {
      return botSvg(m.name, botState(m, waitsOnMe(m)), size);
    }

    function memberRow(m) {
      if (m.status === undefined) {
        var label = m.kind === 'host' ? m.name.split('@')[0].replace(/-daemon$/, '') : (m.displayName || m.name);
        var icon = m.kind === 'agent' ? robot(m) : m.kind === 'host' ? daemonSvg('', 's15') : '<span class="pav">' + escapeHtml(label.slice(0, 1).toLowerCase()) + '</span>';
        return '<li class="seat"><div class="w"><div class="l1">' + icon + '<b>' + (m.kind === 'host' ? escapeHtml(label) : shownName(m.name, m.displayName)) + '</b>' + (m.kind === 'human' ? '' : '<small>' + escapeHtml(m.kind === 'host' ? S.genericComputer : 'agent') + '</small>') + '</div></div></li>';
      }
      var st = m.status === 'left' ? S.memberLeft : presence(m), agent = m.kind === 'agent', stuck = agent && m.online && !m.hostOfflineSince && m.work === 'blocked';
      var icon = agent ? robot(m) : '<span class="pav' + (m.name === state.me ? ' me' : '') + '">' +
        escapeHtml((m.displayName || m.name).slice(0, 1).toLowerCase()) + '</span>';
      var label = m.kind === 'host' && m.device ? escapeHtml(computerLabel(m)) : shownName(m.name, m.displayName);
      return '<li class="seat' + (agent ? ' hascard' : '') + (!m.online || m.status === 'left' ? ' dim' : '') + '" data-name="' + escapeHtml(m.name) + '">' + icon +
        '<div class="w"><div class="l1"><b>' + label + '</b>' +
        (m.name === state.me ? '<small>' + escapeHtml(S.you) + '</small>' : '') +
        '<span class="st' + (stuck ? ' wait' : m.online && m.status === 'active' ? ' live' : '') + '">' + escapeHtml(st) + '</span></div>' +
        (agent ? cardPreview(m) : '') + '</div>' + (agent ? '<span class="rcgo" aria-hidden="true"></span>' : '') + '</li>';
    }

    // ---------- role cards and the description: two lines in the list, the whole of it in a popup ----------
    // The popup is the task detail sheet (#item-panel). An agent's own person edits its card there (saved by
    // POST /r/<id>/roleCard, at most 1000 characters); the topic's creator edits the description (at most 2000).

    var SPAWN_CARD = /^([^\s:]+): started by (\S+) with \/spawn; takes work from \S+$/;
    var CARD_MAX = 1000, TOPIC_MAX = 2000;
    /** A member's card as a reader should see it: '' when there is none, or only the /spawn sentence (then who brought it in). */
    function roleCardOf(m) {
      var role = m.name.split('@')[0], card = String(m.roleCard || '').trim(), spawned = SPAWN_CARD.exec(card);
      if (!card || (spawned && spawned[1] === role)) return { text: '', by: spawned ? spawned[2] : '' };
      // The name is right above it: a leading 「role：」 the agent wrote out of habit goes.
      if (card.indexOf(role) === 0 && /^\s*[：:]/.test(card.slice(role.length))) card = card.slice(role.length).replace(/^\s*[：:]\s*/, '');
      return { text: card, by: '' };
    }

    function cardPreview(m) {
      var c = roleCardOf(m);
      if (!c.text) return '<div class="rcprev none">' + escapeHtml(S.rcNone) + (c.by ? '<span class="rcby"> · ' + escapeHtml(fill(S.rcBy, { name: c.by })) + '</span>' : '') + '</div>';
      return '<div class="rcprev">' + escapeHtml(plainLines(c.text)) + '</div>';
    }

    /** Characters as the server counts them (code points, after \r\n becomes \n and the ends are trimmed). */
    function charCount(s) {
      return Array.from(String(s).replace(/\r\n?/g, '\n').trim()).length;
    }
    /** Under an edit box: 「183 / 1000」, red with how much is over once it is too long; Save waits until it fits. */
    function countText(n, max) {
      return n + ' / ' + max + (n > max ? ' · ' + fill(S.overBy, { n: n - max }) : '');
    }
    function showCount(ta, out, save, max) {
      var n = charCount(ta.value);
      out.textContent = countText(n, max);
      out.classList.toggle('over', n > max);
      if (save) save.disabled = n > max;
    }
    function growBox(ta, most) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, most) + 'px';
    }
    var popEdit = null;   // 'card:<name>' or 'topic' while the popup's edit box is open
    function popup(html, key) {
      $("item-panel").innerHTML = '<div class="grab"></div><header class="sh"><span class="sp"></span><button type="button" class="x" data-close-item aria-label="' + escapeHtml(S.itemClose) + '">×</button></header>' +
        '<div class="sbody mpop">' + html + '</div>';
      $("item-panel").dataset.itemId = key;
      $("item-scrim").classList.remove('hidden');
      $("item-panel").classList.remove('hidden');
    }
    function editBox(value, max, hint, save) {
      return '<div class="topicedit"><textarea id="pop-edit" rows="6" placeholder="' + escapeHtml(hint) + '">' + escapeHtml(value) + '</textarea>' +
        '<div class="topicfoot"><small class="count" id="pop-n"></small><span class="sp"></span>' +
        '<button type="button" class="btn" data-pop-cancel>' + escapeHtml(S.cancel) + '</button><button type="button" class="btn primary" id="pop-save" ' + save + '>' + escapeHtml(S.save) + '</button></div></div>';
    }
    function sizePop() {
      var ta = $("pop-edit");
      if (!ta) return;
      growBox(ta, 360);
      showCount(ta, $("pop-n"), $("pop-save"), popEdit === 'topic' ? TOPIC_MAX : CARD_MAX);
    }
    /** One member's popup: big robot, status, computer, the whole card; 「@ it」, and for its own person 「edit」. */
    function showMember(name, editing) {
      var m = state.members.find(function (x) { return x.name === name; });
      if (!m) return closeItem();
      var c = roleCardOf(m), mine = m.kind === 'agent' && m.owner === state.me && m.status === 'active' && canWrite();
      var host = state.members.find(function (h) { return h.name === m.host; });
      popEdit = editing === true && mine ? 'card:' + name : null;
      var stCls = m.online && !m.hostOfflineSince ? (m.work === 'blocked' ? ' wait' : ' live') : '';
      var head = '<div class="mhead">' + robot(m, 'big') + '<div class="mw"><h3>' + shownName(m.name, m.displayName) + '</h3>' +
        '<div class="msub"><span class="st' + stCls + '">' + escapeHtml(presence(m)) + '</span>' + (host ? '<span>' + escapeHtml(computerOf(host)) + '</span>' : '') + '</div></div></div>';
      var laneEditing = editing === 'lane' && laneMine(m);
      if (laneEditing) popEdit = 'lane:' + name;
      var body = popEdit && !laneEditing
        ? '<div class="mlbl">' + escapeHtml(S.rcLabel) + '</div>' + editBox(c.text, CARD_MAX, S.rcHint, 'data-card-save="' + escapeHtml(name) + '"') +
          '<p class="muted small rcnote">' + escapeHtml(fill(S.rcTold, { name: name })) + '</p>'
        : '<div class="mlbl">' + escapeHtml(S.rcLabel) + '</div>' + (c.text ? '<div class="mcard md">' + renderMarkdown(c.text, names()) + '</div>'
          : '<p class="mcard none">' + escapeHtml(S.rcNone) + (c.by ? ' · ' + escapeHtml(fill(S.rcBy, { name: c.by })) : '') + '</p>') +
          laneRow(m, laneEditing) + handoffRow(m) + '<div class="acts">' + (canWrite() && m.status === 'active' ? '<button type="button" class="btn wide primary" data-at="' + escapeHtml(name) + '">' + escapeHtml(fill(S.rcAt, { name: name.split('@')[0] })) + '</button>' : '') +
          (mine ? '<button type="button" class="btn wide" data-card-edit="' + escapeHtml(name) + '">' + escapeHtml(c.text ? S.rcEditCard : S.rcWrite) + '</button>' : '') + '</div>';
      popup(head + body, 'member:' + name);
      if (popEdit && !laneEditing) { sizePop(); $("pop-edit").focus(); }
      if (laneEditing) $("pop-lane").focus();
    }
    /** The agent's person may set its lane, a left agent's too (it stays on the overview for 7 days). */
    function laneMine(m) {
      return m.kind === 'agent' && m.owner === state.me && canWrite();
    }
    /**
     * An agent's lane (docs/api/topics.md "The lane") under its role card: the word or 「没有方向」, and for its own
     * person 「改方向」, which turns the row into a one-line box saved by POST /r/<id>/lane (lane='' clears it).
     */
    function laneRow(m, editing) {
      if (m.kind !== 'agent') return '';
      if (editing) {
        return '<div class="mlbl">' + escapeHtml(S.laneLabel) + '</div><div class="topicedit laneedit"><input type="text" id="pop-lane" maxlength="32" value="' + escapeHtml(m.lane || '') + '" placeholder="' + escapeHtml(S.laneHint) + '">' +
          '<div class="topicfoot"><span class="sp"></span><button type="button" class="btn" data-pop-cancel>' + escapeHtml(S.cancel) + '</button><button type="button" class="btn primary" data-lane-save="' + escapeHtml(m.name) + '">' + escapeHtml(S.save) + '</button></div></div>';
      }
      return '<div class="mlbl">' + escapeHtml(S.laneLabel) + '</div><div class="mlane"><span class="' + (m.lane ? 'mcard' : 'mcard none') + '">' + escapeHtml(m.lane || S.laneNone) + '</span>' +
        (laneMine(m) ? '<button type="button" class="btn sm" data-lane-edit="' + escapeHtml(m.name) + '">' + escapeHtml(S.laneEdit) + '</button>' : '') + '</div>';
    }
    function saveLane(btn) {
      var name = btn.dataset.laneSave, value = $("pop-lane").value.trim();
      if (value && !/^[^\s|'"]{1,32}$/u.test(value)) return flash(S.laneBad);
      btn.disabled = true;
      post("lane", { name: name, lane: value }).then(function (r) {
        var m = state.members.find(function (x) { return x.name === name; });
        if (m) { m.lane = r.lane; m.laneBy = r.laneBy; m.laneAt = r.laneAt; }
        popEdit = null;
        showMember(name, false);
        toast(S.laneSaved);
      }, function (err) { btn.disabled = false; flash(err.next || String(err)); });
    }
    /** 「10-16 14:20」 / 「Oct 16, 14:20」: when a handoff was stored, in this browser's time (as its page says it). */
    function handoffWhen(ms) {
      var d = new Date(ms), two = function (n) { return String(n).padStart(2, '0'); };
      return (boot.lang === 'zh' ? two(d.getMonth() + 1) + '-' + two(d.getDate()) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ',') + ' ' + clock(ms);
    }
    /**
     * An agent seat's handoff in the cloud (docs/api/files.md): one line under its card, when and on which
     * computer, to the handoff's page. Left seats too; nothing when it has none.
     */
    function handoffRow(m) {
      if (m.kind !== 'agent' || !m.handoff) return '';
      var v = handoffWhen(m.handoff.updatedAt) + (m.handoff.computer ? ' · ' + m.handoff.computer : '');
      return '<a class="mho" href="/r/' + encodeURIComponent(boot.roomId) + '/handoff?name=' + encodeURIComponent(m.name) + '"><span class="th">' + escapeHtml(S.handoffLabel) +
        '</span><span class="v">' + escapeHtml(v) + '</span><span class="rcgo" aria-hidden="true"></span></a>';
    }

    /** A member or the description changed while its popup is open (and not being edited): show the new one. */
    function refreshPopup() {
      var key = $("item-panel").dataset.itemId || '';
      if ($("item-panel").classList.contains('hidden') || popEdit) return;
      if (key.indexOf('member:') === 0) showMember(key.slice(7), false);
      else if (key === 'topic') showTopic(false);
    }
    function saveCard(btn) {
      var name = btn.dataset.cardSave, text = $("pop-edit").value;
      if (charCount(text) > CARD_MAX) return;
      btn.disabled = true;
      post("roleCard", { name: name, roleCard: text }).then(function (r) {
        var m = state.members.find(function (x) { return x.name === name; });
        if (m) { m.roleCard = r.roleCard; m.roleCardBy = r.roleCardBy; m.roleCardAt = r.roleCardAt; }
        popEdit = null;
        showMember(name, false);
        refreshPanel();
        renderSide();
        toast(S.rcSaved);
      }, function (err) { btn.disabled = false; flash(err.next || String(err)); });
    }

    var MEMBER_FOLD_KEY = 'scorpio.memberFold.' + boot.roomId;
    var memberFold = {};
    try { memberFold = JSON.parse(localStorage.getItem(MEMBER_FOLD_KEY) || '{}') || {}; } catch (e) {}
    function memberIsFolded(name) {
      return Object.prototype.hasOwnProperty.call(memberFold, name) ? !!memberFold[name] : name !== state.me;
    }
    function toggleMemberFold(name) {
      memberFold[name] = !memberIsFolded(name);
      try { localStorage.setItem(MEMBER_FOLD_KEY, JSON.stringify(memberFold)); } catch (e) {}
      if (panels.kind() === 'members') openPanel('members');
      if (panels.sideView() === 'members') renderSide();
    }

    function computerOf(seat) {
      if (seat.device) return seat.device.name;
      var x = /This computer: ([^\s.;]+)/.exec(seat.roleCard || "");
      return x ? x[1] : seat.name.split("@")[0];
    }

    function computerLabel(seat) {
      var d = seat.device;
      return d ? d.name + (d.hostname ? ' (' + d.hostname + ')' : '') + (d.note ? ' · ' + d.note : '') : computerOf(seat);
    }

    function removeComputer(name) {
      var seat = state.members.find(function (m) { return m.name === name && m.kind === 'host' && m.owner === state.me && m.status === 'active'; });
      if (!seat) return;
      return ask(fill(S.confirmRemoveComputer, { name: computerOf(seat) }), {
        ok: S.removeOk, danger: true, code: 'scorpio daemon rejoin=' + boot.roomId
      }).then(function (ok) {
        if (!ok) return;
        return post('removeComputer', { name: name }).then(function (r) {
          // the computer goes; its agents stay as left, their handoffs with them, until the members frame
          writeMembers(state.members.filter(function (m) { return r.removed.indexOf(m.name) < 0; }));
          state.members.forEach(function (m) { if ((r.left || []).indexOf(m.name) >= 0) { m.status = 'left'; m.host = null; m.online = false; } });
          refreshPanel();
          if (panels.sideView() === 'members') renderSide();
          toast(S.removedComputer);
        }).catch(function (err) { flash(err.next || String(err)); });
      });
    }


    /** The one entry to the topic's overview (/r/<id>/view): right of the counts, for members and viewers alike. */
    function overviewLink() {
      return '<a class="btn sm gvlink" href="/r/' + encodeURIComponent(boot.roomId) + '/view">' + escapeHtml(S.gvLink) + '</a>';
    }

    /** Everyone who came in and has not left, online or not, each with one word of where they are. */
    function membersHtml() {
      if (state.members.length && state.members[0].status === undefined) {
        var groups = new Map(), humans = state.members.filter(function (m) { return m.kind === 'human'; });
        state.members.forEach(function (m) {
          var at = m.name.lastIndexOf('@'), account = m.kind === 'human' || at < 0 ? m.name : m.name.slice(at + 1);
          if (!groups.has(account)) groups.set(account, []);
          groups.get(account).push(m);
        });
        var body = Array.from(groups.keys()).sort(function (a, b) { return a === state.me ? -1 : b === state.me ? 1 : a.localeCompare(b); }).map(function (account) {
          var order = { human: 0, agent: 1, host: 2 };
          var rows = groups.get(account).sort(function (a, b) { return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name); });
          return '<section class="own"><ul class="seats">' + rows.map(memberRow).join('') + '</ul></section>';
        }).join('');
        var peopleAndAgents = state.members.filter(function (m) { return m.kind !== 'host'; }).length;
        return topicHtml() + '<div class="seathead"><span class="nums">' + S.membersIntro + peopleAndAgents + ' · ' + humans.length + S.membersPeople + '</span><span class="seatacts">' + overviewLink() + '</span></div>' + body;
      }
      var active = state.members.filter(function (m) { return m.status === 'active'; });
      var humans = active.filter(function (m) { return m.kind === 'human'; });
      var agents = active.filter(function (m) { return m.kind === 'agent'; });
      var hosts = active.filter(function (m) { return m.kind === 'host'; });
      var left = state.members.filter(function (m) { return m.status === 'left' && m.kind === 'agent' && m.handoff; });
      humans.sort(function (a, b) { return a.name === state.me ? -1 : b.name === state.me ? 1 : (b.lastActive || 0) - (a.lastActive || 0) || a.name.localeCompare(b.name); });
      var body = humans.map(function (person) {
        var owned = agents.filter(function (m) { return m.owner === person.name; });
        // Only the agents' states: 等你 means the viewer's undelivered tasks, and the pill and the task panel show it.
        // Offline is what presence() calls offline, its computer's or its own, so the summary agrees with the rows.
        var counts = { working: 0, blocked: 0, offline: 0, idle: 0 };
        owned.forEach(function (m) {
          if (!m.online || m.hostOfflineSince) counts.offline++;
          else if (m.online && m.work === 'blocked') counts.blocked++;
          else if (m.online && m.work === 'working') counts.working++;
          else counts.idle++;
        });
        var folded = memberIsFolded(person.name);
        var groups = new Map();
        hosts.filter(function (h) { return h.owner === person.name; }).forEach(function (h) {
          groups.set(h.name, { name: computerLabel(h), host: h, agents: [] });
        });
        owned.forEach(function (m) {
          var host = hosts.find(function (h) { return h.name === m.host; });
          var computer = host ? computerLabel(host) : S.genericComputer;
          var key = host ? host.name : computer;
          if (!groups.has(key)) groups.set(key, { name: computer, host: host, agents: [] });
          groups.get(key).agents.push(m);
        });
        var summary = owned.length ? fill(owned.length === 1 ? S.agentCountOne : S.agentCount, { n: owned.length }) : S.noAgentCount;
        [['working', S.memberWork.working, S.memberWork.working, 'live-ink'], ['blocked', S.memberWork.blocked, S.memberWork.blocked, 'wait-ink'],
          ['offline', S.memberWork.offline, S.memberWork.offline, 'wait-ink'], ['idle', S.memberWork.idle, S.memberWork.idle, '']].forEach(function (part) {
          if (counts[part[0]]) summary += ' · <b' + (part[3] ? ' class="' + part[3] + '"' : '') + '>' + counts[part[0]] + ' ' + (boot.lang === 'zh' ? part[1] : part[2]) + '</b>';
        });
        var badges = (person.name === state.me ? '<small>' + escapeHtml(S.you) + '</small>' : '') +
          (person.name === state.room.owner ? (person.name === state.me ? '<small class="sep">·</small>' : '') + '<small>' + escapeHtml(S.roomOwner) + '</small>' : '');
        var groupsHtml = folded ? '' : Array.from(groups.values()).map(function (group) {
          return '<div class="grp sub computer">' + daemonSvg(group.host && group.host.online ? '' : 'offline', 's15') + '<span>' + escapeHtml(group.name) +
            (group.host && !group.host.device ? S.hostOpen + escapeHtml(group.host.name) + S.hostClose : '') + '</span>' +
            (group.host && group.host.owner === state.me ? '<span class="sp"></span><button type="button" class="x" data-remove-computer="' + escapeHtml(group.host.name) + '" aria-label="' + escapeHtml(fill(S.removeComputerLabel, { name: group.name })) + '">×</button>' : '') + '</div>' +
            (group.agents.length ? '<ul class="seats sub">' + group.agents.sort(function (a, b) { return a.name.localeCompare(b.name); }).map(memberRow).join('') + '</ul>' : '');
        }).join('');
        var leftOwned = left.filter(function (m) { return m.owner === person.name; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var leftFolded = memberIsFolded('left:' + person.name);
        var leftHtml = folded || !leftOwned.length ? '' : '<button type="button" class="grp sub left-fold' + (leftFolded ? '' : ' open') + '" data-fold-member="left:' + escapeHtml(person.name) + '" aria-expanded="' + !leftFolded + '">' +
          '<span>' + escapeHtml(fill(S.leftMembers, { n: leftOwned.length })) + '</span><span class="fold-ic" aria-hidden="true"></span></button>' +
          (leftFolded ? '' : '<ul class="seats sub">' + leftOwned.map(memberRow).join('') + '</ul>');
        return '<section class="own' + (folded ? ' folded' : '') + '"><button type="button" class="oh" data-fold-member="' + escapeHtml(person.name) + '" aria-expanded="' + !folded + '">' +
          '<span class="pav' + (person.name === state.me ? ' me' : '') + '">' + escapeHtml((person.displayName || person.name).slice(0, 1).toLowerCase()) + '</span>' +
          '<span class="w"><span class="l1"><b>' + shownName(person.name, person.displayName) + '</b>' + badges +
          (badges ? '<small class="sep">·</small>' : '') +
          '<span class="st' + (person.online ? ' live' : '') + '">' + escapeHtml(presence(person)) + '</span></span><span class="l2">' + summary + '</span></span><span class="fold-ic" aria-hidden="true"></span></button>' + groupsHtml + leftHtml + '</section>';
      }).join('');
      return topicHtml() + '<div class="seathead"><span class="nums">' + S.membersIntro + (humans.length + agents.length) + ' · ' + humans.length + S.membersPeople + '</span><span class="seatacts">' + overviewLink() +
        '<button type="button" class="btn sm primary" data-invite>' + S.inviteShort + '</button>' +
        (isOwner() ? '<button type="button" class="btn sm" data-settings>' + S.settings + '</button>' : '') + '</span></div>' + body +
        (agents.length ? '' : '<p class="noagents">' + botSvg('', 'idle', 'big') + '<span>' + escapeHtml(S.noAgents) + '</span></p>');
    }

    panels.tab('members', {
      html: membersPanelHtml, side: true,
      before: function (root) {
        var input = root.querySelector('[data-member-filter]');
        return input && document.activeElement === input ? { start: input.selectionStart, end: input.selectionEnd } : null;
      },
      after: function (root, focus) {
        var input = root.querySelector('[data-member-filter]');
        if (input && focus) { input.focus(); input.setSelectionRange(focus.start, focus.end); }
      },
      label: function () {
        var count = state.members.filter(function (m) { return m.status !== 'left' && m.kind !== 'host' && shown(m); }).length;
        return escapeHtml(S.membersTab) + '<span class="n">' + count + '</span>';
      },
      panelBefore: function (root) {
        var before = {};
        root.querySelectorAll("ul.seats li[data-name] > .bot").forEach(function (b) { before[b.parentNode.dataset.name] = b.getAttribute("class"); });
        return before;
      },
      panelAfter: function (root, before) {
        root.querySelectorAll("ul.seats li[data-name] > .bot").forEach(function (b) {
          var was = before && before[b.parentNode.dataset.name];
          if (was && was !== b.getAttribute("class")) botFresh(b);
        });
      },
    });

    return {
      membersHtml: membersHtml, filterClick: filterClick, filterInput: filterInput,
      ownerOf: ownerOf, shownName: shownName, nameText: nameText, myAgents: myAgents, isWorkingAgent: isWorkingAgent, shown: shown, presence: presence, robot: robot, computerOf: computerOf, roleCardOf: roleCardOf, saveLane: saveLane,
      showMember: showMember, refreshPopup: refreshPopup, saveCard: saveCard, removeComputer: removeComputer, toggleMemberFold: toggleMemberFold,
      // The popup engine, which the description's popup and the settings sheet in room-settings.js use.
      popup: popup, editBox: editBox, sizePop: sizePop, growBox: growBox, showCount: showCount, charCount: charCount, TOPIC_MAX: TOPIC_MAX,
      /** Which edit box the popup has open: popEdit() reads it, popEdit(v) sets it (the description's popup sets 'topic'). */
      popEdit: function (v) { if (arguments.length) popEdit = v; return popEdit; },
      clearPop: function () { popEdit = null; },
      /** The hello and members frames: the whole list. */
      set: function (members) { writeMembers(members); },
      /** The cursor frame: a member read up to here. */
      cursorMoved: function (name, cursor) { state.members.forEach(function (x) { if (x.name === name) x.cursor = cursor; }); },
    };
  };
})();
