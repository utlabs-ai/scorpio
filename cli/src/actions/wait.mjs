import { deliveryDue, renderDelivery } from '../render/forward.mjs'
import {
  api, roomPath, boundRoom, readJson, REMINDERS_FILE, sessionKey, writePrivate, emit,
  roomCtx, intArg, WAIT_DEFAULT_S, remember, sleep, server, readToken, VERSION,
} from '../client.mjs'

// ---------- wait ----------

function wakers(listenRes) {
  const all = new Map()
  for (const m of [...(listenRes?.mentions || []), ...(listenRes?.broadcasts || [])]) all.set(m.seq, m)
  return [...all.values()].sort((a, b) => a.seq - b.seq)
}

// Same renderer as the daemon (src/render/forward.mjs), with the topic reminder: shown on the first wake
// after a join and again every 20, with only the changes in between.
async function printWake(ctx, st, list, listened = null) {
  let l = listened
  if (!l) { try { l = await api('GET', roomPath(ctx.roomId, '/listen'), { role: ctx.role }) } catch {} }
  const b = boundRoom(ctx.roomId) || {}
  const name = l?.me || st.me || `${ctx.role}@`
  const room = {
    roomId: ctx.roomId,
    roomName: l?.room?.name || st.roomName,
    topic: l?.room?.topic ?? st.topic ?? b.topic,
    owner: l?.room?.owner || b.owner,
    members: l?.members || [],
    items: l?.items || [],
    deleted: l?.deleted || [],
    ...(l?.memo ? { memo: l.memo } : {}),
  }
  let remind = null
  let changes = []
  let tasks = []
  let memo = null
  const messages = [...list].sort((a, c) => a.seq - c.seq)
  if (l?.members) {
    try {
      const all = readJson(REMINDERS_FILE) || {}
      const key = `${sessionKey()}|${ctx.roomId}|${name}`
      const due = deliveryDue(all[key], { session: b.joinedAt ?? null, room, name, shown: messages.map((m) => m.seq) })
      ;({ remind, changes, tasks, memo } = due)
      all[key] = due.next
      writePrivate(REMINDERS_FILE, JSON.stringify(all))
    } catch {}
  }
  return emit(renderDelivery({ room, messages, name, remind, changes, tasks, memo, again: `scorpio wait topicId=${ctx.roomId}` }), 0)
}

function printIdle(roomName, roomId) {
  return emit(`Scorpio topic "${roomName}" (${roomId}): no new messages for you. Nothing to do, no reply needed. Run wait again: scorpio wait topicId=${roomId}`, 0)
}

async function wait(args) {
  const ctx = roomCtx(args)
  const timeoutS = intArg(args, 'timeout') ?? WAIT_DEFAULT_S
  const deadline = Date.now() + timeoutS * 1000
  const st = { roomName: boundRoom(ctx.roomId)?.roomName || ctx.roomId }
  const first = await api('GET', roomPath(ctx.roomId, '/listen'), { role: ctx.role })
  remember(ctx)
  st.me = first.me
  const woke = wakers(first)
  if (woke.length) return printWake(ctx, st, woke, first)
  if (typeof globalThis.WebSocket !== 'function') return pollWait(ctx, deadline, st)
  return socketWait(ctx, deadline, st)
}

async function pollWait(ctx, deadline, st) {
  let lastErr = null
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) {
      if (lastErr) throw lastErr
      return printIdle(st.roomName, ctx.roomId)
    }
    await sleep(Math.min(15_000, left))
    try {
      const l = await api('GET', roomPath(ctx.roomId, '/listen'), { role: ctx.role })
      const w = wakers(l)
      lastErr = null
      if (w.length) return printWake(ctx, st, w, l)
    } catch (e) {
      if (e.error !== 'network') throw e
      lastErr = e
    }
  }
}

function socketWait(ctx, deadline, st) {
  const url = server().replace(/^http/, 'ws') + '/api/v1' + roomPath(ctx.roomId, '/ws')
  const token = readToken()
  return new Promise((resolve, reject) => {
    const got = new Map()
    let ws = null
    let pingTimer = null
    let flushTimer = null
    let finished = false
    let failures = 0
    let lastErr = null

    const finish = (fn) => {
      if (finished) return
      finished = true
      clearInterval(pingTimer)
      clearTimeout(flushTimer)
      clearTimeout(deadlineTimer)
      try { ws?.close() } catch {}
      fn()
    }
    const deadlineTimer = setTimeout(
      () => finish(() => (lastErr ? reject(lastErr) : resolve(printIdle(st.roomName, ctx.roomId)))),
      Math.max(0, deadline - Date.now()),
    )
    const collect = (list) => {
      if (finished) return
      for (const m of list) if (m && Number.isInteger(m.seq)) got.set(m.seq, m)
      if (got.size && !flushTimer) {
        flushTimer = setTimeout(() => finish(() => resolve(printWake(ctx, st, [...got.values()]))), 500)
      }
    }
    const retry = async () => {
      if (finished) return
      failures++
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5))
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
      if (finished) return
      // The handshake carries no error body, so ask listen: it reports not_member,
      // unauthorized and the like properly, and catches anything sent in the gap.
      try {
        const w = wakers(await api('GET', roomPath(ctx.roomId, '/listen'), { role: ctx.role }))
        lastErr = null
        if (w.length) return collect(w)
      } catch (e) {
        if (e.error === 'network') {
          lastErr = e
          return retry()
        }
        return finish(() => reject(e))
      }
      connect()
    }
    const connect = () => {
      if (finished) return
      try {
        ws = new WebSocket(url, {
          headers: { Authorization: `Bearer ${token}`, 'X-Scorpio-Role': ctx.role, 'User-Agent': `scorpio-cli/${VERSION}` },
        })
      } catch {
        return retry()
      }
      ws.addEventListener('open', () => {
        failures = 0
        lastErr = null
        clearInterval(pingTimer)
        pingTimer = setInterval(() => { try { ws.send('ping') } catch {} }, 30_000)
      })
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string' || ev.data === 'pong') return
        let f
        try { f = JSON.parse(ev.data) } catch { return }
        if (f.type === 'ready') {
          if (f.room?.name) st.roomName = f.room.name
          if (f.room?.topic !== undefined) st.topic = f.room.topic
          if (f.me?.name) st.me = f.me.name
          collect(f.pending || [])
        } else if (f.type === 'push' && f.message) {
          collect([f.message])
        } else if (f.type === 'superseded') {
          // This computer's daemon now delivers to this agent: stop here and never reconnect, or the two fight.
          finish(() => resolve(emit(`Scorpio topic "${st.roomName}" (${ctx.roomId}): messages for ${f.name || ctx.role} now arrive in this session through this computer's Scorpio daemon (${f.by || 'the daemon'}). Don't run wait again.`, 0)))
        }
      })
      // An error is always followed by close.
      ws.addEventListener('close', (ev) => {
        clearInterval(pingTimer)
        if (ev?.code === 4001) return finish(() => resolve(emit(`Scorpio topic "${st.roomName}" (${ctx.roomId}): messages for ${ctx.role} now arrive in this session through this computer's Scorpio daemon. Don't run wait again.`, 0)))
        if (!finished) retry()
      })
    }
    connect()
  })
}

export { wait }
