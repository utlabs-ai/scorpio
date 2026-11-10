// An in-place filter. Only its sparse older pages live here; continuous history stays with room-feed.
(function () {
  "use strict";
  window.createRoomMentionFeed = function (ctx) {
    var button = ctx.button, feed = ctx.feed, rows = ctx.rows, state = ctx.state;
    var enabled = false, sparse = [], block = null, empty = null, more = true, loading = null, generation = 0;
    function label() {
      button.textContent = ctx.fill(ctx.S.mentionOnly, { n: state.mentionUnread });
      button.setAttribute('aria-pressed', String(enabled));
    }
    /** The rows shown: the sparse pages' own, then the window's rows for me as the feed tracks them (no walk of the page). */
    function visibleRows() {
      var own = block ? Array.prototype.filter.call(block.children, function (el) { return el.classList.contains('forme'); }) : [];
      return own.concat(rows.formeRows());
    }
    function sync() {
      if (empty) { empty.remove(); empty = null; }
      if (enabled && !visibleRows().length && !loading && !more) {
        empty = document.createElement('p');
        empty.className = 'empty mention-empty';
        empty.textContent = ctx.S.mentionOnlyEmpty;
        feed.appendChild(empty);
      }
      label();
    }
    function drop() {
      generation++;
      loading = null; more = true;
      rows.dropSparse(sparse);
      sparse = [];
      if (block) block.remove();
      block = null;
      if (empty) empty.remove();
      empty = null;
    }
    function loadEarlier() {
      if (!enabled) return Promise.resolve(false);
      if (loading) return loading;
      // Rows for me in memory above the window come first; the server's pages only once memory has none.
      if (rows.growUp()) { sync(); rows.refreshTop(); rows.updateJump(); return Promise.resolve(true); }
      if (!more) return Promise.resolve(false);
      var token = generation, a = rows.anchor(), visible = visibleRows();
      var before = visible.length ? '&before=' + visible[0].dataset.seq : '';
      loading = fetch('/r/' + ctx.roomId + '/mentions?limit=50&kind=human,agent,system,scheduled' + before,
        { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.next || ctx.S.searchError); return j; }); })
        .then(function (j) {
          if (token !== generation) return false;
          var got = (j.mentions || []).filter(function (m) { return !state.bySeq.has(m.seq); }).sort(function (a, b) { return a.seq - b.seq; });
          if (got.length) {
            if (!block) {
              block = document.createElement('div'); block.className = 'mention-older';
              var earlier = feed.querySelector('#earlier');
              feed.insertBefore(block, earlier ? earlier.nextSibling : feed.firstChild);
            }
            var frag = document.createDocumentFragment();
            rows.indexSparse(got);
            got.forEach(function (m) { frag.appendChild(rows.renderMessage(m)); });
            block.insertBefore(frag, block.firstChild);
            sparse = got.concat(sparse);
            rows.placeTimes();
          }
          more = !!j.hasMore;
          return got.length > 0;
        }, function (e) { if (token === generation) ctx.flash(e.message || ctx.S.searchError); return false; })
        .then(function (got) {
          if (token !== generation) return false;
          loading = null;
          sync(); rows.refreshTop(); rows.restore(a); rows.updateJump(); rows.maybeMark();
          return got;
        });
      rows.refreshTop();
      return loading;
    }
    function toggle(on, clicked) {
      var last = !on && !clicked && rows.nearBottom() && visibleRows().slice(-1)[0];
      var row = clicked || last;
      var a = row ? { seq: row.dataset.seq, off: row.getBoundingClientRect().top - feed.getBoundingClientRect().top } : rows.anchor(on);
      var wasSparse = a && sparse.some(function (m) { return m.seq === Number(a.seq); });
      enabled = on;
      feed.classList.toggle('only-me', enabled);
      if (!enabled) drop();
      rows.placeTimes(true); // other rows show: the times are placed for them
      sync(); rows.refreshTop();
      if (!enabled && wasSparse) ctx.jumpTo(Number(a.seq));
      else rows.restore(a);
      rows.updateJump(); rows.maybeMark();
      if (enabled && !visibleRows().length) return loadEarlier();
    }
    /** Off where the reader is, for a jump that then scrolls to its own target. */
    function off() {
      if (!enabled) return;
      enabled = false;
      feed.classList.toggle('only-me', false);
      drop(); rows.placeTimes(true); sync(); rows.refreshTop();
    }
    button.onclick = function () { return toggle(!enabled); };
    // Read the menu before room-feed dismisses it in document's capture listener.
    var menuAtClick = false;
    document.addEventListener('click', function () { menuAtClick = rows.menuOpen(); }, true);
    feed.addEventListener('click', function (e) {
      var selection = window.getSelection();
      if (!enabled || menuAtClick || rows.selecting() || (selection && !selection.isCollapsed) ||
          e.target.closest('a, button, input, textarea, img, .rc')) return;
      var row = e.target.closest('.msg[data-seq]');
      if (row) toggle(false, row);
    });
    label();
    return { active: function () { return enabled; }, loadEarlier: loadEarlier,
      hasMore: function () { return more; }, loading: function () { return !!loading; },
      sync: sync, label: label, reset: drop, off: off };
  };
})();
