// DSH 插件入口：跟着 HOST 进程跑，提供 /plugin-market-sync/status 状态页。
//
// 这里的 apply 必须够小心：配置错、token 缺都只警告，不让 HOST 起不来。
import { readSettings } from './config.mjs'
import { createRunner } from './runner.mjs'
import { describeDaily } from './schedule.mjs'

const name = 'market-sync'
const inject = ['webServer']

function sendJson(res, status, payload, { head = false } = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(head ? undefined : body)
}

function apply(ctx, rawConfig) {
  let settings
  try {
    settings = readSettings(rawConfig, { pluginRoot: import.meta.dirname ? `${import.meta.dirname}/..` : process.cwd() })
  } catch (error) {
    console.warn(`[market-sync] 配置无效，插件未启动：${error?.message ?? error}`)
    return
  }

  const log = (line) => console.log(line)
  const runner = createRunner({ settings, deps: { log } })

  ctx.effect(() => {
    runner.start()
    return () => runner.stop()
  }, 'market-sync.schedule')

  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-market-sync/status',
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const status = runner.status()
        sendJson(
          res,
          200,
          {
            ...status,
            autoMark: settings.autoMark,
            submitMissing: settings.submitMissing,
            marketRepo: settings.marketRepo,
            maxIssuesPerRun: settings.maxIssuesPerRun,
          },
          { head: req.method === 'HEAD' },
        )
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
    },
  })

  console.log(
    `[market-sync] 已装载：${describeDaily(settings)} 把 GitHub 上匹配 ${settings.namePatternSource} 的插件标为 ` +
      `${settings.topics.join('、')}${settings.dryRun ? '（dryRun，只报告不改动）' : ''}`,
  )
}

export { apply, inject, name }
