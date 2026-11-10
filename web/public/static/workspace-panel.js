(function () {
  'use strict';
  window.createWorkspacePanel = function (ctx) {
    var entry = document.getElementById('btn-workspace'), root = null, panel = null, frame = null, instanceId = null, computerId = null, openLink = null, previousFocus = null, inert = [], revoked = false;
    var width = null, dragging = null;
    var media = window.matchMedia('(min-width:761px)');
    function bounds() { var max = Math.max(0, window.innerWidth - 120); return { min: Math.min(880, max), max: max, draggable: max >= 880 }; }
    function clamp(value) { var b = bounds(); return Math.min(b.max, Math.max(b.min, value)); }
    function size() {
      if (!panel) return;
      width = clamp(width == null ? window.innerWidth * .75 : width); panel.style.width = width + 'px';
      panel.classList.toggle('wvp-fixed-width', !bounds().draggable);
    }
    function message() { if (frame && instanceId) frame.contentWindow.postMessage({ version: 1, type: 'init', instanceId: instanceId, theme: document.documentElement.dataset.scorpioEffectiveTheme === 'dark' ? 'dark' : 'light' }, location.origin); }
    function close() {
      if (!root) return;
      window.removeEventListener('resize', size); document.removeEventListener('keydown', key, true); document.removeEventListener('scorpio-theme', message);
      root.remove(); root = panel = frame = openLink = null; instanceId = computerId = null;
      document.documentElement.classList.remove('wvp-open');
      inert.forEach(function (record) { record.element.inert = record.value; }); inert = [];
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      if (revoked) {
        entry.hidden = true; revoked = false;
        fetch('/r/' + encodeURIComponent(ctx.roomId) + '/workspace/hosts', { credentials: 'same-origin', cache: 'no-store' })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (value) { entry.hidden = !(value && value.computers && value.computers.length); }).catch(function () {});
      }
    }
    function key(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } }
    function open() {
      if (root || entry.hidden || !media.matches) return;
      previousFocus = document.activeElement; instanceId = crypto.randomUUID();
      try { var saved = Number(localStorage.getItem('workspace-panel-width-v1')); width = Number.isFinite(saved) && saved > 0 ? saved : null; } catch (e) { width = null; }
      root = document.createElement('div'); root.className = 'wvp-root';
      var scrim = document.createElement('div'); scrim.className = 'wvp-scrim'; root.append(scrim);
      panel = document.createElement('section'); panel.className = 'wvp-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', ctx.strings.title);
      frame = document.createElement('iframe'); frame.title = ctx.strings.title; frame.sandbox = 'allow-scripts allow-same-origin'; frame.src = '/r/' + encodeURIComponent(ctx.roomId) + '/workspace?embed=1'; frame.addEventListener('load', message); panel.append(frame);
      var controls = document.createElement('div'); controls.className = 'wvp-controls';
      openLink = document.createElement('a'); openLink.className = 'wvp-tab'; openLink.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2 7 9M6 3H2v11h11v-4"/></svg>'; openLink.append(document.createTextNode(ctx.strings.openTab)); openLink.target = '_blank'; openLink.rel = 'noopener noreferrer'; openLink.setAttribute('aria-disabled', 'true'); openLink.tabIndex = -1;
      openLink.addEventListener('click', function (event) { if (!computerId) event.preventDefault(); });
      var exit = document.createElement('button'); exit.className = 'wvp-close'; exit.type = 'button'; exit.textContent = '×'; exit.setAttribute('aria-label', ctx.strings.close); exit.addEventListener('click', close);
      controls.append(openLink, exit); panel.append(controls);
      var handle = document.createElement('button'); handle.className = 'wvp-handle'; handle.type = 'button'; handle.setAttribute('aria-label', ctx.strings.title); handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
      handle.addEventListener('pointerdown', function (event) { if (!bounds().draggable) return; dragging = { id: event.pointerId, x: event.clientX, width: width }; handle.setPointerCapture(event.pointerId); panel.classList.add('wvp-dragging'); event.preventDefault(); });
      handle.addEventListener('pointermove', function (event) { if (dragging && dragging.id === event.pointerId) { width = clamp(dragging.width + dragging.x - event.clientX); size(); } });
      function end(event) { if (!dragging || dragging.id !== event.pointerId) return; dragging = null; panel.classList.remove('wvp-dragging'); try { localStorage.setItem('workspace-panel-width-v1', String(width)); } catch (e) {} }
      handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      handle.addEventListener('keydown', function (event) { if (!bounds().draggable || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); width = clamp(width + (event.key === 'ArrowLeft' ? 40 : -40)); size(); try { localStorage.setItem('workspace-panel-width-v1', String(width)); } catch (e) {} });
      panel.append(handle); root.append(panel);
      Array.from(document.body.children).forEach(function (element) { inert.push({ element: element, value: element.inert }); element.inert = true; });
      document.body.append(root); document.documentElement.classList.add('wvp-open'); size();
      document.addEventListener('keydown', key, true); document.addEventListener('scorpio-theme', message); window.addEventListener('resize', size); exit.focus({ preventScroll: true });
    }
    window.addEventListener('message', function (event) {
      if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.version !== 1 || event.data.instanceId !== instanceId) return;
      if (event.data.type === 'close') close();
      else if (event.data.type === 'revoked') { revoked = true; computerId = null; openLink.remove(); }
      else if (event.data.type === 'computer' && typeof event.data.computerId === 'string' && event.data.computerId.length > 0 && event.data.computerId.length <= 256) {
        computerId = event.data.computerId; openLink.href = '/r/' + encodeURIComponent(ctx.roomId) + '/workspace?computer=' + encodeURIComponent(computerId); openLink.removeAttribute('aria-disabled'); openLink.tabIndex = 0;
      }
    });
    entry?.addEventListener('click', open);
    return { members: function (members, member) { if (entry) entry.hidden = member === false || !(members || []).some(function (m) { return m.kind === 'host' && m.owner === ctx.me && m.status === 'active'; }); }, close: close };
  };
})();
