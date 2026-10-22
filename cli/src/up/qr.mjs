import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../vendor/qrcodegen.mjs', import.meta.url), 'utf8')
const qrcodegen = vm.runInNewContext(source + '\nqrcodegen', Object.create(null), { filename: 'qrcodegen.mjs' })

export function qrMatrix(text) {
  const segments = qrcodegen.QrSegment.makeSegments(String(text))
  const code = qrcodegen.QrCode.encodeSegments(segments, qrcodegen.QrCode.Ecc.LOW, 3, 3, -1, false)
  return Array.from({ length: code.size }, (_, y) =>
    Array.from({ length: code.size }, (_, x) => code.getModule(x, y)))
}

export function qrLines(text, { colors = 256 } = {}) {
  const matrix = qrMatrix(text)
  const border = 2
  const size = matrix.length + border * 2
  const dark = (x, y) => x >= border && y >= border && x < size - border && y < size - border
    ? matrix[y - border][x - border] : false
  const ansi = (top, bottom) => {
    if (colors >= 256) return '\x1b[' + (top ? '38;5;16' : '38;5;231') + ';' + (bottom ? '48;5;16' : '48;5;231') + 'm'
    return '\x1b[' + (top ? '30' : '97') + ';' + (bottom ? '40' : '107') + 'm'
  }
  const lines = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x += 1) line += ansi(dark(x, y), dark(x, y + 1)) + '▀'
    lines.push(line + '\x1b[0m')
  }
  return lines
}

export function qrOutput(text, { isTTY = process.stdout.isTTY, term = process.env.TERM || '', colors = 256 } = {}) {
  if (!isTTY || term === 'dumb') return String(text) + '\n'
  try { return qrLines(text, { colors }).join('\n') + '\n' + text + '\n' }
  catch { return String(text) + '\n' }
}
