// 投稿：已打 topic 但市场索引里没有的仓库，自动提一个 submission issue。
//
// 为什么需要这层：采集器对 topic 的搜索受 GitHub「最多 1000 条」硬限制，
// 只有靠 stars/updated/created 三路并集尽量覆盖；老仓库就算打了 topic 也可能扫不到。
// issue 是明确意图，采集器会直接读，不受搜索窗口影响。
import { GithubError } from './github.mjs'

const MAX_BODY_CHARS = 4000

export function issueTitle(repo) {
  return `[提交插件] ${repo.name}`
}

export function issueBody({ repo, detection }) {
  const full = repo.full_name
  const description =
    typeof repo.description === 'string' && repo.description.trim() !== ''
      ? repo.description.trim()
      : '（仓库没有填写简介，详见 README）'
  const evidence = detection?.evidence ?? 'cordis 插件标记'
  const lines = [
    '### 仓库地址',
    `https://github.com/${full}`,
    '',
    '### 插件类型',
    'cordis 插件',
    '',
    '### 一句话简介',
    description,
    '',
    '### 作者自述（可选）',
    `由 dsh-market-sync 自动提交：仓库已打 dsh-plugin topic，本地检测判据为「${evidence}」，`,
    '但连续多个索引周期都没有出现在市场数据里，因此按投稿流程补一条记录。',
    '',
    '### 是否已打 topic',
    '是（dsh-plugin）',
    '',
  ]
  return lines.join('\n').slice(0, MAX_BODY_CHARS)
}

function normalize(text) {
  return String(text ?? '').toLowerCase()
}

/**
 * 判断并（必要时）提交一个仓库。
 * @returns { status, issueNumber?, url?, reason? }
 *   status ∈ disabled | no-index | indexed | too-new | dry-run | existing | closed | created | error
 */
export async function ensureSubmission({
  github,
  repo,
  detection,
  settings,
  index,
  state,
  log = () => {},
  now = Date.now,
  dryRun = false,
}) {
  if (!settings.submitMissing) return { status: 'disabled' }
  if (index === null || index === undefined) return { status: 'no-index' }

  const fullName = repo.full_name
  const key = fullName.toLowerCase()

  if (index.fullNames.has(key)) return { status: 'indexed' }

  // 索引比仓库最后一次更新还旧 → 这一轮本来就看不到它，别急着投稿
  const updatedMs = Date.parse(repo.updated_at ?? repo.pushed_at ?? '')
  if (index.generatedAtMs > 0 && Number.isFinite(updatedMs) && updatedMs > index.generatedAtMs) {
    return { status: 'too-new', reason: `索引 ${index.generatedAt} 早于仓库更新 ${repo.updated_at}` }
  }

  if (state.submissions === null || typeof state.submissions !== 'object') state.submissions = {}
  const recorded = state.submissions[key]
  if (recorded !== undefined && typeof recorded.issueNumber === 'number') {
    if (recorded.state === 'open') return { status: 'existing', issueNumber: recorded.issueNumber, url: recorded.url }
    if (recorded.state === 'closed') return { status: 'closed', issueNumber: recorded.issueNumber, url: recorded.url }
    try {
      const issue = await github.getIssue(settings.marketRepo, recorded.issueNumber)
      const nextState = issue?.state === 'closed' ? 'closed' : 'open'
      state.submissions[key] = { ...recorded, state: nextState, checkedAt: new Date(now()).toISOString() }
      return {
        status: nextState === 'closed' ? 'closed' : 'existing',
        issueNumber: recorded.issueNumber,
        url: recorded.url,
      }
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) {
        delete state.submissions[key]
      } else {
        throw error
      }
    }
  }

  if (dryRun) {
    return { status: 'dry-run', reason: `会提交 ${issueTitle(repo)}（索引 ${index.generatedAt}）` }
  }

  // 看看市场里有没有别人已经提过（人工提的或上一次跑挂了没记 state）
  try {
    const found = await github.searchIssues(
      `repo:${settings.marketRepo} is:issue "${fullName}" in:body`,
    )
    const hit = (found?.items ?? []).find((item) => normalize(item?.body).includes(key))
    if (hit !== undefined) {
      state.submissions[key] = {
        issueNumber: hit.number,
        url: hit.html_url,
        state: hit.state === 'closed' ? 'closed' : 'open',
        at: new Date(now()).toISOString(),
      }
      return { status: 'existing', issueNumber: hit.number, url: hit.html_url }
    }
  } catch (error) {
    // 搜索接口偶发 422/限流时不阻塞投稿；创建接口自己会去重失败
    if (error?.kind === 'rate-limit' || error?.kind === 'unauthorized') throw error
    log(`      投稿前搜索失败（忽略）：${error?.message ?? error}`)
  }

  const issue = await github.createIssue(settings.marketRepo, {
    title: issueTitle(repo),
    body: issueBody({ repo, detection }),
  })
  state.submissions[key] = {
    issueNumber: issue?.number ?? null,
    url: issue?.html_url ?? null,
    state: 'open',
    at: new Date(now()).toISOString(),
    indexGeneratedAt: index.generatedAt,
  }
  return { status: 'created', issueNumber: issue?.number ?? null, url: issue?.html_url ?? null }
}
