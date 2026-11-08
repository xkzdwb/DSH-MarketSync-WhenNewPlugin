# DSH-MarketSync-WhenNewPlugin

> 每天 00:00，把自己 GitHub 上「以 DSH 开头的插件仓库」自动送进 [dsh.market](https://github.com/2BingLing/dsh-market)。

一个零依赖的 DSH 插件，**不调用任何模型**：一次跑批 1~3 秒、几十次 GitHub API 请求。它只做一件事——让市场每天 06:00 的采集器看得到你的新插件。不用提 issue，不用手工打标签。

- 跟着 DSH HOST 进程走；00:00 时 DSH 没开，下次启动自动补跑
- 只碰自己名下的仓库；只碰「像插件」的仓库；写操作只有 topic 和两个标记文件
- 提交信息固定，补标记的提交可在 GitHub 上逐条回滚

## 它做什么

每天 00:00（Asia/Shanghai，可配）跑一批：

1. `GET /user/repos?affiliation=owner` 列出自己名下的仓库；
2. 按 `namePattern`（默认 `^DSH`）筛名字，排除私有 / fork / 归档；
3. 按市场自己的判据（抄自 `collector/src/detect.ts`）判定是不是插件：
   - 根目录有 `cordis.patch.yml` / `dsh.profile` / `dsh.profile.yml` / `dsh-manifest.json` / `dsh.plugin.json`；或
   - 根目录有 `SKILL.md`（或 `skills/*/SKILL.md`）；或
   - `package.json` 的依赖名含 `cordis` / `@cordisjs/plugin` / `dsh-base` / `@deepseek-ai/dsh-`，或有 `dsh.bundle.patch` / `dsh.client`；
   - 根目录不像时再看一层子目录（monorepo 常见）；
4. 缺标记但明显是插件的仓库，**自动补**：`package.json` 加 `dsh.bundle.patch`（必要时补 `main`），根目录建 `cordis.patch.yml`；
5. 缺 `dsh-plugin` topic 的补上（`PUT /repos/{owner}/{repo}/topics`，保留原有 topic）。

## 为什么不是「实时」

市场的采集器是**每天 06:00** 扫 `topic:dsh-plugin`，这是市场那边的节奏。本插件保证「每天 00:00 之前你的仓库一定是可被采集的状态」，所以效果是**次日 06:00 自动上架**。之后仓库内容更新（README、版本）也不用重跑：采集器按 `pushed_at` 增量重抓。

## 安装

```powershell
dsh plugin add github:xkzdwb/DSH-MarketSync-WhenNewPlugin
```

或手动：把 `examples/cordis.patch.snippet.yml` 的内容加进 profile 的 `cordis.patch.yml` 的 `insert:` 下（缩进对齐其它 `- id:`），重启 DSH。

装好后访问 `http://127.0.0.1:10605/plugin-market-sync/status`，能看到 `started: true` 即生效。

## 授权（一次性）

需要一个能改你自己仓库 topic 的 GitHub token（scope：`repo`；`workflow` 可选）。

自动方式（Windows，Edge / Chrome 已登录 GitHub）：

```powershell
node tools/authorize.mjs
```

它会用独立 profile 起一个带调试口的浏览器，打开 token 创建页、填描述、点 Generate token、读回 token 写进本目录 `secrets.json`。GitHub 要求 sudo 确认时，在浏览器窗口里输密码即可，脚本会继续等。

手动方式：GitHub → Settings → Developer settings → Personal access tokens，建一个 token，写进 `secrets.json`：

```json
{ "githubToken": "ghp_xxx" }
```

也可以直接用环境变量 `GITHUB_TOKEN`。优先级：`config.token` > `secrets.json` > 环境变量。

## 运行

| 时机 | 行为 |
| --- | --- |
| 每天 00:00 | 跑一批 |
| 00:00 时 DSH 没开 | 下次启动补跑（`catchUp: true`） |
| 失败 | 10 分钟后重试，最多 5 次；限流按 reset 时间等 |

手动试跑：

```powershell
node tools/sync-once.mjs --dry-run   # 只报告，不改
node tools/sync-once.mjs             # 真改
```

审计流水：`audit/sync.jsonl`，每个动作一行。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `time` | `"00:00"` | 每天几点跑（24h） |
| `timeZone` | `"Asia/Shanghai"` | 按 IANA 时区算，不受机器时区影响 |
| `catchUp` | `true` | 错过 00:00 后下次启动补跑 |
| `tickIntervalMs` | `30000` | 多久看一次表 |
| `namePattern` | `"^DSH"` | 仓库名正则 |
| `topics` | `["dsh-plugin"]` | 要补的 topic（小写、可多个） |
| `includePrivate` | `false` | 市场只收公开仓库，默认跳过私有 |
| `includeForks` / `includeArchived` | `false` | 同上 |
| `requireMarkers` | `true` | 只给「市场认得的插件」打 topic |
| `autoMark` | `true` | 像插件却缺 cordis 标记时，自动提交 `package.json` + `cordis.patch.yml` |
| `markerCommitMessage` | `chore(dsh): 补市场收录标记…` | 自动补标记的提交信息 |
| `followSubdir` | `true` | 根目录没标记时看一层子目录 |
| `maxRepos` | `200` | 单次最多处理多少个仓库 |
| `secretsFile` | `secrets.json` | token 文件；相对路径按插件目录算 |
| `token` | 空 | 应急：直接写 token（不推荐） |
| `stateFile` | `state.json` | 上次跑批时间 + 检测缓存 |
| `auditFile` | `audit/sync.jsonl` | 审计流水 |
| `dryRun` | `false` | 只报告不改动 |
| `timeoutMs` | `20000` | 单请求超时 |
| `retries` | `3` | 5xx / 网络错误重试次数 |

## 安全边界

- 只处理 `affiliation=owner` 的仓库；私有 / fork / 归档默认跳过
- 只有名字匹配 `namePattern` 的才处理
- `requireMarkers: true`：不像插件的仓库不打 topic，避免污染市场
- `autoMark` 的写操作只有两类文件：`package.json`、根目录 `cordis.patch.yml`
- token 只存本机；状态接口只报「有没有 token」，不返回内容
- 所有请求只打 `api.github.com`

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 状态页 404 | 插件没装进 profile，或改了 patch 没重启 DSH |
| `没有 GitHub token` | 跑 `node tools/authorize.mjs`，或写 `secrets.json` |
| `401` | token 失效 / 被撤销，重新授权 |
| `403` 限流 | 免费额度：匿名 60/小时、带 token 5000/小时；插件会等到 reset 再重试 |
| 授权脚本「25 秒内没打开调试端口」 | 专用 profile 被别的浏览器窗口占用，关掉那个窗口重试 |
| 授权脚本停在 Confirm access | 在浏览器窗口里输入密码并点 Confirm |

## 开发

```powershell
node test/run-tests.mjs   # 31 项离线测试，不打网络
```

## 卸载

从 profile 的 `cordis.patch.yml` 删掉 `- id: market-sync` 那段并重启 DSH；或用 `dsh plugin remove`（按你的安装方式）。

## License

MIT