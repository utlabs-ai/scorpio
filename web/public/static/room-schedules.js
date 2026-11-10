// Scheduled messages on the room page. The server owns rules, permissions and nextAt;
// this module only presents the contract's Schedule and posts its operations.
(function () {
  "use strict";

  window.createRoomSchedules = function (ctx) {
    var $ = ctx.$, S = ctx.S.sched, sheet = $("schedule-sheet"), scrim = $("schedule-scrim");
    var state = ctx.state, boot = ctx.boot, input = ctx.input;
    var list = [], count = 0, loaded = false, proRequired = false, mode = "", detail = null, form = null, returnToList = false;
    var editItem = null, edit = null, busy = false, feedbackTimer = null, loadVersion = 0;
    var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    var locale = boot.lang === "zh" ? "zh-CN" : "en-US";
    // one clock for the feature (composer button, the avatar, the preview): app.css .ic-clock
    var CLOCK = '<span class="ic-clock" aria-hidden="true"></span>';
    // send now = the composer's send arrow
    var ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.5V2.5M4.5 6 8 2.5 11.5 6"/></svg>';
    function fill(s, vars) { return ctx.fill(s, vars); }
    function esc(s) { return escapeHtml(String(s == null ? "" : s)); }
    function name(n) {
      var m = state.members.find(function (x) { return x.name === n; });
      if (m && m.kind === "human" && m.displayName) return m.displayName;
      if (String(n || "").includes("@") && String(n).split("@").slice(1).join("@") === state.me) return shortName(n);
      return String(n || "");
    }
    function shortName(n) { return String(n || "").split("@")[0]; }
    function dateTime(ms) {
      return ms == null ? "—" : new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    function clock(ms) { return new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: boot.lang === "en" }); }
    function lastWhen(ms) { return Date.now() - ms < 90000 ? S.justNow : dateTime(ms); }
    function unit(minutes) {
      return minutes === 60 ? S.everyHour : minutes % 60 === 0 ? fill(S.everyHours, { n: minutes / 60 }) : fill(S.everyMinutes, { n: minutes });
    }
    function weekdayInZone(ms, tz) {
      var day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(ms)).toLowerCase();
      return DAYS.indexOf(day);
    }
    function zonedReference(rule) {
      var formatter = new Intl.DateTimeFormat("en-US", { timeZone: rule.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      function parts(ms) {
        var out = {};
        formatter.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== "literal") out[p.type] = Number(p.value); });
        return out;
      }
      function offset(ms) { var p = parts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000; }
      var today = parts(Date.now()), time = rule.time.split(":");
      var wall = Date.UTC(today.year, today.month - 1, today.day, Number(time[0]), Number(time[1]));
      var candidate = wall - offset(Date.now());
      return wall - offset(candidate);
    }
    function ruleLabel(rule, nextAt) {
      if (!rule) return "";
      if (rule.kind === "once") return fill(S.ruleOnce, { when: dateTime(rule.at) });
      if (rule.kind === "every") return unit(rule.minutes);
      var at = nextAt || zonedReference(rule);
      if (rule.kind === "daily") return fill(rule.step > 1 ? S.ruleDailyN : S.ruleDaily, { n: rule.step, time: clock(at) });
      var origin = weekdayInZone(at, rule.tz), days = (rule.days || []).map(function (d) {
        var offset = (DAYS.indexOf(d) - origin + 7) % 7;
        var local = new Date(at + offset * 86400000).getDay();
        return (rule.step > 1 ? S.weekdayNames : S.weekdays)[(local + 6) % 7];
      });
      return fill(rule.step > 1 ? S.ruleWeeklyN : S.ruleWeekly, { n: rule.step, days: days.join(boot.lang === "zh" ? "、" : ", "), time: clock(at) });
    }
    function reason(code, item) { return fill(S.reason[code] || code || "", { name: shortName(item.reviveName) }); }
    function stopped(item) {
      if (item.stoppedReason === "archived") return S.stoppedArchived;
      if (item.stoppedReason === "pro_expired") return S.stoppedPro;
      if (item.stoppedReason === "failed") return fill(S.stoppedFailed, { when: dateTime(item.lastAt), reason: reason(item.lastError, item) });
      return fill(S.stopped, { who: name(item.stoppedBy || item.by) });
    }
    function api(body) { return ctx.post("schedules", body); }
    function get(path) {
      return fetch("/r/" + boot.roomId + "/schedules" + (path || ""), { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); });
    }
    function errorText(e) {
      if (e && e.error === "schedule_in_past") return S.past;
      if (e && e.error === "schedule_too_frequent") return S.minEvery;
      if (e && e.error === "pro_required") return S.pro;
      if (e && e.error === "schedule_no_files") return S.noFiles;
      if (e && S.reason[e.error]) return reason(e.error, detail || {});
      return e && (e.next || e.error) || String(e);
    }
    function frame(f) {
      if (f) { count = f.count || 0; proRequired = !!f.proRequired; ctx.refreshScheduleViews(); }
      if (f && f.type === "schedules" && (ctx.scheduleTabOpen() || mode === "detail")) refresh();
    }
    function refresh() {
      if (boot.member === false) return Promise.resolve();
      var version = ++loadVersion;
      return get("").then(function (j) {
        if (version !== loadVersion) return;
        list = j.items || []; count = j.count || 0; proRequired = !!j.proRequired; loaded = true;
        ctx.refreshScheduleViews();
        if (mode === "detail" && detail) {
          var current = list.find(function (x) { return x.id === detail.id; });
          if (current) { detail = current; render(); }
        }
      }).catch(function (e) { if (version === loadVersion) ctx.flash(errorText(e)); });
    }
    function show(kind) {
      ctx.closePanel(); ctx.closeItem();
      mode = kind; sheet.classList.remove("hidden"); scrim.classList.remove("hidden");
      render();
    }
    function close(reopen) {
      var openList = returnToList && reopen !== false;
      sheet.classList.add("hidden"); scrim.classList.add("hidden"); mode = "";
      clearTimeout(feedbackTimer);
      if (editItem) leaveEdit();
      returnToList = false;
      if (openList) ctx.openPanel("schedules");
    }
    function openDetail(id) {
      get("/" + encodeURIComponent(id)).then(function (j) {
        returnToList = ctx.scheduleTabOpen();
        detail = j.item; show("detail");
      }).catch(function (e) { ctx.toast(e && e.error === "schedule_not_found" ? S.gone : errorText(e)); });
    }
    function localDate(d) {
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    }
    function blankForm() {
      var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      return { kind: "once", date: localDate(tomorrow), time: "10:00", days: ["mon"], n: 30, unit: "m", step: 1, from: "", revive: true, calendar: false, nonce: crypto.randomUUID() };
    }
    function formOf(item) {
      var f = blankForm(), r = item.rule;
      f.kind = r.kind; f.revive = !!item.revive; f.calendar = !!item.calendar;
      if (r.kind === "once") { var d = new Date(r.at); f.date = localDate(d); f.time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
      if (r.kind === "daily" || r.kind === "weekly") { f.time = r.time; f.days = r.days || ["mon"]; f.step = r.step || 1; f.from = r.from || ""; }
      if (r.kind === "every") { f.unit = r.minutes % 60 === 0 ? "h" : "m"; f.n = f.unit === "h" ? r.minutes / 60 : r.minutes; }
      return f;
    }
    function openForm() {
      if (!ctx.canWrite()) return;
      if (ctx.composer.hasFiles()) return ctx.toast(S.noFiles);
      if (!input.value.trim()) return;
      returnToList = false; form = blankForm(); show("form");
    }
    /** Editing takes over the composer: the schedule's text in it, Send saves, the edit bar's × cancels. */
    function startEdit(item) {
      editItem = item; form = formOf(item);
      edit = ctx.composer.takeOver({ text: item.text, label: '<span>' + esc(S.edit) + ' <b>' + esc(item.id) + '</b></span>', onSave: save, onCancel: close });
      show("form");
    }
    function leaveEdit() {
      editItem = null;
      edit.end(); edit = null;
    }
    function mentioned() {
      return Array.from(new Set(renderMarkdown.mentionedNames(input.value, new Set(state.members.map(function (m) { return m.name; })))));
    }
    function reviveTarget() {
      return mentioned().map(function (n) { return state.members.find(function (m) { return m.name === n; }); })
        .find(function (m) { return m && m.kind === "agent" && m.owner === state.me; });
    }
    function hostFor(m) { return m && state.members.find(function (x) { return x.name === m.host && x.kind === "host"; }); }
    function idleHint() {
      if (form.kind !== "every") return "";
      var minutes = Number(form.n) * (form.unit === "h" ? 60 : 1);
      var agent = mentioned().map(function (n) { return state.members.find(function (m) { return m.name === n; }); })
        .find(function (m) { var host = hostFor(m), idle = host ? (host.idleHandoffMinutes == null ? 60 : host.idleHandoffMinutes) : 0; return m && m.kind === "agent" && m.owner === state.me && m.status === "active" && host && host.status === "active" && idle > 0 && minutes < idle; });
      var host = hostFor(agent);
      return agent ? fill(S.keepsAwake, { n: minutes, name: shortName(agent.name), computer: host.device && host.device.name || shortName(host.name) }) : "";
    }
    function ruleFromForm() {
      if (form.kind === "once") return { kind: "once", at: new Date(form.date + "T" + form.time + ":00").getTime() };
      if (form.kind === "every") return { kind: "every", minutes: Number(form.n) * (form.unit === "h" ? 60 : 1) };
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      var rule = form.kind === "daily" ? { kind: "daily", time: form.time, tz: tz }
        : { kind: "weekly", days: DAYS.filter(function (d) { return form.days.indexOf(d) >= 0; }), time: form.time, tz: tz };
      if (Number(form.step) > 1) { rule.step = Number(form.step); rule.from = form.from; }
      return rule;
    }
    function firstFromForm(rule) { return window.scheduleFormNext(rule, Date.now()); }
    function seedFrom() {
      if ((form.kind !== "daily" && form.kind !== "weekly") || Number(form.step) <= 1) return;
      if (!form.from) {
        var rule = ruleFromForm(); delete rule.step; delete rule.from;
        var first = firstFromForm(rule);
        if (first != null) form.from = localDate(new Date(first));
      }
      if (form.kind === "weekly") form.from = window.scheduleFormWeekdayDate(form.from, form.days);
    }
    function validForm(rule) {
      return !!input.value.trim() && !ctx.composer.hasFiles() && !proRequired &&
        (rule.kind !== "once" || Number.isFinite(rule.at) && (rule.at > Date.now() || editItem && !ruleChanged(rule))) &&
        (rule.kind !== "weekly" || rule.days.length > 0) &&
        ((rule.kind !== "daily" && rule.kind !== "weekly") || Number.isInteger(Number(form.step)) && Number(form.step) >= 1 && Number(form.step) <= (rule.kind === "daily" ? 365 : 52) && (Number(form.step) === 1 || !!form.from)) &&
        (rule.kind !== "every" || rule.minutes >= 10 && rule.minutes <= 10080);
    }
    function ruleChanged(rule) { return !editItem || JSON.stringify(editItem.rule) !== JSON.stringify(rule); }
    function proHtml() { return proRequired ? '<div class="sched-pro"><span>' + esc(S.pro) + '</span><a class="btn sm primary" href="/pricing">Pro ›</a></div>' : ""; }
    function head(title, back, extra) {
      return '<div class="grab"></div><header class="sh"><button type="button" class="x sched-back' + (back ? '' : ' hidden') + '" data-sched-act="back" aria-label="' + esc(ctx.S.back) + '"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg></button><h3>' + esc(title) + '</h3><span class="sp"></span>' + (extra || '') + '<button type="button" class="x" data-sched-act="close" aria-label="' + esc(ctx.S.cancel) + '">×</button></header>';
    }
    function listHtml() {
      var stop = ctx.canWrite() && list.some(function (x) { return x.on && x.canStop; });
      var top = proHtml() + (stop ? '<div class="sched-listbar"><button type="button" class="btn sm danger sched-stopall" data-sched-act="stop_all">' + esc(S.stopAll) + '</button></div>' : '');
      return (top ? '<div class="fixed">' + top + '</div>' : '') + '<div class="scroll"><div class="sched-list">' + list.map(function (item) {
        var status = item.on ? (item.lastError ? esc(fill(S.lastFailed, { when: dateTime(item.lastAt), reason: reason(item.lastError, item) })) :
          (item.lastAt ? (item.lastSeq ? '<button type="button" data-sched-act="jump" data-seq="' + item.lastSeq + '">' + esc(S.last + ' ' + lastWhen(item.lastAt)) + '</button>' : esc(S.last + ' ' + lastWhen(item.lastAt))) : '') +
          (item.lastAt && item.nextAt ? '<span class="sep"> · </span>' : '') + (item.nextAt ? '<span class="nw">' + esc(S.next + ' ' + dateTime(item.nextAt)) + '</span>' : '')) : esc(stopped(item));
        return '<div class="sched-row' + (item.on ? '' : ' off') + '"><div class="sched-main"><button type="button" class="sched-open" data-sched-act="detail" data-id="' + esc(item.id) + '"><b>' + esc(ruleLabel(item.rule, item.nextAt)) + (item.calendar ? '<i class="sched-mark">' + esc(S.calendarMark) + '</i>' : '') + '</b><span>' + esc((item.to || []).length ? (item.to.map(name).join(boot.lang === "zh" ? "、" : ", ") + ' · ') : '') + esc(fill(S.byWho, { who: name(item.by) })) + '</span></button><small class="sched-run' + (item.lastError ? ' bad' : '') + '">' + status + '</small></div>' +
          (item.canStop && ctx.canWrite() ? '<button type="button" class="sched-fly" data-sched-act="send" data-id="' + esc(item.id) + '" aria-label="' + esc(S.sendNow + ' ' + item.id) + '" title="' + esc(S.sendNow) + '"' + (proRequired ? ' disabled' : '') + '>' + ARROW + '</button><label class="sched-toggle"><input type="checkbox" role="switch" class="sw" data-sched-toggle="' + esc(item.id) + '"' + (item.on ? ' checked' : '') + (proRequired && !item.on ? ' disabled' : '') + '><span class="sr-only">' + esc(S.listTitle) + ' ' + esc(item.id) + '</span></label>' : '') + '</div>';
      }).join("") + (loaded && !list.length ? '<div class="sched-empty"><p>' + esc(S.empty) + '</p><small>' + esc(S.emptyHint) + '</small></div>' : '') + '</div></div>';
    }
    function detailHtml(item) {
      var pair = function (label, value) { return '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>'; };
      return head(S.listTitle + ' ' + item.id, true) + proHtml() + '<div class="sbody sched-detail"><div class="md sched-text">' + renderMarkdown(item.text, new Set(state.members.map(function (m) { return m.name; })), state.me) + '</div><dl class="kv">' +
        pair(S.listTitle, esc(ruleLabel(item.rule, item.nextAt))) +
        ((item.to || []).length ? pair(S.to, esc(item.to.map(name).join(boot.lang === "zh" ? "、" : ", "))) : '') +
        pair(S.by, esc(name(item.by))) + pair(S.created, esc(dateTime(item.createdAt))) +
        (item.lastAt ? pair(S.last, item.lastSeq ? '<button type="button" data-sched-act="jump" data-seq="' + item.lastSeq + '">' + esc(dateTime(item.lastAt)) + ' · #' + item.lastSeq + '</button>' : esc(dateTime(item.lastAt))) : '') +
        (item.nextAt ? pair(S.next, esc(dateTime(item.nextAt))) : '') + '</dl>' +
        (!item.on ? '<p class="sched-status' + (item.lastError ? ' bad' : '') + '">' + esc(stopped(item)) + '</p>' : item.lastError ? '<p class="sched-status bad">' + esc(fill(S.lastFailed, { when: dateTime(item.lastAt), reason: reason(item.lastError, item) })) + '</p>' : '') +
        '<div class="sched-sws">' +
        (item.reviveName ? '<label class="sched-switch"><span>' + esc(fill(S.revive, { name: shortName(item.reviveName) })) + '</span><input type="checkbox" role="switch" class="sw" data-sched-revive' + (item.revive ? ' checked' : '') + (!item.canEdit || proRequired || !ctx.canWrite() ? ' disabled' : '') + '></label>' : '') +
        '<label class="sched-switch"><span>' + esc(S.calendar) + '</span><input type="checkbox" role="switch" class="sw" data-sched-calendar' + (item.calendar ? ' checked' : '') + (!item.canEdit || proRequired || !ctx.canWrite() ? ' disabled' : '') + '></label>' +
        (item.canStop && ctx.canWrite() ? '<label class="sched-switch"><span>' + esc(S.on) + '</span><input type="checkbox" role="switch" class="sw" data-sched-toggle="' + esc(item.id) + '"' + (item.on ? ' checked' : '') + (proRequired && !item.on ? ' disabled' : '') + '></label>' : '') + '</div>' +
        '<div class="acts sched-actions">' + (item.canStop && ctx.canWrite() ? '<button type="button" class="btn wide" data-sched-act="send" data-id="' + esc(item.id) + '"' + (proRequired ? ' disabled' : '') + '>' + esc(S.sendNow) + '</button>' : '') +
        (item.canEdit && ctx.canWrite() ? '<button type="button" class="btn wide" data-sched-act="edit">' + esc(S.edit) + '</button>' : '') +
        (item.canStop && ctx.canWrite() ? '<button type="button" class="btn wide danger" data-sched-act="delete">' + esc(S.delete) + '</button>' : '') + '</div></div>';
    }
    var CAL = '<svg class="sched-cal" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>';
    function dayFace(value) {
      if (!value) return "";
      var d = new Date(value + "T00:00:00"), same = d.getFullYear() === new Date().getFullYear();
      var md = d.toLocaleDateString(locale, Object.assign({ month: boot.lang === "zh" ? "long" : "short", day: "numeric" }, same ? {} : { year: "numeric" }));
      var wd = S.weekdayNames[(d.getDay() + 6) % 7];
      return boot.lang === "zh" ? md + " " + wd : wd + ", " + md;
    }
    function dateField(label, field, value, min) {
      return '<label class="sched-field"><span>' + esc(label) + '</span><span class="sched-face">' + CAL + '<b>' + esc(dayFace(value)) + '</b><input type="date" data-sched-field="' + field + '" value="' + esc(value) + '"' + (min ? ' min="' + esc(min) + '"' : '') + ' aria-label="' + esc(label) + '"></span></label>';
    }
    function formHtml() {
      seedFrom();
      var rule = ruleFromForm(), first = firstFromForm(rule), valid = validForm(rule);
      var target = reviveTarget(), host = target && target.status === "active" && hostFor(target);
      var hint = target ? (host ? fill(S.reviveHint, { name: shortName(target.name), computer: host.device && host.device.name || shortName(host.name) }) : fill(S.reviveHintAway, { name: shortName(target.name) })) : "";
      var time = '<label class="sched-field"><span>' + esc(S.time) + '</span><input type="time" data-sched-field="time" step="60" value="' + esc(form.time) + '"></label>';
      var unitWord = form.kind === "daily" ? (Number(form.step) === 1 ? S.dayUnit : S.daysUnit) : (Number(form.step) === 1 ? S.weekUnit : S.weeksUnit);
      var stepRow = '<div class="sched-every sched-step"><span class="sched-w">' + esc(S.everyWord) + '</span><input type="number" inputmode="numeric" min="1" max="' + (form.kind === "daily" ? 365 : 52) + '" data-sched-field="step" value="' + esc(form.step) + '" aria-label="' + esc(S.everyWord + " … " + unitWord) + '"><span class="sched-w">' + esc(unitWord) + '</span></div>';
      var firstRow = Number(form.step) > 1 ? dateField(S.first, "from", form.from, localDate(new Date())) : "";
      var extra = form.kind === "once" ? dateField(S.date, "date", form.date) + time
        : form.kind === "daily" ? stepRow + time + firstRow
        : form.kind === "weekly" ? stepRow + '<div class="sched-days">' + DAYS.map(function (d, i) { return '<label><input type="checkbox" data-sched-day="' + d + '"' + (form.days.indexOf(d) >= 0 ? ' checked' : '') + '><span>' + esc(S.weekdays[i]) + '</span></label>'; }).join("") + '</div>' + time + firstRow
        : '<div class="sched-every"><input type="number" inputmode="numeric" min="1" max="10080" data-sched-field="n" value="' + esc(form.n) + '"><span class="sched-sel"><select data-sched-field="unit"><option value="m"' + (form.unit === "m" ? ' selected' : '') + '>' + esc(S.minuteUnit) + '</option><option value="h"' + (form.unit === "h" ? ' selected' : '') + '>' + esc(S.hourUnit) + '</option></select></span></div>';
      var tooSoon = rule.kind === "every" && rule.minutes < 10;
      var past = rule.kind === "once" && Number.isFinite(rule.at) && rule.at <= Date.now() && (!editItem || ruleChanged(rule));
      return head(S.title, !!editItem) + proHtml() + '<div class="sbody"><div class="sched-form' + (proRequired ? ' disabled" inert' : '"') + '>' + (editItem ? '<textarea class="sched-body" data-sched-body aria-label="' + esc(S.edit) + '">' + esc(input.value) + '</textarea>' : '') + '<div class="seg sched-kinds">' + ["once", "daily", "weekly", "every"].map(function (k) {
        return '<button type="button" data-sched-kind="' + k + '" class="' + (form.kind === k ? 'on' : '') + '">' + esc(S[k]) + '</button>';
      }).join("") + '</div><div class="sched-rows">' + extra +
        (target ? '<div class="sched-revive"><label class="sched-switch"><span>' + esc(fill(S.revive, { name: shortName(target.name) })) + '</span><input type="checkbox" role="switch" class="sw" data-sched-field="revive"' + (form.revive ? ' checked' : '') + '></label><p class="sched-hint">' + esc(hint) + '</p></div>' : '') +
        '<div class="sched-calendar"><label class="sched-switch"><span>' + esc(S.calendar) + '</span><input type="checkbox" role="switch" class="sw" data-sched-field="calendar"' + (form.calendar ? ' checked' : '') + '></label><p class="sched-hint">' + esc(S.calendarHint) + '</p></div></div>' +
        (tooSoon ? '<p class="sched-error">' + esc(S.minEvery) + '</p>' : past ? '<p class="sched-error">' + esc(S.past) + '</p>' : '') +
        (idleHint() ? '<p class="sched-hint idle">' + esc(idleHint()) + '</p>' : '') +
        '<p class="sched-preview">' + CLOCK + '<span>' + esc(fill(rule.kind === "once" ? (mentioned().length ? S.previewOnce : S.previewOnceNoTo) : (mentioned().length ? S.preview : S.previewNoTo), { rule: ruleLabel(rule, first), to: mentioned().map(name).join(boot.lang === "zh" ? "、" : ", "), first: dateTime(first) })) + '</span></p>' +
        '<button type="button" class="btn primary big sched-submit" data-sched-act="save"' + (valid && !busy ? '' : ' disabled') + '>' + esc(editItem ? ctx.S.save : S.create) + '</button></div></div>';
    }
    function render() {
      if (!mode) return;
      var active = document.activeElement;
      var switchSelector = active && sheet.contains(active) && active.matches('input.sw')
        ? active.hasAttribute('data-sched-revive') ? '[data-sched-revive]'
          : active.hasAttribute('data-sched-calendar') ? '[data-sched-calendar]'
          : active.hasAttribute('data-sched-toggle') ? '[data-sched-toggle="' + active.dataset.schedToggle + '"]'
          : active.dataset.schedField === 'calendar' ? '[data-sched-field="calendar"]'
          : '[data-sched-field="revive"]'
        : null;
      sheet.innerHTML = mode === "detail" && detail ? detailHtml(detail) : mode === "form" && form ? formHtml() : "";
      var next = switchSelector && sheet.querySelector(switchSelector);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
    function save() {
      if (!form || busy) return;
      var rule = ruleFromForm();
      if (!validForm(rule)) return;
      busy = true; render();
      var body = editItem ? { op: "edit", id: editItem.id, text: input.value, revive: form.revive, calendar: form.calendar }
        : { op: "add", text: input.value, rule: rule, revive: form.revive, calendar: form.calendar, nonce: form.nonce };
      if (editItem && ruleChanged(rule)) {
        // Omitting step on a same-kind edit preserves it (docs/api/schedules.md); resetting needs an explicit 1.
        if ((rule.kind === "daily" || rule.kind === "weekly") && !rule.step && editItem.rule.step > 1 && editItem.rule.kind === rule.kind) rule.step = 1;
        body.rule = rule;
      }
      api(body).then(function (r) {
        var warning = r.warnCode === "keeps_awake" ? idleHint() || r.warn : r.warnCode === "no_takeover" ? reason("no_takeover", r.item || {}) : r.warn;
        if (editItem) { leaveEdit(); detail = r.item; mode = "detail"; }
        else { ctx.composer.clear(); apiViewChanged(); mode = ""; sheet.classList.add("hidden"); scrim.classList.add("hidden"); }
        if (warning) ctx.flash(warning);
        refresh(); render();
      }).catch(function (e) {
        if (e && e.error === "pro_required") proRequired = true;
        ctx.flash(errorText(e));
      }).finally(function () { busy = false; render(); });
    }
    function operation(op, id) {
      return api({ op: op, id: id }).then(function (r) {
        if (op === "delete") { var wasList = returnToList; close(); if (!wasList) ctx.openPanel("schedules"); detail = null; }
        if (r.item && detail && r.item.id === detail.id) detail = r.item;
        refresh(); render();
        return r;
      }).catch(function (e) { ctx.flash(errorText(e)); refresh(); });
    }
    function sendNow(id) {
      ctx.ask(S.sendNowConfirm, { ok: S.sendNow }).then(function (yes) {
        if (!yes) return;
        api({ op: "send", id: id, nonce: crypto.randomUUID() }).then(function (r) {
          ctx.toast(S.sent);
          if (!r.item) { if (mode === "detail") { var wasList = returnToList; close(); if (!wasList) ctx.openPanel("schedules"); detail = null; } }
          else if (detail && r.item.id === detail.id) detail = r.item;
          refresh(); render();
        }).catch(function (e) { ctx.toast(errorText(e)); refresh(); });
      });
    }
    function stopAll() {
      ctx.ask(S.stopAllConfirm, { ok: S.stopAll, danger: true }).then(function (yes) { if (yes) operation("stop_all"); });
    }
    function listClick(e) {
      var b = e.target.closest("[data-sched-act]");
      if (!b) return false;
      switch (b.dataset.schedAct) {
        case "detail": openDetail(b.dataset.id); break;
        case "send": sendNow(b.dataset.id); break;
        case "stop_all": stopAll(); break;
        case "jump": ctx.jumpTo(Number(b.dataset.seq)); break;
        default: return false;
      }
      return true;
    }
    function listChange(e) {
      var id = e.target.dataset.schedToggle;
      if (!id) return false;
      operation(e.target.checked ? "on" : "off", id);
      return true;
    }
    sheet.addEventListener("click", function (e) {
      var date = e.target.closest('.sched-face');
      if (date) { var picker = date.querySelector('input'); if (picker.showPicker) picker.showPicker(); return; }
      var kind = e.target.closest("[data-sched-kind]");
      if (kind) { form.kind = kind.dataset.schedKind; if (form.kind === "weekly") form.step = Math.min(52, Number(form.step) || 1); render(); return; }
      var b = e.target.closest("[data-sched-act]"); if (!b) return;
      var id = b.dataset.id;
      switch (b.dataset.schedAct) {
        case "close": close(); break;
        case "back": if (mode === "detail") { var wasList = returnToList; close(); if (!wasList) ctx.openPanel("schedules"); } else close(); break;
        case "detail": openDetail(id); break;
        case "save": save(); break;
        case "edit": startEdit(detail); break;
        case "send": sendNow(id); break;
        case "delete": ctx.ask(S.deleteConfirm, { ok: S.delete, danger: true }).then(function (yes) { if (yes) operation("delete", detail.id); }); break;
        case "stop_all": stopAll(); break;
        case "jump": close(false); ctx.jumpTo(Number(b.dataset.seq)); break;
      }
    });
    sheet.addEventListener("input", function (e) {
      if (e.target.hasAttribute("data-sched-body")) {
        edit.setText(e.target.value);
        if (e.isComposing) return;
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(function () {
          if (mode !== "form" || !editItem) return;
          var field = sheet.querySelector("[data-sched-body]");
          if (!field) return;
          var active = document.activeElement === field, start = field.selectionStart, end = field.selectionEnd;
          render();
          if (active) { field = sheet.querySelector("[data-sched-body]"); field.focus(); field.setSelectionRange(start, end); }
        }, 180);
        return;
      }
      var f = e.target.dataset.schedField;
      if (f === "n" || f === "step") { form[f] = e.target.value; var submit = sheet.querySelector(".sched-submit"); if (submit) submit.disabled = !validForm(ruleFromForm()); }
    });
    sheet.addEventListener("change", function (e) {
      var day = e.target.dataset.schedDay;
      if (day) { form.days = e.target.checked ? form.days.concat(day) : form.days.filter(function (d) { return d !== day; }); render(); return; }
      var field = e.target.dataset.schedField;
      if (field === "step") {
        form.step = Math.min(form.kind === "daily" ? 365 : 52, Math.max(1, Math.round(Number(e.target.value) || 1)));
        render(); return;
      }
      if (field) { form[field] = field === "revive" || field === "calendar" ? e.target.checked : e.target.value; render(); return; }
      if (e.target.hasAttribute("data-sched-revive")) { api({ op: "edit", id: detail.id, revive: e.target.checked }).then(function (r) { detail = r.item; refresh(); render(); }).catch(function (err) { ctx.flash(errorText(err)); render(); }); return; }
      if (e.target.hasAttribute("data-sched-calendar")) { api({ op: "edit", id: detail.id, calendar: e.target.checked }).then(function (r) { detail = r.item; refresh(); render(); }).catch(function (err) { ctx.flash(errorText(err)); render(); }); return; }
      var id = e.target.dataset.schedToggle;
      if (id) operation(e.target.checked ? "on" : "off", id);
    });
    scrim.addEventListener("click", close);
    $("btn-schedule").addEventListener("click", openForm);
    new MutationObserver(function () { apiViewChanged(); }).observe($("strip"), { attributes: true, childList: true });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && mode) close(); });

    function apiViewChanged() {
      var button = $("btn-schedule"), unavailable = !input.value.trim() || ctx.composer.hasFiles() || !ctx.canWrite();
      button.classList.toggle("unavailable", unavailable);
      button.setAttribute("aria-disabled", String(unavailable));
      if (mode === "form") render();
    }

    /** The row hooks: a scheduled message's chip in its foot, and the system lines for a schedule made or deleted. */
    function footer(m) {
      if (!m.scheduled) return "";
      return '<button type="button" class="ichip sched-footer" data-schedule-id="' + esc(m.scheduled.id) + '"><span class="t">' +
        esc(fill(S.footer, { who: name(m.scheduled.by), id: m.scheduled.id })) + '</span><span class="chev" aria-hidden="true">›</span></button>';
    }
    function systemText(ev) {
      if (ev.type === "schedule_created") return fill(ev.rule.kind === "once" ? ((ev.to || []).length ? S.sysCreatedOnce : S.sysCreatedOnceNoTo) : ((ev.to || []).length ? S.sysCreated : S.sysCreatedNoTo), { who: name(ev.who), id: ev.id, rule: ruleLabel(ev.rule, ev.first), to: (ev.to || []).map(name).join(boot.lang === "zh" ? "、" : ", "), first: dateTime(ev.first) });
      if (ev.type === "schedule_deleted") return fill((ev.to || []).length ? S.sysDeleted : S.sysDeletedNoTo, { who: name(ev.who), id: ev.id, rule: ruleLabel(ev.rule), to: (ev.to || []).map(name).join(boot.lang === "zh" ? "、" : ", ") });
      return null;
    }

    ctx.rowHook("schedule", footer);
    ctx.rowHook("systemText", systemText);
    ctx.socket.on("schedules", frame);
    ctx.panels.tab('schedules', { html: listHtml, label: function () { return esc(S.listTitle) + '<span class="n">' + count + '</span>'; }, side: true, long: true, firstOpen: refresh });
    return {
      frame: frame, refresh: refresh, openDetail: openDetail, openForm: openForm,
      count: function () { return count; }, listHtml: listHtml, listClick: listClick, listChange: listChange,
      save: save,
      composerChanged: apiViewChanged,
    };
  };
})();
