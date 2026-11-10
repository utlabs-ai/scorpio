// Form rules use the browser's zone (docs/api/schedules.md). Count UTC calendar dates, then construct
// local wall times: Date moves gaps forward and chooses the first repeated hour.
(function () {
  "use strict";
  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], DAY = 86400000;
  // The weekly form calls its anchor First: keep it on an allowed weekday.
  window.scheduleFormWeekdayDate = function (value, days) {
    if (!value || !days.length) return value;
    var start = Date.parse(value + "T00:00:00Z");
    for (var n = 0; n < 7; n++) {
      var d = new Date(start + n * DAY);
      if (days.indexOf(DAYS[(d.getUTCDay() + 6) % 7]) >= 0) return d.toISOString().slice(0, 10);
    }
    return value;
  };
  window.scheduleFormNext = function (rule, after) {
    if (rule.kind === "once") return rule.at;
    if (rule.kind === "every") return after + rule.minutes * 60000;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time) || rule.kind === "weekly" && !rule.days.length) return null;
    var now = new Date(after), today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    var step = rule.step || 1, anchor = rule.from ? Date.parse(rule.from + "T00:00:00Z") : today;
    if (!Number.isInteger(step) || step < 1 || !Number.isFinite(anchor)) return null;
    var start = Math.max(today, anchor), time = rule.time.split(":").map(Number);
    var monday = function (ms) { return ms - (new Date(ms).getUTCDay() + 6) % 7 * DAY; };
    var limit = rule.kind === "daily" ? step + 1 : 7 * (step + 1);
    for (var n = 0; n <= limit; n++) {
      var ms = start + n * DAY, d = new Date(ms);
      var gap = rule.kind === "daily" ? (ms - anchor) / DAY : (monday(ms) - monday(anchor)) / (7 * DAY);
      if (step > 1 && gap % step !== 0) continue;
      if (rule.kind === "weekly" && rule.days.indexOf(DAYS[(d.getUTCDay() + 6) % 7]) < 0) continue;
      var at = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), time[0], time[1]).getTime();
      if (at > after) return at;
    }
    return null;
  };
})();
