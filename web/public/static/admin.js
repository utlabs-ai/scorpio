// The ops page /admin: tabs (kept in the address, #users / #cost / #revenue), the chart switches, sorting the
// tables by a header, and copying a prompt.
(function () {
  "use strict";
  var tabs = Array.from(document.querySelectorAll(".ops-tabs a[data-tab]"));
  var panels = Array.from(document.querySelectorAll("[data-panel]"));
  function show(name) {
    if (!panels.some(function (p) { return p.dataset.panel === name; })) name = "users";
    tabs.forEach(function (a) { a.classList.toggle("on", a.dataset.tab === name); a.setAttribute("aria-selected", String(a.dataset.tab === name)); });
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== name; });
  }
  tabs.forEach(function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      history.replaceState(null, "", "#" + a.dataset.tab);
      show(a.dataset.tab);
    });
  });
  show(location.hash.slice(1));
  window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });

  document.querySelectorAll("[data-views]").forEach(function (group) {
    var of = group.dataset.views;
    group.querySelectorAll("button[data-view]").forEach(function (button) {
      button.addEventListener("click", function () {
        group.querySelectorAll("button[data-view]").forEach(function (b) { b.classList.toggle("on", b === button); });
        document.querySelectorAll('[data-view-of="' + of + '"]').forEach(function (v) { v.hidden = v.dataset.name !== button.dataset.view; });
      });
    });
  });

  document.querySelectorAll("table[data-sortable]").forEach(function (table) {
    var body = table.tBodies[0], active = "", direction = 1;
    table.querySelectorAll("th").forEach(function (th) { if (th.getAttribute("aria-sort") !== "none" && th.querySelector("button")) { active = th.querySelector("button").dataset.sort; direction = th.getAttribute("aria-sort") === "ascending" ? 1 : -1; } });
    table.querySelectorAll("th button[data-sort]").forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.dataset.sort, num = button.dataset.type === "num";
        direction = active === key ? -direction : num ? -1 : 1;
        active = key;
        var rows = Array.from(body.rows);
        rows.sort(function (a, b) {
          var x = a.dataset[key] || "", y = b.dataset[key] || "";
          return direction * (num ? Number(x) - Number(y) : x.localeCompare(y));
        });
        body.replaceChildren.apply(body, rows);
        table.querySelectorAll("th").forEach(function (th) { th.setAttribute("aria-sort", th.contains(button) ? (direction === 1 ? "ascending" : "descending") : "none"); });
      });
    });
  });

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var card = button.closest(".ops-prompt");
      var text = card.querySelector("p").textContent + "\n\n" + card.querySelector("pre").textContent;
      var label = button.textContent;
      navigator.clipboard.writeText(text).then(function () {
        button.textContent = "✓";
        setTimeout(function () { button.textContent = label; }, 1500);
      });
    });
  });
})();
