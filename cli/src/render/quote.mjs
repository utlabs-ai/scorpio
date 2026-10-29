export const FRAME = '+' + '-'.repeat(38) + '+'
export const boxed = (text) => [FRAME, ...String(text ?? '').replace(/\n$/, '').split('\n').map((line) => line ? `│ ${line}` : '│'), FRAME].join('\n')

/** Can this go into a terminal as typed text? Newline and tab only; every other control character is a key press. */
export function typeable(text) {
  return !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(String(text ?? ''))
}

// Typed into a terminal, a control character is a key press (Ctrl-C interrupts the agent, a carriage
// return submits half a message). We never alter what people wrote, so such a text is not typed at
// all: the agent gets a line telling it how to fetch the original. `wait` prints, it does not type,
// so it passes everything through.
export const quoted = (text, terminal, what, fetch) => (terminal && !typeable(text)
  ? `(The ${what} contains control characters that cannot be typed into a terminal, so it is not pasted here. Read it with: ${fetch})`
  : boxed(text))

export const flat = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
