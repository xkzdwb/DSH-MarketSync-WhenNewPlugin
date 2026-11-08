// 每日固定时刻的定时计算：按配置里的 IANA 时区算「下一次/上一次 HH:MM」。
// 不用 Date#getHours 之类，是因为 HOST 进程的本地时区由系统决定，而这里必须跟配置走。
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** 某个瞬间在该时区的 UTC 偏移（毫秒）：localWall = instant + offset。 */
export function zoneOffsetMs(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = {}
  for (const part of formatter.formatToParts(new Date(instant))) parts[part.type] = part.value
  // hour 在 24:00 这种边缘会返回 "24"，取模归零。
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return wall - Math.floor(instant / 1000) * 1000
}

/** 瞬间 → 该时区的墙上时间字段（month 是 1–12，weekday 0=周日）。 */
export function wallClockOf(instant, timeZone) {
  const offset = zoneOffsetMs(instant, timeZone)
  const wall = new Date(instant + offset)
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    weekday: wall.getUTCDay(),
    offset,
  }
}

/** 墙上时间（年月日时分）→ 瞬间。偏移量迭代两次，足以覆盖夏令时切换。 */
export function instantFromWall({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0)
  let offset = zoneOffsetMs(wall, timeZone)
  let instant = wall - offset
  const again = zoneOffsetMs(instant, timeZone)
  if (again !== offset) instant = wall - again
  return instant
}

function slotOfToday(local, hour, minute, dayShift = 0) {
  return Date.UTC(local.year, local.month - 1, local.day, hour, minute, 0) + dayShift * DAY_MS
}

function instantFromWallMs(wallMs, timeZone) {
  const date = new Date(wallMs)
  return instantFromWall(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    },
    timeZone,
  )
}

/**
 * 严格晚于 now 的下一个「每天 HH:MM」时刻。
 * @param now - 当前时刻（毫秒）。
 * @param options - { hour, minute, timeZone }
 * @returns 下一次触发的毫秒时间戳。
 */
export function nextDaily(now, { hour, minute, timeZone }) {
  const local = wallClockOf(now, timeZone)
  let wall = slotOfToday(local, hour, minute)
  let instant = instantFromWallMs(wall, timeZone)
  if (instant <= now) {
    wall += DAY_MS
    instant = instantFromWallMs(wall, timeZone)
  }
  return instant
}

/** 不晚于 now 的最近一个「每天 HH:MM」时刻。 */
export function previousDaily(now, { hour, minute, timeZone }) {
  const local = wallClockOf(now, timeZone)
  let wall = slotOfToday(local, hour, minute)
  let instant = instantFromWallMs(wall, timeZone)
  if (instant > now) {
    wall -= DAY_MS
    instant = instantFromWallMs(wall, timeZone)
  }
  return instant
}

/** "2026-11-09 00:00" 这种可读写法（按配置时区）。 */
export function formatInZone(instant, timeZone, { seconds = false } = {}) {
  const local = wallClockOf(instant, timeZone)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${local.year}-${pad(local.month)}-${pad(local.day)} ` +
    `${pad(local.hour)}:${pad(local.minute)}` +
    (seconds ? `:${pad(local.second)}` : '')
  )
}

/** 配置里的时刻写成一句人话，日志里用。 */
export function describeDaily({ hour, minute, timeZone }) {
  const pad = (n) => String(n).padStart(2, '0')
  return `每天 ${pad(hour)}:${pad(minute)}（${timeZone}）`
}

/** 两个时刻之间的天数（按墙上日期算，用于「补跑窗口」判断）。 */
export function daysBetween(from, to, timeZone) {
  const a = wallClockOf(from, timeZone)
  const b = wallClockOf(to, timeZone)
  const dayA = Date.UTC(a.year, a.month - 1, a.day)
  const dayB = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((dayB - dayA) / DAY_MS)
}

export { MINUTE_MS, DAY_MS }
