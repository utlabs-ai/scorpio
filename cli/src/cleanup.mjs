import fs from 'node:fs'
import path from 'node:path'

export const DAY_MS = 24 * 60 * 60 * 1000
export const HERDR_LOG_BYTES = 10 * 1024 * 1024
export const cleanupDays = (value) => Number.isInteger(value) && value >= 0 ? value : 30

// HOME is the configured, resolved root. Links below it can lead to a workspace or another home.
function localStat(home, file = home) {
  const relative = path.relative(home, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  let current = home, stat
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    try { stat = fs.lstatSync(current) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    if (stat.isSymbolicLink()) return null
  }
  return stat
}

function report(log, error) {
  // Error text can contain paths or data from a failed operation; log only its status.
  try { log(`local cleanup: ${error.code || error.name || 'unknown'}`) } catch {}
}

function regularFd(home, file, flags, act) {
  const stat = localStat(home, file)
  if (!stat?.isFile() || stat.nlink !== 1) return
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (opened.isFile() && opened.nlink === 1 && opened.ino === stat.ino && opened.dev === stat.dev) act(fd, opened)
  } finally { fs.closeSync(fd) }
}

/** Only the paths enumerated here are eligible; never recursively remove an unknown tree. */
export function cleanup({ home, now = Date.now(), days = 30, log = console.error }) {
  days = cleanupDays(days)
  const attempt = (fn) => { try { return fn() } catch (e) { report(log, e) } }
  const children = (dir) => attempt(() => localStat(home, dir)?.isDirectory() ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : []) || []
  const removeEmpty = (dir) => attempt(() => {
    if (localStat(home, dir)?.isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  })
  const expire = (file, age, privatePrompt = false) => attempt(() => {
    const stat = localStat(home, file)
    if (!stat?.isFile() || stat.nlink !== 1) return
    if (now - stat.mtimeMs > age) { fs.unlinkSync(file); return true }
    else if (privatePrompt && (stat.mode & 0o777) !== 0o600) {
      regularFd(home, file, fs.constants.O_RDONLY, (fd) => fs.fchmodSync(fd, 0o600))
    }
  })
  attempt(() => {
    home = fs.realpathSync(home)
    if (!localStat(home)?.isDirectory()) return
    if (days > 0) {
      for (const file of children(path.join(home, 'files'))) expire(file, days * DAY_MS)
      for (const topic of children(path.join(home, 'topics'))) {
        const dir = path.join(topic, 'files')
        let deleted = false
        for (const file of children(dir)) if (expire(file, days * DAY_MS)) deleted = true
        if (deleted) removeEmpty(dir)
      }
      for (const file of children(path.join(home, 'sessions'))) if (file.endsWith('.json')) expire(file, days * DAY_MS)
      for (const topic of children(path.join(home, 'handoffs'))) attempt(() => {
        if (!localStat(home, topic)?.isDirectory()) return
        const files = [], dirs = [], times = []
        let blocked = false
        const walk = (dir) => {
          dirs.unshift(dir)
          for (const file of children(dir)) {
            const stat = localStat(home, file)
            if (stat?.isDirectory()) walk(file)
            else if (stat?.isFile() && stat.nlink === 1) { files.push(file); times.push(stat.mtimeMs) }
            else blocked = true // Keep links and special files, and therefore their containing directory.
          }
        }
        walk(topic)
        const newest = times.length ? Math.max(...times) : localStat(home, topic).mtimeMs
        if (blocked || now - newest <= days * DAY_MS) return
        for (const file of files) expire(file, days * DAY_MS)
        for (const dir of dirs) removeEmpty(dir)
      })
    }
    for (const topic of children(path.join(home, 'spawns'))) {
      let deleted = false
      for (const file of children(topic)) if (file.endsWith('.md') && expire(file, days > 0 ? days * DAY_MS : Infinity, true)) deleted = true
      if (deleted) removeEmpty(topic)
    }
    for (const file of children(path.join(home, 'state', 'up-secrets'))) if (file.endsWith('.sh')) expire(file, DAY_MS)
    for (const file of children(path.join(home, 'tmp'))) if (/^herdr-install-.*\.sh$/.test(path.basename(file))) expire(file, DAY_MS)
    attempt(() => regularFd(home, path.join(home, 'state', 'herdr-server.log'), fs.constants.O_WRONLY, (fd, stat) => {
      if (stat.size > HERDR_LOG_BYTES) fs.ftruncateSync(fd, 0)
    }))
  })
}

/** Shared by join and the daemon: the marker records the last scan, not every command. */
export function cleanupIfDue({ home, now = Date.now(), force = false, log = console.error }) {
  try {
    home = fs.realpathSync(home)
    if (!localStat(home)?.isDirectory()) return false
    const config = path.join(home, 'config.json')
    const days = cleanupDays(localStat(home, config)?.isFile() ? JSON.parse(fs.readFileSync(config, 'utf8')).local_cleanup_days : undefined)
    const state = path.join(home, 'state'), marker = path.join(state, 'cleanup.json')
    const stat = localStat(home, marker)
    const lastRun = stat?.isFile() ? JSON.parse(fs.readFileSync(marker, 'utf8')).lastRun : null
    if (!force && Number.isFinite(lastRun) && now - lastRun <= DAY_MS) return false
    cleanup({ home, now, days, log })
    if (!localStat(home, state)) {
      // An existing link is skipped, never replaced or followed by mkdir.
      if (fs.existsSync(state) || fs.lstatSync(home).isSymbolicLink()) return true
      fs.mkdirSync(state, { mode: 0o700 })
    }
    if (!localStat(home, state)?.isDirectory()) return true
    if (fs.existsSync(marker) && !stat?.isFile()) return true
    if (stat?.isFile()) regularFd(home, marker, fs.constants.O_WRONLY, (fd) => {
      fs.ftruncateSync(fd, 0)
      fs.writeFileSync(fd, JSON.stringify({ lastRun: now }))
    })
    else {
      const fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ lastRun: now })) } finally { fs.closeSync(fd) }
    }
    return true
  } catch (e) { report(log, e); return false }
}

/** Binding reads are frequent; update only once daily and never follow a linked session. */
export function touchSession(file, now = Date.now(), log = console.error) {
  try {
    const configuredHome = path.dirname(path.dirname(path.resolve(file)))
    const home = fs.realpathSync(configuredHome)
    file = path.join(home, path.relative(configuredHome, path.resolve(file)))
    regularFd(home, file, fs.constants.O_RDONLY, (fd, stat) => {
      if (now - stat.mtimeMs > DAY_MS) fs.futimesSync(fd, now / 1000, now / 1000)
    })
  } catch (e) { report(log, e) }
}
