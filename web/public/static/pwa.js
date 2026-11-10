// Every page: the service worker (add to home screen, Web Push), and on the home page the
// one switch for notifications on this device. iPhones push only to the app added to the home screen.
(function () {
  "use strict";
  var sw = "serviceWorker" in navigator;
  if (sw) {
    navigator.serviceWorker.register("/sw.js").then(function (reg) {
      // A page opened: notifications about things no longer mine can go.
      if (reg.active) reg.active.postMessage({ type: "sweep" });
    }).catch(function () {});
  }

  var box = document.getElementById("push");
  if (!box) return;
  var S = JSON.parse(box.dataset.s || "{}");
  var txt = box.querySelector(".txt"), btns = box.querySelector(".btns");
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);

  function b64(s) {
    var t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(t, function (c) { return c.charCodeAt(0); });
  }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (j) {
        if (!r.ok) {
          var retry = Number(r.headers.get("retry-after"));
          if (retry > 0) j.retryAfter = retry;
          throw j;
        }
        return j;
      }); });
  }
  function render(state, note) {
    box.classList.remove("hidden");
    box.dataset.state = state;
    txt.textContent = note || S[state] || "";
    var b = [];
    if (state === "off") b.push(["on", S.turnOn, "primary"]);
    if (state === "on") b.push(["test", S.test, ""], ["off", S.turnOff, ""]);
    btns.innerHTML = b.map(function (x) { return '<button type="button" class="btn ' + x[2] + '" data-push="' + x[0] + '">' + x[1] + "</button>"; }).join("");
  }
  function current() {
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription().then(function (sub) { return { reg: reg, sub: sub }; }); });
  }

  var key = null;
  if (!sw || !("PushManager" in window) || !("Notification" in window)) {
    if (ios && !standalone) render("ios");
    else render("unsupported");
    return;
  }
  fetch("/push/key", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) {
    key = j.publicKey;
    if (!key) return render("unconfigured"); // no switch until this server has a public key
    if (Notification.permission === "denied") return render("denied");
    return current().then(function (c) { render(c.sub ? "on" : "off"); });
  }).catch(function () {});

  box.addEventListener("click", function (e) {
    var b = e.target.closest("[data-push]");
    if (!b) return;
    b.disabled = true;
    var act = b.dataset.push;
    if (act === "on") {
      Notification.requestPermission().then(function (p) {
        if (p !== "granted") return render(p === "denied" ? "denied" : "off");
        return current().then(function (c) {
          return c.sub || c.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
        }).then(function (sub) {
          return post("/push/subscribe", sub.toJSON());
        }).then(function () { render("on", S.nowOn); document.dispatchEvent(new Event('scorpio-push-change')); });
      }).catch(function (err) { render("off", S.failed + " " + ((err && (err.next || err.message)) || "")); });
    } else if (act === "off") {
      current().then(function (c) {
        if (!c.sub) return;
        var endpoint = c.sub.endpoint;
        var save = window.scorpioPushPrefs && box.dataset.account
          ? window.scorpioPushPrefs.read(box.dataset.account).then(function (current) {
              window.scorpioPushPrefs.remember(box.dataset.account, current.prefs.mutedRooms);
            }).catch(function () {})
          : Promise.resolve();
        return save.then(function () { return c.sub.unsubscribe(); }).then(function () { return post("/push/unsubscribe", { endpoint: endpoint }); });
      }).then(function () { render("off"); document.dispatchEvent(new Event('scorpio-push-change')); }, function (err) {
        current().then(function (c) { render(c.sub ? "on" : "off", S.offFailed + " " + ((err && (err.next || err.message)) || "")); },
          function () { render("off", S.offFailed); });
        document.dispatchEvent(new Event('scorpio-push-change'));
      });
    } else if (act === "test") {
      post("/push/test").then(function (j) { render("on", j.sent ? S.testSent : S.testNone); }, function (err) {
        if (err && err.error === "rate_limited") return render("on", err.retryAfter ? S.testWait.replace("{s}", err.retryAfter) : err.next);
        render("on", S.failed + " " + ((err && err.next) || ""));
      });
    }
  });
})();
