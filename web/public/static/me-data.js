(function () {
  "use strict";
  var table = document.getElementById("me-data-table");
  if (!table) return;
  var body = table.tBodies[0], active = "", direction = 1;
  table.querySelectorAll("th button[data-sort]").forEach(function (button) {
    button.addEventListener("click", function () {
      var key = button.dataset.sort;
      direction = active === key ? -direction : 1;
      active = key;
      var rows = Array.from(body.rows);
      rows.sort(function (a, b) {
        var x = a.dataset[key], y = b.dataset[key];
        if (key === "name") return direction * x.localeCompare(y);
        x = Number(x); y = Number(y);
        if (x < 0) return 1;
        if (y < 0) return -1;
        return direction * (x - y);
      });
      body.replaceChildren.apply(body, rows);
      table.querySelectorAll("th").forEach(function (th) { th.setAttribute("aria-sort", th.contains(button) ? direction === 1 ? "ascending" : "descending" : "none"); });
    });
  });
})();
