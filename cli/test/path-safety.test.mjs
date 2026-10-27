import test from 'node:test'
import assert from 'node:assert/strict'
import { handoffPath, handoffCopyPath, spawnPath, spawnRecordPath, HOME } from '../src/daemon/paths.mjs'
import { insideHome } from '../src/path-safety.mjs'
import path from 'node:path'

const topic = 'AbCdEf0123456789_-ghIJ'
test('server path components cannot escape Scorpio home', () => {
  for (const make of [handoffPath, handoffCopyPath, spawnPath, spawnRecordPath]) {
    const target = make(topic, 'api@kai')
    assert.ok(target.startsWith(path.resolve(HOME) + path.sep))
    for (const id of ['../outside', '../../outside', 'x'.repeat(21), topic + '/..']) assert.throws(() => make(id, 'api@kai'), /topic/)
    for (const name of ['api@../kai', '../api@kai', 'api@..', '..@kai', 'api@kai/../../outside', 'api@kai@zoe']) assert.throws(() => make(topic, name), /seat|account/)
  }
  assert.throws(() => insideHome(HOME, '..', 'outside'), /outside/)
})
