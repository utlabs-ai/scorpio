// The home avatar opens the same small account menu on phone and desktop.
(function () {
  "use strict";
  var button = document.getElementById('home-avatar');
  if (!button) return;
  var menu = document.getElementById('home-menu');
  var scrim = document.getElementById('home-menu-scrim');
  function close() { menu.classList.add('hidden'); scrim.classList.add('hidden'); }
  button.addEventListener('click', function () {
    var opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    scrim.classList.toggle('hidden', !opening);
  });
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
})();
