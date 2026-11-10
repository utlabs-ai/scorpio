// The topic page's settings for the topic as a whole: the description and its popup, invite and passcode, public or
// private, archive and restore, the quota note and the read-only bar, the settings sheet, and the room menu with mute,
// joining and leaving, being removed and the topic deleted.
(function () {
  "use strict";

  window.createRoomSettings = function (ctx) {
    var $ = ctx.$, S = ctx.S, boot = ctx.boot, fill = ctx.fill, state = ctx.state, panel = ctx.panel, panels = ctx.panels, feed = ctx.feed, viewer = ctx.viewer, socket = ctx.socket,
      post = ctx.post, ask = ctx.ask, toast = ctx.toast, flash = ctx.flash, copy = ctx.copy, copyText = ctx.copyText, clock = ctx.clock, canWrite = ctx.canWrite, isOwner = ctx.isOwner,
      closeMenu = ctx.closeMenu, exitSelect = ctx.exitSelect, nearBottom = ctx.nearBottom, updateChips = ctx.updateChips,
      refreshPanel = ctx.refreshPanel, openPanel = ctx.openPanel, renderSide = ctx.renderSide, closePanel = ctx.closePanel, loadMentions = ctx.loadMentions,
      shown = ctx.shown, names = ctx.names, shell = ctx.shell, atCount = ctx.atCount;
    // The topic's one setter (room-store.js): only the settings write state.room.
    var writeRoom = ctx.writeRoom;
    // The members' popup engine, for the description's popup and the settings sheet's count: the members are created first.
    var roomMembers = ctx.roomMembers;
    var popup = roomMembers.popup, editBox = roomMembers.editBox, sizePop = roomMembers.sizePop, growBox = roomMembers.growBox, showCount = roomMembers.showCount,
      charCount = roomMembers.charCount, refreshPopup = roomMembers.refreshPopup, TOPIC_MAX = roomMembers.TOPIC_MAX;
    var NAME_MAX = 80;   // as at creation: the server cuts a longer name

    /** The topic with these fields changed: a new object in the store. */
    function changeRoom(fields) { writeRoom(Object.assign({}, state.room, fields)); }

    // ---------- the description: on top of the members and in a popup, on the members' popup engine ----------

    /** Plain text for a two-line preview: list marks and Markdown marks out, lines joined with 「 · 」. */
    function plainLines(t) {
      return t.split('\n').filter(function (l) { return !/^\s*\|?\s*:?-{3,}/.test(l); })
        .map(function (l) { return l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`#>]/g, '').trim(); })
        .filter(Boolean).join(' · ');
    }
    /** The description on top of the members: its label, two lines and ›; nothing when there is none and I cannot write one. */
    function topicHtml() {
      var t = String(state.room.topic || '').trim();
      if (!t && !(isOwner() && canWrite())) return '';
      return '<button type="button" class="rtopic" data-topic><span class="th">' + escapeHtml(S.setTopic) + '</span>' +
        '<span class="rcprev' + (t ? '' : ' none') + '">' + escapeHtml(t ? plainLines(t) : S.topicNone) + '</span><span class="rcgo" aria-hidden="true"></span></button>';
    }
    /**
     * The description's popup: the topic's name and the whole description; its creator edits both here.
     * editing: true opens the description's box, 'name' the name's (one box at a time).
     */
    function showTopic(editing) {
      var t = String(state.room.topic || '').trim(), can = isOwner() && canWrite();
      roomMembers.popEdit(editing && can ? (editing === 'name' ? 'name' : 'topic') : null);
      var naming = roomMembers.popEdit() === 'name', writing = roomMembers.popEdit() === 'topic';
      var head = naming
        ? '<div class="mlbl top">' + escapeHtml(S.topicName) + '</div><div class="topicedit nameedit"><input id="pop-name" type="text" maxlength="' + NAME_MAX + '" value="' + escapeHtml(state.room.name) + '">' +
          '<div class="topicfoot"><small class="count" id="pop-n"></small><span class="sp"></span>' +
          '<button type="button" class="btn" data-pop-cancel>' + escapeHtml(S.cancel) + '</button><button type="button" class="btn primary" id="pop-save" data-name-save>' + escapeHtml(S.save) + '</button></div></div>'
        : '<div class="mlbl top">' + escapeHtml(S.setTopic) + '</div><h3 class="tname">' + escapeHtml(state.room.name) +
          (can && !writing ? ' <button type="button" class="btn sm" data-name-edit>' + escapeHtml(S.rename) + '</button>' : '') + '</h3>';
      var body = writing ? editBox(t, TOPIC_MAX, S.topicHint, 'data-topic-save')
        : (t ? '<div class="mcard md">' + renderMarkdown(t, names(), state.me) + '</div>' : '<p class="mcard none">' + escapeHtml(S.topicNone) + '</p>') +
          (can && !naming ? '<div class="acts"><button type="button" class="btn wide" data-topic-edit>' + escapeHtml(t ? S.rcEdit : S.rcWrite) + '</button></div>' : '');
      popup(head + body, 'topic');
      if (writing) { sizePop(); $("pop-edit").focus(); }
      if (naming) { var inp = $("pop-name"); countName(); inp.focus(); inp.select(); }
    }
    function countName() { showCount($("pop-name"), $("pop-n"), $("pop-save"), NAME_MAX); }
    /**
     * The creator's new name for the topic: the server cleans it as at creation; the room frame brings it to everyone.
     * Shared by the description popup's box and the settings sheet's row: resolves with the server's answer, or null
     * when nothing was sent or it was refused (the reason is shown).
     */
    function renameTopic(name, btn) {
      name = String(name || "").trim();
      if (!name) { flash(S.nameEmpty); return Promise.resolve(null); }
      if (charCount(name) > NAME_MAX) return Promise.resolve(null);
      btn.disabled = true;
      return post("name", { name: name }).then(function (r) {
        changeRoom({ name: r.name });
        applyRoom();
        renderSide();
        toast(S.renamed);
        return r;
      }, function (err) { btn.disabled = false; flash(err.next || String(err)); return null; });
    }
    function saveName(btn) {
      renameTopic($("pop-name").value, btn).then(function (r) {
        if (!r) return;
        roomMembers.clearPop();
        showTopic(false);
      });
    }
    function saveTopic(btn) {
      var text = $("pop-edit").value;
      if (charCount(text) > TOPIC_MAX) return;
      btn.disabled = true;
      post("topic", { topic: text }).then(function (r) {
        changeRoom({ topic: r.topic });
        roomMembers.clearPop();
        applyRoom();
        showTopic(false);
        refreshPanel();
        renderSide();
        toast(S.topicSaved);
      }, function (err) { btn.disabled = false; flash(err.next || String(err)); });
    }

    // ---------- the invite card: first in the feed while no agent is in the topic, gone once one joins ----------

    var membersKnown = false, inviteEl = null;
    function wantsInvite() {
      return membersKnown && canWrite() && !state.members.some(function (m) { return m.kind === "agent" && m.status === "active"; });
    }
    function inviteContent(code, newCode, prefix) {
      var invitation = invitationText(code), host = ctx.mySeats()[0];
      // The shared link has no embedded passcode: a code works once, so a group link cannot consume it.
      var colleague = fill(code ? S.colleagueText : S.colleagueTextNoCode, { name: state.room.name, url: location.origin + "/r/" + state.room.id, code: code || "" });
      var agentId = prefix + "invite-text", colleagueId = prefix + "colleague-text";
      return {
        invitation: invitation, colleague: colleague,
        html: (host ? '<p class="invite-label">' + escapeHtml(S.inviteSpawnLabel) + '</p><p class="sx-spawn-t">' +
          escapeHtml(fill(S.inviteSpawnText, { computer: roomMembers.computerOf(host) })) + '</p><div class="row gap"><button class="btn primary" type="button" data-invite-spawn>' + escapeHtml(S.spCardTitle) + '</button></div>' : '') +
          '<p class="invite-label">' + escapeHtml(S.inviteAgent) + '</p><pre class="invite" id="' + agentId + '">' + escapeHtml(invitation) + '</pre>' +
          '<div class="row gap"><button class="btn" type="button" data-copy="' + agentId + '" data-invite-copy-agent>' + escapeHtml(S.copy) + '</button>' +
          (newCode ? '<button class="btn" type="button" id="btn-newcode">' + escapeHtml(S.newCode) + '</button>' : '') + '</div>' +
          '<p class="invite-label">' + escapeHtml(S.inviteColleagueLabel) + '</p><pre class="invite" id="' + colleagueId + '">' + escapeHtml(colleague) + '</pre>' +
          '<div class="row gap"><button class="btn" type="button" data-copy="' + colleagueId + '" data-invite-copy-colleague>' + escapeHtml(S.copy) + '</button></div>',
      };
    }
    function inviteCard() {
      var el = document.createElement("div");
      el.className = "sx-invite";
      var content = inviteContent(state.room.code, false, "card-");
      el.innerHTML = '<div class="sx-ih"><span class="sx-art">' + daemonSvg("", "") + botSvg(state.me + "-agent", "idle", "big") + "</span><b>" + escapeHtml(S.invite) + "</b></div>" + content.html;
      bindInviteSpawn(el);
      el.querySelector("[data-invite-copy-agent]").onclick = function () { copy(content.invitation, S.copied); };
      el.querySelector("[data-invite-copy-colleague]").onclick = function () { copy(content.colleague, S.copied); };
      return el;
    }
    function bindInviteSpawn(el) {
      var button = el.querySelector("[data-invite-spawn]");
      if (button) button.onclick = function () {
        var host = ctx.mySeats()[0];
        if (!host) return;
        closePanel();
        ctx.startSpawn(host.name);
      };
    }
    /** Put the card first in the feed, or take it away; the passcode in it follows the room's. */
    function placeInvite() {
      if (!wantsInvite()) {
        if (inviteEl) { inviteEl.remove(); inviteEl = null; }
        var gone = feed.querySelector(".empty.hidden");
        if (gone) gone.classList.remove("hidden");
        return;
      }
      var fresh = inviteCard();
      if (inviteEl && inviteEl.innerHTML === fresh.innerHTML) { if (feed.firstChild !== inviteEl) feed.insertBefore(inviteEl, feed.firstChild); }
      else {
        if (inviteEl) inviteEl.remove();
        inviteEl = fresh;
        feed.insertBefore(inviteEl, feed.firstChild);
      }
      var empty = feed.querySelector(".empty");
      if (empty) empty.classList.add("hidden"); // the card says what to do in an empty topic
    }

    function invitationText(code) {
      var tpl = code ? S.invitation : S.invitationNoCode;
      return fill(tpl, { id: state.room.id, code: code || "", topic: state.room.topic || state.room.name, install: boot.install });
    }

    // Members can read the passcode (it is a room-level shared secret); only the owner rotates it.
    function showInvite() {
      panel.dataset.kind = "invite";
      panel.classList.remove('sheet', 'tall');
      var code = state.room.code;
      var isOwner = state.room.owner === state.me;
      var content = inviteContent(code, isOwner && !state.room.public, "");
      panel.innerHTML = '<div class="panelhead"><b>' + escapeHtml(S.invite) + '</b><button type="button" class="x" data-close>×</button></div>' + content.html;
      panel.classList.remove("hidden");
      $("panel-scrim").classList.remove("hidden");
      $("invite-text").textContent = content.invitation;
      $("colleague-text").textContent = content.colleague;
      panel.querySelectorAll("[data-copy]").forEach(function (btn) {
        btn.onclick = function () {
          copyText($(btn.dataset.copy).textContent).then(function () {
            btn.textContent = S.copied;
            setTimeout(function () { btn.textContent = S.copy; }, 1500);
          });
        };
      });
      bindInviteSpawn(panel);
      var nc = $("btn-newcode");
      if (nc) nc.onclick = function () {
        (code ? ask(S.newCodeWarn, { ok: S.newCode, danger: true }) : Promise.resolve(true)).then(function (ok) {
          if (!ok) return;
          post("code", {}).then(function (r) {
            changeRoom({ code: r.code });
            showInvite();
          });
        });
      };
    }

    // ---------- the room itself: name, topic, public or private, archived ----------

    function setRoom(r) {
      var was = state.room.archived;
      var topicChanged = state.room.topic !== r.topic;
      changeRoom({ name: r.name, topic: r.topic, code: r.code, public: !!r.public, archived: !!r.archived,
        archivedAt: r.archivedAt == null ? null : r.archivedAt, archivedReason: r.archivedReason || null });
      applyRoom();
      if (was !== state.room.archived) { closeMenu(); exitSelect(); refreshPanel(); }
      if (panels.kind() === "invite") showInvite();
      if (panels.kind() === "settings") showSettings();
      placeInvite();
      if (topicChanged) {
        if (panels.kind() === "members") openPanel("members");
        if (panels.sideView() === "members") renderSide();
        refreshPopup();
      }
    }

    /** Title line, the public tag, and the composer or (archived) the read-only bar in its place. */
    function applyRoom() {
      $("room-name").textContent = state.room.name;
      // The header has room for the description's first line; the whole of it is a tap away.
      var lines = String(state.room.topic || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      $("room-topic").textContent = (lines[0] ? plainLines(lines[0]) : '') + (lines.length > 1 ? ' …' : '');
      var tag = $("room-pub");
      tag.textContent = S.publicTag;
      tag.classList.toggle("hidden", !state.room.public);
      var ro = $("readonly");
      var q = quotaNow(), out = !state.room.archived && !viewer && q && q.used >= q.limit, stick = nearBottom();
      $("composer").classList.toggle("hidden", state.room.archived || out || viewer);
      ro.classList.toggle("hidden", !state.room.archived && !out && !viewer);
      var expiry = archiveExpiryNote();
      ro.innerHTML = state.room.archived
        ? "<span>" + escapeHtml(S.readonlyBar) + (expiry ? '<small class="expiry">' + escapeHtml(expiry) + "</small>" : "") + "</span>" +
          (isOwner() ? '<button type="button" class="btn" data-restore>' + S.restore + "</button>" : "")
        : out ? "<span>" + escapeHtml(fill(S.quotaOut, { limit: q.limit, time: clock(q.resetsAt) }) + (isOwner() ? S.quotaPro : "")) + "</span>" +
          (isOwner() ? '<a class="btn" href="/pricing">' + escapeHtml(S.seePricing) + "</a>" : "")
        : viewer ? "<span>" + escapeHtml(S.viewerBar) + '</span><button type="button" class="btn primary" data-join>' + escapeHtml(S.join) + "</button>"
        : "";
      var note = $("quotanote");
      note.classList.toggle("hidden", !q || out || q.used < q.limit * 0.8);
      note.textContent = q && !out ? fill(S.quotaLeft, { left: q.limit - q.used, limit: q.limit, time: clock(q.resetsAt) }) + (isOwner() ? S.quotaPro : "") : "";
      if (stick) feed.scrollTop = feed.scrollHeight; // the bar or note took room from the feed: a reader at the bottom stays there
      updateChips();
    }

    // ---------- the retention clock: an archived room is deleted after 90 days ----------
    var RETENTION = boot.retention || { archiveAfterDays: 90, binAfterDays: 90 };
    /** 「90 天没新消息，自动归档。85 天后彻底删除。」 for an archived room; "" for an active one. */
    function archiveExpiryNote() {
      var r = state.room;
      if (!r.archived || r.archivedAt == null) return "";
      var n = Math.max(1, Math.ceil((r.archivedAt + RETENTION.binAfterDays * 86400000 - Date.now()) / 86400000));
      var parts = [];
      if (r.archivedReason === "retention") parts.push(fill(S.autoArchived, { days: RETENTION.archiveAfterDays }));
      parts.push(fill(S.binIn, { n: n }));
      return parts.join(boot.lang === "zh" ? "" : " ");
    }

    // ---------- today's messages: from 80% the composer says what is left, at the limit it stops ----------
    var quota = null;   // today's messages in this topic: {plan, used, limit (null: none), resetsAt}
    var quotaTimer = null;
    /** Today's count while it has a limit and the day it belongs to has not ended; else null. */
    function quotaNow() {
      var q = quota;
      return q && q.limit != null && Date.now() < q.resetsAt ? q : null;
    }
    function setQuota(q) {
      quota = q || null;
      clearTimeout(quotaTimer);
      // A new day: the bar goes by itself, without waiting for a message.
      if (quotaNow()) quotaTimer = setTimeout(applyRoom, Math.min(quota.resetsAt - Date.now() + 1000, 2147483000));
      applyRoom();
    }
    /** The hello frame's count, kept only when it has one; reapplyQuota() shows it once the page has drawn. */
    function setQuotaFromHello(q) { if (q !== undefined) quota = q; }
    function reapplyQuota() { setQuota(quota); }
    /** A quota frame: today's count, under the plan the hello frame said. */
    function quotaFrame(f) { setQuota({ plan: quota && quota.plan, used: f.used, limit: f.limit, resetsAt: f.resetsAt }); }

    // Room settings, the owner's: topic, who can enter, asking someone to leave, archiving.
    // note: what the last action did; kept while the sheet re-renders for room and member changes.
    var settingsNote = null;
    function showSettings(note) {
      if (note !== undefined) settingsNote = note;
      var keepTop = panels.kind() === "settings" ? panel.scrollTop : 0;
      var topic = panels.kind() === "settings" && $("set-topic") ? $("set-topic").value : null;
      var name = panels.kind() === "settings" && $("set-name") ? $("set-name").value : null;
      panel.dataset.kind = "settings";
      panel.classList.remove('sheet', 'tall');
      note = settingsNote;
      var r = state.room;
      var accounts = [];
      state.members.forEach(function (m) { if (m.status === "active" && accounts.indexOf(m.owner) < 0) accounts.push(m.owner); });
      accounts.sort(function (a, b) { return (b === r.owner) - (a === r.owner) || a.localeCompare(b); });
      var radio = function (v, label, hint) {
        return '<label class="radio"><input type="radio" name="vis" value="' + v + '"' + ((v === "public") === r.public ? " checked" : "") + "> <span><b>" + label + "</b> <small class=\"muted\">" + escapeHtml(hint) + "</small></span></label>";
      };
      var head = '<div class="panelhead"><b>' + S.settings + '</b><button type="button" class="x" data-close>×</button></div>';
      // Every member exports (docs/api/export.md); the rest of the settings are the creator's.
      var exportSection = "<h4>" + escapeHtml(S.exp.title) + '</h4><p class="muted small">' + escapeHtml(S.exp.note) + "</p>" + '<button type="button" class="btn xp-sec-btn" data-export>' + escapeHtml(S.exp.btn) + "</button>";
      if (!isOwner()) {
        panel.innerHTML = head + exportSection;
        panel.classList.remove("hidden");
        $("panel-scrim").classList.remove("hidden");
        panel.scrollTop = keepTop;
        return;
      }
      panel.innerHTML = head +
        // The name first (a rename only in the description popup was too hidden), then the description, each with its count and Save.
        '<h4>' + S.topicName + '</h4><div class="topicedit nameedit"><input id="set-name" type="text" maxlength="' + NAME_MAX + '">' +
          '<div class="topicfoot"><small id="name-n" class="count"></small><span class="sp"></span><button type="button" class="btn primary" id="name-save" data-savename>' + S.save + "</button></div></div>" +
        '<h4>' + S.setTopic + '</h4><div class="topicedit"><textarea id="set-topic" rows="5" placeholder="' + escapeHtml(S.topicHint) + '"></textarea>' +
          '<div class="topicfoot"><small id="topic-n" class="count"></small><span class="sp"></span><button type="button" class="btn primary" id="topic-save" data-savetopic>' + S.save + "</button></div></div>" +
        "<h4>" + S.setWho + "</h4>" + radio("private", S.visPrivate, S.visPrivateHint) + radio("public", S.visPublic, S.visPublicHint) +
        "<h4>" + S.setPeople + '</h4><div class="chips">' + accounts.map(function (a) {
          return a === r.owner
            ? '<span class="chip">' + escapeHtml(fill(S.ownerChip, { name: a })) + "</span>"
            : '<span class="chip">' + escapeHtml(a) + ' <button type="button" class="x" data-remove="' + escapeHtml(a) + '" aria-label="' + escapeHtml(fill(S.removeLabel, { name: a })) + '">×</button></span>';
        }).join("") + "</div>" +
        (note ? '<p class="note">' + escapeHtml(note) + "</p>" : "") +
        exportSection +
        "<h4>" + S.setArchive + '</h4><p class="muted small">' + escapeHtml(fill(S.archiveNote, { days: RETENTION.binAfterDays })) + "</p>" +
        (r.archived ? '<button type="button" class="btn" data-restore>' + S.restore + "</button>" : '<button type="button" class="btn danger" data-archive>' + S.archiveBtn + "</button>") +
        "<h4>" + S.setDelete + '</h4><p class="muted small">' + escapeHtml(S.deleteNote) + "</p>" +
        '<button type="button" class="btn danger" data-delroom>' + S.deleteBtn + "</button>";
      panel.classList.remove("hidden");
      $("panel-scrim").classList.remove("hidden");
      panel.scrollTop = keepTop;
      $("set-topic").value = topic != null ? topic : r.topic || "";
      $("set-name").value = name != null ? name : r.name;
      sizeTopic();
    }
    /** The description box's height and both counts (the name's too: one call after the sheet renders or a box changes). */
    function sizeTopic() {
      var ta = $("set-topic");
      if (!ta) return;
      growBox(ta, 340);
      showCount(ta, $("topic-n"), $("topic-save"), TOPIC_MAX);
      if ($("set-name")) showCount($("set-name"), $("name-n"), $("name-save"), NAME_MAX);
    }

    /** The settings row's Save: the box then shows the name as the server kept it (trimmed, cut at 80). */
    function saveSettingsName() {
      var btn = $("name-save");
      return renameTopic($("set-name").value, btn).then(function (r) {
        if (r && $("set-name")) $("set-name").value = r.name;
        if ($("name-save")) $("name-save").disabled = false;
      });
    }
    function settingsAct(e) {
      var t = e.target;
      if (t.closest("[data-export]")) return ctx.openExport();
      if (t.closest("[data-savename]")) return saveSettingsName();
      if (t.closest("[data-savetopic]")) {
        if (charCount($("set-topic").value) > TOPIC_MAX) return;
        return post("topic", { topic: $("set-topic").value }).then(function (r) {
          changeRoom({ topic: r.topic });
          $("set-topic").value = r.topic;
          applyRoom();
          toast(S.topicSaved);
        }).catch(function (err) { flash(err.next || String(err)); });
      }
      var rm = t.closest("[data-remove]");
      if (rm) {
        var who = rm.dataset.remove;
        return ask(fill(S.confirmRemove, { name: who }), { ok: S.removeOk, danger: true }).then(function (ok) {
          if (!ok) return;
          return post("remove", { account: who }).then(function () {
            showSettings(state.room.public ? S.removedNotePublic : S.removedNote);
          }).catch(function (err) { flash(err.next || String(err)); });
        });
      }
      if (t.closest("[data-delroom]")) {
        return ask(S.confirmDeleteRoom, { title: S.deleteRoomTitle, ok: S.deleteRoomOk, danger: true }).then(function (ok) {
          if (!ok) return;
          return post("delete", {}).then(function (r) { location.href = r.next || "/app"; }).catch(function (err) { flash(err.next || String(err)); });
        });
      }
      if (t.closest("[data-archive]")) return archiveRoom();
    }

    function archiveRoom() {
      return ask(fill(S.confirmArchive, { days: RETENTION.binAfterDays }), { ok: S.archiveOk }).then(function (ok) {
        if (!ok) return;
        return post("archive", { archived: true }).then(function (r) { setRoom(r); closePanel(); }).catch(function (err) { flash(err.next || String(err)); });
      });
    }

    function setVisibility(pub) {
      (pub ? ask(S.confirmPublic, { ok: S.publicOk }) : Promise.resolve(true)).then(function (ok) {
        if (!ok) return showSettings();
        post("visibility", { public: pub }).then(function (r) {
          setRoom(r);
          showSettings(pub ? S.visNowPublic : S.visNowPrivate);
        }).catch(function (err) { flash(err.next || String(err)); showSettings(); });
      });
    }

    function restoreRoom() {
      post("archive", { archived: false }).then(function (r) { setRoom(r); }).catch(function (err) {
        flash(err && err.error === "room_limit" ? S.restoreLimit : fill(S.restoreFailed, { why: err.next || String(err) }));
      });
    }

    /** The owner asked me to leave: say so and stop reconnecting; reloading shows the passcode form. */
    /** The owner deleted the room: nothing more happens here. */
    function roomGone() {
      socket.stop();
      shell.status("connection", escapeHtml(S.roomGone) + ' <a href="/app">' + escapeHtml(S.home) + "</a>", { html: true });
      $("composer").classList.add("hidden");
      $("readonly").classList.add("hidden");
      closePanel();
      closeMenu();
    }

    /**
     * Out of the topic. I left (here, or in another tab): a public topic shows again as its viewer, a private one goes
     * home. A viewer whose public topic turned private reloads into the passcode form. Otherwise the creator removed me.
     */
    function removedFromRoom(mySelf) {
      if (leaving) return; // leaveTopic() goes on from its answer
      if (mySelf) return state.room.public ? location.reload() : location.assign("/app");
      if (viewer) return location.reload();
      socket.stop();
      shell.status("connection", S.removedMe);
      $("composer").classList.add("hidden");
      $("readonly").classList.add("hidden");
      closePanel();
      closeMenu();
    }

    // ---------- the room menu ----------

    function closeRoomMenu() {
      $('room-menu').classList.add('hidden');
      $('room-menu-scrim').classList.add('hidden');
      $('btn-more').setAttribute('aria-expanded', 'false');
    }
    var roomMuted = null;
    function readRoomMute() {
      window.scorpioPushPrefs.read(state.me).then(function (current) {
        roomMuted = current.prefs.mutedRooms.indexOf(boot.roomId) >= 0;
        if (!$('room-menu').classList.contains('hidden')) renderRoomMenu();
      }).catch(function (err) {
        roomMuted = null;
        if (!$('room-menu').classList.contains('hidden')) renderRoomMenu();
        flash(err.next || err.message || String(err));
      });
    }
    function toggleRoomMute() {
      if (roomMuted == null) return;
      window.scorpioPushPrefs.write(state.me, { roomId: boot.roomId, muted: !roomMuted }).then(function (current) {
        roomMuted = current.prefs.mutedRooms.indexOf(boot.roomId) >= 0;
        toast(roomMuted ? S.muteToastOn : S.muteToastOff);
      }).catch(function (err) { flash(err.next || err.message || String(err)); });
    }
    function renderRoomMenu() {
      var members = state.members.filter(function (m) { return m.status !== 'left' && shown(m); }).length, at = atCount();
      $('room-menu').innerHTML = '<button type="button" class="pi" data-room-menu="members">' + escapeHtml(S.membersTab) +
        '<span class="v">' + members + '</span></button>' +
        '<button type="button" class="pi" data-room-menu="files">' + escapeHtml(S.filesMenu) + '</button>' +
        // A viewer has no @me list and nothing to mute until they join.
        (viewer ? '' : '<button type="button" class="pi" data-room-menu="at">' + S.menuMentions +
        '<span class="v">' + (at.loaded ? at.total : '…') + '</span></button>') +
        '<button type="button" class="pi" data-room-menu="invite">' + escapeHtml(S.inviteShort) + '</button>' +
        (viewer ? '' : '<button type="button" class="pi" data-room-menu="mute"' + (roomMuted == null ? ' disabled' : '') + '>' +
        (roomMuted ? '<span class="sd seen" aria-hidden="true"></span>' : '') +
        (roomMuted ? S.menuUnmute : S.menuMute) + '</button>') +
        '<div class="sep"></div>' +
        // Every member has the settings (a non-creator sees its export section); a viewer of a public topic has not joined.
        (!viewer ? '<button type="button" class="pi" data-room-menu="room-settings">' + escapeHtml(S.settings) + '</button>' : '') +
        '<a class="pi" href="/settings">' + S.menuSettings + '</a>' +
        (isOwner() && !state.room.archived ? '<button type="button" class="pi" data-room-menu="archive">' + escapeHtml(S.archiveBtn) + '</button>' : '') +
        // Leaving: anyone but the creator, who archives or deletes instead (the_owner_stays).
        (!viewer && !isOwner() ? '<button type="button" class="pi" data-room-menu="leave">' + escapeHtml(S.leave) + '</button>' : '');
    }

    // ---------- joining and leaving (docs/api/topics.md) ----------

    var leaving = false;
    function joinTopic(btn) {
      btn.disabled = true;
      post("enter", {}).then(function () { location.reload(); }, function (e) {
        btn.disabled = false;
        flash(fill(S.joinFailed, { why: (e && (e.next || e.error)) || "" }));
      });
    }
    function leaveTopic() {
      closeRoomMenu();
      ask(state.room.public ? S.confirmLeavePublic : S.confirmLeavePrivate, { title: S.confirmLeaveTitle, ok: S.leave, danger: true }).then(function (ok) {
        if (!ok) return;
        leaving = true;
        post("leave", {}).then(function (r) {
          if (r.public) location.reload(); // a viewer again
          else location.assign("/app");
        }, function (e) {
          leaving = false;
          flash(fill(S.leaveFailed, { why: (e && (e.next || e.error)) || "" }));
        });
      });
    }
    function toggleRoomMenu() {
      var menu = $('room-menu');
      if (!menu.classList.contains('hidden')) return closeRoomMenu();
      renderRoomMenu();
      menu.classList.remove('hidden');
      $('room-menu-scrim').classList.remove('hidden');
      $('btn-more').setAttribute('aria-expanded', 'true');
      if (!viewer) loadMentions(true);
    }

    /** The settings' listeners, attached once. The mute state is read first: until it is known the menu's mute item stays disabled. */
    function listen() {
      readRoomMute();
      document.addEventListener('scorpio-push-change', readRoomMute);
      $("readonly").addEventListener("click", function (e) {
        if (e.target.closest("[data-restore]")) return restoreRoom();
        var join = e.target.closest("[data-join]");
        if (join) joinTopic(join);
      });
      $("btn-more").onclick = toggleRoomMenu;
      // The name's box in the description popup: its count, and Enter saves.
      $("item-panel").addEventListener('input', function (e) { if (e.target.id === 'pop-name') countName(); });
      $("item-panel").addEventListener('keydown', function (e) { if (e.target.id === 'pop-name' && e.key === 'Enter') { e.preventDefault(); saveName($("pop-save")); } });
      // The settings sheet's name row: Enter saves (its count rides sizeTopic, which room.js calls on input).
      panel.addEventListener('keydown', function (e) { if (e.target.id === 'set-name' && e.key === 'Enter') { e.preventDefault(); saveSettingsName(); } });
      // The title opens the whole description.
      var titleEl = document.querySelector('.roombar .title');
      titleEl.addEventListener('click', function () { showTopic(false); });
      titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTopic(false); } });
      $('room-menu-scrim').onclick = closeRoomMenu;
      $('room-menu').onclick = function (e) {
        var action = e.target.closest('[data-room-menu]');
        if (!action) return;
        closeRoomMenu();
        if (action.dataset.roomMenu === 'members' || action.dataset.roomMenu === 'at' || action.dataset.roomMenu === 'files') return openPanel(action.dataset.roomMenu);
        if (action.dataset.roomMenu === 'invite') return showInvite();
        if (action.dataset.roomMenu === 'mute') return toggleRoomMute();
        if (action.dataset.roomMenu === 'room-settings') return showSettings(null);
        if (action.dataset.roomMenu === 'archive') return archiveRoom();
        if (action.dataset.roomMenu === 'leave') return leaveTopic();
      };
    }

    return {
      listen: listen, plainLines: plainLines, topicHtml: topicHtml, showTopic: showTopic, saveTopic: saveTopic, saveName: saveName,
      placeInvite: placeInvite, showInvite: showInvite,
      setRoom: setRoom, applyRoom: applyRoom, quotaNow: quotaNow, setQuota: setQuota,
      setQuotaFromHello: setQuotaFromHello, reapplyQuota: reapplyQuota, quotaFrame: quotaFrame,
      /** The passcode from an invite link the page opened with (a topic just made). */
      setCode: function (code) { changeRoom({ code: code }); },
      showSettings: showSettings, sizeTopic: sizeTopic, settingsAct: settingsAct, setVisibility: setVisibility, restoreRoom: restoreRoom,
      renderRoomMenu: renderRoomMenu, closeRoomMenu: closeRoomMenu, roomGone: roomGone, removedFromRoom: removedFromRoom,
      /** The hello frame brought the members: from now on the invite card knows whether an agent is in. */
      knowMembers: function () { membersKnown = true; },
    };
  };
})();
