# 上游参照台账

四个参照项目里我们**读过、判断过**的东西，以及采用了哪些。

配套脚本：

```sh
node research/upstream/refresh.mjs            # 只看有没有新提交（秒级）
node research/upstream/refresh.mjs --diff     # 拉增量，列出关注范围内的改动
node research/upstream/triage.mjs             # 把改动排成「先读哪」的清单
node research/upstream/triage.mjs --md x.md   # 写成文件，给研究子代理当输入
```

读法与取舍（要不要 clone、GitHub 上能看什么、sparse 镜像实测）见
`docs/上游代码怎么读.md`。每轮的原始取证记录在 `research/upstream/findings/`。

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
| ContentRef 惰性正文指针 | **已否决（2026-11-03）** | cc-switch `model.rs:329-354`（Jsonl offset/len/pointer）之所以成立，是因为它读**明文** `.jsonl`；我们主力格式是 zstd 单帧（`codex.js:493-494` 自己的注释：「只能整体解压」），**没有随机访问**。2039/2579 个文件是这种格式，指针化的前提不存在 | 见 2026-11-03 第三轮：从「边际收益待评估」改成明确否决，理由不是收益小而是物理做不到。继续挂 pending 会让每次深读重新纠结 |
| TurnIndex + 分块下发 | **已采用（目录 + 分块）/ pending（流式）** | cc-switch `cache.rs:311-431` 后端算提问目录；`commands/session_manager.rs:36-77` 按 `Header → Messages(≤150 条/256KB) → Done` 流式 | 目录 + 首屏 200 条 + `/api/session/html` 分块已做；真正的流式（一条连接连续推）还没做。2026-11-03 复核：两家做流式都是为了解决「整场一次推完卡 UI」，我们已切到 203 KB，前提消失 → 降级为「先量再说」 |
| 契约 fixture 双端共享 | pending（**定位已修正**） | cc-switch `tests/fixtures/sessions/*.messages.json` 同时被 Rust 往返与 TS schema 校验（`model.ts` / `sessionFixtures.test.ts:347-489`） | 2026-11-03：fixture 抓不到「同一份数据 + 不同环境输入」的 bug（DSH_HOME 大小写那条就是）。所以要做**两类**：数据夹具 + 环境夹具。见第三轮 |
| FTS5 倒排增量维护 | **已采用（2026-10-30）** | 归因更正（2026-11-03）：**cc-switch 全仓没有 FTS5、没有虚拟表、没有倒排索引**，它的会话检索是前端 FlexSearch 只索引元数据。我们这三条触发器是**自研**，正确对照是 Elysian 的 `text_index.py`（CJK 二元组 + DF 截断），不是 cc-switch | `search.js` 加三条 `doc_fts_*` 触发器；首次/`--force`/`reindex` 才 rebuild。实时改一场 2–3s（其中约 2s 是冷扫描），全量 7.3s |
| Node 24 + Windows 空 WAL 导致 `disk I/O error` | **已修复（2026-10-30）** | 实测：写连接正常关闭后留下 0 字节 `-wal` + `-shm`，下一次打开直接失败；副本无此问题 | `openIndex` 在写打开前清 0 字节边车；只读打开失败时清一次再重试，仍失败才退 immutable。非空 WAL 一律不动 |
| 索引正文压缩 | **已采用（2026-10-30）** | 实测 doc 表 183 MB（body 66.8M 字符），正文 deflate 压缩率约 23% | `doc.body_z` + `readBody()`；老库首开自动迁移并 VACUUM。真实索引 **240 → 169 MB（-26%）**，搜索摘录/凭证结果逐条一致 |
| 会话页分块加载 | **已采用（2026-10-30）** | cc-switch 的 TurnIndex + 流式下发；我们整页 1.59 MB | 首屏 200 条 + `/api/session/html` 片段 + 「加载更多」；1914 条会话 **1.6 MB → 203 KB**，`&all=1` 兜底 |
| 扫描器代码进缓存指纹 | **已采用（2026-10-30）** | 缓存原来只认源文件 (mtime, ctime, size)，改扫描器必须手工加 `CACHE_VERSION` | 缓存加 `__fingerprint`（内置 + 用户扫描器内容哈希）；改代码自动全量重扫一次 |
| 网页首访慢（切换项目/能力面/用量要等 2–3 秒） | **已采用（2026-10-30）** | cc-switch / magpie 快在"常驻进程 + 结果持久化 + 前端先出壳"；我们是同步 SSR + 纯内存缓存，每个进程首访各算一遍 | 最近项目/能力面落盘；`serve` 启动预热能力面、用量、技能使用率；`/env?tab=usage` 不再算完整清单；HTML/JSON/资源 gzip。实测 `/env` 2.4s→12ms、`/usage` 1.7s→33ms、项目页 1.8s→153ms |
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

| Hermes 内容保真（解码 `\x00json:`、过滤 `model_only`、按 display_identity 去重） | 已查证**不适用** | 三条都对着实测真实库核过，详见 `scanners/hermes.js` 的注释。关键一条：看着像"重放"的重复其实是 Agent 真的重试了 85 次（各自有不同时间戳和 message_uid），去重会删掉真实过程 |
| `calls` 口径（`credits` 不是钱、`handed_on` 不算调用、`rejected` 单列） | 已采用（部分） | `calls.js`：`rejected` 单列并给 `upstreamCalls`；`credits` 改标"额度消耗"；会话匹配改 `agent\|id`。`handed_on` / `source=reported` 实测 3.2 万条里一条都没有，不做 |

| 两级缓存（列表 + 正文 LRU） | 已采用 | `transcript-cache.js`：按源文件指纹失效，双限 LRU。实测同一场大会话第二次读 1082ms → 0.4ms |
| 字节游标增量索引 | 已否决 | 先量过：索引成本 99% 在读文件+解析，不在索引文本（40 场抽样：读 11.9s / 拆文本 7ms / 分词 36ms）。而稳态索引只有 2.8s，90s 仅出现在首次全量——游标救不了首次全量 |

## Elysian（往世乐土，AI 本地记忆库；`10950cf`，2026-11-03）

> 与上面三个不同：**它不是档案馆，是档案馆的反面**——它做检索、做注入、把
> "谁说的、什么时候为真、谁能看"做成检索约束。所以这里记的大多是**判断**：
> 它的机制哪些在我们定位下值得抄、哪些抄了就违背我们的定位。
> 深读方式：五个只读小组分切片（检索 / 记忆语义 / bench / Go MCP / 摄入），
> 全部结论带 `file:line`，每条都回代码核过。

### 它真正做对了什么

| 事项 | 判断 | 去向 |
|---|---|---|
| **反自证审计**：AST 规则禁止"跑到分数达标为止"，强制"报告必须覆盖冻结的 n""每个分数旁必须有 chance 行""打分器不得 import 被测库"，并用**注入的作弊样例反向验证审计器本身有效** | 值得学（最硬的一条） | `bench/audit.py:29-34,48-76,202-231`。它解决的是"证明套件只证明自己存在"。我们的 `doctor`/回归验证可以照这个形状：把"我不许自己怎么骗自己"写成机器规则 + 自测 |
| **冻结 + sha256 + revision 三联**：13 个第三方集按 HF revision 钉死，每文件记 sha256/snapshot/licence，套件再出带摘要的 manifest 并被校验 | 值得学 | `bench/corpus_sources.py:8`、`bench/build_sets.py:62-86`、`bench/validate_sets.py:98-115`。对应我们"三个月后不知道扫的是哪版会话库" |
| **每个比率旁配 n + Wilson 下界 + "什么都不做"的基线** | 值得学 | `bench/metrics.py:66-89`。我们的"99% 归一化成功"这类数字目前没有 floor，读不出信号 |
| **一次只动一个变量的配对前后测**（先把描述退回原文再重写） | 值得学 | `bench/redescribe_check.py:57-103`。迁移/改 scanner 前后应逐条 diff 并写明"唯一差别是 X" |
| **冻结件不可覆盖，harness 只在副本上跑** | 值得学 | `video_audio_check.py:402-408`。回归跑绝不写进用户真归档 |
| **采样偏差自曝**：300 探针偏高 0.16 这种事写进报告 | 值得学（纪律） | `leg_check.py:5-10`。藏起来比写出来贵 |
| **`deferred` 是一等状态**：没跑过的检查既不算过也不算败，套件"绿不绿"取决于真跑过的检查 | 值得学 | `proofs/suite.py:74-79`、`evaluation_schemas.py:110-117`。我们 `doctor` 的"读不到正文"应有同等待遇 |
| **"不存在也是一种状态"**：`v_atoms_current` 把失效/未生效的记忆从默认视图隐藏，而不是删除；`atom_count()` 仍计入 | 值得学 | `migrations.py:188-194`、`AGENTS.md:50-51`。对应我们"会话还在但正文不可读"——该隐藏不该删，且计数要分开报 |
| **缓存 key 把语料版本与可见性编进去** | 值得学 | `cache_fabric.py:20-22`。我们的 `transcript-cache.js` 只用 `(mtime,size)`，应加 corpus revision |
| **内容寻址对象库 + 确定性 ID**（sha256 命名、`object://`、resolve 防逃逸） | 部分值得学 | `storage.py:29-32,59-87`。**但它的 `source_id` 把文件名 stem 拼进 ID**，对我们是反例：我们的会话文件持续追加，内容一变 ID 就变，每扫一次生新 source。应反过来——session id 做 key，内容做版本 |
| **注解即契约 + 手写期望表**：23 个 MCP 工具按 readOnly/additive/destructive 四档钉死，漏注解或标错即测试失败 | 值得学（成本极低） | `elysian-mcp/internal/mcpserver/server.go:62-71`、`annotations_test.go:34-64`。我们工具少，照抄便宜 |
| **方言表 + 行为位**：把 7 个客户端差异压成数据位（读/写/审批/去重/只存不召回/无 session hook/让位），而不是 if-else | 值得学 | `elysian-mcp/internal/hook/dialect.go:29-43`。接多客户端 hook 的最佳骨架 |
| **原子写 + `ours()` 标记 + 原位替换**：装进用户配置文件前先认自己写过的，替换保留同组他人 handler 且刻意不挪位置 | 值得学 | `elysian-mcp/internal/setup/edit.go:66,107-149`。安装器被信任的前提 |
| **两段式读取**：search 返 1200 字摘要，fetch 给全文 | 值得学 | `elysian-mcp/internal/mcpserver/tools.go:185`。和我们的 `read_session` offset/maxChars 同源 |
| **重复 SQL + 漂移测试**：可见性条款写了 5 份，但有一致性测试锁住 | 值得学 | `browse.py:14` + `backend/tests/test_visibility_rule.py:26-35`。我们多入口同样适用 |
| **"遗忘报告即契约"**：`ForgetReport` 把级联清单变成对外承诺，并报"哪些 cartridge 含它"而不是静默重写 | 值得学（语义） | `schemas.py:291-303`、`memory.py:402-421` |
| **holder schema**：`kind IN ('person','agent','service')` + `token_hash` + `knows_about` | 可借形状 | `migrations.py:92-103`。与我们"跨 Agent 事实"同构，`kind` 可直接用，把 Agent 当 holder |
| **`as_of` 点查询**：一条谓词答"某时刻的事实视图" | 值得学 | `store_search.py:80-94`、`db.py:141-166`。这正是时间线的核心问法 |
| **中文分词单点共享**：索引侧 CJK 逐字加空格 + camelCase 切分，查询侧整句 + 相邻二字短语 OR + 拉丁前缀 | 值得学 | `text_index.py:20,27-31,72-73,163-172`。和我们 FTS5 二元组方案同题，可交叉验 |
| **截断 DF 代替停用词表** | 值得学（小） | `text_index.py:105-118` |

### 抄了就违背我们定位的

| 事项 | 判断 | 原因 |
|---|---|---|
| RRF 三路融合、dense/CLIP/VLM 描述管线 | **不适用** | `retrieval.py:157-168`。它们全部服务于"检索"，我们明确不做检索 |
| hook 每轮自动注入上下文 | **已否决** | 我们 README:17-18 写明"不往 Agent 里注入任何东西"。注意 Elysian 自己也没做到：Grok/Kigi 只能退成"规则文件教模型调工具"（`wire_c.go:14,86-91`），说明**"靠模型记得调 MCP 工具"是最脆的一环**——我们默认就站在这个位置，这条要当风险记，不是当方案抄 |
| cartridge 挂载 / working·consolidation·archive 三层 / rollup 固化 | **不适用** | 服务"注入与上下文预算"，与"只归档不注入"相反 |
| 隔离区在 compiler 期放行、信任分打分 | **不适用（但有可借语义）** | `trust.py:69-121`。我们不做注入，但**导出/Markdown 可以标注"第三方文本、不可作事实引用"**，形状可借 |

### 它自己的话术与实现不符（提醒：别照 README 抄设计）

| 声明 | 实际 |
|---|---|
| "四动词一个 writer，规则不会漂移" | 四动词成立；但 atoms 另有 `ingestion.py:92`、`describe.py:165`、`memory.py:326` 三个写入口 |
| "向量与记忆写在同一事务" | 不成立：atoms+FTS 一个事务，向量另开连接另事务（`memory.py:134-135`、`vector_index.py:142`） |
| "token 决定身份，客户端不能自称别人" | 对读成立；对写退化为单身份——写只认 operator token，而 operator 的 `holder_id` 为 None，全部落 `default_holder`（`api_auth.py:55,104-116`、`api.py:235`）；`supersede` 不校验 owner |
| "forget 级联到一切派生数据" | 漏 consolidation rollup：rollup 抄了原文却是独立 source，**被遗忘的文本仍活在 rollup 里可被检索**（`memory.py:293-298,402-421`） |
| "holder 边界带来 +0.455" | 两行相减的派生数；holder 内 chance 本身从 0.0002 抬到 0.369，差值大半来自候选池缩小，测的是基准切分不是能力 |
| "p50 0.072s / 165,973 atoms" | 那次 dense 关闭、无 filters（operator 全库）；开 dense 后 p50 721ms（`LEGS.md:18`） |
| "没有索引要重建，存下即可检索" | 与 `_rebuild` / `build-dense-index` 并存（`vector_index.py:379-381`） |
| "支持 15 个客户端、无需模型记得调用" | 实际 14 个且 4 个降级；setup/backend 五个测试全 `//go:build !windows`，`edit.go:175-201` 的 pwsh/cmd/plain 三分支从未被执行 |

### 真 bug（对我们是警示，不是要抄）

- **图片腿完全没有 holder 过滤**（`retrieval.py:152-155`、`visual_index.py:71`）：thin 触发图片腿时，别的 holder 的私图可进结果。这是"过滤只加在一条腿上"的经典事故。
- **`forget` 之后原文仍活在 rollup 里**（上表）。
- **`min_trust` 语义失效**：记忆信任分恒为 `(1.0,0,0)`，`min()` 恒 0，`min_trust>0` 会滤掉全部记忆；dense 通道又不传该参数。
- **直读 SQLite 的三个 MCP 工具绕过 holder 可见性校验**（`fetch_atom`/`get_cartridge`/`elysian_status`），而 `/api/search` 会校验——权限边界在两个入口上不一致。
- **每次检索都 `UPDATE recall`**（`retrieval.py:94`）：读也抢写锁，多进程并发最痛的一条。我们多 Agent 并发写要引以为戒。
- **`setup` 在 Windows 上基本没测**：`plain` 分支遇含空格路径直接报错，会让多家客户端 setup 整体中断（`edit.go:196`、`setup.go:100-103`）。

### 结论（一句话）

Elysian 值得抄的是**纪律**，不是**架构**：反自证审计、冻结+复现三联、chance/Wilson 并排、
deferred 一等状态、不存在也是一种状态、注解即契约、方言表、原子写+标记、遗忘报告即契约、
`as_of` 谓词。它的检索/注入/cartridge/三层记忆**全部服务于我们明确不做的那件事**；
而它最脆的一环（靠模型记得调 MCP 工具、以及权限边界在多入口上不一致）恰好是我们现在就站着的坑。

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

1. 共享 fixture（**定位修正**）：不是"替代临时造数据"，而是「一份数据、多入口共用」
   + 「同一份数据、不同环境输入」两类。见 2026-11-03 第三轮。
2. 真正的流式下发：**降级为"先量再说"**。前提（整场推送卡 UI）已随 1.6 MB→203 KB 消失，
   收益只剩一次往返的几十 ms。要做先量：单场页 HTML 最大体积、加载更多的 P95。
3. tail 增量续读：**维持否决，理由升级**。magpie 自己为增量付"窗口过期即整份重读"的税
   （`revision_cache.go:13-20`，5 min → 1 h，21 MB rollout 为一行整读）。我们用 ctime 判据
   + 整读，没有这笔税。
4. ~~ContentRef 式正文指针~~ **已否决（2026-11-03）**：主力格式 zstd 单帧无随机访问，
   前提不存在。见上表。

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

---

## 2026-11-03 第三轮增量深读（magpie `a3768cdd` / cc-switch `7afceec1`）

这一轮只读「从上次 pin 到现在」的变化（magpie 3 天 2668 文件 / +158k 行；
cc-switch 219 文件 / 76 提交），不是通读。两份带 `file:line` 的原始记录在
`research/upstream/findings/`，读法与取舍见 `docs/上游代码怎么读.md`。

### 已采用（本轮落到代码里）

| 事项 | 判断 | 上游证据 | 去向 |
|---|---|---|---|
| **per-scanner 缓存指纹** | **已采用（2026-11-03）** | magpie `sessions.go:1110-1118`：「a raise of `cacheVersion` reads every file of every agent again, minutes of CPU for a long history after each update (#2278)」；`cache_decode.go:39-47,92` 逐条丢；`call_cache.go:54-60,674` 同一模式用在调用索引 | `registry.js`：`__fingerprint`（单值）→ `__fingerprints`（按扫描器的映射），条目加 `scanner` 字段。**实测**：改 dsh 扫描器从「重解析 2582 个文件 / 37–66 秒」降到「73 个文件 / 3.8 秒」；改 claude-code（2 个文件）从 35.8 秒降到 ~39 毫秒 |
| **老缓存迁移不丢条目** | **已采用（2026-11-03）** | magpie `cache_decode.go:39-47`「老条目没有 agent 名时，只有没有任何 agent 版本动过才保留」；`sessions.go:1332-1338`「第一次刷新顺手补名而不是丢弃」 | 读老格式（单值）时**一条都不作废**，只补 `scanner` 名并写新键。否则升级本身会触发一次 40 秒全量重扫，用户体感是「更新完第一屏卡了」 |
| **路径身份按 pathKey 去重（含 sources 兜底）** | **已采用（2026-11-03）** | cc-switch `dsh_config.rs:39-43`（#9100）：同一 profile 目录经 symlink / junction / 8.3 短名 / 大小写出现两次，导致同一把 `<file>.lock` 取两次、每次写都报假冲突 | `dsh.js` 候选根 + discover 文件级去重；`registry.js` 的 `sources` 合并也按 `pathKey`。**这不是潜在缺陷，是可复现的真 bug**：`DSH_HOME` 写成全小写 → 146 个文件（基线 73）→ `source` 拼成两段 → `readMessages` 不拆 `\|` → **ENOENT，DSH 整家 cat/网页/MCP 挂而 timeline 正常**。修复后 73 文件、`source` 无 `\|`、正文读得出 |
| **旁路库判据必须含 `-wal`，失败不 memo** | **已采用（2026-11-03）** | cc-switch `session_usage_codex.rs:2050,2096-2098`（读完复验父文件 stamp）；magpie `call_cache.go:204-211`（`callRoot == ""` 被当成「根已移动」，把刚写好的分片全 prune 掉——「未知」不能与「已变更」共用一个判别值） | `sqlite-read.js` 导出 `stampForDb()`（主库 + `-wal`），`codex.threadIndex` 改用它；打不开 / 缺列 / 查询抛错时返回 null 且**不写 memo**（下一轮重试）。实测 `state_5.sqlite` 是 WAL 模式（文件头 18/19 字节 = 2），旧判据在 checkpoint 前一直命中旧标题 |
| **正文缓存补 ctime** | **已采用（2026-11-03）** | 「同一纪律落地程度不一」：`registry.js` 的 `sameStatOnly` 已用 ctime，`transcript-cache.js` 的 `fileStamp` 只有 `(size, mtime)` | 两处判据统一。等长原地改写 + 回填 mtime 时不再返回旧正文 |

### 复核后维持 / 修正的既有判断

| 事项 | 结论 |
|---|---|
| 「cc-switch 吞掉单家解析失败」 | **仍成立，但要收窄**：`session_manager/mod.rs:72-80` 的 `hN.join().unwrap_or_default()` 本轮未动；但同一仓库的**用量同步**早就把每家 `Err` 汇总进 `errors`（`session_usage.rs:127-136`，旧 pin 就有）。准确说法是「会话列表路径吞，用量同步路径不吞」 |
| 「`state_5.sqlite` 写死」 | 仍成立，且本轮零改动。但补一条：**目录不是写死的**——它解析 `config.toml` 的 `sqlite_home` 与 `CODEX_SQLITE_HOME`，候选可能有两条。我们的 `findVersionedDb()` 优势在版本号，两者可并存（见待办） |
| ContentRef / TurnIndex | 见上面的判断修正（前者否决，后者降级） |
| 「tail 增量否决」 | 维持，理由升级（见待办 #3）。magpie 把空闲窗口 5 min → 1 h 恰恰反证增量要付「窗口过期即整份重读」的税 |
| 「目录列举缓存否决」 | 维持。magpie 本轮新增的是**请求内共享列举**和**字符串复用**，与「跨扫描的目录 mtime 缓存」是两件事 |
| 「handoff 不是跨 Agent 接力」 | 维持。本轮只改了 fd 取法（`Fd` → `SyscallConn`），仍是 socket 交接 |
| 「Claude 分叉去重已采用」 | 维持，`cc_copies.go` 本轮无改动 |
| 「calls 口径」 | 维持，`HandedOn` 不计调用、`Rejected` 单列，逐行与旧 pin 一致 |
| 「Codex 逐请求 delta 计价 维持不做」 | 加强：上游又加了一层 bounded fork 验证（`history_base` / `end_byte_offset` / 父文件双 stamp），复杂度继续上升 |

### 新记的判断（本轮没做，但结论已经确定）

| 事项 | 判断 | 理由 / 证据 |
|---|---|---|
| 「一趟读两用」（magpie `callsAlong`） | **不采纳，因为我们已做到** | `search.js:620-623` 一次 `readSessionContent` 同时产出 FTS 文本与压缩正文。真正的两趟是**跨进程**（index 与 cat 是两个 CLI），magpie 能合是因为它同进程持有两个句柄 |
| mcp-hub → mcp-router | **不采纳功能，只采纳失败答复纪律** | 两者是同一端点改名 + 扩写（`/mcp/magpie/hub`、`hubPool` 键名一字未改），不是换代。可学的只有：错误必须**点名服务端 + 原因**（`mcp-router.md:32`），且「我不知道」与「它不存在」必须是两个不同答复（`hub_mcp.go:533-566` 刚修好一个把「工具不在当前列表」答成「服务端被关了」的 bug） |
| 外部取数三段式上限（content-length → 流式累计 → 解压后再查） | **下一轮** | `pricing.js:136-147` 是全仓唯一 HTTP 取数点，目前只有 `res.ok` 检查。照 cc-switch `model_pricing.rs:366-455` 补，成本约 30 行 |
| 大文件改成逐行读 + 单行上限 | **下一轮（先量）** | 本轮已量：2579 文件 / 4.88 GB，107 个 > 8 MB，明文最长单行 8.45 MB（qoder）。cc-switch 的纪律是「上限加在**记录**粒度，绝不加在文件粒度」（`session_usage_grokbuild.rs:148-152`：整文件封顶会把后续 token 全部漏记）。先只换 qoder（447 文件 / 25.9 秒） |
| `codex.js:374` 取第一个 `"timestamp"` | **假警报，不改** | magpie 的 `tsat_test.go` 证明的是**它自己字节层解析**下内嵌 timestamp 会出错；我们走 `JSON.parse` 后取 `o.timestamp`，`indexOf` 只是预筛。实测 1896 个 .zst + 706 行 Claude 明文实测 0 例多 timestamp |
| 真两趟 / ContentRef / 流式 / tail | 见「仍待做」 | |

### 本轮暴露的、我们自己的欠账（非上游）

1. **失败只有计数，没有身份。** `registry.js` 的 `stats.failures` / `emptied` /
   `keptStale` 是纯计数，`parseFile` 连异常 message 都扔了；`doctor` 只能说「3 个失败」，
   说不出是哪个文件、为什么；MCP 的「我不认识这个 Agent」「文件在但读不出来」
   「确实没有这场会话」三句话同形。
2. **`codexDir()` 只取第一个根。** `codexDirs()` 已经多候选且用 `sameNorm` 去重，
   但 `threadIndex` 与 `assertUnder` 都只取 `[0]`。用户同时有 `CODEX_HOME` 和
   `~/.codex` 时，state 库在第二个根 → enrich 静默失效。
3. **同一纪律三处落地程度不一**：路径归一（`codex.js` 用 `sameNorm`、`qoder.js` 用
   `pathKey`、`dsh.js` 原来一处都没用）；缓存判据（扫描层用了 ctime + `-wal`，
   正文缓存和旁路库 memo 都没用）。本轮修掉两处，剩下的要一次清扫。

---

## 2026-11-03 落地：P0 三条改造（研究 → 代码）

上面那三条欠账当场改掉了，连同「扫描期只读头尾」。这一节记**结果与代价**，
方便下次判断值不值得再做同类改动。

### 1. 扫描期只读头尾（qoder）

新增 `src/scanners/headtail.js`：`readHeadTail()` 只读头 256 KB + 尾 64 KB，
`headLines()` / `tailLines()` 分开给出完整行（丢掉接缝处的半行）。
qoder 的 `parse()` 改走这条快路径，并在「项目 / 标题 / 时间 / 真人判定」
缺任何一样时**整读兜底**——没有兜底就会把「真人消息只在中段」的会话当成
工具会话丢掉，那是静默丢数据。

**为什么标题只能看头段**：标题的定义是「第一句真人输入」，它在开头；尾段里的
user 消息是对话后段的内容（经常是工具回显），拿它当标题会得到一行 tool output。
第一版没分开，实测 449 个文件里有 6 个标题变成了工具输出，就是这条造成的。

**实测（449 个 qoder 文件 / 4.88 GB 全库）**

| 指标 | 改造前 | 改造后 |
|---|---|---|
| qoder 单家冷扫 | 42 s | **2.2 s** |
| 全库冷扫 | 37–66 s | **20.7 s** |
| 走整读兜底的大文件 | — | 6 个（真人消息在中段的那些） |
| 行为等价 | — | 449/449 文件逐字段一致（差异仅来自当时正在写入的 2 个活文件） |

剩余 20.7 s 里约 15 s 是 codex：它的 `.zst` 必须整份解压才能拿到任何内容
（实测最大的 40 个文件：解压 983 ms vs 逐行 `JSON.parse` 544 ms），
先解压再说，所以这一项到此为止；再要快只能换存储形态，不划算。

### 2. 失败要有身份

- `parseFile` 不再吞异常：返回 `reason`；`stats.problems` 记
  `{agent, file, kind: 'parse'|'emptied', reason}`，**50 条上限** +
  `problemsDropped`（计数不能取自明细长度，否则坏了上万个文件也只显示 50）。
- `doctor` 输出：
  ```
  待办：
    采集问题 1 个：解析失败 1 · 解析为空 0
    fakeagent  ~/.fakeagent/a.jsonl  [解析失败] 模拟：这一家的格式变了，解析必抛
  ```
- MCP：`not_found` / `read_failed` / 未知 Agent / `ambiguous` 四种 `code` 分开；
  handler 抛错也带 `code`，避免调用方把「参数错」和「环境坏」当成同一件事。

### 3. codex 多数据根

`codexDirs()` 早就能列多个根，但 `codexDir()` 只取 `[0]`。改成：
`findThreadDb()` 按候选顺序取第一个**真正有 state 库**的目录；`readMessages`
换 `assertUnderAny(codexDirs())`；另补 `CODEX_SQLITE_HOME` 候选。
两个新用例都是「先红后绿」验证过的（旧代码上分别表现为标题退化成 `(untitled)`、
`cat` 抛「拒绝读取根目录之外的路径」）。

### 结论：这三条属于「同一纪律补齐」，不是新功能

都是已有正确写法在另一处的复制（`codex.js` 早就会头尾读、`search.js` 早就会
把派生输入算进缓存判据、`qoder.js` 早就用 `pathKey`）。**收益却最大**：
20 秒的冷扫、一行能定位的失败、两个静默失效。以后每轮深读都该问一句
「这条纪律在我们代码里落地了几处」。

---

## 2026-11-03 P1 落地：逐行读、WorkBuddy 覆盖、取数上限

第二轮按「剩下值得做的」清单继续，结果如下。

### 1. 正文读取改成逐行流式（`src/scanners/lines.js`）

`qoder` / `claude-code` 的 `readMessages` 从「整文件读成字符串 → split」改成
`lineIterator()`：64 KiB 分块 `readSync`，**同步**（扫描器 API 就是同步的）。

- 单行上限 8 MiB：超长行（工具结果的 base64/长输出）**丢掉这一行、字节照常
  消费、后面的行照常读**——绝不因为一行超长放弃整个文件（cc-switch 的
  `session_usage_grokbuild.rs:148-152` 讲的就是这个）。
- 只在提交 `qoder.js` 时踩到一个坑：用 `for...of` 取第一行再 `break` 会把
  生成器 `return()` 掉（finally 里关掉 fd），后半段就再也读不到了。改成
  手动 `it.next()`。
- **实测（最大的 qoder 会话，254 MB）**：旧写法在 512 MB 堆上限下直接
  `FATAL ERROR: Reached heap limit` 崩掉；新写法 heap 只涨 36 MB、1.6 秒读完。
  也就是说这不只是「省内存」，那条会话以前 `cat`/网页/ MCP 读它是会崩的。

### 2. 新增 WorkBuddy（腾讯桌面 Agent）扫描器

实测有 24 个 session（20 主 + 4 子代理），是这轮覆盖面里最实在的一块。
格式与 Claude Code 同构（`projects/<工作区>/<id>.jsonl`），但有五个坑，
全部写进了 `test/workbuddy.test.js`：

| 坑 | 处理 |
|---|---|
| 用户消息里裹着几 KB 的 `<system-reminder>` 注入上下文 | 只取 `<user_query>` 里的话；没有标签才剥 reminder |
| `timestamp` 是**毫秒** | `msToDate()` 按 13 位判断，容忍秒级/ISO |
| `function_call` 的 `id` 是消息 id，`callId` 才是工具 id | 按 `callId` 配对结果，否则工具调用全是"有调用无输出" |
| 编辑重发会留下旧 user message + `resend-fork-notice` | 先扫一遍收集被取代的 id，输出时跳过；实测一个会话 6 条 user 消息只有 3 条到达过模型 |
| 限流/网络失败也写成 assistant message | 带 `providerData.error` 的跳过，不冒充模型发言 |

另外 `~/WorkBuddy/<时间戳>` 是它自己的临时工作区（实测 8 个会话都是），
当项目列出来会污染项目清单，已按"自己的落脚点"置空；`.workbuddy-ai` 是
同产品另一个客户端（实测是空壳），一并纳入候选根，避免它掉进"未适配"。

### 3. 价目表取数加三段式上限与超时（`src/pricing.js`）

全仓唯一的外部 HTTP 点，原来只有 `res.ok` 检查。现在：
**32 MiB 预检**（content-length 超限连第一个字节都不读）→ **流式累计**（超限
立即 cancel 并报出已读字节）→ **完整内容再查一次**；不认识的
`content-encoding` 直接报错（绝不把压缩字节当 JSON 解）；外加 60 秒超时。
Node 的 fetch 会自动解压，所以按**解压后**的字节卡——否则一个压缩炸弹
能用 1 MB 撑出 1 GB。

### 结果

- 全量用例 **206 → 228**，全绿（新增 7 条 WorkBuddy + 6 条 lines + 5 条 pricing）。
- 冷扫不变（约 20 秒，瓶颈仍是 codex 的 zstd 解压）；这次改的是**内存与
  单文件鲁棒性**，不是速度。
- WorkBuddy 接入后 `doctor` 的「已接入」多一家，`未适配` 列表变空。

---

## 2026-11-03 夹具层：两类夹具 + 它当场抓到的一个缺口

### 为什么现在做

前两轮新增的用例大多是「每个用例自己造数据」：同一个漂移样本会在扫描器
用例里造一遍、在 Web/MCP 用例里再造一遍。两处只要有一处跟不上上游格式，
就会出现「扫描器能解析、网页读出来是空的」这种只在一端复现的不一致，而
两次造数据的人并不知道对方造了什么。

### 做了什么

`test/fixtures/`：

- `samples/` 五组**按真实形状合成的最小样本**（十几到几十行，去掉隐私）：
  WorkBuddy 编辑重发/工具配对、Claude 复制与分叉（3 个文件）、Codex 三代父 id
  （3 个文件）、DSH 多帧 zstd（二进制）、Qoder 旧格式。
- `index.js` 登记「物化到 sandbox 的哪个路径、用哪个扫描器、期望看到什么」；
  新样本没登记、登记了文件不存在，元测试都会报。
- **数据夹具**（`fixtures-contract.test.js`）：同一份字节跑
  **扫描 → 正文 → Web 渲染 → MCP read_session** 四个环节，断言关键内容一路不丢。
- **环境夹具**（`fixtures-env.test.js`）：同一份数据 + 不同的环境输入
  （`DSH_HOME` 大小写、`CODEX_HOME` 空目录、`WORKBUDDY_CONFIG_DIR`、配置 `roots`）。

### 它当场抓到的缺口

Codex 旧版子代理：`session_meta` 里 `session_id` 指向父、`id` 指向自己，
但**没有 `source.subagent` 标记**。原实现只在有该标记时才认子代理，
于是这种 rollout 被当成主会话——时间线里凭空空出一场，`parent` 也丢了。

修法：`parentId` 存在本身就足以判定子代理（旧版写法的定义就是两者不同），
`kind/parent` 改按 `isSubagent || parentId` 决定。既有用例全绿。

这件事值得记下来：**数据夹具的价值不只是"省去重复造数据"，而是"同一份
数据被四个入口各读一遍"**——单入口的用例很难发现"某一层把事实吞掉了"。

---

## 2026-11-03 索引层测量：结论是「不动」

按约定先量再说。方法：真实索引只读解剖（dbstat + 正确的字节口径）；
全量重建在隔离的 `AGENT_ARCHIVE_HOME` 里跑（不碰真实库）；增量用
「touch 一场源文件 → 新进程 buildIndex」测真实路径。

### 索引 168.7 MB 的构成（磁盘字节，非字符数）

| 组件 | 大小 | 占比 |
|---|---|---|
| `doc.fts_text`（token 文本列） | 96.8 MB | 57% |
| `doc_fts_data`（FTS5 倒排 block） | 40.6 MB | 24% |
| `doc.body_z`（deflate 正文） | 25.4 MB | 15% |
| 行头 / 二级索引 / 空闲页 | ~5.9 MB | 4% |

> 口径坑：`length(text列)` 返回**字符数**，中文 UTF-8 是 3 字节——
> 之前台账里记的「fts_text 67.9 M」低估了 43%。量磁盘必须
> `length(cast(x as blob))`。

### 成本

| 路径 | 耗时 | 说明 |
|---|---|---|
| 全量重建 | 104.8 s | collect 98.6 s（**94%**，读正文+分词+写表）+ FTS rebuild 6.2 s |
| 增量（改 6 场） | 3.4 s | ≈0.5 s/场；外加扫描发现变化 2.4 s（全量 stat，缓存命中） |
| 查询 | 72–420 ms | 首次含冷打开；均可用 |
| freelist | 1.6 MB | 无碎片问题，VACUUM 无意义 |

### 否决（写下来，下次别再议）

| 方案 | 否决理由 |
|---|---|
| body_z 换 zstd | 实测 150 场抽样：1.00x，省 0.1 MB。零收益换一层复杂度 |
| VACUUM | 空闲页 1.6 MB |
| **清空/砍掉 fts_text 列** | 它是 FTS5 external content（`content='doc'`）的工作列：增量触发器把新值喂给倒排、delete 时回读旧值。contentless 表不支持按行删——砍掉它等于放弃「改一场只付一场」的增量路径。96.8 MB 是**增量+自维护+自带摘录**三件事的合理代价 |
| fts_text 压缩成 blob | 触发器是纯 SQL，解压要进应用层 → 重写整个同步协议；磁盘换不来任何性能路径的收益（查询读倒排+body_z，不读这列） |

### 结论

1. **索引层不是瓶颈。** 全量重建 105 s 的 94% 在读正文，与扫描同源
   （LESSONS 老数据交叉验证：40 场抽样「读 11.9 s / 拆文本 7 ms / 分词
   36 ms」）。索引层自己只占 FTS rebuild 6.2 s + 写表。
2. **日常路径健康**：增量 0.5 s/场、查询 <0.5 s、扫描缓存命中 1.5 s。
   没有要修的性能问题。
3. 唯一留下的钩子：如果会话量翻几倍（比如 >100 M 字符），重看
   「fts_text 压缩 + 应用层同步」——现在明确不做。
