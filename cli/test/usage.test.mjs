// Run with node --test from cli/ (no dependencies, no network)
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

const { claudeWindows, getClaudeUsage, readClaudeRateLimits, readClaudeCredentials } = await import('../src/adapters/cli/usage.mjs')

const NOW = Date.UTC(2026, 9, 4, 16, 47)
const TOKEN = 'oauth-token-for-tests'
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 3_600_000, subscriptionType: 'max' } })
const files = (map) => (p) => { if (p in map) return map[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
const noKeychain = { read: async () => ({ error: 'missing' }), services: async () => [] }

test('Claude login on Linux: ~/.claude/.credentials.json, or under CLAUDE_CONFIG_DIR', async () => {
  const home = await readClaudeCredentials({ platform: 'linux', env: {}, home: '/h', readText: files({ '/h/.claude/.credentials.json': CREDS }) })
  assert.equal(home.oauth.accessToken, TOKEN)
  const custom = await readClaudeCredentials({ platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/h', readText: files({ '/cfg/.credentials.json': CREDS }) })
  assert.equal(custom.oauth.accessToken, TOKEN)
})

test('no file, or no claude.ai login in it: no subscription login; an unreadable file says so', async () => {
  assert.deepEqual(await readClaudeCredentials({ platform: 'linux', env: {}, home: '/h', readText: files({}) }), { none: true })
  const apiOnly = files({ '/h/.claude/.credentials.json': JSON.stringify({ mcpOAuth: {} }) })
  assert.deepEqual(await readClaudeCredentials({ platform: 'linux', env: {}, home: '/h', readText: apiOnly }), { none: true })
  const bad = await readClaudeCredentials({ platform: 'linux', env: {}, home: '/h', readText: files({ '/h/.claude/.credentials.json': '{' }) })
  assert.match(bad.reason, /cannot be read/)
})

test('Mac: the keychain entry first, then the suffixed ones, then the file', async () => {
  const read = []
  const keychain = {
    read: async (service) => { read.push(service); return service === 'Claude Code-credentials-1a2b3c4d' ? { stdout: CREDS } : { error: 'missing' } },
    services: async () => ['Claude Code-credentials-1a2b3c4d'],
  }
  const got = await readClaudeCredentials({ platform: 'darwin', env: {}, home: '/h', readText: files({}), keychain })
  assert.equal(got.oauth.accessToken, TOKEN)
  assert.deepEqual(read, ['Claude Code-credentials', 'Claude Code-credentials-1a2b3c4d'])
  const file = await readClaudeCredentials({ platform: 'darwin', env: {}, home: '/h', readText: files({ '/h/.claude/.credentials.json': CREDS }), keychain: noKeychain })
  assert.equal(file.oauth.accessToken, TOKEN)
  const waiting = await readClaudeCredentials({ platform: 'darwin', env: {}, home: '/h', readText: files({}), keychain: { read: async () => ({ error: 'timeout' }), services: async () => [] } })
  assert.match(waiting.reason, /keychain did not give out Claude's login within 10 seconds/)
})

const ask = (res, creds = { oauth: JSON.parse(CREDS).claudeAiOauth }) => {
  const calls = []
  const get = async (opts) => { calls.push(opts); if (res.code) throw res; return res }
  return { calls, run: () => readClaudeRateLimits({ now: () => NOW, credentials: async () => creds, get }) }
}

test('asks once with the login, waiting longer than Claude Code\'s own 5 s', async () => {
  const body = { limits: [{ kind: 'session', percent: 57, resets_at: '2026-10-04T17:30:00+00:00' }] }
  const { calls, run } = ask({ status: 200, headers: {}, body: JSON.stringify(body) })
  assert.deepEqual(await run(), { result: body })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].token, TOKEN)
  assert.ok(calls[0].timeoutMs > 5000)
})

test('an expired login, or none: nothing is sent, the reason says what to do', async () => {
  const expired = ask({ status: 200, body: '{}' }, { oauth: { accessToken: TOKEN, expiresAt: NOW - 1 } })
  assert.match((await expired.run()).reason, /^Claude's login has expired; a Claude session started on this computer renews it$/)
  const none = ask({ status: 200, body: '{}' }, { none: true })
  assert.match((await none.run()).reason, /no Claude subscription login on this computer/)
  assert.equal(expired.calls.length + none.calls.length, 0)
})

test('each failure has its own reason, without the login or parentheses (the room line adds them)', async () => {
  const cases = [
    [{ status: 401, headers: {}, body: '' }, /refused Claude's login with 401; a Claude session started on this computer renews it/],
    [{ status: 429, headers: { 'retry-after': '120' }, body: '' }, /^the quota API is rate limiting, try again in 120 seconds$/],
    [{ status: 429, headers: {}, body: '' }, /^the quota API is rate limiting$/],
    [{ status: 500, headers: {}, body: 'oops' }, /answered HTTP 500/],
    [{ status: 200, headers: {}, body: '<html>' }, /did not answer JSON/],
    [{ code: 'timeout' }, /did not answer within 20 seconds/],
    [{ code: 'ECONNREFUSED' }, /could not reach the quota API: ECONNREFUSED/],
  ]
  for (const [res, want] of cases) {
    const { reason } = await ask(res).run()
    assert.match(reason, want)
    assert.ok(!reason.includes(TOKEN))
    assert.doesNotMatch(reason, /[()]/)
  }
})

test('limits → 5h, week, week <model>, each with its reset; kinds it does not know are left out', () => {
  const w = claudeWindows({
    five_hour: { utilization: 1, resets_at: '2026-10-04T17:30:00+00:00' },
    limits: [
      { kind: 'session', percent: 57, resets_at: '2026-10-04T17:30:00.308989+00:00' },
      { kind: 'weekly_all', percent: 39, resets_at: '2026-10-08T21:00:00.309015+00:00' },
      { kind: 'weekly_scoped', percent: 37, resets_at: '2026-10-08T21:00:00.309239+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 5, resets_at: null, scope: { surface: { display_name: 'Cowork' } } },
      { kind: 'something_new', percent: 3, resets_at: null },
      { kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Opus' } } },
    ],
  })
  assert.deepEqual(w.map((x) => [x.label, x.pct]), [['5h', 57], ['week', 39], ['week Fable', 37], ['week Cowork', 5]])
  assert.equal(w[0].resetsAt, Date.UTC(2026, 9, 4, 17, 30, 0, 308))
  assert.equal(w[3].resetsAt, null)
})

test('older answers without limits: the five_hour and seven_day buckets', () => {
  const w = claudeWindows({ five_hour: { utilization: 12, resets_at: '2026-10-04T17:30:00+00:00' }, seven_day: { utilization: 40, resets_at: null }, seven_day_opus: null })
  assert.deepEqual(w.map((x) => [x.label, x.pct, x.resetsAt]), [['5h', 12, Date.UTC(2026, 9, 4, 17, 30)], ['week', 40, null]])
})

test('through HTTPS_PROXY: a CONNECT tunnel to api.anthropic.com:443; a refusing proxy is reported', async (t) => {
  const seen = []
  const proxy = http.createServer()
  proxy.on('connect', (req, socket) => { seen.push([req.url, req.headers['proxy-authorization']]); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  t.after(() => proxy.close())
  const env = { HTTPS_PROXY: `http://u:p%40ss@127.0.0.1:${proxy.address().port}` }
  await assert.rejects(getClaudeUsage({ token: TOKEN, timeoutMs: 5000, env }), { code: 'proxy_403' })
  assert.deepEqual(seen, [['api.anthropic.com:443', `Basic ${Buffer.from('u:p@ss').toString('base64')}`]])
})
