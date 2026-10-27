/** Credentials and packages must never cross a clear-text remote connection. */
export function serverUrl(value) {
  const text = String(value)
  if (/[\x00-\x20\x7f-\x9f]/.test(text)) throw new Error('Invalid server URL.')
  const url = new URL(text)
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Server URL must use https, except localhost or 127.0.0.1.')
  }
  return text.replace(/\/+$/, '')
}

export function verificationUrl(value, base) {
  const link = new URL(value)
  if (/[\x00-\x20\x7f-\x9f]/.test(String(value)) || link.origin !== new URL(serverUrl(base)).origin || link.username || link.password) throw new Error('Approval link must be on the configured server.')
  return link.href
}
