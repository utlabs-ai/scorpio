import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ entryPoints: [new URL('../src/workspace-access.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false })
const a = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
test('human member and computer owner are all required, including for public topics', () => {
  const actor = { kind: 'human', name: 'kai', account: 'kai' }, member = { kind: 'human', status: 'active', owner: 'kai' }, host = { kind: 'host', status: 'active', owner: 'kai', device_id: 'box' }
  assert.equal(a.mayViewWorkspace(actor, member, host, 'box', false), true)
  for (const args of [[{ ...actor, kind: 'agent' }, member, host, 'box', false], [actor, undefined, host, 'box', false], [actor, { ...member, status: 'left' }, host, 'box', false], [actor, member, { ...host, owner: 'mei' }, 'box', false], [actor, member, host, 'other', false], [actor, member, host, 'box', true], [{ ...actor, name: 'zoe' }, member, host, 'box', false]]) assert.equal(a.mayViewWorkspace(...args), false)
})
