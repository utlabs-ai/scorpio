import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testEnv } from './env.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-todo-cli-'))
const bin = new URL('../bin/scorpio.mjs', import.meta.url)

for (const option of ['round=2', "name=Old"]) {
  test(`todo ${option} reports the removed round command without a network call`, () => {
    const run = spawnSync(process.execPath, [bin.pathname, 'todo', 'roomId=RTEST', 'role=api', option], {
      encoding: 'utf8',
      env: testEnv(home, { SCORPIO_HOME: home }),
    })
    assert.equal(run.status, 1)
    const answer = JSON.parse(run.stdout.trim())
    assert.equal(answer.error, 'bad_request')
    assert.match(answer.next, /search in=task.*task show=T/)
  })
}
