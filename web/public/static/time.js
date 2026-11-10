// Render <time data-ts="ms"> in the viewer's locale and time zone.
(function () {
  "use strict";
  var lang = document.documentElement.lang || undefined;
  document.querySelectorAll("time[data-ts]").forEach(function (el) {
    var ts = Number(el.getAttribute("data-ts"));
    if (!ts) return;
    var d = new Date(ts);
    el.dateTime = d.toISOString();
    var fmt = el.getAttribute("data-fmt");
    var two = function (n) { return String(n).padStart(2, "0"); };
    var hm = two(d.getHours()) + ":" + two(d.getMinutes());
    // data-fmt="date": the day only (a purge date); "handoff": 「10-16 14:20」 / 「Oct 16, 14:20」 (as the
    // member card says it); else the day and the time.
    el.textContent = fmt === "handoff"
      ? (/^zh/.test(lang || "") ? two(d.getMonth() + 1) + "-" + two(d.getDate()) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ",") + " " + hm
      : fmt === "date"
      ? d.toLocaleDateString(lang, { month: "short", day: "numeric" })
      : d.toLocaleString(lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  });
})();
