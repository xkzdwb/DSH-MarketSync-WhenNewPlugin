import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAY_MS,
  MINUTE_MS,
  daysBetween,
  describeDaily,
  formatInZone,
  instantFromWall,
  nextDaily,
  previousDaily,
  wallClockOf,
  zoneOffsetMs,
} from '../src/schedule.mjs'
import {
  maskToken,
  normalizeTopics,
  parseTimeOfDay,
  readSettings,
  resolveToken,
} from '../src/config.mjs'
import { isCordisPackageJson, pickSubdirs, detectLayer, detectRepo } from '../src/detect.mjs'
import { loadState, saveState } from '../src/state.mjs'
import { runSync } from '../src/sync.mjs'
import { buildPatchYaml, planMarkers } from '../src/marker.mjs'
import { createRunner } from '../src/runner.mjs'

const TZ = 'Asia/Shanghai'
const at = (year, month, day, hour, minute) =>
  instantFromWall({ year, month, day, hour, minute }, TZ)
const tmp = () => mkdtempSync(join(tmpdir(), 'market-sync-test-'))

// ---------------------------------------------------------------- schedule

test('schedule：NextDaily 落在下一个 00:00', () => {
  assert.equal(nextDaily(at(2026, 11, 8, 23, 59), { hour: 0, minute: 0, timeZone: TZ }), at(2026, 11, 9, 0, 0))
  // 正好在 00:00 时「下一次」必须是明天，否则同一 slot 会跑两次
  assert.equal(nextDaily(at(2026, 11, 9, 0, 0), { hour: 0, minute: 0, timeZone: TZ }), at(2026, 11, 10, 0, 0))
  assert.equal(nextDaily(at(2026, 11, 9, 0, 1), { hour: 0, minute: 0, timeZone: TZ }), at(2026, 11, 10, 0, 0))
})

test('schedule：PreviousDaily 落在今天/昨天 00:00', () => {
  assert.equal(previousDaily(at(2026, 11, 9, 0, 0), { hour: 0, minute: 0, timeZone: TZ }), at(2026, 11, 9, 0, 0))
  assert.equal(previousDaily(at(2026, 11, 8, 23, 59), { hour: 0, minute: 0, timeZone: TZ }), at(2026, 11, 8, 0, 0))
})

test('schedule：非零点时刻也按配置时区算', () => {
  const options = { hour: 7, minute: 30, timeZone: TZ }
  assert.equal(nextDaily(at(2026, 11, 9, 7, 29), options), at(2026, 11, 9, 7, 30))
  assert.equal(nextDaily(at(2026, 11, 9, 7, 31), options), at(2026, 11, 10, 7, 30))
})

test('schedule：格式化与描述用配置时区，不受进程时区影响', () => {
  assert.equal(formatInZone(at(2026, 11, 9, 0, 0), TZ), '2026-11-09 00:00')
  assert.equal(describeDaily({ hour: 0, minute: 0, timeZone: TZ }), '每天 00:00（Asia/Shanghai）')
  const local = wallClockOf(at(2026, 11, 9, 0, 0), TZ)
  assert.equal(local.hour, 0)
  assert.equal(zoneOffsetMs(at(2026, 11, 9, 0, 0), TZ), 8 * 60 * MINUTE_MS)
})

test('schedule：跨时区、跨夏令时也能往返', () => {
  for (const tz of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin']) {
    for (const [month, day] of [[1, 15], [3, 8], [7, 1], [11, 2]]) {
      const instant = at(2026, month, day, 0, 0)
      const options = { hour: 0, minute: 0, timeZone: tz }
      assertEqualsDayGap(previousDaily(instant, options), instant)
    }
  }
  assert.equal(daysBetween(at(2026, 11, 7, 23, 0), at(2026, 11, 9, 1, 0), TZ), 2)
})

function assertEqualsDayGap(previous, instant) {
  assert.ok(previous <= instant, 'previousDaily 不该晚于 now')
  assert.ok(instant - previous < DAY_MS + MINUTE_MS, 'previousDaily 不该早于 24 小时')
}

// ---------------------------------------------------------------- config

test('config：parseTimeOfDay 严格校验', () => {
  assert.deepEqual(parseTimeOfDay('00:00'), { hour: 0, minute: 0 })
  assert.deepEqual(parseTimeOfDay('7:05'), { hour: 7, minute: 5 })
  assert.throws(() => parseTimeOfDay('24:00'), /超出范围/)
  assert.throws(() => parseTimeOfDay('00:60'), /超出范围/)
  assert.throws(() => parseTimeOfDay('零点'), /HH:MM/)
})

test('config：normalizeTopics 去重、小写、校验字符', () => {
  assert.deepEqual(normalizeTopics('Dsh-Plugin, cordis-plugin,dsh-plugin'), ['dsh-plugin', 'cordis-plugin'])
  assert.deepEqual(normalizeTopics(['dsh-plugin']), ['dsh-plugin'])
  assert.throws(() => normalizeTopics(['bad topic']), /不合法/)
})

test('config：readSettings 归一化路径与正则', () => {
  const dir = tmp()
  const settings = readSettings(
    {
      time: '0:00',
      timeZone: TZ,
      namePattern: '^DSH-',
      topics: 'dsh-plugin',
      stateFile: 'state.json',
      auditFile: 'a/b.jsonl',
      secretsFile: 'secrets.json',
    },
    { pluginRoot: dir },
  )
  assert.equal(settings.time, '00:00')
  assert.equal(settings.namePattern.test('DSH-Foo'), true)
  assert.equal(settings.namePattern.test('xDSH-Foo'), false)
  assert.equal(settings.stateFile, join(dir, 'state.json'))
  assert.equal(settings.auditFile, join(dir, 'a/b.jsonl'))
  assert.throws(() => readSettings({ timeZone: 'Asia/Nowhere' }, { pluginRoot: dir }), /时区/)
  assert.throws(() => readSettings({ time: '25:00' }, { pluginRoot: dir }), /time/)
})

test('config：token 优先级 config > secrets.json > 环境变量', () => {
  const dir = tmp()
  const secrets = join(dir, 'secrets.json')
  writeFileSync(secrets, JSON.stringify({ githubToken: 'ghp_fromfile' }), 'utf8')
  const base = { secretsFile: 'secrets.json' }
  assert.equal(resolveToken(readSettings({ ...base, token: 'ghp_fromconfig' }, { pluginRoot: dir })).source, 'config')

  const previous = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    assert.deepEqual(resolveToken(readSettings(base, { pluginRoot: dir })), { token: 'ghp_fromfile', source: 'secrets' })
    process.env.GITHUB_TOKEN = 'ghp_fromenv'
    const fromEnv = readSettings({ secretsFile: join(dir, 'nope.json') }, { pluginRoot: dir })
    assert.deepEqual(resolveToken(fromEnv), { token: 'ghp_fromenv', source: 'env' })
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
  assert.equal(maskToken('ghp_1234567890abcdef'), 'ghp_…cdef')
  assert.equal(maskToken(''), '')
})

test('state：损坏的状态文件不拖垮插件', () => {
  const dir = tmp()
  const file = join(dir, 'state.json')
  assert.deepEqual(loadState(file), { state: {} })
  writeFileSync(file, '{oops', 'utf8')
  const broken = loadState(file)
  assert.deepEqual(broken.state, {})
  assert.match(broken.error, /损坏/)
  saveState(file, { version: 1, lastRunAt: 123 })
  assert.equal(loadState(file).state.lastRunAt, 123)
})

// ---------------------------------------------------------------- detect

test('detect：package.json 的三种 cordis 判据', () => {
  assert.equal(isCordisPackageJson(JSON.stringify({ dependencies: { cordis: '^3' } })), true)
  assert.equal(isCordisPackageJson(JSON.stringify({ devDependencies: { '@deepseek-ai/dsh-base': '1' } })), true)
  assert.equal(isCordisPackageJson(JSON.stringify({ dsh: { bundle: { patch: './x.yml' } } })), true)
  assert.equal(isCordisPackageJson(JSON.stringify({ dsh: { client: './client.js' } })), true)
  assert.equal(isCordisPackageJson(JSON.stringify({ dependencies: { react: '18' } })), false)
  assert.equal(isCordisPackageJson('not json'), false)
  assert.equal(isCordisPackageJson(''), false)
})

test('detect：pickSubdirs 优先同名，跳过噪音目录', () => {
  const items = [
    { name: 'docs', type: 'dir', path: 'docs' },
    { name: 'packages', type: 'dir', path: 'packages' },
    { name: 'DSH-Web', type: 'dir', path: 'DSH-Web' },
    { name: 'dsh-client', type: 'dir', path: 'dsh-client' },
    { name: 'README.md', type: 'file', path: 'README.md' },
  ]
  const picked = pickSubdirs(items, 'DSH-Web').map((item) => item.path)
  assert.deepEqual(picked.slice(0, 2), ['DSH-Web', 'dsh-client'])
  assert.equal(picked.includes('docs'), false)
})

const fakeGithub = ({ roots = {}, files = {} } = {}) => {
  const calls = { root: 0, file: 0 }
  return {
    calls,
    async rootItems(fullName, path = '') {
      calls.root += 1
      const key = path === '' ? fullName : `${fullName}:${path}`
      if (Object.hasOwn(roots, key)) return roots[key]
      const error = new Error('Not Found')
      error.status = 404
      throw error
    },
    async file(fullName, path) {
      calls.file += 1
      const key = `${fullName}:${path}`
      return Object.hasOwn(files, key) ? files[key] : null
    },
  }
}

test('detect：根目录标记 / skills / package.json', async () => {
  const github = fakeGithub({
    roots: {
      'me/A': [{ name: 'cordis.patch.yml', type: 'file', path: 'cordis.patch.yml' }],
      'me/B': [{ name: 'skills', type: 'dir', path: 'skills' }],
      'me/B:skills': [{ name: 'SKILL.md', type: 'file', path: 'skills/SKILL.md' }],
      'me/C': [{ name: 'package.json', type: 'file', path: 'package.json' }],
      'me/D': [{ name: 'README.md', type: 'file', path: 'README.md' }],
    },
    files: { 'me/C:package.json': JSON.stringify({ dependencies: { cordis: '^3' } }) },
  })
  const settings = { followSubdir: false }
  assert.equal((await detectRepo({ github, repo: { name: 'A', full_name: 'me/A' }, settings })).kind, 'cordis')
  assert.equal((await detectRepo({ github, repo: { name: 'B', full_name: 'me/B' }, settings })).kind, 'skill')
  assert.equal((await detectRepo({ github, repo: { name: 'C', full_name: 'me/C' }, settings })).kind, 'cordis')
  const rejected = await detectRepo({ github, repo: { name: 'D', full_name: 'me/D' }, settings })
  assert.equal(rejected.eligible, false)
  assert.match(rejected.reason, /cordis.patch.yml/)
})

test('detect：根目录不像插件时看一层子目录', async () => {
  const github = fakeGithub({
    roots: {
      'me/Mono': [
        { name: 'README.md', type: 'file', path: 'README.md' },
        { name: 'dsh-market-sync', type: 'dir', path: 'dsh-market-sync' },
      ],
      'me/Mono:dsh-market-sync': [{ name: 'cordis.patch.yml', type: 'file', path: 'dsh-market-sync/cordis.patch.yml' }],
    },
  })
  const found = await detectRepo({
    github,
    repo: { name: 'Mono', full_name: 'me/Mono' },
    settings: { followSubdir: true },
  })
  assert.equal(found.eligible, true)
  assert.match(found.source, /^subdir dsh-market-sync/)
})

test('detect：detectLayer 对 package.json 无 cordis 给出理由', async () => {
  const github = fakeGithub({ files: { 'me/X:package.json': JSON.stringify({ dependencies: { react: '18' } }) } })
  const result = await detectLayer({
    github,
    fullName: 'me/X',
    path: '',
    items: [{ name: 'package.json', type: 'file', path: 'package.json' }],
  })
  assert.equal(result.eligible, false)
  assert.match(result.reason, /cordis/)
})

// ---------------------------------------------------------------- sync

function makeFakeApi(repos) {
  const topicsMap = new Map()
  const calls = { list: 0, topics: 0, put: 0, root: 0, file: 0, write: 0 }
  return {
    calls,
    topicsMap,
    requests: 0,
    async listOwnedRepos() {
      calls.list += 1
      return repos
    },
    async topics(name) {
      calls.topics += 1
      return topicsMap.get(name) ?? []
    },
    async setTopics(name, names) {
      calls.put += 1
      topicsMap.set(name, names)
      return names
    },
    async rootItems(fullName, path = '') {
      calls.root += 1
      const repo = repos.find((item) => item.full_name === fullName)
      if (repo === undefined) throw new Error('unknown repo')
      if (path === '') return repo.__root ?? []
      if (repo.__dirs?.[path] !== undefined) return repo.__dirs[path]
      const error = new Error('no subdir')
      error.status = 404
      throw error
    },
    async file(fullName, path) {
      calls.file += 1
      const repo = repos.find((item) => item.full_name === fullName)
      return repo.__files?.[path] ?? null
    },
    async fileMeta(fullName, path) {
      const repo = repos.find((item) => item.full_name === fullName)
      const text = repo.__files?.[path]
      if (text === undefined) return null
      return { text, sha: `sha-${path}` }
    },
    async putFile(fullName, path, content) {
      calls.write += 1
      const repo = repos.find((item) => item.full_name === fullName)
      repo.__files = { ...(repo.__files ?? {}), [path]: content }
      return { path, sha: `sha-${path}` }
    },
  }
}

function makeRepos() {
  return [
    {
      name: 'DSH-Alpha',
      full_name: 'me/DSH-Alpha',
      private: false,
      fork: false,
      archived: false,
      pushed_at: '2026-11-01T00:00:00Z',
      __root: [{ name: 'cordis.patch.yml', type: 'file', path: 'cordis.patch.yml' }],
    },
    {
      name: 'DSH-Beta',
      full_name: 'me/DSH-Beta',
      private: false,
      fork: false,
      archived: false,
      pushed_at: '2026-11-02T00:00:00Z',
      __root: [{ name: 'package.json', type: 'file', path: 'package.json' }],
      __files: { 'package.json': JSON.stringify({ dependencies: { cordis: '^3' } }) },
    },
    {
      name: 'DSH-Gamma',
      full_name: 'me/DSH-Gamma',
      private: false,
      fork: false,
      archived: false,
      pushed_at: '2026-11-03T00:00:00Z',
      __root: [{ name: 'package.json', type: 'file', path: 'package.json' }],
      __files: { 'package.json': JSON.stringify({ dependencies: { react: '18' } }) },
    },
    {
      name: 'DSH-Skill',
      full_name: 'me/DSH-Skill',
      private: false,
      fork: false,
      archived: false,
      pushed_at: '2026-11-04T00:00:00Z',
      __root: [{ name: 'SKILL.md', type: 'file', path: 'SKILL.md' }],
    },
    {
      name: 'DSH-Private',
      full_name: 'me/DSH-Private',
      private: true,
      fork: false,
      archived: false,
      pushed_at: '2026-11-05T00:00:00Z',
      __root: [{ name: 'cordis.patch.yml', type: 'file', path: 'cordis.patch.yml' }],
    },
    {
      name: 'Other-Thing',
      full_name: 'me/Other-Thing',
      private: false,
      fork: false,
      archived: false,
      pushed_at: '2026-11-06T00:00:00Z',
      __root: [],
    },
  ]
}

function syncSettings(dir, overrides = {}) {
  const settings = readSettings(
    {
      timeZone: TZ,
      topics: ['dsh-plugin'],
      stateFile: join(dir, 'state.json'),
      auditFile: join(dir, 'audit/sync.jsonl'),
      secretsFile: join(dir, 'secrets.json'),
      token: 'ghp_testtokenxxxxxxxx',
      ...overrides,
    },
    { pluginRoot: dir },
  )
  return settings
}

test('sync：只给「像插件」的 DSH* 仓库补 topic', async () => {
  const dir = tmp()
  const repos = makeRepos()
  const api = makeFakeApi(repos)
  api.topicsMap.set('me/DSH-Beta', ['dsh-plugin', 'cordis'])
  api.topicsMap.set('me/DSH-Skill', ['dsh-plugin'])

  const report = await runSync({ settings: syncSettings(dir), deps: { github: api, now: () => at(2026, 11, 9, 0, 0) } })
  assert.equal(report.scanned, 6)
  assert.equal(report.matched, 4) // Alpha/Beta/Gamma/Skill；Private 与 Other 被过滤
  assert.deepEqual(report.tagged.map((item) => item.fullName), ['me/DSH-Alpha'])
  assert.deepEqual(api.topicsMap.get('me/DSH-Alpha'), ['dsh-plugin'])
  assert.equal(report.already, 2)
  assert.deepEqual(report.skipped.map((item) => item.fullName), ['me/DSH-Gamma'])
  assert.equal(report.errors.length, 0)

  // 状态与审计都写了
  const { state } = loadState(join(dir, 'state.json'))
  assert.equal(state.lastRunAt, at(2026, 11, 9, 0, 0))
  assert.equal(state.repos['me/DSH-Alpha'].eligible, true)
  const audit = readFileSync(join(dir, 'audit/sync.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(audit.some((item) => item.action === 'tagged' && item.fullName === 'me/DSH-Alpha'))
  assert.ok(audit.some((item) => item.action === 'run'))
})

test('sync：仓库没变化时不重复探测（第二遍只读 topic）', async () => {
  const dir = tmp()
  const repos = makeRepos()
  const api = makeFakeApi(repos)
  api.topicsMap.set('me/DSH-Beta', ['dsh-plugin'])
  api.topicsMap.set('me/DSH-Skill', ['dsh-plugin'])
  const now = () => at(2026, 11, 9, 0, 0)
  const settings = syncSettings(dir)

  await runSync({ settings, deps: { github: api, now } })
  const afterFirst = { ...api.calls }
  const second = await runSync({ settings, deps: { github: api, now } })
  assert.equal(second.tagged.length, 0)
  assert.equal(second.already, 3)
  assert.equal(api.calls.root, afterFirst.root, '第二遍不应该再拉目录')
  assert.equal(api.calls.file, afterFirst.file, '第二遍不应该再拉 package.json')
})

test('sync：dryRun 只报告不改动', async () => {
  const dir = tmp()
  const api = makeFakeApi(makeRepos())
  const report = await runSync({
    settings: syncSettings(dir, { dryRun: true }),
    deps: { github: api, now: () => at(2026, 11, 9, 0, 0), log: () => {} },
  })
  assert.deepEqual(
    report.planned.map((item) => item.fullName).sort(),
    ['me/DSH-Alpha', 'me/DSH-Beta', 'me/DSH-Skill'],
  )
  assert.equal(report.tagged.length, 0)
  assert.equal(api.calls.put, 0)
  assert.equal(api.topicsMap.has('me/DSH-Alpha'), false)
})

test('sync：requireMarkers=false 时所有 DSH* 都打 topic', async () => {
  const dir = tmp()
  const api = makeFakeApi(makeRepos())
  const report = await runSync({
    settings: syncSettings(dir, { requireMarkers: false }),
    deps: { github: api, now: () => at(2026, 11, 9, 0, 0) },
  })
  assert.equal(report.tagged.length + report.planned.length, 4)
  assert.equal(api.calls.root, 0)
})

test('sync：没有 token 时给出可执行的提示', async () => {
  const dir = tmp()
  const api = makeFakeApi(makeRepos())
  await assert.rejects(
    runSync({ settings: syncSettings(dir, { token: '' }), deps: { github: api } }),
    /tools\/authorize\.mjs/,
  )
})

// ---------------------------------------------------------------- marker

test('marker：像插件但没标记的仓库能生成补丁内容', () => {
  const detection = {
    eligible: false,
    source: 'root',
    rootNames: ['package.json', 'src', 'README.md'],
    pkgText: JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: 'src/plugin.js' }),
  }
  const plan = planMarkers({ detection })
  assert.equal(plan.ok, true)
  assert.equal(plan.id, 'demo-plugin')
  assert.equal(plan.needsMarkerFile, true)
  assert.equal(plan.needsDshField, true)
  const yaml = buildPatchYaml({ pkgName: 'dsh-demo-plugin', id: 'demo-plugin' })
  assert.match(yaml, /^- insert:/m)
  assert.match(yaml, /name: 'dsh-demo-plugin'/)
  assert.match(yaml, /config: \{\}/)
})

test('marker：不是插件（没有 src/ 也没有 plugin.js 入口）时不猜', () => {
  const website = {
    eligible: false,
    source: 'root',
    rootNames: ['package.json', 'index.html'],
    pkgText: JSON.stringify({ name: 'website', main: 'index.js' }),
  }
  assert.equal(planMarkers({ detection: website }).ok, false)
  const broken = { rootNames: ['package.json'], pkgText: '{oops', source: 'root' }
  assert.equal(planMarkers({ detection: broken }).ok, false)
})

test('sync：自动补标记后再打 topic，且第二遍不重复写', async () => {
  const dir = tmp()
  const repo = {
    name: 'DSH-Delta',
    full_name: 'me/DSH-Delta',
    private: false,
    fork: false,
    archived: false,
    pushed_at: '2026-11-07T00:00:00Z',
    __root: [
      { name: 'package.json', type: 'file', path: 'package.json' },
      { name: 'src', type: 'dir', path: 'src' },
    ],
    __files: { 'package.json': JSON.stringify({ name: 'dsh-delta', version: '0.1.0', main: 'src/plugin.js' }) },
  }
  const api = makeFakeApi([repo])
  const report = await runSync({
    settings: syncSettings(dir),
    deps: { github: api, now: () => at(2026, 11, 9, 0, 0), log: () => {} },
  })
  assert.deepEqual(report.marked.map((item) => item.fullName), ['me/DSH-Delta'])
  assert.deepEqual(report.tagged.map((item) => item.fullName), ['me/DSH-Delta'])
  const pkg = JSON.parse(repo.__files['package.json'])
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(repo.__files['cordis.patch.yml'], /name: 'dsh-delta'/)
  assert.deepEqual(api.topicsMap.get('me/DSH-Delta'), ['dsh-plugin'])

  const writes = api.calls.write
  await runSync({
    settings: syncSettings(dir),
    deps: { github: api, now: () => at(2026, 11, 10, 0, 0), log: () => {} },
  })
  assert.equal(api.calls.write, writes, '第二遍应该走缓存，不再写文件')
})

test('sync：dryRun 时补标记也只计划', async () => {
  const dir = tmp()
  const repo = {
    name: 'DSH-Epsilon',
    full_name: 'me/DSH-Epsilon',
    private: false,
    fork: false,
    archived: false,
    pushed_at: '2026-11-08T00:00:00Z',
    __root: [
      { name: 'package.json', type: 'file', path: 'package.json' },
      { name: 'src', type: 'dir', path: 'src' },
    ],
    __files: { 'package.json': JSON.stringify({ name: 'dsh-epsilon', main: 'src/plugin.js' }) },
  }
  const api = makeFakeApi([repo])
  const report = await runSync({
    settings: syncSettings(dir, { dryRun: true }),
    deps: { github: api, now: () => at(2026, 11, 9, 0, 0), log: () => {} },
  })
  assert.equal(report.marked.length, 1)
  assert.equal(report.marked[0].planned, true)
  assert.equal(api.calls.write, 0)
  assert.deepEqual(api.topicsMap.size, 0)
  assert.deepEqual(report.planned.map((item) => item.fullName), ['me/DSH-Epsilon'])
})

// ---------------------------------------------------------------- runner

const reportStub = (tagged = 0) => ({
  scanned: 1,
  matched: 1,
  tagged: Array.from({ length: tagged }, (_, i) => ({ fullName: `me/DSH-${i}` })),
  planned: [],
  already: 0,
  skipped: [],
  errors: [],
  aborted: null,
  finishedAt: 0,
  requests: 0,
})

function waitFor(predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('waitFor 超时'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function runnerSettings(dir, overrides = {}) {
  return {
    ...readSettings({ stateFile: join(dir, 'state.json'), timeZone: TZ }, { pluginRoot: dir }),
    ...overrides,
  }
}

test('runner：当天 00:00 之后启动会补跑，跑完不再重复', async () => {
  const dir = tmp()
  const settings = runnerSettings(dir)
  let clock = at(2026, 11, 9, 10, 0)
  const calls = []
  const runner = createRunner({
    settings,
    deps: {
      now: () => clock,
      log: () => {},
      sync: async () => {
        calls.push(clock)
        return reportStub(1)
      },
    },
  })
  runner.start()
  await waitFor(() => calls.length === 1)
  await runner.tick()
  assert.equal(calls.length, 1)
  const status = runner.status()
  assert.equal(status.lastSummary.tagged, 1)
  assert.match(status.nextRunLocal, /2026-11-10 00:00/)
  runner.stop()
})

test('runner：第二天再启动会再跑一次', async () => {
  const dir = tmp()
  const settings = runnerSettings(dir)
  let clock = at(2026, 11, 9, 10, 0)
  const calls = []
  const deps = {
    now: () => clock,
    log: () => {},
    sync: async () => {
      calls.push(clock)
      return reportStub(0)
    },
  }
  const first = createRunner({ settings, deps })
  first.start()
  await waitFor(() => calls.length === 1)
  first.stop()

  clock = at(2026, 11, 10, 0, 30)
  const second = createRunner({ settings, deps })
  second.start()
  await waitFor(() => calls.length === 2)
  second.stop()
  assert.equal(calls.length, 2)
})

test('runner：catchUp=false 时只在 00:00 附近跑', async () => {
  const dir = tmp()
  let clock = at(2026, 11, 9, 10, 0)
  const settings = runnerSettings(dir, { catchUp: false })
  let count = 0
  const runner = createRunner({
    settings,
    deps: { now: () => clock, log: () => {}, sync: async () => (count += 1, reportStub(0)) },
  })
  runner.start()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(count, 0)
  // 把它挪到 00:02（宽限期内）就该跑
  clock = at(2026, 11, 10, 0, 2)
  await runner.tick()
  assert.equal(count, 1)
  runner.stop()
})

test('runner：失败后退避，重试次数用尽当天不再试', async () => {
  const dir = tmp()
  let clock = at(2026, 11, 9, 10, 0)
  const settings = runnerSettings(dir, { tickIntervalMs: 5000 })
  let attempts = 0
  const runner = createRunner({
    settings,
    deps: {
      now: () => clock,
      log: () => {},
      sync: async () => {
        attempts += 1
        throw new Error('boom')
      },
    },
  })
  runner.start()
  await waitFor(() => attempts === 1)
  await runner.tick()
  assert.equal(attempts, 1, '退避期内不该立刻重试')
  clock += 11 * MINUTE_MS
  await runner.tick()
  assert.equal(attempts, 2)
  for (let i = 0; i < 4; i += 1) {
    clock += 60 * MINUTE_MS
    await runner.tick()
  }
  assert.equal(attempts, 5, '最多重试 5 次')
  clock += 60 * MINUTE_MS
  await runner.tick()
  assert.equal(attempts, 5, '用尽后当天不再重试')
  assert.equal(runner.status().gaveUpToday, true)
  runner.stop()
})

test('runner：runNow 供手动触发', async () => {
  const dir = tmp()
  let clock = at(2026, 11, 9, 10, 0)
  const runner = createRunner({
    settings: runnerSettings(dir),
    deps: { now: () => clock, log: () => {}, sync: async () => reportStub(0) },
  })
  const report = await runner.runNow('测试')
  assert.equal(report.tagged.length, 0)
  assert.equal(runner.status().lastSummary.tagged, 0)
})

// ---------------------------------------------------------------- plugin smoke

test('plugin：配置错误只警告，不抛错', async () => {
  const { apply } = await import('../src/plugin.js')
  const warnings = []
  const original = console.warn
  console.warn = (line) => warnings.push(String(line))
  try {
    apply({}, { time: '99:99' })
  } finally {
    console.warn = original
  }
  assert.ok(warnings.some((line) => line.includes('配置无效')))
})

test('package.json 与示例文件存在且可解析', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'src/plugin.js')
  assert.equal(existsSync(new URL('../secrets.example.json', import.meta.url)), true)
})
