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

## 待办（按产品价值排序）

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

剩下的：

1. **契约式测试**（cc-switch + AutoSwarm 都指向它）
   我们有 11 个 scanner 解析别人家的格式，零测试。`research/probes/` 那 48 个
   脚本依赖本机真实数据，只能算人工验收，换台机器就失效。
   做法：每家一份脱敏 fixture + 期望输出 + 不变量断言（含"不该发生什么"），
   用 Node 内置 `node --test`，零依赖。
   漂移样本要覆盖：Codex 三代父 id 写法、导入会话的导入时间戳、DSH 多帧 zstd、
   Qoder 新旧两套存储、只有 WAL 没有主库。

2. **版本号自动发现**（本机 `state_5.sqlite` / `memories_1.sqlite` 都是写死的）
   上游升版会把 5 改成 6。写死的结果是"这个 Agent 突然没有会话"，而不是报错。
   必须按 `state_*.sqlite` 取最高版本，并在读不到时明确降级。

3. **Hermes 内容保真**（magpie 已解决）
   解码 `\x00json:` 前缀、过滤 `display_metadata.model_only`、按显示身份去重。
   我们现在会把原始编码前缀和压缩摘要原样显示出来。

4. **`calls` 层口径**（magpie 的字段语义比我们细）
   `credits` 是计划积分不是钱、`handed_on` 不该算一次调用、`rejected` 要单列、
   会话匹配要带 agent 而不只是 id、`cache_unknown` 不等于 miss。

5. **补覆盖面**：Gemini CLI、Kimi、Pi（cc-switch 有，我们没有）。
