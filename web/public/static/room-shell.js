// The topic page status line. Each writer owns its notice and timer.
(function () {
  "use strict";

  window.createRoomShell = function (ctx) {
    var line = ctx.statusEl, notices = {}, order = 0, shown;

    function render() {
      var notice = notices.error && notices.undo
        ? (notices.error.order > notices.undo.order ? notices.error : notices.undo)
        : notices.error || notices.undo || notices.connection;
      if (notice === shown) return;
      shown = notice;
      if (!notice) { line.classList.add("hidden"); return; }
      if (notice.html) line.innerHTML = notice.content;
      else line.textContent = notice.content;
      line.classList.remove("hidden");
    }

    function clear(channel) {
      if (notices[channel] && notices[channel].timer) clearTimeout(notices[channel].timer);
      delete notices[channel];
      render();
    }

    function status(channel, content, options) {
      options = options || {};
      if (!content) return clear(channel);
      if (notices[channel] && notices[channel].timer) clearTimeout(notices[channel].timer);
      var notice = { content: content, html: !!options.html, order: ++order, timer: null };
      notices[channel] = notice;
      if (options.ms) notice.timer = setTimeout(function () {
        if (notices[channel] === notice) clear(channel);
      }, options.ms);
      render();
    }

    function panels(ctx) {
      var panel = ctx.panel, $ = ctx.$, S = ctx.S, escapeHtml = ctx.escapeHtml, roomSearch = ctx.roomSearch;
      var tabs = ["plan", "schedules", "members", "files", "memo"], entries = {}, refreshers = {};
      var panelHtml = "", sideHtml = "", currentSide = "plan", sideIsOpen = true;
      try { sideIsOpen = localStorage.getItem('scorpio.sideOpen') !== '0'; } catch (e) {}
      document.querySelector('.ui.desk').classList.toggle('side-closed', !sideIsOpen);

      function tab(kind, entry) { entries[kind] = entry; }
      function refresh(kind, fn) { refreshers[kind] = fn; }
      function kind() { return panel.dataset.kind; }
      function sideView() { return currentSide; }
      function sideOpen() { return sideIsOpen; }
      function isOpen() { return !panel.classList.contains('hidden'); }
      function label(tab) { return entries[tab].label(); }

      // Keep the selected phone tab visible while the close button keeps its place beside the scrolling strip.
      function fitTabs() {
        if (!window.matchMedia('(max-width: 760px)').matches || !isOpen()) return;
        var g = panel.querySelector('.sh .seg');
        if (!g) return;
        g.classList.toggle('over', g.scrollWidth > g.clientWidth + 1);
        var selected = g.querySelector('.on');
        if (selected) selected.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
      window.addEventListener('resize', fitTabs);

      function closePanel() {
        if (panel.dataset.kind === "search") roomSearch.closed();
        document.body.classList.remove('todo-sheet-open');
        panel.classList.add("hidden");
        $("panel-scrim").classList.add("hidden");
        $("panel-scrim").classList.remove("search-scrim");
        panel.classList.remove("sheet", "tall", "search-panel");
        panel.innerHTML = "";
        panel.dataset.kind = "";
      }

      function setSideOpen(open) {
        if (sideIsOpen === open) return;
        sideIsOpen = open;
        document.querySelector('.ui.desk').classList.toggle('side-closed', !open);
        try { localStorage.setItem('scorpio.sideOpen', open ? '1' : '0'); } catch (e) {}
        requestAnimationFrame(ctx.renderMain);
      }

      function renderSide(options) {
        if (options && options.force) sideHtml = '';
        var side = $("desktop-side");
        if (!side) return;
        var entry = entries[currentSide];
        var h = '<header class="sh"><div class="seg">' + tabs.map(function (t) {
          return '<button type="button" data-side="' + t + '" class="' + (currentSide === t ? 'on' : '') + '">' + label(t) + '</button>';
        }).join('') + '</div><span class="sp"></span>' +
          '<button type="button" class="x" data-side-close aria-label="' + S.sideClose + '">×</button></header><div class="sbody' + (entry.long ? ' long' : '') + '">' + entry.html() + '</div>';
        if (h === sideHtml) return;
        var scroll = side.querySelector('.scroll'), top = scroll ? scroll.scrollTop : 0;
        var token = entry.before ? entry.before(side) : undefined;
        sideHtml = h;
        side.innerHTML = h;
        scroll = side.querySelector('.scroll');
        if (scroll) scroll.scrollTop = top;
        if (entry.after) entry.after(side, token);
        side.querySelectorAll('[data-flex]').forEach(function (el) { el.style.flexGrow = Math.max(0, Number(el.dataset.flex) || 0); });
        ctx.renderMain();
      }

      function openPanel(target, initialSearch) {
        if (target === 'wait') target = 'plan';
        if (target === 'search') {
          if (panel.dataset.kind === 'search' && !panel.classList.contains('hidden')) return;
          closePanel();
          panel.dataset.kind = 'search';
          panel.classList.add('sheet', 'tall', 'search-panel');
          panel.classList.remove('hidden');
          $('panel-scrim').classList.add('search-scrim');
          $('panel-scrim').classList.remove('hidden');
          roomSearch.open(initialSearch);
          return;
        }
        if (panel.dataset.kind === 'search') {
          roomSearch.closed();
          panel.classList.remove('search-panel');
          $('panel-scrim').classList.remove('search-scrim');
        }
        var entry = entries[target];
        if (window.matchMedia('(min-width: 761px)').matches && entry.side) {
          var firstSideOpen = !!entry.firstOpen && (currentSide !== target || !sideIsOpen);
          currentSide = target;
          sideHtml = '';
          setSideOpen(true);
          renderSide();
          closePanel();
          if (firstSideOpen) entry.firstOpen();
          return;
        }
        var firstSheetOpen = !!entry.firstOpen && (panel.dataset.kind !== target || panel.classList.contains('hidden'));
        var fresh = !!entry.opened && panel.dataset.kind !== target;
        var oldScroll = panel.querySelector('.scroll'), keepTop = panel.dataset.kind === target && oldScroll ? oldScroll.scrollTop : 0;
        var head = '<div class="grab"></div><header class="sh"><div class="seg">' + tabs.map(function (t) {
          return '<button type="button" class="' + (t === target ? 'on' : '') + '" data-tab="' + t + '">' + label(t) + '</button>';
        }).join('') + '</div><span class="sp"></span><button type="button" class="x" data-close aria-label="' + escapeHtml(S.cancel) + '">×</button></header>';
        var body = '<div class="sbody' + (entry.long ? ' long' : '') + '">' + entry.html() + '</div>';
        if (panel.dataset.kind === target && panelHtml === head + body && !panel.classList.contains('hidden')) { fitTabs(); return; }
        var before = panel.dataset.kind === target && entry.panelBefore ? entry.panelBefore(panel) : undefined;
        var token = entry.before ? entry.before(panel) : undefined;
        panel.dataset.kind = target;
        panelHtml = head + body;
        panel.innerHTML = head + body;
        panel.classList.add('sheet', 'tall');
        if (entry.panelAfter) entry.panelAfter(panel, before);
        panel.classList.remove('hidden');
        $('panel-scrim').classList.remove('hidden');
        document.body.classList.toggle('todo-sheet-open', target === 'plan' && window.matchMedia('(max-width: 760px)').matches);
        var scroll = panel.querySelector('.scroll');
        if (scroll) scroll.scrollTop = keepTop;
        panel.querySelectorAll('[data-flex]').forEach(function (el) { el.style.flexGrow = Math.max(0, Number(el.dataset.flex) || 0); });
        if (fresh) entry.opened();
        if (entry.after) entry.after(panel, token);
        if (firstSheetOpen) entry.firstOpen();
        fitTabs();
      }

      function togglePanel(target) {
        if (window.matchMedia('(min-width: 761px)').matches && entries[target].side && sideIsOpen && currentSide === target) {
          setSideOpen(false);
          return;
        }
        if (panel.dataset.kind === target) return closePanel();
        openPanel(target);
      }

      function refreshPanel() {
        var current = panel.dataset.kind;
        if (refreshers[current]) return refreshers[current]();
        if (entries[current]) openPanel(current);
      }

      return { tab: tab, refresh: refresh, kind: kind, sideView: sideView, sideOpen: sideOpen, isOpen: isOpen,
        closePanel: closePanel, setSideOpen: setSideOpen, renderSide: renderSide, openPanel: openPanel,
        togglePanel: togglePanel, refreshPanel: refreshPanel };
    }

    return { status: status, clear: clear, panels: panels };
  };
})();
