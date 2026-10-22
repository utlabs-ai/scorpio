// Seven-row ASCII Pobi sprite for the cold-start animation.
export const SW = 24
export const LW = 27
const BASE = [
  '                        ',
  '                        ',
  '      .---------.       ',
  '     /  .-----.  \\      ',
  '    |  |       |  |     ',
  "     \\  '-----'  /      ",
  "       '-------'        ",
]
const ANT = { C: [10, '|'], R: [11, '/'], L: [9, '\\'] }
const EYE = {
  o: [10, 'o o'], blink: [10, '- -'], closed: [10, '- -'], left: [9, 'o o'], blinkL: [9, '- -'],
  right: [11, 'o o'], blinkR: [11, '- -'], happy: [10, '^ ^'],
}
const HAND = { restL: [6, 3], restR: [6, 18], waveOut: [2, 1], waveIn: [1, 3], ear: [4, 20] }
const put = (rows, row, col, value) => {
  const chars = [...rows[row]]
  for (const [offset, char] of [...value].entries()) chars[col + offset] = char
  rows[row] = chars.join('')
}
export function pobi({ ant = 'C', eye = 'o', hands = ['restL', 'restR'], arcs = [], lamp = '@' } = {}, width = SW) {
  const rows = BASE.map((row) => row.padEnd(width))
  const [lampCol, stem] = ANT[ant]
  put(rows, 0, lampCol, `(${lamp})`)
  put(rows, 1, 11, stem)
  const [eyeCol, eyes] = EYE[eye]
  put(rows, 4, eyeCol, eyes)
  for (const hand of hands) {
    const [row, col] = HAND[hand]
    put(rows, row, col, '()')
  }
  for (const [row, col, char] of arcs) put(rows, row, col, char)
  return rows
}
const rest = { ant: 'C', eye: 'o' }
export const OPEN_FRAMES = [
  { name: 'rest', sprite: rest, ms: 220 },
  { name: 'blink', sprite: { ...rest, eye: 'blink' }, ms: 110 },
  { name: 'rest', sprite: rest, ms: 170 },
  { name: 'antR', sprite: { ...rest, ant: 'R' }, ms: 110 },
  { name: 'antC', sprite: rest, ms: 70 },
  { name: 'antL', sprite: { ...rest, ant: 'L' }, ms: 110 },
  { name: 'rest', sprite: rest, ms: 0 },
]
const look = { ...rest, eye: 'left' }
const tilt = { ant: 'R', eye: 'right', hands: ['restL', 'ear'] }
const arc1 = [[4, 26, '(']]
const arc2 = [[3, 25, '('], [4, 24, '('], [5, 25, '(']]
export const WAVE_FRAMES = [
  { name: 'look', sprite: look, ms: 900 },
  { name: 'waveOut', sprite: { ...look, hands: ['waveOut', 'restR'] }, ms: 200 },
  { name: 'waveIn', sprite: { ...look, hands: ['waveIn', 'restR'] }, ms: 200 },
  { name: 'waveOut', sprite: { ...look, hands: ['waveOut', 'restR'] }, ms: 200 },
  { name: 'waveIn', sprite: { ...look, hands: ['waveIn', 'restR'] }, ms: 200 },
  { name: 'waveOut', sprite: { ...look, hands: ['waveOut', 'restR'] }, ms: 200 },
  { name: 'look', sprite: look, ms: 1700 },
  { name: 'blinkL', sprite: { ...look, eye: 'blinkL' }, ms: 110 },
]
export const WAVE_END = { approved: { ...rest, eye: 'happy' }, expired: rest, still: look }
export const LISTEN_FRAMES = [
  { name: 'tilt', sprite: tilt, ms: 400 },
  { name: 'arc1', sprite: { ...tilt, arcs: arc1 }, ms: 260 },
  { name: 'arc2', sprite: { ...tilt, arcs: arc2 }, ms: 260 },
  { name: 'tilt', sprite: tilt, ms: 320 },
  { name: 'arc1', sprite: { ...tilt, arcs: arc1 }, ms: 260 },
  { name: 'arc2', sprite: { ...tilt, arcs: arc2 }, ms: 260 },
  { name: 'tilt', sprite: tilt, ms: 1300 },
  { name: 'blinkR', sprite: { ...tilt, eye: 'blinkR' }, ms: 110 },
]
