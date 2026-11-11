# CC Switch 会话识别/读取逻辑：全量梳理（2026-11-05）

> 本文是**覆盖面研究**的原始取证，不是采纳清单。判断与去向见 [`../LESSONS.md`](../LESSONS.md)，
> 与 MAGPIE 侧的差集合并后才构成完整的「补覆盖面」清单。
> 上游 pin：`7afceec1`（2026-11-03）；本轮核到 `ca58c031`（2026-11-04，#9181）。

## 0. 取证口径（先固定证据是哪一版）

- 本地 sparse 镜像 `%USERPROFILE%\.agent-archive\upstream-cache\cc-switch` 已 `fetch` 到
  `FETCH_HEAD=ca58c031`。9 个新提交全是 UI/DB 批处理/预设默认值/打包，
  **`git diff --stat 7afceec1..FETCH_HEAD -- src-tauri/src/session_manager/` 为空**，
  `git status --porcelain` 干净。
  → 本文所有 `session_manager/` 下的 `file:line` **对 pin 与当前 main 都有效**。
- `research/reference-src/cc-switch/` 是 2026-10-21 节选，**已过时**（12 文件，缺 dsh/kimi/omp）。
- 仓库根 `session-manager.md` 是 v1 PRD（只写 Codex/Claude、只 macOS），**不是现架构**。

## 1. 两个集合必须分清（本项目此前一直混着）

| 集合 | 数量 | 出处 |
|---|---|---|
| **能读会话** | **13** | `session_manager/providers/` 每家一模块；`mod.rs:61-97` 汇流 |
| **能改配置/供应商切换** | **14** | `app_config.rs:466-486` 的 `AppType`；`commands/config.rs:68-193` |

两集合差集只有 `Claude Desktop`（只改配置、不读会话）。

### 1.1 「19 个」是 MAGPIE 的数，不是 CC Switch 的 —— 台账纠错

2026-10-21 调研（[`跨Agent会话识别与记忆中间件研究.md`](../../../docs/跨Agent会话识别与记忆中间件研究.md):102）
写「`magpie ls` 识别出 19 个 Agent 的设置文件」，那份清单
（Claude Code / Claude Desktop / Codex / OpenCode / Pi / Cursor CLI / VS Code /
DSH / Command Code / Devin / Hermes / Cline / Qoder / Qoder CN / ZCode /
WorkBuddy / WorkBuddy AI / CodeBuddy Code / Lody）**属于 MAGPIE**。
CC Switch 配置层实测 **14**、会话层 **13**。以后别把「19」套到 CC Switch 上。

### 1.2 会话层 13 家（provider_id → 模块 → 扫描方式 → 恢复命令）

| # | id | 模块 | 扫描 | resume |
|---|---|---|---|---|
| 1 | codex | codex.rs | 线程 | `codex resume <id>` |
| 2 | claude | claude.rs | 线程 | `claude --resume <id>` |
| 3 | opencode | opencode.rs | 线程 | `opencode -s <id>` |
| 4 | openclaw | openclaw.rs | 线程 | 无（网关管理） |
| 5 | gemini | gemini.rs | 线程 | `gemini --resume <id>` |
| 6 | hermes | hermes.rs | 线程 | 无 |
| 7 | grokbuild | grokbuild.rs | 线程 | `grok --resume <id>` |
| 8 | pi | pi.rs | 线程 | `pi --session <path>` |
| 9 | omp (Oh My Pi) | omp.rs | 线程 | 带 env 前缀 |
| 10 | mcode (MiniMax) | mcode.rs | 同步 | `env MINIMAX_DATA_DIR=… mcode --session <id>` |
| 11 | kimi | kimi.rs | 同步 | `kimi --session <id>` |
| 12 | dsh | dsh.rs | 同步 | 无（明确只读） |
| 13 | agy (Antigravity) | agy.rs | 同步 | `agy --conversation=<id>` |

> 旧调研写「10 个 provider」，**少算 dsh / kimi / omp 三家**。

## 2. 注册表与扩展机制

- 入口 `scan_sessions()`（`mod.rs:60-106`）：`std::thread::scope` 起 **9 个线程**
  （codex/claude/opencode/openclaw/gemini/hermes/grokbuild/pi/omp），同步追加
  mcode/kimi/dsh/agy，最后按 `last_active_at ?? created_at` 倒序。
  9 个线程都是 `hN.join().unwrap_or_default()`（一家 panic → 空列表）。
- `load_messages`（`:108-136`）、`delete_session_with_roots`（`:229-241`）、
  `provider_roots`（`:244-259`）都是**按 provider_id 字符串分派**的 `match`。
- 每家 provider 契约（不是 trait，是一组自由函数）：
  `scan_sessions()` / `load_messages()` / `delete_session()` / `session_roots()` /
  `SessionMeta.resume_command`；SQLite 变体另需 `load_messages_sqlite` 等。
- **新增一家要动 5 处字符串分派** + `content.rs` / `cache.rs` 的旁挂分支
  + 配置层 6 处 `match` + 契约夹具。**没有 trait、没有数据驱动的会话路径表。**
- 「低成本」来自**共享件**而非注册表：`utils.rs`（FileParseCache / read_head_tail_lines /
  LineSpans / parse_timestamp_to_ms / extract_text）、`blocks.rs`、`content.rs`、
  `cache.rs`、`model.rs`。新家只写「找文件 + 转 JSON」。
- **唯一接近数据驱动的是 `Dialect`**（pi.rs:56-76）：把 provider_id / resolve_root /
  resume_command / title_slot / model_selector 做成结构字段，让 **Pi 与 Oh My Pi 共用整份解析器**
  （omp.rs 只定义 4 个行为位）。接「某家的 fork」时这才是低成本路径——我们补 omp 时可照此。

## 3. 逐家规格（路径 / 格式 / 关键字段 / 坑）

### 3.1 根路径、环境变量、平台差异

| 家 | 根路径规则 | 环境变量 / 覆盖 | 平台差异 |
|---|---|---|---|
| claude | `<claude_config_dir>/projects/*.jsonl` | settings 覆盖；**会话扫描不读 `CLAUDE_CONFIG_DIR`** | 三平台 `~/.claude`；Windows 用 FOLDERID_Profile，**刻意不用 HOME** |
| codex | `<codex_dir>/sessions` + `archived_sessions` | settings 覆盖；state 库另认 `config.toml:sqlite_home` + `CODEX_SQLITE_HOME` | 跳过 WSL UNC 上的 state 库 |
| opencode | `$XDG_DATA_HOME/opencode/opencode.db`，否则 `~/.local/share/opencode/opencode.db` | `OPENCODE_DB`、`XDG_DATA_HOME` | **注释明说不遵守 macOS/Windows 约定，全平台 `~/.local/share`** |
| openclaw | `~/.openclaw/agents/*/sessions/*.jsonl` | settings `openclaw_config_dir` | 统一 |
| gemini | `~/.gemini/tmp/<hash>/chats/session-*.json(l)`；项目从 `tmp/<hash>/.project_root` 读 | settings `gemini_config_dir` | 统一 |
| hermes | `<hermes_dir>/state.db` + `sessions/*.jsonl` | settings > `HERMES_HOME`（trim 非空、不展开 `~`）> 默认 | **唯一显著平台分支**：Win `%LOCALAPPDATA%\hermes`，其余 `~/.hermes`；Win WSL 走 Python helper |
| grokbuild | `~/.grok/{sessions,archived_sessions}`，递归找 `summary.json` | settings `grok_config_dir` | 统一 |
| pi | `~/.pi/agent/sessions` 或 `PI_CODING_AGENT_SESSION_DIR` / settings `session_dir` | `PI_CODING_AGENT_DIR` 等；**相对路径明确拒绝全局枚举** | settings `pi_config_dir` |
| omp | `PI_CODING_AGENT_SESSION_DIR`（绝对才收）否则 `<omp_data_dir>/sessions` | `OMP_PROFILE`/`PI_PROFILE`/`PI_CONFIG_DIR`/`XDG_DATA_HOME` | **linux/macos 才有 XDG/profile 分支**，Windows 直接 `agent` |
| mcode | `<data_dir>/v2/sqlite/runtime-state.sqlite` | `MINIMAX_DATA_DIR` > `MAVIS_DATA_DIR` > `~/.minimax` | 恢复命令按平台分 |
| kimi | `<data_dir>/sessions/<workspace>/<id>/` | `KIMI_CODE_HOME` > `~/.kimi-code` | 恢复命令分 POSIX / PowerShell |
| dsh | `$DSH_HOME/sessions`，否则 `~/.dsh/sessions` | `DSH_HOME` | 统一；**CC Switch 没有 `~/DeepSeekHarness` 候选**（我们是超集） |
| agy | `~/.gemini/antigravity-cli/brain` + `~/.gemini/antigravity/brain` + 私有 `~/.cc-switch/agy/<provider>/…/brain` | `--gemini_dir` | 统一 |

> 全仓无 `Application Support` 字样 → LESSONS:116「未核对」可结论：
> **CC Switch 不用 macOS Application Support**，靠 `~/.xxx` + xdg。

### 3.2 格式与关键字段

| 家 | 格式 | 关键字段 | 父子/分支 |
|---|---|---|---|
| claude | 明文 JSONL | `sessionId`/`cwd`/`timestamp`/`message.role`/`content`；`relocated`+`relocatedCwd` | 子代理文件排除 |
| codex | `rollout-*.jsonl[.zst]` | `payload.id`/`cwd`/`timestamp`；外部 `session_index.jsonl` + `state_5.sqlite:threads.title` | `source.subagent.thread_spawn.parent_thread_id` |
| opencode | SQLite V1 `session/message/part` / V2 `session_v2/session_message` | `id/title/directory/time_*`；`sqlite:<db>:<ses_…>` | `kv.migration.v1-v2` 标记 |
| openclaw | JSONL（与 Pi 同构，复用 `PiTranscript`） | `type=session` 的 `id`/`cwd`/`timestamp`；`sessions.json:displayName` | 无树形分支，按文件顺序全取 |
| gemini | 旧 `.json` 单对象 / 新 `.jsonl` **回放日志** | `sessionId`/`startTime`/`messages[]`；行含 `id`/`$set`/`$rewindTo` | 按 id 原位 upsert、`$rewindTo` 截断 |
| hermes | `state.db:sessions`（列用 pragma 动态取）+ 旧 jsonl | `\u{0}json:` 正文前缀 | `SQLITE_SCAN_LIMIT=500` |
| grokbuild | `summary.json`（元数据）+ `chat_history.jsonl`（正文，固定名） | `info.id`/`info.cwd`/`generated_title`/`*_at`；正文 `type ∈ {system,user,assistant,tool}` | — |
| pi | 单文件 JSONL **会话树** | 首行 `type=session` `{id,cwd,timestamp,version,title}`；entry 有 `id`/`parentId` | 从 `latest_id` 沿 `parentId` 回溯 `active_entry_indexes`，带环检测 |
| omp | 同 Pi，`Dialect` 差异：首行可能是 `{"type":"title"}`、`model_change` 用单串 | 同 Pi | 同 Pi |
| mcode | SQLite `runtime-state.sqlite` | `local_runtime_sessions`；两代消息表靠 `…_migrations` 判定 UNION | 过滤 `parent_session_id IS NULL`、`session_kind NOT IN('peek','channel','cron')` |
| kimi | `state.json` + `agents/main/wire.jsonl` | `title`/`lastPrompt`/`cwd|workDir`/`createdAt`/`updatedAt`/`archived` | `agent.switched` 分支切换 |
| dsh | `session.vN.jsonl[.zstd]`，**zstd 多独立帧** | 首行 `id`/`cwd`/`createdAt`；`user/message`/`assistant/message`/`tool/result` | `surfaceOp=replace` 跳过、按 id 去重 |
| agy | `.system_generated/logs/transcript_full.jsonl` + `conversation_summaries.db` | transcript 行 `step_index`；索引表 `conversation_id/title/workspace_uris/…` | 多根同 id 按「有 transcript 者优先」去重 |

### 3.3 我们缺的那几家，坑在哪

- **gemini**：新版 `.jsonl` 是 `loadConversationRecord` 的**回放日志**（`$set` 合并/整体替换
  messages、`$rewindTo` 删该条及之后、带 id 行原位 upsert），不是普通 JSONL；
  旧 `.json` 与新 `.jsonl` 同名共存时**只认 `.jsonl`**；标题要跳过 `/`、`?`、
  `<session_context>`/`<hook_context>` 注入。→ 路径 + 回放语义 + 字段语义三缺。
- **pi / omp**：**会话树 + 活动分支**——只投影 `latest_id` 回溯链上的 entry，被撤销/分叉的
  轮次必须隐藏。上限 `MAX_TREE_ENTRIES=500k` / `MAX_SESSION_BYTES=128MiB`。相对 sessionDir
  故意不可全局枚举。→ 唯一真正的硬骨头；omp 可用 `Dialect` 顺手带出。
- **openclaw**：复用 Pi 的 block 映射但**无分支**；要剥尾部 `\n[message_id: …]` 网关注入；
  标题 `sessions.json:displayName` > 首条 user > cwd basename。→ 难度低。
- **grokbuild**：**sourcePath 是 `summary.json`，正文在固定名 `chat_history.jsonl`**，
  指纹与正文指针都要特判；`reasoning` 记录不当对话；活跃文件可达数十~上百 MiB，
  需逐行上限（上限加在记录粒度，别加在文件粒度）。→ 元数据/正文分离。
- **mcode**：SQLite 有两代消息表，靠 `local_runtime_message_row_migrations` 走 UNION；
  `source_path` 是 `mcode:<id>` 而非文件路径。
- **kimi**：元数据 `state.json`、正文 `wire.jsonl` 双文件 + `agent.switched` 分支语义。
- **agy**：**从不写二进制会话库**，只读导出 transcript + 索引库；索引-only 会话能列出
  但没正文。→ 我们已有 antigravity，但**路径缺口**：CLI 变体 `antigravity-cli/brain`
  与私有 `--gemini_dir`（LESSONS:93,113 已标，本轮确认）。

### 3.4 恢复/删除是否写（我们是只读档案馆，只取字符串）

| 家 | 删除 | 写? |
|---|---|---|
| dsh / agy / mcode | **明确拒绝** | 全只读 |
| openclaw / hermes / kimi / opencode / pi / omp / claude / codex / gemini / grokbuild | 删文件/删行 + 改索引 + tombstone | **写** |

`resume_command` 只是 `SessionMeta` 里的字符串；`terminal/mod.rs` 会真的拉起终端执行
（macOS 上有副作用）。对只读档案馆只取字符串即可。

## 4. 通用机制（可借鉴，标注已采用/空白）

| 机制 | 上游 | 我们 |
|---|---|---|
| L1 FileParseCache：键=路径、命中=`mtime && size`、**失败不缓存下轮重试**、外部标题缓存后再叠加 | utils.rs:17-93 | 已采用（LESSONS:51） |
| L2 TranscriptCache：双限 LRU（8 条 / 96 MiB）、按指纹失效 | cache.rs:17-282 | 已有 `transcript-cache.js`（LESSONS:175） |
| 指纹：`Fingerprint{modified,len}` merge、目录源并一级子项、SQLite 并 `-wal`、**旁挂正文**（Grok `chat_history.jsonl`、OpenCode `part/`） | cache.rs:52-175 | `-wal` 已纳入；**旁挂正文仍是空白**（补 grokbuild 时要一起做） |
| `resolve_under_roots` + `safe_join` + SQLite `(provider,表,列)` 白名单 | content.rs:78-509 | `assertUnder` 已做，SQL 靠硬编码等价 |
| `read_head_tail_lines` 丢接缝半行；Claude 用 64 KiB 尾窗找 `relocated` | utils.rs:101-139 | 已有 `headtail.js` |
| 逐行读 + 单行 8 MiB 上限（**上限加在记录粒度**） | utils.rs:261-330 | 已采用（LESSONS:378,462） |
| 旁路表修正：Codex 标题 = `session_index.jsonl` + `state_5.sqlite`，SQL 排除「title==首条 user」、打开带 `busy_timeout(2s)` | codex.rs:99-194 | 已采用；**目录多候选**比文件名写死更值得补 |
| 契约夹具：Rust 往返逐字节相等 + TS `Spec<T>` 编译期绑定类型 | model.rs:605-649 / sessionFixtures.test.ts | 已有两类夹具；编译期绑定不适用（JS） |
| ContentRef 惰性指针 / TurnIndex 流式下发 | model.rs:329-354 / cache.rs:286-317 | 前者已否决（zstd 单帧），后者已切首屏 200 条 |
| `Dialect` 让 Pi/omp 共用解析器 | pi.rs:56-76 | **值得抄**：补 fork 型 Agent 时省一整份解析器 |

## 5. 差距：CC Switch 侧我们缺的 7 家（+1 仅配置）

排序按「格式可复用性 + 生态常见度」粗排，**本机是否真有这些数据未核实**，
落地前先跑一次 `doctor`/反向发现定优先级。

| 序 | 家 | 价值 | 难度 | 缺什么 |
|---|---|---|---|---|
| 1 | **gemini / Gemini CLI** | 高（官方 CLI、JSONL 最易） | 低 | 路径 + 回放语义 + 字段语义（三者全缺） |
| 2 | **pi** | 中高（及其分支共用解析器） | **中高** | 路径 + **会话树/活动分支投影**（最难） |
| 3 | **openclaw** | 中 | 低 | 路径 + `sessions.json` 索引 + `message_id` 剥离 |
| 4 | **grokbuild** | 中 | 低-中 | 路径 + 元数据/正文分离（指纹带旁挂）+ 字段 |
| 5 | **kimi / Kimi Code** | 中 | 中 | 路径 + `state.json`/`wire.jsonl` + 分支 |
| 6 | **mcode / MiniMax** | 中 | 中 | 路径 + SQLite 两代消息表 UNION |
| 7 | **omp / Oh My Pi** | 低-中 | **低**（先做 Pi 后只 `Dialect`） | 路径 + 标题槽 / `model_change` 单串 |
| — | Claude Desktop | 低 | — | **只在配置层**，CC Switch 也不读它会话，不计入补扫描器 |

### 5.2 反向差集：CC Switch 学不到、得靠 MAGPIE 或自研

`zcode` / `qoder` / `cursor` / `copilot` / `kiro` / `workbuddy` 六家——CC Switch 会话层没有。
（这六家我们恰好都有。）

### 5.3 别照抄：CC Switch 也不比我们全的地方

- **环境变量覆盖**：CC Switch 会话扫描只读自己 settings 的 `*_config_dir` + `~/.claude`/`~/.codex`，
  **不读 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`**。我们的 `codexDirs()`/dsh 多候选是超集。
- **DSH**：CC Switch 只有 `DSH_HOME` + `~/.dsh`，**没有 `~/DeepSeekHarness`**（Windows 桌面版默认）。
- **Antigravity**：CC Switch 不解析二进制/protobuf，反而比我们多认 CLI 变体路径（该补）。
- 「19」是 MAGPIE 的，别套到 CC Switch。

## 6. 未核实 / 边界（不编）

1. Grok 的 `tool_calls` 配对形状：上游注释自标「按 OpenAI 形状推断（待核实）」。
2. Claude Desktop 配置库路径未细读（本轮不需要）。
3. omp 的 `native_agent_dir()` 完整分支未逐行核（不影响主结论）。
4. `services/session_usage_*.rs` 写库逻辑未通读（沿用 11-03 findings）。
5. 各源在 Windows/macOS/Linux 的真实落盘未真机验证（我们只在 Windows 实测过）。
6. 9 个新提交只看了 message + `--name-status`；但 `session_manager/` diff 为空是 `diff --stat` 直接确认的。

## 7. 一句话结论

CC Switch 会话层 = **13 个 provider 模块 + 5 处字符串分派 + 一组共享件**，没有 trait、
没有数据驱动的会话路径表；「19」是 MAGPIE 的数，它的配置层只有 **14 个 AppType**。
对我们最有价值的是把 **7 家（gemini / pi / openclaw / grokbuild / mcode / kimi / omp）**补进来，
其中 gemini、openclaw、grokbuild、mcode 是「路径+格式+字段三缺但难度低」，
**pi 的会话树是唯一硬骨头**；omp 可在 Pi 之后用一个 `Dialect` 顺手带出。
