// 读市场索引：拿到「市场现在认识哪些仓库」，用来判断某个仓库是否真的漏收。
//
// 索引 plugins-lite.json 约 17 MB（gzip 后 4 MB），每天 06:00 由采集器重发一次；
// 只取 fullName 集合，不解析其余字段，内存占用可控。
const INDEX_TIMEOUT_MS = 90_000

/**
 * 拉一次市场索引。
 * @param url - plugins-lite.json 的地址
 * @returns { generatedAt, generatedAtMs, count, fullNames }
 * @throws 网络/HTTP/JSON 错误（调用方决定是否吞掉）
 */
export async function fetchIndex(url, { fetchImpl = globalThis.fetch, timeoutMs = INDEX_TIMEOUT_MS } = {}) {
  const sep = url.includes('?') ? '&' : '?'
  const target = `${url}${sep}v=${Date.now()}`
  const response = await fetchImpl(target, {
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-market-sync' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`市场索引读取失败：HTTP ${response.status}`)
  const data = await response.json()
  const list = Array.isArray(data?.plugins) ? data.plugins : []
  const fullNames = new Set()
  for (const entry of list) {
    if (typeof entry?.fullName === 'string' && entry.fullName !== '') {
      fullNames.add(entry.fullName.toLowerCase())
    }
  }
  const generatedAt = typeof data?.generatedAt === 'string' ? data.generatedAt : ''
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : 0
  return { generatedAt, generatedAtMs, count: fullNames.size, fullNames }
}
