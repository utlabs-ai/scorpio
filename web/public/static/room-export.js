// The export sheet (docs/api/export.md): five parts to tick, one button. The server decides everything else: the
// sheet asks it first with dry=1, shows its refusal as one line, and otherwise lets the browser download the zip
// from the same address (Content-Disposition keeps the page). Nothing is held in the page: a zip can be 2 GB.
(function () {
  "use strict";

  window.createRoomExport = function (ctx) {
    var $ = ctx.$, S = ctx.S.exp, boot = ctx.boot, sheet = $("export-sheet"), scrim = $("export-scrim");
    var PARTS = ["messages", "tasks", "files", "handoffs", "memo"];
    var off = {}, busy = false, error = "", closeTimer = null;
    function esc(s) { return escapeHtml(String(s == null ? "" : s)); }
    function fill(s, vars) { return ctx.fill(s, vars); }

    function row(part) {
      return '<label class="xp-row"><input type="checkbox" class="xp-ck" data-part="' + part + '"' + (off[part] ? "" : " checked") + (busy ? " disabled" : "") +
        '><span class="xp-t">' + esc(S[part]) + (part === "files" ? '<small class="xp-s">' + esc(S.filesNote) + "</small>" : "") + "</span></label>";
    }
    function render() {
      var none = PARTS.every(function (p) { return off[p]; });
      sheet.innerHTML = '<div class="grab"></div><header class="sh"><h3>' + esc(S.sheetTitle) + '</h3><span class="sp"></span>' +
        '<button type="button" class="x" data-export-close aria-label="' + esc(ctx.S.cancel) + '">×</button></header>' +
        '<div class="sbody"><div class="xp-rows">' + PARTS.map(row).join("") + "</div>" +
        (error ? '<p class="xp-err" role="alert">' + esc(error) + "</p>" : "") +
        '<div class="xp-acts"><button type="button" class="btn primary xp-go" data-export-go' + (busy || none ? " disabled" : "") + ">" + esc(busy ? S.packing : S.btn) + "</button></div></div>";
    }
    function open() {
      off = {}; busy = false; error = "";
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      render();
      sheet.classList.remove("hidden"); scrim.classList.remove("hidden");
      var first = sheet.querySelector("input.xp-ck");
      if (first) first.focus();
    }
    function close() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      sheet.classList.add("hidden"); scrim.classList.add("hidden");
    }
    function url() {
      var include = PARTS.filter(function (p) { return !off[p]; });
      var q = new URLSearchParams();
      if (include.length !== PARTS.length) q.set("include", include.join(","));
      var tz = "UTC";
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) {}
      q.set("tz", tz);
      return "/r/" + boot.roomId + "/export?" + q.toString();
    }
    // The first limit the topic is over, in the sheet's words: 10 万条消息 / 100,000 messages, 1000 个附件 / 1,000 files, 2 GiB.
    function limitText(limits, counts) {
      var zh = boot.lang === "zh";
      var n = function (v) { return zh ? (v >= 10000 && v % 10000 === 0 ? v / 10000 + " 万" : String(v)) : v.toLocaleString("en-US"); };
      if (counts.messages > limits.messages) return fill(S.limitMessages, { n: n(limits.messages) });
      if (counts.files > limits.files) return fill(S.limitFiles, { n: n(limits.files) });
      return fill(S.limitBytes, { n: String(Math.round(limits.bytes / 1073741824 * 10) / 10) });
    }
    function errorLine(err) {
      if (err && err.error === "export_busy") return S.busy;
      if (err && err.error === "export_too_large" && err.limits && err.counts) return fill(S.tooLarge, { limit: limitText(err.limits, err.counts) });
      return fill(S.failed, { why: (err && err.next) || String(err) });
    }
    function go() {
      if (busy) return;
      var target = url();
      busy = true; error = ""; render();
      fetch(target + "&dry=1", { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (res) { return res.json().then(function (body) { if (!res.ok) throw body; return body; }); })
        .then(function () {
          // The download: the browser saves the attachment and stays on the page; the sheet goes once it has begun.
          location.href = target;
          closeTimer = setTimeout(close, 1500);
        })
        .catch(function (err) { busy = false; error = errorLine(err); render(); });
    }

    sheet.addEventListener("change", function (e) {
      var ck = e.target.closest("input.xp-ck");
      if (!ck) return;
      off[ck.dataset.part] = !ck.checked;
      var none = PARTS.every(function (p) { return off[p]; });
      sheet.querySelector("[data-export-go]").disabled = busy || none;
    });
    sheet.addEventListener("click", function (e) {
      if (e.target.closest("[data-export-close]")) return close();
      if (e.target.closest("[data-export-go]")) return go();
    });
    scrim.addEventListener("click", close);
    sheet.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

    return { open: open, close: close };
  };
})();
