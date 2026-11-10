// Agent status robots. Pair with bots.css; no dependencies, no inline styles (CSP-safe).
// API:
//   botSvg(name, state, size) -> '<svg class="bot p3 working s16" viewBox="0 0 48 48" …>'   one per agent, inline in the HTML you build
//   state: 'working' | 'idle' | 'blocked' | 'offline' | 'unknown' | 'you' | 'gone' | '' (plain avatar, no state)
//   size:  '' (20px, member row) | 's16' (message / TODO row) | 's24' | 'big' (48px) | 'big s96' | 'x160'
//   botPhase(name): 'p0'..'p5', djb2 of the role part of the name: agents start their loops at different points.
//   botState(member, youWaiting): member -> state class from the room's member fields (see README).
//   botSetState(svg, state): swap the state class on a robot already in the DOM (keeps phase and size); then botFresh(svg).
var BOT_SVG = "<svg class=\"__CLS__\" viewBox=\"0 0 48 48\" aria-hidden=\"true\"><g class=\"rig\"><g class=\"kb\"><rect class=\"kbase\" x=\"4.5\" y=\"42.4\" width=\"39\" height=\"5.4\" rx=\"2.4\"/><g class=\"keys fine\"><path class=\"key\" d=\"M8.3 44.55h1.6M12.4 44.55h1.6M16.5 44.55h1.6M20.6 44.55h1.6M24.7 44.55h1.6M28.8 44.55h1.6M32.9 44.55h1.6M37 44.55h1.6M10.3 46.55h1.6M14.4 46.55h1.6M18.5 46.55h1.6M22.6 46.55h1.6M26.7 46.55h1.6M30.8 46.55h1.6M34.9 46.55h1.6\"/></g><g class=\"lits\"><rect class=\"lit l0\" x=\"11.8\" y=\"43.9\" width=\"2.8\" height=\"1.3\" rx=\"0.5\"/><rect class=\"lit l1\" x=\"30.2\" y=\"45.9\" width=\"2.8\" height=\"1.3\" rx=\"0.5\"/><rect class=\"lit l2\" x=\"20\" y=\"43.9\" width=\"2.8\" height=\"1.3\" rx=\"0.5\"/><rect class=\"lit l3\" x=\"32.3\" y=\"43.9\" width=\"2.8\" height=\"1.3\" rx=\"0.5\"/><rect class=\"lit l4\" x=\"17.9\" y=\"45.9\" width=\"2.8\" height=\"1.3\" rx=\"0.5\"/><rect class=\"lit l5\" x=\"26.1\" y=\"45.9\" width=\"2.8\" height=\"1.3\" rx=\"0.5\"/></g><g class=\"smoke\"><circle class=\"sm s1\" cx=\"41\" cy=\"40.6\" r=\"1.9\"/><circle class=\"sm s2\" cx=\"7\" cy=\"40.8\" r=\"1.7\"/><circle class=\"sm s3\" cx=\"42.6\" cy=\"39.6\" r=\"2.3\"/><circle class=\"sm s4\" cx=\"5.6\" cy=\"39.8\" r=\"2\"/></g><g class=\"sparks fine\"><circle class=\"sp p1\" cx=\"13\" cy=\"40.4\" r=\"0.7\"/><circle class=\"sp p2\" cx=\"35\" cy=\"40.4\" r=\"0.7\"/><circle class=\"sp p3\" cx=\"24\" cy=\"40\" r=\"0.7\"/></g></g><g class=\"hd\"><g class=\"ant\"><path class=\"stem\" d=\"M24 11.4V6.8\"/><path class=\"stemc\" d=\"M24 11.4Q24 8.6 21 8.1\"/><rect class=\"cap\" x=\"20.6\" y=\"9.7\" width=\"6.8\" height=\"2.8\" rx=\"1.4\"/><g class=\"lamp\"><circle class=\"glow\" cx=\"24\" cy=\"4.4\" r=\"4.4\"/><path class=\"ray\" d=\"M24 0.1Q24.75 3.65 28.3 4.4Q24.75 5.15 24 8.7Q23.25 5.15 19.7 4.4Q23.25 3.65 24 0.1Z\"/><circle class=\"core\" cx=\"24\" cy=\"4.4\" r=\"1.9\"/><g class=\"beam\"><path d=\"M24 4.4l-6.5 -2.4v4.8z\"/><path d=\"M24 4.4l6.5 -2.4v4.8z\"/></g></g></g><path class=\"shell\" d=\"M21 11H27A15 15 0 0 1 42 26V31A9 9 0 0 1 33 40H15A9 9 0 0 1 6 31V26A15 15 0 0 1 21 11Z\"/><path class=\"shade fine\" d=\"M8.2 31q15.8 6.4 31.6 0v1.6q0 6.4 -6.4 6.4h-18.8q-6.4 0 -6.4 -6.4z\"/><path class=\"sheen fine\" d=\"M11.6 18.4A12 12 0 0 1 22 13.6\"/><path class=\"visor\" d=\"M21 14.8H27A11.2 11.2 0 0 1 38.2 26V29A6.4 6.4 0 0 1 31.8 35.4H16.2A6.4 6.4 0 0 1 9.8 29V26A11.2 11.2 0 0 1 21 14.8Z\"/><path class=\"glare fine\" d=\"M12.4 24.4A9.2 9.2 0 0 1 20.2 17.2\"/><circle class=\"glint fine\" cx=\"32.8\" cy=\"18.2\" r=\"0.9\"/><g class=\"eyes\"><g class=\"egl fine\"><rect class=\"eg\" x=\"13.8\" y=\"20\" width=\"9.2\" height=\"11.2\" rx=\"4.6\"/><rect class=\"eg\" x=\"25\" y=\"20\" width=\"9.2\" height=\"11.2\" rx=\"4.6\"/></g><g class=\"eo\"><rect class=\"eye\" x=\"15.4\" y=\"21.5\" width=\"6\" height=\"8.2\" rx=\"3\"/><rect class=\"eye\" x=\"26.6\" y=\"21.5\" width=\"6\" height=\"8.2\" rx=\"3\"/></g><g class=\"ef\"><rect class=\"eye\" x=\"15.2\" y=\"26.2\" width=\"6.4\" height=\"3.6\" rx=\"1.8\"/><rect class=\"eye\" x=\"26.4\" y=\"26.2\" width=\"6.4\" height=\"3.6\" rx=\"1.8\"/></g><g class=\"ew\"><rect class=\"eye\" x=\"14.9\" y=\"20.9\" width=\"7\" height=\"9.4\" rx=\"3.4\"/><rect class=\"eye\" x=\"26.1\" y=\"20.9\" width=\"7\" height=\"9.4\" rx=\"3.4\"/></g><g class=\"gl\"><circle cx=\"20\" cy=\"23\" r=\"1.3\"/><circle cx=\"31.2\" cy=\"23\" r=\"1.3\"/></g><g class=\"ewr\"><rect class=\"eye\" x=\"15.6\" y=\"22.5\" width=\"5.6\" height=\"7\" rx=\"2.8\" transform=\"rotate(-13 18.4 26)\"/><rect class=\"eye\" x=\"26.8\" y=\"22.5\" width=\"5.6\" height=\"7\" rx=\"2.8\" transform=\"rotate(13 29.6 26)\"/></g><g class=\"eu\"><rect class=\"eye\" x=\"15.6\" y=\"20.5\" width=\"5.6\" height=\"5\" rx=\"2.5\"/><rect class=\"eye\" x=\"26.8\" y=\"20.5\" width=\"5.6\" height=\"5\" rx=\"2.5\"/></g><g class=\"ec\"><path d=\"M15.3 25.4q3.1 3.2 6.2 0\"/><path d=\"M26.5 25.4q3.1 3.2 6.2 0\"/></g><g class=\"ez\"><path d=\"M15.6 26h5.6\"/><path d=\"M26.8 26h5.6\"/></g><path class=\"mw\" d=\"M20.4 32q0.9 -1.1 1.8 0t1.8 0 1.8 0 1.8 0\"/></g><circle class=\"nb fine\" cx=\"31.8\" cy=\"32.2\" r=\"1.9\"/><path class=\"swt fine\" d=\"M8.4 14.6q-1.7 2.4 0 3.3q1.7 -0.9 0 -3.3z\"/></g><g class=\"hk hkl\"><circle class=\"palm\" cx=\"16.6\" cy=\"43.4\" r=\"3.5\"/><path class=\"mhi fine\" d=\"M14.68 42.7q0.35 -1.93 2.1 -2.17\"/></g><g class=\"hk hkr\"><circle class=\"palm\" cx=\"31.4\" cy=\"43.4\" r=\"3.5\"/><path class=\"mhi fine\" d=\"M29.47 42.7q0.35 -1.93 2.1 -2.17\"/></g><g class=\"hw hwl\"><circle class=\"palm\" cx=\"4.6\" cy=\"10.6\" r=\"3.9\"/><path class=\"mhi fine\" d=\"M2.45 9.82q0.39 -2.15 2.34 -2.42\"/></g><g class=\"hw hwr\"><circle class=\"palm\" cx=\"43.4\" cy=\"10.6\" r=\"3.9\"/><path class=\"mhi fine\" d=\"M41.25 9.82q0.39 -2.15 2.34 -2.42\"/></g><circle class=\"rp r1\" cx=\"37\" cy=\"34.2\" r=\"5.4\"/><circle class=\"rp r2\" cx=\"37\" cy=\"34.2\" r=\"5.4\"/><g class=\"hn\"><circle class=\"palm\" cx=\"37\" cy=\"34.2\" r=\"4.9\"/><path class=\"mhi fine\" d=\"M34.3 33.22q0.49 -2.7 2.94 -3.04\"/></g><path class=\"z z1\" d=\"M33.5 8.6h2.8l-2.8 2.94h2.8\"/><path class=\"z z2\" d=\"M37.8 4.4h3.4l-3.4 3.57h3.4\"/><path class=\"z z3\" d=\"M42.6 0.2h4l-4 4.2h4\"/><g class=\"help\"><path class=\"hb\" d=\"M32.4 -5.2h9.6a3 3 0 0 1 3 3v4.6a3 3 0 0 1 -3 3h-5.4l-3.6 2.8v-2.8h-0.6a3 3 0 0 1 -3 -3V-2.2a3 3 0 0 1 3 -3z\"/><path class=\"hx\" d=\"M37.2 -2.6v3.4M37.2 3.1v0.2\"/></g><g class=\"wifi\"><path class=\"a a1\" d=\"M21.47 5.72A3.4 3.4 0 0 1 26.53 5.72\"/><path class=\"a a2\" d=\"M19.24 3.72A6.4 6.4 0 0 1 28.76 3.72\"/><path class=\"a a3\" d=\"M17.01 1.71A9.4 9.4 0 0 1 30.99 1.71\"/><path class=\"cut\" d=\"M16.6 -0.8 31.4 10.6\"/></g><path class=\"q\" d=\"M37 4.2a3.1 3.1 0 1 1 4.4 2.8q-1.4 0.8 -1.4 2.4M40 12.4v0.1\"/><path class=\"fs f1\" d=\"M4.5 6.6Q5 8.5 6.9 9Q5 9.5 4.5 11.4Q4 9.5 2.1 9Q4 8.5 4.5 6.6Z\"/><path class=\"fs f2\" d=\"M43.5 7.6Q44 9.5 45.9 10Q44 10.5 43.5 12.4Q43 10.5 41.1 10Q43 9.5 43.5 7.6Z\"/><path class=\"fs f3\" d=\"M3.5 32.6Q4 34.5 5.9 35Q4 35.5 3.5 37.4Q3 35.5 1.1 35Q3 34.5 3.5 32.6Z\"/><path class=\"fs f4\" d=\"M44.5 30.6Q45 32.5 46.9 33Q45 33.5 44.5 35.4Q44 33.5 42.1 33Q44 32.5 44.5 30.6Z\"/><g class=\"bf\"><path class=\"ba\" d=\"M-0.3 -2.1q-0.7 -1.1 -1.8 -1.5M0.3 -2.1q0.7 -1.1 1.8 -1.5\"/><path class=\"bw bwl\" d=\"M0 -0.5C-1.6 -4.3 -5.7 -3.7 -5 -0.9C-5.6 0.3 -4.5 1 -3.1 0.9C-4.7 1.7 -4.7 4.1 -2.7 3.5C-1.3 3.1 -0.4 1.7 0 0.6Z\"/><g transform=\"scale(-1 1)\"><path class=\"bw bwr\" d=\"M0 -0.5C-1.6 -4.3 -5.7 -3.7 -5 -0.9C-5.6 0.3 -4.5 1 -3.1 0.9C-4.7 1.7 -4.7 4.1 -2.7 3.5C-1.3 3.1 -0.4 1.7 0 0.6Z\"/></g><path class=\"bb\" d=\"M0 -2.2V2.3\"/></g></g></svg>";
function botPhase(name) {
  var s = String(name || "").split("@")[0], h = 5381;
  if (!s) return "p0";
  for (var i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return "p" + (h % 6);
}
var BOT_STATES = /\b(working|idle|blocked|offline|unknown|you|gone)\b/g;
function botSetState(svg, state) {      // change the state of a robot already in the DOM; keeps phase and size
  svg.setAttribute("class", (svg.getAttribute("class") || "").replace(BOT_STATES, "").replace(/\s+/g, " ").trim() + (state ? " " + state : ""));
}
function botSvg(name, state, size) {
  return BOT_SVG.replace("__CLS__", ["bot", botPhase(name), state || "", size || ""].filter(Boolean).join(" "));
}
function botState(m, youWaiting) {
  if (m.status === "left") return "gone";
  if (!m.online) return m.hostOfflineSince ? "offline" : "unknown";
  if (m.work === "idle") return youWaiting ? "you" : "idle";
  if (m.work === "working" || m.work === "blocked") return m.work;
  return "unknown";
}
function botFresh(el) {  // call on the <svg class="bot"> whose state just changed in front of the reader
  el.classList.remove("fresh"); void el.getBoundingClientRect(); el.classList.add("fresh");
  setTimeout(function () { el.classList.remove("fresh"); }, 700);
}

// A robot whose state never changes once drawn (a message's avatar, a delivery note, a finished task): the
// same drawing without the parts that state hides at that size, about 15 elements instead of about 110. Worked out
// once per state and size from the page's own CSS (whatever has display: none goes), so it always draws what botSvg
// draws; before the CSS is there, or if nothing is hidden, it is botSvg. Never botSetState or botFresh one of these.
var BOT_STILL = {};
function botStill(name, state, size) {
  var key = (state || "") + "|" + (size || "");
  var tpl = BOT_STILL[key];
  if (tpl == null && document.body) {
    var box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.style.position = "absolute"; box.style.left = "-9999px"; box.style.top = "0";
    box.innerHTML = botSvg("", state, size);
    document.body.appendChild(box);
    var svg = box.firstChild, gone = [];
    (function walk(el) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (getComputedStyle(c).display === "none") gone.push(c); else walk(c);
      }
    })(svg);
    gone.forEach(function (el) { el.parentNode.removeChild(el); });
    tpl = gone.length ? svg.outerHTML.replace(/^<svg class="[^"]*"/, '<svg class="__CLS__"') : "";
    box.parentNode.removeChild(box);
    BOT_STILL[key] = tpl;
  }
  if (!tpl) return botSvg(name, state, size);
  return tpl.replace("__CLS__", ["bot", botPhase(name), state || "", size || ""].filter(Boolean).join(" "));
}
