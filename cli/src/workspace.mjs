// A topic's local workspace and downloaded files live under this computer's Scorpio home.
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './daemon/paths.mjs'

import { TOPIC_ID } from './path-safety.mjs'
const root = path.resolve(HOME)

function topicDir(topicId) {
  if (typeof topicId !== 'string' || !TOPIC_ID.test(topicId)) throw new Error('Invalid topic id.')
  return path.join(root, 'topics', topicId)
}

export const workspaceFor = (topicId) => path.join(topicDir(topicId), 'workspace')
export const topicFilesDir = (topicId) => path.join(topicDir(topicId), 'files')

// Check each directory before descending, so an existing file or symlink cannot redirect writes.
export function ensureDir(dir) {
  const target = path.resolve(dir)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Directory is outside Scorpio home: ${target}`)
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const check = (current, follow = false) => {
    const stat = follow ? fs.statSync(current) : fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a directory: ${current}`)
  }
  // Dotfiles tools may link ~/.scorpio to another directory. Its children must still be real dirs.
  check(root, true)
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try { fs.mkdirSync(current, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    check(current)
  }
  return target
}
