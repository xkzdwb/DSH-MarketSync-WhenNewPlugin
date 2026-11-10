#!/usr/bin/env node
// 命令行跑一次同步（调试/手动补跑用，DSH 插件本身不依赖它）。
//
//   node tools/sync-once.mjs --dry-run     # 只报告会打哪些 topic
//   node tools/sync-once.mjs               # 真的改 topic
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from '../src/config.mjs'
import { runSync } from '../src/sync.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function parseArgs(argv) {
  const out = { config: {}, configFile: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} 缺少值`)
      return argv[i]
    }
    if (arg === '--dry-run') out.config.dryRun = true
    else if (arg === '--no-dry-run') out.config.dryRun = false
    else if (arg === '--config') out.configFile = next()
    else if (arg === '--secrets') out.config.secretsFile = next()
    else if (arg === '--state') out.config.stateFile = next()
    else if (arg === '--audit') out.config.auditFile = next()
    else if (arg === '--max-repos') out.config.maxRepos = Number(next())
    else if (arg === '--topics') out.config.topics = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--include-private') out.config.includePrivate = true
    else if (arg === '--no-markers') out.config.requireMarkers = false
    else if (arg === '--no-auto-mark') out.config.autoMark = false
    else if (arg === '--no-submit') out.config.submitMissing = false
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`不认识的参数：${arg}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node tools/sync-once.mjs [--dry-run] [--config file.json] [--secrets 路径] [--state 路径]')
    return
  }
  let raw = { ...args.config }
  if (args.configFile !== '') {
    const file = isAbsolute(args.configFile) ? args.configFile : resolve(process.cwd(), args.configFile)
    raw = { ...raw, ...JSON.parse(readFileSync(file, 'utf8')) }
  }
  const settings = readSettings(raw, { pluginRoot: root })
  settings.dryRun = args.config.dryRun === undefined ? settings.dryRun : args.config.dryRun
  const report = await runSync({ settings, deps: { log: (line) => console.log(line) } })
  console.log(
    JSON.stringify(
      {
        结束: new Date(report.finishedAt).toISOString(),
        耗时秒: Math.round(report.tookMs / 100) / 10,
        扫描仓库: report.scanned,
        名字匹配: report.matched,
        新增topic: report.tagged.map((item) => item.fullName),
        补标记: report.marked.map((item) => `${item.fullName}（${item.files.join(' + ')}${item.planned ? '，计划' : ''}）`),
        计划: report.planned.map((item) => item.fullName),
        已就绪: report.already,
        市场索引: report.index,
        投稿: report.submitted,
        投稿跳过: report.submitSkipped,
        跳过: report.skipped,
        失败: report.errors,
        请求数: report.requests,
        中止: report.aborted,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(`✗ ${error?.message ?? error}`)
  process.exitCode = 1
})
