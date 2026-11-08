// 「这个仓库算不算 DSH 插件」的判定：规则对齐市场 collector/src/detect.ts。
//
// 市场收录条件（全部满足）：
//   1. 公开、非 fork、非归档、非官方本体；
//   2. 根目录有 SKILL.md / skills/SKILL.md（skill 型），或
//      有 cordis.patch.yml / dsh.profile / dsh.profile.yml / dsh-manifest.json / dsh.plugin.json（cordis 标记），或
//      package.json 的依赖含 cordis 关键字 / 声明 dsh.bundle.patch / dsh.client（cordis 插件）。
// 判定故意保守：宁可报告「不像插件」，也不给无关仓库乱打 topic。
const CORDIS_MARKERS = [
  'cordis.patch.yml',
  'dsh.profile',
  'dsh.profile.yml',
  'dsh-manifest.json',
  'dsh.plugin.json',
]
// 与市场一致的依赖关键字：任何依赖名包含其中之一即视为 cordis 插件。
const CORDIS_PKG_KEYWORDS = ['cordis', '@cordisjs/plugin', 'dsh-base', '@deepseek-ai/dsh-']
const SKIP_DIRS = /^(docs?|assets?|test|tests|scripts?|tools?|examples?|images?|img|public|src|lib|dist|node_modules|vendor|\.github)$/i

const fileOf = (item) => item !== undefined && item.type === 'file'
const dirOf = (item) => item !== undefined && item.type === 'dir'

/** 仓库里的 package.json 是不是 cordis 插件（三种判据，跟市场一致）。 */
export function isCordisPackageJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return false
  }
  if (pkg === null || typeof pkg !== 'object') return false
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }
  if (Object.keys(deps).some((dep) => CORDIS_PKG_KEYWORDS.some((keyword) => dep.includes(keyword)))) return true
  if (pkg.dsh !== null && typeof pkg.dsh === 'object') {
    if (pkg.dsh.bundle?.patch) return true
    if (pkg.dsh.client) return true
  }
  return false
}

/** 子目录 bundle 的候选：与仓库同名 / dsh|cordis|plugin|bundle|client|web 开头，最多 4 个。 */
export function pickSubdirs(items, repoName) {
  const dirs = items.filter((item) => dirOf(item) && !SKIP_DIRS.test(item.name))
  const wanted = String(repoName ?? '').toLowerCase()
  const candidates = []
  const seen = new Set()
  const push = (item) => {
    const key = item.path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(item)
  }
  for (const item of dirs) if (item.name.toLowerCase() === wanted) push(item)
  for (const item of dirs) if (/^(dsh|cordis|plugin|bundle|client|web)/i.test(item.name)) push(item)
  return candidates.slice(0, 4)
}

/**
 * 判定一层目录（根目录或某个子目录）是不是插件。
 * 只在必要时才发额外请求（package.json 内容、skills/ 列表）。
 * @returns { eligible, kind, evidence, reason }
 */
export async function detectLayer({ github, fullName, path = '', items }) {
  const list = Array.isArray(items) ? items : []
  const byName = new Map(list.map((item) => [String(item.name).toLowerCase(), item]))
  const prefix = path === '' ? '' : `${path}/`
  const hasSkill = fileOf(byName.get('skill.md'))
  const marker = CORDIS_MARKERS.find((name) => fileOf(byName.get(name.toLowerCase())))
  if (marker !== undefined) {
    return { eligible: true, kind: 'cordis', evidence: `${prefix}${marker}`, reason: null }
  }

  let skillDir = false
  const skills = byName.get('skills')
  if (!hasSkill && dirOf(skills)) {
    try {
      const subItems = await github.rootItems(fullName, skills.path)
      skillDir = (Array.isArray(subItems) ? subItems : []).some(
        (item) => fileOf(item) && item.name.toUpperCase() === 'SKILL.MD',
      )
    } catch {
      skillDir = false
    }
  }

  let pkgText = null
  let hasPkg = false
  if (fileOf(byName.get('package.json'))) {
    hasPkg = true
    try {
      pkgText = await github.file(fullName, `${prefix}package.json`)
    } catch {
      pkgText = null
    }
  }

  const pkgIsCordis = isCordisPackageJson(pkgText)
  if (pkgIsCordis) {
    return { eligible: true, kind: 'cordis', evidence: `${prefix}package.json 声明 cordis`, reason: null }
  }
  if (hasSkill || skillDir) {
    return {
      eligible: true,
      kind: 'skill',
      evidence: hasSkill ? `${prefix}SKILL.md` : `${prefix}skills/*/SKILL.md`,
      reason: null,
    }
  }
  if (hasPkg) {
    return {
      eligible: false,
      kind: null,
      evidence: null,
      reason: 'package.json 里没有 cordis 依赖，也没有 dsh.bundle.patch / dsh.client 字段',
      pkgText,
    }
  }
  return {
    eligible: false,
    kind: null,
    evidence: null,
    reason: '根目录没有 cordis.patch.yml / dsh.profile / SKILL.md，也没有 package.json',
    pkgText: null,
  }
}

/**
 * 判定整个仓库：先看根目录，根目录不像插件且允许时再看一层子目录。
 * @returns { eligible, kind, evidence, reason, source }
 */
export async function detectRepo({ github, repo, settings, log = () => {} }) {
  const fullName = repo.full_name
  let items
  try {
    items = await github.rootItems(fullName)
  } catch (error) {
    return { eligible: false, kind: null, reason: `读取根目录失败：${error?.message ?? error}`, source: 'root' }
  }
  if (!Array.isArray(items)) {
    return { eligible: false, kind: null, reason: '仓库是空的（根目录不可读）', source: 'root' }
  }

  const root = await detectLayer({ github, fullName, path: '', items })
  if (root.eligible) return { ...root, source: 'root', rootNames: items.map((item) => String(item.name)) }

  if (settings.followSubdir) {
    for (const dir of pickSubdirs(items, repo.name)) {
      try {
        const subItems = await github.rootItems(fullName, dir.path)
        if (!Array.isArray(subItems)) continue
        const sub = await detectLayer({ github, fullName, path: dir.path, items: subItems })
        if (sub.eligible) return { ...sub, source: `subdir ${dir.path}/`, rootNames: items.map((item) => String(item.name)) }
      } catch (error) {
        log(`      ${fullName}：子目录 ${dir.path} 读取失败（${error?.message ?? error}）`)
      }
    }
  }
  return { ...root, source: 'root', rootNames: items.map((item) => String(item.name)) }
}

export { CORDIS_MARKERS, CORDIS_PKG_KEYWORDS }
