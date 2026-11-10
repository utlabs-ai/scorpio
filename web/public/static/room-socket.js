// One ordered WebSocket dispatch for the topic page.
(function () {
  "use strict";

  window.createRoomSocket = function (ctx) {
    var ws = null, retry = 0, pingTimer = null, reconnectTimer = null, probeTimer = null, stopped = false, listening = false;
    var handlers = {}, path = ctx.path || "/r/" + ctx.roomId + "/ws", readyType = ctx.readyType || "hello", first = true;
    var replayAfterHello = { message: true, files: true, cursor: true, approvals: true };

    function on(type, fn) { handlers[type] = fn; }
    function send(text) { if (ws && ws.readyState === 1) ws.send(text); }
    // Nobody is pushed about a topic they are looking at. A page that shows no message text (the overview) opens with
    // viewing: false: it says hidden and never visible, so pushes and approval cards keep reaching the person.
    function tellVisibility() { if (readyType === "hello") send(ctx.viewing === false || document.visibilityState !== "visible" ? "hidden" : "visible"); }
    function visibility() {
      tellVisibility();
      if (document.visibilityState === "visible") resume();
    }
    // Back on the page, or the network is back: connect now instead of waiting out the backoff. iOS
    // often hands back a dead socket that still reads open, so an open one must answer a ping within 5 seconds.
    function resume() {
      if (stopped) return;
      retry = 0;
      if (!ws) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        return connect();
      }
      if (ws.readyState !== 1 || probeTimer) return;
      var probed = ws;
      send("ping");
      probeTimer = setTimeout(function () {
        probeTimer = null;
        if (stopped || ws !== probed) return;
        drop();
        ctx.status.status("connection", ctx.reconnecting);
        connect();
      }, 5000);
    }
    /** Let go of the current socket without its close event. */
    function drop() {
      clearInterval(pingTimer);
      pingTimer = null;
      clearTimeout(probeTimer);
      probeTimer = null;
      if (!ws) return;
      var closing = ws;
      ws = null;
      closing.onclose = null;
      try { closing.close(); } catch (e) {}
    }

    function stop() {
      stopped = true;
      if (listening) {
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("online", resume);
        listening = false;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      drop();
    }

    function connect() {
      if (stopped) return;
      if (!listening) {
        document.addEventListener("visibilitychange", visibility);
        window.addEventListener("online", resume);
        listening = true;
      }
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      var early = first && window.scorpioEarly;
      first = false;
      window.scorpioEarly = null;
      window.scorpioRoomStarted = true;
      if (early && early.ws.url.slice(-path.length) !== path) { try { early.ws.close(); } catch (e) {} early = null; }
      ws = early ? early.ws : new WebSocket(proto + "//" + location.host + path);
      var current = ws, helloSeen = false, held = [];
      if (retry) ctx.status.status("connection", ctx.reconnecting);

      current.onopen = function () {
        if (stopped || ws !== current) return;
        retry = 0;
        tellVisibility();
        ctx.status.clear("connection");
        clearInterval(pingTimer);
        pingTimer = setInterval(function () { send("ping"); }, 30000);
      };
      current.onmessage = function (ev) {
        if (stopped || ws !== current) return;
        if (ev.data === "pong") { clearTimeout(probeTimer); probeTimer = null; return; }
        var frame;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        if (!frame || !frame.type) return;
        if (frame.type === "removed" || frame.type === "deleted") {
          if (handlers[frame.type]) handlers[frame.type](frame);
          return;
        }
        if (frame.type === readyType) {
          helloSeen = true;
          if (ctx.hello) ctx.hello(frame);
          else if (handlers[readyType]) handlers[readyType](frame);
          held.forEach(function (item) { if (replayAfterHello[item.type] && handlers[item.type]) handlers[item.type](item); });
          held = [];
          return;
        }
        if (!helloSeen) { held.push(frame); return; }
        if (frame.type === "members") ctx.members(frame);
        else if (handlers[frame.type]) handlers[frame.type](frame);
      };
      current.onclose = function (ev) {
        if (stopped || ws !== current) return;
        clearInterval(pingTimer);
        pingTimer = null;
        clearTimeout(probeTimer);
        probeTimer = null;
        ws = null;
        held = [];
        if (ctx.onDisconnect) ctx.onDisconnect();
        if (ev.code === 4004) return ctx.removed ? ctx.removed() : stop();
        if (ev.code === 4010) return ctx.gone ? ctx.gone() : stop();
        retry++;
        ctx.status.status("connection", ctx.reconnecting);
        reconnectTimer = setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry)));
      };
      // The early connection collected its open, then frames, then close in that order.
      if (early) {
        if (early.open) current.onopen();
        early.frames.forEach(function (data) { if (ws === current) current.onmessage({ data: data }); });
        if (early.closed && ws === current) current.onclose(early.closed);
      }
    }

    return { on: on, connect: connect, send: send, stop: stop };
  };
})();
