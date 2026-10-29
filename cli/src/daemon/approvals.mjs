// One transport card per pane; terminal state is re-read before any requested press.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { dialogBlocked } from '../adapters/cli/index.mjs'
import { LAUNCHER, STATE_DIR, writeJson } from './paths.mjs'
import { createKeys, keysFor } from './keys.mjs'
import { codexTrustMenu, cursorMenu, detailOf, hookMatches, menuIdentity, parseMenu, sameMenu, screenTail, standardApproval, visibleMenu } from './approval-menu.mjs'

export function writeApprovalSettings({ launcher = LAUNCHER, stateDir = STATE_DIR } = {}) {
  writeJson(path.join(stateDir, 'hooks', 'claude.json'), { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `${launcher} approval-hook claude`, timeout: 3600 }] }] } })
}
export function createApprovals({ terminal, targets, send, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  socket = path.join(STATE_DIR, 'approval.sock'), keyTable = createKeys({ fetch: async () => null }), log = () => {}, kick = () => {} }) {
  const serial = new Map()
  const run = (pane, fn) => {
    const job = (serial.get(pane) || Promise.resolve()).then(fn)
    const settled = job.catch(() => {})
    serial.set(pane, settled)
    return job.finally(() => { if (serial.get(pane) === settled) serial.delete(pane) })
  }
  const cards = new Map(), pending = new Map(), waiting = new Map(), unknown = new Map(), locks = new Set()
  let server, timer, polling = false
  const hasWaitingHook = (pane) => Boolean(pending.get(pane)?.some((r) => !r.used))
  // Blocked for the relay: Herdr's blocked (dialogBlocked).
  const blocked = (target, status, screen) => dialogBlocked(status, { kind: target.cli, screen, hookWaiting: hasWaitingHook(target.pane) })
  const busy = (pane) => cards.has(pane) || Boolean(pending.get(pane)?.some((r) => !r.used && now() - r.ts < 2000)) || waiting.has(pane)
  const release = (request, decision = null) => {
    if (!request) return false
    const delivered = Boolean(request.reply && request.reply({ decision }) !== false)
    request.reply = null
    const queue = pending.get(request.pane) || []
    const i = queue.indexOf(request); if (i >= 0) queue.splice(i, 1)
    if (!queue.length) pending.delete(request.pane)
    return delivered
  }
  const wire = (card) => ({ id: card.id, name: card.name, cli: card.cli, detail: card.detail, menu: card.menu, screen: card.screen, ts: card.ts })
  const emit = (card, frame) => { for (const roomId of card.rooms) send(roomId, frame) }
  function close(card, reason, result, nextScreen) {
    if (cards.get(card.pane) !== card) return
    cards.delete(card.pane)
    log(`approval ${card.id} closed: ${reason}`)
    // A changed menu can still belong to the held hook; the replacement card must keep its details.
    const transfer = reason === 'changed' && card.request && hookMatches(card.request.event, nextScreen)
    if (transfer) card.request.used = false
    else release(card.request)
    for (const r of [...(pending.get(card.pane) || [])]) if (r !== (transfer && card.request) && r.ts <= (card.request?.ts ?? card.ts)) release(r)
    waiting.delete(card.pane); unknown.delete(card.pane)
    emit(card, { type: 'approval_close', id: card.id, reason, ...(result ? { result } : {}) })
    kick()
  }
  async function open(target, screen) {
    const width = await terminal.paneWidth?.(target.pane) ?? null
    const menu = visibleMenu(screen, width, target.cli)
    const request = (pending.get(target.pane) || []).find((r) => !r.used && hookMatches(r.event, screen))
    if (request) request.used = true
    const card = { ...target, id: randomBytes(8).toString('hex'), ts: now(), menu, width, identity: menuIdentity(screen, menu),
      detail: request ? detailOf(request.event) : null, event: request?.event, request,
      screen: !menu || !request ? screenTail(screen) : null }
    cards.set(target.pane, card); waiting.delete(target.pane)
    log(`approval ${card.id} opened for ${card.name} (${card.cli}, ${menu ? 'menu' : 'screen'}, ${request ? 'hook' : 'no hook'})`)
    emit(card, { type: 'approval_open', approval: wire(card) })
    return card
  }
  async function observe(target, paneStatus) {
    if (locks.has(target.pane)) return
    const card = cards.get(target.pane)
    const screen = await terminal.read(target.pane, 200)
    // A pane whose blocked is lifted behaves as idle.
    const status = blocked(target, paneStatus, screen) ? 'blocked' : paneStatus === 'blocked' ? 'idle' : paneStatus
    const menu = visibleMenu(screen, card?.width ?? await terminal.paneWidth?.(target.pane), target.cli)
    for (const r of [...(pending.get(target.pane) || [])]) {
      if (!r.used && now() - r.ts >= 2000 && !menu) release(r)
    }
    if (card) {
      if (card.decided) {
        if (sameMenu(card, screen) && !pending.get(target.pane)?.some((r) => !r.used && r.ts > card.decidedAt)) return
        const nextMenu = menu && (status === 'blocked' || pending.get(target.pane)?.some((r) => !r.used && r.ts > card.ts))
        close(card, 'answered', 'ok', screen)
        if (nextMenu) await open(target, screen)
        return
      }
      if (card.menu === null && menu === null) {
        if (status === 'blocked') {
          const latest = screenTail(screen)
          if (latest !== card.screen) {
            card.screen = latest
            if (!card.refused) emit(card, { type: 'approval_open', approval: wire(card) })
          }
        } else if (status != null) close(card, 'answered_here')
        return
      }
      if (sameMenu(card, screen)) return
      const nextMenu = menu && (status === 'blocked' || pending.get(target.pane)?.some((r) => !r.used && r.ts > card.ts))
      close(card, nextMenu ? 'changed' : 'answered_here', undefined, screen)
      if (nextMenu) await open(target, screen)
      return
    }
    const hasHook = hasWaitingHook(target.pane)
    if (status !== 'blocked' && !hasHook) { waiting.delete(target.pane); unknown.delete(target.pane); return }
    if (!menu) {
      waiting.delete(target.pane)
      if (hasHook) { unknown.delete(target.pane); return }
      const since = unknown.get(target.pane) ?? now()
      unknown.set(target.pane, since)
      if (now() - since >= 3000) await open(target, screen)
      return
    }
    unknown.delete(target.pane)
    const since = waiting.get(target.pane) ?? now()
    waiting.set(target.pane, since)
    // Give a native menu time to acquire its hook before opening a card without details.
    if (now() - since < 2000 && !hasHook) return
    await open(target, screen)
  }
  async function tick() {
    if (polling) return
    polling = true
    try {
      const list = await targets()
      if (list === null) return
      const live = new Set(list.map((t) => t.pane))
      for (const card of cards.values()) if (!live.has(card.pane)) close(card, 'gone')
      for (const map of [waiting, unknown]) for (const pane of map.keys()) if (!live.has(pane)) map.delete(pane)
      for (const pane of pending.keys()) if (!live.has(pane)) for (const r of [...pending.get(pane)]) release(r)
      for (const t of list) await run(t.pane, async () => observe(t, t.status ?? await terminal.paneStatus(t.pane)))
    } catch (error) { log(`approval observation failed: ${error?.code || error?.name || 'unknown'}`) }
    finally { polling = false }
  }
  async function request(frame, reply) {
    if (frame?.v !== 1 || !['claude', 'codex'].includes(frame.cli) || typeof frame.pane !== 'string' || !frame.event) { reply({ decision: null }); return }
    const list = await targets()
    if (!list?.some((t) => t.pane === frame.pane)) { reply({ decision: null }); return }
    const r = { ...frame, reply: frame.cli === 'claude' ? reply : null, used: false, ts: now() }
    const queue = pending.get(r.pane) || []; queue.push(r); pending.set(r.pane, queue)
    if (r.cli === 'codex') reply({ ok: true })
    waiting.set(r.pane, waiting.get(r.pane) ?? now())
    kick()
    // Capture a hook that arrives just after the preceding observation of the native menu.
    await tick()
  }
  async function settle(pane, done, settleMs) {
    const deadline = now() + settleMs
    let previousDone = false
    for (;;) {
      const screen = await terminal.read(pane, 200)
      const currentDone = done(screen)
      if (currentDone && previousDone) return screen
      const remaining = deadline - now()
      if (remaining <= 0) return screen
      previousDone = currentDone
      await sleep(Math.min(200, remaining))
    }
  }
  async function answer(roomId, frame) {
    const card = [...cards.values()].find((c) => c.id === frame.id && c.rooms.includes(roomId))
    if (!card) return
    return run(card.pane, async () => {
      if (cards.get(card.pane) !== card) return
      if (card.decided) return
      locks.add(card.pane)
      let answerDescription
      try {
        if (!Number.isFinite(frame.ts) || now() - frame.ts > 120_000) { close(card, 'expired'); return }
        const screen = await terminal.read(card.pane, 200)
        const status = await terminal.paneStatus(card.pane)
        if (!(blocked(card, status, screen) || card.request?.reply) || !sameMenu(card, screen)) {
          const nextMenu = visibleMenu(screen, card.width, card.cli) &&
            (blocked(card, status, screen) || pending.get(card.pane)?.some((r) => !r.used && r.ts > card.ts))
          close(card, nextMenu ? 'changed' : 'answered_here', undefined, screen)
          if (nextMenu) {
            const target = (await targets())?.find((t) => t.pane === card.pane)
            if (target) await open(target, screen)
          }
          return
        }
        const table = await keyTable()
        const option = card.menu?.options.find((o) => o.n === frame.n)
        const last = card.menu?.options.at(-1)
        const message = typeof frame.message === 'string' && frame.message.length <= 2000 && option && option === last && /^No\b/.test(last.label) ? frame.message : ''
        if (card.menu ? !option : !keysFor(table, terminal.adapter || 'herdr').some((k) => k.name === frame.key)) return
        answerDescription = `${card.menu ? `option ${option.n}` : `key ${frame.key}`}${message ? ', with a reason' : ''}`
        let hookDecision = false, delivered = false
        if (card.cli === 'claude' && card.request?.reply && standardApproval(card.menu) && (option.n === 1 || option === last)) {
          hookDecision = true
          card.decidedAt = now()
          delivered = release(card.request, option.n === 1 ? { behavior: 'allow' } : { behavior: 'deny', ...(message ? { message } : {}) })
        } else {
          const cursor = card.menu && cursorMenu(screen)
          if (cursor) {
            const keys = keysFor(table, terminal.adapter || 'herdr')
            const direction = option.n > cursor.selected ? 'down' : 'up'
            const move = keys.find((key) => key.name === direction)?.[terminal.adapter || 'herdr']
            const enter = keys.find((key) => key.name === 'enter')?.[terminal.adapter || 'herdr']
            if (!enter || (option.n !== cursor.selected && !move)) throw new Error('cursor keys unavailable')
            for (let i = 0; i < Math.abs(option.n - cursor.selected); i++) await terminal.sendKeys(card.pane, move)
            const moved = option.n !== cursor.selected
              ? await settle(card.pane, (screen) => cursorMenu(screen)?.selected === option.n, table.settleMs)
              : await terminal.read(card.pane, 200)
            const selected = cursorMenu(moved)
            if (!sameMenu(card, moved) || selected?.selected !== option.n || selected.menu.options[option.n - 1]?.label !== option.label) {
              throw new Error('cursor did not reach chosen option')
            }
            await terminal.sendKeys(card.pane, enter)
          } else {
            const key = card.menu ? String(option.n) : keysFor(table, terminal.adapter || 'herdr').find((k) => k.name === frame.key)[terminal.adapter || 'herdr']
            await terminal.sendKeys(card.pane, key)
            // Only Codex trust menus need Enter; another menu may already be the next request.
            if (card.cli === 'codex' && card.menu && codexTrustMenu(screen)) {
              const moved = await settle(card.pane, (screen) => {
                const selected = screenTail(screen).split('\n').findLast((line) => /^\s*[›❯]\s+\d+\.\s+/.test(line))
                return Number(selected?.match(/^\s*[›❯]\s+(\d+)\./)?.[1]) === option.n
              }, table.settleMs)
              const selected = screenTail(moved).split('\n').findLast((line) => /^\s*[›❯]\s+\d+\.\s+/.test(line))
              const n = Number(selected?.match(/^\s*[›❯]\s+(\d+)\./)?.[1])
              if (!sameMenu(card, moved) || n !== option.n || parseMenu(moved, card.width, card.cli)?.options.find((o) => o.n === n)?.label !== option.label) {
                throw new Error('cursor did not reach chosen option')
              }
              const enter = keysFor(table, terminal.adapter || 'herdr').find((key) => key.name === 'enter')?.[terminal.adapter || 'herdr']
              if (!enter) throw new Error('cursor keys unavailable')
              await terminal.sendKeys(card.pane, enter)
            }
          }
          release(card.request)
        }
        let after = await settle(card.pane, (screen) => !sameMenu(card, screen), table.settleMs)
        if (!hookDecision && message && option === last && !sameMenu(card, after) && !parseMenu(after)) {
          if (card.cli === 'codex') {
            try { await terminal.inject(card.pane, message) }
            catch (error) { log(`approval reason injection failed: ${error?.code || 'unknown'}`) }
          } else {
            await terminal.sendText(card.pane, message); await terminal.sendKeys(card.pane, 'enter')
          }
          after = await terminal.read(card.pane, 200)
        }
        const failed = sameMenu(card, after)
        if (hookDecision && delivered && failed) {
          card.decided = true
          log(`approval ${card.id} answered: ${answerDescription}, sent to claude; waiting for the menu to close`)
          return
        }
        log(`approval ${card.id} answered: ${answerDescription}, ${failed ? 'failed' : 'ok'}`)
        answerDescription = undefined
        close(card, 'answered', failed ? 'failed' : 'ok')
        const statusAfter = await terminal.paneStatus(card.pane)
        if ((failed || visibleMenu(after, card.width, card.cli)) && (blocked(card, statusAfter, after) || hasWaitingHook(card.pane))) {
          const target = (await targets())?.find((t) => t.pane === card.pane)
          if (target) await open(target, after)
        }
      } catch (error) {
        if (answerDescription) log(`approval ${card.id} answered: ${answerDescription}, failed`)
        close(card, 'answered', 'failed')
        log(`approval answer failed: ${error?.code || error?.name || 'unknown'}`)
        const target = (await targets())?.find((t) => t.pane === card.pane)
        const screen = target ? await terminal.read(card.pane, 200) : ''
        if (target && sameMenu(card, screen) && (blocked(card, await terminal.paneStatus(card.pane), screen) || hasWaitingHook(card.pane))) await open(target, screen)
      }
      finally { locks.delete(card.pane) }
    })
  }
  return {
    busy, cards, request, tick, answer, hookWaiting: hasWaitingHook,
    shown: (pane) => busy(pane) && !cards.get(pane)?.refused,
    refused(frame) {
      const card = [...cards.values()].find((c) => c.id === frame.id)
      if (!card) return
      card.refused = true
      log(`approval refused: ${frame.id} ${frame.error}`)
    },
    resend(roomId) { for (const card of cards.values()) if (!card.refused && card.rooms.includes(roomId)) send(roomId, { type: 'approval_open', approval: wire(card) }) },
    async start() {
      fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 })
      try { fs.unlinkSync(socket) } catch (e) { if (e.code !== 'ENOENT') throw e }
      server = net.createServer((client) => {
        let buffer = '', received = false
        const reply = (body) => {
          if (client.destroyed) return false
          client.end(JSON.stringify(body) + '\n')
          return true
        }
        client.on('error', () => {})
        client.on('data', (data) => {
          if (received) return
          buffer += data
          if (!buffer.includes('\n')) return
          received = true
          try { request(JSON.parse(buffer.split('\n')[0]), reply).catch(() => reply({ decision: null })) } catch { reply({ decision: null }) }
        })
      })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
      fs.chmodSync(socket, 0o600)
      timer = setInterval(tick, 2000)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      for (const queue of pending.values()) for (const r of [...queue]) release(r)
      server?.close()
      try { fs.unlinkSync(socket) } catch {}
    },
  }
}

export function approvalTargets({ panes, spawns, entries, readRecord }) {
  if (!panes) return null
  const targets = new Map()
  const add = (e, kind) => {
    const pane = panes.find((p) => p.pane_id === e.pane)
    if (!pane || !['claude', 'codex'].includes(kind || pane.agent)) return
    const record = readRecord(e)
    const fromSpawn = record?.pane === e.pane
    let target = targets.get(e.pane)
    if (!target) { target = { pane: e.pane, name: e.name, cli: kind || pane.agent, rooms: [], status: pane.agent_status, spawned: false }; targets.set(e.pane, target) }
    if (fromSpawn && !target.spawned) { target.rooms = [e.roomId]; target.name = e.name; target.spawned = true }
    else if (!target.spawned && !target.rooms.includes(e.roomId)) target.rooms.push(e.roomId)
  }
  for (const op of spawns) if (op.pane) add(op, op.kind)
  for (const entry of entries) add(entry)
  return [...targets.values()]
}
