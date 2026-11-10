// One same-URL history entry per visible room overlay on a phone.
(function () {
  "use strict";
  var key = "scorpioRoomOverlay", page = Math.random().toString(36).slice(2);
  var entries = [], stack = [], queued = false, pendingBack = false;
  function mobile() { return window.matchMedia("(max-width: 760px)").matches; }
  function depth(state) {
    var marker = state && state[key];
    return marker && marker.page === page ? marker.depth : 0;
  }
  function marked(nextDepth) {
    var state = history.state && typeof history.state === "object" ? Object.assign({}, history.state) : {};
    state[key] = { page: page, depth: nextDepth };
    return state;
  }
  function visible() {
    return entries.filter(function (entry) { return entry.isOpen(); }).map(function (entry) { return entry.id; });
  }
  function navigateToStack() {
    if (pendingBack) return;
    var current = depth(history.state);
    if (stack.length < current) {
      pendingBack = true;
      history.go(stack.length - current);
    } else if (stack.length > current) {
      for (var level = current + 1; level <= stack.length; level++) history.pushState(marked(level), "", location.href);
    } else if (current) {
      history.replaceState(marked(current), "", location.href);
    }
  }
  function sync() {
    queued = false;
    if (!mobile() && !stack.length) return;
    var seen = mobile() ? visible() : [];
    var next = stack.filter(function (id) { return seen.indexOf(id) >= 0; });
    seen.forEach(function (id) { if (next.indexOf(id) < 0) next.push(id); });
    if (next.length === stack.length && next.every(function (id, i) { return id === stack[i]; })) return;
    stack = next;
    navigateToStack();
  }
  function schedule() {
    if (!queued) { queued = true; queueMicrotask(sync); }
  }
  // Only the overlays' own elements are watched, for their class and hidden attributes (docs/web.md rule 3: no observer
  // on the whole page, where every row write in the feed would wake it). An overlay without one says when it changed.
  var observer = new MutationObserver(schedule);
  function watch(el) {
    if (el) observer.observe(el, { attributes: true, attributeFilter: ["class", "hidden"] });
  }
  window.scorpioRoomOverlays = {
    /** el: the element that opening and closing the overlay shows and hides; none when its owner calls changed(). */
    register: function (id, isOpen, close, el) {
      entries.push({ id: id, isOpen: isOpen, close: close });
      watch(el);
      schedule();
    },
    watch: watch,
    changed: schedule
  };
  window.addEventListener("resize", schedule);
  window.addEventListener("popstate", function (event) {
    if (pendingBack) {
      pendingBack = false;
      navigateToStack();
      return;
    }
    var target = depth(event.state);
    while (stack.length > target) {
      var id = stack.pop();
      var entry = entries.find(function (candidate) { return candidate.id === id; });
      if (entry) entry.close();
    }
    schedule();
  });
})();
