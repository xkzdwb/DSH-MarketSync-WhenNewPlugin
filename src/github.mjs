// GitHub REST 封装：只包这个插件真正用到的几个端点，统一处理重试、限流和报错。
// 目标是最少请求：列仓库 1–2 次、每个仓库「读 topic」1 次，只有缺 topic 时才 PUT。
const API = 'https://api.github.com'
const USER_AGENT = 'dsh-market-sync'

export class GithubError extends Error {
  constructor(message, { status = 0, path = '', data = null, kind = 'http' } = {}) {
    super(message)
    this.name = 'GithubError'
    this.status = status
    this.path = path
    this.data = data
    this.kind = kind
  }
}

export class RateLimitError extends GithubError {
  constructor(message, { resetAt = 0, ...rest } = {}) {
    super(message, { ...rest, kind: 'rate-limit' })
    this.name = 'RateLimitError'
    this.resetAt = resetAt
  }
}

export class UnauthorizedError extends GithubError {
  constructor(message, rest = {}) {
    super(message, { ...rest, kind: 'unauthorized' })
    this.name = 'UnauthorizedError'
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function describe(data) {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data.slice(0, 300)
  if (typeof data.message === 'string') return data.message
  try {
    return JSON.stringify(data).slice(0, 300)
  } catch {
    return String(data)
  }
}

/**
 * 建一个 GitHub 客户端。
 * @param options - { token, fetchImpl, timeoutMs, retries, baseDelayMs, log, userAgent }
 */
export function createGithub({
  token = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  retries = 3,
  baseDelayMs = 1500,
  log = () => {},
  userAgent = USER_AGENT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch，无法访问 GitHub API')
  let requests = 0

  function headers(hasBody) {
    const out = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
    }
    if (hasBody) out['Content-Type'] = 'application/json'
    if (token !== '') out.Authorization = `Bearer ${token}`
    return out
  }

  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : `${API}${path}`
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1))
      let response
      try {
        response = await fetchImpl(url, {
          method,
          headers: headers(body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        lastError = new GithubError(`请求失败：${method} ${path}：${error?.message ?? error}`, {
          path,
          kind: 'network',
        })
        log(`      ${lastError.message}（第 ${attempt + 1} 次）`)
        continue
      }

      requests += 1
      const text = await response.text().catch(() => '')
      let data = null
      if (text !== '') {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }

      if (response.ok) return data

      const status = response.status
      const remaining = response.headers.get('x-ratelimit-remaining')
      const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000

      if (status === 401) {
        throw new UnauthorizedError(
          `GitHub 拒绝了这个 token（401）：token 无效、已过期或被撤销。重新运行 tools/authorize.mjs 授权。`,
          { status, path, data },
        )
      }
      if ((status === 403 || status === 429) && remaining === '0') {
        const when = resetAt > 0 ? new Date(resetAt).toISOString() : '稍后'
        throw new RateLimitError(`GitHub API 额度用尽（${status}），${when} 恢复`, { status, path, data, resetAt })
      }
      if (status >= 500 && attempt < retries) {
        lastError = new GithubError(`GitHub ${status}：${method} ${path}：${describe(data)}`, { status, path, data })
        log(`      ${lastError.message}（第 ${attempt + 1} 次，将重试）`)
        continue
      }
      throw new GithubError(`GitHub ${status}：${method} ${path}：${describe(data)}`, { status, path, data })
    }
    throw lastError ?? new GithubError(`GitHub 请求失败：${method} ${path}`, { path })
  }

  return {
    tokenPresent: token !== '',
    get requests() {
      return requests
    },
    whoami() {
      return request('GET', '/user')
    },
    rateLimit() {
      return request('GET', '/rate_limit')
    },
    /** 列出当前 token 拥有的仓库（按最近推送排序），最多 max 个。 */
    async listOwnedRepos({ max = 500, perPage = 100 } = {}) {
      const out = []
      for (let page = 1; out.length < max; page += 1) {
        const batch = await request(
          'GET',
          `/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=${perPage}&page=${page}`,
        )
        if (!Array.isArray(batch) || batch.length === 0) break
        out.push(...batch)
        if (batch.length < perPage) break
      }
      return out.slice(0, max)
    },
    /** 仓库现有的 topic。 */
    async topics(fullName) {
      const data = await request('GET', `/repos/${fullName}/topics`)
      return Array.isArray(data?.names) ? data.names : []
    },
    /** 覆盖式设置 topic（GitHub 的 PUT 语义），返回新列表。 */
    async setTopics(fullName, names) {
      const data = await request('PUT', `/repos/${fullName}/topics`, { names })
      return Array.isArray(data?.names) ? data.names : names
    },
    /** 列目录（path 为空 = 仓库根）。 */
    rootItems(fullName, path = '') {
      const suffix = path === '' ? '' : `/${path.replace(/^\/+|\/+$/g, '')}`
      return request('GET', `/repos/${fullName}/contents${suffix}`)
    },
    /** 读文件并按 UTF-8 返回；文件不存在返回 null。 */
    async file(fullName, path) {
      try {
        const data = await request('GET', `/repos/${fullName}/contents/${path}`)
        if (typeof data?.content === 'string' && data.encoding === 'base64') {
          return Buffer.from(data.content, 'base64').toString('utf8')
        }
        return null
      } catch (error) {
        if (error?.status === 404) return null
        throw error
      }
    },
    /** 读文件的 { text, sha }（sha 用于更新）；文件不存在返回 null。 */
    async fileMeta(fullName, path) {
      try {
        const data = await request('GET', `/repos/${fullName}/contents/${path}`)
        if (typeof data?.sha !== 'string') return null
        const text =
          typeof data.content === 'string' && data.encoding === 'base64'
            ? Buffer.from(data.content, 'base64').toString('utf8')
            : null
        return { text, sha: data.sha }
      } catch (error) {
        if (error?.status === 404) return null
        throw error
      }
    },
    /**
     * 新建或更新一个文件（Contents API）。
     * @param options - { message, sha, branch }
     */
    async putFile(fullName, path, content, { message, sha, branch } = {}) {
      const body = {
        message: message ?? `update ${path}`,
        content: Buffer.from(String(content), 'utf8').toString('base64'),
      }
      if (sha !== undefined && sha !== null) body.sha = sha
      if (branch !== undefined && branch !== null) body.branch = branch
      const data = await request('PUT', `/repos/${fullName}/contents/${path}`, body)
      return { path: data?.content?.path ?? path, sha: data?.content?.sha ?? null }
    },
    /** 在市场仓库里新建投稿 issue。 */
    createIssue(repo, { title, body }) {
      return request('POST', `/repos/${repo}/issues`, { title, body })
    },
    /** 读单个 issue，用来判断投稿后来是不是被关掉了。 */
    getIssue(repo, number) {
      return request('GET', `/repos/${repo}/issues/${number}`)
    },
    /** 搜索 issue（投稿前查重）。 */
    searchIssues(query, { perPage = 20 } = {}) {
      return request('GET', `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`)
    },
  }
}
