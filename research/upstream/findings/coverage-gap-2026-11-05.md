# 覆盖面差距总台账（2026-11-05）

> 这是「补覆盖面」的**派单依据**。原始取证见同目录：
> - [`cc-switch-coverage-2026-11-05.md`](cc-switch-coverage-2026-11-05.md)（CC Switch 13 家全量规格）
> - [`magpie-coverage-2026-11-05.md`](magpie-coverage-2026-11-05.md)（MAGPIE，待研究子代理回填）
> - [`source-decoupling-2026-11-05.md`](source-decoupling-2026-11-05.md)（数据源解耦方案）
>
> 判断与去向最终写回 [`../LESSONS.md`](../LESSONS.md)。本机真实数据只是**测试样本**（用户 2026-11-05 纠偏），
> 覆盖面的目标是「按上游全生态对齐」，不是「照着这台机器装了什么做」。

## 0. 现状（已核）

- 内置扫描器 **12 款**（`src/registry.js:23-34,48-61`）：
  `claude-code` `codex` `zcode` `qoder` `dsh` `hermes` `cursor` `opencode` `antigravity` `kiro` `copilot` `workbuddy`。
  全部是「开发机恰好装过/碰巧知道」的那几家。
- 基线：`npm test` → **265 / 265 全绿**（Node v24.12.0）。
- 契约：`discover()` 无参、`parse/parseAll`、`readMessages`、`candidateRoots`，见 `CONTRIBUTING.md:61-76`。
  解耦后新增两个可选导出：`structureSpec` + `discoverWithin(roots, ctx)`（P0 由 `p0-source` 落地）。

## 1. 本机「测试集」实测（只读列目录，2026-11-05）

`~` 与 `%APPDATA%`/`%LOCALAPPDATA%` 下**明确存在、但我们没有专门扫描器**的 Agent 数据目录（节选）：

| 目录 | 会话形态文件数 / 体积 | 顶层结构 | 对应上游的哪家 | 备注 |
|---|---|---|---|---|
| `~/.openclaw-autoclaw` | 167 / 4.2 MB | `agents/` `autoclaw/` … | **openclaw**（CC Switch： `~/.openclaw/agents/*/sessions/*.jsonl`） | 变体名，需按形状认 |
| `~/.commandcode` | 36 / 5.4 MB | `projects/` `file-history/` | Command Code（MAGPIE 的 19 清单里有） | `projects/` 疑似类 Claude JSONL |
| `~/.gemini` | 458 / 86.2 MB | `antigravity*` `config` | antigravity（已有）+ **Gemini CLI**（`tmp/<hash>/chats/`） | 主体是 antigravity；需确认有无 CLI 的 `tmp/` |
| `~/.pi` | 1 / ~0 | `agent/` | **pi**（CC Switch/MAGPIE 都有） | 数据极少，够做形状验证 |
| `~/.cline` | 10 / ~0 | `data/` `tasks/` `cron/` | cline（MAGPIE 有；`doctor.js` 记「本机无数据、库全空」） | 低优先 |
| `~/.codebuddy` | 2 / ~0 | `diagnostics/` `plugins/` | CodeBuddy（MAGPIE 有） | 低优先 |
| `~/.codeium/windsurf` | 2 / 0.1 MB | `windsurf/` | Windsurf（`doctor.js` 标 blocked：加密 .pb，熵 7.998） | **读不了，如实报** |
| `~/.trae` / `.trae-cn` | 2302 / 2535（4.6 / 6.4 MB） | `assistant/` `extensions/` … | Trae（`doctor.js` 标 blocked：SQLCipher 加密库，熵 7.999） | **读不了，如实报** |
| `~/.lody` | 3 / ~0 | `chats/` `logs/` | Lody（MAGPIE 19 清单） | 待核 |
| `~/.devin` / `.accio` / `.qoder-cli` / `.qoder-alpha` / `.qoderwork*` | 若干 | 各异 | Devin / 国产变体 / Qoder 衍生 | 待核，属「反向发现」范围 |

**结论**：本机是一大堆 Agent 的现成样本库，`doctor.js` 里已把其中 4 家（Windsurf/Trae/Cline/…）标成
`blocked`（加密或空）。补覆盖面时**能用本机目录做形状验证的**：openclaw、commandcode、gemini-cli、
pi、cline；**明确读不了的**：Windsurf/Trae（如实报，不假装能读，符合项目一贯诚实口径）。
但**测试一律用合成样本**（`test/fixtures/sources/**`），不依赖这些真实目录——换台机器就没了。

## 2. 差集①：CC Switch 能读、我们没有的 7 家（已确认）

来源：`cc-switch-coverage-2026-11-05.md` §5。排序按「格式可复用性 + 生态常见度」，
并叠加本机是否有真数据可验证。

| 序 | agent 名（建议） | 上游 id | 价值 | 难度 | 缺什么 | 本机形状 |
|---|---|---|---|---|---|---|
| 1 | `gemini` | gemini | 高（官方 CLI、JSONL 最易） | 低 | 路径 `~/.gemini/tmp/<hash>/chats/session-*.json(l)` + `.project_root`；**JSONL 回放语义**（`$set`/`$rewindTo`/按 id upsert）；字段与注入过滤 | `~/.gemini` 在（主体 antigravity） |
| 2 | `pi` | pi | 中高（带动 omp） | **中高** | 路径 `~/.pi/agent/sessions` / `PI_CODING_AGENT_SESSION_DIR`；**会话树 + 活动分支投影**（`latest_id` 沿 `parentId` 回溯，隐藏被撤销/分叉轮次）；header/entry 字段 | `~/.pi/agent` 在（几乎空） |
| 3 | `openclaw` | openclaw | 中 | 低 | 路径 `~/.openclaw[-autoclaw]/agents/*/sessions/*.jsonl`；`sessions.json:displayName`；剥尾部 `\n[message_id: …]` | `~/.openclaw-autoclaw/agents` 在（167 文件） |
| 4 | `grokbuild` | grokbuild | 中 | 低-中 | 路径 `~/.grok/{sessions,archived_sessions}`；**元数据 `summary.json` / 正文 `chat_history.jsonl` 分离**（指纹要带旁挂）；活跃文件需逐行上限 | 本机未见 |
| 5 | `kimi` | kimi | 中 | 中 | 路径 `KIMI_CODE_HOME`/`~/.kimi-code/sessions`；`state.json` + `agents/main/wire.jsonl` 双文件；`agent.switched` 分支 | 本机未见 |
| 6 | `mcode` | mcode | 中 | 中 | 路径 `MINIMAX_DATA_DIR`/`~/.minimax/v2/sqlite/runtime-state.sqlite`；SQLite 两代消息表 UNION | 本机未见 |
| 7 | `omp` | omp | 低-中 | **低**（先做 pi 后只 `Dialect`） | 路径 `OMP_PROFILE`/`XDG`；标题槽 + `model_change` 单串两个字段 | 本机未见 |

> `Claude Desktop` 只在 CC Switch 配置层，不读会话，**不计入补扫描器**。

## 3. 差集②：MAGPIE 能读、我们没有的（**已回填，见 `magpie-coverage-2026-11-05.md`**）

MAGPIE 三个集合必须分清：**A1 读会话 25 家**（`access.go:193` `Found()` 权威清单）、
**A2 读调用记录 13 项 `xxxCallFiles()`/14 家**（`calls.go:340-349`）、
**B 改配置/接管流量 74+ 内置**（`agent.All()`）。「19 个」是 10-21 单机 `magpie ls` 实测数，
**不是任何代码上限**（CC Switch 报告与本报告互相印证，两处台账都别再拿它当指标）。

### ⚠️ 先删两条误报（回自己代码核对过，别照上游清单盲建）

上游差距清单是按「上游注册表 vs 12 款名单」推的，lead 逐条回 `src/scanners/` 核对：
- `qoder-cn` —— **不缺**，`qoder.js:53-61` 的 `configRoots()` 已含 `.qoder-cn`/`QoderCN`/`Qoder CN` 等全部变体；
- `workbuddy-ai` —— **不缺**，`workbuddy.js:57-60` 的 `roots()` 已含 `.workbuddy-ai`。
这两家**不进派单**。`codebuddy` 确实缺（`workbuddy.js` 没有 `CODEBUDDY_CONFIG_DIR`/`.codebuddy` 根），
但可用「复用 workbuddy 解析器 + 加一个根」低成本接入。

### 合并两家信息后的完整缺口（去掉上述误报、合并 CC Switch 侧重复项）

| 优先 | Agent | 我们缺什么 | 价值/难度 | 本机形状 |
|---|---|---|---|---|
| **P0** | `pi`（+ `omp`/`raft`/`cindy` 共用解析） | 路径、JSONL、**会话树/活动分支投影**（CC Switch）、usage/compaction 字段（MAGPIE）、fork 去重 | 高（一套 4 家）/ 中高 | `~/.pi/agent` 在（几乎空） |
| **P0** | `kimi` | `~/.kimi-code`、`wire.jsonl`/`state.json`、三协议差异、`agent.switched` 分支 | 高 / 中 | 本机未见 |
| **P0** | `cline` | 4 级 env 路径链、`<id>.json`+`<id>.messages.json`、整份重写、fork 截断 | 高 / 中低 | `~/.cline` 在（库全空） |
| **P0** | `gemini` (CLI) | `~/.gemini/tmp/<hash>/chats/` + `.project_root`、回放日志 JSONL（`$set`/`$rewindTo`） | 高 / 低 | `~/.gemini` 在（主体 antigravity） |
| **P0** | `openclaw` | `~/.openclaw[-autoclaw]/agents/*/sessions/*.jsonl`、`sessions.json:displayName`、剥 message_id 后缀 | 中 / 低 | `~/.openclaw-autoclaw/agents` 在 |
| **P1** | `codebuddy` | 复用 workbuddy 解析器 + `CODEBUDDY_CONFIG_DIR`→`~/.codebuddy` 根 | 中 / **极低** | `~/.codebuddy` 在 |
| **P1** | `grokbuild` | 元数据/正文分离（**两家读的文件不同**：CC Switch `chat_history.jsonl`、MAGPIE `updates.jsonl`，都要认）、逐行上限 | 中 / 中 | 本机未见 |
| **P1** | `mcode` / minimax-code | `v2/sessions/<日期>/…-session_<b64>`、多代 messages.jsonl（MAGPIE）/ `runtime-state.sqlite` 双表（CC Switch）——**两种存储形态，别只做一个** | 中 / 中 | `~/.newmax`/`.minimax` 待核 |
| **P1** | `agy` CLI 变体 | 我们 `antigravity.js` 只读桌面版，缺 `~/.gemini/antigravity-cli/brain/.../transcript_full.jsonl` | 中 / 低 | `~/.gemini` 在 |
| **P1** | `claude-desktop`/Cowork/MSIX | Desktop 多数据目录、`local_<id>.json` 血缘、`local-agent-mode-sessions` | 中高 / 中（目录发现最碎） | 待核 |
| **P2** | `droid`/Factory、`alma`、`wsl`（跨 6 家）、`cursor` editor protobuf | 各自全缺；alma 是 SQLite 树形、WSL 是 Windows 特有、cursor 需 protobuf 逆向 | 中低 / 中~高 | 部分在 |
| **P3** | `cindy` | 复用 Pi 后极低 | 低 / 极低 | 未证实 |

**明确不排期**：`Trae`/`Trae CN`/`Windsurf` —— MAGPIE 11-05 核实**完全没适配会话读取**
（只在 VS Code fork 目录名举例里出现），`doctor.js` 已标 `blocked`（加密）。`Kiro` 会话 MAGPIE
只在配置层、**我们反倒已有扫描器**——别照 MAGPIE 给它定优先级。

并集预估：补完 P0+P1 后，覆盖面从 **12 → 20+**；P2/P3 视需求再排。

## 4. 反向差集（别指望上游教）

`zcode` `qoder` `cursor` `copilot` `kiro` `workbuddy` 六家是**我们独有**（CC Switch 会话层没有），
靠 MAGPIE 或自研已有，保持不动。另有三处「CC Switch 也不比我们全」别照抄：
会话扫描不读 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`（我们是超集）、DSH 没有 `~/DeepSeekHarness` 候选、
Antigravity 不解析二进制但多认 CLI 变体路径（**这条是我们该补的路径缺口**：`antigravity-cli/brain`）。

## 5. 补一家扫描器的标准动作（派单模板）

每家一个独立工作单元，**写作用域互不重叠**：新增 `src/scanners/<agent>.js` + `test/<agent>.test.js` +
在 `test/fixtures/` 登记合成样本。**不要改 `src/registry.js` 的 `scanners` 数组**——由 lead 统一注册，避免冲突。

必须同时满足两套契约（解耦后）：
1. **本机默认**：`discover()` 无参，用 `platform.js` 的 `withOverrides`/`userDataCandidates`/`dataCandidates`
   + `extraRoots(name)` 拼路径（照现有 12 家的写法），`candidateRoots()` 声明根。
2. **显式数据源**：`structureSpec`（声明式路径/文件模式 + `rootAnchor` + `dirHints` + 可选 `contentProbe`）
   + `discoverWithin(roots, ctx)`；`readMessages(session, ctx={})` 用 `ctx.roots` 做越界校验，
   保证外部根不被 `assertUnderAny` 误杀。参照 P0 落地的 `codex.js` 样板与 `src/scanners/kit.js`。

内容纪律（沿用项目一贯口径）：
- 只读，不写任何 Agent 原始文件；「读不了就如实报」，不编字段、不猜 cwd、不猜项目归属。
- 标题取第一句真人输入；注入/系统内容按形状剥（别硬编码标签名单）。
- 子代理会话标 `kind:'subagent'` + `parent`；复制/分叉会话按 `copyOf`/`branchOf` 处理（若该家有）。
- SQLite 源一律用 `src/sqlite-read.js` 的 `openReadOnly`（含 `-wal` 判据）；大文件用 `src/lines.js` 逐行读
  （上限加在记录粒度）。
- 时间戳注意秒/毫秒/ISO、以及「导入时刻 vs 真实时间」这类坑。
- 测试用**合成样本**，不碰本机真实目录；每家至少一条「真实形状样本」+ 一条「漂移/边界样本」。

## 6. 优先级与分组建议（待 MAGPIE 报告回来定稿）

- **第 1 批（格式简单、本机有样本可验证）**：`gemini` / `openclaw` / `pi`＋`omp` / `grokbuild`
  —— 可 3~4 个 teammate 并行，每个独占一个 scanner 文件。
- **第 2 批（SQLite / 双文件 / 分支语义）**：`kimi` / `mcode` / `codebuddy` / `cline`
  —— 依赖 `sqlite-read.js`，可并行。
- **第 3 批（MAGPIE 侧特有、需先查清）**：`claude-desktop`/Cowork / `wsl` / `alma`/`cindy`/`droid` 等
  —— 等 MAGPIE 报告确认「是不是真会话源」再定，别凭名字建扫描器。
- **明确不做的**（如实报、不假装有扫描器）：Windsurf / Trae 加密库。
- 每批完成后：lead 统一注册进 `registry.js` + 跑 `npm test` 全绿 + `doctor` 覆盖率复核 + 更新本文与 LESSONS。

## 7. 与解耦的依赖关系

- 补扫描器**本可**依赖 P0 的 `structureSpec`/`discoverWithin` 契约，但本轮用「**零依赖并行**」化解：
  `structureSpec` 是纯数据对象、`discoverWithin(roots, ctx)` 是纯函数，宿主靠鸭子类型
  （`scanner.structureSpec` / `typeof scanner.discoverWithin === 'function'`）对接，
  scanner **不 import** `src/structure.js`/`src/source.js`/`kit.js`。
  派单规范见 [`scanner-brief-2026-11-05.md`](scanner-brief-2026-11-05.md)。
- P0（lead 决策）**否决了 `setScanSource` 进程级全局 shim**：解耦方案 2.3 明确「不要用模块级全局，
  readSessionContent 是 async，serve 里两个不同 source 交错会串根」。改为显式直传
  `cmdProjects → listProjects({source}) → scanCached({noCache, source})`（query.js 只动 `listProjects` 一处）。
- 缓存隔离在 P0 完成；之后切不同 source 验证「同一家、两份不同备份」不串数据。

## 8. 收尾集成 checklist（lead 独占，等 4 个 teammate 全部交付后一次性做）

四路并行写作用域互不重叠：`p0-source`（registry/cli/structure/source/kit/codex/query.listProjects）、
`scan-jsonl-a`（gemini/openclaw/codebuddy）、`scan-tree`（pi/omp/cline）、`scan-split`（kimi/grokbuild/mcode）。
**下列文件三个 scanner teammate 都不碰，是 lead 的收尾动作**：

1. **`src/registry.js`**：把 9 家 `import` 并加进 `scanners` 数组（:23-34、:48-61）。这是"正文读取自动通"的
   唯一前提——`query.js:232` 的 `readSessionContent` 按 `session.agent` 从 `scanners` 找并调 `readMessages`，
   不用改 query。加完核对 `scannerFingerprints()` 会不会把新家算进去（会，正好）。
2. **`src/doctor.js` 的 `detectGaps()` 手写清单**（:483-596）：
   - **必须去掉 `Cline` 那条的 `blocked`**（:529「本机无数据/库全空」）——新 cline scanner 读的是 MAGPIE 的
     `data/sessions/<id>/*.messages.json` JSON 形态，不再是旧的 `data/db/sessions.db`；留着 blocked 会出现
     「已接入 cline」与「读不了」自相矛盾。同时把 `paths` 改成 `.cline/data/sessions`（dir）。
   - 把 8 家（gemini/openclaw/codebuddy/pi/omp/kimi/grokbuild/mcode）补进 `candidates`，否则覆盖率体检
     少报、且 `knownPathsFromGaps(gaps)`（`unknown.js:440`）排除不到它们 → 反向发现会把 `~/.gemini`、
     `~/.openclaw-autoclaw` 这些**已适配**目录误报成「未适配」。路径用各 scanner 的 `candidateRoots()` 优先
     （:614 逻辑已支持），清单里给 `homePath(...)` 兜底即可。
   - Windsurf/Trae 的 `blocked` **保留**（加密读不了，如实报）。
3. **`test/fixtures/index.js` + 元测试**：三家落地的合成样本是 `test/fixtures/samples/` 下的**扁平文件名**
   （已裁决：子目录会触发 `fixtures-contract.test.js:140-155` 的 `readdirSync` 误报）。
   lead 统一把新样本登记进 `FIXTURES`，让元测试转绿；各家 `.test.js` 自带 `sandbox()` 数据不依赖它。
   ⚠️ **登记顺序硬约束**：`fixtures-contract.test.js:45-75` 会遍历 `FIXTURES` 每个条目、
   `scannerOf()` 从 `registry.scanners` 找、`scanAll` 扫全部家，并对 `expect.sessions/title/project/userTexts`
   做全链路断言。所以**必须先完成第 1 步（9 家注册进 registry.js）再登记**，且每条 `expect` 要与样本
   实际解出的会话数/标题/正文逐项对齐，否则契约测试会红。第一批 3 家的静态样本已落盘：
   `gemini-replay.jsonl` / `gemini-legacy.json` / `openclaw-session.jsonl` / `openclaw-sessions.json` /
   `codebuddy-session.jsonl`（收尾登记时逐一核对这些名字与 `FIXTURES` 一致）。
4. **`README.md` / `CONTRIBUTING.md` 口径**：把「本机/这台机器是立项前提」改成「本机数据只是测试样本、
   指定数据源是一等能力」；补 `--source` 用法与 `structureSpec`/`discoverWithin` 契约；
   更新过时的测试数字（:501「14 个用例」→ 实测 265+）与「当前支持」表（12 → 21 家）。
5. **`npm test` 全量 + `doctor` 覆盖率复核**：基线 265 全绿；收尾后报新总数、0 fail；
   跑一次 `node src/cli.js doctor --json` 确认 9 家 `supported:true`、无「已接入却报未适配」。
6. **集成验证**：造一个含多家数据的假备份目录，用 `--source` 跑 `projects`/`timeline`，
   确认自动识别 + 正文读得出 + 本机真数据没混进结果（P0 的 e2e 已覆盖单家，这里补多家）。
7. **更新 `LESSONS.md` 第四轮**：把「覆盖面 12→21」的实际结果、被否决的 shim、
   以及「零依赖并行」这条协作纪律写进去。

⚠️ 上述动作**等 4 个 teammate 全交付再做**：registry 的 `import` 指向的文件必须真实存在，
agent 名也以最终交付为准，提前改会 import 失败或返工。
