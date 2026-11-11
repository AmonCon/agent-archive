# 配方（Recipes）

「配方」不是插件，也不是自动化脚本。它是一组**可以直接粘给你正在用的 Agent 的提示词**，
加上推荐的 MCP 工具调用顺序。

agent-archive 只负责提供事实（会话、文件、任务、时间线）；
总结、归纳、写报告，由**你自己的模型**完成——不经过我们的 API Key，也不额外花钱。

## 先接上 MCP

在终端运行：

```bash
node src/cli.js mcp
```

把它打印出来的配置粘进你正在用的 Agent（Claude Code / Codex / Cursor / Qwen
等各家的位置不同，命令会列出来）。接好后，Agent 就能调用 `project_brief`、
`project_timeline`、`search_sessions`、`read_session` 这些工具。

## 三条配方

| 配方 | 什么时候用 | 主要工具 |
|---|---|---|
| [接手前速读](./handoff-quickread.md) | 刚接手一个别人做过的项目，先搞清楚上一段做到哪 | `project_brief` → `search_sessions` → `read_session` |
| [项目周报](./weekly-report.md) | 每周回顾：这个项目这一周发生了什么 | `project_timeline` → `read_session_summary` → `read_session` |
| [主题洞察](./topic-insight.md) | 想回顾某个主题在多次对话里是怎么演变的 | `search_sessions` → `read_session` → `project_timeline` |

## 三条通用规矩

1. **先元数据，后正文。** 先 `project_brief` / `project_timeline` / `search_sessions`
   拿清单，再对少数值得读的会话调 `read_session`。不要一上来把整场会话塞进上下文。
2. **每句话要有出处。** 让 Agent 在结论后面标会话 id 或文件名。没有记录依据的，
   写「记录里没有」，不要补。
3. **事实和推断分开。** 交接单、时间线、搜索摘录是事实；「下一步应该做什么」是推断，
   让 Agent 明确标成建议。

## 说明

- 配方里的 `{{项目路径}}`、`{{关键词}}`、`{{时间范围}}` 是占位符，用之前替换掉。
- 这些提示词是模板，不是圣旨：可以按你的项目改输出格式。
- 配方不会修改任何会话，也不会往 Agent 里写东西。
