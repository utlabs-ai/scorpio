import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('first agent keeps its own permissions and passes an environment API key through a private file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-agent-'))
  const previousHome = process.env.SCORPIO_HOME
  const previousKey = process.env.OPENAI_API_KEY
  const previousServer = process.env.SCORPIO_SERVER
  process.env.SCORPIO_HOME = home
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: 'https://scorpio.example.com/' }))
  process.env.OPENAI_API_KEY = 'test-only-key-marker'
  try {
    const { ensureAgentPane } = await import('../src/up/agent.mjs')
    let secretPath = ''
    const terminal = {
      agents: async () => [],
      newTab: async ({ label, env }) => {
        assert.equal(label, 'pobi')
        assert.equal(JSON.stringify(env).includes('test-only-key-marker'), false)
        return { tab: 'w1:t2', pane: 'w1:p2' }
      },
      renameTab: async () => { throw new Error('Unexpected tab rename.') },
      waitShell: async () => ({ ok: true }),
      run: async (_pane, command) => {
        assert.equal(command.includes('test-only-key-marker'), false)
        secretPath = command.slice(2).replace(/^'|'$/g, '')
        assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600)
        assert.match(fs.readFileSync(secretPath, 'utf8'), /test-only-key-marker/)
      },
      startAgent: async ({ name, argv }) => {
        assert.equal(name, 'pobi')
        assert.equal(argv.length, 1)
        assert.equal(argv[0].includes('test-only-key-marker'), false)
        assert.equal(argv[0].includes('--allowedTools'), false)
        assert.equal(argv[0].includes('--dangerously-skip-permissions'), false)
        assert.equal(argv[0].includes('--ask-for-approval'), false)
        assert.match(argv[0], /pane=w1:p2/)
        assert.match(argv[0], /role=pobi/)
        assert.ok(argv[0].includes('https://scorpio.example.com/r/Ntn0WcNeFSnP2iFWWBDeht'))
        assert.doesNotMatch(argv[0], /role=codex/)
      },
    }
    const result = await ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'Ntn0WcNeFSnP2iFWWBDeht', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal, inspectPane: async () => null,
    })
    assert.equal(result.pane, 'w1:p2')
    assert.equal(result.name, 'pobi@kai')
    process.env.SCORPIO_SERVER = 'https://override.example.com/'
    const { firstPrompt } = await import('../src/up/agent.mjs')
    assert.ok(firstPrompt({ agent: { role: 'pobi' }, topicId: 'topic-id', pane: 'w1:p2', account: 'kai' })
      .includes('https://override.example.com/r/topic-id'))
    assert.equal(fs.existsSync(secretPath), false)
    const reused = await ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'Ntn0WcNeFSnP2iFWWBDeht', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal: { ...terminal,
        agents: async () => { throw new Error('Name lookup should not be needed for reuse.') },
        newTab: async () => { throw new Error('Should reuse the recorded pane.') },
      }, inspectPane: async (_bin, pane) => {
        assert.equal(pane, 'w1:p2')
        return { agent: 'codex', tab_id: 'w1:t2' }
      },
    })
    assert.equal(reused.reused, true)
    let suffixName = ''
    let suffixLabel = ''
    await ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'SecondTopic1234567890', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal: { ...terminal,
        agents: async () => [{ name: 'pobi', pane_id: 'w1:p9' }, { name: 'pobi-2', pane_id: 'w1:p8' }],
        renameTab: async (_tab, label) => { suffixLabel = label },
        startAgent: async ({ name, argv }) => {
          suffixName = name
          assert.match(argv[0], /role=pobi/)
        },
      }, inspectPane: async () => null,
    })
    assert.equal(suffixName, 'pobi-3')
    assert.equal(suffixLabel, 'pobi-3')
    let raceNames = []
    let raceLive = []
    let raceLabel = ''
    await ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'ThirdTopic12345678901', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal: { ...terminal,
        agents: async () => raceLive,
        renameTab: async (_tab, label) => { raceLabel = label },
        startAgent: async ({ name }) => {
          raceNames.push(name)
          if (name === 'pobi') {
            raceLive = [{ name, pane_id: 'w1:p9' }]
            throw new Error('name claimed by another pane')
          }
        },
      }, inspectPane: async () => null,
    })
    assert.deepEqual(raceNames, ['pobi', 'pobi-2'])
    assert.equal(raceLabel, 'pobi-2')
    let startAttempted = false
    const timeout = new Error('Command failed: herdr agent start')
    timeout.stderr = '{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}'
    const started = await ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'TimeoutTopic123456789', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal: { ...terminal, startAgent: async ({ timeoutMs }) => {
        assert.equal(timeoutMs, 5_000)
        startAttempted = true
        throw timeout
      } },
      inspectPane: async () => startAttempted ? { agent: 'codex' } : null,
    })
    assert.equal(started.reused, false)
    assert.equal(started.pane, 'w1:p2')
    let blockedStarts = 0
    let blockedInspections = 0
    const blocked = new Error('Command failed: herdr agent start')
    blocked.stderr = '{"error":{"code":"agent_not_ready","message":"agent pobi is blocked during startup"}}'
    const waiting = await ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'BlockedTopic123456789', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal: { ...terminal, startAgent: async () => {
        blockedStarts += 1
        throw blocked
      } },
      inspectPane: async () => { blockedInspections += 1; return null },
    })
    assert.deepEqual(waiting, { pane: 'w1:p2', name: 'pobi@kai', reused: false, waiting: true })
    assert.equal(blockedStarts, 1)
    assert.equal(blockedInspections, 1)
    const herdrFailure = new Error('Command failed: herdr agent start ... Use the scorpio skill. Join this topic now ...')
    herdrFailure.stderr = '{"error":{"code":"invalid_agent_name","message":"agent name must be lowercase"}}'
    await assert.rejects(ensureAgentPane({
      agent: { kind: 'codex', role: 'pobi' }, account: 'kai',
      topic: { roomId: 'OtherTopic123456789012', name: 'Hello Scorpio' },
      workdir: path.join(home, 'work'), herdrBin: 'herdr', workspaceId: 'w1',
      terminal: { ...terminal, startAgent: async () => { throw herdrFailure } }, inspectPane: async () => null,
    }), (error) => error.message === 'invalid_agent_name: agent name must be lowercase')
    assert.equal(fs.existsSync(secretPath), false)
  } finally {
    if (previousServer === undefined) delete process.env.SCORPIO_SERVER
    else process.env.SCORPIO_SERVER = previousServer
    if (previousHome === undefined) delete process.env.SCORPIO_HOME
    else process.env.SCORPIO_HOME = previousHome
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Herdr names use the chosen Scorpio role and numeric suffixes', async () => {
  const { herdrAgentName } = await import('../src/up/agent.mjs')
  for (const name of [herdrAgentName('pobi'), herdrAgentName('pobi', 2), herdrAgentName('alex_2', 3)]) {
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/)
  }
  assert.equal(herdrAgentName('pobi'), 'pobi')
  assert.equal(herdrAgentName('pobi', 2), 'pobi-2')
  assert.equal(herdrAgentName('alex_2', 3), 'alex_2-3')
  assert.equal(herdrAgentName('a'.repeat(32), 2), 'a'.repeat(30) + '-2')
})
