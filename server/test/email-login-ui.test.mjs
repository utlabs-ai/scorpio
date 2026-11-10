import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { build } from 'esbuild'

const source = fs.readFileSync(new URL('../../web/public/static/email-login.js', import.meta.url), 'utf8')

async function verifyDisplay(errorCode, fetchFails = false) {
  const listeners = {}
  const classes = new Set()
  const input = { value: '123456', disabled: false, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, addEventListener() {} }
  const button = { disabled: false }
  const resend = { disabled: false, textContent: '', addEventListener() {} }
  const error = { textContent: '', hidden: true }
  const success = { textContent: '', hidden: true }
  const verify = {
    elements: { code: input },
    dataset: { wrong: 'Wrong code', limited: 'Try again later', resend: 'Resend', cooldown: 'Resend ({s} s)', resendIn: '0' },
    querySelector: () => button,
    addEventListener: (name, fn) => { listeners[name] = fn },
  }
  const nodes = { '#email-start': null, '#email-verify': verify, '#email-resend': resend, '#code-error': error, '#code-success': success }
  const fetch = fetchFails
    ? async () => { throw new Error('offline') }
    : async () => ({ status: errorCode === 'email_code_wrong' ? 400 : 500, json: async () => ({ error: errorCode }) })
  vm.runInNewContext(source, { document: { querySelector: (selector) => nodes[selector] }, fetch, setInterval: () => 0, location: { assign() {} }, Date, Math, RegExp, JSON, Response })
  listeners.submit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  return { error: error.textContent, bad: classes.has('sx-bad'), inputDisabled: input.disabled, buttonDisabled: button.disabled }
}

test('only a wrong-code response calls the code wrong; service and network failures leave retry available', async () => {
  assert.deepEqual(await verifyDisplay('email_code_wrong'), { error: 'Wrong code', bad: true, inputDisabled: false, buttonDisabled: false })
  assert.deepEqual(await verifyDisplay('server_error'), { error: 'Try again later', bad: false, inputDisabled: false, buttonDisabled: false })
  assert.deepEqual(await verifyDisplay('email_send_failed', true), { error: 'Try again later', bad: false, inputDisabled: false, buttonDisabled: false })
})

test('daily address limit shows the next-day copy on start and resend', async () => {
  const day = "This address has used today's codes. Try again tomorrow, or sign in with Google or GitHub."
  const answer = async () => ({ status: 429, json: async () => ({ error: 'email_day_limited', retryAfter: 3600 }) })
  const startListeners = {}
  const startError = { textContent: '', hidden: true }
  const start = {
    elements: { email: { value: 'person@example.test', validity: { valid: true } } },
    dataset: { siteKey: '', day },
    querySelector: () => ({ disabled: false, querySelector: () => ({ textContent: '' }) }),
    addEventListener: (name, fn) => { startListeners[name] = fn },
  }
  vm.runInNewContext(source, { document: { querySelector: (selector) => ({ '#email-start': start, '#email-error': startError, '#email-turnstile': { hidden: true } }[selector] || null) }, fetch: answer, location: { assign() {} }, Date, Math, RegExp, JSON, Response })
  startListeners.submit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(startError.textContent, day)

  const resendListeners = {}
  const input = { disabled: false, classList: { remove() {} }, addEventListener() {} }
  const resend = { disabled: false, textContent: '', addEventListener: (name, fn) => { resendListeners[name] = fn } }
  const error = { textContent: '', hidden: true }
  const verify = {
    elements: { code: input },
    dataset: { day, resend: 'Resend', cooldown: 'Resend ({s} s)', resendIn: '0' },
    querySelector: () => ({ disabled: false }),
    addEventListener() {},
  }
  vm.runInNewContext(source, { document: { querySelector: (selector) => ({ '#email-verify': verify, '#email-resend': resend, '#code-error': error, '#code-success': { textContent: '', hidden: true } }[selector] || null) }, fetch: answer, setInterval: () => 0, location: { assign() {} }, Date, Math, RegExp, JSON, Response })
  resendListeners.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(error.textContent, day)
  assert.equal(resend.disabled, true)
})

test('email Turnstile leaves no empty holder, shows the verifying label, and restores it after a response or check failure', async () => {
  const listeners = {}
  const holder = { hidden: true }
  const error = { textContent: '', hidden: true }
  const label = { textContent: 'Continue with email' }
  const button = { disabled: false, querySelector: () => label }
  const start = {
    elements: { email: { value: 'kai@example.com', validity: { valid: true } } },
    dataset: { siteKey: 'site-key', next: '/app', verifying: 'Verifying…', challengeFailed: 'Try again', sendFailed: 'Send failed' },
    querySelector: () => button,
    addEventListener: (name, fn) => { listeners[name] = fn },
  }
  const nodes = { '#email-start': start, '#email-verify': null, '#signup': null, '#email-error': error, '#email-turnstile': holder }
  let options, resolveFetch, resets = 0
  const fetch = () => new Promise((resolve) => { resolveFetch = resolve })
  const window = { turnstile: { render: (_holder, callbacks) => { options = callbacks; return 'widget' }, execute() {}, reset: () => { resets++ } } }
  vm.runInNewContext(source, { document: { querySelector: (selector) => nodes[selector] }, window, fetch, location: { assign() {} }, Date, Math, RegExp, JSON })
  listeners.submit({ preventDefault() {} })
  assert.equal(holder.hidden, true, 'silent verification takes no space')
  assert.equal(button.disabled, true)
  assert.equal(label.textContent, 'Verifying…')
  options['before-interactive-callback']()
  assert.equal(holder.hidden, false)
  options['after-interactive-callback']()
  assert.equal(holder.hidden, true)
  options.callback('token')
  assert.equal(holder.hidden, true)
  resolveFetch({ status: 500, json: async () => ({ error: 'email_send_failed' }) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(button.disabled, false)
  assert.equal(label.textContent, 'Continue with email')
  assert.equal(resets, 1)
  listeners.submit({ preventDefault() {} })
  options['before-interactive-callback']()
  options['error-callback']()
  assert.equal(holder.hidden, true)
  assert.equal(label.textContent, 'Continue with email')
  assert.equal(button.disabled, false)
  listeners.submit({ preventDefault() {} })
  options['before-interactive-callback']()
  options['expired-callback']()
  assert.equal(holder.hidden, true)
  assert.equal(button.disabled, false)
})

test('sign-up Turnstile uses the same hidden holder and verifying label until it can submit', () => {
  const listeners = {}
  const holder = { hidden: true }
  const error = { textContent: '', hidden: true }
  const button = { disabled: false, textContent: 'Create my account' }
  let submits = 0, options, executes = 0, resets = 0
  const windowListeners = {}
  const signup = {
    dataset: { siteKey: 'site-key', language: 'en', verifying: 'Verifying…', challengeFailed: 'Try again' },
    querySelector: () => button,
    addEventListener: (name, fn) => { listeners[name] = fn },
    submit: () => { submits++ },
  }
  const nodes = { '#email-start': null, '#email-verify': null, '#signup': signup, '#signup-turnstile': holder, '#signup-turnstile-error': error }
  const window = { turnstile: { render: (_holder, callbacks) => { options = callbacks; return 'widget' }, execute: () => { executes++ }, reset: () => { resets++ } }, addEventListener: (name, fn) => { windowListeners[name] = fn } }
  vm.runInNewContext(source, { document: { querySelector: (selector) => nodes[selector] }, window })
  listeners.submit({ preventDefault() {} })
  assert.equal(holder.hidden, true)
  assert.equal(button.disabled, true)
  assert.equal(button.textContent, 'Verifying…')
  options['before-interactive-callback']()
  assert.equal(holder.hidden, false)
  options['after-interactive-callback']()
  assert.equal(holder.hidden, true)
  options['error-callback']()
  assert.equal(button.disabled, false)
  assert.equal(button.textContent, 'Create my account')
  assert.equal(holder.hidden, true)
  listeners.submit({ preventDefault() {} })
  options['expired-callback']()
  assert.equal(button.disabled, false)
  listeners.submit({ preventDefault() {} })
  options.callback('token')
  assert.equal(submits, 1)
  assert.equal(executes, 3)
  assert.equal(holder.hidden, true)
  assert.equal(button.textContent, 'Verifying…', 'the native form submit keeps its progress label until navigation')
  windowListeners.pageshow()
  assert.equal(button.disabled, false)
  assert.equal(button.textContent, 'Create my account')
  assert.equal(resets, 1, 'returning through bfcache clears the used Turnstile token')
})

test('both rendered forms wire the hidden holder and one approved progress label', async () => {
  const built = await build({ entryPoints: [new URL('../src/login-page.ts', import.meta.url).pathname, new URL('../src/signup-page.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'neutral', outdir: '/tmp/scorpio-turnstile-ui-test', write: false, logLevel: 'silent' })
  const modules = await Promise.all(built.outputFiles.map((file) => import(`data:text/javascript;base64,${Buffer.from(file.text).toString('base64')}`)))
  const { loginPage } = modules.find((module) => module.loginPage)
  const { signupPage } = modules.find((module) => module.signupPage)
  const login = await loginPage('en', { google: false, github: false, email: true, siteKey: 'site-key', next: '/app' }).text()
  const signup = await signupPage('zh', { email: 'kai@example.com', siteKey: 'site-key' }).text()
  assert.match(login, /id="email-turnstile"[^>]*hidden/)
  assert.match(login, /data-verifying="Verifying…"/)
  assert.match(signup, /id="signup-turnstile"[^>]*hidden/)
  assert.match(signup, /data-verifying="正在验证…"/)
  assert.match(signup, /api\.js\?render=explicit/)
})
