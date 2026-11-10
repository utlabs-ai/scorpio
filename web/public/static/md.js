// A small, safe Markdown renderer for room messages: the text is HTML-escaped first, then a
// handful of constructs are recognised (code, emphasis, links, lists, quotes, headings, tables).
// It never passes raw HTML through.
(function () {
  "use strict";
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  var UNESC = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  function unesc(s) {
    return s.replace(/&(amp|lt|gt|quot|#39);/g, function (e) { return UNESC[e]; });
  }

  /** Calls fn on the text between tags that is not inside a link or code (never attributes). */
  function textOutside(html, fn) {
    var skip = 0;
    return html.split(/(<[^>]+>)/g).map(function (part) {
      if (part.charAt(0) === "<") {
        if (/^<(a|code|pre)[\s>]/.test(part)) skip++;
        else if (/^<\/(a|code|pre)>/.test(part)) skip = Math.max(0, skip - 1);
        return part;
      }
      return skip ? part : fn(part);
    }).join("");
  }

  function mentions(html, names, me) {
    var byLower = new Map(Array.from(names, function (n) { return [n.toLowerCase(), n]; }));
    var longest = 0;
    byLower.forEach(function (v, k) { longest = Math.max(longest, k.length); });
    function highlight(part) {
      return part.replace(/(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g, function (m, pre, name) {
        // Trailing dots and dashes beyond the longest member name cannot be part of one: dropped by index,
        // not one slice and lowercase at a time (a 10,000-character "@a-----" took 0.2 s).
        var end = name.length;
        while (end > longest && /[.-]/.test(name.charAt(end - 1))) end--;
        var n = name.slice(0, end);
        while (!byLower.has(n.toLowerCase()) && /[.-]$/.test(n)) n = n.slice(0, -1);
        var member = byLower.get(n.toLowerCase());
        if (!member) return m;
        return pre + '<span class="mention' + (member === me ? ' me' : '') + '">@' + member + "</span>" + name.slice(n.length);
      });
    }
    // Own-domain Markdown links keep their label inside <a>; it is prose. A bare URL's label is its address.
    html = html.replace(/(<a\b[^>]*>)([^<]*)(<\/a>)/g, function (all, open, label, close) {
      return open + (/^https?:\/\//.test(unesc(label)) ? label : highlight(label)) + close;
    });
    return textOutside(html, highlight);
  }

  // "#19" in the text is message 19 of this room: a link the page turns into a jump (data-jump).
  // Not inside code or an existing link, and not part of a word, an entity (&#39;) or a URL fragment.
  function seqRefs(html) {
    return textOutside(html, function (part) {
      return part.replace(/(^|[^\w&#/])#(\d{1,7})(?!\w|\.\d)/g, function (m, pre, n) {
        return pre + '<a class="ref" href="#m' + n + '" data-jump="' + n + '">#' + n + "</a>";
      });
    });
  }

  // ---------- links ----------
  // This site's own pages (the page's origin, over https) may hide behind words: [text](url) shows
  // only the text; so may the domains, with their subdomains, the deployment names in <meta name="link-domains">.
  // Anywhere else the full address stays visible after the words, so words cannot pass off one site as
  // another. Ownership is decided by the same URL parser the browser follows.
  var SELF = window.location ? window.location.origin : "";
  var meta = typeof document !== "undefined" && document.querySelector && document.querySelector('meta[name="link-domains"]');
  var DOMAINS = meta ? meta.getAttribute("content").split(/\s+/).filter(Boolean) : [];
  function ours(href) {
    var u;
    try { u = new URL(unesc(href)); } catch (e) { return false; }
    if (u.protocol !== "https:" || u.username || u.password) return false;
    if (u.origin === SELF) return true;
    var host = u.hostname;
    return DOMAINS.some(function (d) { return host === d || host.slice(-d.length - 1) === "." + d; });
  }
  function anchor(href, label) {
    return '<a class="lnk" href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
  }
  /**
   * A bare address ends before trailing punctuation and an unmatched closing bracket. The brackets are
   * counted once and kept up to date as the end moves, so a long run of ")" costs one pass, not one per character.
   */
  function trimUrl(u) {
    var open = { ")": 0, "]": 0 }, shut = { ")": 0, "]": 0 };
    for (var k = 0; k < u.length; k++) {
      var b = u.charAt(k);
      if (b === "(") open[")"]++;
      else if (b === "[") open["]"]++;
      else if (b === ")" || b === "]") shut[b]++;
    }
    var end = u.length;
    for (;;) {
      var c = u.charAt(end - 1);
      if (/[.,;:!?*'"]/.test(c)) end--;
      else if ((c === ")" || c === "]") && open[c] < shut[c]) { shut[c]--; end--; }
      else if (end >= 5 && u.slice(end - 5, end) === "&amp;") end -= 5;
      else return u.slice(0, end);
    }
  }
  // Bare addresses are ASCII: they stop at the first CJK character or full-width punctuation, so
  // 「见：https://…，」 works, and so does an address with no space before or after it in Chinese text.
  var BARE = /(^|[^A-Za-z0-9_@.\/-])(https?:\/\/(?:[A-Za-z0-9\-._~:\/?#\[\]@!$()*+,;=%]|&amp;)+)/g;
  var LINK_TAIL = /\]\((https?:\/\/[^\s)]+)\)/y;

  /**
   * [label](https://…) links, as s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, fn) finds them, in one pass.
   * A label runs to the first "]" or line end after its "[", so when one "[" fails, every "[" before that "]"
   * fails the same way: the search goes on after it instead of rescanning (a line of 10,000 "[" took 0.12 s).
   */
  function mdLinks(s, fn) {
    var out = "", from = 0, p = s.indexOf("[");
    while (p >= 0) {
      var q = p + 1;
      while (q < s.length && s.charAt(q) !== "]" && s.charAt(q) !== "\n") q++;
      LINK_TAIL.lastIndex = q;
      var m = q > p + 1 && s.charAt(q) === "]" ? LINK_TAIL.exec(s) : null;
      if (m) {
        out += s.slice(from, p) + fn(s.slice(p, LINK_TAIL.lastIndex), s.slice(p + 1, q), m[1]);
        from = LINK_TAIL.lastIndex;
        p = s.indexOf("[", from);
      } else p = q < s.length ? s.indexOf("[", q + 1) : -1;
    }
    return out + s.slice(from);
  }

  function links(s, keep) {
    s = mdLinks(s, function (m, label, href) {
      if (ours(href)) return keep(anchor(href, label));
      var t = unesc(label).trim(), h = unesc(href);
      if (t === h || t === h.replace(/^https?:\/\//, "") || t + "/" === h || t === h + "/") return keep(anchor(href, href));
      var cjk = /[　-鿿＀-￯]/.test(t);
      return keep(label + (cjk ? "（" : " (") + anchor(href, href) + (cjk ? "）" : ")"));
    });
    return s.replace(BARE, function (m, pre, raw) {
      var u = trimUrl(raw);
      if (!/^https?:\/\/[^\/?#]/.test(u)) return m;
      return pre + keep(anchor(u, u)) + raw.slice(u.length);
    });
  }

  function fmt(s) {
    var held = [];
    var keep = function (html) { held.push(html); return "\u0001" + (held.length - 1) + "\u0002"; };
    s = links(s.replace(/[\u0001\u0002]/g, ""), keep);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0001(\d+)\u0002/g, function (m, i) { return held[Number(i)] || ""; });
  }

  function inline(raw) {
    var parts = esc(raw).split(/(`[^`\n]+`)/g);
    return parts.map(function (p) {
      return p.length > 1 && p.charAt(0) === "`" && p.charAt(p.length - 1) === "`" ? "<code>" + p.slice(1, -1) + "</code>" : fmt(p);
    }).join("");
  }

  function cells(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (c) { return c.trim(); });
  }

  // Quotes nest by rendering their inside again. Past this depth a ">" line is shown as text: no message can
  // run the renderer out of stack (5,000 levels threw), and each level costs one more pass over the text.
  // Lists inside list items count against the same depth.
  var MAX_QUOTE_DEPTH = 16;

  // A list item's marker: indent, then -, *, + or a number of at most 9 digits with . or ), then a space.
  var LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var indentOf = function (l) { return /^\s*/.exec(l)[0].length; };

  /**
   * The list starting at lines[i], as CommonMark reads one: an ordered list starts at its first
   * number; a blank line between items does not end it; lines indented past the marker belong to the item,
   * and a list among them is a list inside that item. Returns { html, next }.
   */
  function list(lines, i, names, depth) {
    var first = LIST.exec(lines[i]);
    var indent = first[1].length, ordered = /\d/.test(first[2]);
    var same = function (m) { return m && m[1].length <= indent + 1 && /\d/.test(m[2]) === ordered; };
    var items = [];
    while (i < lines.length) {
      var m = LIST.exec(lines[i]);
      if (same(m)) { items.push({ head: [m[3]], sub: [] }); i++; continue; }
      var cur = items[items.length - 1];
      if (!lines[i].trim()) {
        // A blank line: the list goes on when what follows is its next item or is indented into this one.
        var j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        if (same(LIST.exec(lines[j]))) { i = j; continue; }
        if (indentOf(lines[j]) < indent + 2) break;
        if (cur.sub.length) cur.sub.push("");
        i = j;
        continue;
      }
      if (indentOf(lines[i]) < indent + 2) break;
      // Indented: a list inside the item (and what follows it), or more of the item's own text.
      if (depth < MAX_QUOTE_DEPTH && (cur.sub.length || LIST.test(lines[i]))) cur.sub.push(lines[i]);
      else cur.head.push(lines[i].trim());
      i++;
    }
    var start = ordered ? parseInt(first[2], 10) : 1;
    var tag = ordered ? "ol" : "ul";
    var html = "<" + tag + (start !== 1 ? ' start="' + start + '"' : "") + ">" + items.map(function (it) {
      var cut = Math.min.apply(null, it.sub.filter(function (l) { return l.trim(); }).map(indentOf));
      var inner = it.sub.length ? blocks(it.sub.map(function (l) { return l.slice(cut); }).join("\n"), names, depth + 1) : "";
      return "<li>" + inline(it.head.join("\n")).replace(/\n/g, "<br>") + inner + "</li>";
    }).join("") + "</" + tag + ">";
    return { html: html, next: i };
  }

  function render(text, names, me, depth) {
    names = names || new Set();
    return seqRefs(mentions(blocks(text, names, depth || 0), names, me));
  }

  /** The block structure of a text (paragraphs, lists, quotes, code, tables), before mentions and #refs. */
  function blocks(text, names, depth) {
    var lines = String(text).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) buf.push(lines[i++]);
        i++;
        out.push('<div class="codeblock"><div class="codeactions"><button type="button" class="wrapcode" data-wrapcode aria-pressed="true">' + esc(api.labels.wrapOn) + '</button><button type="button" class="copycode" data-copycode>' + esc(api.labels.copy) + '</button></div><pre class="code"><code>' + esc(buf.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<div class="tablewrap"><table><thead><tr>' + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") +
          "</tbody></table></div>");
        continue;
      }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        out.push('<p class="h">' + inline(h[2]) + "</p>");
        i++;
        continue;
      }
      if (depth < MAX_QUOTE_DEPTH && /^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push("<blockquote>" + blocks(q.join("\n"), names, depth + 1) + "</blockquote>");
        continue;
      }
      if (LIST.test(line)) {
        var l = list(lines, i, names, depth);
        out.push(l.html);
        i = l.next;
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|>|#{1,6}\s|([-*+]|\d{1,9}[.)])\s)/.test(lines[i]) &&
        !(/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]))) {
        para.push(lines[i++]);
      }
      if (!para.length) para.push(lines[i++]);
      out.push("<p>" + para.map(inline).join("<br>") + "</p>");
    }
    return out.join("");
  }

  // What the page calls. A message the renderer cannot handle is shown as plain text instead of breaking the
  // feed it is in (and every message after it).
  function api(text, names, me) {
    try {
      return render(text, names, me);
    } catch (e) {
      return "<p>" + esc(String(text)).replace(/\n/g, "<br>") + "</p>";
    }
  }
  api.labels = { copy: "Copy", wrapOn: "Wrap: on" }; // the page sets these in its own language
  api.mentionedNames = function (text, names) {
    var html;
    try { html = render(text, names); } catch (e) { return []; }
    return Array.from(html.matchAll(/<span class="mention(?: me)?">@([^<]+)<\/span>/g), function (m) { return m[1]; });
  };
  window.renderMarkdown = api;
  window.escapeHtml = esc;
})();
