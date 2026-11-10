// Daemon icon, a terminal. Pair with daemon.css; no dependencies, no inline styles (CSP-safe).
//   daemonSvg(state, size) -> '<svg class="dmn term s15" viewBox="0 0 48 48" aria-hidden="true">…</svg>'
//   state: '' (on: its computer is up; also the chat avatar) | 'offline' (its computer is offline)
//   size:  '' (20px) | 's15' | 's16' | 's24' | 'big' (48px) | 'big s96'
var DAEMON_SVG = "<svg class=\"__CLS__\" viewBox=\"0 0 48 48\" aria-hidden=\"true\"><rect class=\"base\" x=\"14.4\" y=\"39.8\" width=\"19.2\" height=\"3.6\" rx=\"1.8\"/><path class=\"neck\" d=\"M20.6 36h6.8l1.1 4h-9z\"/><rect class=\"shell\" x=\"3.6\" y=\"8.6\" width=\"40.8\" height=\"27.6\" rx=\"7.2\"/><path class=\"shade fine\" d=\"M4.6 29.4q19.4 4 38.8 0v0.8a5.2 5.2 0 0 1 -5.2 5.2h-28.4a5.2 5.2 0 0 1 -5.2 -5.2z\"/><path class=\"sheen fine\" d=\"M5.8 15.6a6.2 6.2 0 0 1 5 -4.9\"/><rect class=\"visor\" x=\"6.8\" y=\"11.8\" width=\"34.4\" height=\"21.2\" rx=\"4.4\"/><path class=\"glare fine\" d=\"M10.4 19.6a6.6 6.6 0 0 1 5.6 -5\"/><circle class=\"glint fine\" cx=\"37.2\" cy=\"15.4\" r=\"0.9\"/><path class=\"slash\" d=\"M15.4 29.2 21.4 15.6\"/><rect class=\"cursor\" x=\"24.8\" y=\"25.2\" width=\"8.8\" height=\"4\" rx=\"1.4\"/></svg>";
function daemonSvg(state, size) {
  return DAEMON_SVG.replace("__CLS__", ["dmn", "term", state, size].filter(Boolean).join(" "));
}
