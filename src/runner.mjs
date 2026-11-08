// 调度器：每天 HH:MM 跑一次 sync；DSH 当时没开就下次启动补跑；失败按退避重试。
//
// 判定「该跑了」只看一条：某个 00:00 之后还没成功跑过。这样重启、休眠、关机再开
// 都能自然补上，不需要额外记「上次该跑没跑」。
import { MINUTE_MS, describeDaily, formatInZone, nextDaily, previousDaily } from './schedule.mjs'
import { loadState } from './state.mjs'
import { runSync } from './sync.mjs'

const RETRY_MIN_MS = 10 * MINUTE_MS
const MAX_RETRIES = 5
const MAX_RETRY_WAIT_MS = 6 * 60 * MINUTE_MS

function summarize(report) {
  return {
    scanned: report.scanned,
    matched: report.matched,
    tagged: report.tagged.length,
    planned: report.planned.length,
    already: report.already,
    skipped: report.skipped.length,
    errors: report.errors.length,
    aborted: report.aborted ?? null,
  }
}

/**
 * 建调度器。
 * @param options - { settings, deps }
 * @param deps - 可注入 { now, log, sync }
 */
export function createRunner({ settings, deps = {} }) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line) => console.log(line))
  const sync = deps.sync ?? runSync
  const schedule = { hour: settings.hour, minute: settings.minute, timeZone: settings.timeZone }

  let timer = null
  let busy = false
  let stopped = false
  let lastSuccessAt = 0
  let lastAttemptAt = 0
  let lastError = null
  let lastSummary = null
  let retryAt = 0
  let retryAttempts = 0
  let gaveUpSlot = 0

  function graceMs() {
    return Math.max(5 * MINUTE_MS, settings.tickIntervalMs * 2)
  }

  /** 该跑了就返回原因，否则 null。 */
  function dueNow(at) {
    const slot = previousDaily(at, schedule)
    if (gaveUpSlot === slot) return null
    if (lastSuccessAt >= slot) return null
    if (retryAt > at) return null
    if (!settings.catchUp && at - slot > graceMs()) return null
    return { slot, reason: lastSuccessAt === 0 ? '首次运行' : '补跑' }
  }

  async function tick() {
    if (busy || stopped) return
    const at = now()
    const due = dueNow(at)
    if (due === null) return
    busy = true
    lastAttemptAt = at
    try {
      log(`[market-sync] 开始同步（${due.reason}，${formatInZone(at, settings.timeZone, { seconds: true })}）`)
      const report = await sync({ settings, deps: { now, log } })
      lastSuccessAt = at
      lastSummary = summarize(report)
      lastError = null
      retryAt = 0
      retryAttempts = 0
    } catch (error) {
      retryAttempts += 1
      lastError = error?.message ?? String(error)
      lastSummary = null
      const waitMs =
        error?.kind === 'rate-limit' && Number(error.resetAt) > 0
          ? Math.max(MINUTE_MS, Number(error.resetAt) - now())
          : RETRY_MIN_MS * retryAttempts
      retryAt = now() + Math.min(waitMs, MAX_RETRY_WAIT_MS)
      log(`[market-sync] 同步失败（第 ${retryAttempts} 次）：${lastError}`)
      if (retryAttempts >= MAX_RETRIES) {
        gaveUpSlot = due.slot
        log(`[market-sync] 连续失败 ${retryAttempts} 次，今天不再重试；下一个 00:00 再试。`)
      } else {
        log(`[market-sync] ${Math.round((retryAt - now()) / MINUTE_MS)} 分钟后重试`)
      }
    } finally {
      busy = false
    }
  }

  function start() {
    if (timer !== null) return
    const { state } = loadState(settings.stateFile)
    if (typeof state.lastRunAt === 'number' && state.lastRunAt > 0) lastSuccessAt = state.lastRunAt
    if (state.lastSummary !== undefined) lastSummary = state.lastSummary
    stopped = false
    log(`[market-sync] 计划：${describeDaily(schedule)}；状态文件 ${settings.stateFile}`)
    timer = setInterval(() => {
      void tick()
    }, settings.tickIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    void tick()
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function status() {
    const at = now()
    const next = nextDaily(at, schedule)
    const slot = previousDaily(at, schedule)
    return {
      plugin: 'market-sync',
      schedule: describeDaily(schedule),
      timeZone: settings.timeZone,
      time: settings.time,
      catchUp: settings.catchUp,
      dryRun: settings.dryRun,
      topics: settings.topics,
      namePattern: settings.namePatternSource,
      running: busy,
      started: timer !== null,
      nowLocal: formatInZone(at, settings.timeZone, { seconds: true }),
      nextRunAt: next,
      nextRunLocal: formatInZone(next, settings.timeZone),
      currentSlotLocal: formatInZone(slot, settings.timeZone),
      lastAttemptAt: lastAttemptAt || null,
      lastAttemptLocal: lastAttemptAt === 0 ? null : formatInZone(lastAttemptAt, settings.timeZone, { seconds: true }),
      lastSuccessLocal: lastSuccessAt === 0 ? null : formatInZone(lastSuccessAt, settings.timeZone, { seconds: true }),
      lastError,
      lastSummary,
      retryAttempts,
      retryAtLocal: retryAt === 0 || retryAt <= at ? null : formatInZone(retryAt, settings.timeZone, { seconds: true }),
      gaveUpToday: gaveUpSlot === slot,
    }
  }

  /** 供测试/CLI 直接触发一次，不经过定时判定。 */
  async function runNow(reason = '手动触发') {
    if (busy) return { skipped: '正在运行' }
    const at = now()
    const due = { slot: previousDaily(at, schedule), reason }
    busy = true
    lastAttemptAt = at
    try {
      const report = await sync({ settings, deps: { now, log } })
      lastSuccessAt = at
      lastSummary = summarize(report)
      lastError = null
      retryAt = 0
      retryAttempts = 0
      return report
    } catch (error) {
      lastError = error?.message ?? String(error)
      lastSummary = null
      throw error
    } finally {
      busy = false
      void due
    }
  }

  return { start, stop, tick, status, runNow }
}
