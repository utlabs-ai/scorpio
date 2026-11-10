// Reply buttons and chart cards on an agent's message (docs/api/messages.md).
// Buttons come first in the row's foot. A tap posts /press; the reply comes back like any message, and who chose what
// comes back in a message_update frame, which draws the row again. A card's frame is on the content domain with a
// ticket, as a file's is (file-page.js): it loads while its row is on the page and near the screen, says its height
// (scorpio:size) and that it drew (scorpio:ready), and goes with its row. Where it cannot, the summary stands in for it.
(function () {
  "use strict";
  var READY_MS = 8000;       // no scorpio:ready by then: the summary instead
  var NEAR = "600px 0px";    // how close to the screen a card's row must come before its frame loads

  window.createRoomAiCards = function (ctx) {
    var S = ctx.S.ai, state = ctx.state, feed = ctx.feed, frameOpts = ctx.boot.card;
    // What this module watches, by seq: only rows the page drew, each dropped once its row has gone (docs/web.md rule 1).
    var groups = new Map();     // a row's button group, watched for its width
    var places = new Map();     // a row's card: {seq, el, box, frame, win, origin, timer, height, ready}
    var sources = new Map();    // a loaded frame's window → its card (in the feed, or the full screen one)
    var busy = new Map();       // seq → the index of the button whose press is on its way
    var full = null, over = null, back = null;

    function theme() {
      return document.documentElement.dataset.scorpioEffectiveTheme === "dark" ? "dark" : "light";
    }
    function displayName(name) {
      var m = state.members.find(function (x) { return x.name === name; });
      return (m && m.displayName) || name;
    }

    // ---------- buttons ----------

    /** What a screen reader says for a button: its label, and who chose it. */
    function spoken(b) {
      var by = b.by || [], mine = by.indexOf(state.me) >= 0;
      var names = by.filter(function (n) { return n !== state.me; }).map(displayName).join(S.namesJoin);
      if (mine) return names ? ctx.fill(S.mineAlso, { label: b.label, names: names }) : ctx.fill(S.mine, { label: b.label });
      return names ? ctx.fill(S.chosenBy, { label: b.label, names: names }) : b.label;
    }
    /** The latest three who chose it, on its top right; more than that, a count. */
    function chosen(by) {
      if (!by.length) return "";
      return '<span class="aib-avs" aria-hidden="true">' + (by.length > 3 ? '<span class="aib-more">+' + (by.length - 3) + "</span>" : "") +
        by.slice(-3).map(function (n) { return ctx.avatar({ from: n, fromKind: "human" }); }).join("") + "</span>";
    }
    function buttonsHtml(m) {
      if (!m.buttons || !m.buttons.length) return "";
      var wait = busy.get(m.seq);
      return '<div class="aib"' + (wait != null ? ' data-busy="' + wait + '" aria-busy="true"' : "") + ">" + buttonsInner(m) + "</div>";
    }
    function buttonsInner(m) {
      // A viewer or an archived topic sees them, greyed: pressing is for members while the topic is open.
      var can = ctx.canWrite();
      return m.buttons.map(function (b, i) {
        var by = b.by || [];
        return '<button type="button" class="aib-b' + (by.length ? " picked" : "") + (by.indexOf(state.me) >= 0 ? " mine" : "") + '" data-press="' + m.seq + ":" + i + '"' +
          (can ? "" : " disabled") + ' aria-label="' + escapeHtml(spoken(b)) + '"><span class="aib-l">' + escapeHtml(b.label) + "</span>" + chosen(by) + "</button>";
      }).join("");
    }
    /** Someone chose (message_update): the buttons drawn again inside their group; the row, and a card's frame, stay. */
    function buttonsChanged(m, el) {
      var g = el.querySelector(".aib");
      if (!g || !m.buttons || !m.buttons.length) return false;
      g.innerHTML = buttonsInner(m);
      return true;
    }
    function press(button) {
      var at = button.dataset.press.split(":"), seq = Number(at[0]), index = Number(at[1]);
      if (button.disabled || busy.has(seq)) return; // a second tap while the first is on its way
      busy.set(seq, index);
      busyShown(seq);
      return ctx.post("press", { seq: seq, index: index }).then(function (r) {
        // {unchanged: true}: it was already this person's answer, and nothing was sent.
        if (r && r.message) ctx.append(r.message);
        // A press is a send: an agent of mine that left is called back (or noted) as after the composer's send.
        if (r && r.seq) ctx.deliveryNotes(r.delivery || [], r.seq);
      }, function (e) {
        ctx.flash(ctx.refusal(e));
      }).then(function () {
        busy.delete(seq);
        busyShown(seq);
      });
    }
    /** The group of seq's row, when the page has it, shows whether a press is on its way (and which button). */
    function busyShown(seq) {
      var g = groups.get(seq), i = busy.get(seq);
      if (!g) return;
      if (i == null) { delete g.dataset.busy; g.removeAttribute("aria-busy"); }
      else { g.dataset.busy = String(i); g.setAttribute("aria-busy", "true"); }
    }
    // A row of buttons that does not fit goes into one column, every button full width; never a ragged wrap.
    var widths = window.ResizeObserver ? new ResizeObserver(function (list) {
      list.forEach(function (e) { fitGroup(e.target, Math.round(e.contentRect.width)); });
    }) : null;
    function fitGroup(g, width) {
      if (g.aibWidth === width) return; // a change of height (the column itself) decides nothing
      g.aibWidth = width;
      g.classList.remove("stack");
      var need = 0, n = 0;
      for (var c = g.firstElementChild; c; c = c.nextElementSibling, n++) need += c.offsetWidth;
      need += (n - 1) * (parseFloat(getComputedStyle(g).columnGap) || 0);
      if (need > g.clientWidth) g.classList.add("stack");
    }

    // ---------- cards ----------

    function cardHtml(m) {
      if (!m.card) return "";
      return '<div class="aic" data-card="' + m.seq + '"><p class="aic-no">' + escapeHtml(S.notShown) + '</p><p class="aic-sum">' + escapeHtml(m.card.summary || "") +
        '</p><div class="aic-box"></div><button type="button" class="aic-full" data-cardfull="' + m.seq + '" aria-label="' + escapeHtml(S.fullLabel) + '">' + escapeHtml(S.full) + "</button></div>";
    }
    // docs/web.md rule 3: each card's own box is watched, and only while its row is on the page.
    var near = window.IntersectionObserver ? new IntersectionObserver(function (list) {
      list.forEach(function (e) { if (e.isIntersecting && e.target.aicCard) load(e.target.aicCard); });
    }, { root: feed, rootMargin: NEAR }) : null;

    /** A card's frame: a ticket first; without one (409 not_shown, any error, no content domain) the summary stays. */
    function load(p) {
      if (p.started) return;
      p.started = true;
      if (!frameOpts) return fail(p);
      ctx.post("cards/" + p.seq + "/ticket", { theme: theme() }).then(function (t) {
        if (p.gone) return;
        frame(p, t.url);
      }, function () { fail(p); });
    }
    function frame(p, url) {
      var f = document.createElement("iframe");
      f.className = "aic-fr";
      f.setAttribute("sandbox", frameOpts.sandbox);
      f.setAttribute("referrerpolicy", "no-referrer");
      // Chrome holds every document of this frame to the policy (the content host agrees); others ignore it.
      if (frameOpts.csp) f.setAttribute("csp", frameOpts.csp);
      f.title = p.summary;
      f.src = url; // before it is in the page: no empty document loads first
      p.origin = new URL(url).origin;
      p.box.appendChild(f);
      p.frame = f;
      p.win = f.contentWindow;
      sources.set(p.win, p);
      p.timer = setTimeout(function () { if (!p.ready) fail(p); }, READY_MS);
    }
    function unload(p) {
      clearTimeout(p.timer);
      if (p.win) sources.delete(p.win);
      if (p.frame) p.frame.remove();
      p.frame = p.win = null;
    }
    function fail(p) {
      if (p.gone) return;
      unload(p);
      p.el.classList.add("failed");
      p.el.classList.remove("capped");
    }
    /** Its height as the frame measured it: at most half the screen in the feed, the bottom fading when that cuts it. */
    function fit(p) {
      if (!p.frame || !p.height) return;
      if (p.full) { p.frame.style.height = p.height + "px"; return; }
      var cap = Math.floor(window.innerHeight / 2), h = Math.min(p.height, cap);
      // A card above the screen that grows would push what the reader looks at down: keep that still.
      var r = p.box.getBoundingClientRect(), above = r.top < feed.getBoundingClientRect().top;
      p.frame.style.height = h + "px";
      p.el.classList.toggle("capped", p.height > cap);
      if (above) feed.scrollTop += h - r.height;
    }
    window.addEventListener("message", function (e) {
      var p = sources.get(e.source); // only a frame of ours, from the origin its ticket named
      if (!p || e.origin !== p.origin || !e.data) return;
      if (e.data.type === "scorpio:size" && e.data.height > 0) { p.height = Math.ceil(e.data.height); fit(p); }
      else if (e.data.type === "scorpio:ready") { p.ready = true; clearTimeout(p.timer); }
    });
    function each(fn) { places.forEach(fn); if (full) fn(full); }
    document.addEventListener("scorpio-theme", function () {
      var t = theme();
      each(function (p) { if (p.win) p.win.postMessage({ type: "scorpio:theme", theme: t }, p.origin); });
    });
    var refit = 0;
    window.addEventListener("resize", function () {
      cancelAnimationFrame(refit);
      refit = requestAnimationFrame(function () { places.forEach(fit); });
    });

    // ---------- full screen: a second frame with its own ticket, × top left; phone Back closes it ----------

    function openFull(seq) {
      var m = state.bySeq.get(seq);
      if (!m || !m.card) return;
      closeFull();
      if (!over) {
        over = document.createElement("div");
        over.className = "aic-over hidden";
        over.setAttribute("role", "dialog");
        over.setAttribute("aria-modal", "true");
        feed.parentNode.appendChild(over);
        over.addEventListener("click", function (e) {
          if (e.target === over || e.target.closest("[data-cardclose]")) closeFull();
        });
        window.scorpioRoomOverlays.register("aicard", function () { return !!full; }, closeFull, over);
      }
      over.setAttribute("aria-label", m.card.summary || "");
      over.innerHTML = '<div class="aic-sheet"><header class="aic-top"><button type="button" class="aic-x" data-cardclose aria-label="' + escapeHtml(S.closeFull) + '">×</button>' +
        '<span class="aic-av">' + ctx.avatar(m) + '</span><b class="aic-who">' + ctx.rowName(m.from, m.fromKind, m.displayName) + '</b><span class="aic-meta">#' + m.seq + " · " + escapeHtml(ctx.fmtTime(m.ts)) +
        '</span></header><div class="aic-scroll"><div class="aic full" data-card="' + m.seq + '"><p class="aic-no">' + escapeHtml(S.notShown) + '</p><p class="aic-sum">' +
        escapeHtml(m.card.summary || "") + '</p><div class="aic-box"></div></div></div></div>';
      var el = over.querySelector(".aic");
      full = { seq: seq, el: el, box: el.querySelector(".aic-box"), summary: m.card.summary || "", full: true };
      back = document.activeElement;
      over.classList.remove("hidden");
      over.querySelector(".aic-x").focus();
      load(full);
    }
    function closeFull() {
      if (!full) return;
      full.gone = true;
      unload(full);
      full = null;
      over.classList.add("hidden");
      over.innerHTML = "";
      if (back && back.focus && back.isConnected) back.focus();
      back = null;
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && full) { e.stopPropagation(); closeFull(); }
    });

    // ---------- rows coming and going ----------

    /** What no longer has a row on the page is let go: its observers, its frame and its timer. */
    var sweeping = false;
    function sweep() {
      sweeping = false;
      groups.forEach(function (g, seq) { if (!g.isConnected) { if (widths) widths.unobserve(g); groups.delete(seq); } });
      places.forEach(function (p, seq) { if (!p.el.isConnected) drop(p); });
    }
    function drop(p) {
      p.gone = true;
      if (near) near.unobserve(p.box);
      unload(p);
      if (places.get(p.seq) === p) places.delete(p.seq);
    }
    /**
     * A row was just drawn (not yet on the page). A row leaves the page in many ways (trimmed, drawn again, the window
     * moved, the @me pages dropped), so instead of a call from each, whatever watched a row that went is let go once the
     * rows being drawn are in place (they are drawn in batches, off the page until the batch goes in), each time a row
     * with buttons or a card is drawn: at most the window's rows are watched, plus those gone since.
     */
    function drawn(m, el) {
      if (!m.buttons && !m.card) return;
      if (!sweeping) { sweeping = true; queueMicrotask(sweep); }
      // Its row is being drawn again: the old one's group and frame are let go, and the new one loads its own frame.
      var old = places.get(m.seq), oldGroup = groups.get(m.seq);
      if (old) drop(old);
      if (oldGroup && widths) widths.unobserve(oldGroup);
      var g = m.buttons && el.querySelector(".aib");
      if (g) {
        groups.set(m.seq, g);
        if (widths) widths.observe(g);
      }
      var place = m.card && el.querySelector(".aic");
      if (place) {
        var p = { seq: m.seq, el: place, box: place.querySelector(".aic-box"), summary: m.card.summary || "" };
        p.box.aicCard = p;
        places.set(m.seq, p);
        if (near) near.observe(p.box);
        else load(p);
      }
    }

    ctx.rowHook("buttons", buttonsHtml);
    ctx.rowHook("card", cardHtml);
    ctx.rowHook("drawn", drawn);
    ctx.rowHook("buttonsChanged", buttonsChanged);
    feed.addEventListener("click", function (e) {
      var b = e.target.closest("[data-press]");
      if (b) return press(b);
      var f = e.target.closest("[data-cardfull]");
      if (f) return openFull(Number(f.dataset.cardfull));
    });
  };
})();
