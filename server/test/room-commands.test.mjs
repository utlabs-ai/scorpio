// The composer's daemon commands with /read, /keys and /text: the list, its words in both languages,
// and the names of agents a /spawn asked for that have not joined yet.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

const source = fs.readFileSync(new URL('../../web/public/static/room-composer.js', import.meta.url), 'utf8')
const fn = (name) => new RegExp(`\\n    function ${name}\\([\\s\\S]*?\\n    \\}\\n`).exec(source)[0]

const members = (names) => names.map((name) => ({ name, kind: 'host', owner: name.split('@')[1], status: 'active' }))

function spawnedNames(messages, me = 'mei', seats = members(['daemon@mei', 'daemon-2@mei'])) {
  const ctx = { state: { members: seats }, ownerOf: (name) => name.includes('@') ? name.split('@').slice(1).join('@') : name }
  vm.runInNewContext(fn('hostSeat'), ctx)
  vm.runInNewContext(fn('spawnedNames'), ctx)
  return JSON.parse(JSON.stringify(ctx.spawnedNames(messages, me)))
}

test('/read, /keys and /text are in the list, one name each, with words in Chinese and English', () => {
  const list = vm.runInNewContext(/\n    var COMMANDS = (\[[\s\S]*?\n    \]);/.exec(source)[1])
  for (const name of ['read', 'keys', 'text']) {
    assert.equal(list.find((c) => c.name === name).one, true, name)
    for (const lang of ['zh', 'en']) {
      assert.ok(ROOM_STRINGS[lang][`cmd_${name}`], `${lang} cmd_${name}`)
      assert.ok(ROOM_STRINGS[lang][`args_${name}`], `${lang} args_${name}`)
      assert.doesNotMatch(ROOM_STRINGS[lang][`cmd_${name}`], /房间/)
    }
  }
  assert.ok(ROOM_STRINGS.zh.notJoined && ROOM_STRINGS.en.notJoined)
})

test('a /spawn with a name, from me or my agent to my daemon, lists the name until /bye or /handoff of it there', () => {
  const m = (from, text) => ({ from, text })
  assert.deepEqual(spawnedNames([
    m('mei', '@daemon@mei /spawn claude pane-web /home/kai/scorpio model=claude-opus-5-5 effort=high 你做工单 B'),
    m('supervisor@mei', '@daemon-2@mei /spawn codex pane-mac ~/scorpio do it'),
    m('mei', '@daemon@mei /spawn claude /home/kai/x no name, so the daemon picks one'),
    m('mei', '@daemon@mei /spawn claude cwd="~/My Project" no name either'),
    m('kai', '@daemon@kai /spawn claude theirs /tmp'),
    m('mei', 'not a command /spawn claude prose /tmp'),
  ]), { 'pane-web': 'daemon@mei', 'pane-mac': 'daemon-2@mei' })
  assert.deepEqual(spawnedNames([
    m('mei', '@daemon@mei /spawn claude a /x'),
    m('mei', '@daemon@mei /spawn claude b /x'),
    m('mei', '@daemon@mei /spawn claude c /x'),
    m('mei', '@daemon-2@mei /bye a'),
    m('mei', '@daemon@mei /bye b'),
    m('mei', '@daemon@mei /handoff c'),
  ]), { a: 'daemon@mei' }, '/bye on another daemon is not this one')
  assert.deepEqual(spawnedNames([
    m('mei', '@daemon@mei /spawn claude a /x'),
    m('mei', '@daemon@mei /bye all'),
    m('mei', '@daemon@mei /spawn codex a /x'),
  ]), { a: 'daemon@mei' }, 'spawned again after /bye all')
})

test('a renamed host offers commands after its mention, but an agent with a daemon-like name does not', () => {
  const seat = 'mei-mac-daemon@mei'
  const ctx = {
    state: { me: 'mei', members: [...members([seat]), { name: 'pane-daemon@mei', kind: 'agent', owner: 'mei', status: 'active' }] },
    input: { value: `@${seat} `, selectionStart: seat.length + 2 },
    COMMANDS: vm.runInNewContext(/\n    var COMMANDS = (\[[\s\S]*?\n    \]);/.exec(source)[1]),
    S: ROOM_STRINGS.en,
    escapeHtml: (text) => text,
    openPicker: (mode, html) => { ctx.picked = { mode, html } },
    hidePicker: () => { ctx.picked = null },
    bareOff: null, picker: { classList: { add() {} } },
  }
  for (const name of ['hostSeat', 'mySeats', 'command', 'commandAt', 'bareSeatsAt', 'suggestCommand']) vm.runInNewContext(fn(name), ctx)
  assert.equal(ctx.suggestCommand(), true)
  assert.equal(ctx.picked.mode, 'cmd')
  assert.match(ctx.picked.html, /data-cmd="spawn"/)
  assert.match(ctx.picked.html, /data-cmd="bye"/)

  ctx.input.value = '@pane-daemon@mei '
  ctx.input.selectionStart = ctx.input.value.length
  ctx.picked = null
  assert.equal(ctx.suggestCommand(), false)
  assert.equal(ctx.picked, null)
})

test('spawned names follow renamed host membership', () => {
  const seat = 'mei-mac-daemon@mei'
  const messages = [{ from: 'mei', text: `@${seat} /spawn codex seat-kind /work` }]
  assert.deepEqual(spawnedNames(messages, 'mei', members([seat])), { 'seat-kind': seat })
  assert.deepEqual(spawnedNames(messages, 'mei', [{ name: seat, kind: 'agent' }]), {})
})

test('the key table comes from the server, and a key shows its label', () => {
  assert.match(fn('keyTable'), /fetch\("\/api\/v1\/config\/keys"\)/)
  assert.match(source, /escapeHtml\(r\.label \|\| r\.arg\)/)
})
