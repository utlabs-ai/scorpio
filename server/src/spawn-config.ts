// KV config:spawn is the truth for the options offered by /spawn. The built-ins match the CLI's shipped args.
export type SpawnOption = { id: string; about?: { en?: string; zh?: string } };
export type PermOption = { id: string; label: { en: string; zh: string }; about?: { en?: string; zh?: string }; note?: { en?: string; zh?: string } };
export type SpawnKind = { models: SpawnOption[]; efforts: SpawnOption[]; default: { model: string; effort: string } };
export type SpawnConfig = { perm: PermOption[]; checkedAt: string | null; sources: string[]; claude: SpawnKind; codex: SpawnKind };

const efforts = (kind: "claude" | "codex") =>
  (kind === "claude" ? ["low", "medium", "high", "xhigh", "max", "ultracode"] : ["low", "medium", "high", "xhigh"]).map((id) => ({ id }));
export const DEFAULT_SPAWN: SpawnConfig = {
  perm: [
    { id: "ask", label: {"en": "Ask me in Scorpio", "zh": "在 Scorpio 里问我"}, about: {"en": "Claude Code and Codex run with your own settings on your computer; when they ask for permission, it comes to you in Scorpio. If your Codex settings set no approval policy, --ask-for-approval on-request is added, so it asks you before leaving its sandbox.", "zh": "Claude Code 和 Codex 照你电脑上的配置运行，要申请权限时弹到 Scorpio 里给你答。Codex 配置里没设审批策略的，加 --ask-for-approval on-request，出沙箱前先来问你。"} },
    { id: "auto", label: {"en": "Approve for me", "zh": "代我审批"}, about: {"en": "Claude Code's auto mode (--permission-mode auto); Codex's auto-review (--approve-for-me). What they block is not sent to you.", "zh": "Claude Code 的 auto 模式（--permission-mode auto）；Codex 的自动审（--approve-for-me）。它们拦下的不问你。"} },
    { id: "all", label: {"en": "Allow everything", "zh": "全部放行"}, about: {"en": "Claude Code skips all permission checks (--dangerously-skip-permissions); Codex runs fully open (--ask-for-approval never --sandbox danger-full-access).", "zh": "Claude Code 跳过所有权限（--dangerously-skip-permissions）；Codex 完全放开（--ask-for-approval never --sandbox danger-full-access）。"}, note: {"en": "This agent skips every approval, as before. It applies to this session only and changes no setting on your computer.", "zh": "这个 agent 跳过所有审批，和以前一样。只管它这一次会话，不改你电脑上的设置。"} },
  ],
  checkedAt: null,
  sources: [],
  claude: { models: [{ id: "claude-opus-5-5" }], efforts: efforts("claude"), default: { model: "claude-opus-5-5", effort: "medium" } },
  codex: { models: [{ id: "gpt-6.1-sol" }], efforts: efforts("codex"), default: { model: "gpt-6.1-sol", effort: "medium" } },
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const idOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(v);
const sentenceOk = (v: unknown, max = 160) => typeof v === "string" && v.trim() === v && v.length >= 1 && v.length <= max && !/[\r\n]/.test(v);

function kindOf(raw: unknown, name: string): SpawnKind {
  if (!object(raw)) throw new Error(`${name}: expected an object`);
  const options = (field: "models" | "efforts") => {
    const list = raw[field];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${name}.${field}: expected a nonempty list`);
    const seen = new Set<string>();
    return list.map((entry, i): SpawnOption => {
      const item = `${name}.${field}[${i}]`;
      if (!object(entry) || !idOk(entry.id)) throw new Error(`${item}.id: use 1–64 letters, digits, . _ : or -`);
      if (seen.has(entry.id)) throw new Error(`${item}.id: duplicate ${entry.id}`);
      seen.add(entry.id);
      if (entry.about === undefined) return { id: entry.id };
      if (!object(entry.about)) throw new Error(`${item}.about: expected an object`);
      const about: { en?: string; zh?: string } = {};
      for (const lang of ["en", "zh"] as const) {
        const value = entry.about[lang];
        if (value !== undefined) {
          if (!sentenceOk(value)) throw new Error(`${item}.about.${lang}: expected one line of 1–160 characters`);
          about[lang] = value as string;
        }
      }
      return { id: entry.id, about };
    });
  };
  const models = options("models"), efforts = options("efforts");
  const defaults = raw.default;
  if (!object(defaults) || !idOk(defaults.model) || !models.some((o) => o.id === defaults.model))
    throw new Error(`${name}.default.model: must name a listed model`);
  if (!idOk(defaults.effort) || !efforts.some((o) => o.id === defaults.effort))
    throw new Error(`${name}.default.effort: must name a listed effort`);
  return { models, efforts, default: { model: defaults.model, effort: defaults.effort } };
}

function permOf(raw: unknown): PermOption[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("perm: expected a nonempty list");
  const seen = new Set<string>();
  const allowed = raw.filter((entry) => object(entry) && ["ask", "auto", "all"].includes(entry.id as string));
  if (!allowed.length) throw new Error("perm: no supported levels");
  return allowed.map((entry, i): PermOption => {
    const item = `perm[${i}]`;
    if (!object(entry) || !idOk(entry.id)) throw new Error(`${item}.id: use 1–64 letters, digits, . _ : or -`);
    if (seen.has(entry.id)) throw new Error(`${item}.id: duplicate ${entry.id}`);
    seen.add(entry.id);
    if (!object(entry.label) || !sentenceOk(entry.label.en) || !sentenceOk(entry.label.zh))
      throw new Error(`${item}.label: expected en and zh lines of 1–160 characters`);
    const result: PermOption = { id: entry.id, label: { en: entry.label.en as string, zh: entry.label.zh as string } };
    for (const field of ["about", "note"] as const) {
      const text = entry[field];
      if (text === undefined) continue;
      if (!object(text)) throw new Error(`${item}.${field}: expected an object`);
      result[field] = {};
      for (const lang of ["en", "zh"] as const) {
        if (text[lang] === undefined) continue;
        if (!sentenceOk(text[lang], 400)) throw new Error(`${item}.${field}.${lang}: expected one line of 1–400 characters`);
        result[field][lang] = text[lang] as string;
      }
    }
    return result;
  });
}

/** Strict mode is for the editor; the Worker falls back each option list independently. */
export function spawnConfigOf(raw: unknown, strict = false): SpawnConfig {
  if (!object(raw)) {
    if (strict) throw new Error("config:spawn: expected an object");
    return DEFAULT_SPAWN;
  }
  if (strict && (typeof raw.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.checkedAt)))
    throw new Error("checkedAt: expected YYYY-MM-DD");
  if (strict && (!Array.isArray(raw.sources) || !raw.sources.every((s) => typeof s === "string" && /^https:\/\//.test(s))))
    throw new Error("sources: expected HTTPS URL strings");
  const result: SpawnConfig = {
    perm: DEFAULT_SPAWN.perm,
    checkedAt: typeof raw.checkedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.checkedAt) ? raw.checkedAt : null,
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s): s is string => typeof s === "string" && /^https:\/\//.test(s)) : [],
    claude: DEFAULT_SPAWN.claude,
    codex: DEFAULT_SPAWN.codex,
  };
  for (const name of ["claude", "codex"] as const) {
    try { result[name] = kindOf(raw[name], name); }
    catch (error) { if (strict) throw error; }
  }
  if (raw.perm !== undefined) {
    try { result.perm = permOf(raw.perm); }
    catch (error) { if (strict) throw error; }
  }
  return result;
}

let cache: { value: SpawnConfig; at: number } | null = null;
export async function configSpawn(env: { KV: KVNamespace }): Promise<SpawnConfig> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const raw = await env.KV.get("config:spawn", { type: "json", cacheTtl: 60 }).catch(() => null);
  cache = { value: spawnConfigOf(raw), at: Date.now() };
  return cache.value;
}
