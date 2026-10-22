# 跨 Agent 会话识别机制研究 + 记忆中间件可行性

> 研究日期：2026-10-21　目标机器：本机（Windows）　结论先行版

---

## 一、先纠正一个概念：这两款软件不是同类产品

| | **CC Switch** | **MAGPIE** |
|---|---|---|
| 仓库 | `farion1231/cc-switch` | `yetone/magpie` |
| 形态 | Tauri 桌面应用（Rust 后端 + TS 前端），41 MB | Go 单文件二进制 57 MB + `magpie-bun` 辅助进程 |
| 定位 | **供应商/账号切换器 + 用量账本** | **统一网关 + 模型路由 + 账号池** |
| 核心动作 | 改写各 Agent 的配置文件，把 provider 指到不同地方 | 起 `127.0.0.1:3425` 本地网关，所有 Agent 的请求都打到这里 |
| 与 New API 的关系 | 只是"改配置"，不转发流量（除非开本地代理） | 更接近 New API 的角色——真正的中间人 |
| 会话能力 | 有，但**是附带功能**（读会话、看用量、恢复会话） | 有，也是**附带功能**（`magpie sessions` 统计花销） |

一句话：**CC Switch 管"你连哪个 API"，MAGPIE 管"请求怎么走"**。两者都顺手做了会话读取，但都不是为了"跨 Agent 记忆"而设计的。这一点很关键——它决定了你要做的东西是**空白地带**，不是重复造轮子。

---

## 二、它们是怎么识别各家 Agent 会话的

### 2.1 共同的根本做法：都是"读本地文件/数据库"，没有一家用了协议

这是最重要的发现。**没有任何一个 Agent 提供"给我读你的会话"的标准接口**。两家都只能：

1. 硬编码一批已知的存储路径（各家约定）
2. 逐家写解析器，把各自的私有格式转成统一结构
3. 用文件 mtime + size 或内容指纹做缓存，避免重复解析

这是纯粹的**逆向工程 + 格式适配**路径，不是"集成"路径。

### 2.2 CC Switch：Rust 侧，一个 provider 一个模块

源码目录 `src-tauri/src/session_manager/`：

```
session_manager/
├── mod.rs                    ← 统一入口 scan_sessions()
├── model.rs                  ← 统一 SessionMessage 结构
├── cache.rs                  ← TranscriptCache + Fingerprint
├── content.rs                ← 路径合法性校验（防越权读）
└── providers/
    ├── claude.rs / codex.rs / opencode.rs / gemini.rs
    ├── hermes.rs / pi.rs / openclaw.rs / grokbuild.rs
    ├── mcode.rs / agy.rs / blocks.rs / utils.rs
```

`mod.rs` 里的核心是**8 个线程并行扫描 + 2 个同步扫描**：

```rust
// mod.rs:58-99
pub fn scan_sessions() -> Vec<SessionMeta> {
    let (r1, r2, r3, r4, r5, r6, r7, r8) = std::thread::scope(|s| {
        let h1 = s.spawn(codex::scan_sessions);
        let h2 = s.spawn(claude::scan_sessions);
        let h3 = s.spawn(opencode::scan_sessions);
        let h4 = s.spawn(openclaw::scan_sessions);
        let h5 = s.spawn(gemini::scan_sessions);
        let h6 = s.spawn(hermes::scan_sessions);
        let h7 = s.spawn(grokbuild::scan_sessions);
        let h8 = s.spawn(pi::scan_sessions);
        (/* join 全部 */)
    });
    // ... mcode、agy 同步扫描
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
}
```

每个 provider 模块都只需实现三个函数，这是**可复用的适配器契约**（`provider_roots()` 在 mod.rs:227 定义了每家的根目录）：

| 函数 | 作用 |
|---|---|
| `scan_sessions() -> Vec<SessionMeta>` | 扫描出会话列表（id、标题、项目目录、时间、源文件路径、恢复命令） |
| `load_messages(path) -> Vec<SessionMessage>` | 读某个会话的完整消息 |
| `delete_session(root, path, id)` | 删除（带路径越界防护） |

**两级缓存设计**（这是性能关键，你的工具可以直接抄）：

```rust
// providers/utils.rs:42  FileParseCache::scan
// 缓存键 = 文件路径；命中条件 = modified 时间戳 && 字节长度都没变
Some(entry) if entry.modified == modified && entry.len == len => entry.meta,
_ => parse(&path)   // 没变就不重新解析
```

```rust
// cache.rs  第二级：正文缓存，指纹 = 主文件 + 附属文件（如 -wal/-shm、消息子目录）的
// metadata 集合。任何一处变化就重新解析，否则复用 Arc<Transcript>
pub fn get_or_load(&self, key, fingerprint, load) -> ...
```

注意 `fingerprint` 的巧思：**正文不一定在 sourcePath 本身**。比如 OpenCode 的消息存在另一个目录，所以指纹要把附属文件也算进去（`cache.rs:116 source_fingerprint`，还有 `merge_opencode_parts`）。这是个容易踩的坑。

另外 `content.rs` 做了 `resolve_under_roots`——**所有路径必须先校验在 provider 根目录内**才允许读，防止 `../` 越权。你如果做成常驻服务，这一层必须抄。

**支持的 Agent**（从二进制字符串还原，共 10 个 provider 适配器）：

`codex` `claude` `opencode` `openclaw` `gemini` `hermes` `grokbuild` `pi` `mcode` `agy`(Antigravity)

而**配置管理**范围更大——`magpie ls` 在本机识别出 19 个 Agent 的设置文件：Claude Code、Claude Desktop、Codex、OpenCode、Pi、Cursor CLI、VS Code、DeepSeek Harness、Command Code、Devin、Hermes、Cline、Qoder、Qoder CN、ZCode、WorkBuddy、WorkBuddy AI、CodeBuddy Code、Lody。

> ⚠️ 重要区别：**"能改配置"的 Agent 数量 ≫ "能读会话"的 Agent 数量**。ZCode 在配置列表里，但不在 CC Switch 的会话 provider 列表里。

### 2.3 MAGPIE：Go 侧，一个 `xxxCallFiles()` 一个 Agent

源码在 `internal/sessions/`。入口是一个显式的**注册表函数**：

```go
// calls.go:323-335  callSources 就是全部适配器的注册表
func callSources() []file {
    out := callFiles()                              // Claude Code / Cowork / Codex / WSL
    out = append(out, openCodeCallFiles()...)
    out = append(out, zcodeCallFiles()...)
    out = append(out, dshCallFiles()...)            // DeepSeek Harness
    out = append(out, minimaxCallFiles()...)
    out = append(out, kimiCallFiles()...)
    out = append(out, wslFiles("kimi")...)
    out = append(out, piCallFiles()...)
    out = append(out, codebuddyCallFiles()...)
    out = append(out, agyCallFiles()...)            // Antigravity
    return append(out, workbuddyCallFiles()...)
}
```

每个 `xxxCallFiles()` 只做一件事：找到文件，把 `{path, key, agent}` 塞进列表。真正的解析在 `readXxxCalls()`。

**它比 CC Switch 多啃了几个硬骨头**：

- **Cursor**：会话存在 `~/.cursor/chats/*/*/store.db`，是 **protobuf 编码**，不是 JSON。MAGPIE 写了手动的 protobuf 字段解析（`cursor.go` 里的 `pbFields`），还处理了"复制一份再读"（`cursor_clone_*`）避免锁库。
- **ZCode**：`~/.zcode/cli/db/db.sqlite`，**是 OpenCode 的表结构分支**。MAGPIE 直接复用 OpenCode 的读法，只覆盖了标题来源：

```go
// zcode.go:8-16 注释直接写明了
// ZCode's CLI, OpenCode made over, keeps its sessions in OpenCode's tables
// in a database of its own, ~/.zcode/cli/db/db.sqlite
func zcodeDB() string { return filepath.Join(ZCodeDir(), "cli", "db", "db.sqlite") }
```

- **Hermes**：`~/.hermes/profiles/*/state.db`，而且是**多 profile**——代码会遍历 `profiles/` 下所有非隐藏子目录（`hermes.go:32 HermesDirs`）。本机实测 `.hermes` 有 **3.8 GB**，是最大的一个。
- **DeepSeek Harness**：`~/.DeepSeekHarness/sessions/--<项目>--/<session-id>/session.v4.jsonl.zstd`，**zstd 压缩的 JSONL**，还做了"按 zstd 帧续读"的增量优化。
- **Codex**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`，同时兼容 `archived_sessions/`，并用 `session_index.jsonl` 取标题。

**增量读取是这个项目的精华**（`tail.go`）：每个文件记录 `{off, skip, size, head_hash, prefix_hash}`。下次如果只是尾部追加，就从 `Off` 续读；如果文件缩小或开头变了（被重写/替换），就整个重读。

```go
// tail.go:41-50
func (t *tail) holds(path string) bool {
    fi, err := os.Stat(path)
    if err != nil || fi.Size() < t.Size || t.Off > t.Size { return false }
    return sameHead(headOf(path), t.Head, t.HeadSize) && prefixHash(path, t.Size) == t.Hash
}
```

`headOf` 只读前 256 字节（`headLen`），`prefixHash` 对长文件用 **16 个 4KB 窗口采样**（`calls.go` 的 `sample-v1` 逻辑），避免每次全量哈希大文件。这个思路对你有 3.8 GB 数据的场景是必需的。

**还有两个设计值得注意**：

1. **`desktopDataDirs()`**（`external.go` / `callFiles`）：连 Claude Desktop 的 MSIX 包目录、Cowork 的 `local-agent-mode-sessions/*/*/local_*/.claude` 都扫。
2. **`MergeExternal`**：网关自己记录的（没有本地文件的）会话，以**只读**方式并进列表。也就是说 **MAGPIE 已经在自己网关层留了"第二数据源"**——凡是走它网关的请求，即使 Agent 本地没存会话，它也能还原出一份。这正好是你想做的事的雏形。

### 2.4 两家的能力对比（实测）

| Agent | 会话存储位置 | CC Switch 能读 | MAGPIE 能读 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ | ✅ |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl[.zst]` | ✅ | ✅ |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) | ✅ | ✅ |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.json` | ✅ | — |
| Hermes | `~/.hermes/profiles/*/state.db` (SQLite) | ✅ | ✅ |
| Pi | `~/.pi/**` JSONL | ✅ | ✅ |
| OpenClaw | `~/.openclaw/agents/*/sessions/*.jsonl` | ✅ | — |
| Grok Build | `~/.grok/sessions/*/*/summary.json` | ✅ | ✅ |
| MiniMax Code | `v2/sqlite/runtime-state.sqlite` | ✅ | ✅ |
| Antigravity | 专有二进制 | ✅（只读，禁止删） | ✅ |
| **ZCode** | `~/.zcode/cli/db/db.sqlite` (SQLite) | ❌ | ✅ |
| **Qoder / Qoder CN** | `~/.qoder-cn/projects/<slug>/<uuid>/*.jsonl` | ❌ | ✅（作为 OpenCode 分支） |
| **DeepSeek Harness** | `~/DeepSeekHarness/sessions/**/session.v4.jsonl.zstd` | ❌ | ✅ |
| Cursor | `~/.cursor/chats/*/*/store.db` (protobuf) | ❌ | ✅ |
| Kimi Code | 自有 JSONL | ❌ | ✅ |
| WorkBuddy / CodeBuddy | 自有 JSON | ❌ | ✅ |
| **Trae / Trae CN** | 未查到适配 | ❌ | ❌ |

> 本机实测覆盖面：`magpie sessions` 一次就返回了 zcode、qoder-cn、hermes、opencode、dsh 五家的真实会话，带标题、项目路径、token 数、恢复命令。而 CC Switch 的 `session_log_sync` 表里只有 `codex`(3510)、`claude`(934)、`opencode`(94) 三类——**两家覆盖面确实不同，MAGPIE 更全**。

**这两家的空缺正好是你的机会**：Trae、Windsurf、Kiro、Cline 这些要么没适配、要么只做了半截。

---

## 三、你的想法可行吗？——可行，但要注意三件事

### 3.1 结论：完全可行，而且这个位置现在是空的

你设想的架构本质是：

```
各家 Agent ──写入──> 私有存储 ──读取──> [你的中间层] ──注入──> 各家 Agent
                                          │
                                          ├── 归一化（统一消息模型）
                                          ├── 抽取（事实/决策/偏好）
                                          ├── 索引（向量 + FTS + 知识图谱）
                                          └── 按需检索（MCP / hooks / 指令注入）
```

**为什么现在可行**：会话识别的技术路径已经被这两家验证透了（就是 2.2/2.3 那套：路径表 + 解析器 + 指纹缓存）。你不用再论证可行性，可以直接复用。

**为什么现在有价值**：两家都把会话读取当成"顺手做的次要功能"，用来算账（用量/成本）。**没有一家把"跨 Agent 记忆"当主业**。CC Switch 的 `get_hermes_memory` / `search_daily_memory_files` 只是管理 Hermes 自己的记忆文件；MAGPIE 的 `library instructions` 是往各家**写同一份静态指令**（不是动态检索）。

### 3.2 三个坑，必须先想清楚

**坑 1：Trae 这类"纯 GUI 闭源"可能根本读不到**

本机的 `.trae-cn` 有 1.3 GB，但我没在里面找到结构化的会话文件。如果会话存在云端或加密，你只能靠"代理流量"或"DOM 抓取"兜底——这两种都很脆。**建议：先只支持"有本地落盘"的 Agent，Trae 单独评估。**

**坑 2：注入比读取难得多**

读取是"只读文件"，安全。但**要让 Agent 用上你的记忆，你必须写进它的上下文**。目前有四种注入通道，各有代价：

| 通道 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **项目指令文件** | 往每个项目的 `CLAUDE.md` / `AGENTS.md` / `.cursor/rules` / `ZCODE.md` 写 | 所有 Agent 都支持，稳定 | 静态，只能写摘要；改文件有冲突风险 |
| **MCP Server** | 你提供一个 MCP server，Agent 主动调 `recall(query)` | 动态、按需、不污染上下文 | Agent 必须支持 MCP 且用户得配置；**模型不一定主动调** |
| **生命周期 hooks** | 在 Agent 的 `SessionStart` / `UserPromptSubmit` hook 里注入 | 自动、无需模型配合 | 每家 hook 机制不同，覆盖不全 |
| **网关层** | 像 MAGPIE 那样代理所有请求，在 messages 里插一段 | **通吃所有 Agent，零配置** | 必须让用户把流量导过来；改请求体有兼容风险 |

> **网关层是唯一"零适配"的通道**，这也是为什么 MAGPIE 的架构对你很有参考价值——它已经证明"让所有 Agent 打到一个本地端口"在 Windows 上是可行的（19 个 Agent 都被它接管了）。但代价是用户得愿意走你的网关。

我建议**分层**：网关层做主力（覆盖全，自动），MCP + 指令文件做补充（覆盖走了别家网关的人）。

**坑 3：会话 ≠ 记忆**

这是最容易做错的地方。原始对话里 90% 是噪音（工具输出、文件内容、报错长尾）。直接把会话塞进向量库，检索出来的东西又长又偏。

本机数据能说明问题：
- ZCode `db.sqlite` **271 MB**，`part` 表 65,357 行，`message` 表 14,570 行 → 平均每条消息 4.5 个 part，绝大部分是工具调用和结果。
- 所有 Agent 会话加起来约 **12 GB**。

你需要的是一条**蒸馏管线**，而不是"全文进向量库"：

```
原始会话 → 切分 turn → 剥离工具输出 → LLM 抽取结构化记忆
        → {事实, 决策+理由, 偏好, 踩坑, 项目约定}
        → 按 项目 / 主题 / 实体 三维归档
        → 去重 + 冲突消解（同一条事实后来被推翻怎么办）
        → 检索时按 token 预算裁剪
```

---

## 四、生态里已经有什么（避免重复造轮子）

你提到腾讯开源了记忆模型——查证后是**两条线**：

| 项目 | 定位 | 对你的用处 |
|---|---|---|
| **Hy Memory 2.0**（混元，2026-10） | 记忆**写入模型** `Hy-Memory-30B-A3B`（MoE，激活 3B）+ `hy-memory` SDK + `MemHub` 桌面工具 | 可以直接当"抽取器"用——它的工作就是"把对话写成记忆"，正好是上面那条管线的核心环节 |
| **TencentDB Agent Memory**（腾讯云，2026-04 发布 / 05 开源） | 完整记忆引擎：符号化短期记忆 + 分层长期记忆（原始对话→用户画像），带上下文卸载 | 可参考架构，也可直接接 |

社区里已经有一批 MCP 记忆层，**但它们解决的是另一个问题**：

- **Memorix**：跨 Agent 共享**项目记忆**（Observation / Reasoning / Git 三层），MCP 接入。**接近你的目标**。
- **ai-memory**（akitaonrails）：MCP + hooks 自动捕获，编译成 git 版本化的 Markdown wiki，SQLite FTS。**架构上和你最像**。
- **MARM Memory**：本地 SQLite，"会话历史 + 代码库索引 + 概念图"三位一体。
- **Agentic Memory**：六层认知记忆模型，MCP 统一检索入口。

**它们的共同短板**：都依赖 **MCP 或 hooks 接入**，也就是"需要 Agent 配合"。没有一个走**网关层**拿到全部流量。这就是你的差异化空间。

> 补充：这些项目我只看摘要未深读源码，真要选型建议逐个看过再定。

---

## 五、如果你要做，建议的最小可行路径

**阶段 0（1 天）—— 验证"能不能读全"**
抄 MAGPIE 的 `callSources()` 思路，写一个注册表 + 每 Agent 一个 `scan()`。先只做**元数据扫描**（会话列表、项目、时间），不做全文解析。用本机 12 GB 数据做压力测试。

关键设计（直接从源码抄）：
- 缓存键 = `(path, mtime, size)`，命中就跳过
- 大文件只读 head 256B + 16 点采样哈希
- 路径必须先 `resolve_under_roots` 校验

**阶段 1（3-5 天）—— 统一消息模型 + 增量解析**
定一份 `UnifiedMessage { role, text, tool_calls, ts, session_id, project, agent }`。**先只做 3 家**：Claude Code（JSONL 最简单）、Codex（JSONL，结构清晰）、ZCode（SQLite，openCode 同构，你本机数据最多）。这三家覆盖了 90% 的使用量。

**阶段 2（1 周）—— 记忆抽取管线**
接 Hy Memory 或自己用 LLM 做抽取。重点不是"抽得全"，而是**"抽得准 + 有置信度 + 冲突能消解"**。这一步决定产品好不好用，比读会话难十倍。

**阶段 3 —— 注入**
先做**指令文件注入**（最稳，一天能出效果），再上 **MCP recall 工具**，最后才考虑网关。

**贯穿始终的工程约束**：
1. **只读优先**——绝不修改 Agent 原始会话文件（CC Switch 连删除都做了 root 校验）。
2. **SQLite 要带 `-wal`/`-shm`**——直接读会漏最新数据，或在 Agent 运行时锁库。MAGPIE 对 Cursor 的做法是**复制副本再读**，可以照搬。
3. **别做全量索引**——12 GB 全量向量化成本高且收益低，先按项目/时间窗口做增量。

---

## 六、一句话回答你的问题

> "这两款软件都能识别各家 Agent 的会话，是怎么做到的？"

**全是硬编码路径 + 每家一个解析器 + 指纹缓存**。没有协议、没有标准接口。CC Switch 写了 10 个 Rust provider 模块，MAGPIE 写了 15+ 个 Go 读取器，把 JSONL / SQLite / zstd / protobuf 各种格式逐个啃下来。MAGPIE 覆盖面更广（多啃了 ZCode、Cursor、Qoder、DeepSeek Harness），CC Switch 更规范（有严格的路径越权校验和两级缓存）。

> "我再做一款跨 Agent 记忆中间件，可行吗？"

**可行，位置是空的，难点不在读取而在注入和记忆质量。** 读取这块已经被验证透了，抄就行；注入建议走网关层（MAGPIE 已证明可行）；记忆质量要靠蒸馏管线，别指望"全文向量库"。

---

## 附：本机实测数据（2026-10-21）

| 存储 | 大小 | 文件数 |
|---|---|---|
| `~/.hermes` | 3810 MB | 96,142 |
| `~/.qoder` | 2451 MB | 45,389 |
| `~/.codex/sessions` | 1463 MB | 1,898 |
| `~/.trae-cn` | 1321 MB | 84,431 |
| `~/.workbuddy` | 1117 MB | 48,534 |
| `~/.qoder-cn/projects` | 471 MB | 848 |
| `~/.local/share/opencode` | 372 MB | 30,790 |
| `~/.codex/archived_sessions` | 331 MB | 141 |
| `~/.cursor` | 291 MB | 1,713 |
| `~/.zcode/cli/db` | 262 MB | 3（单库） |
| `~/DeepSeekHarness/sessions` | 20 MB | 39 |
| `~/.claude/projects` | 3 MB | 50 |

ZCode 数据库结构（`~/.zcode/cli/db/db.sqlite`）：
- `session` 245 行 / `message` 14,570 行 / `part` 65,357 行 / `model_usage` 4,340 行
- 与 OpenCode 同构（`session` / `message` / `part`），多了 `title_source`、`workflow_*`、`turn_usage`、`tool_usage` 等 ZCode 特有表

---

## 参考来源

- [farion1231/cc-switch](https://github.com/farion1231/cc-switch) — MIT，Tauri
- [yetone/magpie](https://github.com/yetone/magpie) — Go
- [CC Switch 官网](https://ccswitch.io)
- 腾讯云开发者：[Hy Memory 2.0](https://cloud.tencent.com/developer/article/2763042)
- [TencentDB Agent Memory](https://baike.baidu.com/item/TencentDB%20Agent%20Memory/67574210)
- [2026 智能体记忆产品能力榜](https://cloud.tencent.com/developer/article/2760280)
