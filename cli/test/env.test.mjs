import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { assertTestHome, testEnv } from './env.mjs'

test('testEnv ignores an inherited SCORPIO_HOME and SCORPIO_SERVER, and refuses a real Scorpio home', () => {
  const saved = { home: process.env.SCORPIO_HOME, server: process.env.SCORPIO_SERVER }
  try {
    process.env.SCORPIO_HOME = '/somewhere/else'
    process.env.SCORPIO_SERVER = 'https://scorpio.example.com'
    const tmp = path.join(os.tmpdir(), 'scorpio-env')
    const env = testEnv(tmp)
    assert.equal(env.HOME, tmp)
    assert.equal(env.SCORPIO_HOME, path.join(tmp, '.scorpio'))
    assert.equal('SCORPIO_SERVER' in env, false)
    assert.equal(testEnv(tmp, { SCORPIO_SERVER: 'http://127.0.0.1:9' }).SCORPIO_SERVER, 'http://127.0.0.1:9')
  } finally {
    for (const [name, value] of [['SCORPIO_HOME', saved.home], ['SCORPIO_SERVER', saved.server]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const real = os.userInfo().homedir
  assert.throws(() => testEnv(os.tmpdir(), { SCORPIO_HOME: path.join(real, '.scorpio') }), /real Scorpio home/)
  assert.throws(() => testEnv(os.tmpdir(), { SCORPIO_HOME: path.join(real, '.scorpio-staging') }), /real Scorpio home/)
  assert.throws(() => assertTestHome({ HOME: real }), /real Scorpio home/)
})
