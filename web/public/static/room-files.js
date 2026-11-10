(function () {
  "use strict";

  window.createRoomFiles = function (ctx) {
    "use strict";
    var $ = ctx.$, GO_DOWN = ctx.GO_DOWN, GO_PAGE = ctx.GO_PAGE, S = ctx.S, boot = ctx.boot, clock = ctx.clock, closePanel = ctx.closePanel, dayText = ctx.dayText, extOf = ctx.extOf, fileLinkAttrs = ctx.fileLinkAttrs, fill = ctx.fill, jumpTo = ctx.jumpTo, openPanel = ctx.openPanel, panel = ctx.panel, panels = ctx.panels, picAttrs = ctx.picAttrs, rowName = ctx.rowName, sizeText = ctx.sizeText;

    // ---------- the panel's third tab, 附件: the topic's attachments ----------

    /**
     * Files | Pictures, a filter by name, and for each kind the rows the server listed so far: newest message first, within
     * a message in its own order. No numbers anywhere: the counts only tell an empty topic, and how many went.
     */
    var FL = { seg: "files", q: "", lists: {}, counts: null, gen: 0, busy: false, failed: "", timer: null, live: null };
    var FL_PAGE = { files: 50, pics: 30 };
    var FL_DOC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>';
    /** The filter as the search reads it: one Chinese character or two other characters, else everything. */
    function flQuery() {
      var compact = FL.q.trim().replace(/\s/g, "");
      return /\p{Script=Han}/u.test(compact) || Array.from(compact).length >= 2 ? FL.q.trim().replace(/\s+/g, " ") : "";
    }
    function flShown() {
      if (window.matchMedia('(min-width: 761px)').matches) return panels.sideOpen() && panels.sideView() === 'files';
      return panels.kind() === 'files' && panels.isOpen();
    }
    /** One page of the kind on screen: the first (fresh), or the one after its last row. A newer fresh one wins. */
    function flLoad(fresh) {
      var seg = FL.seg, list = FL.lists[seg];
      if (!fresh && (FL.busy || !list || !list.more)) return;
      var gen = fresh ? ++FL.gen : FL.gen, q = flQuery();
      var params = new URLSearchParams({ kind: seg, limit: String(FL_PAGE[seg]) });
      if (q) params.set("q", q);
      var last = !fresh && list.rows[list.rows.length - 1];
      if (last) { params.set("before", String(last.seq)); params.set("beforeId", last.id); }
      FL.busy = true;
      fetch("/r/" + boot.roomId + "/files?" + params, { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.next || S.searchError); return j; }); })
        .then(function (j) {
          if (gen !== FL.gen) return;
          FL.counts = j.counts || FL.counts;
          FL.lists[seg] = { rows: (fresh ? [] : FL.lists[seg].rows).concat(j.files || []), more: !!j.hasMore, q: q };
          FL.failed = "";
        }, function (e) { if (gen === FL.gen) FL.failed = e.message || S.searchError; })
        .then(function () { if (gen === FL.gen) { FL.busy = false; flRedraw(); } });
    }
    function flRedraw() {
      if (!flShown()) return;
      if (window.matchMedia('(min-width: 761px)').matches) panels.renderSide({ force: true }); else openPanel('files');
    }
    /** A file came or went: the first page again, a second after the last of a burst, while the tab is on screen. */
    function flLive() {
      if (!FL.lists.files && !FL.lists.pics) return;
      if (!flShown()) { FL.lists = {}; return; }
      clearTimeout(FL.live);
      FL.live = setTimeout(function () { var keep = FL.lists[FL.seg]; FL.lists = {}; FL.lists[FL.seg] = keep; FL.failed = ""; flLoad(true); }, 1000);
    }
    function flDay(ts) {
      var d = new Date(ts), now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      if (d.toDateString() === now.toDateString()) return S.filesToday;
      if (d.toDateString() === y.toDateString()) return S.filesYesterday;
      return dayText(ts);
    }
    /** The filter's words marked in a name, as the search marks its hits. */
    function flMark(name) {
      var q = flQuery(), text = String(name || ""), low = text.toLocaleLowerCase();
      var terms = q ? q.split(" ").sort(function (a, b) { return b.length - a.length; }) : [];
      var out = "", pos = 0;
      while (pos < text.length) {
        var at = -1, len = 0;
        terms.forEach(function (term) { var i = low.indexOf(term.toLocaleLowerCase(), pos); if (i >= 0 && (at < 0 || i < at)) { at = i; len = term.length; } });
        if (at < 0) return out + escapeHtml(text.slice(pos));
        out += escapeHtml(text.slice(pos, at)) + "<mark>" + escapeHtml(text.slice(at, at + len)) + "</mark>";
        pos = at + len;
      }
      return out;
    }
    /** A file: badge · name · ↗ / ↓, then size · who · time · #n. The row opens it as in its message; #n goes to the message. */
    function flRow(f) {
      var attrs = fileLinkAttrs(f).replace(' class="view"', '').replace(/ title="[^"]*"/, ' title="' + escapeHtml(f.name) + '"');
      return '<li class="fl-r"><span class="ext">' + escapeHtml(extOf(f.name) || 'FILE') + '</span>' +
        '<a class="fl-nm' + (f.view ? ' view' : '') + '"' + attrs + ' data-full="' + escapeHtml(f.name) + '">' + flMark(f.name) + '</a>' + (f.view ? GO_PAGE : GO_DOWN) +
        '<div class="fl-meta"><span>' + sizeText(Math.max(f.size || 0, 1024)) + '</span><i>·</i><span class="fl-who">' + rowName(f.from, String(f.from).indexOf('@') < 0 ? 'human' : 'agent', f.displayName) +
        '</span><i>·</i><time>' + clock(f.ts) + '</time><i>·</i><button type="button" class="fl-ref" data-fl-jump="' + f.seq + '">#' + f.seq + '</button></div></li>';
    }
    function flPic(f) {
      return '<a' + picAttrs(f) + ' title="' + escapeHtml(f.name) + '"><img src="' + escapeHtml(f.url) + '" alt="' + escapeHtml(f.name) + '" loading="lazy"></a>';
    }
    function flHtml() {
      var c = FL.counts, list = FL.lists[FL.seg];
      if (c && !c.files && !c.pics) return '<div class="scroll fl-scroll"><div class="fl-empty">' + FL_DOC + '<p>' + escapeHtml(S.filesEmpty) + '</p></div></div>';
      var bar = '<div class="fl-bar"><div class="seg sm fl-seg">' + [["files", S.filesSegFiles], ["pics", S.filesSegPics]].map(function (x) {
        return '<button type="button" class="' + (FL.seg === x[0] ? 'on' : '') + '" data-fl-seg="' + x[0] + '">' + escapeHtml(x[1]) + '</button>';
      }).join('') + '</div><label class="searchfield fl-q"><span aria-hidden="true">⌕</span><input class="fl-input" type="search" maxlength="200" autocomplete="off" placeholder="' +
        escapeHtml(S.filesFilter) + '" aria-label="' + escapeHtml(S.filesFilter) + '" value="' + escapeHtml(FL.q) + '"></label></div>';
      if (!list) return bar + '<div class="scroll fl-scroll"><p class="fl-none">' + escapeHtml(FL.failed || S.searchLoading) + '</p></div>';
      if (!list.rows.length) return bar + '<div class="scroll fl-scroll"><p class="fl-none">' + escapeHtml(list.q ? S.filesNoMatch : FL.seg === 'pics' ? S.filesNoPics : S.filesNoFiles) + '</p>' + (list.q ? '' : flGone()) + '</div>';
      var groups = [], last = null;
      list.rows.forEach(function (f) { var d = flDay(f.ts); if (d !== last) { groups.push({ d: d, xs: [] }); last = d; } groups[groups.length - 1].xs.push(f); });
      // the pictures of every day in one .pics: the image viewer pages through all of them, across days
      var pics = FL.seg === 'pics';
      return bar + '<div class="scroll fl-scroll">' + (pics ? '<div class="pics fl-pics">' : '') + groups.map(function (g) {
        return '<section class="fl-g"><h3 class="fl-day">' + escapeHtml(g.d) + '</h3>' + (pics
          ? '<div class="fl-grid">' + g.xs.map(flPic).join('') + '</div>'
          : '<ul class="fl-list">' + g.xs.map(flRow).join('') + '</ul>') + '</section>';
      }).join('') + (pics ? '</div>' : '') + (list.more ? '<p class="fl-none fl-next">' + escapeHtml(FL.failed || S.searchLoading) + '</p>' : flGone()) + '</div>';
    }
    /** At the end of the list: how many went when uploaders' space was full; nothing when none. */
    function flGone() {
      return FL.counts && FL.counts.gone ? '<p class="fl-gone">' + escapeHtml(fill(S.filesGone, { n: FL.counts.gone })) + '</p>' : '';
    }
    /** The filter box being typed in, so a redraw gives it back its caret. */
    function flTyping() {
      var a = document.activeElement;
      return a && a.classList && a.classList.contains('fl-input') ? { from: a.selectionStart, to: a.selectionEnd } : null;
    }
    /** After the tab is drawn: names fitted, the caret back, the first page fetched, the next one when the list is short. */
    function flAfter(root, typing) {
      flFit(root);
      if (typing) { var i = root.querySelector('.fl-input'); if (i) { i.focus(); try { i.setSelectionRange(typing.from, typing.to); } catch (e) {} } }
      if (FL.failed || FL.busy) return; // a failed page waits for a click, a key or a new file: no loop of retries
      if (!FL.lists[FL.seg]) return flLoad(true);
      var sc = root.querySelector('.fl-scroll'), list = FL.lists[FL.seg];
      if (sc && list && list.more && sc.scrollHeight <= sc.clientHeight + 240) flLoad(false);
    }
    /**
     * Two lines at most; a name too long for them loses its middle and keeps its end, from the version (-v3…) through
     * the extension (14 to 28 characters). Measured unclamped, the start found by halving; remembered per name and width.
     */
    var flFitted = {};
    function flFit(root) {
      if (!root) return;
      root.querySelectorAll('.fl-nm[data-full]').forEach(function (el) {
        var full = el.getAttribute('data-full'), w = el.clientWidth;
        if (!w) return;
        var key = w + '|' + full, fitted = flFitted[key];
        if (fitted === undefined) {
          el.classList.add('fl-measure');
          var lh = parseFloat(getComputedStyle(el).lineHeight), fits = function (s) { el.textContent = s; return el.getBoundingClientRect().height <= 2 * lh + 1; };
          if (!lh || fits(full)) fitted = null;
          else {
            var vm = /[-_.]v\d+[^/]*$/i.exec(full), tl = vm ? full.length - vm.index - 1 : 0, tail = full.slice(-Math.max(14, Math.min(tl, 28)));
            var lo = 0, hi = full.length - tail.length;
            while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (fits(full.slice(0, mid) + '…' + tail)) lo = mid; else hi = mid - 1; }
            fitted = full.slice(0, lo) + '…' + tail;
          }
          el.classList.remove('fl-measure');
          flFitted[key] = fitted;
        }
        el.innerHTML = flMark(fitted || full);
      });
    }
    function flRoot() { return window.matchMedia('(min-width: 761px)').matches ? $("desktop-side") : panel; }
    // the filter: 300 ms after the last key, a new first page for both kinds
    document.addEventListener('input', function (e) {
      if (!e.target.classList || !e.target.classList.contains('fl-input')) return;
      FL.q = e.target.value;
      FL.failed = "";
      clearTimeout(FL.timer);
      FL.timer = setTimeout(function () {
        var list = FL.lists[FL.seg];
        if (list && list.q === flQuery()) return;
        FL.lists = {};
        flLoad(true);
      }, 300);
    });
    // near the end of the list: the next page
    document.addEventListener('scroll', function (e) {
      var el = e.target, list = FL.lists[FL.seg];
      if (!el.classList || !el.classList.contains('fl-scroll') || !list || !list.more || FL.busy) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) flLoad(false);
    }, true);
    // a wider or narrower panel, and the font once loaded: the names fitted again
    var flResize = null;
    window.addEventListener('resize', function () { clearTimeout(flResize); flResize = setTimeout(function () { if (flShown()) flFit(flRoot()); }, 150); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (flShown()) flFit(flRoot()); });
    /** A click in the tab: Files | Pictures, or #n (to the message: a phone's sheet goes first, a computer's panel stays). */
    function flClick(e) {
      var seg = e.target.closest('[data-fl-seg]');
      if (seg) { FL.seg = seg.dataset.flSeg; FL.failed = ""; flRedraw(); return true; }
      var ref = e.target.closest('[data-fl-jump]');
      if (ref) {
        e.preventDefault();
        if (!window.matchMedia('(min-width: 761px)').matches) closePanel();
        jumpTo(Number(ref.dataset.flJump));
        return true;
      }
      return false;
    }

    panels.tab('files', { html: flHtml, label: function () { return escapeHtml(S.filesTab); }, side: true, long: true, before: flTyping, after: flAfter });
    return {
      flAfter: flAfter,
      flClick: flClick,
      flHtml: flHtml,
      flLive: flLive,
      flTyping: flTyping,
    };
  };
})();
