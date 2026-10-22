import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-name-'))
process.env.SCORPIO_HOME = home
const { NAME, chooseName, rememberedName, onlineNameTaken } = await import('../src/up/name.mjs')
const file = path.join(home, 'state', 'up.json')

test('name prompt validates, defaults to pobi, and remembers each agent kind', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ topicId: 'saved-topic', agentNames: { claude: 'mira' } }))
  const answers = ['Pobi', 'bad name', '']
  const errors = []
  const screen = { language: 'zh', askLine: (prompt) => {
    assert.equal(prompt, '给 agent 起个名字 [pobi]：')
    return answers.shift()
  }, error: (message) => errors.push(message) }
  assert.equal(chooseName(screen, 'codex'), 'pobi')
  assert.equal(errors.length, 2)
  assert.ok(errors.every((message) => message.includes('小写字母')))
  assert.equal(rememberedName('codex'), 'pobi')
  assert.equal(chooseName({ askLine: () => { throw new Error('Should remember the name.') } }, 'codex'), 'pobi')
  const english = { language: 'en', askLine: (prompt) => {
    assert.equal(prompt, 'Name it [pobi]: ')
    return 'alex_2'
  }, error: () => { throw new Error('Valid name rejected.') } }
  assert.equal(chooseName(english, 'codex', { force: true }), 'alex_2')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agentNames, { claude: 'mira', codex: 'alex_2' })
  assert.equal(NAME.test('a' + 'b'.repeat(31)), true)
  assert.equal(NAME.test('a' + 'b'.repeat(32)), false)
})

test('only online members with the same role block a name, except a reused local pane', () => {
  const members = [
    { name: 'pobi@owner', status: 'active', online: true },
    { name: 'pobi@other', status: 'active', online: true },
    { name: 'mira@owner', status: 'active', online: false },
    { name: 'old@owner', status: 'left', online: false },
  ]
  assert.equal(onlineNameTaken(members, 'pobi'), true)
  assert.equal(onlineNameTaken(members, 'pobi', 'pobi@owner'), true)
  assert.equal(onlineNameTaken(members.slice(0, 1), 'pobi', 'pobi@owner'), false)
  assert.equal(onlineNameTaken(members, 'mira'), false)
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
