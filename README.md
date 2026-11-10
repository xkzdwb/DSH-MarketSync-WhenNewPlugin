# 03-市场同步（market-sync）

把 GitHub 上自己名下、名字匹配 `^DSH` 的**插件仓库**补上 `dsh-plugin` topic，让 [dsh.market](https://github.com/2BingLing/dsh-market) 每日 06:00 的采集自动收录；打了 topic 但连续几个索引周期都没被采集到的，再自动补一条 submission issue。

纯自动化：DSH 起来后跟着 HOST 进程走，每天 **00:00（Asia/Shanghai）** 跑一次；00:00 时 DSH 没开，下次启动自动补跑。不需要开网页、不需要手工点。

## 它做什么

每次跑批：

1. 用 token 列出自己名下的仓库（`GET /user/repos?affiliation=owner`）；
2. 按 `namePattern`（默认 `^DSH`）筛名字，再排除私有 / fork / 归档；
3. 判定「市场认不认得这是个插件」（规则抄自市场的 `collector/src/detect.ts`）：
   - 根目录有 `cordis.patch.yml` / `dsh.profile` / `dsh.profile.yml` / `dsh-manifest.json` / `dsh.plugin.json`，或
   - 根目录有 `SKILL.md`（或 `skills/*/SKILL.md`），或
   - `package.json` 的依赖名含 `cordis` / `@cordisjs/plugin` / `dsh-base` / `@deepseek-ai/dsh-`，或有 `dsh.bundle.patch` / `dsh.client`；
   - 根目录不像时，允许再看一层子目录（monorepo 常见）；
4. 缺标记时**自动补**（`autoMark` 默认开）：只对「根目录有 `package.json`，入口是 `plugin.js` 或 `src/` 下的文件」这种明确的插件仓库，
   - `package.json` 补 `dsh.bundle.patch: "./cordis.patch.yml"`（必要时补 `main`），
   - 根目录新建 `cordis.patch.yml`（`insert` 本包、`config: {}` 用默认值）；
   补完立刻打 topic，一次跑批完成；
5. 已经带 `dsh-plugin` 的跳过；缺的用一次 `PUT /repos/{owner}/{repo}/topics` 补上（保留原有 topic）。
6. 拉一次市场索引 `plugins-lite.json`，对「这次处理过、却不在索引里」的仓库补一条 issue：标题 `[提交插件] <仓库名>`，正文带仓库地址、插件类型、简介、已打 topic 的说明，外加作者自述（自动生成，可随时编辑）。issue 走市场自带的投稿通道，**不受采集器“topic 搜索最多 1000 条”的限制**。同一个仓库只提一次（记在 `state.submissions`，并在提交前用 `searchIssues` 查重）；索引比仓库本身还旧时按 `too-new` 跳过，等下一轮。

**不做**的事：不碰私有/fork/归档仓库、不改「不像插件」的仓库、不重复提 issue。补标记只碰上面那两类文件，提交信息固定为 `chore(dsh): 补市场收录标记…`，可在 GitHub 上逐条回滚。不想让它写仓库：`autoMark: false`（缺标记的仓库就只进报告 `skipped`）；不想提 issue：`submitMissing: false`。

请求预算：列仓库 1 次 + 每个候选仓库读 topic 1 次；检测结果按 `pushed_at` 缓存，仓库没变就不重复拉目录/package.json。token 缺失时零请求。

## 启用

在 `C:\Users\lzx_x\.dsh\profiles\desktop\cordis.patch.yml` 的 `insert:` 里加（改完要重启 DSH）：

```yaml
    - id: market-sync
      name: "P:/工程/DeepseekHarness/系统/03-市场同步/src/plugin.js"
      config:
        time: "00:00"
        timeZone: Asia/Shanghai
        catchUp: true
        topics:
          - dsh-plugin
```

## 授权（只需一次）

```powershell
node tools/authorize.mjs
```

会用 `C:\Users\lzx_x\AppData\Local\dsh-web-deepseek\profile` 里的 Edge（已登录 GitHub）打开 token 页面，自动填描述、点「Generate token」、读回 token 并写进本目录 `secrets.json`。遇到 GitHub 要求 sudo 确认时，按提示在浏览器窗口里输密码即可，脚本会继续等。

- 只验证已有 token：`node tools/authorize.mjs --check`
- 换 token：再跑一次即可（插件每个 tick 都重读 `secrets.json`，不用重启 DSH）
- token 落在本机 `secrets.json`（已在 `.gitignore`），不进 yml、不进日志；状态接口只报「有没有 token」，不报内容

## 手动试跑

```powershell
node tools/sync-once.mjs --dry-run   # 只报告会打哪些，不真的改
node tools/sync-once.mjs             # 真改
```

`--dry-run` 只读：列出每个 DSH* 仓库「是插件 / 不是插件 + 理由 / 已带 topic / 缺 topic」，也会标出「会补标记」「会投稿」。加 `--no-submit` 可以跳过投稿这一步。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `time` | `"00:00"` | 每天几点跑（24h） |
| `timeZone` | `"Asia/Shanghai"` | 按 IANA 时区算，不受机器时区影响 |
| `catchUp` | `true` | 错过 00:00（关机/休眠）后下次启动补跑 |
| `tickIntervalMs` | `30000` | 多久看一次表 |
| `namePattern` | `"^DSH"` | 仓库名正则 |
| `topics` | `["dsh-plugin"]` | 要补的 topic（小写、可多个） |
| `includePrivate` | `false` | 市场只收公开仓库，默认跳过私有 |
| `includeForks` / `includeArchived` | `false` | 同上 |
| `requireMarkers` | `true` | 只给「市场认得的插件」打 topic；设 `false` 则所有 DSH* 都打 |
| `autoMark` | `true` | 像插件却缺 cordis 标记时，自动提交 `package.json` + `cordis.patch.yml` |
| `markerCommitMessage` | `chore(dsh): 补市场收录标记…` | 自动补标记的提交信息 |
| `submitMissing` | `true` | 打了 topic 却不在市场索引里时，自动提 submission issue |
| `maxIssuesPerRun` | `3` | 单次最多提几条 issue（0–20） |
| `marketRepo` | `2BingLing/dsh-market` | 收 issue 的仓库 |
| `marketIndexUrl` | 官方 `plugins-lite.json` | 市场索引地址，用来判断“收没收录” |
| `followSubdir` | `true` | 根目录没标记时看一层子目录 |
| `maxRepos` | `200` | 单次最多处理多少个仓库（保护 API 额度） |
| `secretsFile` | `secrets.json` | token 文件；相对路径按插件目录算 |
| `token` | 空 | 应急：直接写 token（不推荐） |
| `stateFile` | `state.json` | 上次跑批时间 + 检测缓存 |
| `auditFile` | `audit/sync.jsonl` | 每次动作的审计流水 |
| `dryRun` | `false` | 只报告不改动 |
| `timeoutMs` | `20000` | 单请求超时 |
| `retries` | `3` | 网络/5xx 重试次数 |

## 状态

DSH 跑起来后：`http://127.0.0.1:10605/plugin-market-sync/status`（端口以实际 GUI 为准），返回：

- `schedule` / `nextRunLocal` / `lastSuccessLocal`
- `lastSummary`（扫描、命中、新增、已就绪、跳过、失败、投稿）
- `lastError` / `retryAtLocal` / `gaveUpToday`

## 市场那边什么时候能看到

市场 collector 每天 06:00 扫 `topic:dsh-plugin`。打完 topic 后，最快当天 06:00、最慢次日 06:00 出现在市场索引里（之后仓库每次 push 会按 `pushedAt` 增量更新 README/评分）。

但 GitHub 搜索 `topic:dsh-plugin` 有 29,000+ 条，API 只返回前 1000 条（采集器用 created/updated/stars 三路并集尽量覆盖）。刚打 topic 的仓库若不在任何一路的前 1000 里，就会被漏掉——这正是投稿 issue 的用途：issue 由采集器直接读取，不受搜索窗口限制，通常会在下一个 06:00 前被收录并自动回复/关闭。

## 排错

| 现象 | 处理 |
| --- | --- |
| `没有 GitHub token` | 跑 `node tools/authorize.mjs` |
| 401 / token 被撤销 | 重新授权；`--check` 可先验证 |
| 403 且 `x-ratelimit-remaining: 0` | 额度用尽，插件会按 `reset` 时间自动退避重试 |
| 仓库全被 `skipped` | 多半是「根目录没有 cordis 标记 / package.json 没 cordis 依赖」。按上面三条判据补一个（如仓库根放 `cordis.patch.yml`），或临时设 `requireMarkers: false` |
| 打了 topic 迟迟不进市场 | 采集器的 topic 搜索只取前 1000 条。插件会在下一轮自动提 issue；也可手动 `node tools/sync-once.mjs` 立刻补 |
| 投稿一直没发生 | 看状态里的 `index.ok`：索引拉取失败时只记录、不中断；`too-new` 表示索引比仓库旧，等下一轮即可 |
| 浏览器 25 秒没开调试口 | 关掉所有使用 `dsh-web-deepseek` profile 的 Edge 窗口，或 `--profile` 指定别的目录 |
| 端口 9555 被占用 | `--port 9560`，或先关掉用它的实例 |

## 测试

```powershell
node test/run-tests.mjs
```

覆盖：定时计算（含跨时区/夏令时）、配置校验、token 优先级、状态读写、插件标记判定、一次完整同步（打 topic / 已就绪 / 跳过 / dryRun / 缓存）、自动补标记、投稿判定（缺收录 / 已收录 / too-new / 查重复用 / 单次上限）、调度器补跑与失败退避。
