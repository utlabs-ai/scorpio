import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

test('route error rules live outside Worker assembly, and domain routes only translate requests', () => {
  const root = new URL('../src/', import.meta.url)
  const index = fs.readFileSync(new URL('index.ts', root), 'utf8')
  assert.ok(!index.includes('schedules(?:\\/[^/]+)?|code|topic|roleCard'), 'the old /r error regex is gone')
  const routeDir = new URL('routes/', root)
  for (const name of fs.readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(new URL(name, routeDir), 'utf8')
    assert.doesNotMatch(source, /from ["']\.\.\/index(?:\.ts)?["']/, name)
    assert.doesNotMatch(source, /push_subscriptions|push_muted_rooms/, name)
  }
})

test('room index statements live outside routes and room actions', () => {
  const root = new URL('../src/', import.meta.url)
  const routeDir = new URL('routes/', root)
  const files = [
    ...fs.readdirSync(routeDir).filter((f) => f.endsWith('.ts')).map((f) => new URL(f, routeDir)),
    ...['room-actions.ts', 'room-stub.ts', 'room-purge.ts'].map((f) => new URL(f, root)),
  ]
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /FROM rooms|INTO rooms|UPDATE rooms|`create:|\b(FROM|JOIN|INTO|UPDATE)\s+room_members\b/, file.pathname)
  }
})

test('route modules do not query devices directly', () => {
  const routeDir = new URL('../src/routes/', import.meta.url)
  for (const name of fs.readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(new URL(name, routeDir), 'utf8')
    assert.doesNotMatch(source, /\b(FROM|INTO|UPDATE)\s+devices\b/, name)
  }
})

test('route modules leave data access to domain owners except the minimum CLI config', () => {
  const routeDir = new URL('../src/routes/', import.meta.url)
  for (const name of fs.readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(new URL(name, routeDir), 'utf8')
    assert.doesNotMatch(source, /env\.(?:DB|FILES)\./, name)
    const kvCalls = source.match(/env\.KV\./g) ?? []
    if (name === 'shared.ts') {
      assert.equal(kvCalls.length, 1, name)
      assert.match(source, /env\.KV\.get\("config:min_cli", \{ cacheTtl: 60 \}\)/, name)
    } else {
      assert.equal(kvCalls.length, 0, name)
    }
  }
})
