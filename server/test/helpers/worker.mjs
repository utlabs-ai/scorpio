import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

// The Worker as deployed from an entry file: this server's own by default; a deployment's entry wraps it (options.entry).
const SERVER_ENTRY = new URL('../../src/index.ts', import.meta.url).pathname
const bundles = new Map()
const bundle = (entry) => {
  if (!bundles.has(entry)) bundles.set(entry, build({
    entryPoints: [entry],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    external: ['cloudflare:workers', 'node:*'], mainFields: ['module', 'main'], // node:zlib (zip.ts) is workerd's, given by nodejs_compat
  }).then((built) => built.outputFiles[0].text))
  return bundles.get(entry)
}
await bundle(SERVER_ENTRY)
export const ORIGIN = 'https://scorpio.test'
const defaults = {
  PUBLIC_URL: ORIGIN, CONTENT_DOMAIN: 'content.test', VIEW_TICKET_KEY: 'route-test-key-0123456789abcdef0123456789',
  DEV_LOGIN_KEY: 'route-test-login-key', OPS_ACCOUNTS: 'ops', CREEM_WEBHOOK_SECRET: 'route-test-creem-secret',
  TURNSTILE_SITE_KEY: 'route-test-site-key', TURNSTILE_SECRET_KEY: 'route-test-turnstile-secret',
  GOOGLE_CLIENT_ID: 'route-test-google-id', GOOGLE_CLIENT_SECRET: 'route-test-google-secret',
  GITHUB_CLIENT_ID: 'route-test-github-id', GITHUB_CLIENT_SECRET: 'route-test-github-secret',
}
const statements = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)

// Every key of `overrides` becomes a binding. `append` is code added to the bundle (a subclass of RoomDO, say),
// `className` the class ROOMS is bound to, and `entry` the Worker's entry file. `noFiles`: no FILES binding, as a
// deployment without file storage runs.
export async function worker(overrides = {}, options = {}) {
  const { append = '', className = 'RoomDO', entry = SERVER_ENTRY } = options
  const script = await bundle(entry)
  const bindings = { ...defaults, ...overrides }
  for (const [key, value] of Object.entries(bindings)) if (value === undefined) delete bindings[key]
  const mf = new Miniflare(convertV4MiniflareOptions({
    ...(options.name ? { name: options.name } : {}),
    ...(options.inspect ? { unsafeInspectDurableObjects: true } : {}),
    modules: true, script: script + append, compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    bindings, durableObjects: { ROOMS: { className, useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: options.noFiles ? [] : ['FILES'],
    ratelimits: { DEVICE_CODE_LIMIT: { namespace_id: '917403', simple: { limit: 10, period: 60 } } },
    serviceBindings: { ASSETS: () => new Response('missing asset', { status: 404 }) },
    ...(options.email ? { email: { send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['no-reply@example.com'] }] }, resourceTmpPath: options.resourceTmpPath } : {}),
  }))
  const db = await mf.getD1Database('DB')
  const dir = new URL('../../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const s of statements(fs.readFileSync(new URL(f, dir), 'utf8'))) await db.prepare(s).run()
  }
  const kv = await mf.getKVNamespace('KV')
  const fetch = (path, init = {}) => mf.dispatchFetch(path.startsWith('http') ? path : `${ORIGIN}${path}`, { redirect: 'manual', ...init })
  const json = async (res) => { const text = await res.text(); try { return { status: res.status, ...JSON.parse(text) } } catch { return { status: res.status, text } } }
  async function person(handle) {
    const id = `u-${handle}`
    await db.prepare('INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES (?, ?, ?, ?, 0)').bind(id, handle, `${handle}@x.test`, Date.now()).run()
    const sid = `sid-${handle}-0123456789abcdef0123`
    await kv.put(`s:${sid}`, JSON.stringify({ id, handle, email: `${handle}@x.test` }))
    const token = `tok-${handle}-0123456789abcdef`
    await db.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`t-${handle}`, id, createHash('sha256').update(token).digest('hex'), 'box', Date.now(), Date.now() + 86400_000).run()
    const web = (path, init = {}) => fetch(path, { ...init, headers: { cookie: `sid=${sid}`, ...(init.method === 'POST' ? { origin: ORIGIN } : {}), ...(init.headers || {}) } })
    const post = (path, body = {}, headers = {}) => web(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
    const api = (path, init = {}, role) => fetch(`/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(role ? { 'x-scorpio-role': role } : {}), ...(init.headers || {}) } })
    const apiPost = (path, body = {}, role) => api(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, role)
    return { id, handle, cookie: `sid=${sid}`, web, post, api, apiPost }
  }
  async function topic(owner, code = '') {
    const r = await json(await owner.apiPost('/rooms', { name: 'Route test topic', code }))
    if (!r.roomId) throw new Error(`create: ${JSON.stringify(r)}`)
    await owner.web(`/r/${r.roomId}`)
    return r.roomId
  }
  async function join(p, roomId, role) {
    return json(await p.apiPost(`/rooms/${roomId}/join`, { role }, undefined))
  }
  return { mf, db, kv, fetch, json, person, topic, join, dispose: () => mf.dispose() }
}
