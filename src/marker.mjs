// 给「确实是自己写的 DSH 插件、但忘了写 cordis 标记」的仓库补收录标记。
//
// 市场 collector 的判定见 src/detect.mjs：根目录有 cordis.patch.yml，或 package.json 里
// 声明 dsh.bundle.patch / dsh.client / cordis 依赖。老仓库常常三样都没有，于是即使打了
// dsh-plugin topic 也会被 reject("package.json not cordis")。
//
// 这里只做最小、可审计的改动：
//   - package.json：补 dsh.bundle.patch（必要时补 main）
//   - 根目录：新建 cordis.patch.yml（insert 本包，config 用默认值）
// 只碰「根目录 package.json + src/plugin.js」这种明确的插件仓库；其它情况只报告。

const MARKER_FILE = 'cordis.patch.yml'
const BOM = '\uFEFF'

/** 去掉 BOM 后解析 package.json；失败返回 null。 */
export function parsePackageJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const pkg = JSON.parse(text.replace(/^\uFEFF/, ''))
    return pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : null
  } catch {
    return null
  }
}

/** 把 package.json 序列化回文本（保留 2 空格缩进与结尾换行）。 */
export function formatPackageJson(pkg) {
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/** dsh-weekly-report → weekly-report；拿不到就用 fallback。 */
export function markerId(pkgName, fallback = 'plugin') {
  const text = String(pkgName ?? '').trim()
  const stripped = text.replace(/^dsh[-_]?/i, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  return stripped === '' ? fallback : stripped
}

/** 生成根目录 cordis.patch.yml 的内容。config 留空 = 全部用插件默认值。 */
export function buildPatchYaml({ pkgName, id, description = '' }) {
  const lines = []
  if (description !== '') lines.push(`# ${pkgName} — ${description}`)
  lines.push(`# 这个文件由 dsh-market-sync 自动补：市场收录要求根目录有 cordis 标记。`)
  lines.push('- insert:')
  lines.push(`    - id: ${id}`)
  lines.push(`      name: '${pkgName}'`)
  lines.push('      config: {}')
  return `${lines.join('\n')}\n`
}

/** 从 detection 里取根目录文件名单（小写）。 */
function rootNameSet(detection) {
  const names = Array.isArray(detection?.rootNames) ? detection.rootNames : []
  return new Set(names.map((name) => String(name).toLowerCase()))
}

/**
 * 判断这个仓库能不能自动补标记。
 * 只有「根目录 package.json + src/plugin.js（或 main 指向 plugin.js）」才动手。
 * @returns { ok, reason, pkg, id, needsMain, needsMarkerFile, needsDshField }
 */
export function planMarkers({ detection }) {
  const rootNames = rootNameSet(detection)
  const pkg = parsePackageJson(detection?.pkgText)
  if (pkg === null) {
    return { ok: false, reason: 'package.json 解析失败或不存在，无法安全地补标记', pkg: null }
  }
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    return { ok: false, reason: 'package.json 没有 name，无法判断包名', pkg }
  }
  const main = typeof pkg.main === 'string' ? pkg.main : ''
  // 只认明确的插件入口：plugin.js、src/ 下的入口，或「有 src/ 但没写 main」。
  const mainLooksLikePlugin = /(^|\/)plugin\.js$/i.test(main) || /^src\//i.test(main)
  if (!mainLooksLikePlugin && !(main === '' && rootNames.has('src'))) {
    return { ok: false, reason: '看起来不是 DSH 插件（没有 main=plugin.js / src 入口）', pkg }
  }
  const hasPatch = pkg.dsh !== null && typeof pkg.dsh === 'object' && typeof pkg.dsh?.bundle?.patch === 'string'
  return {
    ok: true,
    reason: null,
    pkg,
    id: markerId(pkg.name),
    needsMain: main === '' && rootNames.has('src'),
    needsMarkerFile: !rootNames.has(MARKER_FILE.toLowerCase()),
    needsDshField: !hasPatch,
  }
}

/**
 * 补标记（幂等）。仓库已经写好标记时什么都不做。
 * @param options - { github, repo, detection, settings, log }
 * @returns { changed, planned, files, reason, pkg }
 */
export async function ensureMarkers({ github, repo, detection, settings, log = () => {} }) {
  const plan = planMarkers({ detection })
  if (!plan.ok) return { changed: false, planned: false, files: [], reason: plan.reason, pkg: plan.pkg }

  const { pkg } = plan
  const nextPkg = { ...pkg }
  const files = []

  if (plan.needsMain) {
    // 根目录有 src/ 但没写 main：只有确实存在 src/plugin.js 才补，避免猜错入口。
    let items = []
    try {
      items = await github.rootItems(repo.full_name, 'src')
    } catch {
      items = []
    }
    const hasPlugin = Array.isArray(items) && items.some((item) => item?.type === 'file' && /^plugin\.js$/i.test(item.name))
    if (!hasPlugin) {
      return { changed: false, planned: false, files: [], reason: 'package.json 没有 main，src/ 下也没有 plugin.js', pkg }
    }
    nextPkg.main = 'src/plugin.js'
    files.push('package.json')
  }

  const existingDsh = pkg.dsh !== null && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? pkg.dsh : {}
  if (plan.needsDshField) {
    nextPkg.dsh = {
      ...existingDsh,
      bundle: { ...(existingDsh.bundle ?? {}), patch: './cordis.patch.yml' },
    }
    if (!files.includes('package.json')) files.push('package.json')
  }

  const patchYaml = plan.needsMarkerFile
    ? buildPatchYaml({ pkgName: pkg.name, id: plan.id, description: typeof pkg.description === 'string' ? pkg.description : '' })
    : null
  if (patchYaml !== null) files.push(MARKER_FILE)

  if (files.length === 0) return { changed: false, planned: false, files: [], reason: '标记已经齐全', pkg }

  if (settings.dryRun) {
    return { changed: true, planned: true, files, reason: null, pkg: nextPkg }
  }

  log(`  ~ ${repo.full_name}：补标记（${files.join(' + ')}）`)
  if (files.includes('package.json')) {
    const meta = await github.fileMeta(repo.full_name, 'package.json')
    if (meta === null) throw new Error('读不到 package.json 的 sha，无法更新')
    await github.putFile(repo.full_name, 'package.json', formatPackageJson(nextPkg), {
      message: settings.markerCommitMessage,
      sha: meta.sha,
    })
  }
  if (patchYaml !== null) {
    await github.putFile(repo.full_name, MARKER_FILE, patchYaml, { message: settings.markerCommitMessage })
  }
  return { changed: true, planned: false, files, reason: null, pkg: nextPkg }
}

export { MARKER_FILE }
