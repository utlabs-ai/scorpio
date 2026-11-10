import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: [new URL('../src/files.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
})
const { fileResponse, fileType, sniffVideo } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

test('video container headers override octet-stream uploads and declared types', () => {
  const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  const mov = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20])
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x93])
  for (const [bytes, type] of [[mp4, 'video/mp4'], [mov, 'video/quicktime'], [webm, 'video/webm']]) {
    assert.equal(sniffVideo(bytes), type)
    assert.equal(fileType(bytes, 'application/octet-stream'), type)
    assert.equal(fileType(bytes, 'text/plain'), type)
  }
  assert.equal(fileType(new TextEncoder().encode('ordinary data'), 'application/octet-stream'), 'application/octet-stream')
  assert.equal(fileType(new TextEncoder().encode('ordinary data'), 'video/mp4'), 'application/octet-stream')
})

test('HEIC ftyp header is not classified as video', () => {
  const heic = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])
  assert.equal(sniffVideo(heic), null)
  assert.equal(fileType(heic, 'application/heic'), 'application/heic')
  assert.equal(fileType(heic, 'image/heic'), 'application/octet-stream')
})

const bytes = new TextEncoder().encode('0123456789')
function env() {
  const reads = []
  return {
    reads,
    FILES: {
      async get(key, options) {
        reads.push({ key, options })
        const range = options?.range
        const part = range ? bytes.slice(range.offset, range.offset + range.length) : bytes
        return { body: new Response(part).body }
      },
    },
  }
}

test('video full response plays inline and advertises byte ranges', async () => {
  for (const type of ['video/mp4', 'video/webm', 'video/quicktime']) {
    const store = env()
    const res = await fileResponse(store, 'key', { name: 'movie.mov', type, size: bytes.length })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), type)
    assert.match(res.headers.get('content-disposition'), /^inline;/)
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('content-length'), '10')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-security-policy'), /sandbox/)
    assert.equal(await res.text(), '0123456789')
    assert.deepEqual(store.reads, [{ key: 'key', options: undefined }])
  }
})

test('video range reads only requested R2 bytes and returns 206', async () => {
  const store = env()
  const res = await fileResponse(store, 'key', { name: 'movie.mp4', type: 'video/mp4', size: bytes.length }, 'bytes=2-5')
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(res.headers.get('content-length'), '4')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(await res.text(), '2345')
  assert.deepEqual(store.reads, [{ key: 'key', options: { range: { offset: 2, length: 4 } } }])
})

test('other file types remain downloads and ignore Range', async () => {
  const store = env()
  const res = await fileResponse(store, 'key', { name: 'notes.txt', type: 'text/plain', size: bytes.length }, 'bytes=2-5')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/octet-stream')
  assert.match(res.headers.get('content-disposition'), /^attachment;/)
  assert.equal(res.headers.get('accept-ranges'), null)
  assert.equal(await res.text(), '0123456789')
  assert.deepEqual(store.reads, [{ key: 'key', options: undefined }])
})
