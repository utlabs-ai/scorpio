import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { RoomDO } = await load('room-do.ts')
const { Files } = await load('room/files.ts')

test('evictFiles separates missing, trashed and gone; only visible files enter the message and shown list', async () => {
  const rows = {
    other: { uploaded_by: 'bob', deleted_at: null, seq: 1, name: 'other', size: 1 },
    trash: { uploaded_by: 'agent@ana', deleted_at: 10, seq: 2, name: 'trash', size: 2 },
    sent: { uploaded_by: 'ana', deleted_at: null, seq: 3, name: 'sent', size: 3 },
    unsent: { uploaded_by: 'ana', deleted_at: null, seq: null, name: 'unsent', size: 4 },
  }
  const marked = []
  const dropped = []
  const room = {
    roomRow: () => ({ id: 'room-1' }),
    sql: { exec: (_sql, id) => ({ toArray: () => rows[id] ? [rows[id]] : [] }) },
    markFileInMessage: (...args) => marked.push(args),
    dropFileRow: async (...args) => { dropped.push(args) },
  }
  const out = (await Files.prototype.evictFiles.call(room, 'ana', ['absent', 'other', 'trash', 'sent', 'unsent'])).ok
  assert.deepEqual(out, { gone: ['sent', 'unsent'], trashed: ['trash'], missing: ['absent', 'other'], shown: [{ name: 'sent', size: 3 }] })
  assert.equal(marked.length, 1)
  assert.equal(marked[0][0], 3)
  assert.equal(marked[0][1], 'sent')
  assert.equal(typeof marked[0][2], 'number')
  assert.deepEqual(dropped.map(([r, id]) => [r.name, id]), [['trash', 'room-1'], ['sent', 'room-1'], ['unsent', 'room-1']])
})

const eviction = await load('room-eviction.ts')

test('classifyFile distinguishes absent, another account, trashed and gone', () => {
  assert.equal(eviction.classifyFile(undefined, 'ana'), 'missing')
  assert.equal(eviction.classifyFile({ uploaded_by: 'bot@bob', deleted_at: null }, 'ana'), 'missing')
  assert.equal(eviction.classifyFile({ uploaded_by: 'bot@ana', deleted_at: 10 }, 'ana'), 'trashed')
  assert.equal(eviction.classifyFile({ uploaded_by: 'ana', deleted_at: null }, 'ana'), 'gone')
})

test('isShown requires an attached message and no prior deletion', () => {
  assert.equal(eviction.isShown({ deleted_at: null, seq: 4 }), true)
  assert.equal(eviction.isShown({ deleted_at: 10, seq: 4 }), false)
  assert.equal(eviction.isShown({ deleted_at: null, seq: null }), false)
})
