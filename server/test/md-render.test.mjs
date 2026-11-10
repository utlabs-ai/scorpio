import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import vm from "node:vm"

// The room page's Markdown renderer (web/public/static/md.js), run as the browser runs it (on a page at `origin`, with
// the deployment's <meta name="link-domains"> when `domains` is given).
const page = (origin, domains) => ({ window: { location: { origin } }, document: { querySelector: () => (domains === undefined ? null : { getAttribute: () => domains }) }, URL })
const browser = page("https://scorpio.utlabs.ai")
vm.runInNewContext(fs.readFileSync(new URL("../../web/public/static/md.js", import.meta.url), "utf8"), browser)
const render = browser.window.renderMarkdown
function renderer(origin, domains) {
  const other = page(origin, domains)
  vm.runInNewContext(fs.readFileSync(new URL("../../web/public/static/md.js", import.meta.url), "utf8"), other)
  return other.window.renderMarkdown
}
const names = new Set(["supervisor@zoe", "zoe", "pm@zoe"])

// Output of the renderer before it was made fast, for ordinary messages: making it fast must not change what anyone sees.
// (One change since: a mention inside a quote is marked once, not twice.)
const unchanged = [
  [
    "Plain **bold**, *em*, ~~gone~~ and `code`.",
    "<p>Plain <strong>bold</strong>, <em>em</em>, <del>gone</del> and <code>code</code>.</p>"
  ],
  [
    "See https://en.wikipedia.org/wiki/Foo_(bar). And (https://example.com/a).",
    "<p>See <a class=\"lnk\" href=\"https://en.wikipedia.org/wiki/Foo_(bar)\" target=\"_blank\" rel=\"noopener noreferrer\">https://en.wikipedia.org/wiki/Foo_(bar)</a>. And (<a class=\"lnk\" href=\"https://example.com/a\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/a</a>).</p>"
  ],
  [
    "Trailing: https://example.com/x]] and https://example.com/y?a=1&b=2;",
    "<p>Trailing: <a class=\"lnk\" href=\"https://example.com/x\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/x</a>]] and <a class=\"lnk\" href=\"https://example.com/y?a=1&amp;b=2\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/y?a=1&amp;b=2</a>;</p>"
  ],
  [
    "[our page](https://scorpio.utlabs.ai/pricing) and [elsewhere](https://example.com/z)",
    "<p><a class=\"lnk\" href=\"https://scorpio.utlabs.ai/pricing\" target=\"_blank\" rel=\"noopener noreferrer\">our page</a> and elsewhere (<a class=\"lnk\" href=\"https://example.com/z\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/z</a>)</p>"
  ],
  [
    "[a[b](https://example.com/q) [中文标签](https://example.com/c)",
    "<p>a[b (<a class=\"lnk\" href=\"https://example.com/q\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/q</a>) 中文标签（<a class=\"lnk\" href=\"https://example.com/c\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/c</a>）</p>"
  ],
  [
    "@supervisor@zoe please check, @zoe... and @pm@zoe-- ok; mail a@b.com",
    "<p><span class=\"mention\">@supervisor@zoe</span> please check, <span class=\"mention me\">@zoe</span>... and <span class=\"mention\">@pm@zoe</span>-- ok; mail a@b.com</p>"
  ],
  [
    "#12 is fixed, see #1234, but not a#5 or https://x.y/#7",
    "<p><a class=\"ref\" href=\"#m12\" data-jump=\"12\">#12</a> is fixed, see <a class=\"ref\" href=\"#m1234\" data-jump=\"1234\">#1234</a>, but not a#5 or <a class=\"lnk\" href=\"https://x.y/#7\" target=\"_blank\" rel=\"noopener noreferrer\">https://x.y/#7</a></p>"
  ],
  [
    "> quoted @zoe\n> > nested https://example.com/n)\n> back",
    "<blockquote><p>quoted <span class=\"mention me\">@zoe</span></p><blockquote><p>nested <a class=\"lnk\" href=\"https://example.com/n\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/n</a>)</p></blockquote><p>back</p></blockquote>"
  ],
  [
    "- one\n- two\n  more\n1. first\n2. second",
    "<ul><li>one</li><li>two<br>more</li></ul><ol><li>first</li><li>second</li></ol>"
  ],
  [
    "| a | b |\n|---|:-:|\n| `x` | [l](https://example.com) |",
    "<p>| a | b |</p><p>|---|:-:|<br>| <code>x</code> | l (<a class=\"lnk\" href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com</a>) |</p>"
  ],
  [
    "# Heading\n\ntext\n```js\nconst x = \"<b>\";\n```",
    "<p class=\"h\">Heading</p><p>text</p><div class=\"codeblock\"><div class=\"codeactions\"><button type=\"button\" class=\"wrapcode\" data-wrapcode aria-pressed=\"true\">Wrap: on</button><button type=\"button\" class=\"copycode\" data-copycode>Copy</button></div><pre class=\"code\"><code>const x = &quot;&lt;b&gt;&quot;;</code></pre></div>"
  ],
  [
    "<script>alert(1)</script> & \"quotes\" 'single'",
    "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;single&#39;</p>"
  ]
]

test("ordinary messages render exactly as before", () => {
  for (const [text, html] of unchanged) assert.equal(render(text, names, "zoe"), html, text)
})

// Each of these took seconds, or threw, before the renderer was made fast (a message holds at most 10,000 characters).
const MS = 150
const cpuMs = (fn) => {
  const start = process.cpuUsage()
  fn()
  const cpu = process.cpuUsage(start)
  return (cpu.user + cpu.system) / 1000
}
const slow = {
  "an address followed by 10,000 )": "https://a.b/" + ")".repeat(9988),
  "an address followed by 20,000 )": "https://a.b/" + ")".repeat(19988),
  "an address followed by 10,000 ]": "https://a.b/" + "]".repeat(9988),
  "10,000 [": "[".repeat(10000),
  "a mention followed by 10,000 dots": "@supervisor@zoe" + ".".repeat(9985),
  "a mention followed by 10,000 dashes": "@a" + "-".repeat(9998),
  "a quote 5,000 levels deep": ">".repeat(5000) + " x",
  "a quote 9,998 levels deep": ">".repeat(9998) + " x",
}

for (const [what, text] of Object.entries(slow)) {
  test(`${what}: renders within ${MS} ms without throwing`, () => {
    assert.equal(typeof render(text, names, "zoe"), "string")
    // The best of three CPU runs still catches expensive rendering without charging time waiting for the host.
    const took = Math.min(...[0, 1, 2].map(() => cpuMs(() => render(text, names, "zoe"))))
    assert.ok(took < MS, `took ${took.toFixed(1)} ms`)
  })
}

test("quotes nest 16 levels deep; deeper markers show as text", () => {
  const html = render(">".repeat(20) + " deep", names)
  assert.equal(html.match(/<blockquote>/g).length, 16)
  assert.match(html, /&gt;&gt;&gt;&gt; deep/)
})

test("a message the renderer cannot handle is shown as plain text", () => {
  const broken = { [Symbol.iterator]() { throw new Error("boom") } } // names that fail inside the renderer
  assert.equal(render("a <b>\nline", broken), "<p>a &lt;b&gt;<br>line</p>")
  assert.deepEqual([...render.mentionedNames("@x", broken)], [])
})

test("the page sets code block button labels", () => {
  const before = { ...render.labels }
  render.labels.copy = "复制"
  render.labels.wrapOn = "折行：开"
  try {
    assert.match(render("```\nx\n```"), /data-copycode>复制</)
    assert.match(render("```\nx\n```"), /data-wrapcode aria-pressed="true">折行：开</)
  } finally {
    Object.assign(render.labels, before)
  }
})

// A numbered list whose items are apart showed 1. 1. 1., and its "- " lines were plain text.
test("a list keeps going across blank lines, starts at its first number, and nests indented lists", () => {
  assert.equal(render("1. a\n\n2. b\n\n3. c"), "<ol><li>a</li><li>b</li><li>c</li></ol>")
  assert.equal(render("3. x\n4. y"), '<ol start="3"><li>x</li><li>y</li></ol>')
  assert.equal(render("- a\n  - a1\n  - a2\n- b"), "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>")
  assert.equal(render("1. a\n   more\n2. b\n\ntext after"), "<ol><li>a<br>more</li><li>b</li></ol><p>text after</p>")
  assert.equal(render("1. a\n\n- b"), "<ol><li>a</li></ol><ul><li>b</li></ul>", "another kind of list is another list")
  assert.equal(render("1234567890. not a list"), "<p>1234567890. not a list</p>")
})

test("a long reply renders as one list of three, with its sub-points as lists", () => {
  const text = [
    "@zoe 收到，逐条：", "",
    "1. **v6 我来出。** 底稿用 a50a4ac。", "",
    "3. **不设硬上限。** 原理讲两件事：",
    "   - **注意力**：上下文越长越慢；",
    "   - **缓存**：老会话的缓存是热的。",
    "   用量我的提法是：起帮手前先看 `/usage`。",
    "   - 50% 以下，按原则来；",
    "   - 90% 以上，不起，先问你。",
    "   要不要让守护进程提醒一次，让你定。", "",
    "2. **#1234 拿一个真事说。**",
    "   - design 交了稿 v1。",
    "   我推荐 A。",
  ].join("\n")
  const html = render(text, names, "zoe")
  assert.equal((html.match(/<ol/g) || []).length, 1, html)
  assert.equal((html.match(/<\/li>/g) || []).length, 3 + 5, "three numbered items and five sub-points")
  assert.match(html, /<li><strong>不设硬上限。<\/strong> 原理讲两件事：<ul><li><strong>注意力<\/strong>：上下文越长越慢；<\/li><li><strong>缓存<\/strong>/)
  assert.match(html, /<\/ul><p>用量我的提法是：起帮手前先看 <code>\/usage<\/code>。<\/p><ul><li>50% 以下/)
  assert.match(html, /<li><strong><a class="ref" href="#m1234" data-jump="1234">#1234<\/a> 拿一个真事说。<\/strong><ul><li>design 交了稿 v1。<\/li><\/ul><p>我推荐 A。<\/p><\/li><\/ol>$/)
  assert.ok(!/<span class="mention"><span/.test(html), "a mention in a list item is marked once")
})

test("lists nested as deep as 10,000 characters allow render quickly; past 16 levels the markers are text", () => {
  const lines = []
  for (let k = 0, size = 0; size + 2 * k + 4 <= 10000; k++) { lines.push(" ".repeat(2 * k) + "- x"); size += 2 * k + 4 }
  const deep = lines.join("\n")
  assert.ok(deep.length <= 10000 && lines.length > 90, `${lines.length} levels`)
  const best = (fn) => Math.min(...[0, 1, 2].map(() => cpuMs(fn)))
  const html = render(deep, names)
  const took = best(() => render(deep, names))
  assert.ok(took < MS, `took ${took.toFixed(1)} ms`)
  assert.equal((html.match(/<ul>/g) || []).length, 17)
  // As many items as a message holds (10,000 characters).
  const items = Array.from({ length: 1350 }, (_, k) => `${k + 1}. x`).join("\n")
  assert.ok(items.length <= 10000)
  assert.equal((render(items, names).match(/<li>/g) || []).length, 1350)
  const took2 = best(() => render(items, names))
  assert.ok(took2 < MS, `1,350 items took ${took2.toFixed(1)} ms`)
  assert.equal(render("1. a" + "\n".repeat(9990) + "2. b"), "<ol><li>a</li><li>b</li></ol>")
})

test("a mention inside a quote, a list or both is marked once, and as you when it is you", () => {
  for (const text of ["> hi @zoe", "- hi @zoe", "> - hi @zoe", "1. a\n   > hi @zoe"]) {
    const html = render(text, names, "zoe")
    assert.equal((html.match(/<span class="mention/g) || []).length, 1, html)
    assert.match(html, /<span class="mention me">@zoe<\/span>/)
  }
  assert.deepEqual([...render.mentionedNames("> @pm@zoe and @zoe", names)], ["pm@zoe", "zoe"])
})

test("words may hide only the page's own https origin and the deployment's link domains; everything else shows its address", () => {
  const hidden = (r, url) => r(`[words](${url})`, [], "") === `<p><a class="lnk" href="${url}" target="_blank" rel="noopener noreferrer">words</a></p>`
  const own = renderer("https://example.test")
  assert.ok(hidden(own, "https://example.test/r/1"))
  for (const url of ["https://files.example.test/a", "http://example.test/r/1", "https://example.test:8443/", "https://x@example.test/",
    "https://example.test.evil.test/", "https://evil.test/example.test"]) assert.ok(!hidden(own, url), url)
  const site = renderer("https://chat.example.test", "example.test other.test")
  for (const url of ["https://chat.example.test/r/1", "https://files.example.test/a", "https://example.test/", "https://a.b.other.test/"]) assert.ok(hidden(site, url), url)
  for (const url of ["https://badexample.test/", "https://example.test.evil.test/", "http://files.example.test/", "https://x@example.test/"]) assert.ok(!hidden(site, url), url)
})
