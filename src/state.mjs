// 状态文件：上次跑批的时间、每个仓库的检测缓存、最近一次摘要。
// 检测缓存按 pushed_at 失效——仓库没变就不重复拉 contents/package.json。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const STATE_VERSION = 1

/** 读状态；文件不存在或损坏都返回空状态，不让插件起不来。 */
export function loadState(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: {} }
    return { state: {}, error: `读取状态文件失败（${file}）：${error?.message ?? error}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: {}, error: `状态文件不是 JSON 对象（${file}）` }
    }
    return { state: parsed }
  } catch (error) {
    return { state: {}, error: `状态文件损坏（${file}）：${error?.message ?? error}` }
  }
}

/** 写状态：先写临时文件再改名，进程被杀也不会留下半截 JSON。 */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
