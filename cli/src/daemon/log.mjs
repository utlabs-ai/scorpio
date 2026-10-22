import fs from 'node:fs'
import path from 'node:path'
import { STATE_DIR } from './paths.mjs'

export const LOG_FILE = path.join(STATE_DIR, 'daemon.log')
export const LOG_BYTES = 10 * 1024 * 1024
export const LOG_LINES = 500
export const herdrExit = (subcommand, error) => `herdr ${subcommand} exit ${error?.code ?? error?.exitCode ?? 'unknown'}`

const localIso = (date) => {
  const two = (value) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}${offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`
}

/** One source for the text stream, the on-screen tail, and the two rotating files. */
export function createDaemonLog({ file = LOG_FILE, maxBytes = LOG_BYTES, capacity = LOG_LINES, now = () => new Date(), output = console.log, onLine = () => {} } = {}) {
  const diskLines = () => {
    const rows = []
    for (const name of [`${file}.1`, file]) {
      try { rows.push(fs.readFileSync(name, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    return rows.join('').split('\n').filter(Boolean)
  }
  const ring = diskLines().slice(-capacity).map((line) => {
    const [ts, level, ...rest] = line.split('\t')
    return { ts, level, text: rest.join(' ') }
  })
  let writeOutput = output, notify = onLine
  const append = (level, ...parts) => {
    const date = now()
    const text = parts.map(String).join(' ').replace(/\r?\n/g, ' ⏎ ').replace(/\t/g, ' ')
    const record = { ts: localIso(date), level, text }
    ring.push(record)
    if (ring.length > capacity) ring.shift()
    const row = `${record.ts}\t${level}\t${text}\n`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size + Buffer.byteLength(row) > maxBytes) {
        try { fs.unlinkSync(`${file}.1`) } catch (e) { if (e.code !== 'ENOENT') throw e }
        if (size) fs.renameSync(file, `${file}.1`)
      }
      fs.appendFileSync(file, row, { mode: 0o600 })
    } catch (e) { writeOutput(date.toTimeString().slice(0, 8), `daemon log file: ${e.message}`) }
    writeOutput(date.toTimeString().slice(0, 8), ...parts)
    notify(record)
    return record
  }
  const log = (...parts) => append('info', ...parts)
  log.info = log
  log.warn = (...parts) => append('warn', ...parts)
  log.error = (...parts) => append('error', ...parts)
  log.recent = (count = capacity) => ring.slice(-count)
  log.file = file
  log.setOutput = (fn) => { writeOutput = fn }
  log.onLine = (fn) => { notify = fn }
  log.all = diskLines
  return log
}
