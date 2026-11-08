#!/usr/bin/env node
// 一次性授权：用已登录 GitHub 的 Edge 现场生成一个 classic token，存进 secrets.json。
//
// 为什么走浏览器而不是让用户手填 PAT：
//   - 用户不需要理解 scope、复制粘贴；
//   - token 只落在本机 secrets.json（不进 yml、不进会话）；
//   - 以后要换 token 再跑一次即可，插件每分钟都会重读 secrets.json。
//
// 用法：
//   node tools/authorize.mjs                 # 打开浏览器、生成、保存、验证
//   node tools/authorize.mjs --check         # 只验证已有 token
//   node tools/authorize.mjs --keep-open     # 生成后不关页面
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, closePage, newPage } from './cdp.mjs'
import { DEFAULT_PORT, defaultUserDataDir, ensureBrowser } from './browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function parseArgs(argv) {
  const out = {
    port: DEFAULT_PORT,
    profile: defaultUserDataDir(),
    executable: '',
    tokenName: 'dsh-market-sync',
    scopes: ['repo', 'workflow'],
    secrets: resolve(root, 'secrets.json'),
    timeoutSec: 300,
    check: false,
    keepOpen: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} 缺少值`)
      return argv[i]
    }
    if (arg === '--check') out.check = true
    else if (arg === '--keep-open') out.keepOpen = true
    else if (arg === '--port') out.port = Number(next())
    else if (arg === '--profile') out.profile = next()
    else if (arg === '--executable') out.executable = next()
    else if (arg === '--token-name') out.tokenName = next()
    else if (arg === '--scopes') out.scopes = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--secrets') out.secrets = next()
    else if (arg === '--timeout') out.timeoutSec = Number(next())
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`不认识的参数：${arg}`)
  }
  if (!isAbsolute(out.secrets)) out.secrets = resolve(process.cwd(), out.secrets)
  return out
}

function readSecretsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}

function saveToken(file, token, tokenName) {
  const data = readSecretsFile(file)
  data.githubToken = token
  data.tokenName = tokenName
  data.updatedAt = new Date().toISOString()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作。
  }
}

async function verify(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-market-sync',
    },
    signal: AbortSignal.timeout(15000),
  })
  const scopes = response.headers.get('x-oauth-scopes') ?? ''
  if (!response.ok) throw new Error(`token 验证失败（HTTP ${response.status}）`)
  const user = await response.json()
  return { login: user.login, scopes }
}

function sleep(ms) {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, ms))
}

const FILL_FORM = (description) => `(() => {
  const desc = document.querySelector('#oauth_access_description')
  if (desc) {
    desc.focus()
    desc.value = ${JSON.stringify(description)}
    desc.dispatchEvent(new Event('input', { bubbles: true }))
    desc.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const buttons = [...document.querySelectorAll('button, input[type="submit"]')]
  const button = buttons.find((el) => /generate token/i.test((el.innerText || el.value || '').trim()))
  if (button) button.click()
  return {
    url: location.href,
    description: !!desc,
    clicked: !!button,
    title: document.title,
    bodyStart: document.body ? document.body.innerText.slice(0, 300) : '',
  }
})()`

const TOKEN_RE = /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})/
const STATE_JS =
  '({ href: location.href, ready: document.readyState, text: document.body ? document.body.innerText : "" })'

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'))
    return
  }

  if (options.check) {
    const existing = readSecretsFile(options.secrets).githubToken
    if (typeof existing !== 'string' || existing === '') throw new Error(`没有 token：${options.secrets}`)
    const info = await verify(existing)
    console.log(`✓ token 有效：${info.login}${info.scopes === '' ? '' : `（scope：${info.scopes}）`}`)
    return
  }

  const browser = await ensureBrowser({
    port: options.port,
    userDataDir: options.profile,
    executable: options.executable,
  })
  console.log(`浏览器：${browser.launched ? '新启动' : '复用已开的'}（端口 ${options.port}）`)

  const url =
    'https://github.com/settings/tokens/new?' +
    new URLSearchParams({ scopes: options.scopes.join(','), description: options.tokenName }).toString()
  const target = await newPage(options.port, url)
  const page = await Cdp.connect(target.webSocketDebuggerUrl)
  const pageId = target.id

  try {
    const deadline = Date.now() + options.timeoutSec * 1000
    let token = null
    let clickedAt = ''
    let notifiedSudo = false
    let lastHint = ''

    while (Date.now() < deadline) {
      let state
      try {
        state = await page.evaluate(STATE_JS)
      } catch {
        // 页面正在导航，执行上下文暂时不可用，等下一轮。
        await sleep(1500)
        continue
      }
      const href = String(state?.href ?? '')
      const text = String(state?.text ?? '')

      const found = TOKEN_RE.exec(text)
      if (found !== null) {
        token = found[1]
        break
      }
      if (href.includes('/login')) {
        throw new Error('浏览器里没有登录 GitHub：请在这个 Edge 窗口里登录一次，然后重跑本脚本。')
      }
      if (/Confirm access|sudo mode/i.test(text)) {
        if (!notifiedSudo) {
          notifiedSudo = true
          console.log('⚠ GitHub 要求重新确认身份（sudo）：请在刚打开的浏览器窗口里输入密码并点 Confirm，脚本会继续等。')
        }
        await sleep(2000)
        continue
      }
      // 点过生成后 GitHub 会跳到带 token 的页面；同一个 URL 不重复点。
      if (href.includes('/settings/tokens') && text.includes('Generate token') && clickedAt !== href) {
        try {
          const filled = await page.evaluate(FILL_FORM(options.tokenName))
          clickedAt = href
          if (filled?.clicked === true) console.log('已填写描述并点击「Generate token」，等待 token 出现…')
          else console.log('页面已就绪，但没找到「Generate token」按钮，继续等待…')
        } catch {
          // 点的时候页面刚好重载，下一轮再来。
        }
      } else if (text.length > 0) {
        const hint = href.includes('github.com') ? `当前页面：${href}` : ''
        if (hint !== '' && hint !== lastHint) {
          lastHint = hint
          console.log(hint)
        }
      }
      await sleep(2000)
    }
    if (token === null) {
      throw new Error(
        `等了 ${options.timeoutSec} 秒还没拿到 token。` +
          '若浏览器停在 Confirm access，请在窗口里完成确认（必要时重跑）；若停在登录页，请先登录。',
      )
    }

    const info = await verify(token)
    saveToken(options.secrets, token, options.tokenName)
    console.log(`✓ 已保存到 ${options.secrets}`)
    console.log(`  账号：${info.login}${info.scopes === '' ? '' : `；scope：${info.scopes}`}`)
    console.log(`  token：${token.slice(0, 4)}…${token.slice(-4)}`)
    console.log('  插件下个 tick 就会用上它，不用重启 DSH。')
  } finally {
    page.close()
    if (!options.keepOpen) await closePage(options.port, pageId)
  }
}

main().catch((error) => {
  console.error(`✗ ${error?.message ?? error}`)
  process.exitCode = 1
})
