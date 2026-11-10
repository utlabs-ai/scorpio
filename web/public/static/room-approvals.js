// The owner's approval cards. Server snapshots are the truth; folds, drafts and in-flight clicks stay on this page.
(function () {
  "use strict";
  window.createRoomApprovals = function (ctx) {
    var dock = ctx.dock, S = ctx.S, items = [], local = new Map(), keys = null, keyLoad = null;
    var target = new URLSearchParams(location.search).get("approval");
    function esc(value) { return ctx.escape(value == null ? "" : String(value)); }
    function ui(id) {
      if (!local.has(id)) local.set(id, { folded: false, draft: "", pending: null, error: "" });
      return local.get(id);
    }
    function closed(c) { return c.status !== "open" && c.status !== "answering"; }
    function failed(c) { return c.status === "answered" && c.result === "failed"; }
    function code(s, cls) { return '<pre class="' + (cls || 'apv-code') + '">' + esc(s) + '</pre>'; }
    // The daemon serializes tool_input and cuts it at 2000 characters, which can leave incomplete JSON.
    function detailInput(d) {
      if (typeof d.input === 'string') {
        try { return JSON.parse(d.input) || {}; } catch (e) { return d.input; }
      }
      return d.input || {};
    }
    function detail(d) {
      var i = detailInput(d), body = '';
      if (i.command != null) body = code(i.command);
      else if (i.file_path != null) {
        body = code(i.file_path);
        if (i.old_string != null) body += '<pre class="apv-code apv-diff"><span class="apv-del">- ' + esc(i.old_string) + '</span>\n<span class="apv-add">+ ' + esc(i.new_string == null ? '' : i.new_string) + '</span></pre>';
      } else if (i.url != null) body = code(i.url) + (i.prompt ? '<p class="apv-desc">' + esc(i.prompt) + '</p>' : '');
      else body = code(typeof i === 'string' ? i : JSON.stringify(i, null, 2));
      var desc = i.description || d.description;
      return '<div class="apv-detail"><span class="apv-tool">' + esc(d.tool) + '</span>' + body +
        (desc ? '<p class="apv-desc">' + esc(desc) + '</p>' : '') +
        (d.cwd ? '<p class="apv-cwd"><span>' + esc(S.cwd) + '</span> <code>' + esc(d.cwd) + '</code></p>' : '') + '</div>';
    }
    function summary(c) {
      var d = c.detail, i = d ? detailInput(d) : {};
      return d ? d.tool + ' · ' + (typeof i === 'string' ? i : i.command || i.file_path || i.url || '') : c.menu ? c.menu.question[0] : S.screenOnly;
    }
    function card(c) {
      var u = ui(c.id), busy = c.status === 'answering' || !!u.pending;
      var selected = c.answer || u.pending || {}, disabled = busy ? ' disabled' : '';
      var html = '<header class="apv-h">' + ctx.robot(c.name, '', 's24') + '<b class="apv-who">' + esc(c.name) + '</b><span class="apv-cli">' + (c.cli === 'claude' ? 'Claude Code' : 'Codex') + '</span>' +
        '<span class="apv-ago">' + esc(ctx.ago(c.opened_ms)) + '</span>' +
        '<button type="button" class="apv-fold" data-fold aria-expanded="' + !u.folded + '" aria-label="' + esc(u.folded ? S.unfold : S.fold) + '"><svg class="apv-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button></header>';
      if (u.folded) html += '<p class="apv-sum">' + esc(summary(c)) + '</p>';
      else {
        if (u.error) html += '<p class="apv-state offline" role="status">' + '<span class="apv-mk" aria-hidden="true">!</span>' + esc(u.error) + '</p>';
        if (c.detail) html += detail(c.detail);
        else if (c.screen && c.menu) html += code(c.screen, 'apv-screen');
        if (items.some(function (previous) { return failed(previous) && previous.name === c.name && previous.closed_ms <= c.opened_ms && c.opened_ms - previous.closed_ms <= 10000; })) {
          html += '<p class="apv-state retry" role="status"><span class="apv-mk" aria-hidden="true">!</span>' + esc(S.failed) + '</p>';
        }
        if (c.menu) {
          html += '<div class="apv-q">' + c.menu.question.map(function (q) { return '<p>' + esc(q) + '</p>'; }).join('') + '</div><div class="apv-opts">';
          c.menu.options.forEach(function (o, index) {
            var why = index === c.menu.options.length - 1 && /^No/.test(o.label);
            var b = '<button type="button" class="apv-o' + (selected.n === o.n ? ' on' : '') + '" data-n="' + o.n + '"' + disabled + '><span class="apv-n">' + o.n + '</span><span class="apv-l">' + esc(o.label) + (o.note ? '<small>' + esc(o.note) + '</small>' : '') + '</span></button>';
            html += why ? '<div class="apv-last">' + b + '<textarea class="apv-why" rows="1" maxlength="2000" aria-label="' + esc(c.cli === 'codex' ? S.whyCodex : S.why) + '" placeholder="' + esc(c.cli === 'codex' ? S.whyCodex : S.why) + '"' + disabled + '>' + esc(u.draft) + '</textarea></div>' : b;
          });
          html += '</div><p class="apv-hints">' + c.menu.hints.map(esc).join('<br>') + '</p>';
        } else {
          html += '<p class="apv-note">' + esc(S.screenOnly) + '</p>' + code(c.screen || '', 'apv-screen') + '<div class="apv-keys">' +
            (keys || []).map(function (k) { return '<button type="button" class="apv-k' + (selected.key === k.name ? ' on' : '') + '" data-key="' + esc(k.name) + '"' + disabled + '>' + esc(k.label) + '</button>'; }).join('') + '</div>';
        }
        if (busy) html += '<p class="apv-state sent" role="status"><span class="apv-spin" aria-hidden="true"></span>' + esc(S.sent) + '</p>';
      }
      return { html: html, cls: 'apv' + (u.folded ? ' folded' : '') };
    }
    function render() {
      var shown = items.filter(function (c) { return !closed(c); });
      Array.from(dock.children).forEach(function (el) { if (!shown.some(function (c) { return c.id === el.dataset.approval; })) el.remove(); });
      dock.hidden = !shown.length;
      shown.forEach(function (c, index) {
        var el = Array.from(dock.children).find(function (e) { return e.dataset.approval === c.id; });
        if (!el) { el = document.createElement('section'); el.dataset.approval = c.id; el.tabIndex = -1; }
        var rendered = card(c);
        el.className = rendered.cls;
        // Unchanged snapshots leave the person's focus, selection and internal scroll alone.
        if (el._html !== rendered.html) {
          var focused = el.contains(document.activeElement) && document.activeElement.classList.contains('apv-why');
          var start = focused && document.activeElement.selectionStart, end = focused && document.activeElement.selectionEnd;
          el.innerHTML = rendered.html; el._html = rendered.html;
          if (focused && el.querySelector('.apv-why')) { var field = el.querySelector('.apv-why'); field.focus({ preventScroll: true }); field.setSelectionRange(start, end); }
        }
        if (dock.children[index] !== el) dock.insertBefore(el, dock.children[index] || null);
        if (target === c.id) { ui(c.id).folded = false; el.scrollIntoView({ block: 'nearest' }); el.focus({ preventScroll: true }); target = null; }
      });
    }
    function loadKeys() {
      if (keys || keyLoad) return;
      keyLoad = fetch('/api/v1/config/keys').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) { keys = j.keys; render(); }, function (e) { ctx.flash(e.message); }).finally(function () { keyLoad = null; });
    }
    function snapshot(frame) {
      items = frame.items.slice().sort(function (a, b) { return a.opened_ms - b.opened_ms || a.id.localeCompare(b.id); });
      local.forEach(function (_, id) { if (!items.some(function (c) { return c.id === id; })) local.delete(id); });
      if (items.some(function (c) { return !c.menu && !closed(c); })) loadKeys();
      render();
      if (ctx.changed) ctx.changed();
    }
    function answer(c, body) {
      var u = ui(c.id);
      if (u.pending || c.status !== 'open') return;
      u.pending = body; u.error = ''; render();
      fetch('/rooms/' + encodeURIComponent(ctx.roomId) + '/approvals/' + encodeURIComponent(c.id) + '/answer', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body)
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); }).then(function (j) {
        if (items.indexOf(c) >= 0 && j.approval) items[items.indexOf(c)] = j.approval;
      }, function (e) {
        if (e.error === 'approval_not_found') items = items.filter(function (x) { return x.id !== c.id; });
        else if (e.error === 'already_answered' && e.approval) { var index = items.findIndex(function (x) { return x.id === c.id; }); if (index >= 0 && items[index] === c) items[index] = e.approval; }
        else u.error = e.error === 'host_offline' ? S.offline : e.next || ctx.errorText;
      }).finally(function () { u.pending = null; render(); });
    }
    dock.addEventListener('input', function (e) { if (e.target.classList.contains('apv-why')) ui(e.target.closest('[data-approval]').dataset.approval).draft = e.target.value; });
    dock.addEventListener('click', function (e) {
      var button = e.target.closest('button'); if (!button || button.disabled) return;
      var section = button.closest('[data-approval]'), c = items.find(function (x) { return x.id === section.dataset.approval; });
      if (!c) return;
      var u = ui(c.id);
      if (button.hasAttribute('data-fold')) { u.folded = !u.folded; render(); section.querySelector('[data-fold]').focus({ preventScroll: true }); return; }
      if (button.hasAttribute('data-key')) answer(c, { key: button.dataset.key });
      else if (button.hasAttribute('data-n')) {
        var n = Number(button.dataset.n), body = { n: n }, last = c.menu.options[c.menu.options.length - 1];
        if (n === last.n && /^No/.test(last.label) && u.draft) body.message = u.draft;
        answer(c, body);
      }
    });
    function focus(id) {
      if (!items.some(function (c) { return c.id === id; })) return;
      ui(id).folded = false; target = id; render();
    }
    document.addEventListener('click', function (e) {
      var button = e.target.closest('[data-approval-link]');
      if (!button) return;
      if (ctx.closePanel) ctx.closePanel();
      focus(button.dataset.approvalLink);
    });
    return { snapshot: snapshot, focus: focus, forAgent: function (name) {
      var card = items.find(function (c) { return c.name === name && !closed(c); });
      return card ? card.id : null;
    } };
  };
})();
