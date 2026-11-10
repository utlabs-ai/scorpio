import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

// server/src/zip.ts: a store-only zip written as a stream, checked with a reference reader (Python's zipfile, which
// verifies every CRC with testzip; unzip -t where Python is missing).
const built = await build({
  entryPoints: [new URL('../src/zip.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', external: ['node:*'],
})
const { ZipWriter, dosTime, chunksOf, text, descriptor, endRecord, localHeader } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const AT = dosTime(2026, 11, 2, 14, 3, 9)
async function zipOf(entries) {
  const chunks = []
  const w = new ZipWriter(async (c) => { chunks.push(Buffer.from(c)) }, AT)
  for (const [name, parts] of entries) await w.entry(name, parts)
  await w.end()
  return Buffer.concat(chunks)
}
function inspect(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-zip-'))
  const file = path.join(dir, 'x.zip')
  fs.writeFileSync(file, zip)
  const out = execFileSync('python3', ['-I', '-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "entries": [{"name": i.filename, "size": i.file_size, "compress": i.compress_type, "crc": i.CRC, "flags": i.flag_bits, "date": list(i.date_time), "body": z.read(i).decode("utf-8", "replace") if i.file_size < 200 else None} for i in z.infolist()]}))
`, file], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return JSON.parse(out)
}

test('dosTime packs the fields; years before 1980 are clamped', () => {
  assert.deepEqual(dosTime(2026, 11, 2, 14, 3, 9), { date: ((46 << 9) | (11 << 5) | 2), time: ((14 << 11) | (3 << 5) | 4) })
  assert.equal(dosTime(1970, 1, 1, 0, 0, 0).date, (0 << 9) | (1 << 5) | 1)
})

test('headers have their signatures and sizes', () => {
  assert.equal(localHeader(text('a.txt'), AT).length, 30 + 5)
  assert.equal(descriptor(1, 2).length, 16)
  assert.equal(endRecord(0, 0, 0).length, 22)
  assert.equal(Buffer.from(endRecord(1, 2, 3)).readUInt32LE(0), 0x06054b50)
})

test('a zip of text, UTF-8 names and a streamed entry opens with a reference reader, every CRC right', async () => {
  const big = Buffer.alloc(300_000, 7)
  const stream = new ReadableStream({ start(c) { c.enqueue(big.subarray(0, 100_000)); c.enqueue(big.subarray(100_000)); c.close() } })
  const zip = await zipOf([
    ['主题-2026-11-02/topic.md', [text('# 主题\n'), text('line two\n')]],
    ['主题-2026-11-02/data.json', [text('{"format":1}')]],
    ['主题-2026-11-02/files/abc-report.bin', chunksOf(stream)],
    ['主题-2026-11-02/handoffs/empty.md', []],
  ])
  const z = inspect(zip)
  assert.equal(z.bad, null)
  assert.deepEqual(z.entries.map((e) => [e.name, e.size, e.compress]), [
    ['主题-2026-11-02/topic.md', 18, 0], ['主题-2026-11-02/data.json', 12, 0], ['主题-2026-11-02/files/abc-report.bin', 300_000, 0], ['主题-2026-11-02/handoffs/empty.md', 0, 0],
  ])
  assert.equal(z.entries[0].body, '# 主题\nline two\n')
  assert.deepEqual(z.entries[0].date, [2026, 11, 2, 14, 3, 8])
  for (const e of z.entries) assert.equal(e.flags & 0x0808, 0x0808)
  // The end record is the last 22 bytes: what the CLI checks before it keeps a download.
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50)
})

test('an empty zip is still a zip', async () => {
  const z = inspect(await zipOf([]))
  assert.equal(z.bad, null)
  assert.deepEqual(z.entries, [])
})
