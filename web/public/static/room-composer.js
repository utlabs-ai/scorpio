// The composer on the topic page: drafts, the reply bar, growing and the tall view, send and the outbox, delivery notes
// under my messages, the message menu's reply and mention, attachments, the @ picker and the / commands. Another domain borrows it through
// takeOver (editing a scheduled message) instead of writing its input, pictures, reply or send button.
(function () {
  "use strict";

  window.createRoomComposer = function (ctx) {
    var $ = ctx.$, RECEIPT = ctx.RECEIPT, S = ctx.S, ago = ctx.ago, append = ctx.append, ask = ctx.ask, avatar = ctx.avatar, boot = ctx.boot, canWrite = ctx.canWrite, clock = ctx.clock, computerOf = ctx.computerOf, extOf = ctx.extOf, feed = ctx.feed, fileRow = ctx.fileRow, fill = ctx.fill, flash = ctx.flash, input = ctx.input, isCoarse = ctx.isCoarse, lastSeq = ctx.lastSeq, myAgents = ctx.myAgents, names = ctx.names, nearBottom = ctx.nearBottom, ownerOf = ctx.ownerOf, picker = ctx.picker, post = ctx.post, postWithin = ctx.postWithin, presence = ctx.presence, quoteHtml = ctx.quoteHtml, quotaNow = ctx.quotaNow, readLine = ctx.readLine, rowName = ctx.rowName, setQuota = ctx.setQuota, shown = ctx.shown, shownName = ctx.shownName, sizeText = ctx.sizeText, state = ctx.state, textChanged = ctx.textChanged;
    // The composer's own: attachments {name, preview (images), file (not an image), size, status: up|ok|bad, id, before, after},
    // the reply ({seq, from, text, excerpt}: what the reply bar shows; excerpt: a selected part), and my file space
    // ({plan, used, limit, oldest, graceUntil}).
    var pics = [], replyTo = null, replySnap = null, space = boot.space || null;
    var ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.5V2.5M4.5 6 8 2.5 11.5 6"/></svg>';

    // ---------- drafts: what is typed (and what it replies to) is kept per room until it is sent ----------
    // In this tab's session storage: it survives going to another room and back, or a reload, and goes with the tab.

    var DRAFT_KEY = "scorpio.draft." + boot.roomId;
    var draftTimer = null;
    function saveDraft() {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(function () {
        try {
          if (input.value.trim() || replySnap) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text: input.value, reply: replySnap }));
          else sessionStorage.removeItem(DRAFT_KEY);
        } catch (e) {}
      }, 300);
    }
    function loadDraft() {
      try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; }
    }
    function clearDraft() {
      clearTimeout(draftTimer);
      try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
    }

    // ---------- the reply bar ----------

    /**
     * Reply to a message. opts: quiet (no focus, no draft save), mention (put @sender in front, so the
     * reply reaches them), excerpt (the part being answered, shown in the bar), snap (a saved reply to show
     * when the message is not on the page).
     */
    function setReply(seq, opts) {
      opts = opts || {};
      var m = seq != null ? state.bySeq.get(seq) || opts.snap : null;
      replyTo = m ? seq : null;
      replySnap = m ? { seq: m.seq, from: m.from, text: opts.excerpt || (opts.snap && opts.snap.text) || m.text || "", excerpt: !!(opts.excerpt || (opts.snap && opts.snap.excerpt)) } : null;
      var bar = $("replying");
      if (!m) { bar.classList.add("hidden"); if (!opts.quiet) saveDraft(); return; }
      if (opts.mention && m.from !== state.me && input.value.indexOf("@" + m.from) < 0) {
        input.value = "@" + m.from + " " + input.value.replace(/^\s+/, "");
        autosize();
        textChanged();
      }
      var t = replySnap.text.replace(/\s+/g, " ").trim() || S.picOnly;
      var q = t.length > 80 ? t.slice(0, 80) + "…" : t;
      // The bigger composer shows what is being answered in full.
      bar.innerHTML = '<div class="rqwrap"><span class="rq">' + S.replyingTo + " <b>" + escapeHtml(m.from) + " #" + m.seq + '</b> <i class="short">' + escapeHtml(q) + "</i></span>" +
        '<div class="rqfull md">' + renderMarkdown(replySnap.text || S.picOnly, names()) + '</div></div><button type="button" class="x" id="reply-cancel">×</button>';
      bar.classList.remove("hidden");
      $("reply-cancel").onclick = function () { setReply(null); };
      if (!opts.quiet) {
        saveDraft();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }

    // ---------- the composer grows with the text up to a few lines; past two, a button makes it big ----------

    var grow = $("btn-grow");
    function isTall() { return document.body.classList.contains("tall"); }
    function autosize() {
      input.style.height = "auto";
      var h = input.scrollHeight, cs = getComputedStyle(input);
      input.style.height = isTall() ? "" : Math.min(h, 132) + "px";
      grow.classList.toggle("hidden", isTall());
      // ⤢ once the text is past two lines: from the same measure, no second layout per keystroke. On a
      // phone, where it counts, the box has no min-height, so the height is the text's own plus its padding.
      $("composer").classList.toggle("cx-multi", h - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) > parseFloat(cs.lineHeight) * 2.5);
    }
    /** The composer over the whole page: a big box, what it answers in full above it. */
    function setTall(on) {
      document.body.classList.toggle("tall", on);
      window.scorpioRoomOverlays.changed(); // no element of its own to watch (room-overlay-history.js)
      hidePicker();
      autosize();
      if (on) input.focus();
    }

    /** A send the server refused for a limit: the page's own words (the server's next is for agents). */
    function sendRefusal(e, o) {
      if (e.error === "quota_exceeded") {
        var q = quotaNow();
        if (q) setQuota({ plan: q.plan, used: q.limit, limit: q.limit, resetsAt: q.resetsAt });
        return q ? fill(S.quotaOut, { limit: q.limit, time: clock(q.resetsAt) }) : e.next;
      }
      if (e.error === "rate_limited") return fill(S.tooFast, { s: (/(\d+) s\b/.exec(e.next || "") || [0, 60])[1] });
      if (e.error === "text_too_long") return fill(S.tooLong, { n: o.text.length, max: TEXT_MAX });
      return e.next || e.error;
    }

    /** Send: the composer empties at once and the message waits at the bottom of the feed until the server has it. */
    function send() {
      if (taken) return taken.onSave();
      var text = input.value;
      if (pics.some(function (p) { return p.status === "up"; })) return flash(S.picUploading);
      var ok = pics.filter(function (p) { return p.status === "ok"; });
      if (!text.trim() && !ok.length) return;
      if (text.length > TEXT_MAX) return flash(fill(S.tooLong, { n: text.length, max: TEXT_MAX }));
      // "/usage" typed straight in goes to my daemon: the only one, or the one I pick.
      var c = /^\s*\/([A-Za-z]+)(?=\s|$)/.exec(text);
      if (c && command(c[1])) {
        var seats = mySeats();
        if (!seats.length) return flash(S.noDaemon);
        if (seats.length > 1) return askSeat(c[1].toLowerCase(), true);
        text = "@" + seats[0].name + " " + text.replace(/^\s+/, "");
      }
      var o = {
        id: nonce(), nonce: nonce(), text: text.replace(/\r\n/g, "\n"), replyTo: replyTo, reply: replySnap, ts: Date.now(),
        files: ok.map(function (p) { return p.id; }), pics: ok.map(function (p) { return { preview: p.preview, name: p.name, file: !!p.file, size: p.size }; }), state: "queued",
      };
      pics.forEach(function (p) { if (ok.indexOf(p) < 0) URL.revokeObjectURL(p.preview); });
      pics = [];
      renderStrip();
      input.value = "";
      if (isTall()) setTall(false);
      autosize();
      textChanged();
      hidePicker();
      setReply(null, { quiet: true });
      clearDraft();
      outbox.push(o);
      drawOut(o);
      saveOutbox();
      pump();
    }

    // ---------- the outbox: sent but not answered yet, or failed ----------
    // One request at a time, in the order sent. A card shows "Sending…" until the server answers; the room's
    // own copy of the message then takes its place. A failed one keeps its text: Retry sends it with the same
    // nonce (the server answers a repeat within 10 minutes with the first result, so it never goes twice);
    // Edit puts it back into the composer. Kept in this tab's session storage, so a reload loses nothing.

    var outbox = [];   // {id, nonce, text, replyTo, reply, files, pics, ts, state: queued|sending|sent|failed, error, seq, el}
    var outEl = document.createElement("div");
    outEl.id = "outbox";
    var OUT_KEY = "scorpio.outbox." + boot.roomId, OUT_WAIT = 45000, sendingNow = false;

    function saveOutbox() {
      try {
        var keep = outbox.filter(function (o) { return o.state !== "sent"; }).map(function (o) {
          return { id: o.id, nonce: o.nonce, text: o.text, replyTo: o.replyTo, reply: o.reply, files: o.files, picN: o.pics.length, picMeta: o.pics.map(function (p) { return { name: p.name, file: !!p.file, size: p.size }; }), ts: o.ts, state: o.state, error: o.error };
        });
        if (keep.length) sessionStorage.setItem(OUT_KEY, JSON.stringify(keep));
        else sessionStorage.removeItem(OUT_KEY);
      } catch (e) {}
    }
    /** After a reload: what was still on its way goes again (the same nonce: never twice), unless that is too long ago to tell. */
    function loadOutbox() {
      var list;
      try { list = JSON.parse(sessionStorage.getItem(OUT_KEY) || "[]"); } catch (e) { list = []; }
      (Array.isArray(list) ? list : []).forEach(function (o) {
        o.pics = [];
        for (var i = 0; i < (o.picN || 0); i++) o.pics.push(Object.assign({ preview: null, name: "" }, (o.picMeta || [])[i] || {}));
        if (o.state !== "failed") {
          if (Date.now() - o.ts < 9 * 60000) o.state = "queued";
          else { o.state = "failed"; o.error = S.sendUnknown; }
        }
        outbox.push(o);
        drawOut(o);
      });
    }

    function placeOutbox() {
      if (outEl.parentNode !== feed || outEl.nextSibling) feed.appendChild(outEl);
    }

    function drawOut(o) {
      var stick = nearBottom();
      placeOutbox();
      var el = o.el;
      if (!el) {
        el = o.el = document.createElement("article");
        outEl.appendChild(el);
        var empty = feed.querySelector(".empty");
        if (empty) empty.remove();
      }
      var bad = o.state === "failed";
      el.className = "msg fm mine out " + (bad ? "failed" : "pending");
      el.dataset.out = o.id;
      var quote = quoteHtml(o.reply);
      var shown = o.pics.filter(function (p) { return !p.file; }), other = o.pics.filter(function (p) { return p.file; });
      var attached = (shown.length ? '<div class="pics' + (shown.length === 1 ? " one" : "") + '">' + shown.map(function (p) {
        return p.preview ? '<a><img src="' + p.preview + '" alt=""></a>' : '<a class="nopic"><span class="ic-img" aria-hidden="true"></span></a>';
      }).join("") + "</div>" : "") + (other.length ? '<div class="files">' + other.map(function (p) { return "<a>" + fileRow(p.name, p.size) + "</a>"; }).join("") + "</div>" : "");
      var phase = bad ? 'failed' : o.state === 'sent' ? 'sent' : 'sending';
      var st = bad ? S.notSent : o.state === 'sent' ? S.sent : S.sending;
      el.innerHTML = '<div class="fm-av">' + avatar({ from: state.me, fromKind: 'human' }) + '</div><div class="fm-col"><header class="fm-top"><b class="who">' +
        rowName(state.me, 'human') + '</b><span class="sp"></span><span class="rc ' + phase + '">' + RECEIPT + '<span>' + escapeHtml(st) + '</span></span></header>' + quote +
        '<div class="body md">' + renderMarkdown(o.text, names(), state.me) + '</div>' + attached +
        (bad ? '<div class="outfail"><span>' + escapeHtml(o.error || S.sendFailed) + '</span><span class="sp"></span><button type="button" class="btn" data-edit="' + o.id +
          '">' + escapeHtml(S.editSend) + '</button><button type="button" class="btn primary" data-retry="' + o.id + '">' + escapeHtml(S.retrySend) + '</button></div>' : '') + '</div>';
      if (stick) feed.scrollTop = feed.scrollHeight; // a reader at the bottom stays there as the card changes
    }

    /** Off the outbox: its card goes, and its image previews with it. */
    function dropOut(o) {
      var i = outbox.indexOf(o);
      if (i >= 0) outbox.splice(i, 1);
      if (o.el) o.el.remove();
      o.pics.forEach(function (p) { if (p.preview) URL.revokeObjectURL(p.preview); });
      saveOutbox();
    }

    /** The room's copy of a message I sent has come: the card waiting for it gives way. */
    function arrived(m) {
      if (m.from !== state.me) return;
      var o = outbox.find(function (x) { return x.seq === m.seq; }) ||
        // It can come over the socket before the answer to the request: the oldest one on its way with the same text.
        outbox.find(function (x) { return x.state === "sending" && !x.seq && x.text === m.text && x.files.length === (m.files || []).length; });
      if (!o) return;
      o.seq = m.seq;
      if (o.state === "sent") dropOut(o);
      else if (o.el) { o.el.remove(); o.el = null; o.hidden = true; }
    }

    function pump() {
      if (sendingNow) return;
      var o = outbox.find(function (x) { return x.state === "queued"; });
      if (!o) return;
      sendingNow = true;
      o.state = "sending";
      if (!o.hidden) drawOut(o);
      postWithin("send", { text: o.text, replyTo: o.replyTo, nonce: o.nonce, files: o.files }, OUT_WAIT).then(function (r) {
        o.seq = r.seq;
        o.state = "sent";
        // The HTTP answer is authoritative too: a dropped WebSocket frame must not strand my message in the outbox.
        if (r.message) append(r.message);
        // On the page already, or older than what is (sent before a reload, answered now from the first time).
        if (o.hidden || state.bySeq.has(r.seq) || r.seq <= lastSeq()) dropOut(o);
        else drawOut(o);
        if (o.files && o.files.length) setSpace(r);
        return deliveryNotes(r.delivery || [], r.seq);
      }, function (e) {
        // The room's copy already came: it did go through, only the answer got lost.
        if (o.hidden || (o.seq && state.bySeq.has(o.seq))) return dropOut(o);
        o.state = "failed";
        o.error = e && e.name === "AbortError" ? S.sendTimeout
          : e && e.error ? sendRefusal(e, o)
          : S.sendNet;
        drawOut(o);
        if (!nearBottom()) flash(S.sendFailedBelow);
      }).then(function () {
        sendingNow = false;
        saveOutbox();
        pump();
      });
    }

    function outById(id) { return outbox.find(function (o) { return o.id === id; }); }

    function retrySend(id) {
      var o = outById(id);
      if (!o || o.state !== "failed") return;
      o.state = "queued";
      o.error = null;
      drawOut(o);
      saveOutbox();
      pump();
    }

    /** A failed message back into the composer to change it (before what is typed there now, if anything). */
    function editSend(id) {
      var o = outById(id);
      if (!o || o.state !== "failed") return;
      var now = input.value.replace(/^\s+|\s+$/g, "");
      input.value = o.text + (now ? "\n\n" + now : "");
      if (o.reply && replyTo == null) setReply(o.reply.seq, { quiet: true, snap: o.reply });
      o.files.forEach(function (fid, i) {
        var p = o.pics[i] || {};
        pics.push({ id: fid, name: p.name || (p.file ? "file" : "image"), preview: p.preview || "", file: !!p.file, size: p.size, status: "ok" });
        p.preview = null; // the composer has it now
      });
      renderStrip();
      dropOut(o);
      autosize();
      saveDraft();
      textChanged();
      input.focus();
      input.setSelectionRange(o.text.length, o.text.length);
    }

    // ---------- delivery: who a message of mine does not reach now, and why, under that message ----------
    // An agent of mine that left the room comes with the takeover command it left, offered as one tap:
    // its computer being offline and it having left are different things to do about. Kept in this tab's session.

    var notes = new Map();   // seq -> [{t, name, cmd, sent}]
    var NOTES_KEY = "scorpio.notes." + boot.roomId;
    try { (JSON.parse(sessionStorage.getItem(NOTES_KEY) || "[]") || []).forEach(function (e) { notes.set(e[0], e[1]); }); } catch (e) {}

    function saveNotes() {
      try { sessionStorage.setItem(NOTES_KEY, JSON.stringify(Array.from(notes.entries()).slice(-40))); } catch (e) {}
    }

    function deliveryRows(list) {
      var rows = [];
      list.forEach(function (d) {
        if (d.status === "queued") rows.push({ phase: "later", t: d.host_offline_since ? fill(S.queuedOffline, { name: d.name, t: ago(d.host_offline_since) }) : fill(S.queued, { name: d.name }), name: d.name, bot: d.host_offline_since ? "offline" : "idle" });
        else if (d.status === "to_owner") rows.push({ phase: "later", t: fill(S.toOwner, { name: d.name }), name: d.name, bot: "idle" });
        else if (d.status === "left" && d.takeover && ownerOf(d.name) === state.me) rows.push({ phase: "gone", t: fill(S.leftOwn, { name: d.name }), name: d.name, bot: "gone", cmd: d.takeover, takeoverSeq: d.takeover_seq });
        // One of mine that left without a takeover command (no handoff): nothing brings it back, so say that the message does not reach it.
        else if (d.status === "left" && ownerOf(d.name) === state.me) rows.push({ phase: "gone", t: fill(S.leftNoTakeover, { name: d.name }), name: d.name, bot: "gone" });
      });
      return rows;
    }

    function deliveryNotes(list, seq) {
      var rows = deliveryRows(list);
      if (!rows.length) return;
      notes.set(seq, rows);
      saveNotes();
      drawNotes(seq);
      var card = $("m" + seq), message = state.bySeq.get(seq);
      if (card && message) readLine(message, card.querySelector('.rc'));
      if (boot.autoCallBack !== false) return Promise.all(rows.map(function (row) {
        if (!row.cmd || commandSent(row)) return;
        return sendCallBack(row, seq).catch(function (err) {
          flash(err.next || err.message || String(err));
        });
      }));
    }

    // Only a just-received send or press answer calls this: rendering history never sends a command.
    function commandSent(row) {
      return Array.from(state.bySeq.values()).some(function (m) {
        return m.seq > row.takeoverSeq && m.text === row.cmd;
      }) || Array.from(notes.values()).some(function (rows) {
        return rows.some(function (r) { return r.cmd === row.cmd && r.sent > row.takeoverSeq; });
      });
    }

    function sendCallBack(row, seq) {
      return post("send", { text: row.cmd, nonce: nonce() }).then(function (res) {
        row.sent = res.seq;
        saveNotes();
        drawNotes(seq);
      });
    }

    function notePending(row, seq) {
      if (row.sent) return true;
      var member = state.members.find(function (m) { return m.name === row.name; });
      return !member || !(Number(member.cursor) >= seq);
    }

    function noteEntries(seq, message) {
      var allowed = message && message.delivery && message.delivery.map(function (d) { return d.name; });
      // A scheduled revive already posted this agent's /spawn line. Offering the same takeover again would duplicate it.
      var spawn = message && message.scheduled && /^\s*@\S+\s+\/spawn\s+(?:claude|codex)\s+([A-Za-z0-9_.-]+)/.exec(message.text || "");
      var revived = spawn ? spawn[1] + "@" + ownerOf(message.scheduled.by) : null;
      return (notes.get(seq) || deliveryRows(message && message.delivery || []))
        .map(function (row, i) { return { row: row, index: i }; })
        .filter(function (entry) { return entry.row.name !== revived && notePending(entry.row, seq) && (!allowed || allowed.indexOf(entry.row.name) >= 0); });
    }

    function notesHtml(seq, message) {
      var rows = noteEntries(seq, message);
      if (!rows.length) return "";
      return rows.map(function (entry) {
        var r = entry.row, i = entry.index;
        var seatRow = hostSeat(r.name);
        var icon = !r.name || r.name.indexOf("@") < 0 ? "" : seatRow ? daemonSvg(r.bot === "offline" || r.bot === "gone" ? "offline" : "", "s16") : botStill(r.name, r.bot || "gone", "s16");
        if (r.sent) return '<div class="bring back">' + icon + '<span>' + escapeHtml(fill(S.calledBack, { name: r.name, n: "" })) + '<a class="ref" href="#m' + r.sent + '" data-jump="' + r.sent + '">#' + r.sent + '</a></span></div>';
        return '<div class="bring ' + (r.phase || 'later') + '">' + icon + '<span>' + escapeHtml(r.t) + '</span>' +
          (r.cmd ? '<button type="button" class="btn sm you" data-takeover="' + seq + ':' + i + '">' + escapeHtml(S.callBack) + '</button>' : '') + '</div>';
      }).join("");
    }

    function drawNotes(seq) {
      var card = $("m" + seq);
      if (!card) return; // its card shows them when it comes
      var html = notesHtml(seq, state.bySeq.get(seq));
      if (card.notesDrawn === html) return; // unchanged: no write (docs/web.md rule 2)
      card.notesDrawn = html;
      card.querySelectorAll(".bring").forEach(function (old) { old.remove(); });
      var bubble = card.querySelector(".fm-foot");
      if (bubble) {
        var itemLine = bubble.querySelector('.todoline');
        if (itemLine) itemLine.insertAdjacentHTML('beforebegin', html);
        else bubble.insertAdjacentHTML("beforeend", html);
      }
    }

    /** Bring a left agent back: its takeover command, shown in full, sent as me once I say so. */
    function callBack(key) {
      var at = key.split(":"), seq = Number(at[0]), rows = notes.get(seq);
      if (!rows) {
        rows = deliveryRows((state.bySeq.get(seq) || {}).delivery || []);
        if (rows.length) notes.set(seq, rows);
      }
      var r = rows && rows[Number(at[1])];
      if (!r || r.sent) return;
      var perm = /(^|\s)perm=(all|ask|auto)(\s|$)/.exec(r.cmd);
      var note = perm ? spawnHints().permissionNote(perm[2]) : Promise.resolve(S.spPermUnknownSetting);
      note.then(function (text) {
        return ask(fill(S.confirmCallBack, { name: r.name }), { ok: S.callBackOk, code: r.cmd, note: text, art: botSvg(r.name, "gone", "big s96") });
      }).then(function (ok) {
        if (!ok) return;
        return sendCallBack(r, seq);
      }).catch(function (err) { flash(err.next || err.message || String(err)); });
    }

    function nonce() {
      var a = new Uint8Array(12);
      crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    }

    /** The message menu's reply and mention. */
    function composeMenu(m) {
      if (!canWrite()) return [];
      var items = [{ act: "reply", label: S.menuReply, icon: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6"/></svg>', run: function (m) { return setReply(m.seq, { mention: true }); } }];
      if (m.from !== state.me) items.push({ act: "mention", label: fill(S.menuMention, { name: m.from }), icon: '<span class="mi mi-at" aria-hidden="true">@</span>', run: function (m) { return mentionAtEnd(m.from); } });
      return items;
    }

    /** "Mention X": @X at the end of what is being typed. */
    function mentionAtEnd(name) {
      if (!canWrite() || name === state.me) return;
      var v = input.value.replace(/\s+$/, "");
      input.value = (v ? v + " " : "") + "@" + name + " ";
      autosize();
      saveDraft();
      textChanged();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    // ---------- attachments in the composer: images (compressed first) and any other file ----------

    var PIC_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    var PIC_MAX = 9, PIC_MAX_BYTES = boot.fileMax || 10 * 1024 * 1024, PIC_EDGE = 2560;
    var TEXT_MAX = boot.textMax || 10000;
    function mbText(n) { return Math.round(n / 1048576) + " MB"; }

    function toBlob(canvas, type, quality) {
      return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
    }

    /** Shrink before upload: long edge at most 2560 px, re-encoded as WebP (JPEG where the browser has no WebP encoder). GIFs stay as they are. */
    function compress(file) {
      if (file.type === "image/gif" || !window.createImageBitmap) return Promise.resolve({ blob: file, name: file.name });
      return createImageBitmap(file).then(function (bmp) {
        var scale = Math.min(1, PIC_EDGE / Math.max(bmp.width, bmp.height));
        var c = document.createElement("canvas");
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        if (bmp.close) bmp.close();
        return toBlob(c, "image/webp", 0.8).then(function (b) {
          return b && b.type === "image/webp" ? b : toBlob(c, "image/jpeg", 0.85);
        }).then(function (b) {
          if (!b || (scale === 1 && b.size >= file.size)) return { blob: file, name: file.name };
          return { blob: b, name: (file.name || "image").replace(/\.[^.]*$/, "") + (b.type === "image/webp" ? ".webp" : ".jpg") };
        });
      }).catch(function () { return { blob: file, name: file.name }; });
    }

    function addPics(files) {
      if (!canWrite()) return;
      var list = Array.prototype.slice.call(files || []);
      var notes = [];
      list.forEach(function (file) {
        if (pics.length >= PIC_MAX) { if (notes.indexOf(S.picMax) < 0) notes.push(S.picMax); return; }
        var pic = PIC_TYPES.indexOf(file.type) >= 0;
        var item = { name: file.name || (pic ? "image" : "file"), preview: pic ? URL.createObjectURL(file) : "", file: !pic, size: file.size, status: "up", before: file.size };
        pics.push(item);
        // Images shrink first; any other file goes as it is (the server decides by its bytes what is an image).
        (pic ? compress(file) : Promise.resolve({ blob: file, name: item.name })).then(function (c) {
          item.after = c.blob.size;
          if (c.blob.size > PIC_MAX_BYTES) {
            item.status = "bad";
            item.error = fill(pic ? S.picTooBig : S.fileTooBig, { name: item.name, max: mbText(PIC_MAX_BYTES) });
            flash(item.error);
            renderStrip();
            return;
          }
          item.name = c.name;
          return fetch("/r/" + boot.roomId + "/files", {
            method: "POST",
            headers: { "content-type": c.blob.type || file.type || "application/octet-stream", "x-file-name": encodeURIComponent(c.name), accept: "application/json" },
            body: c.blob,
            credentials: "same-origin",
          }).then(function (res) {
            return res.json().then(function (j) { if (!res.ok) throw j; return j; });
          }).then(function (j) {
            item.id = j.id; item.status = "ok"; item.size = j.size;
            setSpace(j);
          }).catch(function (e) {
            var code = e && e.error;
            item.status = "bad";
            item.error = code === "file_too_large" ? fill(pic ? S.picTooBig : S.fileTooBig, { name: item.name, max: mbText(PIC_MAX_BYTES) })
              : code === "upload_limit" ? S.picDayLimit
              : (e && (e.next || e.message)) || S.picFailed;
            flash(item.error);
          }).then(renderStrip);
        });
      });
      if (notes.length) flash(notes.join("\n"));
      renderStrip();
    }

    // ---------- my file space: full means my oldest files go, so say so before, while attaching ----------

    /** An upload or send answer: it carries `space` from 80% on; without it the space is below that. */
    function setSpace(j) {
      if (!space || !j) return;
      if (j.space) Object.assign(space, j.space);
      else space.used = 0;
      renderSpace();
    }
    function dayText(ms) {
      var d = new Date(ms), o = { month: "long", day: "numeric" };
      if (d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
      return d.toLocaleDateString(boot.lang === "zh" ? "zh-CN" : undefined, o);
    }
    /** Shown above the composer while files are attached: from 80% of the space (red from 95%), or while a lapsed Pro's 30 days run. */
    function renderSpace() {
      var note = $("spacenote"), sp = space;
      if (!note) return;
      var near = sp && sp.limit && sp.used >= sp.limit * 0.8, grace = sp && sp.graceUntil && sp.graceUntil > Date.now();
      var show = !!pics.length && !state.room.archived && (near || grace);
      note.classList.toggle("hidden", !show);
      if (!show) { note.textContent = ""; return; }
      var parts = [], link = function (href, text) { return (text.charAt(0) === " " ? " " : "") + '<a href="' + href + '">' + escapeHtml(text.trim()) + "</a>"; };
      if (near) {
        var date = sp.oldest ? dayText(sp.oldest) : S.spaceFirst;
        var vars = { pct: Math.min(100, Math.floor(sp.used / sp.limit * 100)), used: sizeText(sp.used), limit: sizeText(sp.limit), left: sizeText(Math.max(0, sp.limit - sp.used)), date: date };
        // What can be done about it: free, upgrade. Drive backup is off the pages for now.
        var more = sp.plan === "free" && !grace ? link("/pricing", S.spacePro) : "";
        parts.push(escapeHtml(fill(sp.used >= sp.limit ? S.spaceFull : S.spaceNear, vars)) + more);
      }
      if (grace) parts.push(escapeHtml(fill(S.spaceGrace, { date: dayText(sp.graceUntil) })));
      note.innerHTML = parts.join(" ");
      note.classList.toggle("hot", !!near && sp.used >= sp.limit * 0.95);
    }

    function renderStrip() {
      renderSpace();
      var strip = $("strip");
      strip.classList.toggle("hidden", !pics.length);
      strip.innerHTML = pics.map(function (p, i) {
        var face = p.preview ? '<img src="' + p.preview + '" alt="">'
          : p.file ? '<span class="ic-file" aria-hidden="true"></span><span class="ext">' + escapeHtml(extOf(p.name) || "") + "</span>"
          : '<span class="ic-img" aria-hidden="true"></span>';
        return '<div class="thumb ' + p.status + (p.file ? " file" : "") + '" title="' + escapeHtml(p.error || p.name) + '">' + face +
          (p.status === "up" ? '<span class="st">…</span>' : p.status === "bad" ? '<span class="st">!</span>' : "") +
          '<button type="button" class="rm" data-rm="' + i + '" aria-label="×">×</button></div>';
      }).join("");
    }

    // ---------- the @ picker ----------

    function insertMention(name, replacePartial) {
      var pos = input.selectionStart, v = input.value;
      var before = v.slice(0, pos), after = v.slice(pos);
      if (replacePartial) before = before.replace(/@[A-Za-z0-9_.@-]*$/, "");
      else if (before && !/\s$/.test(before)) before += " ";
      var ins = "@" + name + " ";
      input.value = before + ins + after;
      var c = (before + ins).length;
      input.setSelectionRange(c, c);
      hidePicker();
      autosize();
      saveDraft();
      textChanged();
      input.focus();
      var seat = hostSeat(name);
      if (seat && seat.owner === state.me) suggestCommand(); // a daemon of mine: its commands right away
    }

    function showPicker(filter, replacePartial) {
      var f = (filter || "").toLowerCase();
      // Who is still here, plus my own agents that left: since v0.19.0 an @ to one
      // of those calls it back, so they are offered too, last and grey. Someone else's left agent and a person who left
      // stay out; a typed full name still reaches them as before.
      var list = state.members.filter(function (m) {
        var mineLeft = m.kind === "agent" && m.status === "left" && ownerOf(m.name) === state.me;
        return m.name !== state.me && (m.status === "active" || mineLeft) && shown(m) && (m.name.toLowerCase().indexOf(f) >= 0 || (m.displayName || "").toLowerCase().indexOf(f) >= 0);
      });
      if (!list.length) return hidePicker();
      var rank = function (m) { return m.status !== 'active' ? 5 : m.kind !== 'agent' ? 0 : !m.online ? 4 : m.work === 'working' ? 1 : m.work === 'blocked' ? 2 : 3; };
      list.sort(function (a, b) { return rank(a) - rank(b) || a.name.localeCompare(b.name); });
      openPicker("at", '<div class="aph"><span>@ ' + S.pickerWho + '</span><span class="sp"></span><span class="muted">' +
        S.pickerSearchHint + '</span></div>' + list.map(function (m) {
        var gone = m.status !== 'active';
        var icon = m.kind === 'agent' ? botStill(m.name, '', 's16') : m.kind === 'host' ? daemonSvg(gone || !m.online ? 'offline' : '', 's16') :
          '<span class="pav">' + escapeHtml((m.displayName || m.name).slice(0, 1).toLowerCase()) + '</span>';
        return '<button type="button" class="pickrow' + (gone ? ' gone' : '') + '" data-pick="' + escapeHtml(m.name) + '">' + icon +
          // An agent or a computer as message rows name it: mine by its role alone, others' with @account
          // small after it; picking still inserts the full name.
          '<span class="nm">' + (m.kind === 'human' ? shownName(m.name, m.displayName) : rowName(m.name, m.kind, m.displayName)) + '</span><span class="st' + (m.online && m.work === 'working' ? ' live' : '') + '">' +
          // A left agent of mine: what sending does, per the account setting (auto call-back, or the 「叫它回来」 button).
          escapeHtml(gone ? (boot.autoCallBack !== false ? S.st_leftBack : S.st_left) : presence(m)) + '</span></button>';
      }).join(""));
      picker.dataset.partial = replacePartial ? "1" : "";
    }
    /** mode: at | assign | cmd | seat | arg. The first choice is lit: arrow keys move it, Enter or Tab takes it. */
    function openPicker(mode, html) {
      picker.innerHTML = html;
      picker.classList.remove("sp", "cmdl");
      picker.dataset.mode = mode;
      picker.dataset.partial = "";
      picker.classList.remove("hidden");
      document.querySelector(".jumps").hidden = true;
      lightPick(0);
    }
    function hidePicker() {
      if (spawnSteps && spawnSteps.isOpen()) {
        spawnSteps.close();
        input.value = input.value.replace(/^\s*(?:@[A-Za-z0-9_.@-]+\s+)*\/spawn\s*$/, "");
        autosize(); saveDraft(); textChanged();
      }
      picker.classList.add("hidden");
      document.querySelector(".jumps").hidden = false;
      picker.classList.remove("sp", "cmdl");
      picker.innerHTML = "";
      picker.dataset.mode = "";
      picker.dataset.partial = "";
    }
    function picks() { return Array.prototype.slice.call(picker.querySelectorAll("button:not([disabled])")); }
    function lightPick(i) {
      var list = picks();
      list.forEach(function (b, k) { b.classList.toggle("hi", k === i); b.classList.toggle("on", k === i); });
      picker.dataset.hi = String(i);
      if (list[i]) list[i].scrollIntoView({ block: "nearest" });
    }
    /** Keys typed while the picker is open; true when the picker took the key. */
    function pickerKey(e) {
      if (picker.classList.contains("hidden")) return false;
      var list = picks(), i = Number(picker.dataset.hi) || 0;
      if (e.key === "Escape") {
        if (picker.dataset.mode === "cmd") bareOff = input.value.slice(0, input.selectionStart); // not again for this text
        hidePicker();
        return true;
      }
      if (!list.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        lightPick((i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isCoarse())) {
        (list[i] || list[0]).click();
        return true;
      }
      return false;
    }

    // ---------- room commands: "/" at the start of the composer ----------
    // The daemon's own table (cli/src/daemon/commands.mjs, its /help). A command goes to one of my daemons
    // (the command seat of a computer of mine; others' daemons do not take my commands): with one it is
    // filled in, with several I pick the computer (its role card names it), with none the picker says so.

    var COMMANDS = [
      { name: "spawn", args: "claude|codex [name] [dir] [model=…] [effort=…] [perm=…] [prompt]" },
      { name: "handoff", args: "name…|all" },
      { name: "bye", args: "name…|all" },
      // One agent's screen: read it, press keys, type text. one: only the first argument is a name.
      { name: "read", args: "name [lines]", one: true },
      { name: "keys", args: "name key…", one: true },
      { name: "text", args: "name text", one: true },
      { name: "idle", args: "[minutes|off]" },
      { name: "usage", args: "" },
      { name: "help", args: "" },
    ];
    function command(name) {
      return COMMANDS.find(function (c) { return c.name === String(name || "").toLowerCase(); });
    }
    function hostSeat(name) {
      return state.members.find(function (m) { return m.name === name && m.kind === "host"; });
    }
    function mySeats() {
      return state.members.filter(function (m) { return m.kind === "host" && m.owner === state.me && m.status === "active"; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    }
    /**
     * My agents a daemon was asked to start that may not have joined yet: the names in /spawn commands from me or
     * my agents to a daemon of mine, in the messages the page has, until a /bye or /handoff of that name (or all) to the
     * same daemon. Only our own command syntax, never the daemon's replies. {name: daemon}.
     */
    function spawnedNames(messages, me) {
      var out = {};
      messages.forEach(function (m) {
        if (m.from !== me && ownerOf(m.from) !== me) return;
        var c = /^\s*((?:@[A-Za-z0-9_.@-]+\s+)+)\/(spawn|bye|handoff)(?:\s+([\s\S]*))?$/i.exec(m.text || "");
        var seat = c && c[1].trim().split(/\s+/).map(function (n) { return n.slice(1); }).filter(function (n) {
          var member = hostSeat(n);
          return member && member.owner === me;
        })[0];
        if (!seat) return;
        var words = (c[3] || "").trim().split(/\s+/);
        if (c[2].toLowerCase() !== "spawn") {
          Object.keys(out).forEach(function (n) { if (out[n] === seat && (words.indexOf(n) >= 0 || words.indexOf("all") >= 0)) delete out[n]; });
        } else if (/^(claude|codex)$/i.test(words[0]) && /^[a-z][a-z0-9_-]{0,31}$/.test(words[1] || "")) out[words[1]] = seat; // /spawn claude|codex [name] …
      });
      return out;
    }

    var spawnSteps = null;
    function spawnHints() {
      if (!spawnSteps) spawnSteps = window.createSpawnCard({ S: S, lang: boot.lang, state: state, escape: escapeHtml, fill: fill,
        ownerOf: ownerOf, hostSeat: hostSeat, computerOf: computerOf, spawnedNames: spawnedNames,
        spawnPerm: boot.spawnPerm, picker: picker, input: input, isCoarse: isCoarse, roomId: boot.roomId,
        collapse: function () { hidePicker(); if (!isCoarse()) input.focus(); },
        send: function (text) { input.value = text; send(); } });
      return spawnSteps;
    }

    /** The keys /keys can press ({name, label}), from GET /api/v1/config/keys the first time they are wanted. */
    var KEYS = null, keysLoading = false;
    function keyTable() {
      if (!KEYS && !keysLoading) {
        keysLoading = true;
        fetch("/api/v1/config/keys").then(function (r) { return r.json(); }).then(function (j) { KEYS = j.keys; suggestCommand(); })
          .catch(function () { keysLoading = false; });
      }
      return KEYS || [];
    }

    /**
     * What is being typed, as a command: {kind: "name", partial} while typing "/sp", {kind: "args", cmd, args}
     * after it; only at the start of the text, after nothing but @daemons. null when it is not a command.
     */
    function commandAt(before) {
      var m = /^\s*((?:@[A-Za-z0-9_.@-]+\s+)*)\/([A-Za-z]*)(\s[\s\S]*)?$/.exec(before);
      if (!m) return null;
      var lead = m[1].trim() ? m[1].trim().split(/\s+/) : [];
      if (!lead.every(function (n) { return hostSeat(n.slice(1)); })) return null;
      if (m[3] == null) return { kind: "name", partial: m[2].toLowerCase(), lead: lead.length };
      var c = command(m[2]);
      return c ? { kind: "args", cmd: c, args: m[3], lead: lead.length, seats: lead.map(function (n) { return n.slice(1); }) } : null;
    }

    /** Show what fits what is being typed: commands, or a command's arguments. True when it is a command. */
    function suggestCommand() {
      var before = input.value.slice(0, input.selectionStart);
      var at = commandAt(before) || bareSeatsAt(before);
      if (!at) return false;
      if (at.kind === "name") {
        var seats = mySeats();
        var list = COMMANDS.filter(function (c) { return c.name.indexOf(at.partial) === 0; });
        // Nothing left to pick: no such command, or one already sent to a daemon and typed out in full.
        if (!list.length || (at.lead && list.length === 1 && list[0].name === at.partial)) { hidePicker(); return true; }
        var head = at.lead ? "" : !seats.length ? S.noDaemon
          : seats.length === 1 ? fill(S.cmdToOne, { name: seats[0].name, host: computerOf(seats[0]) })
          : fill(S.cmdToMany, { n: seats.length });
        var off = !at.lead && !seats.length;
        openPicker("cmd", (head ? '<div class="phead' + (off ? " warn" : "") + '">' + (!at.lead && seats.length === 1 ? daemonSvg(seats[0].online ? '' : 'offline', 's16') : '') + escapeHtml(head) + "</div>" : "") + list.map(function (c) {
          return '<button type="button" class="two" data-cmd="' + c.name + '"' + (off ? " disabled" : "") + '><span class="l1"><b>/' + c.name + "</b>" +
            (c.args && c.name !== "spawn" ? ' <span class="args">' + escapeHtml(S["args_" + c.name] || c.args) + "</span>" : "") + '</span><small class="muted">' + escapeHtml(c.name === "spawn" ? S.spSpawnRow : S["cmd_" + c.name]) + "</small></button>";
        }).join(""));
        picker.classList.add("cmdl");
        return true;
      }
      // Arguments: the names of my agents for handoff / bye / read / keys / text, claude or codex to start /spawn, keys for /keys.
      if (at.cmd.name === "spawn") {
        if (at.args.trim() || input.value !== before) return false;
        var selected = at.seats[0] || (mySeats().length === 1 ? mySeats()[0].name : null);
        if (!selected) { askSeat("spawn", false); return true; }
        if (!at.seats.length) return toSeat(selected, false), true;
        if (hostSeat(selected).owner !== state.me) return false;
        document.querySelector(".jumps").hidden = true;
        spawnHints().open(selected);
        return true;
      }
      picker.classList.remove("sp");
      var words = at.args.trim() ? at.args.trim().split(/\s+/) : [];
      var partial = /\s$/.test(at.args) ? "" : words.pop() || "";
      var rows = [];
      if (at.cmd.args && (at.cmd.one ? !words.length : words.indexOf("all") < 0)) {
        // Only the agents on the computer the command goes to can be picked; those on another one are greyed,
        // with where they are (a daemon answers "not on this computer" for them).
        var elsewhere = function (m) { return at.seats.length > 0 && !!m.host && at.seats.indexOf(m.host) < 0; };
        var seatOf = function (name) { return state.members.find(function (x) { return x.name === name; }) || { name: name }; };
        var roles = myAgents().map(function (m) {
          return elsewhere(m) ? { arg: m.name.split("@")[0], note: fill(S.onComputer, { host: computerOf(seatOf(m.host)) }), off: true }
            : { arg: m.name.split("@")[0], note: m.online ? S.online : S.offline };
        });
        if (at.cmd.one) {
          // Also the ones a /spawn named that are not here yet: a stuck one is what these commands are for.
          var spawned = spawnedNames(state.messages, state.me);
          Object.keys(spawned).forEach(function (n) {
            if (roles.some(function (r) { return r.arg === n; })) return;
            roles.push(at.seats.length > 0 && at.seats.indexOf(spawned[n]) < 0 ? { arg: n, note: fill(S.onComputer, { host: computerOf(seatOf(spawned[n])) }), off: true }
              : { arg: n, note: S.notJoined });
          });
        }
        roles.sort(function (a, b) { return (a.off ? 1 : 0) - (b.off ? 1 : 0); });
        if (!at.cmd.one) roles.push({ arg: "all", note: S.argAll });
        rows = roles.filter(function (r) {
          return r.arg.toLowerCase().indexOf(partial.toLowerCase()) === 0 && words.indexOf(r.arg) < 0 && !(r.arg === "all" && words.length);
        });
      } else if (at.cmd.name === "keys") {
        // After the name, the keys: each tap adds one, as often as needed; Send when done.
        rows = keyTable().filter(function (k) { return k.name.indexOf(partial.toLowerCase()) === 0; }).map(function (k) {
          return { arg: k.name, label: k.label, note: k.label.toLowerCase() === k.name ? "" : k.name };
        });
      }
      if (!rows.length) { hidePicker(); return false; } // the @ picker may take it from here (a /spawn prompt can @ someone)
      openPicker("arg", rows.map(function (r) {
        return '<button type="button" data-arg="' + escapeHtml(r.arg) + '"' + (r.off ? " disabled" : "") + "><b>" + escapeHtml(r.label || r.arg) + "</b>" + (r.note ? ' <small class="muted">' + escapeHtml(r.note) + "</small>" : "") + "</button>";
      }).join(""));
      return true;
    }

    /** The invitation uses the same /spawn recognition as typing or choosing the command. */
    function startSpawn(seat) {
      input.value = "@" + seat + " /spawn ";
      input.setSelectionRange(input.value.length, input.value.length);
      autosize();
      saveDraft();
      textChanged();
      suggestCommand();
    }

    /** Replace what is typed before the caret (matched by re) with ins; what follows the caret stays. */
    function typeOver(re, ins) {
      var pos = input.selectionStart, before = input.value.slice(0, pos).replace(re, ins);
      input.value = before + input.value.slice(pos);
      input.setSelectionRange(before.length, before.length);
      autosize();
      saveDraft();
      textChanged();
      input.focus();
    }

    /**
     * Only @ to my daemons so far, then a space: the commands come up as if "/" had been typed; picking
     * one writes it after them. Esc puts the list away until the text changes.
     */
    var bareOff = null;
    function bareSeatsAt(before) {
      var m = /^\s*((?:@[A-Za-z0-9_.@-]+\s+)+)$/.exec(before);
      if (!m) { bareOff = null; return null; }
      if (bareOff === before) return null;
      var lead = m[1].trim().split(/\s+/), mine = mySeats().map(function (x) { return x.name; });
      if (!lead.every(function (n) { return mine.indexOf(n.slice(1)) >= 0; })) return null;
      return { kind: "name", partial: "", lead: lead.length, bare: true };
    }

    /** A command picked: "/sp" becomes "/spawn ", then it goes to my daemon (asking which, with several). */
    function pickCommand(name) {
      var c = command(name);
      var before = input.value.slice(0, input.selectionStart);
      if (/\/[A-Za-z]*$/.test(before)) typeOver(/\/[A-Za-z]*$/, "/" + c.name + (c.args ? " " : ""));
      else typeOver(/$/, "/" + c.name + (c.args ? " " : "")); // after "@daemon… " with no "/" yet
      if (commandAt(input.value.slice(0, input.selectionStart)).lead) return afterCommand();
      var seats = mySeats();
      if (seats.length === 1) return toSeat(seats[0].name, false);
      if (!seats.length) { hidePicker(); return flash(S.noDaemon); }
      askSeat(c.name, false);
    }

    /** Which computer: one row per daemon of mine. thenSend: Send was pressed, so it goes once picked. */
    function askSeat(cmd, thenSend) {
      openPicker("seat", '<div class="phead">' + escapeHtml(fill(S.pickSeat, { cmd: cmd })) + "</div>" + mySeats().map(function (s) {
        return '<button type="button" class="dseat" data-seat="' + escapeHtml(s.name) + '">' + daemonSvg(s.online ? '' : 'offline', '') + '<b>' + escapeHtml(computerOf(s)) + '</b> <small class="muted">@' +
          escapeHtml(s.name) + " · " + (s.online ? S.online : S.offline) + "</small></button>";
      }).join(""));
      picker.dataset.send = thenSend ? "1" : "";
    }

    /** Put "@daemon… " in front of the command. */
    function toSeat(name, thenSend) {
      var pos = input.selectionStart, v = input.value, lead = v.length - v.replace(/^\s+/, "").length;
      var ins = "@" + name + " ";
      input.value = ins + v.slice(lead);
      var c = Math.max(0, pos - lead) + ins.length;
      input.setSelectionRange(c, c);
      autosize();
      saveDraft();
      textChanged();
      var seat = state.members.find(function (m) { return m.name === name; });
      if (seat && !seat.online) flash(fill(S.daemonOffline, { host: computerOf(seat) }));
      if (thenSend) { hidePicker(); return send(); }
      input.focus();
      afterCommand();
    }

    /** After the command is in place: its arguments to pick from, if it takes any. */
    function afterCommand() {
      var at = commandAt(input.value.slice(0, input.selectionStart));
      if (at && at.kind === "args" && at.cmd.args) suggestCommand();
      else hidePicker();
    }

    // ---------- taken over: another domain borrows the composer (a scheduled message being edited) ----------
    // What was in it (text, pictures, reply) waits aside and comes back with end(). Taken again before end(), it puts
    // the borrowed state aside in place of the first: as editing did before it had this interface.

    var taken = null;   // {onSave, onCancel, text, pics, reply} while borrowed
    /** o: {text, label (the edit bar's HTML before its ×), onSave (Send and Enter), onCancel (the bar's ×)}. */
    function takeOver(o) {
      var before = input.value;
      input.value = o.text;
      var held = pics;
      pics = [];
      renderStrip();
      var reply = { to: replyTo, snap: replySnap };
      setReply(null, { quiet: true });
      autosize();
      saveDraft();
      var bar = $("schedule-edit");
      bar.innerHTML = o.label + '<span class="sp"></span><button type="button" class="x" data-takeover-cancel aria-label="' + escapeHtml(S.cancel) + '">×</button>';
      bar.classList.remove("hidden");
      $("btn-send").textContent = S.save;
      $("btn-send").setAttribute("aria-label", S.save); $("btn-send").title = S.save;
      taken = { onSave: o.onSave, onCancel: o.onCancel, text: before, pics: held, reply: reply };
      return { setText: setText, end: end };
    }
    function setText(v) {
      input.value = v;
      autosize();
      saveDraft();
    }
    function end() {
      var was = taken;
      taken = null;
      input.value = was.text;
      pics = was.pics || [];
      renderStrip();
      setReply(was.reply.to, { quiet: true, snap: was.reply.snap });
      $("schedule-edit").classList.add("hidden"); $("schedule-edit").innerHTML = "";
      $("btn-send").innerHTML = ARROW; $("btn-send").setAttribute("aria-label", S.send); $("btn-send").title = S.send;
      autosize();
      saveDraft();
    }
    /** After what was typed became something else (a new schedule): empty, with no reply and no draft. */
    function clear() {
      input.value = "";
      setReply(null);
      clearDraft();
      autosize();
    }
    function hasFiles() { return pics.length > 0; }

    /** The feed's slots the composer fills: delivery notes and the receipt under my messages, reply and mention in the menu. */
    function hookFeed(rowHook, menuHook) {
      rowHook('notes', function (m, row) { return row.receipt ? notesHtml(m.seq, m) : ''; });
      rowHook('receipt', function (m) {
        var delivery = noteEntries(m.seq, m).map(function (entry) { return entry.row; });
        if (delivery.some(function (x) { return !x.sent && x.phase === 'gone'; })) return { phase: 'gone', label: S.receiptGone };
        if (delivery.some(function (x) { return !x.sent && x.phase === 'later'; })) return { phase: 'later', label: S.receiptLater };
        return null;
      });
      rowHook('notesRedraw', function (m) { drawNotes(m.seq); });
      menuHook('compose', composeMenu);
    }

    /** The composer's own controls: attaching, removing, pasting and dropping files, the Send button, the edit bar's ×, growing and shrinking, typing and its keys, the picker. */
    function listen() {
      // No attach buttons when the deployment has no file storage (boot.fileStorage false); a pasted or dropped
      // file still goes to the server, which says why it is refused.
      if ($("btn-pic")) {
        $("btn-pic").setAttribute("aria-label", S.picLabel);
        $("btn-pic").onclick = function () { $("pic-input").click(); };
        $("pic-input").onchange = function () { addPics(this.files); this.value = ""; };
        // Any file at all: the same upload; the server takes any type.
        $("btn-file").setAttribute("aria-label", S.fileLabel);
        $("btn-file").onclick = function () { $("file-input").click(); };
        $("file-input").onchange = function () { addPics(this.files); this.value = ""; };
      }
      $("strip").addEventListener("click", function (e) {
        var b = e.target.closest("[data-rm]");
        if (!b) return;
        var p = pics.splice(Number(b.dataset.rm), 1)[0];
        if (p && p.preview) URL.revokeObjectURL(p.preview);
        renderStrip();
      });
      input.addEventListener("paste", function (e) {
        var files = (e.clipboardData && e.clipboardData.files) || [];
        if (!files.length) return;
        e.preventDefault();
        addPics(files);
      });
      document.addEventListener("dragover", function (e) {
        if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) e.preventDefault();
      });
      document.addEventListener("drop", function (e) {
        if (!e.dataTransfer || !e.dataTransfer.files.length) return;
        e.preventDefault();
        addPics(e.dataTransfer.files);
      });
      $("btn-send").innerHTML = ARROW;
      $("btn-send").setAttribute("aria-label", S.send);
      $("btn-send").title = S.send;
      $("btn-send").onclick = send;
      $("schedule-edit").addEventListener("click", function (e) { if (e.target.closest("[data-takeover-cancel]")) taken.onCancel(); });
      grow.setAttribute("aria-label", S.grow);
      grow.title = S.grow;
      grow.onclick = function () { setTall(true); };
      $("tall-title").textContent = S.tallTitle;
      $("btn-shrink").textContent = S.shrink;
      $("btn-shrink").onclick = function () { setTall(false); input.focus(); };
      input.addEventListener("input", function () {
        autosize();
        saveDraft();
        textChanged();
        if (suggestCommand()) return;
        var m = /(^|\s)@([A-Za-z0-9_.@-]*)$/.exec(input.value.slice(0, input.selectionStart));
        if (m) showPicker(m[2], true);
        else if (picker.dataset.partial || /^(cmd|arg|seat)$/.test(picker.dataset.mode)) hidePicker();
      });
      input.addEventListener("keydown", function (e) {
        if (pickerKey(e)) return e.preventDefault();
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isCoarse()) { e.preventDefault(); send(); }
        if (e.key === "Escape") { if (isTall()) setTall(false); else setReply(null); }
      });
      picker.addEventListener("click", function (e) {
        if (picker.classList.contains("sp-card")) return;
        var b = e.target.closest("[data-pick]");
        if (b) return insertMention(b.dataset.pick, picker.dataset.partial === "1");
        var cm = e.target.closest("[data-cmd]");
        if (cm) return pickCommand(cm.dataset.cmd);
        var st = e.target.closest("[data-seat]");
        if (st) return toSeat(st.dataset.seat, picker.dataset.send === "1");
        var ar = e.target.closest("[data-arg]");
        if (ar) {
          typeOver(/[A-Za-z0-9_.-]*$/, ar.dataset.arg + " ");
          return afterCommand();
        }
      });
    }

    return {
      arrived: arrived,
      autosize: autosize,
      callBack: callBack,
      clear: clear,
      dayText: dayText,
      /** Under a message the page sent for the person (a reply button's press), the same notes and automatic call-back a send gets. */
      deliveryNotes: deliveryNotes,
      editSend: editSend,
      hasFiles: hasFiles,
      hidePicker: hidePicker,
      hookFeed: hookFeed,
      insertMention: insertMention,
      isTall: isTall,
      listen: listen,
      loadDraft: loadDraft,
      loadOutbox: loadOutbox,
      mySeats: mySeats,
      startSpawn: startSpawn,
      outEl: outEl,
      outbox: outbox,
      placeOutbox: placeOutbox,
      pump: pump,
      /** Why a message the page sent for the person was refused, in the words a failed send shows (a reply button's press). */
      refusal: function (e) { return e && e.error ? sendRefusal(e, { text: "" }) : S.sendNet; },
      retrySend: retrySend,
      saveDraft: saveDraft,
      send: send,
      setReply: setReply,
      setTall: setTall,
      takeOver: takeOver,
    };
  };
})();
