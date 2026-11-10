// One effective theme for every stylesheet: write dark rules under
// :root[data-scorpio-effective-theme="dark"], never a prefers-color-scheme media rule.
(function () {
  "use strict";
  try { if (localStorage.getItem("scorpio.leftOpen") === "0") document.documentElement.dataset.scorpioSide = "folded"; } catch (e) {}
  var system = window.matchMedia("(prefers-color-scheme: dark)");
  var selected = "system";

  function apply(mode) {
    if (mode !== "light" && mode !== "dark") mode = "system";
    selected = mode;
    var root = document.documentElement;
    root.dataset.scorpioTheme = mode;
    root.dataset.scorpioEffectiveTheme = mode === "system" ? (system.matches ? "dark" : "light") : mode;
    paintScheme(mode);
    paintTop();
  }

  // What the browser paints before the stylesheets apply, as on a reload when coming back to a page:
  // the layout's meta says "light dark", the system's choice. A theme picked here replaces it, or a dark phone shows
  // black before a light page. The meta comes before this script, so it is there to change.
  function paintScheme(mode) {
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = mode === "system" ? "light dark" : mode;
  }

  // The phone's top edge (theme-color) follows the theme picked here, not only the system's: the page's two
  // metas give its light and its dark colour, and both are set to the one in use. They come after this script,
  // so the first paint waits for DOMContentLoaded.
  var tops = null;
  function paintTop() {
    if (!tops) {
      var ms = document.querySelectorAll('meta[name="theme-color"][media]');
      if (!ms.length) return;
      tops = [];
      for (var i = 0; i < ms.length; i++) tops.push({ el: ms[i], dark: /dark/.test(ms[i].media), color: ms[i].content });
    }
    var dark = document.documentElement.dataset.scorpioEffectiveTheme === "dark";
    var want = null;
    for (var j = 0; j < tops.length; j++) if (tops[j].dark === dark) want = tops[j].color;
    if (want) for (var k = 0; k < tops.length; k++) tops[k].el.content = want;
  }
  document.addEventListener("DOMContentLoaded", paintTop);

  window.scorpioThemeSet = function (mode) {
    try { localStorage.setItem("scorpio.theme", mode); } catch (e) {}
    apply(mode);
    document.dispatchEvent(new Event("scorpio-theme"));
  };

  try { selected = localStorage.getItem("scorpio.theme") || "system"; } catch (e) {}
  apply(selected);
  var changed = function () {
    if (selected !== "system") return;
    apply(selected);
    document.dispatchEvent(new Event("scorpio-theme"));
  };
  if (system.addEventListener) system.addEventListener("change", changed);
  else system.addListener(changed);
})();
