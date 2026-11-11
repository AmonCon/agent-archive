# 数据源抽象：把「扫描」从本机解耦（架构方案，2026-11-05）

> 本文是**改造方案**的原始取证，只读研究产出，尚未落地。
> 目的（用户 2026-11-05 纠偏）：**本地只是提供这些文件用于测试**，产品不要求必须扫描本机。
> 主能力 = 通用的跨 Agent 会话识别/归一引擎：给一批数据（任意目录、别的机器拷来的备份、
> 导出包），能识别是哪家、按格式解出。本机真实数据降级为测试样本。
> 落地顺序见第 3 节；判断台账见 [`../LESSONS.md`](../LESSONS.md)。

**基线**：Node v24.12.0，`npm test` → **265 / 265 全绿 / 27.7s**。
`README.md:501` 的「14 个用例」、此前记的「228」均已过时。

---

## 0. 三问速答：现状都是「没有」

| 问题 | 答案 | 证据 |
|---|---|---|
| CLI 有 `--source` 吗 | **没有** | `src/cli.js:2570-2584` `VALUE_FLAGS` 只有 13 个；`:88-114` 帮助、`:2649-2715` 分派均无 |
| config 有「任意目录」形态吗 | **没有** | `src/config.js:23-33`（只有 `roots.<agent>` + `disabled`）、`:80-84` 只认两键；`extraRoots(agentName)` `:104-107` **键必须预先知道是哪一家**；`:1987-1996` `config init` 模板同 |
| MCP 能传源吗 | **不能** | 12 个工具 `inputSchema` 全 `additionalProperties:false` 且无 source 字段；`list_projects` 描述明写「列出本机所有…」`src/mcp.js:41` |

---

## 1. 「绑死本机」耦合点（三类）

### ① 数据根来源：os.homedir / 平台约定 / env / config.roots

- `src/paths.js:15-18` `stateHome()` = 工具**自己的状态目录**（`AGENT_ARCHIVE_HOME` 或 `~/.agent-archive`），**与被扫数据无关，本轮不动**。
- `src/platform.js`：`envOverrides()` `:43-60` 直读 `process.env`；`withOverrides()` `:69-79` 无 opts 注入口；
  **`userDataCandidates(appName, opts)` `:107-126` / `dataCandidates` `:138-155` 已接受 `{platform, home, env}` 注入——现成可复用基础**，但 12 家 scanner 调用时都不传 opts。
  `pathKey()` `:87-90` 按 `process.platform`；`editorDataCandidates()` `:185-193` 未接 opts。
- 12 家 scanner 各自私有根函数（未导出），外部无注入点：`codexDirs()` `codex.js:64`、
  `projectDirs()` `claude-code.js:36`、`dbPath()` `zcode.js:25`、`configRoots()` `qoder.js:38`、
  `roots()` `workbuddy.js:53`、`dshDirs()` `dsh.js:72`、`hermesDir()` 等。
  grep 实测 `src/scanners/` 中 `os.homedir()|extraRoots|envOverrides|withOverrides|process.env` 共 **64 处**（全 `src/` 141 处），比旧记的「59」多，属正则/范围差异。
- `src/unknown.js:110,265-282` `scanRoots(home, platform, env)` 生成 home + `.config` + `.local/share` + APPDATA/LOCALAPPDATA，**无 roots 注入口**；`anchorsFromSources()` `:179` 同样依赖 home。
- `src/doctor.js:475-481,598-622,676-689` `detectGaps()` 硬编码 `os.homedir()`；`discoverUnknownStores()` 调 `detectGaps()` + `scanAll({})`。
- `src/model.js:130,276,283-284` `isProjectPath()` 用本机 home 判断「临时落脚点」；`tildify`/`resolveHome` 用本机 home；`src/query.js:34` `absProject()` 用 `process.cwd()`。
- **本轮明确不动但要登记**：`src/env/*`、`src/calls.js:45`、`src/search.js:570-575`、`src/llm.js:38-42`（环境层/用量层的「本机能力面」是合理语义）。
- **叙事层要同步改口径**：`README.md:5,17,20,753,774`、`src/cli.js:52`、`src/mcp.js:41,504,921,1025`、`src/server.js:21` 的「本机/这台机器」。

### ② `discover()` 无参 —— 这是最关键的锁

- `src/registry.js:464` `scanAll({noCache, only})`；**`:529` `files = scanner.discover()` 无任何参数**；
  `:957-958` `agentRootsOf()` 调 `candidateRoots()` 也无参；`:766` `scanCached({noCache})`；`:792` `scanMemo` 全局单例。
- 其他直接消费者：`src/doctor.js:42,614-616`、`src/transcript-cache.js:101-111`、
  `src/usage.js:95,310,575,386`、`src/scanner-loader.js:23,69,157,172`，
  以及 `CONTRIBUTING.md:66,75` 把「无参 discover」写成了**契约**。
- ⇒ **契约演进必须「新增可选导出，旧签名一个不改」**，否则用户扫描器与 265 个测试一起碎。

### ③ 各入口默认扫本机，没有「指定数据源」

| 入口 | 证据 |
|---|---|
| CLI | `src/cli.js:127,193,417,709,769,823,2131,2201,2354` 只透 `noCache` 等；`cmdServe()` `:584-600` 只传 port；`parseArgs()` `:2590-2605` 只分 positionals/flags/values |
| serve | `src/server.js:81` `startServer({port,host,warm})`；`:208,228,240,271,307,350,399` 全 `listProjects({})`/`scanCached({})` |
| query | `src/query.js:45,154,258` 固定 `scanCached({})`；`readSessionContent()` `:232-242` 只按 `session.source` 找 scanner |
| doctor | `src/doctor.js:59,682` 固定 `scanAll({})` |
| MCP | 见速答；`src/mcp.js:948` `readOnlyHint:true, openWorldHint:false` 须保留 |
| **测试（最直白）** | `test/helpers.js:39-96` `sandbox()` 靠把 `USERPROFILE/HOME` 指到临时目录 + 改 `APPDATA/LOCALAPPDATA/XDG_*` 造「假机器」；`test/fixtures/index.js:37-108` 把样本物化到**假家目录下的相对路径**。即：**测试表达「数据来自别处」的唯一方式，就是把本机伪装成那台机器** |

---

## 2. 「数据源（source）」抽象设计

### 2.1 不变量（向后兼容硬条件）

1. `source === null` 时，`scanAll` 严格走 `:529` 的 `discover()`；缓存文件名、manifest、`scanCached` TTL 全不变 → **265 个用例全绿**。
2. `discover()` / `candidateRoots()` / `parse()` / `parseAll()` / `readMessages()` **现有签名一个不改**，只新增可选导出/参数。
3. 老 config（只有 `roots`/`disabled`）解析结果不变；`extraRoots()`/`disabledAgents()` 语义不变。
4. 「给任意目录 → 识别 → 解析」与「扫本机」是**同一条链路**，不复制第二套解析代码。
5. 显式 source 模式默认**不叠加本机**（`--with-local` 才叠加），否则两份数据混在一起无法解释。
6. 零 npm 依赖（`package.json:37-46`）；glob 自己写段匹配器。

### 2.2 新文件 `src/source.js`（函数签名定稿）

```js
/**
 * @typedef {object} Source
 * @property {'local'|'explicit'} kind
 * @property {string} id          // 稳定短哈希：缓存命名空间 / manifest 用
 * @property {string[]} roots      // 已 path.resolve 的绝对目录（可多个）
 * @property {string|null} label  // 展示名，如「旧机 2026-10」
 * @property {boolean} autoDetect
 * @property {{home?:string, platform?:string, pathStyle?:'win32'|'posix'}|null} origin
 */
export function localSource()
export function createSource(input = {})       // {paths?, roots?, label?, agent?, autoDetect?, origin?}
export function sourceFromConfig(cfg, cliOpts)
export function resolveSource({cliSources=[], cliBindings=[], withLocal=false, config}={})
export function sourceId(source)               // sha256(roots.map(pathKey).sort().join('\n')+label).slice(0,12)
export function identify(roots, opts = {})     // -> {bindings, unmatched, ambiguous}
export function plan(source)                   // -> {bindings, unmatched, ambiguous, sourceId}
```

`identify(roots, opts)` 返回：
`bindings: [{agent, root, score, evidence[]}]`、 `unmatched: [{path, bytes, files, sessionDirs, hint}]`（只报「看到什么」）、
`ambiguous: [{path, agents[]}]`（同构歧义，等显式指定，**绝不按最高分猜**）。

### 2.3 `discover()` 契约演进：不改旧签名，新增 `structureSpec` + `discoverWithin`

新文件 `src/scanners/kit.js`：
```js
export function rootsFor(name, ctx, defaultRootsFn) {
  return ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : defaultRootsFn();
}
```

每家把现有私有根函数保留为「本机默认」，然后：
```js
// 以 codex 为例，其余 11 家同构
export function discover() { return discoverWithin(codexDirs(), {}); }   // 旧签名原样，一行封装
export function discoverWithin(roots, ctx = {}) {                        // 新增
  const all = [];
  for (const root of roots) for (const sub of ['sessions','archived_sessions']) walk(path.join(root, sub), all, 0);
  ...原有去重逻辑原样...
}
export const structureSpec = { /* 2.4 */ };
```

`src/registry.js`：
```js
export function scanAll({ noCache=false, only=null, source=null } = {}) {
  const src = source ? (typeof source === 'string' ? createSource({paths:[source]}) : source) : null;
  const p = src ? plan(src) : null;
  for (const scanner of scanners) {
    let files;
    if (!p) files = scanner.discover();                    // :529 原样，向后兼容
    else {
      const roots = p.bindings.filter(b => b.agent === scanner.name).map(b => b.root);
      if (!roots.length) continue;
      if (typeof scanner.discoverWithin === 'function')
        files = scanner.discoverWithin(roots, { sourceId: src.id, origin: src.origin, roots });
      else {
        recordProblem(stats, { agent: scanner.name, file: roots[0], kind:'source-unsupported',
          reason:'该扫描器未实现 discoverWithin(roots)，显式数据源下无法参与' });
        files = [];                                        // 绝不静默退回扫本机
      }
    }
  }
}
export function scanCached({ noCache=false, source=null } = {})   // :766
export function clearScanCache()                                  // :781 清全部命名空间
```
- `readSessionContent(session, {source}={})`、`readMessages(session, ctx={})`、`postProcess(sessions, ctx)`、
  `enrich(sessions, ctx)` **新增可选第二参数**显式传生效根。
  **不要用模块级全局 `activeRoots`**：`scanAll` 同步看似安全，但 `readSessionContent` 是 async
  （`src/query.js:232-242`），serve 里两个不同 source 的请求交错会串根。
- `src/scanner-loader.js:60-82` `validateScanner()` 把新导出列为**可选**（设必需会挂掉所有用户扫描器）；
  `scannerTemplate()` `:148` 加示例；`CONTRIBUTING.md:61-76` 同步。
- `src/usage.js` / `src/transcript-cache.js` 仍可能 `discover()` 无参：本轮可保留本机语义，
  但必须**显式标注**「用量层/正文缓存仍按本机」，避免语义不一致。

### 2.4 `structureSpec`：声明式「我在一个根下认什么」（新文件 `src/structure.js`）

```js
/**
 * @typedef {object} StructureSpec
 * @property {string} agent
 * @property {Array<{glob?:string, path?:string, kind?:'file'|'dir', weight:number, optional?:boolean}>} probes
 * @property {{from:string, up:number, allowSelf?:boolean}} rootAnchor  // 命中项上溯 N 层 = 应用根
 * @property {string[]} dataPaths    // 相对应用根，交给 discoverWithin
 * @property {string} format
 * @property {number} minScore
 * @property {string[]} [dirHints]   // 应用根首选目录名（同构消歧）
 * @property {{bytes:number, test:(head:string)=>boolean}} [contentProbe]  // 可选，只读头 256B
 * @property {string[]} [deny]
 */
```
`matchRel(rel, pattern)` 自己写：`/` 分段、`*` 单段、`**` 多段（深度上限 8，对齐 `codex.js:176`），
大小写按 `pathKey`（`platform.js:87-90`）。**不引依赖。**

**例 1 — codex**（`codex.js:14,138,189,31`）：
```js
export const structureSpec = {
  agent: 'codex',
  probes: [
    { glob:'sessions/**/rollout-*.jsonl',     kind:'file', weight:3 },
    { glob:'sessions/**/rollout-*.jsonl.zst', kind:'file', weight:3 },
    { glob:'archived_sessions/*.jsonl',       kind:'file', weight:2, optional:true },
    { path:'sessions',                        kind:'dir',  weight:1 },
    { glob:'state_*.sqlite',                  kind:'file', weight:1, optional:true },
  ],
  rootAnchor:{ from:'sessions', up:1 }, dataPaths:['sessions','archived_sessions'],
  format:'codex-rollout', minScore:3, dirHints:['.codex'],
};
```
**例 2 — claude-code**（`claude-code.js:14,36-55,95`）：`projects/*/*.jsonl`（weight 4）、
`projects` 目录（1）、`.claude.json`（可选 1）；`rootAnchor {from:'projects', up:1, allowSelf:true}`；
`minScore 4`；`dirHints ['.claude','claude']`。
**例 3 — zcode**（`zcode.js:12,25-42`）：`cli/db/db.sqlite`（weight 5）+ `-wal`（可选 1）；
`rootAnchor {from:'cli/db/db.sqlite', up:3}`；`minScore 5`；
`contentProbe {bytes:16, test: h => h.startsWith('SQLite format 3')}`。

**12 家取模式的位置**：`dsh.js:14,41,86,196,294`（`sessions/<cwd转义>/<session>/session.vN.jsonl[.zstd]` 多帧）、
`qoder.js:18,23,74-101`（新旧两套）、`workbuddy.js:15-17,88`、`cursor.js:13-15,36,54`、
`opencode.js:14-16,65-85`、`hermes.js:12,76,80`、`kiro.js:13-15,33,40,53-56`、
`copilot.js:13,63`、`antigravity.js:16,83`；另见 `README.md:87-100`、`src/doctor.js:483-596`。

**同构歧义是真问题**：`claude-code`/`workbuddy`/`qoder` 都认 `projects/*/*.jsonl`；
`zcode`/`opencode` 同源 SQLite 三表。靠 `dirHints` + 可选 `contentProbe` 消歧
（claude 行内 `sessionId`；workbuddy `ai-title`/毫秒 ts；qoder `attachment`/`active-leaf`；
opencode 无 `semantics.origin`）；**仍有歧义就进 `ambiguous`，让用户 `--source-agent` 指定**。
依据 `CONTRIBUTING.md:109-115`「拿不到就留 null，不要猜」。

### 2.5 自动识别：复用 `unknown.js` + 防误报

把 `src/unknown.js` 内部导出复用（别抄第二份——`doctor.js:679` 吃过「两边各写一遍读错字段」的亏）：
`SESSION_DIRS :39-52`、`NAME_HINT :62`、`SESSION_EXT :65`、`SKIP_NAMES :68-86`、
`SYSTEM_PREFIXES :95`、`isDir :285`、`isKnown :296-303`、`inspect() :321-408`（两阶段）、`hintOf() :411-417`。
给 `scanUnknownStores(opts) :109` **增 `opts.roots`**：`scanRoots() :265` 改成 `scanRoots(opts)`，
有 roots 就直接用，否则保持现有 home/平台逻辑（不带 roots 时输出逐字不变）。

`plan(source)`：
```
candidates = collectCandidates(roots, {maxDepth:3, maxEntries:300})   // 复用 inspect 两阶段
for dir of candidates:
  hits = scanners.filter(有 structureSpec).map(scoreStructure).filter(score>=minScore)
  0 个 -> unmatched（只报看到什么，不下结论）
  >1 个 -> ambiguous（列候选，不猜）
  1 个 -> binding {agent, root: anchorOf(dir,spec), evidence}
dedupe by (agent, pathKey(root))
```
**防误报六条**（对应 `README.md:785-787` 的 pnpm-cache / pgAdmin 坑）：
1. **身份只由 `structureSpec` 强匹配决定**；`unknown.js` 启发式只用于筛候选和输出 `unmatched`。
   251 个 `.jsonl` 的 `pnpm-cache`、有 `sessions/` 的 `pgAdmin` 没 spec 命中就**绝不会归给任何一家、也不会被解析**。
2. 保留「光有 `.jsonl` 不算入选」（`unknown.js:338-351`）。
3. 保留 `SKIP_NAMES`/`SYSTEM_PREFIXES`；source 层加可配 `excludeNames`（默认含 pnpm-cache / pgadmin / node_modules）。
4. 内容探针**只在 spec 命中之后**用于同构消歧，只读前 256B、有上限、失败退回「歧义」。
5. 深度/条目上限沿用 `unknown.js:115-117`（3 / 300 / 12），`**` 深度上限 8。
6. 已识别目录按 `doctor.js:680-684`「从已发现会话反推锚点」排除，避免重复报「未适配」。

### 2.6 缓存隔离（必须与 P0 一起做，否则串数据）

现状：`registry.js:146-148` 缓存固定 `scan-v5.json`；`:551` 键就是文件路径；
`:639` `manifestParts = agent\tpathKey(file)\tsize`；`:792` `scanMemo` 全局单例。
切 source 时两份不同内容的数据会互相命中——静默错误。
```js
function cacheFile(sourceId='local') {
  const name = sourceId==='local' ? `scan-v${CACHE_VERSION}.json`      // 名字不变 → 老缓存继续命中
              : `scan-v${CACHE_VERSION}-${sourceId}.json`;
  return path.join(cacheDir(), name);
}
let scanMemo = new Map();                    // key=sourceId，替代单例
manifestParts.push(`${scanner.name}\t${pathKey(file)}\t${size}\t${sourceId}`);
manifest.source = { kind, id, label, roots: roots.map(tildify) };
```
`stats.snapshot.source` 让 doctor / `session_stats` / MCP 说明「这批数据从哪来」，
兑现 `registry.js:503-514` 的可复现承诺。
⚠️ **未核实**：新增 snapshot 字段可能被 `test/schema-version.test.js` / `test/mcp-snapshot.test.js`
的全等断言拦住，改动前先读这两个用例。**（lead 已核，见文末补记）**

### 2.7 「项目 / cwd 归属」脱离本机后

- **事实原样保留**：`makeSession` 只 `normalizeProject`（`model.js:46,72-80`），不解析存在性、不重写。
  别机的 `D:\old\proj` / `/Users/alice/proj` 原样进 `project`；`projectKey` 纯字符串小写（`:83-85`）；
  `belongsTo` `:89-97` 已支持只记项目名的末段匹配。
- 失效点：`isProjectPath()` `model.js:123-174` 用**本机** home `:130` 过滤临时落脚点；
  `registry.js:940,953-966` 用 `candidateRoots()`（本机根）把「cwd 落在 Agent 内部目录」置 null；
  `tildify/resolveHome` `:274-285` 用本机 home；`query.absProject` `:32-35` 用 `process.cwd()`。
- 改造（全部加**可选** ctx，无 ctx 行为不变）：
  `isProjectPath(p, ctx)`、`tildify(p, ctx)`、`resolveHome(p, ctx)`（显式 source 建议直接不缩，
  避免把别机路径显示成 `~`）、`absProject(p, ctx)`、`agentRootsOf(scanner, ctx)`。
  `ctx.home` 来自 `source.origin.home`，**没写就不猜，退回本机默认**。
- 临时落脚点过滤改**按形状**（含 `.zcode/workspace` / `.codex/worktrees` / `Documents/Codex`）
  而非「包含某个本机绝对路径」。
- 跨机器同名项目仍按 `projectKey` 字符串合并（**不改归一逻辑**）；可选给会话加
  `sourceRef`（事实层元数据）、`listProjects({groupBySource})` 视图层（P2）。
  **绝不把原机器路径映射/重写成本机路径。**

### 2.8 入口形态（名字定稿）

**CLI**（4 个新选项，选项必须放在命令之后——`cli.js:2634` 把 `argv[2]` 直接当 cmd）：
```
--source <dir>                可重复/逗号分隔；给一批任意目录
--source-agent <agent>:<dir>  显式绑定某块属于哪家，跳过自动识别
--with-local                  给了 --source 时仍叠加本机（默认不叠加）
--source-label <名称>          仅用于 stats/manifest 显示
```
```bash
node src/cli.js projects --source D:\backup\old-machine --json
node src/cli.js timeline D:\old\proj --source D:\backup --source-agent claude-code:E:\export\.claude
node src/cli.js doctor --source D:\backup --json
```
`cli.js:2570-2584` VALUE_FLAGS 加 4 个；`:2590-2605` 把 `--source`/`--source-agent` 做成累积数组；
各命令透传 `source`（`:127,193,417,709,769,823,2131,2201,2354`）；`usage()` `:88-114` 增 4 行。

**config JSON**（新增 `sources`/`defaultSource`，**老两键原样保留**）：
```json
{
  "roots": { "codex": ["D:/archive/.codex"] },
  "disabled": ["kiro"],
  "sources": [
    { "path": "D:/backup/old-machine", "label": "旧机 2026-10", "detect": "auto",
      "origin": { "home": "/Users/alice", "platform": "darwin" } },
    { "path": "E:/export/claude", "label": "claude 导出", "agent": "claude-code" }
  ],
  "defaultSource": "local"
}
```
`config.js:76-89` 增读 `sources`（只收 path 为字符串的项、`path.resolve`、不存在静默跳过）
与 `defaultSource`（`local`|`sources`|`<label>`）；新增 `loadSources()`/`resolveSourceByName()`；
`extraRoots()` `:104` **不动**；`cli.js:1987-1996` `config init` 模板加 `sources: []`。

**MCP（P2，形状先给）**：会话层 7 个工具加**可选** `source: {type:'string'}`（配置里登记的 label），
`additionalProperties:false` 保持。**只接受 label，不接受任意路径**（否则 MCP 客户端可让 server
读本机任意文件，违背 `mcp.js:29` / `server.js:28-35` 只读边界）。`readOnlyHint:true` 不动。

**serve（P2）**：`startServer({...,source})`，source **只来自 CLI/config，绝不接受 `?source=` query**
（GET 参数能指定任意目录 = 任意文件读取入口）；`/api/*` 统一 source。

---

## 3. 逐文件改造清单与落地顺序

### 新增
`src/source.js`（2.2 七函数）、`src/structure.js`（`matchRel`/`scoreStructure`/`collectCandidates`/`anchorOf`）、
`src/scanners/kit.js`（`rootsFor`）、`test/fixtures/sources/**`、
`test/source.test.js`/`structure.test.js`/`source-e2e.test.js`、`docs/数据源抽象.md`。

### 修改（风险点）
| 文件 | 风险 |
|---|---|
| `registry.js` | **串缓存最静默**；`claude.postProcess :216-271` 按 uuid 聚组，不同备份相同 uuid 会误判复制/分叉 → 聚组键加 sourceId；`codex.enrich :802` 外部备份常无旁库（`threadIndexMemo :710` 按路径缓存需随 source 失效）；`zcode.getDb :71-77` 连接缓存须随 source `closeStore()`；新增 snapshot 字段可能被快照用例拦 |
| 12 个 scanner | **越界校验**：`messages.js:101-114` `assertUnderAny` 目前只拿本机根（`codex.js:548`/`claude-code.js:327`/`dsh.js:294`/`qoder.js:99`），外部文件会被拒读，必须同步；`realpath` 对 junction 的判定 `messages.js:120-129` |
| `config.js`/`platform.js`/`unknown.js`/`doctor.js`/`query.js`/`model.js`/`cli.js`/`server.js`/`mcp.js` | 缺省行为必须与改造前逐字一致；`query.*` 被 265 个用例大量直接调用，新增参数必须可选 |
| `transcript-cache.js`/`usage.js`/`scanner-loader.js` | 不透传会造成「会话层外部源、用量层本机」的语义不一致 |
| `README.md`/`CONTRIBUTING.md` | 口径：本机数据只是测试样本；契约补 `structureSpec`/`discoverWithin`；更新过时测试数字 |

### 顺序（硬约束：**缓存隔离必须在 P0**；P1 必须在 kit.js 之后）
- **P0 串行打底（最小可验证第一步）**：`structure.js` → `source.js` → `kit.js` →
  **只改 `codex.js` 一家** → `registry.js`（source + 缓存分命名空间）→
  `cli.js`（只接 `--source` + `projects` 一条透传）→ `test/source-e2e.test.js`。
  验收：给一个假 `.codex` 备份目录能自动识别并解出；`npm test` 265 全绿。
- **P1（12 家 scanner 完全并行）**：codex 之外 11 家各一个改动单元，互不依赖，共用 kit.js。
- **P2（4 文件并行）**：`config.js`/`query.js`/`model.js`/`unknown.js`；`doctor.js` 紧随 query。
- **P3（2 入口并行）**：`cli.js` 全命令透传、`server.js`；`mcp.js`（可选）并行。
- **P4 收尾**：`transcript-cache.js`/`usage.js`/`scanner-loader.js`、文档、测试扩充。

---

## 4. 测试策略（合成样本，完全不碰本机真实数据）

新增 `test/fixtures/sources/mixed-bundle/`（复用 `test/fixtures/samples/*` 字节与
`index.js:37-108` 映射、`helpers.js:197` `makeSqlite()`）：
```
mixed-bundle/
  claude-copy/.claude/projects/E--demo-project/aaaa.jsonl
  codex-backup/.codex/sessions/2026/01/01/rollout-....jsonl
  zcode-export/.zcode/cli/db/db.sqlite
  decoys/pnpm-cache/*.jsonl          (251 个小 jsonl)
  decoys/pgAdmin/sessions/state.db   (有 sessions/ 但无 spec 命中)
  decoys/empty-agent/                (空目录)
```
用 `tempDir()`（`helpers.js:109`）物化，**不调用 `sandbox().run()` 改 HOME**——这正是要证明的
「不靠伪装本机」。`AGENT_ARCHIVE_HOME` 仍指临时 state。

**9 类新用例**：① 每家 spec 命中 + decoy 不误判；② `identify()` 混合包三 binding 互不串 +
同构进 `ambiguous`；③ `discoverWithin(roots)` 且 `discover()` 无参输出回归；
④ **e2e 全链路**（scanAll → listProjects → readSessionContent，**断言本机真数据一条都没进结果**，
在真实 home 之外放「毒丸」文件断言未出现）；⑤ 向后兼容（265 全绿 + manifestHash 对比）；
⑥ 缓存隔离（两份同路径不同内容的 source，manifestHash 不同、TTL 不串）；
⑦ 别机 cwd 归集 / 临时落脚点过滤 / 不缩成 `~`；⑧ CLI `--source` e2e、`--source-agent` 消歧、
serve 拒绝 `?source=`（安全）；⑨ pnpm-cache / pgAdmin 形状固化为 fixture。
新样本必须登记进 `test/fixtures/index.js` 的 `FIXTURES` 并被契约用例覆盖（元测试会拦未登记样本）。

---

## 5. 明确边界（这轮不做）

1. 不重构成常驻进程/服务化；2. **不引入任何 npm 依赖**；3. 不改事实层/视图层分界；
4. 不动 MCP 只读语义；5. 不改现有 config/环境变量语义（只叠加 `sources`）；
6. **不把外部路径重写/映射成本机路径、不猜 cwd、不猜 agent 归属**；
7. 不碰本机真实数据（新测试不改 HOME 也能跑）；
8. 不做 zip/tar 解包、网络/远程源、增量同步、加密格式破解（用户先解开目录）；
9. 不动 `src/env/*`、`calls.js`、`search.js` 索引语义（本机能力面是合理语义，语义不一致处显式标注）；
10. 不做 `CACHE_VERSION` 之外的缓存大改（只加 sourceId 命名空间，localSource 文件名保持 `scan-v5.json`）。

---

## 6. 待 lead 决策 / 未核实

- ~~「228 个测试」~~ → 实测 **265**（已确认）。
- ~~`test/schema-version.test.js` / `mcp-snapshot.test.js` 是否全等断言 snapshot~~ →
  **已核（lead，2026-11-05）：都不是全等断言，新增 `manifest.source` 不挡路。**
  `schema-version.test.js` 只锁 `readSchemaVersion()` 的具体数值（3 / null / 拒绝未来版本），
  完全不碰 snapshot；`mcp-snapshot.test.js:40-45` 用 `assert.ok` / `assert.match` /
  `assert.equal` **逐字段**检查 `snapshot.manifestHash`（只断言 `/^[0-9a-f]{16}$/` 格式）、
  `toolVersion` / `nodeVersion` / `byAgent.dsh.files`，没有 `deepEqual`。
  ⚠️ 但仍有一条纪律要守：**不给 source 时不要往 `manifestParts` 追加任何东西**
  （连 `sourceId='local'` 也别加），否则 `manifestHash` 的值会变——虽然这两个用例只匹配格式、
  不会红，却违背「`source===null` 时行为完全等于现在」这条硬不变量。仅在显式 source 时追加。
- `src/sqlite-read.js:56-88` `openReadOnly` 在只读介质（备份盘）上的行为：未核实。
- 内容探针是否真有必要（是否真有同构目录被路径 spec 误判）：未实测，列 P2 可选，
  先用 `dirHints` + `ambiguous` 兜住。
- MCP/serve 是否本轮就开放 source：按「P2、形状先给、本轮可不做」处理。
- `defaultSource` 是否永远默认 `local`：按「是」设计（向后兼容）；改默认属行为变更，需用户明确同意。
