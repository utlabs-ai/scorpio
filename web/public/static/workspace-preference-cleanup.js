// An unauthenticated sign-in page also clears preferences after remote account deletion.
(function () {
  'use strict';
  var account = document.currentScript.dataset.account;
  function clear(name) {
    var prefix = 'view-files-directory-v1:' + (name ? name + ':' : '');
    try { for (var i = localStorage.length - 1; i >= 0; i--) { var key = localStorage.key(i); if (key && key.startsWith(prefix)) localStorage.removeItem(key); } } catch (e) {}
  }
  if (!account) clear('');
  else document.addEventListener('submit', function (event) { if (event.target instanceof HTMLFormElement && new URL(event.target.action, location.href).pathname === '/logout') clear(account); }, true);
})();
