// A seat's handoff page (/r/<id>/handoff, docs/api/files.md). The text is rendered here as messages
// are, by md.js (it escapes everything first and passes no HTML); #1234 goes to that message in the topic. 「删除」 for the
// seat's own person: asked in our own dialog, then POST /r/<id>/handoffDelete; once deleted the page shows what
// it shows for no handoff.
(function () {
  "use strict";
  var boot = JSON.parse(document.getElementById("ho-boot").textContent);
  var doc = document.getElementById("ho-doc");

  if (doc && boot.text != null) {
    renderMarkdown.labels.copy = boot.labels.copy;
    renderMarkdown.labels.wrapOn = boot.labels.wrapOn;
    doc.innerHTML = renderMarkdown(boot.text, [], "");
    // md.js links #1234 within the room page (data-jump); here it is the message in the topic.
    doc.querySelectorAll("a.ref[data-jump]").forEach(function (a) {
      a.href = "/r/" + encodeURIComponent(boot.room) + "?jump=" + a.dataset.jump;
      a.removeAttribute("data-jump");
    });
    doc.addEventListener("click", function (e) {
      var wc = e.target.closest("[data-wrapcode]");
      if (wc) {
        var wrapped = wc.closest(".codeblock").querySelector("pre.code").classList.toggle("nowrap");
        wc.setAttribute("aria-pressed", String(!wrapped));
        wc.textContent = wrapped ? boot.labels.wrapOff : boot.labels.wrapOn;
        return;
      }
      var cc = e.target.closest("[data-copycode]");
      if (cc && navigator.clipboard) {
        var code = cc.closest(".codeblock").querySelector("code");
        navigator.clipboard.writeText(code ? code.textContent : "").then(function () { toast(boot.labels.copied); }, function () {});
      }
    });
  }

  function toast(text) {
    var t = document.createElement("div");
    t.className = "ho-toast";
    t.setAttribute("role", "status");
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }

  var del = document.getElementById("ho-del");
  if (!del) return;

  function ask() {
    return new Promise(function (resolve) {
      var back = document.activeElement;
      var d = document.createElement("div");
      d.className = "ho-dlg";
      d.innerHTML = '<div class="box" role="alertdialog" aria-modal="true"><p class="q"></p><div class="btns">' +
        '<button type="button" class="b no" data-v="0"></button><button type="button" class="b danger" data-v="1"></button></div></div>';
      d.querySelector(".q").textContent = boot.confirm;
      d.querySelector('[data-v="0"]').textContent = boot.cancel;
      d.querySelector('[data-v="1"]').textContent = boot.ok;
      function done(v) {
        document.removeEventListener("keydown", key, true);
        d.remove();
        if (back && back.focus) back.focus();
        resolve(v);
      }
      function key(e) { if (e.key === "Escape") { e.stopPropagation(); done(false); } }
      d.addEventListener("click", function (e) {
        var b = e.target.closest("[data-v]");
        if (b) return done(b.dataset.v === "1");
        if (e.target === d) done(false); // a tap outside the box
      });
      document.addEventListener("keydown", key, true);
      document.body.appendChild(d);
      d.querySelector('[data-v="1"]').focus();
    });
  }

  function gone() {
    document.getElementById("ho-main").innerHTML = document.getElementById("ho-empty").innerHTML;
    ["ho-acts", "ho-meta", "ho-foot"].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  }

  del.addEventListener("click", function () {
    ask().then(function (ok) {
      if (!ok) return;
      del.disabled = true;
      fetch(boot.del, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ name: boot.seat }),
      }).then(function (r) { return r.json().then(function (b) { if (!r.ok && b.error !== "handoff_not_found") throw b; return b; }); })
        .then(function () { gone(); toast(boot.deleted); }, function (err) {
          del.disabled = false;
          toast((err && (err.next || err.error)) || String(err));
        });
    });
  });
})();
