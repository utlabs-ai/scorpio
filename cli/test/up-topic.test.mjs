import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-topic-'))
process.env.SCORPIO_HOME = home
const { chooseTopic } = await import('../src/up/topic.mjs')
const file = path.join(home, 'state', 'up.json')
const id = 'abcdefghijklmnopqrstuv'
const screen = { language: 'en', write: () => {}, askLine: () => '1' }

test('lost create response is reconciled from the room list before retry', async () => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ agentNames: { codex: 'pobi' } }))
  let lists = 0
  let creates = 0
  const topic = await chooseTopic(screen, {
    readRooms: async () => ({ rooms: ++lists === 1 ? [] : [{ roomId: id, name: 'Hello Scorpio', status: 'active' }] }),
    createRoom: async () => { creates += 1; throw Error('response lost') },
  })
  assert.equal(topic.roomId, id)
  assert.equal(creates, 1)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).topicId, id)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agentNames.codex, 'pobi')
})

test('an existing room is offered instead of creating another', async () => {
  fs.rmSync(file, { force: true })
  let creates = 0
  const topic = await chooseTopic(screen, {
    readRooms: async () => ({ rooms: [{ roomId: id, name: 'Existing', status: 'active' }] }),
    createRoom: async () => { creates += 1 },
  })
  assert.equal(topic.name, 'Existing')
  assert.equal(creates, 0)
})

test('a retry uses the same recorded create nonce', async () => {
  fs.rmSync(file, { force: true })
  const nonces = []
  const topic = await chooseTopic(screen, {
    readRooms: async () => ({ rooms: [] }),
    createRoom: async (nonce) => {
      nonces.push(nonce)
      if (nonces.length === 1) throw Error('response lost')
      return { topicId: id, topicName: 'Hello Scorpio' }
    },
  })
  assert.equal(topic.roomId, id)
  assert.equal(nonces.length, 2)
  assert.equal(nonces[0], nonces[1])
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
