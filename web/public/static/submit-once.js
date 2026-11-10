// A form marked data-once sends once (on the ops page a second tap two seconds after the
// first cut the first request short). At the first submit its button is disabled and shows the data-once text;
// another submit of that form is dropped.
"use strict";
document.addEventListener("submit", function (e) {
  var f = e.target;
  if (!f || !f.matches || !f.matches("form[data-once]")) return;
  if (f.getAttribute("data-sent")) { e.preventDefault(); return; }
  f.setAttribute("data-sent", "1");
  var b = f.querySelector("button");
  if (!b) return;
  // After this event: a button disabled now would not be the form's submitter any more.
  setTimeout(function () { b.disabled = true; if (f.getAttribute("data-once")) b.textContent = f.getAttribute("data-once"); }, 0);
}, true);
