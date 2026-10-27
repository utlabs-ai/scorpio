export function paneTextError(text) {
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return 'The text must be one line, without tabs or other control characters (press keys with /keys)'
  if (/^\s*!/.test(text)) return 'The text must not start with !'
  return null
}
