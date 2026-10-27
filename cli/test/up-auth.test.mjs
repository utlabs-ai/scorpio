import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

test('up reuses the CLI device-code login and stops its approval card on success', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.scorpio')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  const cli = fileURLToPath(new URL('../bin/scorpio.mjs', import.meta.url))
  const launcher = path.join(root, 'bin', 'scorpio')
  fs.writeFileSync(launcher, '#!/bin/sh\nexec "$TEST_NODE" "$TEST_CLI" "$@"\n', { mode: 0o755 })
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/oauth/device/code') {
      res.end(JSON.stringify({ device_code: 'device-code', user_code: 'WDJB-MJHT', verification_uri: 'http://localhost/device',
        verification_uri_complete: 'http://localhost/device?code=WDJB-MJHT', interval: 1, expires_in: 60 }))
    } else if (req.url === '/oauth/token') {
      res.end(JSON.stringify({ access_token: 'test-only-token' }))
    } else if (req.url === '/api/v1/whoami' && req.headers.authorization === 'Bearer test-only-token') {
      res.end(JSON.stringify({ account: 'kai', device: 'mock' }))
    } else {
      res.statusCode = 401
      res.end(JSON.stringify({ error: 'unauthorized' }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  process.env.HOME = home
  process.env.SCORPIO_HOME = root
  process.env.SCORPIO_SERVER = 'http://127.0.0.1:' + server.address().port
  process.env.TEST_NODE = process.execPath
  process.env.TEST_CLI = cli
  const { authorize } = await import('../src/up/auth.mjs')
  const events = []
  const screen = {
    language: 'en', write: (text) => events.push(text),
    startApproval: (url, code) => {
      events.push('start:' + url + ':' + code)
      return { stop: (account) => events.push('stop:' + account) }
    },
  }
  const who = await authorize(screen)
  assert.equal(who.account, 'kai')
  assert.ok(events.some((event) => event.includes('start:http://localhost/device?code=WDJB-MJHT:WDJB-MJHT')))
  assert.ok(events.includes('stop:kai'))
  assert.equal(fs.readFileSync(path.join(root, 'token'), 'utf8').trim(), 'test-only-token')
})
