// A file's own page (/v/<fileId>): Markdown, plain text, SVG and HTML open in a frame on the content domain.
// Each opening asks for a ticket first (60 s, this file); the frame's host is new every time. The only thing the
// frame may tell this page is a link it wants opened (scorpio:open): the strip under the bar shows the whole address
// and opens it only when the person says so. On a phone the bar folds to one line.
(function () {
  "use strict";
  var boot = JSON.parse(document.getElementById("fv-boot").textContent);
  var main = document.getElementById("fv-content");
  var strip = document.getElementById("fv-link");
  var frame = null;
  var frameOrigin = null;
  var loads = 0; // HTML: loads still to come of the address we set; another one means the page went somewhere else
  var pinged = 0; // HTML: the last question sent after a load (scorpio:ping n); 0 once answered
  var pongWait = null;
  var asked = 0; // the last ticket asked for: an answer to an older one is dropped
  var shownAt = 0; // when the link strip last changed: 「打开」 waits a moment after that

  function theme() {
    return document.documentElement.dataset.scorpioEffectiveTheme === "dark" ? "dark" : "light";
  }

  /** The frame's place: there already, or in place of the run card once it is clicked. */
  function box() {
    var b = document.getElementById("fv-frame");
    if (!b) {
      b = document.createElement("div");
      b.className = "fv-frame";
      b.id = "fv-frame";
      main.replaceChildren(b);
    }
    return b;
  }

  function failed(text) {
    clearTimeout(pongWait);
    pinged = 0;
    // Nothing is running any more: the amber strip that said so goes with the frame.
    var who = document.getElementById("fv-who");
    if (who) who.hidden = true;
    var b = box();
    b.className = "fv-frame failed";
    b.textContent = typeof text === "string" ? text : boot.failed;
    frame = null;
    strip.hidden = true;
  }

  /**
   * After a load, ask the frame whether it is still the file (the link bridge in it answers; nothing else on that
   * origin can, and no other origin is listened to). No answer within a few tries: it went elsewhere in a way the load
   * count missed (a page holding back its own load, then leaving; Firefox, Safari), and the frame goes.
   */
  function ping(tries) {
    if (!frame) return;
    var n = Date.now() + Math.random();
    pinged = n;
    try { frame.contentWindow.postMessage({ type: "scorpio:ping", n: n }, frameOrigin); } catch (e) {}
    clearTimeout(pongWait);
    pongWait = setTimeout(function () {
      if (pinged !== n) return;
      if (tries > 1) ping(tries - 1); // a busy page (a big chart drawing) may answer late
      else failed(boot.moved);
    }, 800);
  }

  function open() {
    var me = ++asked;
    fetch(boot.ticket, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ theme: theme() }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (t) {
        if (me !== asked) return; // a newer one is on its way (the theme switched twice)
        frameOrigin = new URL(t.url).origin;
        loads = 1;
        if (frame) {
          frame.src = t.url;
          return;
        }
        frame = document.createElement("iframe");
        frame.setAttribute("sandbox", boot.sandbox);
        frame.setAttribute("referrerpolicy", "no-referrer");
        // Chrome holds every document of this frame to the policy (the content host agrees); others ignore it.
        if (boot.csp) frame.setAttribute("csp", boot.csp);
        frame.title = boot.name;
        frame.src = t.url; // before it is in the page: no empty document loads first
        box().appendChild(frame);
        // HTML loads once. Another load is the page leaving it (a link, a script, a refresh; a blocked one too): the
        // frame goes, rather than show whatever it went to under our bar; and after its load it must say it is the
        // file. Markdown, plain text and SVG run no script and cannot leave (a theme change loads them again).
        if (boot.kind === "html") {
          frame.addEventListener("load", function () {
            if (loads > 0) loads--;
            else return failed(boot.moved);
            ping(3);
          });
        }
      })
      .catch(failed);
  }

  window.addEventListener("message", function (ev) {
    if (!frame || ev.source !== frame.contentWindow || ev.origin !== frameOrigin) return;
    var d = ev.data;
    if (d && d.type === "scorpio:pong" && pinged && d.n === pinged) {
      pinged = 0;
      clearTimeout(pongWait);
      return;
    }
    if (!d || d.type !== "scorpio:open" || typeof d.url !== "string") return;
    var u;
    try { u = new URL(d.url); } catch (x) { return; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    strip.querySelector(".fv-url").textContent = u.href;
    strip.querySelector(".fv-open").href = u.href;
    strip.hidden = false;
    shownAt = Date.now();
  });
  // A click within half a second of the strip appearing (or its address changing) is not taken: the page under it
  // cannot time a click of the person's onto 「打开」.
  function openLink(ev) {
    if (Date.now() - shownAt < 500) { ev.preventDefault(); return; }
    strip.hidden = true;
  }
  strip.querySelector(".fv-open").addEventListener("click", openLink);
  strip.querySelector(".fv-open").addEventListener("auxclick", openLink); // a middle click opens a tab too
  strip.querySelector(".fv-cancel").addEventListener("click", function () { strip.hidden = true; });

  // A phone: the bar folds to the name and ⌄ (an image starts folded: the picture is what one came for).
  var fold = document.querySelector(".fv-fold");
  function setFolded(on) {
    document.body.classList.toggle("folded", on);
    fold.setAttribute("aria-expanded", on ? "false" : "true");
    fold.setAttribute("aria-label", on ? boot.unfold : boot.fold);
    fold.querySelector("path").setAttribute("d", on ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6");
  }
  fold.addEventListener("click", function () { setFolded(!document.body.classList.contains("folded")); });
  if (boot.kind === "image" && window.matchMedia("(max-width: 760px)").matches) setFolded(true);
  // The file this is, in the row of the message's files: in sight (on a phone the row scrolls).
  var on = document.querySelector(".fv-f.on");
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "center" });

  if (!boot.framed) return;
  var run = document.getElementById("fv-run");
  if (run) run.addEventListener("click", function () {
    var who = document.getElementById("fv-who");
    if (who) who.hidden = false; // whose page is running, once it runs
    open();
  });
  else open();
  // Markdown, plain text and SVG follow the theme; a running page is left as it is.
  document.addEventListener("scorpio-theme", function () {
    if (frame && boot.kind !== "html") open();
  });
})();
