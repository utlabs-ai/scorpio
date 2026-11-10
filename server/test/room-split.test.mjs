import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'

const roomFile = new URL('../../web/public/static/room.js', import.meta.url)
const filesFile = new URL('../../web/public/static/room-files.js', import.meta.url)
const tasksFile = new URL('../../web/public/static/room-tasks.js', import.meta.url)
const feedFile = new URL('../../web/public/static/room-feed.js', import.meta.url)
const schedulesFile = new URL('../../web/public/static/room-schedules.js', import.meta.url)
const atFile = new URL('../../web/public/static/room-at.js', import.meta.url)
const membersFile = new URL('../../web/public/static/room-members.js', import.meta.url)
const composerFile = new URL('../../web/public/static/room-composer.js', import.meta.url)
const settingsFile = new URL('../../web/public/static/room-settings.js', import.meta.url)
const storeFile = new URL('../../web/public/static/room-store.js', import.meta.url)
const staticDir = new URL('../../web/public/static/', import.meta.url)
const exports = ['flAfter', 'flClick', 'flHtml', 'flLive', 'flTyping']
const feedForwards = ['closeMenu', 'closeLinkMenu', 'exitSelect', 'textClick', 'jumpTo', 'jumpSearch', 'jumpDown', 'goBack', 'pruneTrail', 'nearBottom', 'append', 'maybeMark', 'refreshReadLines', 'readLine', 'filesChanged', 'updateJump', 'unreadForMe', 'lastSeq', 'loadEarlier', 'rowName', 'quoteHtml']
// Read by room.js through roomFeed itself, not through a forwarder.
const feedDirect = ['rowHook', 'listen', 'menuHook', 'menuOpen', 'linkOpen', 'selecting', 'helloMe', 'helloMessages', 'myCursor', 'readLinesMoved', 'unreadFromMentions', 'updated']
const filterFeedApi = ['anchor', 'restore', 'renderMessage', 'refreshTop', 'indexSparse', 'dropSparse', 'formeRows', 'growUp', 'placeTimes']
const feedExports = [...filterFeedApi, 'avatar', 'fmtTime', 'kindLabel', 'names', ...feedDirect, ...feedForwards]
const atForwards = ['loadMentions']
// Read directly by settings.
const atDirect = ['count']
const atExports = [...atForwards, ...atDirect]
// The members' API: forwarded by room.js under the old names, or read through roomMembers itself.
const memberForwards = ['ownerOf', 'shownName', 'nameText', 'myAgents', 'isWorkingAgent', 'shown', 'presence', 'robot', 'computerOf',
  'showMember', 'refreshPopup', 'saveCard', 'removeComputer', 'toggleMemberFold', 'sizePop']
// The rest of the popup engine: only the settings use it, through roomMembers.
const memberEngine = ['popup', 'editBox', 'growBox', 'showCount', 'charCount']
const memberDirect = ['membersHtml', 'filterClick', 'filterInput', 'TOPIC_MAX', 'popEdit', 'clearPop', 'cursorMoved', 'set', 'roleCardOf', 'saveLane']
const memberExports = [...memberForwards, ...memberEngine, ...memberDirect]
// The settings' API: forwarded by room.js under the old names, or read through settings itself.
const settingsForwards = ['plainLines', 'topicHtml', 'showTopic', 'saveTopic', 'saveName', 'placeInvite', 'showInvite', 'setRoom', 'applyRoom', 'quotaNow', 'setQuota',
  'showSettings', 'sizeTopic', 'settingsAct', 'setVisibility', 'restoreRoom', 'renderRoomMenu', 'closeRoomMenu', 'roomGone', 'removedFromRoom']
const settingsDirect = ['listen', 'knowMembers', 'setCode', 'setQuotaFromHello', 'reapplyQuota', 'quotaFrame']
const settingsExports = [...settingsForwards, ...settingsDirect]
// The composer's API: forwarded by room.js for the callers that stay there, read through composer itself, or captured by the feed.
const composerForwards = ['setReply', 'isTall', 'setTall', 'autosize', 'saveDraft', 'send', 'loadDraft', 'loadOutbox', 'pump', 'insertMention', 'hidePicker']
const composerDirect = ['takeOver', 'clear', 'hasFiles', 'hookFeed', 'listen', 'dayText', 'outbox', 'outEl', 'arrived', 'callBack', 'deliveryNotes', 'editSend', 'retrySend', 'placeOutbox', 'mySeats', 'startSpawn', 'refusal']
const composerExports = [...composerForwards, ...composerDirect]
const taskExports = ['applyTodo', 'closeItem', 'itemsOf', 'markDone', 'openItem', 'pendingDone', 'refreshTodo', 'renderMain', 'todoHtml', 'toggleDone', 'toggleThreadFold']
const panelStub = () => ({ tab() {}, refresh() {}, kind() {}, sideView() {}, sideOpen() {}, isOpen() {}, renderSide() {} })

test('room-files creates only the declared attachment API with blocked storage', () => {
  const sandbox = {
    window: { addEventListener() {} },
    document: { addEventListener() {}, fonts: null },
    localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } },
  }
  vm.runInNewContext(fs.readFileSync(filesFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomFiles, 'function')
  const names = ['$', 'GO_DOWN', 'GO_PAGE', 'S', 'boot', 'clock', 'closePanel', 'dayText', 'extOf', 'fileLinkAttrs', 'fill', 'jumpTo', 'openPanel', 'panel', 'picAttrs', 'rowName', 'sizeText']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  Object.assign(ctx, { boot: {}, S: {}, panel: {}, panels: panelStub() })
  assert.deepEqual(Object.keys(sandbox.window.createRoomFiles(ctx)).sort(), exports.slice().sort())
})

test('room.js forwards each attachment export and no longer contains attachment internals', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  for (const name of exports) {
    assert.ok(source.includes(`function ${name}() { return files.${name}.apply(this, arguments); }`), name)
  }
  assert.doesNotMatch(source, /var TEXT_MAX;/)
  for (const name of ['addPics', 'setSpace', 'renderStrip']) assert.ok(!source.includes(`return files.${name}.apply`), name)
  for (const name of ['flLoad', 'compress']) assert.doesNotMatch(source, new RegExp(`function ${name}\\(`))
  for (const marker of ['PIC_MAX_BYTES', 'createImageBitmap']) assert.doesNotMatch(source, new RegExp(marker))
})

test('room-files no longer holds the composer\'s attachments', () => {
  const source = fs.readFileSync(filesFile, 'utf8')
  for (const name of ['addPics', 'compress', 'setSpace', 'renderSpace', 'renderStrip', 'clearPics', 'dayText']) assert.doesNotMatch(source, new RegExp(`function ${name}\\(`), name)
  for (const marker of ['PIC_MAX', 'TEXT_MAX', 'state.pics']) assert.ok(!source.includes(marker), marker)
})

test('room-composer creates only the declared composer API', () => {
  const sandbox = {
    window: {},
    document: { createElement: () => ({}) },
    sessionStorage: { getItem() { throw new Error('blocked') } },
  }
  vm.runInNewContext(fs.readFileSync(composerFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomComposer, 'function')
  const names = ['$', 'RECEIPT', 'S', 'ago', 'append', 'ask', 'avatar', 'boot', 'canWrite', 'clock', 'computerOf', 'extOf', 'feed', 'fileRow', 'fill', 'flash', 'input', 'isCoarse', 'lastSeq', 'myAgents', 'names', 'nearBottom', 'ownerOf', 'picker', 'post', 'postWithin', 'presence', 'quoteHtml', 'quotaNow', 'readLine', 'rowName', 'setQuota', 'shown', 'shownName', 'sizeText', 'state', 'textChanged']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  Object.assign(ctx, { boot: {}, S: {}, state: {}, input: {}, feed: {} })
  const composer = sandbox.window.createRoomComposer(ctx)
  assert.deepEqual(Object.keys(composer).sort(), composerExports.slice().sort())
  const hooks = [], menuHooks = []
  composer.hookFeed((slot) => hooks.push(slot), (slot) => menuHooks.push(slot))
  assert.deepEqual(hooks, ['notes', 'receipt', 'notesRedraw'])
  assert.deepEqual(menuHooks, ['compose'])
})

test('room.js forwards each composer export and no longer contains composer internals', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  for (const name of composerForwards) {
    assert.ok(source.includes(`function ${name}() { return composer.${name}.apply(this, arguments); }`), name)
  }
  for (const name of ['clearDraft', 'grow', 'sendRefusal', 'nonce', 'saveOutbox', 'drawOut', 'dropOut', 'arrived', 'outById', 'retrySend', 'editSend', 'saveNotes', 'deliveryRows', 'deliveryNotes', 'notePending', 'noteEntries', 'notesHtml', 'drawNotes', 'callBack', 'composeMenu', 'mentionAtEnd']) {
    assert.doesNotMatch(source, new RegExp(`function ${name}\\(`), name)
  }
  for (const marker of ['DRAFT_KEY', 'OUT_KEY', 'NOTES_KEY', 'var outbox', 'var outEl', 'var notes', 'schedules.isEditing', 'schedules.save', 'restoreSendButton', 'clearComposer', 'data-sched-cancel', 'M8 13.5V2.5']) assert.ok(!source.includes(marker), marker)
  assert.doesNotMatch(source, /function showPicker\(/)
  assert.doesNotMatch(source, /var COMMANDS/)
})

test('only the composer writes the composer\'s pictures and reply', () => {
  const dir = new URL('../../web/public/static/', import.meta.url)
  for (const name of fs.readdirSync(dir).filter((name) => /^room-.*\.js$/.test(name) && name !== 'room-composer.js')) {
    const source = fs.readFileSync(new URL(name, dir), 'utf8')
    assert.ok(!source.includes('state.pics') && !source.includes('state.reply'), name)
  }
})

test('room-schedules borrows the composer instead of editing it', () => {
  const source = fs.readFileSync(schedulesFile, 'utf8')
  assert.match(source, /ctx\.composer\.takeOver\(/)
  for (const marker of ['isEditing', 'btn-send', 'data-sched-cancel', 'ctx.renderStrip', 'ctx.setReply', 'ctx.composerChanged', 'ctx.clearComposer', 'ctx.restoreSendButton', 'ctx.hasFiles', 'beforePics', 'beforeReply']) assert.ok(!source.includes(marker), marker)
})

test('room-feed creates only the declared feed API, and each row and menu hook has one owner', () => {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(feedFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomFeed, 'function')
  const names = ['$', 'RECEIPT', 'S', 'arrived', 'boot', 'callBack', 'canWrite', 'copy', 'editSend', 'feed', 'fill', 'flash', 'openItem', 'openPanel', 'openSchedule', 'outEl', 'outbox', 'ownerOf', 'panels', 'placeInvite', 'placeOutbox', 'post', 'retrySend', 'setReply', 'shownName', 'state', 'toast', 'updateChips', 'viewer', 'writeFeed']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  Object.assign(ctx, { boot: {}, S: {}, state: { messages: [] }, outbox: [], outEl: {}, viewer: false, panels: panelStub() })
  const feed = sandbox.window.createRoomFeed(ctx)
  assert.deepEqual(Object.keys(feed).sort(), feedExports.slice().sort())
  feed.rowHook('todo', () => '')
  assert.throws(() => feed.rowHook('todo', () => ''), /already registered/)
  feed.menuHook('todo', () => [])
  assert.throws(() => feed.menuHook('todo', () => []), /already registered/)
})

test('room.js forwards each feed export and no longer contains feed internals', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  for (const name of feedExports.filter((name) => !feedDirect.includes(name) && !filterFeedApi.includes(name))) {
    assert.ok(source.includes(`function ${name}() { return roomFeed.${name}.apply(this, arguments); }`), name)
  }
  for (const name of ['renderMessage', 'readersOf', 'msgBody', 'anchor', 'prependOlder', 'seek', 'lightUp', 'openMenu']) assert.doesNotMatch(source, new RegExp(`function ${name}\\(`))
  for (const marker of ['var trail', 'var heldLatest', 'var loadingEarlier', 'var markTimer', 'FOLD_CHARS', 'todoLine', 'schedules.footer', 'schedules.systemText', 'MENU_ICON_PATHS']) assert.ok(!source.includes(marker), marker)
})

test('both room scripts pass node --check', () => {
  for (const file of [roomFile, filesFile, feedFile, schedulesFile, composerFile, settingsFile, storeFile]) {
    const result = spawnSync(process.execPath, ['--check', file.pathname], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file.pathname}: ${result.stderr}`)
  }
})

test('room-tasks creates only the declared task API with blocked storage', () => {
  const sandbox = {
    window: { addEventListener() {} },
    document: { addEventListener() {}, fonts: null },
    localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } },
  }
  vm.runInNewContext(fs.readFileSync(tasksFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomTasks, 'function')
  const names = ['$', 'S', 'agentsRunning', 'ago', 'ask', 'avatar', 'boot', 'canWrite', 'feed', 'fill', 'flash', 'fmtTime', 'names', 'openPanel', 'post', 'quotaNow', 'refreshPanel', 'rowName', 'shownName', 'state', 'shell', 'toast', 'updateChips', 'waitingOnMe', 'clearPopEdit', 'writeTodo']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  const hooks = [], menuHooks = []
  Object.assign(ctx, { boot: {}, S: {}, state: {}, shell: {}, feed: {}, panels: panelStub(), rowHook(slot) { hooks.push(slot) }, menuHook(slot) { menuHooks.push(slot) } })
  assert.deepEqual(Object.keys(sandbox.window.createRoomTasks(ctx)).sort(), taskExports.slice().sort())
  assert.deepEqual(hooks, ['todo'])
  assert.deepEqual(menuHooks, ['todo'])
})

test('room-at creates only the declared @me API and registers its tab', () => {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(atFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomAt, 'function')
  const names = ['$', 'S', 'avatar', 'boot', 'filesHtml', 'fill', 'fmtTime', 'kindLabel', 'names', 'openPanel', 'renderRoomMenu', 'state', 'updateChips', 'unreadFromMentions']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  const tabs = []
  Object.assign(ctx, { boot: {}, S: {}, state: {}, panels: Object.assign(panelStub(), { tab(kind) { tabs.push(kind) } }) })
  assert.deepEqual(Object.keys(sandbox.window.createRoomAt(ctx)).sort(), atExports.slice().sort())
  assert.deepEqual(tabs, ['at'])
})

test('room.js forwards each @me export', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  for (const name of atForwards) {
    assert.ok(source.includes(`function ${name}() { return roomAt.${name}.apply(this, arguments); }`), name)
  }
  for (const name of atDirect) assert.ok(!source.includes(`return roomAt.${name}.apply`), name)
  assert.match(source, /atCount: function \(\) \{ return roomAt\.count\(\); \}/)
})

test('room-members creates only the declared members API', () => {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(membersFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomMembers, 'function')
  const names = ['$', 'S', 'ago', 'ask', 'boot', 'canWrite', 'clock', 'closeItem', 'fill', 'flash', 'isOwner', 'names', 'openPanel', 'pendingDone', 'plainLines', 'post', 'refreshPanel', 'renderSide', 'showTopic', 'state', 'toast', 'topicHtml', 'writeMembers']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  Object.assign(ctx, { boot: {}, S: {}, state: {}, pendingDone: {}, panels: panelStub() })
  assert.deepEqual(Object.keys(sandbox.window.createRoomMembers(ctx)).sort(), memberExports.slice().sort())
})

test('room.js forwards each member export and no longer contains member internals', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  for (const name of memberForwards) {
    assert.ok(source.includes(`function ${name}() { return roomMembers.${name}.apply(this, arguments); }`), name)
  }
  for (const name of ['memberRow', 'cardPreview', 'roleCardOf', 'handoffRow', 'handoffWhen', 'waitsOnMe', 'countText', 'memberIsFolded']) {
    assert.doesNotMatch(source, new RegExp(`function ${name}\\(`), name)
  }
  for (const name of memberEngine) assert.doesNotMatch(source, new RegExp(`function ${name}\\(`), name)
  for (const marker of ['var popEdit', 'popEdit =', 'SPAWN_CARD', 'CARD_MAX', 'MEMBER_FOLD_KEY', 'var memberFold', 'x.cursor = ']) assert.ok(!source.includes(marker), marker)
  assert.match(source, /clearPopEdit: function \(\) \{ roomMembers\.clearPop\(\); \}/)
  // room.js assigns its own pendingDone only after the members are created: the members take the tasks' object itself.
  assert.match(source, /createRoomMembers\(\{[^}]*pendingDone: tasks\.pendingDone/)
})

test('member list folds only left agents with cloud handoffs under their owner', () => {
  // One instance over a kept localStorage: a new instance reads the folds back from it.
  const stored = new Map()
  const localStorage = { getItem: (key) => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => { stored.set(key, value) } }
  const sandbox = { window: {}, escapeHtml: (value) => String(value), botSvg: () => '', botState: () => '', localStorage }
  vm.runInNewContext(fs.readFileSync(membersFile, 'utf8'), sandbox)
  const members = [
    { name: 'alice', owner: 'alice', kind: 'human', status: 'active' },
    { name: 'zoe@alice', owner: 'alice', kind: 'agent', status: 'left', handoff: { size: 1 } },
    { name: 'amy@alice', owner: 'alice', kind: 'agent', status: 'left', handoff: { size: 1 } },
    { name: 'no-note@alice', owner: 'alice', kind: 'agent', status: 'left', handoff: null },
  ]
  const ctx = {
    state: { members, me: 'alice', room: { owner: 'alice' }, todo: { items: [] } },
    boot: { lang: 'zh' },
    S: { noAgentCount: '没有 agent', memberWork: {}, you: '你', roomOwner: '房主', membersIntro: '成员 ', membersPeople: ' 人', inviteShort: '邀请', settings: '设置', noAgents: '暂无', leftMembers: '已离开 {n}' },
    topicHtml: () => '',
    isOwner: () => false,
    fill: (s, values) => s.replace('{n}', values.n),
    panels: panelStub(),
    pendingDone: {},
    openPanel() {},
    renderSide() {},
  }
  const room = sandbox.window.createRoomMembers(ctx)
  const html = () => room.membersHtml()
  assert.match(html(), /成员 1 · 1 人/)
  assert.match(html(), /已离开 2/)
  assert.doesNotMatch(html(), /data-name="amy@alice"|data-name="zoe@alice"|no-note@alice/)
  room.toggleMemberFold('left:alice')
  assert.ok(html().indexOf('data-name="amy@alice"') < html().indexOf('data-name="zoe@alice"'))
  assert.doesNotMatch(html(), /no-note@alice/)
  members[1].handoff = null
  members[2].handoff = null
  assert.doesNotMatch(html(), /已离开|data-name="amy@alice"|data-name="zoe@alice"/)
})

test('room.js forwards each task export and no longer contains task internals', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  // pendingDone is an object, applyTodo is called through tasks itself: neither has a forwarder.
  for (const name of taskExports.filter((name) => name !== 'pendingDone' && name !== 'applyTodo')) {
    assert.ok(source.includes(`function ${name}() { return tasks.${name}.apply(this, arguments); }`), name)
  }
  assert.match(source, /var pendingDone;/)
  assert.match(source, /pendingDone = tasks\.pendingDone;/)
  for (const name of ['fetchDone', 'showItem', 'todoGroups']) assert.doesNotMatch(source, new RegExp(`function ${name}\\(`))
  for (const marker of ['RECENT_DONE_MS', 'doneFull', 'itemRequest']) assert.doesNotMatch(source, new RegExp(marker))
  assert.doesNotMatch(source, /function (atHtml|membersHtml)\(/)
})

test('room.js, room-tasks.js, room-at.js, room-members.js and room-settings.js pass node --check', () => {
  for (const file of [roomFile, tasksFile, atFile, membersFile, composerFile, settingsFile, storeFile]) {
    const result = spawnSync(process.execPath, ['--check', file.pathname], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file.pathname}: ${result.stderr}`)
  }
})

test('room-settings creates only the declared settings API', () => {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(settingsFile, 'utf8'), sandbox)
  assert.equal(typeof sandbox.window.createRoomSettings, 'function')
  const names = ['$', 'S', 'boot', 'fill', 'state', 'panel', 'panels', 'feed', 'viewer', 'socket', 'post', 'ask', 'toast', 'flash', 'copy', 'copyText', 'clock', 'canWrite', 'isOwner',
    'closeMenu', 'exitSelect', 'nearBottom', 'updateChips', 'refreshPanel', 'openPanel', 'renderSide', 'closePanel', 'loadMentions', 'shown', 'names', 'shell', 'roomMembers', 'writeRoom', 'atCount', 'mySeats', 'startSpawn', 'openExport']
  const ctx = Object.fromEntries(names.map((name) => [name, function () {}]))
  // The members' popup engine is taken from roomMembers when the settings are created.
  const roomMembers = Object.fromEntries([...memberEngine, 'sizePop', 'refreshPopup', 'popEdit', 'clearPop'].map((name) => [name, function () {}]))
  Object.assign(ctx, { boot: {}, S: {}, state: {}, panel: {}, feed: {}, viewer: false, socket: {}, shell: {}, panels: panelStub(), roomMembers: Object.assign(roomMembers, { TOPIC_MAX: 2000 }) })
  assert.deepEqual(Object.keys(sandbox.window.createRoomSettings(ctx)).sort(), settingsExports.slice().sort())
  // Every ctx name the factory reads is one the test passes.
  const read = [...new Set([...fs.readFileSync(settingsFile, 'utf8').matchAll(/ctx\.([\w$]+)/g)].map((m) => m[1]))]
  assert.deepEqual(read.sort(), names.slice().sort())
})

test('room.js forwards each settings export and no longer contains settings internals', () => {
  const source = fs.readFileSync(roomFile, 'utf8')
  for (const name of settingsForwards) {
    assert.ok(source.includes(`function ${name}() { return settings.${name}.apply(this, arguments); }`), name)
  }
  for (const name of ['wantsInvite', 'invitationHtml', 'inviteCard', 'invitationText', 'archiveExpiryNote', 'archiveRoom', 'readRoomMute', 'toggleRoomMute', 'toggleRoomMenu', 'joinTopic', 'leaveTopic']) {
    assert.doesNotMatch(source, new RegExp(`function ${name}\\(`), name)
  }
  for (const marker of ['membersKnown', 'inviteEl', 'RETENTION', 'quotaTimer', 'settingsNote', 'roomMuted', 'var leaving', 'TOPIC_MAX', 'scorpio-push-change', 'btn-more', 'room-menu-scrim', '.roombar .title']) assert.ok(!source.includes(marker), marker)
  // Created after the members, whose popup engine it takes; its listeners attached once; the hello frame tells it the members came, before setRoom.
  assert.ok(source.indexOf('window.createRoomMembers(') < source.indexOf('window.createRoomSettings('))
  assert.equal(source.split('settings.listen();').length, 2)
  assert.match(source, /settings\.knowMembers\(\);\n    setRoom\(f\.room\);/)
})

test('room-store: every field is get-only, each setter is claimed once, and an unknown field throws', () => {
  const sandbox = { window: {} }
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), sandbox)
  const members = [{ name: 'kai' }], room = { id: 'r1' }
  const store = sandbox.window.createRoomStore({ me: 'kai', cursor: 0, messages: [], bySeq: new Map(), members, todo: { items: [], done: null }, mentionUnread: 0, room })
  const { state } = store
  assert.equal(state.me, 'kai')
  assert.equal(state.members, members)
  assert.equal(state.room, room)
  const fields = ['me', 'cursor', 'messages', 'bySeq', 'members', 'todo', 'mentionUnread', 'room']
  for (const field of fields) assert.throws(() => { state[field] = null }, TypeError, field)
  assert.throws(() => { state.cursor++ }, TypeError)
  const setters = Object.fromEntries(fields.filter((f) => f !== 'me').map((f) => [f, store.claim(f)]))
  const values = { cursor: 7, messages: [{ seq: 1 }], bySeq: new Map([[1, {}]]), members: [], todo: { items: [{ id: 'T1' }], done: [] }, mentionUnread: 2, room: { id: 'r2' } }
  for (const [field, v] of Object.entries(values)) { setters[field](v); assert.equal(state[field], v, field) }
  for (const field of Object.keys(values)) assert.throws(() => store.claim(field), /already claimed/, field)
  assert.throws(() => store.claim('me'), /no setter/)
  assert.throws(() => sandbox.window.createRoomStore({ me: 'kai', firstLoad: true }), /unknown field firstLoad/)
})

/** The page's scripts, by name, with their source. */
const staticSources = () => fs.readdirSync(staticDir).filter((name) => name.endsWith('.js')).map((name) => [name, fs.readFileSync(new URL(name, staticDir), 'utf8')])

test('only the members write state.members, through their setter', () => {
  for (const [name, source] of staticSources()) assert.doesNotMatch(source, /state\.members\s*=[^=]/, name)
  const members = fs.readFileSync(membersFile, 'utf8'), room = fs.readFileSync(roomFile, 'utf8')
  assert.match(members, /var writeMembers = ctx\.writeMembers;/)
  assert.match(members, /writeMembers\(state\.members\.filter\(/)
  assert.match(room, /writeMembers: store\.claim\("members"\)/)
  assert.equal(room.split('roomMembers.set(f.members);').length, 3)
})

test('only the settings write state.room', () => {
  for (const [name, source] of staticSources()) {
    if (name === 'room-settings.js') continue
    assert.doesNotMatch(source, /state\.room\.\w+\s*=[^=]/, name)
    assert.doesNotMatch(source, /state\.room\s*=[^=]/, name)
  }
  const settings = fs.readFileSync(settingsFile, 'utf8'), room = fs.readFileSync(roomFile, 'utf8')
  assert.match(settings, /var writeRoom = ctx\.writeRoom;/)
  assert.match(room, /writeRoom: store\.claim\("room"\)/)
  assert.match(room, /settings\.setCode\(/)
  for (const [name, source] of staticSources()) assert.ok(!source.includes('hasCode'), name)
})

test('the composer\'s, the settings\' and @me\'s own fields are not on the shared state', () => {
  // room.js too: the check above scans only room-*.js.
  for (const [name, source] of staticSources()) {
    for (const field of ['pics', 'reply', 'space', 'quota']) assert.ok(!source.includes(`state.${field}`), `${name}: state.${field}`)
    assert.doesNotMatch(source, /state\.at\b/, name)
  }
})

test('only the feed writes the messages, cursor and mentionUnread, and only the tasks write todo', () => {
  for (const [name, source] of staticSources()) {
    assert.doesNotMatch(source, /state\.(cursor|mentionUnread|messages|bySeq|todo)\s*(=[^=]|\+\+|--|\+=|-=)/, name)
    assert.doesNotMatch(source, /state\.todo\.\w+\s*=[^=]/, name)
    assert.ok(!source.includes('state.todo.items.push'), name)
    if (name !== 'room-feed.js') assert.doesNotMatch(source, /state\.(messages|bySeq)\.(push|set|splice|delete|clear|unshift)\b/, name)
    // The feed's own read state is off the shared state.
    assert.doesNotMatch(source, /state\.(firstLoad|oldest|dividerAt|firstUnread|newBelow)\b/, name)
  }
  const room = fs.readFileSync(roomFile, 'utf8'), feed = fs.readFileSync(feedFile, 'utf8'), tasks = fs.readFileSync(tasksFile, 'utf8')
  assert.match(room, /writeFeed: \{ cursor: store\.claim\("cursor"\), mentionUnread: store\.claim\("mentionUnread"\), messages: store\.claim\("messages"\), bySeq: store\.claim\("bySeq"\) \}/)
  assert.match(room, /writeTodo: store\.claim\("todo"\)/)
  assert.match(room, /unreadFromMentions: function \(n\) \{ roomFeed\.unreadFromMentions\(n\); \}/)
  assert.match(feed, /var writeFeed = ctx\.writeFeed;/)
  assert.match(tasks, /var writeTodo = ctx\.writeTodo;/)
  // applyHello keeps its order: my read state, members, the room, the tasks, then the messages (a row's task line reads the tasks).
  const order = ['roomFeed.helloMe(f.me);', 'roomMembers.set(f.members);', 'setRoom(f.room);', 'tasks.applyTodo(', 'settings.setQuotaFromHello(f.quota);', 'roomFeed.helloMessages(f.messages);']
  const at = order.map((s) => room.indexOf(s))
  assert.ok(at.every((i) => i > 0), JSON.stringify(at))
  assert.deepEqual(at.slice().sort((a, b) => a - b), at)
})

test('the dead code (d) removed stays gone', () => {
  const room = fs.readFileSync(roomFile, 'utf8'), files = fs.readFileSync(filesFile, 'utf8'), tasks = fs.readFileSync(tasksFile, 'utf8')
  assert.doesNotMatch(room, /data-split/)
  assert.doesNotMatch(files, /function waitHtml\(/)
  assert.doesNotMatch(tasks, /function who\(/)
  // An agent row opens its card; a row has no second, mention-only branch in either router.
  assert.doesNotMatch(room, /insertMention\((li|member)\.dataset\.name/)
})
