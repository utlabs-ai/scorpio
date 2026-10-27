/** Accept HTTP server addresses without embedded credentials or URL suffixes. */
export function serverUrl(value) {
  const text = String(value)
  if (/[\x00-\x20\x7f-\x9f]/.test(text)) throw new Error('Invalid server URL.')
  const url = new URL(text)
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:')) {
    throw new Error('Server URL must use http or https, without credentials, query or fragment.')
  }
  return text.replace(/\/+$/, '')
}

export function verificationUrl(value, base) {
  const link = new URL(value)
  if (/[\x00-\x20\x7f-\x9f]/.test(String(value)) || link.origin !== new URL(serverUrl(base)).origin || link.username || link.password) throw new Error('Approval link must be on the configured server.')
  return link.href
}
