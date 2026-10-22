// The environment for every process a test starts that may run the CLI, the installer or the daemon.
// Whoever runs the tests may have SCORPIO_HOME and SCORPIO_SERVER set for their own install (agents a
// daemon starts inherit both). A child given {...process.env, HOME: tmp} keeps them, and then installs
// into, logs out of or restarts that real install. So testEnv() always sets both homes to the test's
// own directory and drops SCORPIO_SERVER, and refuses to hand out an environment that would still
// reach a real Scorpio home.
import os from 'node:os'
import path from 'node:path'

// Read once, before any test changes process.env.HOME: the homes of whoever runs the tests.
const REAL = [...new Set([os.userInfo().homedir, process.env.HOME].filter(Boolean))]
  .flatMap((home) => ['.scorpio', '.scorpio-staging'].map((dir) => path.resolve(home, dir)))

/**
 * process.env with HOME set to `home`, SCORPIO_HOME to `home`/.scorpio and no SCORPIO_SERVER, then
 * `extra` on top: a test that needs another SCORPIO_HOME or a server sets it there, and '' for
 * SCORPIO_HOME means unset (the default under HOME).
 */
export function testEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, SCORPIO_HOME: path.join(home, '.scorpio') }
  delete env.SCORPIO_SERVER
  return assertTestHome({ ...env, ...extra })
}

/** Throws before anything runs when a child with this environment would use a real Scorpio home. */
export function assertTestHome(env) {
  const home = path.resolve(env.SCORPIO_HOME || path.join(env.HOME || os.homedir(), '.scorpio'))
  if (REAL.includes(home)) {
    throw new Error(`A test would run with the real Scorpio home ${home}: build its environment with testEnv(<temporary directory>).`)
  }
  return env
}
