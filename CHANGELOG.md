# 更新日志

这个文件记的是**用户能感知的变化**，不是提交日志。格式固定三类：
「新功能 / 改进 / 修复」，另加一节「已知限制」。每条一句话，说清对谁有什么用。

版本号遵循语义化版本；还没发布到 npm registry，从 Git 装：

```bash
npm install -g github:AmonCon/agent-archive
```

## [0.2.0] - 2026-11-16

一句话：**搜索会告诉你它覆盖了多少，用量层补上了 WorkBuddy，环境层多了斜杠命令。**

### 新功能

- **`agent-archive connect`**：按你装了哪几家 Agent，打印可直接粘贴的 MCP 配置
  （Claude Code / Cursor 的 JSON、Codex / Grok Build 的 TOML），带配置文件绝对路径。
  **只打印，不写任何配置**。
- **`agent-archive demo`**：用一份合成样例跑一遍，不碰你的真实会话。没有数据也能
  先看到时间线、换手和交接单长什么样。
- **斜杠命令盘点**：`env commands` / `/env?tab=commands` / MCP `inventory type=commands`。
  读 Claude Code、OpenCode、Pi、Gemini CLI、Qwen Code、Factory Droid 六家的
  `/命令` 定义；同名同内容跨 Agent 合并，同名不同内容标冲突。**正文不返回**，只给长度与哈希。
- **WorkBuddy 用量**：`usage` 新增第七个源，读每次请求的 `providerData.rawUsage`。
  本机实测多出 1288 条请求。
- **`read_session` 支持 `find`**：搜索结果拿到片段后，可以直接从命中处往前 3 条打开，
  不用自己从头翻。

### 改进

- **搜索结果如实报出覆盖**：每条结果带 `index: {docs, total, failed, builtAt}`。
  「这场会话没进索引」和「这场会话没说过」不再长得一样。
- **环境层存在性清单从 12 家对齐到 21 家**：能力面不再漏掉 WorkBuddy / Pi / Kimi /
  OpenClaw 这些会话层早就支持的家。
- **技能根从 10 个扩到 14 个**：本机安装处 386 → 482、独立技能 298 → 363。
  多出来的全是真实存在、之前只是没去读的目录。`.gemini/config/skills` 的归属
  从 gemini 改成 antigravity。
- **Web 首访空状态**：没有识别到项目时给出三个入口（看 demo / 跑体检 / 看能力面），
  不再只有一句「运行 projects」。
- **`serve --open`**：启动后自动打开浏览器。
- **README 重排**：三步上手 + 真截图 + 配方前置 + 「它不是什么」。

### 修复

- **Claude 分叉/复制会话的 token 被重复计**：`--fork-session` / `/branch` 会整段
  复制历史，原来按文件去重，同一 `message.id` 在原件和副本里各算一次。
  本机实测 149 条 usage 行里 105 条是重复的——这一家的用量此前高估了两倍多。
- **发现/stat 失败不再被当成删除**：`discover()` 抛错时保留该家上一轮缓存，
  `stat` 报 EACCES/EBUSY 时保留该场会话并计入 `keptStale`。只有 ENOENT 才算删除。
  以前这两种情况会让某一家会话"静默全没了"。
- **记忆/技能层的读不到有身份了**：文件存在但读不到 = `unreadable`，
  frontmatter 坏了 = `unparsable`，都不再静默变成「0 条」。目录不存在仍是正常的 `missing`。
- **MCP 停用判断补上 `disabled: true`**：WorkBuddy 等客户端用这个键，以前会被报成可用。
- **本地渠道判定改成 host 全等**：`localhost.example.com` 不会再被当成本机网关。
- **裸 Windows 路径不再被当成 `<agent>:<dir>`**：`C:\dir` 以前会被拆成 agent `C`。

### 已知限制

- 仍需要 **Node 22.16+**（读 `.zst` 会话、`node:sqlite`、FTS5 都依赖它）。
- 还没有发布到 npm registry，只能从 Git 装。
- Antigravity 的 18/21 场会话是加密 `.pb`，正文读不到；元数据仍可搜。
- Trae / Windsurf 的会话库加密，明确不破解，`doctor` 会如实报「确认读不了」。

## [0.1.0] - 2026-10-21

第一个可用版本：21 家 Agent 的会话扫描、统一模型、项目时间线、跨 Agent 接力、
交接单、全文搜索、本地网页查看器、MCP server、用量与调用层、环境层、凭证扫描。
