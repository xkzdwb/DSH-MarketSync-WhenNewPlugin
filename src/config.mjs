// 配置读取：把 profile patch 里的 config 拍平成普通对象，并解析 GitHub token 的来源。
//
// 安全取舍：
//   - token 不进 yml（yml 会被读进会话上下文），默认只从 secrets.json 或环境变量取；
//   - 每次运行都重新读 secrets.json，这样刚授权完不用重启 DSH 就能生效；
//   - 一切日志/状态接口只输出掩码（ghp_…abcd）。
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const DEFAULTS = {
  time: '00:00',                 // 每天几点跑（24 小时制）
  timeZone: 'Asia/Shanghai',
  catchUp: true,                 // 00:00 时 DSH 没开：下次启动补跑一次
  tickIntervalMs: 30000,         // 多久看一次表
  namePattern: '^DSH',           // 只处理仓库名匹配这个正则的
  topics: ['dsh-plugin'],        // 要给仓库打上的 topic（市场按它扫）
  includePrivate: false,         // 市场只收公开仓库，私有仓库默认跳过并报告
  includeForks: false,
  includeArchived: false,
  requireMarkers: true,          // 只给「确实是插件」的仓库打 topic，避免污染
  autoMark: true,                // 像插件却没标记时，自动补 cordis.patch.yml + dsh.bundle.patch
  markerCommitMessage: 'chore(dsh): 补市场收录标记（cordis.patch.yml + dsh.bundle.patch）',
  followSubdir: true,            // 根目录没标记时，再看一层子目录（monorepo 常见）
  maxRepos: 200,                 // 最多扫多少个仓库（防止 API 额度被吃光）
  submitMissing: true,           // 已打 topic 但市场索引里没有 → 自动提 submission issue
  marketIndexUrl: 'https://2bingling.github.io/dsh-market/plugins-lite.json',
  marketRepo: '2BingLing/dsh-market',
  maxIssuesPerRun: 3,            // 一次最多提几个 issue（防止误配置刷屏）
  secretsFile: '',               // {"githubToken":"…"}；留空 = 插件目录 secrets.json
  token: '',                     // 应急用：也可直接写在 config 里（不推荐）
  stateFile: '',                 // 留空 = 插件目录 state.json
  auditFile: '',                 // 留空 = 插件目录 audit/sync.jsonl
  dryRun: false,                 // true = 只查询/报告，不真的改 topic
  timeoutMs: 20000,              // 单次 HTTP 超时
  retries: 3,                    // 网络/5xx 重试次数
}

function value(input, fallback) {
  const raw = input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

function plain(input) {
  const raw = value(input, undefined)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of Object.keys(raw)) out[key] = value(raw[key], undefined)
  return out
}

function bool(input, fallback) {
  const raw = value(input, fallback)
  return raw === true || raw === 'true' || raw === 1
}

function numberOr(input, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const raw = Number(value(input, fallback))
  if (!Number.isFinite(raw)) return fallback
  const clamped = Math.min(max, Math.max(min, raw))
  return integer ? Math.round(clamped) : clamped
}

/** "HH:MM" → { hour, minute }；非法值直接抛错（配置错要立刻看见，而不是半夜悄悄不跑）。 */
export function parseTimeOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (match === null) throw new Error(`config.time 必须是 HH:MM，现在是 ${JSON.stringify(text)}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error(`config.time 超出范围（00:00–23:59）：${JSON.stringify(text)}`)
  return { hour, minute }
}

/** 时区是否被 Intl 认识；写错时区会让定时算错，所以直接报错。 */
export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch (error) {
    throw new Error(`config.timeZone 不是合法时区 ${JSON.stringify(timeZone)}：${error?.message ?? error}`)
  }
}

/** topic 列表：数组或逗号分隔字符串 → 规范化后的去重数组；非法项抛错。 */
export function normalizeTopics(input) {
  const list = Array.isArray(input) ? input : String(value(input, '')).split(',')
  const out = []
  for (const item of list) {
    const topic = String(item).trim().toLowerCase()
    if (topic === '') continue
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic)) {
      throw new Error(`config.topics 里有不合法的 topic：${JSON.stringify(item)}（只能是小写字母/数字/连字符）`)
    }
    if (!out.includes(topic)) out.push(topic)
  }
  return out
}

function resolvePath(rawPath, root, fallbackName) {
  const text = String(rawPath ?? '').trim()
  if (text === '') return join(root, fallbackName)
  return isAbsolute(text) ? text : resolve(root, text)
}

/**
 * 读取有效配置。
 * @param rawConfig - cordis 传入的 config。
 * @param options - { pluginRoot }
 * @returns 归一化后的配置（token 只有显式写在 config 里才会出现在这里）。
 * @throws 配置非法时抛错；apply() 会兜住并在 HOST 日志里说明原因。
 */
export function readSettings(rawConfig, { pluginRoot } = {}) {
  const input = rawConfig ?? {}
  const root = pluginRoot ?? process.cwd()

  const timeZone = String(value(input.timeZone, DEFAULTS.timeZone))
  assertTimeZone(timeZone)
  const { hour, minute } = parseTimeOfDay(value(input.time, DEFAULTS.time))

  const namePatternSource = String(value(input.namePattern, DEFAULTS.namePattern))
  let namePattern
  try {
    namePattern = new RegExp(namePatternSource)
  } catch (error) {
    throw new Error(`config.namePattern 不是合法正则 ${JSON.stringify(namePatternSource)}：${error?.message ?? error}`)
  }

  const topics = normalizeTopics(value(input.topics, DEFAULTS.topics))
  if (topics.length === 0) throw new Error('config.topics 至少给一个 topic（市场靠它收录）')

  return {
    timeZone,
    hour,
    minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    catchUp: bool(input.catchUp, DEFAULTS.catchUp),
    tickIntervalMs: numberOr(input.tickIntervalMs, DEFAULTS.tickIntervalMs, { min: 5000, max: 3600000, integer: true }),
    namePattern,
    namePatternSource,
    topics,
    includePrivate: bool(input.includePrivate, DEFAULTS.includePrivate),
    includeForks: bool(input.includeForks, DEFAULTS.includeForks),
    includeArchived: bool(input.includeArchived, DEFAULTS.includeArchived),
    requireMarkers: bool(input.requireMarkers, DEFAULTS.requireMarkers),
    autoMark: bool(input.autoMark, DEFAULTS.autoMark),
    markerCommitMessage: String(value(input.markerCommitMessage, DEFAULTS.markerCommitMessage)),
    followSubdir: bool(input.followSubdir, DEFAULTS.followSubdir),
    maxRepos: numberOr(input.maxRepos, DEFAULTS.maxRepos, { min: 1, max: 2000, integer: true }),
    submitMissing: bool(input.submitMissing, DEFAULTS.submitMissing),
    marketIndexUrl: String(value(input.marketIndexUrl, DEFAULTS.marketIndexUrl)),
    marketRepo: String(value(input.marketRepo, DEFAULTS.marketRepo)),
    maxIssuesPerRun: numberOr(input.maxIssuesPerRun, DEFAULTS.maxIssuesPerRun, { min: 0, max: 20, integer: true }),
    secretsPath: resolvePath(value(input.secretsFile, DEFAULTS.secretsFile), root, 'secrets.json'),
    token: String(value(input.token, DEFAULTS.token)).trim(),
    stateFile: resolvePath(value(input.stateFile, DEFAULTS.stateFile), root, 'state.json'),
    auditFile: resolvePath(value(input.auditFile, DEFAULTS.auditFile), root, 'audit/sync.jsonl'),
    dryRun: bool(input.dryRun, DEFAULTS.dryRun),
    timeoutMs: numberOr(input.timeoutMs, DEFAULTS.timeoutMs, { min: 2000, max: 120000, integer: true }),
    retries: numberOr(input.retries, DEFAULTS.retries, { min: 0, max: 5, integer: true }),
    pluginRoot: root,
  }
}

/** 读 secrets.json；文件不存在 = 没有，解析失败才报警。 */
export function readSecrets(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { secrets: {}, missing: true }
    return { secrets: {}, error: `读取 secretsFile 失败（${file}）：${error?.message ?? error}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { secrets: {}, error: `secretsFile 必须是 JSON 对象（${file}）` }
    }
    return { secrets: parsed }
  } catch (error) {
    return { secrets: {}, error: `secretsFile 不是合法 JSON（${file}）：${error?.message ?? error}` }
  }
}

/**
 * 解析 token：config.token > secrets.json > 环境变量。
 * 每次调用都重新读文件，授权后无需重启。
 * @returns { token, source }，source ∈ 'config' | 'secrets' | 'env' | 'none'
 */
export function resolveToken(settings) {
  if (settings.token !== '') return { token: settings.token, source: 'config' }
  const { secrets } = readSecrets(settings.secretsPath)
  const fromFile = secrets.githubToken ?? secrets.token ?? secrets.github?.token
  if (typeof fromFile === 'string' && fromFile.trim() !== '') {
    return { token: fromFile.trim(), source: 'secrets' }
  }
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (typeof env === 'string' && env.trim() !== '') return { token: env.trim(), source: 'env' }
  return { token: '', source: 'none' }
}

/** 日志里只留前后几位，避免 token 泄漏到 HOST 日志。 */
export function maskToken(token) {
  const text = String(token ?? '')
  if (text.length < 12) return text === '' ? '' : '***'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}
