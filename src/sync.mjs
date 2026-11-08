// 一次同步：列出自己名下的仓库 → 按名字筛 DSH* → 确认是插件 → 补齐 topic。
//
// 请求预算：列仓库 1 次（≤100 个时）+ 每个仓库读 topic 1 次；只有确实缺 topic 时才 PUT。
// 检测结果按 pushed_at 缓存在 state 里，仓库没变就不再拉 contents/package.json。
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveToken } from './config.mjs'
import { detectRepo } from './detect.mjs'
import { createGithub, GithubError } from './github.mjs'
import { ensureMarkers } from './marker.mjs'
import { loadState, saveState, STATE_VERSION } from './state.mjs'

/** 这个仓库要不要处理；返回跳过原因或 null。 */
export function visibilitySkip(repo, settings) {
  if (repo.private === true && !settings.includePrivate) return '私有仓库（市场只收公开仓库）'
  if (repo.fork === true && !settings.includeForks) return 'fork 仓库'
  if (repo.archived === true && !settings.includeArchived) return '已归档仓库'
  if (!settings.namePattern.test(repo.name)) return `仓库名不匹配 ${settings.namePatternSource}`
  return null
}

function appendAudit(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 跑一次同步。
 * @param options - { settings, deps }
 * @param deps - 可注入 { now, log, github }（测试用）
 * @returns 报告对象；失败抛错由 runner 处理。
 */
export async function runSync({ settings, deps = {} }) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line) => console.log(line))
  const startedAt = now()

  const { token, source } = resolveToken(settings)
  if (token === '') {
    throw new Error(
      '没有 GitHub token。先运行 `node tools/authorize.mjs` 授权（会用已登录的 Edge 现场生成并保存到 secrets.json）。',
    )
  }

  const github =
    deps.github ??
    createGithub({
      token,
      log,
      timeoutMs: settings.timeoutMs,
      retries: settings.retries,
    })

  const { state, error: stateError } = loadState(settings.stateFile)
  if (stateError !== undefined) log(`  ! ${stateError}`)
  if (state.version !== STATE_VERSION) state.version = STATE_VERSION
  if (state.repos === null || typeof state.repos !== 'object') state.repos = {}

  const report = {
    startedAt,
    finishedAt: 0,
    tookMs: 0,
    dryRun: settings.dryRun,
    tokenSource: source,
    scanned: 0,
    matched: 0,
    candidates: 0,
    tagged: [],
    marked: [],
    planned: [],
    already: 0,
    skipped: [],
    errors: [],
    aborted: null,
  }

  log(`[market-sync] 读取仓库列表（token 来源：${source}）…`)
  const repos = await github.listOwnedRepos({ max: settings.maxRepos * 3 })
  report.scanned = repos.length

  const candidates = []
  for (const repo of repos) {
    const skip = visibilitySkip(repo, settings)
    if (skip !== null) continue
    candidates.push(repo)
  }
  report.matched = candidates.length
  log(`[market-sync] 共 ${repos.length} 个仓库，名字匹配 ${candidates.length} 个`)

  for (const repo of candidates) {
    if (settings.maxRepos > 0 && report.candidates >= settings.maxRepos) {
      report.aborted = `已达到 maxRepos=${settings.maxRepos} 上限`
      break
    }
    report.candidates += 1
    const fullName = repo.full_name

    // 1) 是不是插件（可复用上次检测结果；缺标记时按设置自动补）
    let detection = null
    let cacheAllowed = true
    const cached = state.repos[fullName]
    const cacheUsable =
      cached !== undefined &&
      cached.pushedAt === repo.pushed_at &&
      typeof cached.eligible === 'boolean' &&
      (cached.eligible === true || !settings.autoMark || cached.markAttempted === true)

    if (!settings.requireMarkers) {
      detection = { eligible: true, kind: null, evidence: null, reason: null, source: 'skipped', pkgText: null }
    } else if (cacheUsable) {
      detection = cached
    } else {
      try {
        detection = await detectRepo({ github, repo, settings, log })
      } catch (error) {
        if (error?.kind === 'rate-limit' || error?.kind === 'unauthorized') throw error
        report.errors.push({ fullName, message: error?.message ?? String(error) })
        continue
      }
    }

    let markAttempted = cached?.markAttempted === true
    if (detection.eligible !== true && settings.autoMark && settings.requireMarkers) {
      try {
        const marked = await ensureMarkers({ github, repo, detection, settings, log })
        if (marked.changed) {
          report.marked.push({ fullName, files: marked.files, planned: marked.planned })
          appendAudit(settings.auditFile, {
            at: new Date(now()).toISOString(),
            fullName,
            action: marked.planned ? 'mark-planned' : 'marked',
            files: marked.files,
          })
          detection = {
            eligible: true,
            kind: 'cordis',
            evidence: marked.planned ? '将自动补 cordis 标记' : 'package.json 声明 cordis（自动补标记）',
            reason: null,
            source: 'root',
          }
          markAttempted = true
          if (marked.planned) cacheAllowed = false
        } else {
          markAttempted = true
          log(`      ${fullName}：不自动补标记（${marked.reason}）`)
        }
      } catch (error) {
        if (error?.kind === 'rate-limit' || error?.kind === 'unauthorized') throw error
        report.errors.push({ fullName, message: `补标记失败：${error?.message ?? String(error)}` })
        appendAudit(settings.auditFile, {
          at: new Date(now()).toISOString(),
          fullName,
          action: 'mark-error',
          message: error?.message ?? String(error),
        })
        continue
      }
    }

    if (settings.requireMarkers && cacheAllowed) {
      state.repos[fullName] = {
        pushedAt: repo.pushed_at,
        eligible: detection.eligible === true,
        kind: detection.kind ?? null,
        evidence: detection.evidence ?? null,
        source: detection.source ?? 'root',
        reason: detection.reason ?? null,
        markAttempted,
        checkedAt: new Date(now()).toISOString(),
      }
    }
    if (detection.eligible !== true) {
      report.skipped.push({ fullName, reason: detection.reason ?? '不像 DSH 插件' })
      appendAudit(settings.auditFile, {
        at: new Date(now()).toISOString(),
        fullName,
        action: 'skip',
        reason: detection.reason ?? '不像 DSH 插件',
      })
      continue
    }

    // 2) 现有 topic
    let current
    try {
      current = await github.topics(fullName)
    } catch (error) {
      if (error?.kind === 'rate-limit' || error?.kind === 'unauthorized') throw error
      report.errors.push({ fullName, message: error?.message ?? String(error) })
      continue
    }
    const missing = settings.topics.filter((topic) => !current.includes(topic))
    if (missing.length === 0) {
      report.already += 1
      continue
    }

    const next = [...new Set([...current, ...settings.topics])]
    const entry = {
      fullName,
      added: missing,
      kind: detection.kind ?? null,
      evidence: detection.evidence ?? null,
    }
    if (settings.dryRun) {
      report.planned.push(entry)
      appendAudit(settings.auditFile, {
        at: new Date(now()).toISOString(),
        fullName,
        action: 'planned',
        topics: next,
        reason: 'dryRun',
      })
      continue
    }

    try {
      const applied = await github.setTopics(fullName, next)
      report.tagged.push({ ...entry, topics: applied })
      appendAudit(settings.auditFile, {
        at: new Date(now()).toISOString(),
        fullName,
        action: 'tagged',
        topics: applied,
        kind: entry.kind,
        evidence: entry.evidence,
      })
      log(`  + ${fullName}：已加 topic ${missing.join(', ')}`)
    } catch (error) {
      if (error?.kind === 'rate-limit' || error?.kind === 'unauthorized') throw error
      report.errors.push({ fullName, message: error?.message ?? String(error) })
      appendAudit(settings.auditFile, {
        at: new Date(now()).toISOString(),
        fullName,
        action: 'error',
        message: error?.message ?? String(error),
      })
    }
  }

  report.finishedAt = now()
  report.tookMs = report.finishedAt - startedAt
  report.requests = github.requests
  state.lastRunAt = startedAt
  state.lastSummary = {
    scanned: report.scanned,
    matched: report.matched,
    tagged: report.tagged.length,
    marked: report.marked.length,
    already: report.already,
    skipped: report.skipped.length,
    errors: report.errors.length,
    dryRun: report.dryRun,
    aborted: report.aborted ?? null,
  }
  try {
    saveState(settings.stateFile, state)
  } catch (error) {
    log(`  ! 状态文件写入失败：${error?.message ?? error}`)
  }
  appendAudit(settings.auditFile, {
    at: new Date(report.finishedAt).toISOString(),
    action: 'run',
    summary: state.lastSummary,
    requests: github.requests,
    aborted: report.aborted ?? null,
  })

  log(
    `[market-sync] 完成：新增 ${report.tagged.length}` +
      (report.dryRun ? `（dryRun 计划 ${report.planned.length}）` : '') +
      `，补标记 ${report.marked.length}，已就绪 ${report.already}，跳过 ${report.skipped.length}，失败 ${report.errors.length}` +
      (report.aborted === null ? '' : `（${report.aborted}）`),
  )
  return report
}

export { GithubError }
