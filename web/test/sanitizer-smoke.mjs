// Browser-only compatibility smoke for the actual Monaco sanitizer adapter; never an application entry point.
import purify from '../node_modules/dompurify/dist/purify.es.mjs'
import { sanitizeHtml } from 'monaco-editor/base/browser/domSanitize.js'

export function runSanitizerSmoke() {
  const methods = ['sanitize', 'addHook', 'removeAllHooks'], calls = Object.fromEntries(methods.map(name => [name, 0])), originals = {}
  for (const name of methods) {
    if (typeof purify[name] !== 'function') throw new Error(`Missing sanitizer method: ${name}`)
    originals[name] = purify[name]
    purify[name] = function (...args) { calls[name]++; return originals[name].apply(purify, args) }
  }
  try {
    const normal = String(sanitizeHtml('<b onclick="bad()">safe</b><script>bad()</script><a href="javascript:bad()">link</a>'))
    const configured = String(sanitizeHtml('<img src="https://example.com/sanitizer-smoke">', { mediaSourceIsAllowed: () => false, allowedMediaProtocols: { override: [] } }))
    return { version: purify.version, calls, safeMarkupRetained: normal.includes('<b>safe</b>'), scriptRemoved: !normal.includes('<script'), eventRemoved: !normal.includes('onclick'), unsafeLinkRemoved: !normal.includes('javascript:'), configuredMediaRemoved: !configured.includes('https://example.com') }
  } finally { for (const name of methods) purify[name] = originals[name] }
}
