// The daemon's observations. The guard reads this file but makes its own independent probes.
import fs from 'node:fs'
import path from 'node:path'
import { HEALTH_FILE, PKG_DIR, readJson, writeJson } from './paths.mjs'

export const currentBuild = () => {
  try { return fs.readFileSync(path.join(PKG_DIR, '.build'), 'utf8').trim() || readJson(path.join(PKG_DIR, 'package.json'))?.version || '0.0.0' }
  catch { return readJson(path.join(PKG_DIR, 'package.json'))?.version || '0.0.0' }
}

export function createHealth({ api, links, file = HEALTH_FILE, build = currentBuild(), pid = process.pid, now = Date.now } = {}) {
  const report = { build, pid, checks: { signin: false, selfcheck: false, herdr: false }, aliveAt: now() }
  let probing = false, nextProbe = 0, savedHeartbeatAt = -Infinity, diskAliveAt = report.aliveAt
  const save = (heartbeat = false) => {
    try {
      writeJson(file, { ...report, aliveAt: heartbeat ? report.aliveAt : diskAliveAt })
      if (heartbeat) { diskAliveAt = report.aliveAt; savedHeartbeatAt = now() }
    } catch {}
  }
  save(true)
  return {
    report,
    herdr(ok) { if (report.checks.herdr !== ok) { report.checks.herdr = ok; save() } },
    round() { report.aliveAt = now(); if (now() - savedHeartbeatAt >= 30_000) save(true) },
    probe() {
      if (probing || now() < nextProbe || (report.checks.signin && report.checks.selfcheck)) return
      probing = true
      nextProbe = now() + 30_000
      Promise.all([
        report.checks.signin ? true : api.whoami({ budgetMs: 60_000 }).then(() => true, () => false),
        report.checks.selfcheck ? true : links.selfcheck(),
      ]).then(([signin, selfcheck]) => {
        report.checks.signin = signin
        report.checks.selfcheck = selfcheck
        save()
      }).finally(() => { probing = false })
    },
  }
}
