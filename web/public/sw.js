// Scorpio's service worker: shows a push, opens the room on a tap, and closes
// notifications that are no longer true (the item was done, deleted or handed on) whenever it runs.
"use strict";
var zh = /^zh/i.test((self.navigator && self.navigator.language) || "");

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

function show(p) {
  var s = (p.shown && p.shown[zh ? "zh" : "en"]) || {};
  var title = s.title || "Scorpio", body = s.body != null ? s.body : (p.text || "");
  return self.registration.showNotification(title, {
    body: body,
    silent: p.silent === true,
    tag: p.tag || undefined,
    data: { url: p.url || "/" },
    icon: "/static/icons/icon-192.png",
    badge: "/static/badge-72.png",
  });
}

/** Ask the server which of the notifications showing are stale, and close those (no silent push needed). */
function sweep() {
  return self.registration.getNotifications().then(function (list) {
    var tags = list.map(function (n) { return n.tag; }).filter(function (t) { return t && (t.indexOf("todo:") === 0 || t.indexOf("blocked:") === 0); });
    if (!tags.length) return;
    return fetch("/push/resolved", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: tags }), credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : { stale: [] }; })
      .then(function (j) { list.forEach(function (n) { if ((j.stale || []).indexOf(n.tag) >= 0) n.close(); }); });
  }).catch(function () {});
}

self.addEventListener("push", function (e) {
  var p = {};
  try { p = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(show(p).then(sweep));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (open) {
    for (var i = 0; i < open.length; i++) {
      var c = open[i];
      if (c.url.split("#")[0] === url.split("#")[0] && "focus" in c) return c.focus().then(function (w) { return w && w.navigate ? w.navigate(url) : w; });
    }
    return self.clients.openWindow(url);
  }));
});

// A page opened: a chance to close what is stale.
self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "sweep") e.waitUntil(sweep());
});
