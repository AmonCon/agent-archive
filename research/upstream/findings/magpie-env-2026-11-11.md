# MAGPIE 环境/资产盘点层深读（2026-11-11）

> 只读取证：读 MAGPIE 上游「环境/资产盘点」（MCP、技能、agent wiring、provider/account 发现）这一层，
> 对齐本仓库 `src/env/*` 找「他们有、我们没有」与「他们做法更对」的点。
> **未改 `src/`、`test/`、`README`、`sources.json`、`LESSONS.md`；未跑 magpie 二进制；未联网 clone。**

## 0. 证据口径

- 镜像：`<用户目录>\.agent-archive\upstream-cache\magpie`（sparse + shallow）。
- 旧 pin `HEAD` = `ace8ee1e1cf9f5bea039b0d46edea108249ea596`；**本轮最新版 `FETCH_HEAD` = `de13afbf6f1eb652264fc40b3d56731df02728d4`**。
  全部内容用 `git -C <镜像> show FETCH_HEAD:<path>` 读取；行号均相对该版本文件。
- 已读文档（`docs/subsystems/`）：
  - `library.md` 全文（121 行，长表长行）；
  - `skill-router.md` 全文（44 行）；
  - `mcp-router.md` 全文（63 行）；
  - `agent-wiring.md` 第 1-44 行（职责表、运行路径主体）+ 第 213-215 行（检测）；其余为 Lody/Cherry 等导入链接，未读；
  - `providers-accounts.md` 第 1-45 行 + 第 386-407 行（错误处理/并发/账号不变量）；
  - `plugin-runtime.md` 只读 P3 工具段（第 233-275 行）。
- 已读代码：
  - `internal/library/`：`library.go`、`mcp.go`、`mcp_on.go`、`mcp_hub.go`、`dsh.go`、`skills.go`、`skill_router.go`、`skill_edits.go`、`skill_changed.go`、`treememo.go`、`targets.go`、`project_mcp.go`、`project_scope.go`、`sync.go`、`instructions.go`、`carry.go`、`plugin_tools.go`；
  - `internal/agent/`：`agent.go` 结构体/检测段、`applied.go`、`stash.go`、`install.go` 的 `CLIMissing`；
  - `internal/provider/`：`provider.go` 的读/错/`All`、`account.go` 头部与 `Accounts`；
  - `internal/gateway/hub_mcp.go` 接口与预算段；`internal/library/mcp_check.go` 的步进预算常量；
  - `internal/proc/look.go`；`internal/edit/file.go`、`internal/steady/steady.go`、`internal/filelock/filelock.go` 的写/锁语义。
- **未核实**：未运行 magpie；未读 `mcp_hub.go` 全部 dial/backend 实现、`mcp_check.go` 全文、gateway 其余中间件、`providers-accounts.md` 全文、`plugin-runtime.md` 全文；shallow 克隆不做提交级归因。
- **文档与代码的一处出入（以代码为准）**：`docs/subsystems/library.md:100` 的「Not carried（不随同步走）」清单只列了 `CopySkills`/`SkillHow`、`SharedSkills`、`MCPHub`，**漏了 `SkillRouter`**；`docs/subsystems/skill-router.md:9` 明说它是「this computer's alone: a sync doesn't carry it」，`internal/library/carry.go:25-56` 的 `Bundle`/`CarriedSkill` 也确实没有该字段。说明 library.md 这张清单滞后于新增的 skill router，结论以代码为准。

---

## 1. MCP 注册怎么发现

### 1.1 不是一张全局表，而是每个 Agent 的 `Target` 描述符

- `internal/library/targets.go:22-78` 定义 `Target`：`Instructions`/`Override`/`Field`/`MCP *mcpFile`/`Skills`/`SkillsAlso`/`MCPVia`/`Copy`/`Store`/`Desktop`/`Settings`/`Gone`/`SharedToo`/`Profile`/`Unreached`。**MCP 的位置、格式、多文件、WSL、能力限制全挂在这一个结构上**。
- `targets.go:143-605` 的 `targetOf` 是一个 50+ case 的 switch，逐家给出 MCP 文件与格式：
  - `targets.go:230-238` dsh：MCP 不是文件，而是 `agent.DshPatchFiles(d)` 返回的多个 profile patch 文件；第一个当 `Path`，其余进 `Also`，格式 `fmtDsh`。
  - `targets.go:117-137` CodeBuddy：`.mcp.json` / `mcp.json` / `~/.codebuddy.json` 三个位置取第一个存在的（`codebuddyMCPIn`）。
  - `targets.go:582-597` Claude Desktop：`claude_desktop_config.json` + 所有 `DesktopConfigs3p` 路径进 `Also`。
  - `targets.go:451-463` WorkBuddy：`$WORKBUDDY_CONFIG_DIR/mcp.json`（默认 `~/.workbuddy`）；`targets.go:336-353` Alma：`~/.config/alma/mcp.json`；`targets.go:550-557` Zed：`settings.json` 的 `context_servers`。
- `internal/library/mcp.go:292-316` 的 `mcpFile` 结构：`Path` + `Also`（同一份服务器还要写的文件：dsh 其他 profile、pi-mcp-extension、Claude Desktop 3p）+ `Extra`（只读、只用于导入：旧 pi-mcp-adapter 文件）+ `WSL`/`Distro`/`Home` + `Literal`/`NoCmdRefs`。
- 项目级：`internal/library/project_mcp.go:44-59` 一张 11 个 agent id 的表（claude、codex、gemini、cursor、opencode、zcode、pi、qoder/qoder-cn、codebuddy、droid），每个给 `{rel, format}`；`project_mcp.go:20-39` 注释说明每个位置都有官方文档/源码出处，且 DeepSeek Harness 明确「没有项目层」（MCP 是 profile patch 里的行）。

### 1.2 格式：25 种方言，一种格式一个 encode/decode

- `internal/library/mcp.go:236-290` 枚举了 **25 个 `mcpFormat`**：Claude、Codex、Gemini、OpenCode、Cursor、Copilot、Crush、Goose、Pi、Claude Desktop、ZCode、dsh、PiNative、Antigravity、Hermes、omp、Kimi、Devin、Grok、Cline、CommandCode、Alma、Zed、Kiro、LiveAgent。
- `mcp.go:321-336` 每个格式的「服务器对象」键不同：`mcpServers`（多数）、`mcp_servers`（Codex/Hermes/Grok）、`mcp`（OpenCode/Crush）、`extensions`（Goose）、`mcp.servers`（ZCode）、`context_servers`（Zed）。
- `mcp.go:1095-1161` 解析入口 `entries()`/`parseEntries`：Codex/Grok 用 TOML 且专门剥掉 `projects` 表（Codex 的 `[projects."<dir>"]` 可达上万条，直接全量解析很贵，`:1090-1094` 注释）；Goose/Hermes 用 YAML；其余 JSON/JSONC；OpenCode 同时读 V1 `mcp.<name>` 和 V2 `mcp.servers.<name>`，**V2 赢同名**（`:1147-1159`）。
- `mcp.go:1324-1364` 的 `owned` 表定义「哪些键是 magpie 写的」：transport/command/args/env/url/headers 等；**其余键（timeout、enabled、tools、oauth、disabled、autoApprove…）都是用户的，重写时原样保留**。`:1416-1458` 的 `merged` 进一步保证：用户额外键追加进 entry，magpie 不拥有的键保留用户值。

### 1.3 多来源怎么合并、服务名怎么归一、重复怎么去重

- 单文件内：`mcp.go:1260-1281` 的 `read()` 先读 `Path`；只有 Pi/PiNative/Desktop 会把 `Also`+`Extra` 逐个读进来，**同名以第一个文件为准**（`if out[name] == nil` 才填）。
- 跨 Agent：`mcp.go:1791-1826` 的 `foundServersOf` 是「发现用户已有注册」的权威：
  1. 遍历所有 `Target`，读它的 MCP（读失败就 `continue`，即**单个文件读不出不会让整个盘点失败**，但也不上报 unknown）；
  2. 跳过 `Applied[agent].MCP` 里 magpie 自己写的名字、跳过 library 里已有的名字、跳过不匹配 `nameRe` 的名字；
  3. 按**文件里的键名**分组：同名且 `same()`（`mcp.go:229-232`：transport、command、args、env、url、headers、about 全相等）→ 合并 agent 列表；同名但定义不同 → 记进 `Found.Others`，**不静默合并**。
- **关键结论：MAGPIE 不做「服务名归一」，也没有跨名字的别名识别。** 它的身份就是「文件里的键名 + 该 entry 的精确定义」，因为它是写回者，必须保留每个 agent 的原生键名；不同名字即使指向同一个服务也会是两条 `Found`。
  这恰好与我们 `src/env/mcp.js` 的取向相反：我们按启动指纹（`fingerprintOf`）归并同一服务的不同安装形态（`src/env/mcp.js:357-395`），再用 `serviceKeyOf` 得服务身份（`:472-483`）。**我们的指纹层是更强的「这台机器到底有几个服务」；不要为了像 magpie 而退回按名识别。** 该抄的是它的「同名不同定义 → Others」冲突检测（见 §6 P1-3）。
- 能力限制：`mcp.go:339-390` 的 `supports()`/`foreign()`——格式不支持就明确拒绝（Claude Desktop 不收 remote；Codex、Goose、dsh、Grok、Command Code、Zed 不收 SSE），用户由扩展自己配置的 entry（有 `settings` 无 command/url）不覆盖，要求换名。

### 1.4 启用/禁用怎么表达

- Library 侧有四层：
  - `Server.Agents []string`：给哪些 agent（`library.go:25-26`）；
  - `Server.Hidden` + `Server.Paused`：全局关，关时 `Agents` 清空、原 agents 存 `Paused`，开时恢复（`mcp_on.go:16-36`）；
  - `Server.Hub = "direct"`：绕过 MCP router，每个 agent 保留自己的 entry（`mcp_hub.go:77-87`）；
  - `Server.DisabledTools []string`：按工具关（`mcp.go:46-49`；写回形式见 `library.md:67-75`：Codex `disabled_tools`、Gemini `excludeTools`、Claude Code `permissions.deny` 的 `mcp__<server>__<tool>`、OpenCode `"<server>_<tool>": false` 等）。
- Agent 自己的 `enabled`/`disabled` 字段：`mcp.go:1324-1360` 的注释明确多数是「用户的键」，magpie 只保留不解释（只有 OpenCode 的 `enabled` 在 owned 里、Goose 的 `enabled` 也是 owned）。
- 我们这边：`normalize` 只产出 transport/command/args/url/envKeys/headerKeys（`src/env/mcp.js:490-517`），**完全不读 `enabled`、也没有「给哪个 agent」这一维**；所以一个 `enabled: false` 的注册在我们这里仍然算「有这个能力」。

---

## 2. 技能怎么发现

### 2.1 目录布局与「谁能读到」

- `internal/library/skills.go:2324-2430` 的 `foundSkills` 是发现权威：
  1. 扫描位置顺序：library 自己的 `skills/` → `~/.agents/skills` → 每个 `Target.Skills`（Claude Desktop 除外，它的技能是它自己的 manifest）；
  2. 跳过 `.` 开头目录、magpie 自己的库链接、library 已有同名、`!nameRe`、以及 router 的 `magpie-skills`；
  3. 结果按名字分：
     - `f.real == r`（同一真实目录）→ 加入 `Agents`；
     - `sameTreeIn(seen, p, f.at)`（不同目录但整棵树一样，例如 CC Switch 给每家复制一份）→ 加入 `Copies`；
     - 其余同名 → `Others`（另一个同名技能，不合并）。
     另外带 `Manual`（`disable-model-invocation`）、`Link`（真实链接目标）、`Shared`（在 `~/.agents/skills` 的 entry）、`Library`（library 文件夹里但没登记，多半是 library.json 丢了）。
- `targets.go:35-37,45-53`：`Skills` 是 agent 自己的技能目录；`SkillsAlso` 是「它还读别人的」——OpenCode 读 Claude 的、Crush 读 Claude 的、Alma 读 claude+codex 的。`targets.go:1057-1080` `readsWith` 会把「同一真实目录」或「对方是 `~/.agents/skills` 且本 agent 会读共享目录」的 agent 也加进 `SkillsAlso`。
- `targets.go:1022-1055`：`readsShared` 列了 18 个会自己读 `~/.agents/skills` 的 agent（codex、gemini、opencode、deveco、crush、dsh、commandcode、devin、droid、cline、grok、grok-app、fx、alma、kimi、omo、zcode、mu）；Pi 从 0.54.0、omp 从 11.0.0 起才算（`:1040-1043`）。`sync.go:737-741` 据此计算 `SkillView.Always`——**技能放在共享目录时，对这些 agent 是「无论有没有被 tick 都可用」**。
- 我们的 `src/env/skills.js:32-102` 只有 9 个根目录（shared-agents 只是伪 agent），**没有 `SkillsAlso`/`readsShared`/`Always` 语义**：Kiro 里一个指向共享目录的链接会被同时算进 kiro 和 shared-agents，但不会算进「OpenCode 也读 Claude 的技能」这种真实可达性。

### 2.2 SKILL.md frontmatter 字段

- `skills.go:168-198`：`meta` 只有三个字段——`name`、`description`、`disable-model-invocation`。`parseMeta` 对 front matter 解析失败**静默返回零值**，所以 `Manual=false` 的语义是「不知道，不是刻意的 false」（`:173-176` 注释、`:188-198` 实现）；`readMeta` 的 `ok=false` 只在 SKILL.md 读不到时。
- `skills.go:200-246`：`nameFor` 优先 front matter 的 `name`，但先 `fitName`（非 `[A-Za-z0-9_-]` 变 `-`、最长 64 字节）；若原名含非 ASCII 字母/数字会被 `dropsLetters` 判为「会丢字」，改用文件夹名。`nameFor` 的注释给了真实案例：35 个技能因中文/符号名被压成 16 个（`CTF•密码学` → `CTF`）。
- 我们的 `src/env/skills.js:211-246` 读 `name/description/version/license/author`（比它多 version/license，好），但**不读 `disable-model-invocation`**，也没有 `fitName`/`dropsLetters` 这种防塌缩规则（我们不用名字做路径，影响小，但展示名会重复）。

### 2.3 同名多份、hash/版本、启用

- 同名冲突（library 安装侧）：`internal/library/skill_beside.go:50` 的 `freeSkillName`：新技能与已有同名时依次加 `-<owner>`、`-<owner>-<repo>`、`-<repo>`、`-<n>`，最多 64 字节；`nameSkill` 只改 SKILL.md 顶层 `name:` 一行，保证「一个 agent 永远看不到两个同名技能」（`library.md:105` 有完整说明）。
- hash/版本（library 侧）：`skills.go:34-73` 的 `Skill`：`Hash`（从 GitHub 拉取时整个文件夹的 hash）、`Commit`（最后动过它的 commit）、`Own`（排除安装产物后的 hash）、`Source`（github|git|folder + repo/ref/path/dir/via）、`Gone`（上游已删）、`OffHere`（本机单独关）、`Called`（原 SKILL.md 给的名字，如果 library 因重名改了目录名）、`Router`（`direct` 不进 router）。
- 安装产物排除：`skill_changed.go:32-70` 定义 `installedDirs`（node_modules、.venv、venv、__pycache__、.pytest_cache 等）和 `lockFiles`（package-lock、yarn.lock、pnpm-lock、bun.lock、uv.lock），`:72-75` `ownHash` 把这两类排除后再算「技能自己的 hash」。`treememo.go:72-91` 用文件夹 stamp 缓存 hash，`treememo.go:10-13,27-55` 规定「没整份扫完的文件夹是未知，下次重扫，绝不当作没变」。
- 启用：`skills.go:56-60` `OffHere`；`:77-79` `gives(id) = !OffHere && Agents contains id`——**`Agents` 是「同步会带走什么」，`OffHere` 是「本机不给」**；`:83-92` `SkillHere` 切换 `OffHere`。`carry.go:42-56` 的 `CarriedSkill` 不带 `OffHere`，所以本机单独关不会被同步到别的电脑。
- 我们的 `src/env/skills.js:316-369`：`hash = sha256(SKILL.md)` 前 16 hex，**只 hash 一个文件**；`groupByHash`（`:483-549`）按这个 hash 分组。后果：两个技能 SKILL.md 完全相同、但 `scripts/` 或模板不同，会被我们合成同一个「能力」。这是身份错误，比漏一个技能更严重。
- 我们也没有 `OffHere`、`disable-model-invocation`、`Copies/Others`、`Always` 的概念；`scanSkills()` 永远返回 `errors: []`（`:376-431`），根目录读失败就静默跳过（`findSkillDirs` 的 `catch { return; }`，`:126-135`）。

---

## 3. mcp-router / skill-router 的「路由」语义与「能力快照」

### 3.1 MCP router：按 agent + 按项目，不按插件

- `internal/library/mcp_hub.go:106-124` `hubServerFor`：给一个 agent 写一个名为 `magpie` 的 Streamable HTTP entry，URL 是 `gatewayOf(t) + gateway.HubMCPPath + url.PathEscape(agentID)`；跨机（WSL/LAN）时带 `Authorization: Bearer <key>`。
- `mcp_hub.go:156-178` `hubFor` 的判定：`MCPHub` 开 + target 有 MCP 位置 + 至少一个 tick 给它的 server 且 `inHub` + 该格式 `supports()` 这个远程 entry + library 里没有叫 `magpie` 的 server + agent 自己没有 `magpie` entry。返回 `no-remote|taken|own` 作为「为什么没给它」。
- `mcp_hub.go:207-229` `hubServers(agentID)`：agent id 里带 `<agent>~<projectKey>` 时，取全局集合 + 项目自己的 server - 项目关掉的 server；`project_scope.go:117-151` 只对 **Claude Code 和 Codex** 生成项目 hub entry；`project_scope.go:49-52` 明确 `projectOffAgents = {claude, codex}`、`projectSkillOffAgents = {claude}`。**不存在按插件的路由维度**：插件贡献的 server 会作为 library 的一个普通 `Server` 存在（`plugin_tools.go:3-27`），然后照常按 agent tick。
- 「其他 app」：`/mcp/magpie/hub`（agent `""`）拿 library 的全部 server，但 `Server.Hidden` / 插件对 agents 隐藏的 server 除外（`mcp_hub.go:193-229`）。
- 运行时工具集：`mcp_hub.go:265-306` 的 `Tools(ctx, agentID)` 才真正列出该 agent 能看到的工具；每个 server 的 `DisabledTools` 被过滤（`:291-297`）。超时预算：`hub_mcp.go:108-116` 明说「a server that couldn't be reached by ctx's end is left out」；`:270-277` `hubListWait=40s`、`hubCallWait=50s`（后者低于 MCP 客户端 60s，好让模型知道是哪台 server 没答，而不是自己超时）。

### 3.2 Skill router：按「技能文件夹」路由，不按项目

- `internal/library/skill_router.go:3-33` 的包注释就是完整语义：router 开时，给每个 agent 的技能文件夹放**一个** magpie 的技能 `magpie-skills`，其 SKILL.md 列出该 agent 被 tick 的技能，每个带 description 和自己的 SKILL.md 路径；agent 只把这一份 description 带进 prompt。**替代的是「每个技能一条 link」，不是替代技能文件夹本身。**
- `skill_router.go:98-115` `routerDir(dir) = <settings>/skill-router/<sha256(realDir(dir)) 前 6 字节 hex>/`，`routerOurs` 用「链接是否指向 router 根」判断是不是 magpie 的。
- `:117-135` `routerWhy`：哪些 agent 不能路由、为什么——`copies`（WSL/用户选择副本）、`liveagent`、`shared`（文件夹本身就是 `~/.agents/skills`）、`taken`（library 有同名 `magpie-skills`）、`own`（用户自己的 `magpie-skills`）。
- `:147-172` `routedFor`：每个 tick 给该 agent（或读同一文件夹的 agent）的技能，排除 `Skill.Router == "direct"`、`Manual`（`disable-model-invocation`）、在 `~/.agents/skills` 本来就能找到的、`blockedSkills`、agent 自己有同名 entry 的。
- `:327-396` `writeRouter`：写 `SKILL.md`（front matter `name: magpie-skills`，description ≤1024 字节，超了 Codex 拒绝，`:68-70`），并在隐藏目录 `.skills/` 下给每个技能建链接；`.skills` 隐藏是为了防止 Codex/OpenCode/Pi 这些「在技能文件夹下面递归找 SKILL.md」的 agent 找到第二份。
- **没有项目级 skill 路由**：router 只对 `t.Skills` 生效；项目技能由 `syncProjects` 走 `project_scope.go` 单独写到项目文件夹（`project_scope.go:19-45` 注释说明项目技能关闭用 Claude Code 的 `skillOverrides`，只有 claude 支持）。`library.md:85` 的「Not covered」也明确列出项目技能不受 `OffHere` 影响。

### 3.3 「能力快照」：有，但是三层计算结果，不是持久文件

1. **配置层（`AgentView`）**：`internal/library/sync.go:391-448`，每个 agent 一份：
   - 路径：`Instructions` / `MCP` / `Skills` / `ProjectSkills` / `ProjectMCP`；
   - 能力：`SkillsAlso`、`NoSSE`、`NoRemote`、`NoEnvRefs`、`ToolsOff`、`Startup`、`MCPVia`；
   - router 状态：`Hub`（`on|no-remote|taken|own`）、`SkillRouter`（`on|copies|liveagent|shared|taken|own`）、`How`（link/copy）、`HowOwn`、`MustCopy`；
   - 存在状态：`Gone`、`Asleep`、`Unseen`。
2. **条目层（`ServerView` / `SkillView`）**：`sync.go:450-503`。`ServerView.Problems map[agent]string`——「这个 server 给这个 agent 失败的原因」；`SkillView` 有 `Always`（共享目录让哪些 agent 无条件可用）、`Shared`/`SharedElsewhere`、`Behind`（副本落后）、`Edited`、`Gone`、`OffHere`、`Manual`、`Router`。
3. **运行时层**：`hubServers(agentID)` / `theHub.Tools(ctx, agentID)`（`mcp_hub.go:207-229,265-306`）是「此刻这个 agent 实际会拿到的 server/tool 集」，含项目变体；`routedFor(t)`（`skill_router.go:147-172`）是「此刻这个技能文件夹实际会被列出的技能集」。
- 因此，**能力快照 = 状态 + 原因 + 证据（哪个文件/哪个 item）**，而且同一套状态会在页面、CLI、router 运行时复用。这正是我们 `src/env/inventory.js` 最缺的：它只给 `agents[].mcp`（服务名数组）与 `skills`（数量），没有「这个 agent 为什么没有某个能力」。

---

## 4. agent-wiring 的绑定模型：provider 是源，agent 是投影；登录态反向成为 provider

### 4.1 Agent 描述符是「schema」，provider/catalog 是「data」

- `internal/agent/agent.go:122-212`：`Agent` 有 `ID/Name/Icon/Aliases/Bin/Dir/Path/Plugin/Fields/Native`，以及 `Sync`/`Unwire`/`Restore`/`Join`/`Routed`/`Follow`/`Check`/`LastUsed`/`Reached`/`Import`/`Launch`/`SplitSuffix`/`Spelled`/`ModelAliases` 等钩子。**每个 agent 的「配置怎么写」是代码描述的，不是通用模板。**
- `agent.go:25-96` `Option`（`Value/Label/Ref/Direct/Via/Same/Rate/Context/Takes/Alias/FastFor/...`）和 `:98-119` `Field`（`Key/Label/Get/Set/Options/Quiet/Live/Follows`）：Field 是「一个可调项」的最小抽象——`Set("")` 回到 agent 自己的默认（magpie 写进去的东西全部撤掉），`Quiet` 跟随别的 field，`Live` 表示改动即时生效不用重启。**provider → agent 的「绑定」就是一堆 Field 的投影**，不是一张独立的绑定表。
- `internal/agent/applied.go:33-40,42`：`applied.json` 记录「magpie 在每个 agent 上设过什么」（`Fields: map[fieldKey]value` + `At` + `Kept`）；`:109-140` `Apply` 每次设置都写记录；`:482-508` `setUp`/`handWired` 区分「magpie 设的」和「用户自己写的 provider 叫 magpie」；`:511-531` `Wired()` 只读当前配置判断是否已接上。
- `internal/agent/stash.go:31-33,88-123`：`stash.json` 记录「magpie 设置之前本来是什么」；Disconnect 用它恢复，而不是猜默认值。
- `internal/agent/applied.go:142-164,175-262`：`Drift` 把「源（magpie 应有的值）」「记录（applied.json）」「实际（配置文件现在读到的值）」三方对比，枚举 5 种偏差：`unwired`（配置不再指向 magpie）、`replaced`（被 agent 自己的模型替换）、`bypassed`（配置对，但最近请求没到 gateway——老进程还跑着旧配置）、`unreachable`（地址不通）、`proxied`（代理没转发）。**这是「谁是来源、谁是派生」最完整的实现：provider 是来源；agent 是派生；applied 是派生记录；stash 是原始备份；Drift 是对账。**

### 4.2 但登录态的方向是反的：agent 的凭证变成 provider

- `internal/provider/account.go:3-9` 原话：**「Accounts: agents the user has signed in to, offered as providers. … magpie reads the credentials the agent itself keeps on disk or in the macOS Keychain, so every other agent can use those models through the gateway. Nothing is stored twice: sign out of the agent and the provider is gone.」**
- `account.go:915-947` `Accounts()` 依次读 Claude、Codex、Copilot、siwc、Gemini/Antigravity 的登录；`:944-946` 被插件接管的 built-in 从列表里删掉，插件账号补到原位置。
- `internal/provider/provider.go:910-943` `All()` = 用户存的 providers + `Accounts()`；`settings.AccountDiscoveryOff()` 可整体关掉账号发现（`:917-919`）。
- 所以绑定不是单向的：
  - **配置投影方向**：`providers.json` / catalog → Agent 的 `Field` 值（model/endpoint/key）；
  - **凭证发现方向**：Agent 自己的 `auth.json` / `.credentials.json` / Keychain → `Accounts()` → provider 列表；
  - 两者都靠 `applied.json` + `stash.json` 保证可逆/可审计，靠 `Drift` 发现外部改动。

### 4.3 一个 agent 的「能力」由哪些输入合成

按 magpie 的代码，能列全的输入是：

1. **Agent 描述符**：`Agent.Fields`/`Native`/各种钩子（`agent.go:122-212`）——每家自己的配置格式、默认值、检测方式。
2. **Provider/catalog**：`providers.json` + `Accounts()` + vendor 模型列表 + models.dev（`provider.go:910-943`；doc `providers-accounts.md:35-38`）。
3. **Settings**：`HiddenModels` / `PickedModels` / routing groups / 每 agent 的 compact/telemetry 等（doc `agent-wiring.md:15-16`，`agent.go:141-169`）。
4. **凭据**：agent 自己的登录态（`account.go:3-9`）。
5. **插件**：`agentplug` 的 `magpie.agent` 模块给出 `config/format/model/prefix`、`connect` 返回要写的键、`agent.library` 给出 Instructions/MCP/Skills 的位置（`targets.go:671-700` `pluginTarget`；doc `agent-wiring.md:39`）。
6. **环境变量型 agent**：没有配置文件可写的，给 `Launch` 命令/环境变量（doc `agent-wiring.md:40` 的 Antigravity CLI/Cursor Private Inference）。
7. **默认值**：`Field.Set("")` 回到 agent 默认（`agent.go:98-100`）；`ownOptions`/`static` 等给 agent 自己的模型选项（`agent.go:497-515`）。

### 4.4 对我们 `inventory.js` 的映射

- `src/env/inventory.js:33-46` 的 `AGENT_PRESENCE` 是「agent → 若干 config 路径 + 若干 data 路径」的硬编码表，`exists()`（`:64-72`）只回 boolean 且把 `EACCES` 等所有异常都当「不存在」。这等于把 magpie 的 `Agent{Bin,Dir,Path}` + `Detected()`/`CLIMissing()`/`SharedHere()` 压成了一个过度简化的「目录在不在」。
- `internal/agent/install.go:280-304` `CLIMissing`：agent 仅凭 settings 还在、CLI 不在 PATH/用户工具目录/安装器目录，且没有别的读这个文件夹的 app/extension 时，是「卸载残留」，页面显示 gone，**不能算 present**。我们的 `detectPresence` 会把这类残留判成 `config` 级 present。
- `targets.go:929-987` `targetsAsleep`：`Detected() || SharedHere()`；`CLIMissing()` 且非 gone 时跳过；WSL 停止的 distro 里的 agent 不打开文件（`:934-937,963-967`），只按上次 `wsl.json` 的 shape 列出 `asleep`/`unseen`。
- `targets.go:671-700`：插件 agent 的位置来自 `agent.library`，`pluginTarget` 返回 nil 表示没地方；我们完全没有「plugin agent」这一层。

---

## 5. 不变量与失败处理（照抄原话 + 代码位置）

> 这一节是整份报告最值得直接搬的部分。magpie 在「读不到 ≠ 没有」上写得比大多数工具都狠，因为它写配置——一次误判会把用户的文件清空。

1. **`providers.json` 读失败 ≠ 空列表**
   - `internal/provider/provider.go:783-796`：
     > `ErrUnreadable is a providers.json that is there but can't be read or decoded: never an empty catalog, to list as none, back up or write over.`
     > `... can't be read (...); magpie left it unchanged — fix it or move it aside`
   - `provider.go:798-830`：`read()` 对 `os.ErrNotExist` 返回空（首次使用），其他错误返回 `unreadableError`；JSON 解析失败先 `lastgood.Fallback` 找 `.bak`，再失败才是 unknown。`load()`（启动/网关）允许带空继续跑（`:752-758`），但 `FileError()`（`:840-850`）让「列 providers 的页面」能把 unknown 说出来，而不是显示「none yet」。
   - 文档 `providers-accounts.md:389`：
     > `An unreadable providers.json is an error, never an empty list. Saving over an empty list would lose every provider.`
2. **指令文本读不到 ≠ 空文本（真实事故 #5709）**
   - `internal/library/instructions.go:309-316` `unreadable()`：只有 `os.ErrNotExist` 算「没有」，其他错误都返回 error；
   - `:318-324` `instructionsLost()`：没有 agent tick、或共享文本为空，就是「library 丢了指令」，**不是用户要求撤回**；
   - `:326-335` 注释：
     > `a library reading empty has lost its instructions, not revoked them, and the parts out there are then the only copy left (#5709, where a start-up apply with an empty Library wiped nine agents' files).`
   - `:346-352`：
     > `a text that can't be read is unknown, not empty: writing what is left would take the agent's part out or cut it down (#5709)`
   - `:400-416`：自动写（sync/启动）遇到 `want == ""` 且 `ok` 且 `instructionsLost()` 时**原样留下、只记日志**，绝不删除；只有页面上的显式写（take-back）才清空。`:426-434` 自动写会「原地清空文件」但绝不删除整个文件。
   - 文档 `library.md:56` 是同一段的中文摘要。
3. **技能副本「没整份扫完」就不能替换/重链/删除**
   - `docs/subsystems/library.md:59`：
     > `A copy's mark establishes that it is unchanged only after its whole folder was scanned. If a subtree or its metadata can't be read, the copy stays in place and the sync reports a Problem; it isn't replaced, relinked or removed. A later sync tries again once it can be read.`
   - `treememo.go:10-13,27-55`：
     > `... a folder not read whole is unknown: it is read again next time, never taken as unchanged.`
     `settleFor = 3 * time.Second`：最近 3 秒内写过的文件夹一律 `settled=false`，其 hash/比较结果不缓存；
   - `skill_edits.go:27-34`：`takeEdits` 扫描失败 → `res.fail` 并记入 `blockedSkills[realDir(p)]`，`syncSkills` 里跳过该副本（不替换）。
4. **插件清单读不到 → 什么都不加、什么都不删**
   - `internal/library/plugin_tools.go:90-94`：
     > `pl, err := pluginsInstalled(); if err != nil { return false // unknown: nothing added, nothing taken out }`
   - 同文件 `:3-27` 的注释还有一条：「A plugin turned off keeps its server, which lists nothing until the plugin is on again. A plugins.json that can't be read takes nothing out.」
5. **并发写：一个 change 一次，但只保证进程内**
   - `internal/library/library.go:179-191`：`var mu lock`（`sync.Mutex` 计数版）；`:333-361` `change` = 锁 → load → 改 → save → sync → save。注释说「One change runs at a time, whether from the page or the CLI.」
   - **`library.go` 的 `change` 只有进程内 `sync.Mutex`，未见 `filelock`**（本轮只精读了 library 包与问题相关的文件，未逐个子文件 grep 并发/锁实现）；跨进程（app + `magpie library ...` 两个进程）library.json 的写看起来不是 OS 锁保护的——这是它的弱点，不是要抄的点。magpie 真正做跨进程锁的是：
     - `internal/filelock/filelock.go:32` `Lock(path, wait)`、`:64-90` `Mutex`（`sync.Mutex` + 文件锁，Unix flock / Windows `LockFileEx`）；
     - `internal/library/mcp.go:1596-1601` `claudeLock()`：写 `~/.claude.json` 时取 Claude Code 自己的锁（`claudelock.Config`），免得 Claude 自己的保存和 magpie 的写互相吞；
     - `providers-accounts.md:393`：`loginsMu` 是 `filelock.Mutex`，持 `logins.json.lock`，每次拿锁后 `filememo.Look` 重读，`logins.json.renew.lock` 保证两个 magpie 不花同一个 refresh token；`filelock.Wait` 10s 拿不到就放弃。
6. **状态文件写坏/机器断电：lastgood + 原子写 + 零字节识别**
   - `providers-accounts.md:390-392`：
     > `When logins.json cannot be decoded as saved accounts, reads keep the accounts read before. Before saving a change, lastgood.Keep keeps the file there now ...`
     > `... a machine that went down mid-write left logins.json and plugin-auth.json at their full length, every byte zero (#1505): the rename reached the disk before the data. Every write of magpie's own state goes through steady.WriteFile (or edit.WriteAtomic), which flushes the temp file before renaming it in ...`
     > `... A state file whose reader takes one that doesn't unmarshal into its type as empty is copied aside before it is written over (lastgood.KeepUnparsed ...), valid JSON of another shape, [] for a map, counts as not parsing. A copy that can't be made stops the write.`
   - 代码：`internal/steady/steady.go:151-160`（temp 文件、flush、rename）；`internal/edit/file.go:124-216`（`WriteAtomic`：`os.CreateTemp` → 写 → `Sync` → `steady.Rename` → 清 stale temp）；`internal/agent/applied.go:53-66` `appliedSave` 先 `lastgood.KeepUnparsed(appliedPath(), lastgood.Into[map[string]applied])`，拷贝失败就不覆盖。
7. **为写而读永远重读，不用缓存**
   - `internal/edit/file.go:23-39`：
     > `It is looked at even while a request holds what was read (filememo.Hold), as what is read here is what a write is made from: bytes held from a second ago would write back over what another app wrote since.`
   - `edit/file.go:41-47` `readHeld` 是只读页面的缓存读（1 秒内同文件不重复看），与写路径分开。
8. **CLI/PATH 查找缓存：目录刚变过就不缓存、不信 stamp**
   - `internal/proc/look.go:13-37`：`lookFresh = 2s`（PATH 文件夹 stamp 信任期）、`lookSettle = 100ms`（文件夹 mtime 在 100ms 内刚变过 → `settled=false`，本次任何结果都不缓存；文档 `agent-wiring.md:214` 说「A directory modified in the last 100ms is read again rather than cached, so an installer writing in the same filesystem clock tick does not leave a permanent cached miss (#3141)」）。
   - `look.go:93-128`：`looked()` 只有 `gen` 与 `stamp` 都没变、且 `stamp != ""` 时才缓存答案；跨 `Forget`/PATH 变化/未 settle 的答案一律丢弃。
9. **单个 agent 失败是 `Problem`，不影响其他 agent**
   - `internal/library/sync.go:16-71`：`Result.Problems []Problem{Agent, What, Error, Own}`；`sync.go:79-81` `fail()` 追加而不 panic；`docs/subsystems/library.md:60`：
     > `A failure for one agent is a Problem in the result. It doesn't stop the others.`
10. **不能把条目记给「没有地方放」的 agent**
    - `targets.go:1108-1162` `Takes()`：agent 没安装 / CLI 缺失 / 没有该类位置，都返回 error，并给出 `noPlace`/`takenBy`（「这里谁能收」）。
    - `docs/subsystems/library.md:97`：
      > `An agent with no place for an item is refused by Takes, never recorded as given it. The refusal lists the agents here that take that item (takenBy), and says where it goes instead (noPlace)`
11. **MCP 检查：每一步独立预算，超时不是错误缓存**
    - `internal/library/mcp_check.go:85-93`：`stdioStep = 30s`、`remoteStep = 60s`，每一步（initialize / notifications/initialized / tools/list）单独计时；`:67-71` 超时结果带 `Step` 和 `Waited`（毫秒）。
    - `docs/subsystems/library.md:27`：`a timeout isn't kept, so the next look asks again (#1467)`——超时不会把 server 永久标成坏。
    - Router 侧：`hub_mcp.go:108-116`「unreached server is left out of the list, not an error」；`hub_mcp.go:270-277` 40s/50s 预算。
12. **`unknown` 在 UI 上必须是一种可见状态，不能混成「没有」**
    - `docs/subsystems/agent-wiring.md:321-322`：某状态「can't be read, or a stopped WSL distro's, is unknown, never 'not added'」；测试 `TestCindyHasClosedWALAndUnreadable`、`TestImportStatusUnreadableIsUnknown`。
    - `docs/subsystems/library.md:22` 的 `asleep`/`unseen`：停止的 WSL distro 不打开文件（会启动 distro）、只按 `wsl.json` 的 shape 列出；「one magpie never saw there is listed only on the rows that name it, as `unseen`, its ticks not shown」。

---

## 6. 给 agent-archive 的采纳建议（P0 / P1 / 不抄）

> 取舍口径：我们是**只读档案馆 + 跨 Agent 识别引擎**（README：「扫描 → 归一 → 时间线」，不改 Agent 配置、不转发请求）。
> 所以「写侧」的实现一律不抄；「读侧如何建模状态、如何不把未知说成空」全部可抄。

### P0（建议本轮就做，成本小、直接改对事实层）

| # | 抄什么 | 改哪个文件 | 为什么值 |
|---|---|---|---|
| P0-1 | **三态读取：ok / missing / unreadable / unparsable**，且每一层都保留下来（files[] 里每个 source 带 status/error；summary 不算「0」而是「unknown」） | `src/env/mcp.js`（`scanMcp` `:526-594`、`readJson` `:291-297`、`readText` `:299-305`）；`src/env/skills.js`（`scanSkills` `:376-431`、`findSkillDirs` `:121-135`）；`src/env/inventory.js`（`exists` `:64-72`、`detectPresence` `:79-92`） | 公开 `mcpSummary`/`skillSummary`/`auditEnvironment` 目前把「JSON 坏了」「TOML/YAML 解析静默空」「目录没权限」都折成 0 或跳过。magpie 的 `ErrUnreadable`（`provider.go:783-796`）和 `instructions.go:346-352` 都是踩过事故后写的：**未知 ≠ 空**。我们做「体检」，把读不到报成「没有」会让用户做错决定。 |
| P0-2 | **per-agent 能力快照**：`agents[]` 从「mcp 名称数组 + skills 计数」升级为 `capabilities: { mcp: {state, items[], problems{}}, skills: {...}, cli: {...} }`，状态至少 `provided / shared / copy / own / candidate-only / not-applicable / unknown / gone`，每条带 `reason` 和证据路径 | `src/env/inventory.js`（`fullInventory` `:164-255`、`agents.map` `:196-219`、`auditEnvironment` `:263-373`） | magpie 的 `AgentView`（`sync.go:391-448`）+ `ServerView.Problems`/`SkillView.Always`（`sync.go:450-503`）证明「能力」必须带原因：`no-remote`、`taken`、`own`、`copies`、`liveagent`、`shared`、`behind`、`gone`、`asleep`、`unseen`。我们现在的 `skills` 计数把「Kiro 链接到共享目录」和「Kiro 真有一份副本」算成同一件事（`inventory.js:205-208` 注释自己承认不去重）。 |
| P0-3 | **补 DeepSeek Harness 自己的 MCP 源**：dsh 的 MCP 不是 `mcpServers` 文件，而是各 profile patch list 里 `@deepseek-ai/dsh-mcp-client` 的 insert 行（`serverName ≤32 [A-Za-z0-9_-]`），多 profile 用 `Path + Also` 合并 | `src/env/mcp.js`：`SOURCES` 加 `dsh`（格式 `yaml-dsh-patch`），解析参考 `internal/library/dsh.go:3-18,36-44,79-135,231-246`；`src/env/skills.js` 的 `ROOTS` 加 `$DSH_HOME/skills`（或 `.dsh/skills`） | 这个项目本身就跑在 DeepSeek Harness 里；`inventory.js:38` 已经把 dsh 列为 present，但 `mcp.js` 的 10 个 source 里没有 dsh——**结果是「dsh 存在但一个 MCP 都没有」的假空**。这是最直接、最可验证的「他们有、我们没有」。 |
| P0-4 | **技能按整个文件夹 hash**（排除 `node_modules`/`.venv`/`__pycache__`/lock 文件等安装产物），并保留 `ownHash`；有 git source 时再记 `commit` | `src/env/skills.js`：`readSkill` `:316-369`（现在只有 `sha256(SKILL.md)` `:340-359`）、`groupByHash` `:483-549` | 只 hash SKILL.md 会把「同名同描述、脚本不同」的两份技能合成一个能力。magpie 的 `Skill.Hash`/`Own`/`Commit`（`skills.go:34-49`）和 `ownHash`（`skill_changed.go:72-75`）就是为此设计的；我们不需要它的「只在 fetch 时 hash」，但需要它的「hash 整棵树、排除安装产物」。 |

### P1（下一轮做，扩大覆盖面 / 提升判别力）

| # | 抄什么 | 改哪个文件 | 为什么值 |
|---|---|---|---|
| P1-1 | **把 `targets.go:143-605` 当作 per-agent 位置/格式 checklist**，把 MCP source 从 10 个扩到覆盖常见桌面 app：codex 多 profile、Claude Desktop（含 3p `Also`）、WorkBuddy、CodeBuddy、Droid、Pi/PiNative、omp/OmO/mu、Goose、Crush、Kimi、Zed、Alma、Antigravity/agy、Cline、CommandCode、Devin、Grok、LiveAgent | `src/env/mcp.js`（`SOURCES` `:28-94`，新增 format 常量与解析器） | 我们的 README 把「认得多少家」当核心指标；magpie 的 25 种 `mcpFormat`（`mcp.go:236-290`）是一份现成的覆盖地图。优先补用户本机真实装了的（workbuddy/codebuddy/droid/pi），不必一次全上。 |
| P1-2 | **`Also`/`Extra` 多文件合并**：一个 agent 的 MCP 可写在多个文件（dsh 各 profile、Claude Desktop 3p、pi-mcp-extension），读取时合并、**第一个文件赢同名**；每个文件单独记 status | `src/env/mcp.js` `scanMcp` | 现在我们的 `seenFiles`（`:530-542`）跨 agent 全局去重，遇到「同一文件被两家读」会吞掉后一家；且多 profile 的 dsh 只读一个文件。magpie `mcp.go:1260-1281` 的「first file wins a name」是明确语义。 |
| P1-3 | **定义冲突检测**：同一 `service` 指纹下，若 command/args/url/headerKeys/envKeys 有实质差异 → 输出 `definitionConflicts`（而不是只按 `mixedForms` 说安装形态不同） | `src/env/mcp.js` `groupByService` `:602-653`、`mcpSummary` `:673-709`；`src/env/inventory.js` `auditEnvironment` `:267-287` | magpie `Found.Others`（`mcp.go:1791-1826`）和 `same()`（`:229-232`）证明「同名不同定义」要单列。我们的 `fingerprintOf` 故意忽略 env 值/headers（好，用于合并），但会导致同一服务在两家的 token/URL 尾路径不同时被静默合并；至少要报出来。 |
| P1-4 | **技能副本/同名/共享读者模型**：`Copies`（同文件不同目录）、`Others`（同名不同内容）、`Shared`（`~/.agents/skills` 的 entry）、`Always`（读共享目录的 agent 无条件可用）；`readsShared` 列表 + Pi/omp 版本门槛 | `src/env/skills.js` `scanSkills`/`groupByHash`；`src/env/inventory.js` `skills` 汇总 | 对应 `skills.go:2324-2430` 的 `FoundSkill`、`targets.go:1022-1080` 的 `readsShared`/`readsWith`、`sync.go:737-741` 的 `Always`。这是「我到底有什么能力」与「这个文件在几个地方」的分界，我们现在只有 hash 分组 + symlink 计数。 |
| P1-5 | **启用语义**：读 `disable-model-invocation`（Manual）与各格式的 `enabled`/`disabled`，输出 `manualOnly` / `enabled:false`；不把「用户关掉的 server」算成可用能力 | `src/env/skills.js` `parseFrontmatter` `:211-246`；`src/env/mcp.js` `normalize` `:490-517` | magpie `meta.Manual`（`skills.go:168-198`）、`Skill.OffHere`/`gives`（`:56-79`）、`Server.Hidden/Paused`（`mcp_on.go:16-36`）。我们现在的「发现」等于「可用」，会把手动技能和停用 server 报成能力。 |
| P1-6 | **指令/记忆目标模型**：一个 agent 的 instructions 可能是「第一个存在的几个文件之一」、可能是 JSON 里的某个 key path（WorkBuddy `personalization.customPrompt`）、可能是用户 profile（Alma `USER.md`，front matter 必须留在最前）；MCP 也可能通过扩展间接读（`MCPVia`） | `src/env/memory.js`（`TARGETS` `:32-95`） | `targets.go:22-43,608-636` 的 `Instructions/Override/Field/Profile/MCPVia` 是完整的「一个 agent 的指令可能在哪」模型；我们 `memory.js` 目前是硬编码路径，会漏 Qwen/Qoder 的 `context.fileName` 改名和 WorkBuddy 的 JSON 字段。 |
| P1-7 | **presence 升级为 Agent 描述符**：`Bin`（命令）+ `Dir`（文件夹）+ `Path`（配置文件）三源检测；`CLIMissing`（卸载残留 → gone）；`SharedHere`（vendor 别的 app 共享目录）；`Gone/Asleep/Unseen`；把 Claude Desktop、Kiro CLI 这类「不是 agent 但仍是 MCP/技能宿主」的 app 也列出来 | `src/env/inventory.js` `AGENT_PRESENCE` `:33-46`、`detectPresence` `:79-92`；`src/env/cli.js` 的 `cliSummary` 可复用 | `agent.go:429-457` `Detected()`、`install.go:280-304` `CLIMissing`、`targets.go:884-918` `apps()`。这直接修「卸载了但目录还在 → 报成已安装」和「装了 Claude Desktop 但没 CLI → 完全看不见」两个误判。 |
| P1-8 | **缓存失效按文件 stamp + settle 窗口**：缓存 key 至少含 path、type、size、mtime；最近 3 秒内写过的文件夹不缓存结果；不可读的文件不进缓存 | `src/env/inventory.js`（`INVENTORY_TTL_MS` `:107`、`readInventoryDisk` `:128-138`）；`src/env/skills.js`（`loadCache` `:279-287` 的 mtime+size） | magpie `treememo.go:27-55` 的 `settleFor=3s`、`proc/look.go:27-37` 的 `lookSettle=100ms` 是同一类「时钟太粗，刚写过的不能信」。我们的 30 分钟磁盘 TTL 会让「刚装了一个技能/MCP」在半小时内不可见；按 stamp 失效更准。 |
| P1-9 | **缓存文件原子写**：skills 的 `fs.writeFileSync(cacheFile())`（`:291-300`）改成 tmp + rename（inventory 的 `writeInventoryDisk` 已经是 tmp+rename，`inventory.js:140-150`） | `src/env/skills.js` | `steady.go:151-160` / `edit/file.go:124-216`：崩溃时不要留下半份缓存；虽然缓存坏了可重建，但「静默损坏 → 下次全量重扫」是我们要避免的慢路径。 |

### 不抄（见 §7 的理由）

- 写配置 / `Applied` / `stash` / 备份 / `removeServer` / `sync` 全套。
- MCP router 的 gateway 实现：`hubMCP`、`hubPool`、`hubPrune`、`find_tools`/`call_tool` 的按需工具、project hub key。
- Skill router 的 `placeRouter`/`writeRouter`/Claude Code `permissions.allow` 规则写入。
- Provider gateway / account switching / quota / balance。
- 以「文件里的键名」作为服务身份的主键。
- 只对 GitHub 来源技能算 hash 的做法。

---

## 7. 明确「不抄」的理由

1. **它是网关 + 配置写入器，我们是只读档案馆。** magpie 的所有复杂逻辑最终服务于「把 library 的内容写进每个 agent 的原生配置文件，并能安全撤回」：`change`（`library.go:333-361`）、`syncMCP`/`syncSkills`、`Applied`/`stash`、`removeX`、`copyIn`/`markCopy`。我们 README 的承诺是「不往 Agent 里注入任何东西，也不改 Agent 配置文件或转发请求」。抄写侧会把「事实」变成「我们造成的状态」，也会带来 `#5709` 那类清空用户文件的风险。
2. **MCP router / skill router 是运行时网关能力，不是盘点能力。** `hubMCP`（`hub_mcp.go:283+`）需要进程池、HTTP 会话、鉴权、项目 key、工具搜索；`placeRouter`（`skill_router.go:174-220`）需要往 agent 技能文件夹写链接和 Claude Code 的权限规则。我们的 `inventory` 只回答「有什么」，不需要也不应该起进程。
3. **Provider/account 层涉及凭证与路由，超出环境层。** `Accounts()` 要读 Keychain/`auth.json`/`.credentials.json`（`account.go:3-9,915-947`），`Drift` 要做请求级对账（`applied.go:175-262`）。我们的安全边界是「env/headers 的值绝不出模块」（`src/env/mcp.js:12-15`）、不读凭据值。可以借「状态 + 原因」的建模，不借读凭证的实现。
4. **按名识别不适合我们。** magpie 必须保留每个 agent 的原生键名，否则写不回去；它没有跨名合并的动机。我们的核心差异化恰恰是启动指纹归一（`src/env/mcp.js:1-15` 注释、`:357-395`）。只吸收它的「同名不同定义要报冲突」，不吸收它的「不归一」。
5. **它对本地 folder 技能不算 hash。** magpie 的 `Skill.Hash` 只对 GitHub/git 来源有意义（`skills.go:34-49`、`skill_changed.go:3-12`），因为它的「更新」只从远端拉；我们的档案要回答「这台机器上到底有几份不同技能」，本地 folder 技能也必须整树 hash（P0-4）。这一点反过来：**我们的做法更对，不要被它带偏。**
6. **性能取舍不同。** 它的 `filememo`/`treememo`/`proc.Look` 缓存是为了让一个常驻网关每秒多次看配置不炸 CPU；我们是按需扫描 + 30 分钟磁盘缓存。可以借「settle/stamp」的正确性规则（P1-8），但不需要搬它那套全局 memo 基础设施。

---

## 附：一句话结论（给 lead）

- MCP：magpie 用 `Target{mcpFile{Path,Format,Also,Extra}}` 覆盖 25 种格式、按「文件键名 + 精确定义」发现/去重，不跨名归一；我们有指纹归一（更强），缺的是格式/位置覆盖、多文件合并、`enabled`/`Hidden`、以及「同名不同定义」冲突。
- 技能：magpie 有整树 `Hash`/`Own`/`Commit`、`Manual`/`OffHere`、`Copies/Others/Shared/Always`；我们只 hash SKILL.md，缺启用与副本语义。
- 路由：mcp-router 按 agent + 项目（仅 Claude Code/Codex 项目 hub），skill-router 按技能文件夹（不按项目、不按插件）；两者都是「一个入口替代 N 个条目」的运行时网关能力。
- 绑定：provider/catalog 是源，agent 是 Field 投影；agent 的登录态又反向成为 `Accounts()` 的 provider（不存两份）；`applied`/`stash`/`Drift` 是三方对账。
- 不变量：`ErrUnreadable` 永不等于空、指令读不到是 unknown（#5709）、副本没整份扫完不替换、插件清单读不到不增删、`settle` 窗口/`filelock`/`lastgood`/原子写。我们的 `exists()`/`errors: []` 全面违反第一条，是最大差距。
