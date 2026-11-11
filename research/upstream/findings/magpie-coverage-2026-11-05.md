# MAGPIE 会话/调用识别逻辑：全量梳理（2026-11-05）

> 覆盖面研究的原始取证，判断与去向见 [`../LESSONS.md`](../LESSONS.md)、
> 派单见 [`coverage-gap-2026-11-05.md`](coverage-gap-2026-11-05.md)。
> 上游 pin `a3768cdd`（11-03），本轮核到 `24885322`（11-05 06:19 UTC）。
> 只读取证，未改 agent-archive 任何代码；仅镜像 `FETCH_HEAD` 被 `git fetch` 更新。
> 行号均为 MAGPIE 仓库 `commit 24885322` 相对路径。

## 0. 版本与取证

- 本地 sparse 镜像 `~/.agent-archive/upstream-cache/magpie`，`git fetch --depth=250 origin main`
  后 `FETCH_HEAD=24885322`；本文全部用 `git show FETCH_HEAD:<path>` 读新版。
- 11-05 相对 10-21 调研的会话子系统增量：新增 `calls_grok.go` `cindy.go` `agy_manage.go`
  `list_kept.go` `codex_cwd.go` `codex_fork.go` `codex_resume.go`；改动 `calls.go` `calls_pi.go`
  `calls_workbuddy.go` `calls_zcode.go` `external.go` `sessions.go` `call_cache.go` 等。
  `tail.go`/`discovery.go`/`frames.go` 本轮未改。
- **未核实**：未跑 MAGPIE 二进制；未读 `internal/gateway/`、`desktopdir.go` 全文、
  `cursor_editor.go` 全局库细节；shallow depth 250，提交级归因不可靠（只用文件级证据）。

## 1. 三个集合必须分清（10-21 调研把它们混在一起了）

| 集合 | 代码位置 | 干什么 | 规模 |
|---|---|---|---|
| **A1 读会话（摘要/列表/正文）** | `internal/sessions/sessions.go` + 各家 `xxxFiles()`/`parseXxx()`；**`access.go:193` `Found()` 是权威清单** | 只读 → 统一 Session | **25 家** |
| **A2 读调用记录（每请求 token/模型/用量）** | `internal/sessions/calls.go` `callSources()` + `call_cache.go` 三类 reader | 只读 → 统一 `Call` | **13 个 `xxxCallFiles()` / 14 家解析** |
| **B 改配置/接管流量（写）** | `internal/agent/`（74+ 内置）+ `internal/library/` + `internal/gateway/` | 写用户文件、代理请求 | **74+ 内置** |

**能改配置 ≫ 能读会话 ≫ 能读调用记录**。A 受 `Reads()` 同意门控（`access.go:15-22`：全新安装默认一家都不读，须在 Sessions 页授权）；`allowed()` 在 `callSourcesInto` 出口按 agent 再过滤一遍（`access.go:172-188`）。B 不受此门控。

### 1.1 「19 个」核实结论（与 CC Switch 报告互相印证）

- `magpie ls`（`internal/cli/main.go:443`）= 本机 `agent.Detected()` 实测输出；`magpie agents`（:447）= `agent.All()` 全集。
- **10-21 的「19 个设置文件」= 当时单机的 `magpie ls` 实测数，不是代码上限**。代码上限：
  `agent.All()` = `onMachine()` **74 个内置 constructor**（`agents.go:237-312`）+ `wslAgents()` + `pluggedAgents()`；
  `library/targets.go` 的 `targetOf` 有 **53 个 case**、`pluginMCP` 有 **18 种 MCP 格式**。
- 那 19 个名字在 11-05 版仍全在，但清单已扩到 74 家（新增 `openChamber`/`deveco`/`mimocode`/
  `droid`/`alma`/`cindy`/`aionui`/`qwen`/`goose`/`crush`/`openClaw`/`newMax`/`kiroCrew` 等）。
- **结论：CC Switch 报告说「19 是 MAGPIE 的数」，本报告进一步确认它是 MAGPIE 单机实测数、不是任何代码上限。两处台账都不该再引用「19」当能力指标。**

## 2. 注册表（关键纠正：callSources 是「调用记录」表，不是「会话」表）

### 2.1 `callSourcesInto()` 挂 13 个 `xxxCallFiles()`（`calls.go:340-349`）

```go
lists := append(callFileLists(codex), openCodeCallFiles(), zcodeCallFiles(), dshCallFiles(),
    minimaxCallFiles(), kimiCallFiles(), wslFiles("kimi"), piCallFiles(), codebuddyCallFiles(), workbuddyAIFiles(),
    agyCallFiles(), workbuddyCallFiles(), grokCallFiles())
return allowed(distinctOf(lists...))
```

| # | 函数 | agent（file.agent） | 解析策略 |
|---|---|---|---|
| 1 | `callFileLists(codex)` | claude / claude-desktop / codex / WSL(claude,codex) | line |
| 2 | `openCodeCallFiles()` | opencode | whole |
| 3 | `zcodeCallFiles()` | zcode | whole |
| 4 | `dshCallFiles()` | dsh | resume |
| 5 | `minimaxCallFiles()` | minimax-code | whole |
| 6 | `kimiCallFiles()` | kimi | line |
| 7 | `wslFiles("kimi")` | kimi（WSL 内） | line |
| 8 | `piCallFiles()` | pi / raft / cindy / omp | line |
| 9 | `codebuddyCallFiles()` | codebuddy | whole |
| 10 | `workbuddyAIFiles()` | workbuddy-ai | whole |
| 11 | `agyCallFiles()` | agy（Antigravity CLI） | whole |
| 12 | `workbuddyCallFiles()` | workbuddy | whole |
| 13 | `grokCallFiles()` | grok（Grok Build） | line（11-05 新增，连带 `calls_grok.go`） |

> 与 10-21 调研（10 项）的差异：重构成 `callSources/With/Into/callFileLists` 四层
> （为 `CallSourcesAndCodexIdentities()` 一趟遍历复用 codex 列表）；新增 `workbuddyAIFiles()` 与 `grokCallFiles()`。
> **10-21 文档「callSources() 就是全部适配器的注册表」已不准确**——会话列表由 `sessions.go` 各家 `xxxFiles()` 负责。

### 2.2 三类 reader 才是解析入口（`call_cache.go:246-296`）

`calls.go:324-333` 原话：**「Every agent here needs an entry in wholeCallReaders, lineCallReaders or
resumeCallReaders」**，漏了就永远读不到调用。

| 类别 | 语义 | Agent → 函数 |
|---|---|---|
| `wholeCallReaders` | 整份重读（库行/JSON 文档/整体替换） | opencode / zcode / workbuddy / workbuddy-ai / codebuddy / minimax-code / agy（7 家） |
| `resumeCallReaders` | 只追加但不能从行中续（zstd 帧） | dsh（1 家） |
| `lineCallReaders` | 只追加、一行一事件、从 Off 续 | kimi / pi / raft / cindy / omp / grok（6 家） |
| 默认 line 分支 | Claude/Codex 字节层解析 | claude / claude-desktop / codex |

合计 **14 家**能抽出调用记录。

### 2.3 会话识别全集 `Found()` = 25 家（`access.go:193-248`）

`claude, claude-desktop, codex, opencode, pi, raft, cindy, zcode, dsh, cline, qoder, qoder-cn,
grok, workbuddy, workbuddy-ai, codebuddy, omp, droid, cursor, hermes, alma, minimax-code,
kimi, agy, gemini`

`Found()` 只 stat 各家根路径（不读内容），是 consent 页「本机有哪些 Agent 有会话」的来源。
**有 `Found()` 但没进 `callSources()` 的**：`qoder, qoder-cn, cline, droid, hermes, alma, cursor, gemini`
——能读会话摘要/正文，但没抽调用记录（「半截」）。Cline 就是活例：会话层完整、调用层没登记。

### 2.4 `file` 记录的确切语义（`sessions.go:399-411`）

10-21 说的 `{path,key,agent}` 是简化版，实际：
```go
type file struct {
    agent, key, path string   // key = "agent:session id"，一场会话可跨多个文件
    size int64; mod time.Time // stat，增量判据
    main, readOnly, cold bool // main=会话自身（非子代理）；cold=WSL 停机 distro 不打开
    more *fileMore            // 懒分配：OpenCode/ZCode 的 sid/parent/oc 句柄
}
```
对外投影 `CallSource{Path,Key,Agent,Size,Modified}`（`calls.go:1272-1277`）。注释写明：只留 96 字节/文件，
避免 Sessions 轮询复制 ~20k 文件 × 5-6 遍（~50MB/poll）。→ **每个文件自带 agent 标签**，与 CC Switch 的
`provider_roots(id)` 同属「发现与解析分离」，是解耦 `structureSpec` 该抄的骨架。

### 2.5 新增一家的 checklist（补扫描器时对照，别漏登记）

1. 根路径函数 `XxxDir()`（`internal/appdir/`，跨 GOOS 参数化 + `_test.go` 三平台断言）
2. `xxxFiles()`（会话列表）+ `xxxCallFiles()`（调用记录）
3. `callSourcesInto()` 的 lists 加一行
4. `wholeCallReaders`/`lineCallReaders`/`resumeCallReaders` 之一注册（**漏了永远不读**）
5. `readXxxCalls()` 解析实现
6. `Found()` 加一行（consent 才列得出）
7. 会话摘要 `parseXxx()` + `Session` 字段映射
8. 升级解析逻辑时 bump `parseVersions[agent]` / `callParseVersions[agent]`
9. （要接管流量才需要）`internal/agent/` 加 constructor、`targets.go` 加 case
10. `_test.go`：路径三平台 + 格式漂移样本

> 对我们只做只读档案馆而言，**第 4/5/9 步不适用**（我们不抽 per-request 调用、不接管流量）；
> 但「会话层与调用层是两张独立注册表、漏登记会静默不读」这条纪律，对应到我们就是
> 「每家必须同时写 `discover()`（本机）与 `structureSpec`+`discoverWithin()`（显式源）两套，漏一套就在某条入口静默消失」。

## 3. 它凭什么覆盖面广：不是数据驱动路径表，是「每家硬编码 + 7 个放大器」

每家一个 `XxxDir()` 手写（`os.UserHomeDir()`/`os.UserConfigDir()` 自动跨平台 + 环境变量优先），
没有统一路径表。覆盖面来自：

1. **同源复用（最高性价比，直接可抄）**：ZCode=OpenCode 表（`zcode.go:8-16`）；
   Qoder/Qoder-CN 行同 Claude Code（`qoder.go:10-16`）；
   WorkBuddy/CodeBuddy/WorkBuddy-AI 共用 `buddyFiles()`（`workbuddy.go:41`）；
   **Pi/omp/raft/cindy 共用 `piParse`**（`pi.go:24-26`、`omp.go:13-16`、`raft.go:10-16`、`cindy.go:8-16`）；
   Kimi 会话与调用共用 `wire.jsonl`。
   → 我们已有 workbuddy/qoder/zcode，等于握着 4+ 家的免费扩展点（**但见 §6.0 的纠错**）。
2. **GOOS 参数化 + 测试**：`appdir.ZCodeHomeOn(goos, home)` + `_test.go` 遍历 darwin/windows 断言。
3. **`discovery.go` 的 `SessionGlob`**：按目录 `(mtime,size)` 缓存列举、`racyDirectory=2s` 守卫、
   16384 上限、**只缓存名字不缓存内容**、`stat` 每次重做（`discovery.go:11-85`）。
4. **WSL 通用兜底**（`wsl.go`）：6 家固定子目录表 + `\\wsl.localhost\<distro>` + 软链重映射
   （#4502）+ 停机 distro 不打开（`file.cold`）。
5. **Desktop 数据目录**（`external.go`/`calls.go:351-355`）：`desktopdir.Everywhere()` 汇总 `%APPDATA%\Claude`、
   MSIX、Cowork `local-agent-mode-sessions/*/*/local_*/.claude`；`DesktopTitles`/`PIDesktopTitles` 血缘标题。
6. **`MergeExternal` 第二数据源**（`external.go:31-42`）：网关 usage ledger 里没本地文件的会话以只读方式并入；
   native 按 `(Agent,ID)` struct 键胜出（注释：5000 会话每轮拼 `"agent|id"` 串 ~200MB/80s，#2278）；
   11-05 新增 `EachMerged()` 惰性归并。**这就是「走了网关、本地没存也能还原会话」的机制**，
   印证 10-21 调研说的「网关层是唯一零适配通道」——但对只读档案馆属「了解不抄」（我们明确不转发请求）。
7. **环境变量覆盖密集**：`KIMI_CODE_HOME`/`MINIMAX_DATA_DIR`/`CODEBUDDY_CONFIG_DIR`/
   `WORKBUDDY_CONFIG_DIR`/`PI_CODING_AGENT_DIR`/`CLINE_SESSION_DATA_DIR`/`GROK_HOME`/
   `QODER_CONFIG_DIR`/`QODERCN_CONFIG_DIR`/`SLOCK_HOME`/`DSH_HOME`/`OPENCODE_DB`/`HERMES_HOME` 等，
   统一经 `appdir.Getenv()`。

## 4. 逐家规格（重点：我们没有的家）

> 路径均「环境变量优先，否则默认」；三平台差异靠 `os.UserHomeDir()`/`os.UserConfigDir()`。

| Agent | 根路径 | 格式 | 关键字段 / 坑 | 证据 |
|---|---|---|---|---|
| **kimi / kimi-code** | `$KIMI_CODE_HOME`→`~/.kimi-code` | `sessions/<slug>/<id>/agents/<a>/wire.jsonl`（追加）+ `state.json`（标题/cwd/时间/父） | `usage.record{agentId,model,usage{inputOther,output,inputCacheRead,inputCacheCreation},time(ms)}`；协议 1.0/1.4/1.5 差异大（1.4 先 `step.end` 后 usage、1.5 反之；老版缺 `agentId`）→ **只用 usage.record 本身不与 step.end 配对**；fork 整段复制父 wire → `kimiCallKey(agent,time,model,usage)` 去重；`magpie/` 前缀是网关调用排除；cwd 缺失查根 `session_index.jsonl` | `calls_kimi.go:15-144`；`kimi.go:14-70` |
| **pi** | `$PI_CODING_AGENT_DIR`→`~/.pi/agent`；会话目录可被 `PI_CODING_AGENT_SESSION_DIR`/`settings.json.sessionDir` 覆盖 | `<time>_<id>.jsonl`，首行 `session` header，其后 entry | `message{role,provider,model,usage{input,output,cacheRead,cacheWrite,reasoning,totalTokens},responseId,durationMs}`、`parentId`、`cwd`、`usage`/`compaction`/`branch_summary`；fork 复制父 entries → 按 id+time 去重、只算 header 之后；input 不含 cache、output 含 reasoning；**CC Switch 侧「会话树/活动分支」是更硬的语义**（两家侧重不同：CC Switch 管投影、MAGPIE 管调用） | `pi.go:16-70`；`calls_pi.go:11-125` |
| **omp / raft / cindy** | omp `~/.omp/agent`(+profiles+XDG 非 Win)；raft `$SLOCK_HOME`→`~/.slock` 下 `agents/*/.pi-sessions`；cindy `UserConfigDir()/Cindy` 下 `pi-agent-home/sessions` | 同 Pi | omp 多 `model_usage` + 固定宽度 title 行（原地改写，读 `title_change`）；cindy provider 是 `magpie-<8hex>` 易与网关重复计数 → `cindyGatewayProvider()`；三家共享 `piCallsBegin`/`readPiCallLine` | `omp.go:13-47`；`raft.go:10-34`；`cindy.go:8-37` |
| **minimax-code / mcode** | `$MINIMAX_DATA_DIR`→`~/.minimax` | `v2/sessions/<日期>/<hh-mm-ss-ms>-session_<b64(id)>/messages.jsonl`（多代由 `history-catalog.json` 记） | `message{role,provider,model,usage,timestamp(ms)}`；whole 读；`custom_provider:magpie` 排除；id 从目录名 base64（4 种编码轮流试）解 | `calls_minimax.go:17-159` |
| **codebuddy** | `$CODEBUDDY_CONFIG_DIR`→`~/.codebuddy` | 与 WorkBuddy 完全同构 `projects/<cwd>/<id>.jsonl` | 共用 `readWorkBuddyCalls`；`models.json` 的 `custom-local:<id>`/`group/<id>` 是 magpie 路由排除 | `calls_workbuddy.go:41-110` |
| **cline** | `$CLINE_SESSION_DATA_DIR`→`$CLINE_DATA_DIR/sessions`→`$CLINE_DIR/data/sessions`→`~/.cline/data/sessions` | `<id>/<id>.json`（manifest）+ `<id>.messages.json`（**整体重写非追加**） | assistant `modelInfo.id`、`ts`(ms)、`metrics`（AI SDK：input 含 cache）；`metadata.fork`/`forkedAt`；**整份重写→不能 tail，必须 whole**；fork 只算 `forkedAt` 之后 | `cline.go:14-60` |
| **grok / Grok Build** | `$GROK_HOME`→`~/.grok` | `sessions/<URLenc cwd>/<id>/summary.json` + `updates.jsonl`（追加） | summary: id/cwd/created_at/generated_title/parent_session_id；updates: `turn_completed` 的 `usage.modelUsage`（按模型拆多 Call）、`timestamp`(秒)；**CC Switch 侧正文在固定名 `chat_history.jsonl`**（两家读的不是同一个文件，见纠错）；网关判定读 `config.toml` 的 `[model."magpie/…"]` | `grok.go:20-53`；`calls_grok.go:19-201` |
| **alma** | `UserConfigDir()/alma` | `chat_threads.db`（**SQLite WAL，运行中持续写**） | `chat_threads` / `chat_messages(parent_id,slot_id,depth,message=UIMessage JSON,metadata{usage})` **树形**（编辑/重答是兄弟）；带触发器/FTS/外键，**绝不删移**；`mode=ro` | `alma.go:15-58` |
| **droid / Factory** | `$FACTORY_HOME_OVERRIDE/.factory`→`~/.factory/sessions` | `<id>.jsonl` + `<id>.settings.json` | 首行 `session_start`(id/title/cwd/parent)；`settings.json` 的 `tokenUsage` **单一累计值**（不分 turn）；fork 从零计 | `droid.go:18-43` |
| **agy / Antigravity CLI** | `~/.gemini/antigravity-cli` | `brain/<id>/.system_generated/logs/transcript_full.jsonl` + `conversation_summaries.db` | step `step_index,source,type,created_at,input_tokens,…,content`；**step 不命名 model/account**；1.2.16 才有 token 字段、老版整行略过（不记 0）；`step_index` 被重写一次→按 index 覆盖去重；whole 读 | `agy.go:20-45`；`calls_agy.go:16-113` |
| **claude-desktop / Cowork / MSIX** | `desktopdir.Everywhere()`（多目录）+ Cowork `local-agent-mode-sessions/*/*/local_*/.claude` | 内部 `.claude` 即 Claude Code 同构 JSONL + `local_<id>.json` | `sessionId`/`cliSessionId`/`priorCliSessionIds`/`title`；`entrypoint` 判 3p；标题当前 id 优先于 prior id | `calls.go:150-163,302-355`；`desktop_titles.go:16-75` |
| **wsl** | `\\wsl.localhost\<distro>\home\<user>` + 6 家子目录 | 与各 Windows 版同构 | cold distro 不打开、软链重映射 #4502 | `wsl.go:18-147` |
| **cursor (protobuf)** | `chats/<md5(cwd)>/<chat id>/store.db` + 全局 `state.vscdb` | **SQLite(WAL) + protobuf blob**（`ConversationStateStructure`，手动 wire type 2+varint，**无 schema**）+ `meta.json` 补 cwd/title | 无 `-wal` 用 `immutable=1`（零写），有 `-wal` 复制 db+wal 再读；macOS APFS `clonefile`；Cursor 关聊天会删 `-wal` | `cursor.go:22-405`；`cursor_snapshot.go:13-58` |
| **其它已有家的差异** | opencode/zcode/qoder/hermes/gemini/codex/claude/dsh | SQLite/JSONL/zstd/JSON | ZCode 固定 USERPROFILE 不跟 HOME；OpenCode 2 有 `session_v2`/`session_message` 新表；hermes `-wal` checkpoint 不改主库 mtime、判据必须含 `-wal`；qoder 行同 Claude Code；dsh zstd 多帧续读 + fork seed 跳过 | `zcode.go:8-38`；`opencode.go:47-79`；`hermes.go:22-45`；`frames.go:149-270` |

### 4.2 通用约定（照抄会错的地方）

- `file.key = "agent:session id"`，一场会话可跨多文件（主 + `subagents/` + 多代）。
- 父子：Claude `SubagentOf`、dsh `parentSession`/`delegationDepth`、grok `parent_session_id`、
  droid `parent`、kimi `forkedFrom`、zcode/opencode `parent_id`、alma 树形 `parent_id/slot_id/depth`。
- **token 口径各家不同**：Claude `input_tokens/output_tokens/cache_*`；Codex 累计差分；
  Kimi `inputOther+cacheRead+cacheWrite`；Pi/omp/MiniMax `input(不含cache)/output(含reasoning)`；
  Grok/Droid/WorkBuddy `input 含 cache`；Hermes canonical 非重叠桶。→ 我们 `usage` 层已按 `semantic` 归一，别照抄字段。
- 网关调用排除（避免双重计数）：`ocGatewayProvider`/`piGateway`/`kimiGateway="magpie/"`/
  `mcodeGateway`/`workbuddyGateway`/`grokGateway`/`dshGatewayProvider`/`cindyGatewayProvider`。
  **MAGPIE 作为网关独有的语义，纯档案馆可不要，但「哪条算本地/哪条算网关」的字段语义值得记**（我们 `calls` 层已有 `rejected` 单列的同类纪律）。

## 5. 通用机制（11-05 版行号，逐条做法）

| 机制 | 做法 | 可借鉴 / 代价 | 证据 |
|---|---|---|---|
| tail 增量续读 | `tail{Off,Skip,Size,Head,HeadSize,Hash}`；`holds()` = size 够 + 头同 + `prefixHash` 同；打包文件按帧续 | 只对「单文件持续追加」划算；LESSONS 已否决（窗口过期即整读的税） | `tail.go:5-50` |
| head_hash + prefix_hash 16×4KiB 采样 | `headLen=256`；`prefixHash(path,n)` n>64KiB 用 16 个 4KiB 窗口；`sync.Pool` 复用缓冲；版本标签 `sample-v1:` | 注释自曝盲区「采样窗口外的改写检测不到」；我们 `registry.headHash()` 已采用 | `calls.go:357-370,1231-1270` |
| 按解析策略分三类 | `whole`/`resume`/`line` 三 reader（**不是按 Agent 分**）；`readCalls` 先 resume→whole→line | 新增一家只选一个策略 + 注册；对应我们「按格式分而非按家分」的思路 | `call_cache.go:246-296` |
| per-agent parseVersions | `parseVersions={codex:3,zcode:1}` 写进 cache 头，`decodeCache` 逐条丢（老条目无 agent 名仅当没版本动过才保留），首次刷新补名不丢 | 改一家只重扫一家；我们 `__fingerprints` 已采用（LESSONS 第三轮） | `sessions.go:1119-1141`；`cache_decode.go:33-95` |
| WAL / immutable=1 | `OpenUntouched` 无 `-wal`→`immutable=1`（零写），有 `-wal`→复制 db+wal 再读；stamp 含 `-wal` | **immutable 完全忽略 WAL**（LESSONS 已实测）；我们 `sqlite-read.js` 已采用 | `cursor.go:175-220`；`hermes.go:89-93` |
| 复制 db 再读（Cursor） | macOS `Clonefile`，其他真复制；按 stamp 共享大库副本，`Linger=30s` | 起因：几 GB `state.vscdb` 被复制 5+ 次；我们 `sqlite-read.js` 对应 | `cursor_snapshot.go:13-58` |
| discovery 目录列举缓存 | `(mod,size)` 命中 + 2s racy 守卫 + 16384 上限，只缓存名字 | 5 秒轮询场景；我们已否决（10 分钟 TTL 无此收益） | `discovery.go:11-85` |
| MergeExternal 第二数据源 | 网关 ledger 会话以 `(Agent,ID)` struct 键只读并入，`EachMerged` 惰性归并 | 网关自记录：本地没存也能还原；**对只读档案馆不适用**（了解不抄） | `external.go:11-90` |
| zstd 帧续读 | `frames.go` 按 RFC 8878 帧头定位帧（不解码）从 off 帧续，`WithDecoderLowmem` | dsh 单帧无随机访问（ContentRef 已否决），但**帧级**可续；我们目前整解压 | `frames.go:15-270` |
| 其它 | `sharedCalls`/`callsFlights` singleflight（防 3.9GB 数组并发复制撑到 85GB RSS）；`ccLineType` 先读 1024B 判 type 再解；`cc_copies.go` union-find 处理 fork；`revision_cache` 窗口 5min→1h | 读放大治理，LESSONS/findings 已逐条判过 | `calls.go:165-754`；`revision_cache.go:8-38` |

## 6. 差距：MAGPIE 能认、我们没有的（**已回自己代码核对，见 6.0**）

### 6.0 ⚠️ 核对纠错：两家「被列为缺失」其实我们已经覆盖

**这份报告的差距清单是「按上游注册表 vs 12 款名单」推的，不是「按我们实际代码」推的**，
lead 逐条回 `src/scanners/` 核对后纠正：

| 报告列为「缺」 | 实际 | 证据 |
|---|---|---|
| `qoder-cn`（「已有 qoder，缺中国版第二个根」） | **不缺**：`qoder.js` 的 `configRoots()` 已含 `.qoder-cn`、`QoderCN`、`Qoder CN`、`com.qodercn.app.stable` 等全部变体 | `src/scanners/qoder.js:53-61` |
| `workbuddy-ai`（「没拆国际版」） | **不缺**：`workbuddy.js` 的 `roots()` 已含 `.workbuddy-ai`，且注释写明「同产品另一个客户端」 | `src/scanners/workbuddy.js:57-60` |

→ **别照上游差距清单盲建扫描器**。这两家不进补覆盖面派单。
（另：报告把 `codebuddy` 列为「与 workbuddy 同构、几乎 config 一行」，但我们目前 `workbuddy.js` 的
`roots()` 只认 `.workbuddy`/`.workbuddy-ai`/`WORKBUDDY_CONFIG_DIR`，**没有** `CODEBUDDY_CONFIG_DIR`
或 `.codebuddy`——`codebuddy` 确实缺，且可以用「复用 workbuddy 解析器 + 加一个根」低成本接入。）

### 6.1 缺口清单（按价值/难度，已去掉 6.0 的两家）

| 优先 | Agent | MAGPIE 状态 | 我们缺什么 | 价值/难度 |
|---|---|---|---|---|
| **P0** | **pi**（+omp/raft/cindy 共 4 家） | 会话+调用全有，共用 `piParse` | 全缺：路径、JSONL、usage/compaction/branch 字段、fork 去重 | 高（一套解析 4 家）/ 中低（纯追加 JSONL）；**但 CC Switch 侧 pi 的「会话树/活动分支」是硬骨头，两边要合并看** |
| **P0** | **kimi** | 会话+调用全有 | 全缺：`~/.kimi-code`、`wire.jsonl` 的 `usage.record`、三协议差异、fork 去重、`state.json` | 高（用户量大）/ 中 |
| **P0** | **cline** | 会话全有，调用没接 | 全缺：4 级 env 路径链、`<id>.json`+`<id>.messages.json`、整份重写、fork 截断 | 高（LESSONS 待办早点名）/ 中低 |
| **P1** | **codebuddy** | 会话+调用全有（复用 WorkBuddy） | 与已有 workbuddy 同构，只需加 `CODEBUDDY_CONFIG_DIR`→`~/.codebuddy` 根 + 复用解析器 | 中 / **极低** |
| **P1** | **grok / Grok Build** | 会话+调用全有 | 全缺：`summary.json`+`updates.jsonl`（MAGPIE）/ `chat_history.jsonl`（CC Switch）、turn 按模型拆 Call | 中 / 中 |
| **P1** | **minimax-code / mcode** | 会话+调用全有 | 全缺：`v2/sessions/<日期>/…-session_<b64>`、多代 messages.jsonl | 中 / 低 |
| **P1** | **agy CLI 变体** | 会话+调用全有 | 半缺：我们 `antigravity.js` 只读桌面版 `~/.gemini/antigravity`，缺 CLI 变体 `antigravity-cli/brain/...`（LESSONS:93/113 已记路径缺口） | 中 / 低 |
| **P1** | **claude-desktop / Cowork / MSIX** | `callFileLists` 全有 | 全缺：Desktop 多目录、`local_<id>.json` 血缘、Cowork | 中高（桌面版用户多）/ 中（目录发现最碎） |
| **P2** | **droid / Factory** | 会话有、调用无 | 全缺：`~/.factory/sessions`、单一累计 tokenUsage | 中低 / 中 |
| **P2** | **alma** | 会话有（SQLite WAL 只读） | 全缺：`chat_threads.db` 树形消息 | 低 / 中高（SQLite 树形+触发器） |
| **P2** | **gemini (CLI)** | `Found()` 有 `geminiTmpDir()` | 全缺：`~/.gemini/tmp/*/chats/*.json`（CC Switch 侧是回放日志 JSONL，难度低） | 中 / 低 |
| **P2** | **WSL（跨 6 家）** | `wsl.go` 通用兜底 | 全缺：`\\wsl.localhost` 列举、cold distro、软链重映射 | 取决于有没有 WSL / 高（Windows 特有） |
| **P2** | **cursor editor protobuf** | `cursor.go` 全有 | 已有 cursor，但缺全局 `state.vscdb` 单库多聊天 + `pbFields` 无 schema 解析 | 中 / 高（protobuf 逆向） |
| **P3** | **cindy** | 会话+调用全有（11-05 新增），复用 Pi 解析 | 复用 Pi 后极低 | 低（新 App 实测有无未证实）/ 极低 |

### 6.2 四家「没适配/半截」的真实状态（11-05 核实，别排期错）

| 家 | 真实状态 |
|---|---|
| **Trae / Trae CN** | **完全没适配会话读取**。全仓只在模型 effort 别名举例、VS Code fork 目录名举例出现；无独立 constructor、无 `internal/sessions/trae.go`、无 `Found()`、无 `callSources`。与 10-21 调研一致 |
| **Windsurf** | **完全没适配**。只在 VS Code fork 目录名举例、Cline 扩展测试里出现 |
| **Kiro** | **只做半截：能改配置/接管，不能读会话**。配置层完整（`kiroCrew` + `targets.go` Kiro CLI skills/MCP），但 `targets.go:830-844` 自己写「Kiro CLI is no agent magpie wires a model into」；`Found()`/`callSources()`/`internal/sessions/` 里都没有 kiro。**我们 12 款里反倒有 kiro 扫描器**——别照 MAGPIE 给 Kiro 定优先级 |
| **Cline** | 只做半截（另一方向）：能读会话、能改配置，**没接调用记录**（Cline 是「会话层与调用层两张独立注册表」的活例） |

> **Trae / Windsurf / Kiro 会话不用排期**：MAGPIE 自己也没读到（前两家完全没适配、Kiro 只在配置层）。
> `doctor.js` 已把 Windsurf/Trae/Cline 标 `blocked`（加密或空），口径一致，保持「如实报读不了」。

### 6.3 两家信息来源的冲突（补之前要合并，别只信一边）

| 家 | CC Switch 说 | MAGPIE 说 | 处理 |
|---|---|---|---|
| grokbuild 正文 | 固定名 `chat_history.jsonl` | `updates.jsonl`（11-05 新增） | **两个文件都可能真实存在**（不同版本/用途），扫描器要都认，别只写一个 |
| pi 难点 | **会话树 + 活动分支投影**（`latest_id` 沿 `parentId` 回溯，隐藏撤销轮次） | fork 复制父 entries、按 id+time 去重、usage 字段 | 两边侧重不同：CC Switch 管「列会话/正文」、MAGPIE 管「抽调用」。我们做只读档案馆以 CC Switch 的树投影为准，MAGPIE 的字段语义补细节 |
| kimi | `state.json` + `agents/main/wire.jsonl` + `agent.switched` 分支 | `sessions/<slug>/<id>/agents/<a>/wire.jsonl` + 三协议差异 | 路径与字段互补，合并 |
| Claude/Codex 环境变量 | 会话扫描**不读** `CLAUDE_CONFIG_DIR`/`CODEX_HOME` | 密集环境变量覆盖经 `appdir.Getenv()` | 我们是超集（多候选），保持，别照 CC Switch 砍 |

## 7. 最可直接落地的三条

1. **`callSources()` 是「调用记录」注册表，不是「会话」注册表**——10-21 调研记反了。
   会话层（`Found()`+`xxxFiles()`+`parseXxx()`）与调用层（13 项 lists + 三类 reader + `readXxxCalls()`）
   是两张表，漏登记会静默不读（Cline 活例）。对应我们：每家必须同时写本机 `discover()` 与
   显式源 `structureSpec`+`discoverWithin()`，漏一套就在某条入口静默消失。
2. **同源复用是覆盖面广的第一杠杆**：ZCode=OpenCode、Qoder=Claude、WorkBuddy/CodeBuddy 共用、
   Pi/omp/raft/cindy 共用。我们已有 workbuddy/qoder/zcode，握着 4+ 家免费扩展点
   （**但先按 §6.0 回自己代码核对，qoder-cn/workbuddy-ai 已覆盖，别重复建**）。
3. **格式坑集中在「能不能续读」**：`whole`（库/整份重写）/`resume`（zstd 帧）/`line`（只追加）
   三分类 + `OpenUntouched`（无 wal 才 immutable，有 wal 复制 db+wal）+ `sample-v1` 16×4KiB 采样哈希
   + per-agent parseVersions，是补任何一家前应先具备的骨架（我们 `registry`/`sqlite-read`/`lines` 大多已有）。

## 8. 未核实 / 下一轮

1. `magpie ls` 在 11-05 单机实际输出几个（没跑二进制）；19 = 10-21 单机 `Detected()` 实测数。
2. `desktopdir.Everywhere()` 的 MSIX 具体路径未逐行读。
3. `internal/gateway/` 会话自记录存储、`MergeExternal` 的 external 具体来源只到接口层。
4. `cursor_editor.go` 的 `state.vscdb` 全局库字段只看了 WAL/复制段落。
5. commits 只取 `per_page=10`；但所有结论以 `FETCH_HEAD` 文件级内容为准，文件级证据可靠。
6. shallow depth 250，`rev-list` 可能被浅边界截断，未做提交级归因。
7. 建议把 `sources.json` 的 magpie commit 更新为 `2488532257daeb79605567d44898925bf47942f2`。
