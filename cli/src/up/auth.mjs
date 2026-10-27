import { setTimeout as sleep } from 'node:timers/promises'
import { verificationUrl } from '../server-url.mjs'
import { server } from '../daemon/paths.mjs'
import { cli } from './services.mjs'
import { tr } from './screen.mjs'

export async function currentAccount() {
  try {
    const who = await cli('whoami')
    return who?.account ? who : null
  } catch (error) {
    if (/unauthorized|revoked|expired/i.test(error.message)) return null
    throw error
  }
}

export async function authorize(screen) {
  const existing = await currentAccount()
  if (existing) return existing
  const deadline = Date.now() + 15 * 60_000
  let shown = ''
  let card = null
  try {
    while (Date.now() < deadline) {
      let state
      try { state = await cli('login', [], { timeout: 75_000 }) }
      catch (error) {
        const clean = error.message.split(' Check with `scorpio messages`')[0]
        throw new Error(clean)
      }
      if (state.status === 'logged_in') {
        const who = await currentAccount()
        if (!who) throw new Error('Scorpio login did not return an account.')
        if (card) card.stop(who.account)
        else screen.write('  [ok] ' + tr(screen.language, 'Approved. Account: ', '已授权，账号：') + who.account + '\n')
        return who
      }
      if (state.status !== 'authorization_pending') throw new Error('Unexpected Scorpio login status: ' + state.status)
      const link = verificationUrl(state.verification_uri_complete || state.verification_uri, server())
      if (!link || !state.user_code) throw new Error('Scorpio did not provide an approval link and code.')
      if (shown !== state.user_code) {
        if (card) card.stop('', true)
        shown = state.user_code
        card = screen.startApproval(link, state.user_code, Date.now() + Number(state.expires_in || 900) * 1000)
      }
      await sleep(1000)
    }
  } catch (error) {
    if (card) card.stop('', true)
    throw error
  }
  if (card) card.stop('', true)
  throw new Error(tr(screen.language, 'Approval timed out. Approve the code and run scorpio up again.', '授权等待超时。在网页上授权后，再次运行 scorpio up。'))
}
