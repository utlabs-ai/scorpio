import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SPAWN, spawnConfigOf, configSpawn } from '../src/spawn-config.ts'
import { worker } from './helpers/worker.mjs'

const valid = () => ({
  checkedAt: '2026-10-21', sources: ['https://example.com/models'],
  claude: { models: [{ id: 'claude-opus-5-5', about: { en: 'For complex work.', zh: '适合复杂任务。' } }, { id: 'claude-sonnet-5' }],
    efforts: [{ id: 'low' }, { id: 'xhigh', about: { en: 'Think longer.' } }], default: { model: 'claude-opus-5-5', effort: 'xhigh' } },
  codex: { models: [{ id: 'gpt-6-sol' }], efforts: [{ id: 'low' }, { id: 'xhigh' }], default: { model: 'gpt-6-sol', effort: 'xhigh' } },
})

test('valid spawn KV retains model and effort descriptions and defaults', () => {
  assert.deepEqual(DEFAULT_SPAWN.claude.default, { model: 'claude-opus-5-5', effort: 'medium' })
  assert.deepEqual(DEFAULT_SPAWN.codex.default, { model: 'gpt-6.1-sol', effort: 'medium' })
  assert.deepEqual(DEFAULT_SPAWN.claude.efforts.map(({ id }) => id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
  assert.deepEqual(spawnConfigOf(valid(), true), { ...valid(), perm: DEFAULT_SPAWN.perm })
})

test('one broken kind falls back alone; an unlisted default also falls back', () => {
  const raw = valid()
  raw.claude.models[1].id = 'bad;model'
  assert.deepEqual(spawnConfigOf(raw).claude, DEFAULT_SPAWN.claude)
  assert.deepEqual(spawnConfigOf(raw).codex, raw.codex)
  raw.claude = valid().claude
  raw.codex.default.model = 'unlisted'
  assert.deepEqual(spawnConfigOf(raw).claude, raw.claude)
  assert.deepEqual(spawnConfigOf(raw).codex, DEFAULT_SPAWN.codex)
})

test('editor rejects invalid ids and defaults with a path to the bad item', () => {
  for (const badId of ['has space', 'bad;model']) {
    const raw = valid()
    raw.claude.models[0].id = badId
    assert.throws(() => spawnConfigOf(raw, true), /claude\.models\[0\]\.id/)
  }
  const raw = valid()
  raw.codex.default.effort = 'max'
  assert.throws(() => spawnConfigOf(raw, true), /codex\.default\.effort/)
})

test('missing or unparseable KV gives both built-ins', async () => {
  assert.deepEqual(spawnConfigOf(null), DEFAULT_SPAWN)
  assert.deepEqual(spawnConfigOf('unparseable'), DEFAULT_SPAWN)
  const got = await configSpawn({ KV: { get: async () => null } })
  assert.deepEqual(got, DEFAULT_SPAWN)
})

test('GET /api/v1/config/spawn is public and returns the validated KV value', async () => {
  const w = await worker()
  try {
    const value = valid()
    await w.kv.put('config:spawn', JSON.stringify(value))
    const res = await w.fetch('/api/v1/config/spawn')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ...value, perm: DEFAULT_SPAWN.perm })
  } finally { await w.dispose() }
})

test('live KV without perm retains its kinds and falls back in both reader and editor', () => {
  for (const strict of [false, true]) {
    const got = spawnConfigOf(valid(), strict)
    assert.deepEqual(got.perm, DEFAULT_SPAWN.perm)
    assert.deepEqual(got.claude, valid().claude)
    assert.deepEqual(got.perm.map((p) => p.id), ['ask', 'auto', 'all'])
  }
})

test('invalid permission lists fall back for the reader and fail with a path for the editor', () => {
  for (const perm of [null, [], {}, [{ id: 'bad id', label: { en: 'Default', zh: '默认' } }],
    [{ id: 'default', label: { en: 'Default' } }], [{ id: 'default', label: { en: '', zh: '默认' } }],
    [{ id: 'all', label: { en: 'All', zh: '全部' }, note: { en: 'two\nlines' } }],
    [{ id: 'all', label: { en: 'All', zh: '全部' }, about: [] }],
    [DEFAULT_SPAWN.perm[0], DEFAULT_SPAWN.perm[0]]]) {
    assert.deepEqual(spawnConfigOf({ ...valid(), perm }).perm, DEFAULT_SPAWN.perm)
    assert.throws(() => spawnConfigOf({ ...valid(), perm }, true), /perm/)
  }
})

test('configured permissions keep supported labels and optional text, dropping default and unknown ids', () => {
  const perm = [
    { id: 'all', label: { en: 'Allow everything', zh: '全部放行' }, about: { zh: '说明' }, note: { en: 'Session only.' } },
    { id: 'default', label: { en: 'Default', zh: '默认' } },
  ]
  assert.deepEqual(spawnConfigOf({ ...valid(), perm }, true).perm, [perm[0]])
  assert.equal(spawnConfigOf({ ...valid(), perm }).perm[0].id, 'all')
})


test('permission descriptions allow 400 characters, keep a single line, and do not relax model descriptions', () => {
  const raw = valid()
  raw.perm = [{ id: 'ask', label: { en: 'Ask', zh: '询问' }, about: { en: 'x'.repeat(400) }, note: { zh: '字'.repeat(400) } }]
  assert.deepEqual(spawnConfigOf(raw, true).perm, raw.perm)
  for (const value of ['x'.repeat(401), 'two\nlines']) {
    raw.perm[0].about.en = value
    assert.throws(() => spawnConfigOf(raw, true), /perm.*400/)
  }
  delete raw.perm
  raw.claude.models[0].about.en = 'x'.repeat(161)
  assert.throws(() => spawnConfigOf(raw, true), /claude.*160/)
  for (const id of ['default', 'other']) {
    const list = [{ id, label: { en: 'Old', zh: '旧' } }, DEFAULT_SPAWN.perm[1]]
    assert.deepEqual(spawnConfigOf({ ...valid(), perm: list }).perm, [DEFAULT_SPAWN.perm[1]])
  }
})
