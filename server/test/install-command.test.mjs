// The install command in invitations. A deployment whose package has its address baked in hands out exactly
// the command it always has: installed computers and invitations already sent depend on it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { installCommand } from '../src/install-command.ts'

test('a package with its server baked in: the command is the one it always was', () => {
  assert.equal(installCommand('https://scorpio.example', { file: 'scorpio-0.26.5-0123456789.tgz' }), 'npx -y https://scorpio.example/dl/scorpio-0.26.5-0123456789.tgz')
  assert.equal(installCommand('https://scorpio.example', { file: 'scorpio-0.26.5-0123456789.tgz', unbound: false }), 'npx -y https://scorpio.example/dl/scorpio-0.26.5-0123456789.tgz')
})

test('a package built without a server: the command passes this address', () => {
  assert.equal(installCommand('https://scorpio.example.workers.dev', { file: 'scorpio-0.26.5-0123456789.tgz', unbound: true }), 'npx -y https://scorpio.example.workers.dev/dl/scorpio-0.26.5-0123456789.tgz --server https://scorpio.example.workers.dev')
})

test('no package served: the published one', () => {
  assert.equal(installCommand('https://scorpio.example', null), 'npx -y @utlabs/scorpio')
})
