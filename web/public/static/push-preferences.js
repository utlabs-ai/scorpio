// Device preferences follow a browser's PushSubscription endpoint. Before subscribing, only room mute markers are local.
(function () {
  "use strict";
  var PREFIX = 'scorpio.mutedRooms.';
  var ROOM = /^[A-Za-z0-9_-]{22}$/;
  function localRooms(account) {
    try {
      var rooms = JSON.parse(localStorage.getItem(PREFIX + account) || '[]');
      return Array.isArray(rooms) ? rooms.filter(function (id) { return typeof id === 'string' && ROOM.test(id); }) : [];
    } catch (e) { return []; }
  }
  function saveLocal(account, rooms) {
    try { localStorage.setItem(PREFIX + account, JSON.stringify(rooms)); } catch (e) {}
  }
  function endpoint() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager ? reg.pushManager.getSubscription() : null;
    }).then(function (sub) { return sub ? sub.endpoint : null; });
  }
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw data; return data; }); });
  }
  function localView(account) {
    return { endpoint: null, prefs: { todoAssigned: true, quotaWarn: true, sound: true, mutedRooms: localRooms(account) } };
  }
  function read(account) {
    return endpoint().then(function (current) {
      if (!current) return localView(account);
      return post('/push/preferences/read', { endpoint: current }).then(function (prefs) {
        var local = localRooms(account);
        var pending = local.filter(function (id) { return prefs.mutedRooms.indexOf(id) < 0; });
        return pending.reduce(function (chain, roomId) {
          return chain.then(function (latest) {
            return post('/push/preferences/write', { endpoint: current, roomId: roomId, muted: true }).catch(function (error) {
              if (error && error.error === 'room_not_found') return latest;
              throw error;
            });
          });
        }, Promise.resolve(prefs)).then(function (updated) {
          if (local.length) saveLocal(account, []);
          return { endpoint: current, prefs: updated };
        });
      });
    });
  }
  function write(account, change) {
    return endpoint().then(function (current) {
      if (current) return post('/push/preferences/write', Object.assign({ endpoint: current }, change)).then(function (prefs) {
        return { endpoint: current, prefs: prefs };
      });
      if (!ROOM.test(change.roomId || '') || typeof change.muted !== 'boolean') throw new Error('Turn on push notifications on this device first.');
      var rooms = localRooms(account).filter(function (id) { return id !== change.roomId; });
      if (change.muted) rooms.push(change.roomId);
      saveLocal(account, rooms);
      return Promise.resolve(localView(account));
    });
  }
  window.scorpioPushPrefs = { read: read, write: write, remember: saveLocal };
})();
