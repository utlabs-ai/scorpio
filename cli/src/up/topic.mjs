import { terminalText } from '../terminal-text.mjs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { api, cli, homeDir, readJson, writeJson } from './services.mjs'
import { tr } from './screen.mjs'

const file = path.join(homeDir, 'state', 'up.json')
const activeRooms = (response) => (response.rooms || []).filter((room) => room.status === 'active')

function remember(topic, nonce) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(topic?.roomId || '')) throw new Error('Scorpio did not return a valid topic id.')
  const previous = readJson(file) || {}
  writeJson(file, { ...previous, topicId: topic.roomId, createNonce: nonce || null })
  return topic
}

function selectExisting(screen, rooms, nonce) {
  screen.pauseStep?.()
  try {
    screen.write('  ' + tr(screen.language, 'Choose a topic to join, or q to exit:', '选择要加入的主题，或输入 q 退出：') + '\n')
    rooms.forEach((room, index) => screen.write('    [' + (index + 1) + '] ' + terminalText(room.name) + '\n'))
    while (true) {
      const answer = screen.askLine('  ' + tr(screen.language, 'Topic number or q: ', '主题编号或 q：'))
      if (answer.toLowerCase() === 'q') throw new Error(tr(screen.language, 'Topic selection cancelled.', '已取消选择主题。'))
      const index = Number(answer) - 1
      if (/^[1-9][0-9]*$/.test(answer) && rooms[index]) return remember(rooms[index], nonce)
    }
  } finally { screen.resumeStep?.() }
}

export async function chooseTopic(screen, { readRooms = () => api('GET', '/rooms'),
  createRoom = (nonce) => cli('create', ['name=Hello Scorpio', 'desc=Your first Scorpio topic', 'nonce=' + nonce]) } = {}) {
  const saved = readJson(file) || {}
  let rooms = activeRooms(await readRooms())
  const old = rooms.find((room) => room.roomId === saved.topicId)
  if (old) return old
  if (rooms.length) return selectExisting(screen, rooms, saved.createNonce)
  const nonce = saved.createNonce || randomUUID()
  writeJson(file, { ...saved, topicId: null, createNonce: nonce })
  const create = () => createRoom(nonce)
  try {
    const result = await create()
    return remember({ roomId: result.topicId || result.roomId, name: result.topicName || result.name || 'Hello Scorpio' }, nonce)
  } catch (firstError) {
    rooms = activeRooms(await readRooms())
    const hello = rooms.find((room) => room.name === 'Hello Scorpio')
    if (hello) return remember(hello, nonce)
    if (rooms.length) return selectExisting(screen, rooms, nonce)
    try {
      const result = await create()
      return remember({ roomId: result.topicId || result.roomId, name: result.topicName || result.name || 'Hello Scorpio' }, nonce)
    } catch { throw firstError }
  }
}

export function rememberedTopic() {
  return readJson(file)?.topicId || null
}
