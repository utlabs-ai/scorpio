// Image viewer for the room feed. Message cards can be replaced at any time, so entry is delegated.
(function () {
  "use strict";

  var labels = JSON.parse(document.getElementById("boot").textContent).S.lightbox;
  // The picture's own page (/v/<id>): a new tab, except inside the home-screen app (the browser is not signed in).
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  var root, stage, image, percent, counter, original, page, previous, next, zoomOut, opener;
  var entries = [], index = 0, zoom = 1, panX = 0, panY = 0, baseW = 0, baseH = 0;
  var oldOverflow = "", pointers = new Map(), pinch = null, drag = null, lastTap = null;
  var press = null, suppressClick = false, suppressTimer = null;

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
  function visible() { return root && !root.hidden; }

  function build() {
    if (root) return;
    root = document.createElement("div");
    root.className = "scorpio-lightbox";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", labels.dialog);
    root.tabIndex = -1;
    root.innerHTML = '<div class="lb-toolbar"><div class="lb-tools">' +
      '<button type="button" data-lb="out" aria-label="' + labels.zoomOut + '">−</button>' +
      '<span class="lb-percent" aria-live="off">100%</span>' +
      '<button type="button" data-lb="in" aria-label="' + labels.zoomIn + '">+</button>' +
      '<button type="button" class="lb-reset" data-lb="reset">' + labels.reset + '</button>' +
      '<a class="lb-original" target="_blank" rel="noopener">' + labels.original + '</a>' +
      '</div></div><a class="lb-page"' + (standalone ? "" : ' target="_blank" rel="noopener"') + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>' + labels.page + '</a>' +
      '<button type="button" class="lb-close" data-lb="close" aria-label="' + labels.close + '">×</button>' +
      '<div class="lb-stage"><img draggable="false" alt=""></div>' +
      '<button type="button" class="lb-arrow lb-prev" data-lb="prev" aria-label="' + labels.previous + '">‹</button>' +
      '<button type="button" class="lb-arrow lb-next" data-lb="next" aria-label="' + labels.next + '">›</button>' +
      '<span class="lb-counter" aria-live="polite"></span>';
    document.body.appendChild(root);
    window.scorpioRoomOverlays.watch(root); // its hidden attribute opens and closes it
    stage = root.querySelector(".lb-stage");
    image = stage.querySelector("img");
    percent = root.querySelector(".lb-percent");
    counter = root.querySelector(".lb-counter");
    original = root.querySelector(".lb-original");
    page = root.querySelector(".lb-page");
    previous = root.querySelector(".lb-prev");
    next = root.querySelector(".lb-next");
    zoomOut = root.querySelector('[data-lb="out"]');
    image.addEventListener("load", fit);
    root.addEventListener("click", onClick);
    root.addEventListener("dblclick", function (event) {
      if (event.target.closest(".lb-stage")) { event.preventDefault(); toggleAt(event.clientX, event.clientY); }
    });
    stage.addEventListener("wheel", function (event) {
      event.preventDefault();
      zoomAt(zoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    }, { passive: false });
    stage.addEventListener("pointerdown", pointerDown);
    stage.addEventListener("pointermove", pointerMove);
    stage.addEventListener("pointerup", pointerUp);
    stage.addEventListener("pointercancel", pointerUp);
  }

  function fit() {
    if (!visible() || !image.naturalWidth || !image.naturalHeight) return;
    var rect = stage.getBoundingClientRect();
    var ratio = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight, 1);
    baseW = image.naturalWidth * ratio;
    baseH = image.naturalHeight * ratio;
    image.style.width = baseW + "px";
    image.style.height = baseH + "px";
    zoom = 1;
    panX = panY = 0;
    render();
  }

  function limitPan() {
    var rect = stage.getBoundingClientRect();
    panX = clamp(panX, -Math.max(0, (baseW * zoom - rect.width) / 2), Math.max(0, (baseW * zoom - rect.width) / 2));
    panY = clamp(panY, -Math.max(0, (baseH * zoom - rect.height) / 2), Math.max(0, (baseH * zoom - rect.height) / 2));
  }

  function render() {
    limitPan();
    image.style.transform = "translate(-50%, -50%) translate(" + panX + "px, " + panY + "px) scale(" + zoom + ")";
    percent.textContent = Math.round(zoom * 100) + "%";
    zoomOut.disabled = zoom <= 0.25;
    root.querySelector('[data-lb="in"]').disabled = zoom >= 5;
    stage.classList.toggle("can-drag", zoom > 1);
  }

  function zoomAt(value, clientX, clientY) {
    if (!baseW) return;
    var nextZoom = clamp(value, 0.25, 5);
    var rect = stage.getBoundingClientRect();
    var x = clientX - rect.left - rect.width / 2;
    var y = clientY - rect.top - rect.height / 2;
    panX = x - (x - panX) * nextZoom / zoom;
    panY = y - (y - panY) * nextZoom / zoom;
    zoom = nextZoom;
    render();
  }

  function toggleAt(x, y) { zoomAt(zoom === 1 ? 2 : 1, x, y); }

  function show(number) {
    if (number < 0 || number >= entries.length) return;
    index = number;
    var entry = entries[index];
    lastTap = null;
    baseW = baseH = 0;
    zoom = 1;
    panX = panY = 0;
    image.alt = entry.alt;
    image.src = entry.href;
    original.href = entry.href;
    if (entry.page) page.href = entry.page;
    else page.removeAttribute("href");
    page.hidden = !entry.page;
    counter.textContent = (index + 1) + " / " + entries.length;
    previous.hidden = next.hidden = entries.length < 2;
    previous.disabled = index === 0;
    next.disabled = index === entries.length - 1;
    render();
    if (image.complete && image.naturalWidth) fit();
  }

  function open(anchor) {
    build();
    var group = anchor.closest(".pics");
    entries = Array.from(group.querySelectorAll("a[href] > img")).map(function (img) {
      return { href: img.parentElement.href, alt: img.alt || "", page: img.parentElement.getAttribute("data-page") || "" };
    });
    index = Array.from(group.querySelectorAll("a[href] > img")).indexOf(anchor.querySelector("img"));
    if (index < 0 || !entries.length) return;
    opener = anchor;
    oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.hidden = false;
    root.focus();
    show(index);
  }

  function close() {
    if (!visible()) return;
    root.hidden = true;
    document.body.style.overflow = oldOverflow;
    image.removeAttribute("src");
    pointers.clear();
    pinch = drag = lastTap = null;
    if (opener && opener.isConnected) opener.focus();
  }

  function onClick(event) {
    var button = event.target.closest("[data-lb]");
    if (button) {
      var action = button.dataset.lb;
      if (action === "close") close();
      else if (action === "prev") show(index - 1);
      else if (action === "next") show(index + 1);
      else if (action === "reset") zoomAt(1, innerWidth / 2, innerHeight / 2);
      else if (action === "in" || action === "out") zoomAt(zoom * (action === "in" ? 1.25 : 0.8), innerWidth / 2, innerHeight / 2);
      return;
    }
    if (!suppressClick && (event.target === root || (event.target === stage && !onImage(event)))) close();
    suppressClick = false;
  }

  function onImage(event) {
    var rect = stage.getBoundingClientRect();
    var x = event.clientX - rect.left - rect.width / 2 - panX;
    var y = event.clientY - rect.top - rect.height / 2 - panY;
    return Math.abs(x) <= baseW * zoom / 2 && Math.abs(y) <= baseH * zoom / 2;
  }

  function point(event) { return { x: event.clientX, y: event.clientY }; }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function pointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point(event));
    if (pointers.size === 1) drag = { start: point(event), panX: panX, panY: panY, moved: false, type: event.pointerType };
    if (pointers.size === 2) {
      var p = Array.from(pointers.values());
      pinch = { distance: distance(p[0], p[1]), mid: midpoint(p[0], p[1]), zoom: zoom, panX: panX, panY: panY };
      drag = null;
    }
  }

  function pointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point(event));
    if (pinch && pointers.size >= 2) {
      var p = Array.from(pointers.values());
      var mid = midpoint(p[0], p[1]);
      var nextZoom = clamp(pinch.zoom * distance(p[0], p[1]) / Math.max(1, pinch.distance), 0.25, 5);
      var rect = stage.getBoundingClientRect();
      panX = mid.x - rect.left - rect.width / 2 - (pinch.mid.x - rect.left - rect.width / 2 - pinch.panX) * nextZoom / pinch.zoom;
      panY = mid.y - rect.top - rect.height / 2 - (pinch.mid.y - rect.top - rect.height / 2 - pinch.panY) * nextZoom / pinch.zoom;
      zoom = nextZoom;
      render();
      ignoreNextClick();
    } else if (drag) {
      var dx = event.clientX - drag.start.x, dy = event.clientY - drag.start.y;
      if (Math.hypot(dx, dy) > 8) { drag.moved = true; ignoreNextClick(); }
      if (zoom > 1) { panX = drag.panX + dx; panY = drag.panY + dy; render(); }
    }
  }

  function pointerUp(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pinch) { pinch = null; drag = null; lastTap = null; ignoreNextClick(); return; }
    if (drag && drag.type === "touch") {
      var dx = event.clientX - drag.start.x, dy = event.clientY - drag.start.y;
      if (zoom === 1 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3 && entries.length > 1) {
        show(index + (dx < 0 ? 1 : -1));
        ignoreNextClick();
        lastTap = null;
      } else if (!drag.moved) {
        var now = Date.now();
        if (lastTap && now - lastTap.time < 320 && distance(lastTap, point(event)) < 30) {
          toggleAt(event.clientX, event.clientY);
          ignoreNextClick();
          lastTap = null;
        } else lastTap = { time: now, x: event.clientX, y: event.clientY };
      }
    }
    drag = null;
  }

  function ignoreNextClick() {
    suppressClick = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(function () { suppressClick = false; }, 400);
  }

  // A long press remains available to the message menu or the browser. Only a short tap opens the viewer.
  document.addEventListener("pointerdown", function (event) {
    var img = event.target.closest && event.target.closest(".pics a > img");
    press = img ? { img: img, x: event.clientX, y: event.clientY, time: Date.now(), moved: false } : null;
  }, true);
  document.addEventListener("pointermove", function (event) {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
  }, true);
  document.addEventListener("contextmenu", function (event) {
    if (press && press.img.contains(event.target)) press.moved = true;
  }, true);
  document.addEventListener("click", function (event) {
    var img = event.target.closest && event.target.closest(".pics a > img");
    if (!img || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (press && (press.img !== img || press.moved || Date.now() - press.time >= 450)) {
      event.preventDefault();
      press = null;
      return;
    }
    event.preventDefault();
    press = null;
    open(img.parentElement);
  }, true);
  document.addEventListener("keydown", function (event) {
    if (!visible()) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); if (entries.length > 1) show(index - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); if (entries.length > 1) show(index + 1); }
    else if (event.key === "Tab") {
      var controls = Array.from(root.querySelectorAll("button:not([hidden]):not([disabled]), a[href]"));
      var next = controls.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1);
      event.preventDefault();
      controls[(next + controls.length) % controls.length].focus();
    }
  }, true);
  window.addEventListener("resize", function () { if (visible()) fit(); });
  window.scorpioRoomOverlays.register("lightbox", visible, close);
})();
