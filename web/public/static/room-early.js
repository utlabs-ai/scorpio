// The topic page's socket, opened while the page is still loading: without this the page waited for its
// eleven deferred scripts before it even started to connect. It only collects what arrives; room.js adopts the socket
// in connect() and replays the frames, the open and a close. Linked async and first on the topic page only, so it may
// also run after room.js has connected: then it does nothing.
(function () {
  var m = /^\/r\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  if (!m || window.scorpioEarly || window.scorpioRoomStarted || typeof WebSocket !== "function") return;
  var ws;
  try {
    ws = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/r/" + m[1] + "/ws");
  } catch (e) {
    return;
  }
  var early = (window.scorpioEarly = { ws: ws, frames: [], open: false, closed: null });
  ws.onopen = function () { early.open = true; };
  ws.onmessage = function (ev) { early.frames.push(ev.data); };
  ws.onclose = function (ev) { early.closed = { code: ev.code, reason: ev.reason }; };
})();
