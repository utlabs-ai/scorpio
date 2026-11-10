// @me on the topic page: messages addressed to me, newest first, from the server.
(function () {
  "use strict";

  window.createRoomAt = function (ctx) {
    var $ = ctx.$, S = ctx.S, avatar = ctx.avatar, boot = ctx.boot, filesHtml = ctx.filesHtml, fill = ctx.fill, fmtTime = ctx.fmtTime, kindLabel = ctx.kindLabel, names = ctx.names, openPanel = ctx.openPanel, panels = ctx.panels, renderRoomMenu = ctx.renderRoomMenu, state = ctx.state, updateChips = ctx.updateChips, unreadFromMentions = ctx.unreadFromMentions;
    var at = { list: [], total: 0, unread: 0, hasMore: false, loading: false, error: null, loaded: false };

    function atHtml() {
      var a = at;
      var html = '<p class="athead"><b>' + escapeHtml(fill(S.atHead, { n: a.total })) + "</b>" +
        (state.mentionUnread ? ' <span class="tag unread">' + escapeHtml(fill(S.atUnread, { n: state.mentionUnread })) + "</span>" : "") + "</p>";
      if (a.error) html += '<p class="error">' + escapeHtml(fill(S.atFailed, { why: a.error })) + "</p>";
      if (a.loaded && !a.list.length && !a.error) {
        return html + '<p class="muted">' + escapeHtml(S.atEmpty) + '</p><p class="muted small">' + escapeHtml(fill(S.atEmptyHint, { me: state.me })) + "</p>";
      }
      html += messagesHtml(a.list);
      var tail = a.loading ? S.atLoading : a.hasMore ? S.atMore : a.list.length ? S.atNoMore : "";
      return html + (tail ? '<p class="attail muted">' + escapeHtml(tail) + "</p>" : "");
    }

    function messagesHtml(list) {
      return '<ul class="pins at">' + list.map(function (m) {
        return '<li class="pin" data-jump="' + m.seq + '"><div class="meta">' + avatar(m) + '<b class="from">' + escapeHtml(m.from) + "</b>" +
          (kindLabel(m.fromKind) ? '<span class="tag">' + kindLabel(m.fromKind) + "</span>" : "") +
          (m.seq > state.cursor ? '<span class="tag unread">' + S.unreadOne + "</span>" : "") +
          '<span class="sp"></span><span class="seq">#' + m.seq + "</span><time>" + fmtTime(m.ts) + "</time></div>" +
          '<div class="body md">' + renderMarkdown(m.text, names()) + "</div>" + filesHtml(m) + "</li>";
      }).join("") + "</ul>";
    }

    /** The first page (reset) or the next page going back. Opening the tab always reloads it. */
    function loadMentions(reset) {
      var a = at;
      if (a.loading && !reset) return;
      if (!reset && !a.hasMore) return;
      var before = !reset && a.list.length ? a.list[a.list.length - 1].seq : 0;
      a.loading = true;
      a.error = null;
      var token = (loadMentions.n = (loadMentions.n || 0) + 1);
      fetch("/r/" + boot.roomId + "/mentions?limit=50" + (before ? "&before=" + before : ""), { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); })
        .then(function (j) {
          if (token !== loadMentions.n) return;
          a.list = (reset ? [] : a.list).concat(j.mentions || []);
          a.total = j.total;
          a.hasMore = !!j.hasMore;
          unreadFromMentions(j.unread);
          updateChips();
        }, function (e) {
          if (token === loadMentions.n) a.error = (e && (e.next || e.message)) || String(e);
        })
        .then(function () {
          if (token !== loadMentions.n) return;
          a.loading = false;
          a.loaded = true;
          if (!$('room-menu').classList.contains('hidden')) renderRoomMenu();
          if (panels.kind() === "at") openPanel("at");
        });
      if (panels.kind() === "at") openPanel("at");
    }

    panels.tab('at', { html: atHtml, opened: function () { loadMentions(true); } });

    return {
      loadMentions: loadMentions,
      /** How many: total once the first page came (the room menu's @me count). */
      count: function () { return { loaded: at.loaded, total: at.total }; },
    };
  };
})();
