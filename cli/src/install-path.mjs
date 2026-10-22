import fs from 'node:fs'
import path from 'node:path'

const PATH_LINE = 'export PATH="$HOME/.scorpio/bin:$PATH"'

export function exposeLauncher({ home, launcher, pathEnv = '', platform = process.platform, shell = process.env.SHELL || '' }) {
  const local = path.join(home, '.local', 'bin')
  const preferred = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', local, path.join(home, 'bin')]
    : [local, path.join(home, 'bin'), '/usr/local/bin']
  const candidates = new Set(preferred.map((dir) => path.resolve(dir)))
  // npx adds temporary node_modules/.bin entries; they disappear when the installer exits.
  const dirs = pathEnv.split(path.delimiter).filter((dir) => path.isAbsolute(dir) && !/(^|\/)(node_modules|\.npm|\.pnpm|\.yarn)(\/|$)/.test(dir)).map((dir) => path.resolve(dir))
  for (const dir of dirs) {
    const link = path.join(dir, 'scorpio')
    try {
      const entry = fs.lstatSync(link)
      if (entry.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === launcher) return { mode: 'link', path: link }
      break // an earlier command would shadow a link later in PATH
    } catch (error) { if (error.code !== 'ENOENT') continue }
    if (!candidates.has(path.resolve(dir))) continue
    try {
      if (dir === local && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (!fs.statSync(dir).isDirectory()) continue
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK)
      fs.symlinkSync(launcher, link)
      return { mode: 'link', path: link }
    } catch { /* try the next writable PATH directory */ }
  }

  const rc = path.join(home, shell.endsWith('/zsh') ? '.zshrc' : shell.endsWith('/bash') ? '.bashrc' : '.profile')
  const old = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : ''
  if (!old.split(/\r?\n/).some((line) => line.trim() === PATH_LINE)) {
    fs.appendFileSync(rc, `${old && !old.endsWith('\n') ? '\n' : ''}${PATH_LINE}\n`)
  }
  return { mode: 'rc', path: rc }
}
