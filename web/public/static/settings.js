// Settings controls: local appearance, account name, and CSSOM usage bars.
(function () {
  "use strict";
  var themeButtons = Array.from(document.querySelectorAll('[data-theme-choice]'));
  function updateTheme() {
    var mode = document.documentElement.dataset.scorpioTheme || 'system';
    themeButtons.forEach(function (button) {
      var on = button.dataset.themeChoice === mode;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }
  themeButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (window.scorpioThemeSet) window.scorpioThemeSet(button.dataset.themeChoice);
      updateTheme();
    });
  });
  document.addEventListener('scorpio-theme', updateTheme);
  updateTheme();
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    var sound = document.querySelector('[data-push-pref="sound"]');
    if (sound) sound.closest('li.row').classList.add('hidden');
    document.querySelector('.sound-note').classList.remove('hidden');
  }

  document.querySelectorAll('.plan .pb b[data-pct]').forEach(function (bar) {
    bar.style.width = Math.max(0, Math.min(100, Number(bar.dataset.pct) || 0)) + '%';
  });
  // 邀请朋友 — the link is copied; a code is entered within 7 days of signing up (POST /settings/invite-code).
  var zh = document.documentElement.lang === 'zh-CN';
  var S = JSON.parse(document.getElementById("boot").textContent).S;
  document.querySelectorAll('[data-copy-invite]').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.dataset.copyInvite, label = button.textContent;
      var done = function () { button.textContent = button.dataset.done; setTimeout(function () { button.textContent = label; }, 1500); };
      // as room.js copies: the clipboard API where it is allowed, else a selected textarea
      var fallback = function () { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
  });
  // 日历订阅 (Settings → 通知): the address and the CalDAV account are made when the row is first opened (POST /settings/calendar), never for someone who leaves it closed.
  var calendar = document.getElementById('calendar-setting');
  if (calendar) {
    var calUrl = document.getElementById('calendar-url'), calAdd = document.getElementById('calendar-add');
    var calReset = document.getElementById('calendar-reset'), calResult = document.getElementById('calendar-result');
    var calCopies = Array.from(calendar.querySelectorAll('button[data-copy-of]'));
    var calLoaded = false;
    var showCalendar = function (body) {
      calUrl.value = body.url;
      calAdd.href = body.url.replace(/^https?:/, 'webcal:');
      calAdd.removeAttribute('aria-disabled');
      ['server', 'account', 'password'].forEach(function (k) { document.getElementById('caldav-' + k).value = body.caldav[k]; });
      calCopies.forEach(function (button) { button.disabled = false; });
      calReset.disabled = false;
    };
    var calPost = function (path) {
      return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' })
        .then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); });
    };
    var calError = function (error) { calResult.textContent = (error && (error.next || error.message)) || String(error); };
    calendar.addEventListener('toggle', function () {
      if (!calendar.open || calLoaded) return;
      calLoaded = true;
      calPost('/settings/calendar').then(showCalendar, function (error) { calLoaded = false; calError(error); });
    });
    // one handler for the four copy buttons: each copies the field data-copy-of names
    calCopies.forEach(function (button) {
      button.addEventListener('click', function () {
        var field = document.getElementById(button.dataset.copyOf), text = field.value, label = button.textContent;
        var done = function () { button.textContent = button.dataset.done; setTimeout(function () { button.textContent = label; }, 1500); };
        var fallback = function () { field.select(); document.execCommand('copy'); done(); };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
        else fallback();
      });
    });
    calReset.addEventListener('click', function () {
      calReset.disabled = true; calResult.textContent = '';
      calPost('/settings/calendar/reset').then(function (body) { showCalendar(body); calResult.textContent = calReset.dataset.done; }, calError)
        .finally(function () { calReset.disabled = false; });
    });
  }
  var permChoices = Array.from(document.querySelectorAll('input[name="spawn-perm"]'));
  var savedPerm = (permChoices.find(function (input) { return input.checked; }) || {}).value;
  permChoices.forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.checked) return;
      var result = document.getElementById('spawn-perm-result');
      permChoices.forEach(function (choice) { choice.disabled = true; });
      result.hidden = true;
      fetch('/settings/spawn-perm', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ perm: input.value }),
      }).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); })
        .then(function (body) {
          savedPerm = body.perm;
          result.textContent = S.setSpawnPermSaved;
          result.classList.remove('err');
          result.classList.add('ok');
        }, function () {
          result.textContent = S.setSpawnPermFailed;
          result.classList.remove('ok');
          result.classList.add('err');
        }).then(function () {
          permChoices.forEach(function (choice) { choice.checked = choice.value === savedPerm; choice.disabled = false; });
          result.hidden = false;
        });
    });
  });
  var codeForm = document.getElementById('invite-code-form');
  if (codeForm) codeForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = codeForm.querySelector('button'), result = document.getElementById('invite-code-result');
    // a code works once, and only while its sender has invites left this month
    var why = S.settingsInviteWhy;
    button.disabled = true;
    fetch('/settings/invite-code', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: codeForm.elements.code.value.trim() }),
    }).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); })
      .then(function (body) {
        // the row turns into what it is once filled: who invited you, nothing to open, no extra sentence
        var by = (body && body.invite && body.invite.invitedBy) || codeForm.elements.code.value.trim().toUpperCase();
        var row = document.createElement('span');
        row.className = 't';
        row.id = 'invited-by';
        row.textContent = codeForm.dataset.by.replace('{name}', by);
        document.getElementById('invite-code-setting').replaceWith(row);
      }, function (error) {
        result.textContent = why[error && error.error] || (error && (error.next || error.message)) || String(error);
        result.classList.add('err'); // red, so it does not read as the hint it replaced
        button.disabled = false;
      });
  });
  var trialForm = document.getElementById('trial-code-form');
  if (trialForm) {
    var trial = new URLSearchParams(window.location.search).get('trial');
    if (trial !== null) {
      document.getElementById('trial-code-setting').open = true;
      trialForm.elements.code.value = trial;
      document.getElementById('trial-code').scrollIntoView({ block: 'center' });
    }
    trialForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = trialForm.querySelector('button'), result = document.getElementById('trial-code-result');
      button.disabled = true;
      fetch('/settings/trial-code', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code: trialForm.elements.code.value.trim() }),
      }).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); })
        .then(function (body) {
          var message;
          if (body.until) {
            var date = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(body.until);
            message = zh ? '已兑换 ' + body.days + ' 天 Pro，Pro 到 ' + date : body.days + ' days of Pro redeemed; Pro until ' + date;
          } else if (body.startsNow) message = zh ? '已兑换 ' + body.days + ' 天 Pro，今天开始' : body.days + ' days of Pro redeemed, starting today';
          else message = zh ? '已兑换 ' + body.days + ' 天 Pro，当前 Pro 到期后开始' : body.days + ' days of Pro redeemed, starting when your current Pro ends';
          var row = document.createElement('span'); row.className = 't'; row.id = 'trial-code-success'; row.textContent = message;
          document.getElementById('trial-code-setting').replaceWith(row);
        }, function (error) {
          result.textContent = (error && (error.next || error.message)) || String(error);
          result.classList.add('err'); button.disabled = false;
        });
    });
  }
  // 「交接只存在 agent 的电脑上」: POST /settings/handoff; the switch shows what the server stored.
  var handoff = document.getElementById('handoff-local');
  if (handoff) handoff.addEventListener('click', function () {
    var on = handoff.getAttribute('aria-pressed') !== 'true';
    handoff.disabled = true;
    fetch('/settings/handoff', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ local: on }),
    }).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); })
      .then(function (body) {
        handoff.setAttribute('aria-pressed', String(!!body.local));
        handoff.querySelector('.sw').classList.toggle('on', !!body.local);
      }, function () {})
      .then(function () { handoff.disabled = false; });
  });
  // Automatically bring my own left agents back: POST /settings/call-back; the switch shows what the server stored.
  var callBack = document.getElementById('auto-call-back');
  if (callBack) callBack.addEventListener('click', function () {
    var on = callBack.getAttribute('aria-pressed') !== 'true';
    callBack.disabled = true;
    fetch('/settings/call-back', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ on: on }),
    }).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); })
      .then(function (body) {
        callBack.setAttribute('aria-pressed', String(!!body.on));
        callBack.querySelector('.sw').classList.toggle('on', !!body.on);
      }, function () {})
      .then(function () { callBack.disabled = false; });
  });
  // Revoking a computer asks first: the agents on it keep working but are cut off from every topic.
  document.querySelectorAll('form[data-confirm-revoke]').forEach(function (revoke) {
    revoke.addEventListener('submit', function (event) {
      event.preventDefault(); // form.submit() below does not come back through here
      var back = document.activeElement, d = document.createElement('div');
      d.className = 'dialog';
      d.innerHTML = '<div class="box" role="alertdialog" aria-modal="true"><h3 class="dialog-title"></h3><p class="q"></p><div class="btns">' +
        '<button type="button" class="btn" data-dlg="0"></button><button type="button" class="btn dangerfill" data-dlg="1"></button></div></div>';
      d.querySelector('.dialog-title').textContent = S.revokeTitle;
      d.querySelector('.q').textContent = S.revokeBody;
      d.querySelector('[data-dlg="0"]').textContent = S.cancel;
      d.querySelector('[data-dlg="1"]').textContent = S.revokeOk;
      function done(yes) {
        document.removeEventListener('keydown', key, true);
        d.remove();
        if (yes) revoke.submit(); else if (back && back.focus) back.focus();
      }
      function key(e) { if (e.key === 'Escape') { e.stopPropagation(); done(false); } }
      d.addEventListener('click', function (e) {
        var b = e.target.closest('[data-dlg]');
        if (b) return done(b.dataset.dlg === '1');
        if (e.target === d) done(false); // a tap outside the box
      });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(d);
      d.querySelector('[data-dlg="1"]').focus();
    });
  });
  function openHash() { var drive = document.getElementById('drive'); if (location.hash === '#drive' && drive) drive.open = true; } // Drive is off the page for now
  window.addEventListener('hashchange', openHash);
  openHash();

  var form = document.getElementById('name-form');
  if (!form) return;
  var account = form.dataset.account, prefsState = null;
  var prefButtons = Array.from(document.querySelectorAll('[data-push-pref]'));
  var pushCard = document.getElementById('push');
  var pushMaster = document.querySelector('.push-master > button');
  var pushHint = document.querySelector('.push-hint');
  var mutedButton = document.querySelector('[data-muted-rooms]');
  var mutedList = document.getElementById('muted-rooms');
  var roomNames = new Map((JSON.parse(mutedList.dataset.rooms || '[]') || []).map(function (room) { return [room.id, room.name]; }));
  var prefError = document.getElementById('push-prefs-error');
  function showError(error) {
    prefError.textContent = (error && (error.next || error.message)) || String(error);
    prefError.classList.remove('hidden');
  }
  function pushEnabled() {
    return pushCard.dataset.state === 'on' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  }
  function controlsEnabled() {
    return !!(prefsState && prefsState.endpoint && pushEnabled());
  }
  function updateCategoryControls() {
    var enabled = controlsEnabled();
    var action = pushCard.dataset.state === 'on' ? 'off' : pushCard.dataset.state === 'off' ? 'on' : '';
    pushMaster.disabled = !action || !pushCard.querySelector('[data-push="' + action + '"]');
    pushMaster.setAttribute('aria-pressed', String(pushEnabled()));
    pushHint.classList.toggle('hidden', pushEnabled());
    prefButtons.forEach(function (button) {
      button.disabled = !enabled;
      button.closest('li.row').classList.toggle('dis', !enabled);
      var switchEl = button.querySelector('.sw');
      switchEl.classList.toggle('on', enabled && !!prefsState.prefs[button.dataset.pushPref]);
      switchEl.classList.toggle('dis', !enabled);
      button.setAttribute('aria-pressed', String(enabled && !!prefsState.prefs[button.dataset.pushPref]));
    });
  }
  function showPreferences(current) {
    prefsState = current;
    prefError.classList.add('hidden');
    updateCategoryControls();
    mutedButton.disabled = false;
    document.getElementById('muted-count').textContent = current.prefs.mutedRooms.length;
    mutedList.replaceChildren();
    if (!current.prefs.mutedRooms.length) {
      var empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent = S.settingsMutedEmpty;
      mutedList.appendChild(empty);
    }
    current.prefs.mutedRooms.forEach(function (id) {
      var row = document.createElement('div'), link = document.createElement('a'), unmute = document.createElement('button');
      row.className = 'row';
      link.href = '/r/' + id;
      link.textContent = roomNames.get(id) || id;
      unmute.type = 'button';
      unmute.className = 'btn xs line';
      unmute.dataset.unmute = id;
      unmute.textContent = S.settingsUnmute;
      row.append(link, unmute);
      mutedList.appendChild(row);
    });
  }
  function readPreferences() {
    window.scorpioPushPrefs.read(account).then(showPreferences, showError);
  }
  new MutationObserver(updateCategoryControls).observe(pushCard, { attributes: true, attributeFilter: ['data-state'] });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) updateCategoryControls(); });
  pushMaster.addEventListener('click', function () {
    var action = pushCard.dataset.state === 'on' ? 'off' : pushCard.dataset.state === 'off' ? 'on' : '';
    var button = pushCard.querySelector('[data-push="' + action + '"]');
    if (button && !button.disabled) button.click();
  });
  prefButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (!controlsEnabled()) return;
      var change = {};
      change[button.dataset.pushPref] = !prefsState.prefs[button.dataset.pushPref];
      button.disabled = true;
      window.scorpioPushPrefs.write(account, change).then(showPreferences, function (error) {
        button.disabled = false;
        showError(error);
      });
    });
  });
  mutedButton.addEventListener('click', function () { mutedList.classList.toggle('hidden'); });
  mutedList.addEventListener('click', function (event) {
    var unmute = event.target.closest('[data-unmute]');
    if (!unmute) return;
    unmute.disabled = true;
    window.scorpioPushPrefs.write(account, { roomId: unmute.dataset.unmute, muted: false }).then(showPreferences, function (error) {
      unmute.disabled = false;
      showError(error);
    });
  });
  document.addEventListener('scorpio-push-change', readPreferences);
  updateCategoryControls();
  readPreferences();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = form.querySelector('button'), result = document.getElementById('name-result');
    button.disabled = true;
    fetch('/settings/name', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ displayName: form.elements.displayName.value }),
    }).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw body; return body; }); })
      .then(function (body) {
        var name = body.displayName === form.dataset.account ? form.dataset.account : body.displayName + S.settingsAccountOpen + form.dataset.account + S.settingsAccountClose;
        var subtitle = document.getElementById('settings-subtitle');
        subtitle.textContent = name + subtitle.textContent.slice(subtitle.textContent.indexOf(' · '));
        document.getElementById('name-current').textContent = body.displayName;
        result.textContent = S.settingsNameSaved;
      }, function (error) { result.textContent = (error && (error.next || error.message)) || String(error); })
      .finally(function () { button.disabled = false; });
  });
})();
