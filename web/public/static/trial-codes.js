(function () {
  'use strict';
  document.querySelectorAll('[data-copy-trial]').forEach(function (button) {
    button.addEventListener('click', function () {
      var textarea = document.getElementById(button.dataset.copyTrial), label = button.textContent;
      var done = function () { button.textContent = button.dataset.done; setTimeout(function () { button.textContent = label; }, 1500); };
      var fallback = function () { textarea.select(); if (document.execCommand('copy')) done(); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(textarea.value).then(done, fallback);
      else fallback();
    });
  });
})();
