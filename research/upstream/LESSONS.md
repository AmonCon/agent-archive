# 上游参照台账

三个参照项目里我们**读过、判断过**的东西，以及采用了哪些。
配套脚本：`node research/upstream/refresh.mjs --diff`（只看新变化）。

目的很实际：MAGPIE 每天在改，靠反复通读来跟进不现实，而且每次重读都会重新
推导同一批结论。所以这里记的是**判断结果**，不是代码转述——下次只需复核变化
的部分，以及"pending"那几条是否还值得做。

状态取值：

- **已采用** — 落到代码里了，括号内是位置
- **pending** — 判断有价值但还没做
- **不适用** — 我们不写用户文件、不转发请求、不做多租户，那类能力不该抄
- **已否决** — 曾经考虑，结论是不要（写明为什么，避免下次重新纠结）

---

## MAGPIE（个人版模型网关，更新极快）

| 事项 | 判断 | 去向 |
|---|---|---|
| 头部 256B + 16×4KiB 采样哈希判断"文件是否被改" | 已采用 | `registry.js` 的 `headHash()`；只对 stat 未变的文件算，避免翻倍开销 |
| `(size, mtime)` 拼 revision，覆盖 WAL 被 checkpoint 截断 | 已采用 | `scanners/*.js` 的 `extraFiles()` + `registry.js` 的 `stampOf()` |
| SQLite 每会话聚合指纹，避免整库重解析 | 已采用 | `scanners/hermes.js`；`sum(rowid)` 代替 `total(length(content))`（后者实测 203ms，反而不如全表 117ms） |
| 无 `-wal` 用 `immutable=1`，有 `-wal` 复制 db+wal 再读 | 已采用 | `sqlite-read.js`；实测 `immutable` 会完全忽略 WAL（连表都看不见） |
| 目录列举缓存 + "racy" 守卫（目录 mtime 精度粗） | pending | 现在 2421 文件全量 readdir + stat，热扫 1.4 秒；收益中等 |
| 按解析策略分三类（tail / whole / fingerprint）而非按 Agent 分 | pending | 我们目前是"按文件整读 + 缓存"，够用；做增量阅读时才需要 |
| 单飞（并发读同一批文件合并） | 已否决 | 扫描是同步的、无 await，Node 单线程下天然不并发 |
| WSL 冷发行版不打开、异步列举、落盘缓存 | pending | 只在用户有 WSL 数据时才有意义；属于"给别人用"的覆盖面 |
| `lessons.md` 式复盘账本（规则+原因+证据+天数，3 天升级为规范） | 已采用（部分） | 就是本文件的组织方式 |

## cc-switch（供应商切换器，Tauri + Rust）

| 事项 | 判断 | 去向 |
|---|---|---|
| 旁路表取真值：`state_5.sqlite` 的 `updated_at`/`title` | 已采用 | `scanners/codex.js` 的 `enrich()`；实测 `updated_at` 偏差 1 秒，mtime 平均 507 秒 |
| tail 读取补长文件被截断的结束时间 | 已采用 | 明文 `.jsonl` 读尾部 64KB（`.zst` 单帧，尾部解不开） |
| 逐家模块 + 字符串分派（无 trait 也够用） | 已采用 | `registry.js` 的 `scanners` 数组 |
| L1 列表缓存：**失败不入缓存**，每轮重试 | 已采用 | `registry.js`；失败时沿用旧指纹，下一轮必然重试 |
| ContentRef 惰性全文指针（大 transcript 不整传） | 已采用（等价物） | `mcp.js` 的 `read_session` offset/maxChars 分段 |
| `resolve_under_roots` + `safe_join` + SQLite 表列白名单 | 已采用（部分） | `messages.assertUnder/assertUnderAny`；SQL 白名单未做（我们的 SQL 是硬编码的） |
| 契约式测试：fixture + 不变量 + 漂移样本 | pending（**最高优先**） | 见下方"待办" |
| 两级缓存（列表 + 正文 LRU） | pending | 我们只有扫描结果缓存；同一场会话每次 `cat` 都重解析 |
| 会话删除/回收站 | 不适用 | 只读档案馆不提供删除 |
| 拒删策略（无可靠删除语义就明确拒绝） | 不适用（同源） | 我们根本没写路径 |
| `live/` 配置补丁引擎、floor 字段、备份 | 不适用 | 存在前提是"改用户配置文件" |

## AutoSwarm（多 Agent 编排）

| 事项 | 判断 | 去向 |
|---|---|---|
| 状态由事实推导，不写状态机/数据库/心跳 | 已采用（思路） | 我们的缓存按内容指纹判定，不维护"已处理"标记 |
| 原子发布：tmp + fsync + rename | 已采用 | `registry.saveCache()` |
| 进程身份用 (pid, 创建时间) 防 PID 复用 | 不适用 | 我们没有长驻子进程 |
| 能力协商后再用，缺能力明确报错不降级 | 已采用 | doctor 的"已调研、确认读不了"与"还没做"分开报 |
| 明确的"不做"清单（不评审、不重试、不压缩上下文） | 已采用（思路） | README 的边界章节 |
| 可编程假 CLI 做端到端协议测试（`fixtures/provider.py`） | pending | 对应我们的"假存储 fixture" |
| 三级判定：found / parsed / readable / verified | 已采用（部分） | doctor 的覆盖率 + `emptied`/`keptStale`；`verified` 等价物是正文抽样 |
| 未知事件隔离并持久化成诊断（不崩、不装懂） | 已采用（部分） | `failures` 计数 + 保留上次结果；还没有"原始样本留存" |
| 宿主 hook、审批中继、写原生配置 | 不适用 | 执行器的必要复杂度，对我们是攻击面 |

---

## macOS 路径交叉核对（2026-10-28，来源：magpie 源码）

我们只在 Windows 真机跑过。既然 magpie 是跨平台的，就逐家拿它的路径规则对照——
这是目前唯一能在没有 Mac 的情况下验证"我们对 macOS 的假设对不对"的办法。

magpie 的组织方式值得注意：路径函数都接受 `GOOS` 参数（`ZCodeHomeOn(goos, home)`），
并有同名 `_test.go` 遍历 `darwin`/`windows` 断言结果。这和我们给 `platform.js`
加平台注入是同一个思路，可以互相印证。

| Agent | magpie 的规则（含源码注释里的实测记录） | 我们的做法 | 结论 |
|---|---|---|---|
| Hermes | `$HERMES_HOME`，否则 Windows `%LOCALAPPDATA%\hermes`、其余平台 `~/.hermes` | 同样三条候选 | ✅ 一致 |
| Claude Code | `$CLAUDE_CONFIG_DIR`，否则 `~/.claude`（三平台相同） | 一致 | ✅ |
| Qoder | `$QODER_CONFIG_DIR` | 一致 | ✅ |
| DSH | `$DSH_HOME`，否则 `~/.dsh` | 多探 `~/DeepSeekHarness`（Windows 桌面版默认） | ✅ 超集 |
| ZCode | **CLI 数据库固定在 Go 的 home**（Windows 是 `USERPROFILE`），**不跟随** `HOME` 覆盖，也不跟随用户改的数据存储路径 | `os.homedir()/.zcode/cli/db/db.sqlite` | ✅ 一致，且**不该"修"** |
| Cursor | 快照多 GB 库时 macOS 走 APFS `clonefile`，其他平台真复制 | 复制 db+wal（现已改用 `COPYFILE_FICLONE`） | ✅ 已改 |
| Antigravity | 读 `~/.gemini/antigravity-cli`（CLI 变体，`.system_generated/logs/transcript_full.jsonl`） | 只读 `~/.gemini/antigravity`（桌面版索引库） | ⚠️ **覆盖缺口** |

### 那条"看起来该修、实际不能修"的

ZCode 的注释里有一句实测记录，直接否掉了一个看似合理的改进：

> ZCode 3.14.3 for Windows, run with both, wrote `cli\db\db.sqlite` under
> USERPROFILE and `v2` under HOME.

也就是说：ZCode 应用本身会在 `$HOME`（用户可能为 Git Bash/MSYS2 设过）下写配置，
但**它会话数据库永远在 `USERPROFILE\.zcode\cli\db`**。如果照着"应用数据应该在
HOME 下"的直觉去改，Windows 上反而会读不到。

同样，ZCode 设置里可以改"数据存储路径"（`dataBaseDir`），但那影响的是
`.zcode/v2` 的配置与登录，不是 CLI 的会话库。

**这两条只有读源码才知道，光看"平台惯例"一定会猜错。**

### 还没解决的

- `~/.gemini/antigravity-cli` 的格式没读过。它和桌面版的 `conversation_summaries.db`
  是两个位置，可能同时存在。要补的话得先弄清 `transcript_full.jsonl` 的结构。
- cc-switch 的 session_manager 没有出现 `Application Support` 字样，说明它的
  macOS 路径可能走另一套抽象（或它只支持固定的几家）。**未核对**。

---

## 2026-10-30 第二轮深读（magpie `ace8ee1` / cc-switch `9941a64`）

这一轮读的是**完整源码**（magpie 6830 文件、cc-switch 1802 文件），不再是
`reference-src/` 里的节选。三条最重要的判断修正：

1. **magpie 的 `internal/handoff` 不是跨 Agent 接力**，而是进程升级时用
   `SCM_RIGHTS` 交接监听 socket（`handoff.go:1-13`）。我们的 `handoff` 命令
   与它同名不同义，别按它的模型改。真正的接力逻辑在 `sessions.Carry` 与
   `carry_convert.go`。
2. **cc-switch 会吞掉单家解析失败**：`join().unwrap_or_default()`
   （`session_manager/mod.rs:72-80`）把一家 panic 变成"空列表"，界面看不出来。
   这是我们"失败要如实报数"的反例，不要学。
3. **cc-switch 的 Codex state db 文件名写死** `state_5.sqlite`
   （`codex_state_db.rs:16-19`），注释自认每次 Codex 升级都要改。我们的
   `sqlite-read.findVersionedDb()` 按前缀取最高版本，这一点我们更强。

### 本轮新增判断

| 事项 | 判断 | 证据 | 去向 |
|---|---|---|---|
| 分叉/复制会话去重（Claude `--fork-session`、`/branch` 会整段复制历史） | **已采用（2026-10-30）** | magpie `cc_copies.go:52-188`：按首消息 uuid / compaction uuid 做 union-find，复制品不单列、只补差异用量；分叉记 `branch` 并挂到主会话 | `model.js` 加 `copyOf`/`branchOf`；`claude-code.js` 的 `postProcess` 聚组，`start` 最早者为原件；`mainOnly` 排除复制品；索引跳过复制品；doctor 单列计数 |
| tail 增量续读 | **已否决（本轮）** | magpie `sessions/tail.go:16-50`：`Off + Size + 头部哈希 + 前缀哈希` 判定只追加，否则整读 | 先量了成本：热扫 2.17s 里约 0.7s 是每个文件算头哈希，不是解析。改用 ctime 判据后热扫 1.02s，零额外 IO。tail 只对"单文件持续追加"有优势，留到真有 50MB 级活跃文件时再做 |
| 目录列举缓存 + 批量 stat | **已否决（本轮）** | magpie `discovery.go:33-56`（按目录 mtime/size 缓存，2 秒 racy 窗口） | 我们的 `scanCached()` 已有 5 分钟 TTL，readdir 每 5 分钟才一次；每次扫描的成本在逐文件 stat/头哈希，不在目录列举。magpie 的收益来自它 5 秒刷新循环，场景不同 |
| **日期口径统一** | **已采用（2026-10-30）** | `cli.js:231`、`export.js:69`、`query.js:179`、`digest.js:221` 用 `toISOString()` 取 **UTC 日**；`web/format.js:28`、`usage.js:620` 用**本地日**。东八区 00:00–08:00 的会话在终端与网页会落到相邻两天 | `model.dayKey()` 统一走本地日；CLI/导出/摘要/查询/网页/用量六处全部替换，测试锁住 00:30 不漂移 |
| **状态目录两处绕过 `statePath`** | **已采用（2026-10-30）** | `secrets.js:91` 写死 `~/.agent-archive/index/fulltext-v1.sqlite`（同时忽略 `AGENT_ARCHIVE_HOME` 与 `INDEX_VERSION`）；`env/skills.js:273` 写死 `~/.agent-archive/cache/skills-v1.json` | `secrets.js` 改用 `search.indexPath()`；`skills.js` 改用 `statePath('cache', ...)` |
| `/api/session` 无上限 | **已采用（2026-10-30）** | `server.js` 直出整场 `messages`；MCP 的 `read_session` 有 8000/40000 字上限 | 默认前 200 条，`limit`（上限 1000）/`offset` 翻页，响应带 `total`/`hasMore`/`nextOffset`/`turns`；`?message=N` 不变 |
| ContentRef 惰性正文指针 | pending（边际收益重估） | cc-switch `model.rs:329-354`（Jsonl offset/len/pointer、Sqlite 主键+列、File、Sidecar），读取前校验行边界（`content.rs:312-364`） | 正文已经压缩到 169MB 索引里；再做指针化要先量摘录/凭证扫描的取数成本，不急 |
| TurnIndex + 分块下发 | **已采用（目录 + 分块）/ pending（流式）** | cc-switch `cache.rs:311-431` 后端算提问目录；`commands/session_manager.rs:36-77` 按 `Header → Messages(≤150 条/256KB) → Done` 流式 | 目录 + 首屏 200 条 + `/api/session/html` 分块已做；真正的流式（一条连接连续推）还没做 |
| 契约 fixture 双端共享 | pending | cc-switch `tests/fixtures/sessions/*.messages.json` 同时被 Rust 往返与 TS schema 校验（`model.ts` / `sessionFixtures.test.ts:347-489`） | 我们 178 个用例都是临时造数据，无 fixture 目录。可以先把漂移样本（Codex 三代父 id、DSH 多帧 zstd、Cursor 权威路径）抽成 JSON，供扫描器与 Web/MCP 共用 |
| FTS5 倒排增量维护 | **已采用（2026-10-30）** | cc-switch 的增量思路（不是直接抄代码）：doc 的任何变化都同步到倒排，而不是全量 rebuild | `search.js` 加三条 `doc_fts_*` 触发器；首次/`--force`/`reindex` 才 rebuild。实时改一场 2–3s（其中约 2s 是冷扫描），全量 7.3s |
| Node 24 + Windows 空 WAL 导致 `disk I/O error` | **已修复（2026-10-30）** | 本机实测：写连接正常关闭后留下 0 字节 `-wal` + `-shm`，下一次打开直接失败；副本无此问题 | `openIndex` 在写打开前清 0 字节边车；只读打开失败时清一次再重试，仍失败才退 immutable。非空 WAL 一律不动 |
| 索引正文压缩 | **已采用（2026-10-30）** | 实测 doc 表 183 MB（body 66.8M 字符），正文 deflate 压缩率约 23% | `doc.body_z` + `readBody()`；老库首开自动迁移并 VACUUM。真实索引 **240 → 169 MB（-26%）**，搜索摘录/凭证结果逐条一致 |
| 会话页分块加载 | **已采用（2026-10-30）** | cc-switch 的 TurnIndex + 流式下发；我们整页 1.59 MB | 首屏 200 条 + `/api/session/html` 片段 + 「加载更多」；1914 条会话 **1.6 MB → 203 KB**，`&all=1` 兜底 |
| 扫描器代码进缓存指纹 | **已采用（2026-10-30）** | 缓存原来只认源文件 (mtime, ctime, size)，改扫描器必须手工加 `CACHE_VERSION` | 缓存加 `__fingerprint`（内置 + 用户扫描器内容哈希）；改代码自动全量重扫一次 |
| 活跃时长口径（5 分钟空闲切分、按小时直方图） | 暂缓 | magpie `sessions.go:302-362` | 我们的 `handoff` 已把会话重叠单列；加"活跃时长"会改变现有统计口径，等有需求再做 |
| Codex 逐请求 delta 计价 | 维持不做 | cc-switch `services/session_usage_codex.rs:299-445`（事件顺序跨版本、`SAME_FLUSH_SLACK_MS`、`total_token_usage` 不能按模型切基线） | 我们的 `usage` 只报各家账本原值，不猜；这套 delta 逻辑工程量与口径风险都大 |
| 删除会话 / 终端恢复 / 写配置 | 不适用 | cc-switch `mod.rs:176-214`；magpie `library` | 我们是只读档案馆 |

### 我们自己暴露出的问题（非上游）

- 索引 226 MB / 3102 场、正文 64 M 字符：`doc` 表存了整段 `body`，且任何
  doc 变化都触发 FTS5 `rebuild` 全量重建（`search.js:480-505`）。规模再上去
  这是唯一硬瓶颈。
- "消息→可检索文本"有 6 份实现（`search.js:614`、`mcp.js:812`、`cli.js:547`、
  `digest.js:67`、`export.js:325`、`web/format.js:102`），Codex 命令数组的特殊
  处理只在 CLI 版有，必然漂移。
- 子代理断链只在 `doctor` 可见（`model.js:224/233` 直接 `continue`），
  query/MCP/Web 没有 orphan 出口。

---

| Hermes 内容保真（解码 `\x00json:`、过滤 `model_only`、按 display_identity 去重） | 已查证**不适用** | 三条都对着本机真实库核过，详见 `scanners/hermes.js` 的注释。关键一条：看着像"重放"的重复其实是 Agent 真的重试了 85 次（各自有不同时间戳和 message_uid），去重会删掉真实过程 |
| `calls` 口径（`credits` 不是钱、`handed_on` 不算调用、`rejected` 单列） | 已采用（部分） | `calls.js`：`rejected` 单列并给 `upstreamCalls`；`credits` 改标"额度消耗"；会话匹配改 `agent\|id`。`handed_on` / `source=reported` 本机 3.2 万条里一条都没有，不做 |

| 两级缓存（列表 + 正文 LRU） | 已采用 | `transcript-cache.js`：按源文件指纹失效，双限 LRU。实测同一场大会话第二次读 1082ms → 0.4ms |
| 字节游标增量索引 | 已否决 | 先量过：索引成本 99% 在读文件+解析，不在索引文本（40 场抽样：读 11.9s / 拆文本 7ms / 分词 36ms）。而稳态索引只有 2.8s，90s 仅出现在首次全量——游标救不了首次全量 |

## 待办（按产品价值排序）

### 2026-10-30 第二轮深读后重排

**本轮已完成（178 个用例全绿）**

1. ~~日期口径统一~~：`model.dayKey()` 走本地日，替换六处 `toISOString` 取日。
2. ~~状态目录收敛~~：`secrets.js` 用 `indexPath()`，`env/skills.js` 用 `statePath()`。
3. ~~`/api/session` 上限~~：默认前 200 条 + `limit`/`offset`/`total`/`hasMore`。
4. ~~FTS 增量~~：三条 `doc_fts_*` 触发器；全量 rebuild 只用于首建 / `--force` / `reindex`。
5. ~~扫描性能~~：用 `ctime` 替代逐文件头部哈希，热扫 2.17s → 1.02s。
6. ~~Claude 分叉/复制~~：`copyOf`/`branchOf` + `postProcess`，复制品不进默认视图与索引，doctor 单列。
7. ~~网页会话目录~~：`src/turns.js` + 会话页目录 + 消息锚点 + API `turns` 字段。
8. ~~工具入参摘要收敛~~：`messages.summarizeInput()` 统一六处，Codex 命令数组规则只保留一份。
9. ~~Node 24 + Windows 空 WAL~~：`openIndex` 写打开前清 0 字节边车，只读失败时清一次再重试。
10. ~~索引正文压缩~~：`body_z` + 自动迁移 + VACUUM，真实索引 240 → 169 MB（-26%）。
11. ~~会话页分块加载~~：首屏 200 条 + HTML 片段接口，1914 条会话 1.6 MB → 203 KB。
12. ~~扫描器代码进缓存指纹~~：`__fingerprint` 自动作废缓存，不再依赖手工加版本号。

**仍待做（按价值排序）**

1. 共享 fixture：把 Codex 三代父 id、DSH 多帧 zstd、Cursor 权威路径等漂移样本
   抽到 `test/fixtures/`，供扫描器与 Web/MCP 共用。
2. 真正的流式下发：现在是分块轮询，下一步做 `Header → Messages → Done`。
3. tail 增量续读：只在"单文件持续追加且体积很大"时才有优势，等有真实样本再做。
4. ContentRef 式正文指针：压缩已经拿掉 26% 体积，指针化的边际收益需要重新评估。

已完成的两项（2026-10-28）：契约式测试（56 个用例，覆盖 Codex / Hermes / DSH /
Qoder / Cursor / 注册表 / 跨平台路径 / 反向发现），以及未知 Agent 的反向发现
（`src/unknown.js` + `doctor` 的"未适配的会话存储"区块）。

测试过程中撞出并修掉的三处静默缺陷，值得记下来——它们都是"两个数字都真、
放在一起就误导"的类型：

| 缺陷 | 症状 | 为什么长期没被发现 |
|---|---|---|
| Cursor 的 SELECT 漏了 `workspaceId` | "权威路径优先"这条规则从未生效，一直靠有损的目录名反解 | 反解出来的值看起来合理，不会为空 |
| DSH 读 `data.content` 而非 `data.message.content` | 所有工具输出是 `null` | 片段存在、工具名显示正常，只是内容空 |
| Qoder 子代理整家未采 | `discover` 不看 `subagents/` 子目录，且两处都跳过 `isSidechain` 行 | 主会话一切正常，只是少了子代理 |

0c. **环境层测试** **已完成（2026-10-28）**：MCP / 技能 / 记忆各补一组用例
    （共 22 个）。撞出两个真缺陷：Hermes YAML 的块状 args 列表读成空
    （导致所有 npx 服务被合并成同一个）、`groupByHash` 的 aliases 是死代码
    （哈希覆盖整份 SKILL.md，同哈希必然同名）。后者改为收集目录名。

   教训：**身份判定和手写解析器是最该先测的地方**。它们不报错，只是把
   不同的东西当成同一个，或者把同一个当成不同的。

0. **macOS 真机验证** **已完成（2026-10-28）**：macOS 26.7.1 / Darwin 25.6 / x64，
   97 个用例全过（2.0 s）。抓出两个只有干净机器才会暴露的问题——
   零会话时 doctor 报假警报、反向发现的"已知路径"排除清单一直为空
   （`paths` vs `hits` 字段读错）。两者都修了。

0b. ~~结构性欠账：扫描器的候选根与 doctor 的已知清单各维护一份~~ **已解决（2026-10-28）**。
    每个扫描器导出 `candidateRoots()`，doctor 的 `detectGaps` 与反向发现统一消费；
    没有扫描器的（Trae / Windsurf / Cline）才回退到手写清单。三个契约用例锁住：
    每个内置扫描器都要声明、doctor 报的路径必须在声明里、反向发现不能把
    自己声明的目录报成"未适配"。

1. ~~契约式测试~~ **已完成（2026-10-28）**：86 个用例 / 1.3 秒 / 零跳过，
   覆盖 Codex / Hermes / DSH / Qoder / Cursor / 注册表 / 跨平台路径 /
   反向发现 / 调用层口径 / 用户扫描器。漂移样本含 Codex 三代父 id、
   导入会话时间戳、DSH 多帧 zstd、Cursor 权威路径。

2. ~~版本号自动发现~~ **已完成**：`sqlite-read.findVersionedDb()` 按前缀取最高版本。

3. **扫描器开放扩展** **已完成**：`scanner-loader.js` +
   `scanner init/path/check/list`。支持一家新 Agent 不再需要改我们的代码。
   这是"通用产品"最实质的一条——见 README 的扩展章节。

4. **配置覆盖数据根** **已完成**：`config.js` + `config init/show/path`。
   `roots.<agent>` 指该 Agent 的家目录，`disabled` 跳过某家。
   解决两件环境变量表达不了的事：GUI 拉起的 MCP server 不继承 shell 变量、
   一个 `CODEX_HOME` 只能指一个位置。


3. **Hermes 内容保真**（magpie 已解决）
   解码 `\x00json:` 前缀、过滤 `display_metadata.model_only`、按显示身份去重。
   我们现在会把原始编码前缀和压缩摘要原样显示出来。

4. **`calls` 层口径**（magpie 的字段语义比我们细）
   `credits` 是计划积分不是钱、`handed_on` 不该算一次调用、`rejected` 要单列、
   会话匹配要带 agent 而不只是 id、`cache_unknown` 不等于 miss。

5. **补覆盖面**：Gemini CLI、Kimi、Pi（cc-switch 有，我们没有）。
