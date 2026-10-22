// Keep the account address visible alongside the nickname a person chose.
export function personName(name, displayName) {
  const nickname = String(displayName ?? '').replace(/[\x00-\x1f\x7f-\x9f|]+/g, ' ').trim()
  return nickname && displayName !== name ? `${name} (nickname: ${nickname})` : name
}
