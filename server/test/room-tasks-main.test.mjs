import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const tasksFile = new URL('../../web/public/static/room-tasks.js', import.meta.url)

// renderMain runs on every resize, after applyRoom has placed the composer; it must hide it in the same cases applyRoom does.
function composerAfterRenderMain({ viewer, archived = false, quota = { used: 0, limit: 100 } }) {
  const el = () => { const cls = new Set(); return { classList: { add(c) { cls.add(c) }, remove(c) { cls.delete(c) }, toggle(c, on) { on ? cls.add(c) : cls.delete(c) }, contains(c) { return cls.has(c) } } } }
  const composer = el(), jumps = el(), feed = el()
  const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {}, querySelector() { return jumps } } }
  vm.runInNewContext(fs.readFileSync(tasksFile, 'utf8'), sandbox)
  const tasks = sandbox.window.createRoomTasks({
    $: (id) => (id === 'composer' ? composer : el()), S: {}, boot: {}, feed, shell: {}, state: { room: { archived } }, viewer,
    quotaNow: () => quota, clearPopEdit() {}, rowHook() {}, menuHook() {},
    panels: { tab() {}, refresh() {}, kind() {}, sideView() {}, sideOpen() {}, isOpen() {}, renderSide() {} },
  })
  tasks.renderMain()
  return composer.classList.contains('hidden')
}

test('renderMain keeps the composer hidden for a viewer of a public topic', () => {
  assert.equal(composerAfterRenderMain({ viewer: true }), true)
  assert.equal(composerAfterRenderMain({ viewer: true, quota: { used: 100, limit: 100 } }), true)
})

test('renderMain shows the composer to a member with messages left, hides it when archived or out of messages', () => {
  assert.equal(composerAfterRenderMain({ viewer: false }), false)
  assert.equal(composerAfterRenderMain({ viewer: false, archived: true }), true)
  assert.equal(composerAfterRenderMain({ viewer: false, quota: { used: 100, limit: 100 } }), true)
})

// One moving robot per agent, in the members list (design.md §7): a task row draws the default still icon whatever its state.
test('task rows draw the default still robot for open and done items alike', async () => {
  const { ROOM_STRINGS } = await import('../src/strings.ts')
  const drawn = []
  const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} },
    botStill: (name, state, size) => { drawn.push(['still', name, state, size]); return '<svg class="bot"></svg>' },
    botSvg: (name, state) => { drawn.push(['moving', name, state]); return '<svg class="bot working"></svg>' }, escapeHtml: (s) => String(s) }
  vm.runInNewContext(fs.readFileSync(tasksFile, 'utf8'), sandbox)
  const members = [{ name: 'web@kai', kind: 'agent', status: 'active', online: true, work: 'working' }]
  const items = [{ id: 'T1', title: 'doing', status: 'doing', assignee: 'web@kai' }, { id: 'T2', title: 'todo', status: 'todo', assignee: 'web@kai' }, { id: 'T3', title: 'done', status: 'done', assignee: 'web@kai' }]
  const tasks = sandbox.window.createRoomTasks({
    $: () => ({}), S: ROOM_STRINGS.zh, boot: {}, feed: {}, shell: {}, state: { me: 'kai', members, todo: { items } }, viewer: false,
    fill: (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]), agentsRunning: () => 1, waitingOnMe: () => ({ count: 0, stuck: [] }), ago: () => 'now',
    clearPopEdit() {}, rowHook() {}, menuHook() {}, panels: { tab() {}, refresh() {}, kind() {}, sideView() {}, sideOpen() {}, isOpen() {}, renderSide() {} },
  })
  tasks.todoHtml()
  assert.ok(drawn.length >= 2)
  assert.deepEqual(drawn.filter((d) => d[0] !== 'still' || d[2] !== '' || d[3] !== 's16'), [])
})

test('only an agent with an open approval gets the phone-card task link', async () => {
  const { ROOM_STRINGS } = await import('../src/strings.ts')
  const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, escapeHtml: s => String(s) }
  vm.runInNewContext(fs.readFileSync(tasksFile, 'utf8'), sandbox)
  const stuck = [{name:'card@kai',workReason:'approval: Bash'},{name:'legacy@kai',workReason:'Terminal prompt; check that computer'}]
  const tasks = sandbox.window.createRoomTasks({
    $:()=>({}),S:ROOM_STRINGS.en,boot:{},feed:{},shell:{},state:{me:'kai',members:[],todo:{items:[]}},viewer:false,
    fill:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]),agentsRunning:()=>0,waitingOnMe:()=>({count:2,stuck}),
    approvalFor:name=>name==='card@kai'?'card-id':null,clearPopEdit(){},rowHook(){},menuHook(){},
    panels:{tab(){},refresh(){},kind(){},sideView(){},sideOpen(){},isOpen(){},renderSide(){}},
  })
  const html=tasks.todoHtml()
  assert.match(html,/data-approval-link="card-id"/)
  assert.match(html,/Needs your approval · open the card/)
  assert.match(html,/Terminal prompt; check that computer/)
  assert.equal((html.match(/data-approval-link/g)||[]).length,1)
})
