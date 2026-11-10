// The public homepage: 「复制」 copies the install command, and
// the poster plays the film in its own frame. The other site pages load it too, for the language menu.
// No clipboard: the command on the page is selected and the page says to press ⌘C / Ctrl+C.
(function () {
  // The language menu in the site's top row, on every site page: a <details> opens it; here
  // it also gets hx-open and aria-expanded, and a click outside it or Esc closes it.
  var menus = document.querySelectorAll(".hx-langwrap");
  menus.forEach(function (menu) {
    menu.addEventListener("toggle", function () {
      menu.classList.toggle("hx-open", menu.open);
      menu.querySelector("summary").setAttribute("aria-expanded", String(menu.open));
    });
  });
  function closeMenus(keep) {
    menus.forEach(function (menu) { if (menu !== keep && menu.open) menu.open = false; });
  }
  document.addEventListener("click", function (ev) { closeMenus(ev.target.closest && ev.target.closest(".hx-langwrap")); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var open = document.querySelector(".hx-langwrap[open]");
    if (!open) return;
    closeMenus(null);
    open.querySelector("summary").focus();
  });

  var home = document.querySelector(".home[data-sx-sentence]");
  if (!home) return;
  var sentence = home.getAttribute("data-sx-sentence");
  var CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';

  // A computer's 「复制」 (.hx-copybtn) keeps its word and its width, so the command never moves: its icon turns into a
  // check, and the first screen's label line says what happened. For 3 seconds, then all of it comes back.
  function sayBox(btn, text, ok) {
    var run = btn.closest(".hx-box").querySelector(".hx-run");
    var icon = btn.querySelector("svg");
    clearTimeout(btn._sxBack);
    if (!btn.hasAttribute("data-sx-icon")) btn.setAttribute("data-sx-icon", icon.innerHTML);
    if (run && !run.hasAttribute("data-sx-label")) run.setAttribute("data-sx-label", run.textContent);
    if (ok) { btn.classList.add("hx-done"); icon.innerHTML = CHECK; }
    if (run) { run.textContent = text; run.classList.toggle("hx-ok", ok); }
    btn._sxBack = setTimeout(function () {
      btn.classList.remove("hx-done");
      icon.innerHTML = btn.getAttribute("data-sx-icon");
      if (run) { run.textContent = run.getAttribute("data-sx-label"); run.classList.remove("hx-ok"); }
    }, 3000);
  }

  // A phone's full-width 「复制」 says it on the button, for 3 seconds.
  function sayButton(btn, text) {
    var label = btn.querySelector("span");
    if (!btn.hasAttribute("data-sx-label")) btn.setAttribute("data-sx-label", label.textContent);
    clearTimeout(btn._sxBack);
    label.textContent = text;
    btn._sxBack = setTimeout(function () { label.textContent = btn.getAttribute("data-sx-label"); }, 3000);
  }

  function say(btn, ok) {
    var text = home.getAttribute(ok ? "data-sx-copied" : "data-sx-keys");
    if (btn.classList.contains("hx-copybtn")) sayBox(btn, text, ok);
    else sayButton(btn, text);
  }

  // The command in the button's own box is selected, for the old copy command or for ⌘C / Ctrl+C.
  function selectShown(btn) {
    var range = document.createRange();
    range.selectNodeContents(btn.closest(".hx-box").querySelector(".hx-cmd"));
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { return document.execCommand("copy"); } catch (_) { return false; }
  }

  function copy(btn) {
    var fallback = function () { say(btn, selectShown(btn)); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(sentence).then(function () { say(btn, true); }, fallback);
    else fallback();
  }

  document.querySelectorAll("[data-sx-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () { copy(btn); });
  });

  // The film: a click puts the video in the poster's frame and plays it from the start with sound, once,
  // with the native controls (full screen too). Nothing of it is downloaded before the click.
  document.querySelectorAll("[data-hx-film]").forEach(function (poster) {
    poster.addEventListener("click", function () {
      var frame = document.createElement("div");
      frame.className = poster.className;
      var video = document.createElement("video");
      video.src = poster.getAttribute("data-hx-film");
      video.poster = poster.querySelector("img").src;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("aria-label", poster.getAttribute("aria-label"));
      frame.appendChild(video);
      poster.replaceWith(frame);
      video.focus();
      var played = video.play();
      if (played && played.catch) played.catch(function () {});
    });
  });
})();
