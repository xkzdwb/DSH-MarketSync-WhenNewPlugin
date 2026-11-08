// 拉起 / 复用带调试端口的 Edge。
// 用独立 user-data-dir，避免动到用户日常浏览器；这个目录里已有 GitHub 登录态。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchVersion } from './cdp.mjs'

export const DEFAULT_PORT = 9555

export function defaultUserDataDir() {
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Local', 'dsh-web-deepseek', 'profile')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dsh-web-deepseek', 'profile')
  return join(homedir(), '.local', 'share', 'dsh-web-deepseek', 'profile')
}

/** 找 Edge / Chrome 可执行文件。 */
export function resolveExecutable(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ]
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium']
  for (const path of candidates) if (existsSync(path)) return path
  throw new Error('找不到 Edge / Chrome，请用 --executable 指定浏览器路径')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 确保调试端口可用：已在跑就直接用，否则 launch 一个新实例。
 * @returns { port, launched, executable, userDataDir }
 */
export async function ensureBrowser({ port = DEFAULT_PORT, userDataDir, executable, headless = false } = {}) {
  const already = await fetchVersion(port)
  if (already !== null) return { port, launched: false, executable: null, userDataDir: userDataDir ?? null }

  const exe = resolveExecutable(executable)
  const dir = userDataDir ?? defaultUserDataDir()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    ...(headless ? ['--headless=new'] : []),
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await sleep(500)
    if ((await fetchVersion(port)) !== null) return { port, launched: true, executable: exe, userDataDir: dir }
  }
  throw new Error(
    `浏览器 25 秒内没打开调试端口 ${port}。\n` +
      `常见原因：这个 user-data-dir 已被别的 Edge 窗口占用（用同一个 profile 启动不会带调试口）。\n` +
      `处理：关掉所有用 ${dir} 的 Edge 窗口后重试，或用 --profile 指定别的目录。`,
  )
}
