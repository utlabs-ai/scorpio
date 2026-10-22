// Last validated copy of the server's config:spawn. The daemon uses it through network outages and restarts.
import { readJson, writeJson, SPAWN_CONFIG_FILE } from './paths.mjs'

export const DEFAULT_SPAWN = {
  checkedAt: null, sources: [],
  claude: { models: [{ id: 'claude-opus-5-5' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].map((id) => ({ id })), default: { model: 'claude-opus-5-5', effort: 'medium' } },
  codex: { models: [{ id: 'gpt-6.1-sol' }], efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id })), default: { model: 'gpt-6.1-sol', effort: 'medium' } },
}
export const SPAWN_REFRESH_MS = 24 * 60 * 60 * 1000
export const SPAWN_RETRY_MS = 60 * 60 * 1000
const idOk = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value)
const kindOk = (kind) => kind && ['models', 'efforts'].every((key) => Array.isArray(kind[key]) && kind[key].length > 0 &&
  kind[key].every((item) => item && idOk(item.id) && (item.about === undefined || (item.about && typeof item.about === 'object' && !Array.isArray(item.about) && ['en', 'zh'].every((lang) => item.about[lang] === undefined ||
    (typeof item.about[lang] === 'string' && item.about[lang].length >= 1 && item.about[lang].length <= 160 && !/[\r\n]/.test(item.about[lang]))))))) &&
  kind.default && kind.models.some((item) => item.id === kind.default.model) && kind.efforts.some((item) => item.id === kind.default.effort)

export function spawnOptionsOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!kindOk(raw.claude) && !kindOk(raw.codex)) return null
  return {
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s) => typeof s === 'string') : [],
    claude: kindOk(raw.claude) ? raw.claude : DEFAULT_SPAWN.claude,
    codex: kindOk(raw.codex) ? raw.codex : DEFAULT_SPAWN.codex,
  }
}

/** Return the last copy immediately; refresh after 24 hours on success, or retry after an hour on failure. */
export function createSpawnOptions({ fetch, now = () => Date.now(), file = SPAWN_CONFIG_FILE, log = () => {} }) {
  let value = spawnOptionsOf(readJson(file)) || DEFAULT_SPAWN
  let nextAt = -Infinity, pending = null
  return {
    get: () => value,
    async refresh() {
      if (pending) return pending
      if (now() < nextAt) return false
      pending = (async () => {
        try {
          const got = spawnOptionsOf(await fetch())
          if (!got) throw new Error('invalid response')
          const changed = JSON.stringify(value) !== JSON.stringify(got)
          value = got
          writeJson(file, got)
          nextAt = now() + SPAWN_REFRESH_MS
          return changed
        } catch (error) {
          nextAt = now() + SPAWN_RETRY_MS
          log(`could not refresh spawn options: ${error.code || error.message}`)
          return false
        }
      })().finally(() => { pending = null })
      return pending
    },
  }
}

export function spawnHelpOptions(config, clis) {
  const kinds = clis.filter((c) => c.installed).map((c) => c.kind)
  return kinds.flatMap((kind) => {
    const group = config[kind]
    const items = (key, selected) => group[key].map(({ id, about }) => `${id}${id === group.default[selected] ? ' (default)' : ''}${about?.en ? ` — ${about.en}` : ''}`).join('; ')
    return [`  ${kind} models: ${items('models', 'model')}`, `  ${kind} effort: ${items('efforts', 'effort')}`]
  }).join('\n')
}
