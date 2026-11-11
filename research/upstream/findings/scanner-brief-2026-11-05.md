# 新增扫描器派单规范（2026-11-05，第四轮补覆盖面）

> 所有补扫描器的 teammate **必读本文 + `CONTRIBUTING.md` 第 1 节**。
> 本轮的方向来自用户纠偏：**本机真实数据只是测试样本**，产品要成为通用的跨 Agent 会话识别/归一引擎，
> 覆盖面按上游（CC Switch / MAGPIE）全生态对齐，不照着这台机器装了什么做。

## 你交付什么

一个（或几个）新 Agent 的扫描器，让「给一批这类数据 → 识别是哪家 → 解出会话」这件事成立。
**每个扫描器一个独立工作单元**，写作用域见文末，互不重叠。

## 两套契约，必须同时满足

解耦改造（`p0-source` teammate 在做）会给扫描器加两个**可选**导出。为了让你能与它并行、
不等它的代码，本轮约定：**你的扫描器对 P0 零依赖**——`structureSpec` 是纯数据对象，
`discoverWithin` 是纯函数，宿主靠鸭子类型（`scanner.structureSpec` / `typeof scanner.discoverWithin === 'function'`）
对接，**不 import `src/structure.js` / `src/source.js` / `src/scanners/kit.js` 里的任何东西**。

### 契约 A：本机默认（向后兼容，签名一个不改）

```js
export const name = 'gemini';                 // 唯一标识，小写/数字/横线
export function candidateRoots() { return [...]; }   // 我会去哪些目录（doctor/反向发现用）
export function discover() {                  // 无参！返回文件路径数组
  return discoverWithin(localRoots(), {});   // 一行封装，见下
}
export function parse(file) { /* 或 parseAll(file) */ }   // 返回会话对象 / 数组 / null
export function readMessages(session) { /* 可选但强烈建议：返回消息数组 */ }
```

- `localRoots()`：你自己的私有函数，按现有 12 家的写法拼「环境变量覆盖 + config.extraRoots + 平台默认」。
  用 `src/platform.js` 的 `withOverrides`/`envOverrides`/`userDataCandidates`/`dataCandidates`，
  `src/config.js` 的 `extraRoots(name)`。**照 `src/scanners/claude-code.js` / `workbuddy.js` 抄结构**。
- `candidateRoots()` 必须包含 `discover()` 会扫的**所有**根（doctor 与反向发现靠它判断「已适配」）。

### 契约 B：显式数据源（新增，纯函数 / 纯数据）

```js
export const structureSpec = {
  agent: 'gemini',
  probes: [ /* 见下 */ ],
  rootAnchor: { from: '...', up: N, allowSelf?: true },
  dataPaths: [...],           // 相对「应用根」的目录/文件，交给 discoverWithin 遍历
  format: '描述性字符串',
  minScore: 3,
  dirHints: ['.gemini'],      // 应用根首选目录名，用于同构消歧
  // contentProbe?: { bytes: 16, test: (head) => bool }   // 可选，只读头 N 字节
};

export function discoverWithin(roots, ctx = {}) {
  const out = [];
  for (const root of roots) {
    // 按 structureSpec.dataPaths 在 root 下找会话文件，push 进 out
    // ctx.roots / ctx.sourceId / ctx.origin 可选用；越界校验见下
  }
  return out;
}
```

`structureSpec.probes` 的形状（**纯数据，字段固定，别自创**）：
```js
{ glob?: 'sessions/**/*.jsonl', path?: 'cli/db/db.sqlite', kind?: 'file'|'dir', weight: 3, optional?: true }
```
- `glob` 支持 `*` 单段、`**` 多段（宿主实现，深度上限 8）；`path` 是精确相对路径。
- `weight` 是命中加分，`minScore` 是「认这一家」的阈值。给 2~3 条强特征（如真实会话文件）weight 3~5，
  给目录/可选旁路文件 weight 1。
- `rootAnchor`：命中项上溯 N 层得到「应用根」。例：`sessions/**/rollout-*.jsonl` 命中 → `from:'sessions', up:1`
  表示应用根是 `sessions` 的父目录；`cli/db/db.sqlite` → `from:'cli/db/db.sqlite', up:3`。
- `dirHints` 用于同构消歧：`claude-code`/`workbuddy`/`qoder` 都认 `projects/*/*.jsonl`，
  靠 `.claude`/`.workbuddy`/`.qoder` 区分；`zcode`/`opencode` 同源 SQLite，靠 `.zcode`/`opencode.db` 区分。
  **有歧义时宿主会报 ambiguous，绝不猜**——你的 spec 只要如实描述形状即可。

**越界校验**：`readMessages(session, ctx = {})` 里若现有用 `assertUnderAny(roots, file)` 之类
（见 `src/messages.js`），当 `ctx.roots` 存在时要用它、否则用本机根，保证外部根的文件不被误杀。
`discoverWithin` 只做 `readdir`/`stat`，不读文件内容。

### 为什么这样能并行

P0 的 `plan(source)`/`identify(roots)` 只读 `structureSpec`（纯数据）并调 `discoverWithin(roots, ctx)`，
不要求你 import 它的任何模块。你只要把这两个导出按上面的形状写好，就能即插即用。
P0 落地后 lead 会统一验证接线；**你不需要等它**。

## 会话对象（`parse`/`parseAll` 返回值）

用 `src/model.js` 的 `makeSession()` 造，或返回等价普通对象（宿主补缺省）。字段：
```js
{ agent, id, project, title, start, end, source, resume, kind, parent, copyOf, branchOf }
```
- `id`：稳定唯一；`project`：cwd 绝对路径（拿不到就 `null`，**不要猜**）；
- `title`：**第一句真人输入**，不是应用标题；注入/系统内容按形状剥（别硬编码标签名单）；
- `start`/`end`：Date / ISO / 毫秒都接受；注意秒 vs 毫秒 vs ISO、「导入时刻 vs 真实时间」这类坑；
- `source`：供 `readMessages` 定位的文件路径（或多段 `a|b` / `path#id` / `db:id`）；
- `kind:'subagent'` + `parent`：子代理会话照常采集但标记；复制/分叉用 `copyOf`/`branchOf`（若该家有）。

**只读**：绝不写任何 Agent 原始文件。读不了就如实返回 `null`/留空，**不编字段、不猜 cwd、不猜项目归属**
（依据 `CONTRIBUTING.md:109-115`）。

## 正文（`readMessages`）

返回消息数组，形状照 `src/messages.js` 的 `makeMessage`/`textPart`/`toolPart`/`reasoningPart`
（去看一个现成扫描器如 `claude-code.js` 或 `workbuddy.js` 的 `readMessages`）：
- 注入/系统内容归为系统内容并剥离；工具调用压成摘要，大输出别整段塞；
- 大文件用 `src/scanners/lines.js` 的 `lineIterator()` 逐行读（上限加在**记录**粒度）；
- SQLite 源一律用 `src/sqlite-read.js` 的 `openReadOnly`（含 `-wal` 判据），绝不直接 `new DatabaseSync(file)` 写开。

## 测试（合成样本，完全不碰本机真实数据）

- 在 `test/<agent>.test.js` 写用例，用 `test/helpers.js` 的 `sandbox()`/`tempDir()`/`makeSqlite()` 造最小样本。
  **不要依赖本机那些真实目录**（`~/.gemini` 等）——换台机器就没了。
- 至少两类：① 「真实形状样本」——按上游规格造的几十行最小文件，断言能解出会话、标题取真人第一句、
  时间戳对、项目归得对；② 「漂移/边界样本」——锁该家最容易静默出错的那一两个坑（如 Gemini 回放日志的
  `$rewindTo`、Pi 的会话树分叉、Kimi 的协议差异、grok 的元数据/正文分离）。
- 一条 `structureSpec` 单测：造符合形状的最小目录，断言 `structureSpec.probes`/`rootAnchor` 描述了它；
  再造一个 decoy（一堆无关 `.jsonl` 的目录），断言它不会被误判（这项由宿主的 `scoreStructure` 验，
  你的用例只需断言 spec 本身的确定性）。
- 合成样本放 `test/fixtures/samples/<agent>/`；**不要改 `test/fixtures/index.js`**（由 lead 统一登记，
  否则多个 teammate 会冲突）。你的测试直接引用自己造的临时文件即可。
- 断言风格遵循 `CONTRIBUTING.md:179-211`：**锁事实不锁实现**、不断言运行时能力。

## 必读的背景资料（都在仓库里，别凭记忆猜格式）

- `CONTRIBUTING.md` 第 1 节（契约与「先别写代码」三件事）、第 2 节（测试写法）
- `README.md:87-136`「当前支持」表（现有 12 家的存储位置与各家坑）
- `research/upstream/findings/cc-switch-coverage-2026-11-05.md` §3.1/3.2/3.3（CC Switch 侧逐家规格）
- `research/upstream/findings/magpie-coverage-2026-11-05.md` §4.1（MAGPIE 侧逐家规格）
- `research/upstream/findings/coverage-gap-2026-11-05.md` §2/§3（你负责那家的「缺什么」）
- `research/upstream/findings/source-decoupling-2026-11-05.md` §2.3/§2.4（`structureSpec` 形状与三个真实例子）
- 现成扫描器样板：`src/scanners/claude-code.js`（JSONL）、`workbuddy.js`（JSONL+子代理）、
  `zcode.js`/`opencode.js`（SQLite）、`codex.js`（zstd/多行 source）

**两家上游对同一家的说法可能冲突**（例如 grok 正文：CC Switch 说 `chat_history.jsonl`、
MAGPIE 说 `updates.jsonl`）——**两种都认**，别只写一个；这类冲突在总台账 §3 有标。

## 写作用域（硬约束，团队并行）

**你只能新增/修改**：
- `src/scanners/<你负责的 agent>.js`（一个或多个，每个是独立文件）
- `test/<你负责的 agent>.test.js`（或对应名字）
- `test/fixtures/samples/<agent>/**（你自己的合成样本）

**绝对不要碰**（这些是别人的写作用域或 lead 收尾，碰了会冲突）：
- `src/registry.js`（`scanners` 数组的注册由 **lead 统一做**）
- `src/structure.js` / `src/source.js` / `src/scanners/kit.js` / `src/scanners/codex.js` / `src/cli.js` / `src/unknown.js`（P0 teammate 的）
- `test/fixtures/index.js` / `test/helpers.js` / `test/fixtures-contract.test.js`（共享，lead 统一）
- `src/config.js` / `query.js` / `model.js` / `doctor.js` / `platform.js` / `server.js` / `mcp.js` /
  `scanner-loader.js` / `transcript-cache.js` / `usage.js` / `messages.js` / `sqlite-read.js` / `lines.js`
- 除你负责的之外任何 `src/scanners/*.js`
- `README.md` / `CONTRIBUTING.md` / `research/**`（lead 收尾统一改）

## 硬验收（自己跑，把结果贴回 lead）

- `node --no-warnings --test test/<你的测试文件>` → 全绿，报告用例数与 0 fail。
- **不要跑全量 `npm test`** 来判自己的成败（P0 正在改 `registry.js`，中途可能红）；
  全量测试由 lead 收尾统一跑。你只对自己的测试文件负责。
- 用 `read` 读过至少一个现成扫描器的完整实现再动手，别凭空造结构。
- 完成后 `send_message` 给 `lead`：交付了哪几家、每个扫描器的路径规则/格式/关键字段（三五句）、
  `structureSpec` 的 probes 与 rootAnchor 怎么定的、测试结果、以及「哪些坑我如实没读/留空」。

## 边界（别越界）

零 npm 依赖；只读、不写 Agent 文件；不改事实层/视图层分界；不猜 cwd/项目/agent 归属；
不碰本机真实数据；不做 zip 解包/网络源/加密格式破解。读不了就如实报，不假装有数据。
