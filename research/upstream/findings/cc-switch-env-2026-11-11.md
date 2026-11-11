# cc-switch 环境/资产盘点层（MCP · 渠道 · 写入安全）深读

## §0 证据口径

- 镜像：`<用户目录>\.agent-archive\upstream-cache\cc-switch`
- **FETCH_HEAD = `abf50589ed0ff60900ead3a83cfda9ff009cd6ef`**（2026-11-11）；本地 HEAD 仍是
  `7afceec1`，两者之间 465 个文件有差异。**浅克隆，不做提交级归因**，全部是"该版本文件里这么写"。
- 行号一律相对 `FETCH_HEAD:<path>`；用 `git show FETCH_HEAD:<path>` 逐文件读。
- 读了（全部逐行）：`src-tauri/src/services/mcp.rs`（918 行全读）、`services/mcp_connectivity.rs`
  （439 行全读）、`services/mcp_connectivity/tests.rs`（472 行，读关键段）、`services/mcp.rs` 的
  调用方 `src-tauri/src/mcp/mod.rs`、`mcp/claude.rs`、`mcp/validation.rs`、`mcp/{dsh,kimi,mcode,pi,agy,
  omp,copilot,grokbuild,hermes,opencode,gemini,codex}.rs`（各读头部契约）、`src-tauri/src/app_config.rs`
  （McpApps/McpServer/AppType）、`provider.rs`（结构体与枚举）、`error.rs`（全读）、
  `src-tauri/src/config.rs` 的 atomic_write/stage_write/commit_staged（455-770）、
  `claude_mcp.rs`、`services/pi_prompt_files.rs`（revision/Conflict 段）、`jsonc_document.rs`（头部）、
  `services/config.rs`（备份）、`services/backup_storage.rs`（头部）、`services/env_checker.rs`（全读）、
  `services/stream_check.rs`（头部）、`services/provider/endpoints.rs`（头部）、`services/mod.rs`。
- 对比读了我们的：`src/env/mcp.js`（全读 711 行）、`src/env/inventory.js`、`src/env/cli.js`、
  `src/env/skills.js`（结构与关键注释）、`src/scanners/dsh.js`。
- **没核实**：没编译、没运行；前端 30+ 个 `*ProviderPresets.ts` 只 grep 了 `category` 取值；
  `proxy/`、`services/provider/*_direct.rs` 的写入引擎内部没深读；没核 macOS 侧真实路径（本机 Windows）。
- 本轮新增/改动的重点（`git diff HEAD FETCH_HEAD --stat`）：`mcp/copilot.rs` **+519 行（新客户端）**、
  `services/mcp_connectivity.rs` +146（新增 `ConnectivityStatus` 三态）、`services/mcp.rs` +37
  （把 Copilot 接进嵌套提交链）。其余是同化改动（各 `mcp/*.rs` 各 1 行、`mod.rs` 1 行）。

---

## §1 MCP 配置发现：谁、什么格式、怎么合并

**一套统一模型 + 每家一个适配器（不是统一解析器）**。统一模型是 `McpServer{id,name,server:Value,
apps:McpApps,…}`（`app_config.rs:356-371`），`McpApps` 是 **15 个 bool**（`app_config.rs:9-36`），
`AppType` 枚举 15 个客户端（`app_config.rs:482-503`）。每家的读写各一个模块
（`mcp/mod.rs:15-50`），`services/mcp.rs` 只做编排与投影。

各家路径 / 格式（全部是 `FILE:LINE` 的注释或常量）：

| 客户端 | 路径 | 格式 | 证据 |
|---|---|---|---|
| Claude Code | `~/.claude.json` 顶层 `mcpServers`；另镜像到各官方账号目录 | JSON（只覆盖 `mcpServers`，其余字段保留） | `claude_mcp.rs:76-78,320`；`services/mcp.rs:356-360` |
| Codex | `~/.codex/config.toml` `[mcp_servers.*]`；容错读 `[mcp.servers.*]` | TOML；无 `type`，由 `command`/`url` 推断 | `mcp/codex.rs:1-16,52-61,63-70` |
| Gemini | `~/.gemini/settings.json` | JSON `mcpServers` | `mcp/gemini.rs:11-16` |
| Grok Build | `~/.grok/config.toml` `[mcp_servers]` | TOML（复用 codex 转换） | `mcp/grokbuild.rs:1-8` |
| OpenCode | `opencode.json` | JSON；`type: local/remote`、`command` 是数组、env 叫 `environment` | `mcp/opencode.rs:4-16` |
| Hermes | `~/.hermes/config.yaml` | YAML，无 `type`；`enabled/timeout/tools/sampling` 等原生字段写回时保留、导入时剥离 | `mcp/hermes.rs:5-19` |
| Kimi Code | JSON `mcpServers`，`atomic_write_private`（含凭据，0600） | JSON | `mcp/kimi.rs:1-30` |
| MiniMax Code | JSON `mcpServers` | JSON | `mcp/mcode.rs:1-22` |
| Pi | `<Pi 配置目录>/mcp.json` 顶层 `mcpServers` | JSON；**不支持 SSE**；服务器名只允许字母数字 `_`/`-`，且 `-` 与 `_` 视为同一名字 | `mcp/pi.rs:1-8` |
| Antigravity | `mcp_config.json` | JSON；**0 字节文件当成没有配置** | `mcp/agy.rs:1-24` |
| Copilot CLI | `~/.copilot/mcp-config.json` | JSON；stdio 写 `"type":"local"`；每项 `tools` 过滤默认 `["*"]`；禁用是 `settings.json` 的 `disabledMcpServers` | `mcp/copilot.rs:1-15` |
| Oh My Pi | 原生 MCP 状态 + 用户 denylist（避免项目级发现把它重新激活） | JSON | `mcp/omp.rs:1-13` |
| DeepSeek Harness | `$DSH_HOME/profiles/{web,desktop,headless,acp}/cordis.patch.yml`，条目键 `config.serverName`；`transport` 只认 `stdio`/`streamable-http`，其余**静默跳过** | **YAML patch**（保留注释/锚点；遇到 YAML tag/alias 直接报错让用户手改） | `mcp/dsh.rs:21-39`；`dsh_config.rs:1-8,29-38,48-60,184,244` |

**多路径与合并**：Claude 除了 `~/.claude.json` 还要把同一份 `mcpServers` 投影到每个官方账号目录
（`services/mcp.rs:356-360`）；DSH 要把同一组条目写进 4 个 profile，并且**按 realpath 身份去重**
（`dsh_config.rs:39-60` 注释直说 symlink/junction/8.3 短名/大小写别名会让同一文件被列两次）。
导入语义是**并集不覆盖**：已存在的服务器只把对应 app 的 bool 置 true，其他字段与应用状态不动
（`services/mcp.rs:668-677` 及各处 `import_from_*` 同一段）。并且**导入绝不反向写回 live**
（`services/mcp.rs:682-683`）。

**发现 ≠ 全量重扫**：`live_sync_apps()` 明确排除 Claude Desktop 与 OpenClaw
（`services/mcp.rs:500-505`），不假装支持。

**对比我们**：`src/env/mcp.js:28-94` 只有 9 个 agent / 11 个源（claude-code、codex、zcode、qoder、
cursor、opencode、gemini、hermes、kiro）。**缺 DSH（我们自己的宿主！）、Kimi、MiniMax Code、Pi、
Antigravity、Copilot、Oh My Pi、Grok Build、Claude Desktop**。我们的身份判定（指纹 + 内容/包名归一）
比它的"原生键名当 id"更强（`src/env/mcp.js:6-14` 自己写了这段对比），这条**保持**。

---

## §2 mcp_connectivity：怎么判"通不通"

**结论先行：它是"真握手"，不是 ping；而且没有任何结果缓存——每次点都真测一遍。**

- 超时：`CHECK_TIMEOUT = 30s`（`mcp_connectivity.rs:35`），但**排队时间不算在内**——
  先 `CHECK_PERMITS.acquire()` 再计时，注释原话 "Queueing here keeps the wait out of the
  per-server CHECK_TIMEOUT"（`:96-100`）。
- 并发：`MAX_CONCURRENT_CHECKS = 3`，且是**跨批次共享的 static Semaphore**（`:36-39`），
  不是每批各自限流；批次用 `BATCHES: HashMap<batchId, AbortHandle>` 管理，`cancel_checks` 取消
  整个批次、队列里没跑的也一起丢（`:85-120`）。结果用 `buffer_unordered(3)` 流式回吐，
  `on_result` 返回 false（页面走了）就 `break`（`:104-108`）。
- **状态三态（本轮新增的核心）**：`Connected` / `AuthRequired` / `Failed`
  （`:53-61`）。`AuthRequired` 的注释就是判据："The endpoint answered 401: reachable, but it
  wants the client's own (often OAuth) sign-in, which CC Switch neither has nor reads."
  401 要在传输层内部捕获（rmcp 会把错误包一层），所以有 `UnauthorizedAwareClient::note`
  （`:297-311`）和 `SameOriginSseClient::note`（`:366-377`）两处记 `AtomicBool`，
  最后由 `check_server` 读这个 flag 决定是不是 AuthRequired（`:122-131`）。
- stdio vs http/sse：缺省 `type` 时 `url 有 && command 无 → http，否则 stdio`（`:138-144`）；
  stdio 侧 `KillOnDrop + ProcessGroup::leader()/JobObject + CREATE_NO_WINDOW`，stderr 丢到 null，
  握手完成后 `ProbeProcess::drop` 仍要 `start_kill()` 再 `wait()`（`:174-191,252-265`）；
  http 侧 `redirect(Policy::none())`、`connect_timeout`+`timeout` 都设、`NeverRetry`（`:202-233`）。
- 握手只做 `initialize` + `notifications/initialized`，**不调用任何工具**（`:278-281`）。
- 安全：http/sse 一律不把配置的 header 转发到跨源端点（legacy SSE 的 message 端点必须同 scheme+authority，
  否则 `PermissionDenied`，"Cross-origin MCP message endpoint"，`:358-394`）。
- **失败可见性**：故意只给粗状态，`check_server` 注释："Do not return/log transport errors:
  URLs, headers and process arguments may contain credentials. The UI only needs the coarse
  status."（`:122-124`）
- 结果缓存与失效：**没有**。全文件 grep `cache|ttl|stale|expire` 零命中；结果只按批次流式回吐，
  不落库不落盘。
- 测试：`unauthorized_endpoints_report_auth_required_not_failure`（`tests.rs:195-214`，http 与 sse
  两条路径都断言 `AuthRequired` 且 mock server 没收到任何 message）、
  `http_success_without_mcp_and_timeouts_are_disconnected`（`:216-242`，200 但不是 MCP → Failed；
  100ms 超时 → Failed；`{}`/未知 type/不存在的命令 → Failed）、并发跨批次（`:286-...`）、
  进程树释放靠"端口能重新 bind"断言（`:338-342`）。

**同族但另一套取舍：供应商可达性**。`stream_check.rs:1-22` 只探 `base_url`：**收到任意 HTTP 响应
（200/4xx/5xx）即"可达"**，只有 DNS/拒连/TLS/超时算"不可达"；明确写"可达 ≠ 配置正确"，
并且"连通性检查**绝不**触碰故障转移熔断器"。这条纪律（探测不改变状态、不冒充可用性）比实现更值钱。

**对比我们**：`src/env/mcp.js` 完全不测连通性（也没有网络/进程）。见 §6：抄状态词汇与"超时不计排队"，
不抄真探测。

---

## §3 渠道 / 供应商模型

- `Provider` 字段：`id / name / settings_config: Value / website_url / category / created_at /
  sort_index / notes / meta / icon / icon_color / in_failover_queue`（`provider.rs:9-44`）。
  关键设计：**`settings_config` 存的是该 app 原生配置的形状**（不是自定义 schema），
  所以"一个渠道"= 一份能直接投影进 live 的 JSON；`meta` 明确"不写入 live 配置，仅存于
  ~/.cc-switch/config.json"（`provider.rs:30`）。
- `ProviderMeta`（`provider.rs:496-543`）：`custom_endpoints`（同一渠道多个 base_url）、
  `common_config_enabled`、`claude_desktop_mode`、`claude_desktop_model_routes`、
  `usage_script`、`endpoint_auto_select`、`is_partner` / `partner_promotion_key`、
  `cost_multiplier`、`pricing_model_source`、`limit_daily_usd` / `limit_monthly_usd`。
- **官方 / 中转 / 本地怎么区分**：一个字符串 `category`（`provider.rs:20`），前端预设用的取值是
  `official` / `cn_official` / `aggregator` / `third_party`（`src/config/claudeDesktopProviderPresets.ts:155-300`），
  后端只当下发字段、不参与逻辑（`provider.rs:904/968/1003` 全是 `Some("aggregator")` 的 preset）。
  另一条维度是**认证来源**：`AuthBindingSource::{ProviderConfig, ManagedAccount}`
  + `AuthBinding{auth_provider, account_id}`（`provider.rs:384-406`）——"官方登录卡"与"API Key 卡"
  在模型上不是两种 provider，而是同一种 + 不同 auth 绑定。
- **"支持哪些模型"分三层表达**：① `settings_config` 里 app 原生的模型字段（如 Claude 的
  `ANTHROPIC_DEFAULT_*_MODEL`）；② `claude_desktop_model_routes`（model → 展示名，`provider.rs:419-431`）
  与 `CodexChatReasoningConfig{supports_thinking,supports_effort,effort_levels}`（`provider.rs:455-479`）；
  ③ 多端点 `custom_endpoints`（`provider/endpoints.rs:12-32`，加 URL 时 trim 掉末尾 `/`，空则
  `AppError::localized("provider.endpoint.url_required","URL 不能为空",…)`）。
- **能不能"多家并存"取决于客户端**：`AppType::is_additive_mode()`（`app_config.rs:526-548`）——
  切换式（Claude/Codex/Gemini/GrokBuild：live 只有当前一家）vs 累加式（OpenCode/OpenClaw/Hermes/
  Pi/MiniMax Code/Kimi Code/DSH/Oh My Pi/Copilot：多个 provider 在原生配置里共存）。这是"渠道模型"
  里最容易被忽略、但决定一个 app 能有几条渠道的常量。
- 余额查询能力是**脚本化的**：`UsageScript{enabled,language,code,timeout,api_key,base_url,
  access_token,user_id,template_type,auto_query_interval,coding_plan_provider,access_key_id,
  secret_access_key,team_organization_id,team_project_id}`（`provider.rs:297-350`），结果模型
  `UsageData{plan_name,total,used,remaining,unit,…}` / `UsageResult{success,data,error}`
  （`provider.rs:351-381`）。——**这是产品功能，我们不抄**，但"余额是可选能力、失败要能表达成
  `error` 而不是 0"这个形状值得记住。

**对比我们**：我们的环境层**完全没有"渠道/供应商"这一维**（`src/env/` 只有 mcp / skills / memory /
cli）。对跨 Agent 档案馆来说，"这台机器上每个 Agent 配了哪些渠道、指向哪些 base_url、模型名各叫什么、
有没有 key"恰好是"资产盘点"的一等公民——这是本轮最大的**覆盖面缺口**（见 §6 P1-3）。

---

## §4 写入安全（它写、我们只读；抄"检测"，不抄"写"）

**原子写**（这条是全文最扎实的一段）：`atomic_write`（`config.rs:462-478`）→ `stage_write`
（`:513-599`）→ `commit_staged`（`:663-768`）。

- 临时文件名 `{file_name}.tmp.{pid}.{ts}.{counter}`，`create_new` 防撞，最多重试 16 次（`:542-568`）。
- 写完 `flush`，`durable` 时再 `sync_all()`；注释写明理由："崩溃恢复要靠这份临时文件前滚"（`:511-512,570-578`）。
- 权限：普通文件沿用目标现有 mode；凭据文件强制 `0600`（`atomic_write_private`，`:456-469,581-593`）。
- **软链接安全**：`resolve_symlink_target` 逐跳 `read_link`（上限 40 跳防环），替换的是**最终目标**，
  因为"rename 到软链接本身会把链接换成普通文件（Unix），Windows 的 `ReplaceFileW` 直接报 os error 1464"（`:601-660`）。
- Windows：`ReplaceFileW` + 3 次重试；WSL UNC 路径直接跳过 ReplaceFileW（`ERROR_NOT_SUPPORTED`）走 rename
  （`:671-756`）。非 Windows 就是 `fs::rename`（`:758-766`）。
- **失败时故意保留临时文件**："写入引擎的 pending 指着它，下次恢复要靠它前滚"（`:666-667`）——
  也就是说**残留的 `.tmp.<pid>.<ts>.<counter>` 文件本身就是"上次写到一半崩了"的物证**。
- 多文件一次操作：`StagedWrite` 把"一次操作涉及的所有文件都备好临时文件、记下写前意图，再逐个 commit"
  （`:480-509`）；MCP 侧用嵌套闭包把 copilot→omp→dsh→kimi→agy→pi→mcode 的写入与 DB 提交串成一条链，
  任一步失败整体不落库（`services/mcp.rs:44-127`，注释 ":73 "MCode / Pi 的文件和数据库一起提交：任一步失败都恢复原样""）。

**文件被外部改怎么发现**（我们最该抄的一节）：
- 内容哈希当 revision：`read_prompt_file` 读字节算 `revision(bytes)`（`pi_prompt_files.rs:252-276`）。
- 提交前**再读一次比对**：`ensure_revision(path, expected, label)`，不等就
  `AppError::Conflict(format!("{label} changed outside CC Switch: {}", path.display()))`
  （`:278-292`）；`AppError::Conflict` 的文档就是 "Native files changed after CC Switch last read them."
  （`error.rs:12-14`）。这是**内容级 compare-and-swap**，不是 mtime。
- 读有多大：`read_open_file_limited` 超 1 MiB 直接 `InvalidInput("{label} exceeds the 1 MiB limit: {path}")`
  （`:299-305`）；非 UTF-8 报 `InvalidInput("Pi prompt file must be UTF-8 ({path}): {error}")`
  （`:258-263`）。
- 备份：`ConfigService::create_backup` 写 `backups/backup_%Y%m%d_%H%M%S.json`，
  `MAX_BACKUPS = 10`，按 mtime 删最旧（`services/config.rs:5-60`）。
- 格式保留：`jsonc_document` 是 JSONC/JSON5 的**往返编辑**（保留注释与键序），
  "File selection, locking, snapshots and rollback belong to the caller"（`jsonc_document.rs:1-18`）。
- 路径边界（只读也能用）：备份页"前端只能传类别 id，路径一律由这里按写入方的口径算出…
  删除也只删该类别自己的目录或按文件名匹配到的文件"（`backup_storage.rs:4-5`）。
- 未安装的客户端**不创建任何文件**：`should_sync_claude_mcp()` / `should_sync_codex_mcp()` /
  `should_sync_gemini_mcp()` / `should_sync_grokbuild_mcp()` 都是"目录不存在就 return Ok(())"
  （`mcp/claude.rs:11-15`、`mcp/codex.rs:17-21`、`mcp/gemini.rs:11-16`、`mcp/grokbuild.rs:13-15`）。

**对比我们**：我们只读，所以 §4 的写机制不抄；但"内容哈希 revision + 提交前比对 + Conflict 文案 +
读上限 + UTF-8 标注"这套**检测**可以整段搬（见 §6 P1）。

---

## §5 失败与未知怎么归类

**错误类型学**（`error.rs:6-66`，thiserror）：`Config / InvalidInput / Conflict / Io{path,source} /
IoContext{context,source} / Json{path,source} / Toml{path,source} / Lock / McpValidation /
Message / HttpStatus{status,body} / Localized{key,zh,en} / Database`。文案模板：
`"IO 错误: {path}: {source}"`、`"JSON 解析错误: {path}: {source}"`、`"TOML 解析错误: {path}: {source}"`、
`"MCP 校验失败: {0}"`、`"并发冲突: {0}"`。

映射到五类：

| 情形 | 归类 | 证据 |
|---|---|---|
| 权限 / 读失败 | `Io{path, source}`（保留 `io::ErrorKind`，PermissionDenied 可判） | `error.rs:15-20,69-74`；`claude_mcp.rs:120` |
| **文件不存在** | **不是错误**：`read_mcp_json → Ok(None)`；`read_json_value` 返回 `{}`；kimi/mcode/agy 的 `read` 遇 NotFound 返回 `{"mcpServers":{}}`；agy 还把**0 字节文件**当没有配置 | `claude_mcp.rs:80-87,115-122`；`mcp/kimi.rs:13-18`；`mcp/mcode.rs:13-18`；`mcp/agy.rs:13-23` |
| 格式不认识 | `Json{path,source}` / `Toml{path,source}`，**带文件路径**；个别模块收窄成 `Config("Invalid Kimi Code MCP JSON")` | `error.rs:27-43`；`mcp/kimi.rs:19-21`；`mcp/claude.rs:55-56` |
| 字段缺失 / 类型错 | `McpValidation` + 逐条具体措辞："MCP 服务器连接定义必须为 JSON 对象"、"type 必须是 'stdio'、'http' 或 'sse'（或省略表示 stdio）"、"stdio 类型的 MCP 服务器缺少 command 字段"、"http 类型的 MCP 服务器缺少 url 字段"；`extract_server_spec` 还有"缺少 server 字段" | `mcp/validation.rs:8-51,73-88` |
| 不支持的应用 | 明确报错不静默跳过："{} 不支持由 CC Switch 管理 MCP" | `services/mcp.rs:509-528` |

**逐条容错 + 聚合上报**（比"整份失败"友好得多）：
- 导入：单条校验失败 `warn!` + `errors.push("{id}: {e}")` + `continue`，最后只有摘要告警，不中断
  （`mcp/claude.rs:64-73,116-118`）；`collect_enabled_servers` 同理跳过无效条目并 warn（`:28-36`）。
- 投影：`project_servers_to_app` 逐条跑，按**相同错误归并**成 `IndexMap<String, Vec<&str>>`，
  最后 `"部分 MCP 服务器同步到 {app} 失败: {ids}: {error}"`（`services/mcp.rs:559-603`）——
  注释写明理由："live 文件本身损坏时每一条都报同一句"，不归并会刷屏。
- 全量同步：`sync_all_enabled` 每家独立跑，失败累积成 `"部分应用 MCP 同步失败: {app}: {err}; …"`
  （`:465-490`），注释："一处损坏没有理由让其他应用的 MCP 状态陈旧"。
- 进度可见性：`McpAppSyncOutcome{app, ok, error}` 按应用回报（`:12-20,530-548`）。
- **它自己也有漏**：DSH 的未知 `transport` 直接 `continue`（`mcp/dsh.rs:38`），条目静默消失。
  所以 P0-2 那条不是"照抄"，而是要做到比它更彻底——这也是我们唯一能在这一层比它强的地方。

**环境冲突检查器的假阳性纪律**（对我们 doctor 特别有用）：`check_env_conflicts` 只按 `EnvKeyword::
Exact|Prefix` 匹配键名，且**故意不扫进程环境**——注释："it is inherited from whatever launched
CC Switch (e.g. Claude Desktop injects ANTHROPIC_BASE_URL into the terminals it spawns, so `pnpm dev`
started there always "conflicts")"（`env_checker.rs:28-34`）；测试 `inherited_process_env_is_not_
reported_on_unix`、`broad_app_keywords_match_only_at_the_start`（`:213-224`）。
注意：它把 `var_value` 一起返回了（`env_checker.rs:7-12`）——**这一点我们绝不能学**（见 §6）。

---

## §6 采纳建议

按性价比排序。只写"他们有 / 我们没有"或"他们更对"。**改之前先量**。

### P0（这轮就该做，成本低、收益确定）

**P0-1 补齐 `src/env/mcp.js` 的 MCP 源（尤其 DSH）。**
现在我们 9 个 agent / 11 个源；它 15 个客户端。差的是：**DSH、Kimi Code、MiniMax Code、Pi、
Antigravity、Copilot CLI、Oh My Pi、Grok Build、Claude Desktop**。
改动：`src/env/mcp.js:28-94` 的 `SOURCES` 追加条目（都是"顶层 `mcpServers` 的 JSON"，可共用现有
`json-mcpServers`；DSH 是 YAML patch，用现有的 `yaml-mcp_servers` 变体；Pi 的名字规范化要处理
`-`/`_` 等价；agy 要处理 0 字节文件）。
证据：`mcp/pi.rs:1-8`（名字规则、无 SSE）、`mcp/agy.rs:20-23`（0 字节=无配置）、
`mcp/copilot.rs:1-15`（`~/.copilot/mcp-config.json`）、`mcp/kimi.rs:1-30`、
`dsh_config.rs:29-38`（`profiles/*/cordis.patch.yml`、`config.serverName`）。
为什么值：DSH 是我们自己的宿主，我们的能力面却看不见它的 MCP；其余几家都是同一格式，几乎零成本。

**P0-2 把"静默丢弃"改成"计数 + 归类上报"。**
现在 `src/env/mcp.js:582`：`if (!raw || typeof raw !== 'object') continue;`——非对象条目**静默消失**，
用户看到"配了 5 个、说只有 4 个"且没有任何提示（这正是我们在 skills.js:113-116 里批评过的那类静默漏）。
改动：给 `normalize()` 前加 `validateSpec(raw)`，照 `mcp/validation.rs:8-51` 的四条判据（非对象 /
type 不认识 / stdio 缺 command / http·sse 缺 url），失败的条目进一个 `invalid[]`（含 `file/name/reason`），
`mcpSummary()` 里输出 `invalidCount` 与条目。措辞直接抄中文原文。
为什么值：一行 `continue` 换成"能看见"，是我们 doctor"失败要如实报数"的同一原则。

**P0-3 静态可疑检查（不执行任何东西）。**
它能静态验的是 `validate_command_in_path`：按 `PATH`（Windows 还要 `PATHEXT` `.COM;.EXE;.BAT;.CMD`）
逐个目录找可执行（`claude_mcp.rs:265-300`）。我们完全可以在**不 spawn** 的前提下给每条 stdio
注册标 `commandFound: true/false/unknown`；remote 的标 `urlValid`（URL 能否 parse、scheme 是否
http/https）。这比"真连通性"便宜、无攻击面，又能回答"我这条 MCP 为什么起不来"的最常见原因。

### P1（值得做，但要先量）

**P1-1 读配置加"上限 + 编码标注"。** `src/env/mcp.js:290-305` 的 `readJson/readText` 没有大小上限、
错误统一成 `null`。照 `pi_prompt_files.rs:299-305`：超 1 MiB 报"xxx exceeds the 1 MiB limit: {path}"；
非 UTF-8 报"… must be UTF-8 ({path})"；错误进 `errors[]` 时带 `path` 与 `kind`
（`not_found / permission / parse / shape / too_large`）。这是把 `mcp.js:557-573` 那个粗粒度的
`'JSON 解析失败'` 细分成 §5 那张表。

**P1-2 用内容哈希 revision 代替纯 mtime 判断"源文件变没变"。** 我们的
`registry.js` 用 `(mtime,size)`+头部哈希；MCP/技能/CLI 配置都是小文件（几十 KB），
照 `pi_prompt_files.rs:252-292` 做"读字节 → sha256 → 提交/比对"，就能把
"CC Switch 读到的是不是当前这份"变成可以回答的问题，并把 `Conflict` 语义（`error.rs:12-14`）
升级成我们 doctor 里的一个 `staleSources` 字段。
顺带一个便宜的诊断：**如果配置目录里存在 `*.tmp.<pid>.<ts>.<counter>` 残留文件，说明某个写入器上次
崩在提交前**（`config.rs:542-549,666-667`）——我们可以只读地把它报出来，提醒用户"这份配置可能半写"。

**P1-3 新增 `src/env/providers.js`：每家的渠道清单（只读）。**
这是本轮最大的覆盖面缺口。照 `provider.rs:9-44` 的字段形状，从各家 live 配置里读：
base_url、模型名（各 app 原生字段）、**是否有 key（只报键名/布尔，绝不报值）**、
以及分类 `official / cn_official / aggregator / third_party`（取值见前端预设，
但**不抄具体预设表**）。还要带上"这个 app 是切换式还是累加式"
（`app_config.rs:526-548`）——它决定"一个 app 能配几条渠道"。
为什么值：档案馆回答"聊过什么"，渠道清单回答"能连什么"；两者合一才是"这台机器的 AI 资产"。

**P1-4 环境变量冲突检查（只比键名）。** 照 `env_checker.rs:20-68` 的 `Exact|Prefix` 关键词模型，
把我们 MCP 注册里的 `envKeys` 与系统环境（Windows 注册表 `HKCU\Environment` /
`HKLM\…\Environment`）比对，报"这个键在系统里也设了值，可能覆盖/被覆盖"。
**关键偏离**：`EnvConflict` 里绝不带 `var_value`（它带了，`env_checker.rs:7-12`），只报
`{varName, sourceType, sourcePath}`——这条线不能破（`src/env/mcp.js:12-14` 已立过规矩）。
同时抄它的假阳性纪律：不扫进程环境（`env_checker.rs:28-34`）。

### 不抄（P0/P1 之外，明确不做）

- **真连通性探测**（`mcp_connectivity.rs` 的 stdio spawn / HTTP 握手）。理由见 §7。
  只抄它的**状态词汇**（Connected / AuthRequired / Failed）与"排队不计入超时""跨批共享并发额度"，
  外加 `stream_check.rs:1-22` 的"可达 ≠ 可用、探测不触碰状态"。
- **全部写入机制**：`atomic_write`/`stage_write`/`commit_staged`/`StagedWrite`/`ReplaceFileW`/
  `jsonc_document` 往返编辑/备份轮转——我们是只读。只在 P1-2 里借"revision + 残留 tmp 检测"两点。
- **供应商预设表、余额脚本、路由/代理、多客户端同步**：产品功能或写侧能力。
- **`EnvConflict.var_value`**：见 P1-4，绝不带到输出。

---

## §7 不抄的理由（它是配置写入器，我们是只读档案馆）

1. **它的一切复杂度都服务于"写进用户的 live 文件"**：原子写、临时文件前滚、ReplaceFileW、
   权限 0600、软链解析、多客户端事务链、备份轮转。我们一行都不写，抄来只是负担和风险。
2. **它的连通性检测要执行未知命令**：stdio 分支真的 `spawn` 用户配置里的 `command`（可能是
   `npx -y 任意包`），http 分支真的发请求（带用户 header/凭据）。对只读档案馆，这是纯粹的攻击面
   扩增——我们连 MCP 服务都不该启动（`src/env/mcp.js` 的定位就是"只解析配置"）。
3. **它读进程环境和 shell 配置并把值返回**（`env_checker.rs`），与我们的红线冲突：
   `src/env/mcp.js:12-14` 明确"env / headers 的值绝不出这个模块"。
4. **它的价值判断依赖"当前渠道是哪一个"**（切换式 vs 累加式、failover 队列、熔断器），
   这些概念只有"替用户改配置/转发请求"时才成立；档案馆没有"当前渠道"，只有"历史上配过什么"。
5. **它的发现是"按原生键名"**，我们已经证明按内容/包名指纹归一更对（`src/env/mcp.js:6-14`），
   这条不能退回去。

**一句话**：把 cc-switch 当一本"怎么把别人的配置文件读对、读全、读不崩，并把读不出来说清楚"的
参考书；不要把它当"怎么替用户写配置"的模板。
