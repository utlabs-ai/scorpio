// The computer's id goes to the server only as a sha256, for invites; nothing when it cannot be read.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { machineId, rawMachineId } from '../src/machine-id.mjs'

const sha = (s) => createHash('sha256').update(s).digest('hex')

test('daemon topic joins send a nonce and seat data without a machine hash', async () => {
  const { createApi } = await import('../src/daemon/api.mjs')
  let sent
  const api = createApi({ server: 'https://scorpio.example.com', token: () => 'test-token', fetchImpl: async (url, init) => {
    sent = { url, body: JSON.parse(init.body) }
    return new Response('{}', { status: 200 })
  } })
  await api.join('topic', { host: true, deviceId: 'box' })
  assert.equal(sent.url, 'https://scorpio.example.com/api/v1/rooms/topic/join')
  assert.equal(sent.body.host, true)
  assert.equal(sent.body.deviceId, 'box')
  assert.ok(sent.body.nonce)
  assert.equal(Object.hasOwn(sent.body, 'machine_id'), false)
})

test('macOS reads IOPlatformUUID; Linux /etc/machine-id, else the dbus one; none is null', () => {
  const ioreg = '+-o IOPlatformExpertDevice\n    "IOPlatformUUID" = "1F2E3D4C-0000-1111-2222-333344445555"\n'
  assert.equal(rawMachineId({ platform: 'darwin', run: () => ioreg }), '1F2E3D4C-0000-1111-2222-333344445555')
  assert.equal(rawMachineId({ platform: 'darwin', run: () => { throw new Error('no ioreg') } }), null)
  const files = { '/etc/machine-id': 'abc123\n', '/var/lib/dbus/machine-id': 'dbus456\n' }
  const read = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }
  assert.equal(rawMachineId({ platform: 'linux', read }), 'abc123')
  delete files['/etc/machine-id']
  assert.equal(rawMachineId({ platform: 'linux', read }), 'dbus456')
  files['/var/lib/dbus/machine-id'] = '  \n'
  assert.equal(rawMachineId({ platform: 'linux', read }), null)
})

test('what is sent is the sha256 of the id, never the id', () => {
  const read = () => 'abc123\n'
  assert.equal(machineId({ platform: 'linux', read }), sha('abc123'))
  assert.match(machineId({ platform: 'linux', read }), /^[0-9a-f]{64}$/)
  assert.equal(machineId({ platform: 'linux', read: () => { throw new Error('ENOENT') } }), null)
})
