# agent-archive

跨 Agent 的项目级会话档案馆。

给定一个项目路径，把所有 Agent 在这个项目里发生过的会话，按时间合并成一条线。

## 为什么只做这一件事

跨 Agent 的记忆、蒸馏、交接摘要都建立在"你首先得知道发生过什么"之上。
而各家 Agent 的会话存储格式互不兼容、路径各不相同，这件事没有标准答案，
只能逐家适配。

本工具只做三件事：**扫描 → 归一 → 时间线**。不做蒸馏，不做向量检索，
不往 Agent 里注入任何东西。它先把事实记录下来，其余都是可选视图。

四种看法，同一份数据：终端里的 `projects`/`timeline`/`cat`，
浏览器里的 `serve`，导出成 Markdown 的 `export`，
以及给其他 Agent 用的 `/api/*` 与 **MCP server**。

**定位：一个 AI 能读得懂的档案馆，而不是一个会读东西的 AI。**
事实层（扫描、归一、时间线）是确定性的、可复现的、零成本的；
总结、归纳、蒸馏交给用户自己的模型——通过 MCP，不通过我们的 API Key。

## 用法

```bash
# 本机有哪些项目（自动过滤掉家目录、桌面、临时目录）
node src/cli.js projects

# 某个项目的完整时间线
node src/cli.js timeline E:\softpi-shop

# 不分天，平铺
node src/cli.js timeline . --flat

# 这个项目在各 Agent 里的分布
node src/cli.js agents E:\softpi-shop

# 扫描统计与缓存位置
node src/cli.js stats

# 采集体检：覆盖率、缺口、正文可读性
node src/cli.js doctor

# 扫描归档里的明文凭证（只报告，掩码输出）
node src/cli.js secrets

# 配置模型（用户自己的 API Key）
node src/cli.js llm --key sk-xxx --model deepseek-chat --base-url https://api.deepseek.com

# 生成项目摘要（默认只估算成本，加 --run 才真的调模型）
node src/cli.js digest E:\softpi-shop
node src/cli.js digest E:\softpi-shop --run --out digest.md

# 审计/刷新已过期的摘要（默认只审计，加 --run 才重算）
node src/cli.js refresh
node src/cli.js refresh --run

# 建全文索引（第一次约一分钟，之后只处理变过的会话）
node src/cli.js index
node src/cli.js index --force             # 全部重建

# 全文搜索
node src/cli.js search 迁移
node src/cli.js search 缓存 --agent zcode --limit 5

# 导出 Markdown
node src/cli.js export E:\softpi-shop              # 项目时间线
node src/cli.js export E:\softpi-shop --bundle     # 该项目全部会话正文
node src/cli.js export 01a11a93 --session          # 单场会话
node src/cli.js export . --out archive.md          # 写文件而不是 stdout

# 读一场会话的正文
node src/cli.js cat --project .          # 该项目最近一场
node src/cli.js cat 1d551b54             # 按 id 前缀
node src/cli.js cat 019a30ad --tools     # 展开工具调用与输出

# 起本地网页查看器（浏览器打开 http://127.0.0.1:7788）
node src/cli.js serve
node src/cli.js serve --port 8000
```

通用选项：`--json` 输出机器可读结果，`--no-cache` 强制全量重扫。

## 搜索：为什么需要索引，以及中文怎么切

全量读一遍 863 场会话要 33 秒、55 M 字符。每次搜索实时扫不可行，
所以正文先在本地落一份 SQLite FTS5 索引（`~/.agent-archive/index/`）。

**中文分词是这里唯一有技术含量的地方。** FTS5 自带的 `unicode61`
不切中文——整段中文是一个 token，搜「缓存」永远搜不到；`trigram`
要求查询至少 3 个字符，「迁移」「缓存」这类两字词同样落空。

所以自己切：连续汉字段切成长度 2 的滑窗（`数据库迁移` →
`数据 据库 库迁 迁移`），英文和标点原样交给 unicode61。

第一次的写法是「原文 + 全量二元组」，实测索引文本膨胀 **4 倍**
（120 场就 34 M 字符），建索引慢到跑不完。改成只存 token 序列后
降到 1.95 倍，863 场 56 秒建完，索引 179 MB。

摘要不用 FTS5 的 `snippet()`：它从索引文本里取，会把二元组一起抓出来，
摘录变成「约 约束 束：」这样的碎片。改为回原始正文里定位关键词取上下文。

**只索引人说的话和工具调用摘要**，不索引完整工具输出——那些多是日志和
源码，放进去既占空间又把真正的对话信号淹没。

## 合并：一场对话可能散在多个文件里

Codex 的续接会话会为同一 session id 产出多个 rollout 文件
（`rollout-<时间>-<父uuid>.jsonl.zst` 和
`rollout-<时间>-<父uuid>_<子uuid>.jsonl`），时间上首尾相接。
`registry.js` 按 `agent|id` 合并它们：时间取包络，正文读取时按
顺序拼接。

不合并的后果很直观——合并前本机 2225 个「会话」里只有 904 个唯一 id，
同一场对话在时间线里重复出现几十次。合并后是 863 场。

另外 Codex 的**子代理会话**（`source: {subagent: {...}}`）整条跳过：
它们是父会话内部的一步，`session_id` 指向父会话，`id` 才是自己的。
用 `session_id` 当标识会让几十个子代理会话挤成同一条。

## 导出：三种粒度

| 命令 | 内容 | 用途 |
|---|---|---|
| `export <项目>` | 会话清单 + 按天时间线 | 看这个项目经历了什么 |
| `export <id> --session` | 单场对话完整正文 | 贴进 issue、给别的模型读 |
| `export <项目> --bundle` | 该项目所有会话正文合成一份 | 完整交接材料 |

三种都默认把正文包成 `>` 引用块——这样原文里偶然出现的 `# 结论`
不会把导出文档的大纲撕开。工具调用压成一行摘要，加 `--tools`
展开入参与输出。

网页上对应三个按钮，走同一个 `/export` 接口，所以**浏览器里看到的
和导出的永远是同一份内容**（两者都调用 `src/export.js`）。

### 噪声剥离是导出质量的前提

导出时发现 Codex 会话有 78% 的正文是注入内容：`<app-context>`（桌面端
能力说明）、`<recommended_plugins>`（插件清单）之类。它们以
**`role: "developer"`** 的消息出现——这个角色名容易被忽略，因为直觉上
只想着 user/assistant。

修法是：`developer` 消息整条归为系统内容，并且和 user 消息一样过
`stripBlocks`；剥空了就丢弃。同一场会话导出从 118 KB 降到 19.5 KB。

`stripBlocks` 也从"逐个列标签名"改成按形状剥（成对标签、自闭合标签、
无闭合时剥到末尾）。实测 904 场里有 273 场标题是这类标签，
硬编码名单永远追不上 Codex 加功能的速度。

## 接给别的 Agent：MCP server

这是这个产品真正的用法——**不用自己接模型**。档案馆包成一个 MCP
server，用户已经在用的 Agent（Claude Code、Codex、ZCode、Cursor、
OpenCode、Kiro……）自己就能来读。

```bash
node src/cli.js mcp          # 打印可粘贴的配置
node src/cli.js mcp --json   # 只要配置 JSON
```

粘进对应 Agent 的 MCP 配置即可（各家的位置不同，命令会列出来）。

**零依赖实现。** MCP 的 stdio 传输就是「stdin/stdout 上一行一条
JSON-RPC」，手写足够，不需要引入任何 npm 包。

### 八个工具

| 工具 | 作用 |
|---|---|
| `list_projects` | 有哪些项目、多少会话、哪些 Agent |
| `project_timeline` | 某项目的会话清单（只有元数据） |
| `search_sessions` | 全文搜索，返回命中处摘录 |
| `read_digest` | 读**已生成**的项目摘要；没有就提示怎么生成，不现编 |
| `read_session_summary` | 读某场会话已有的摘要，用来判断值不值得深挖 |
| `read_session` | 读正文，**分段**，默认 8000 字 |
| `session_stats` | 采集质量、索引规模、已有摘要数量 |
| `export_timeline` | 导出 Markdown |

`read_digest` 和 `read_session_summary` 是视图层的入口。它们**只读已有的
摘要，不会替你调模型**——生成要花钱，必须由用户在终端显式执行。
推荐给 Agent 的调用顺序也写在 `initialize` 的 instructions 里：

```
list_projects → read_digest（有现成交接材料吗）→
  没有就 search_sessions / project_timeline 定位 → read_session 读正文
```

翻 984 场会话的成本，因此可以降一个数量级。

### 为什么要默认截断

一场会话常有十几万字（约 5 万 token）。如果 `read_session` 直接返回
全文，Agent 手滑点一次就能烧掉大量上下文额度，而且它往往只需要其中
一段。

所以每个返回正文的工具都有 `maxChars` 上限（默认 8000，硬上限 40000），
超出时明确报告 `totalChars` / `hasMore` / `nextOffset`，让调用方自己
决定要不要继续读。列表类工具只给元数据，从不夹带正文。

所有工具都标记 `readOnlyHint: true`——它们不会修改任何 Agent 的原始数据。

## 凭证扫描：`secrets`

```bash
node src/cli.js secrets              # 扫全部归档
node src/cli.js secrets high         # 只看高危以上
node src/cli.js secrets --agent zcode
```

会话归档里常有真实凭证——AK 粘进对话、工具输出回显、部署脚本硬编码。
这些埋在几万条消息里，人自己看不见，但档案馆有全文，扫一遍就能找出来。

内置特征：阿里云 `LTAI*`、AWS `AKIA*`、GitHub `gh[pousr]_*` /
`github_pat_*`、`sk-*`（OpenAI 兼容）、`sk-ant-*`、私钥文件头、
`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 赋值、通用的 `api_key=` / `secret=`。

**输出一律掩码，而且掩码比命中更激进**：命中只认已知前缀，
掩码会把上下文里任何 24 位以上的连续字母数字都打掉——
否则这个工具自己就成了泄漏渠道（第一版就踩过这个坑）。

**它只报告，不处置。** 真正的修法是去对应平台停用/轮换凭证；
删聊天记录没用，备份和索引里还在。

## 视图层：摘要由模型做，事实不由模型做

这是整个产品的分界线：

```
     事实层（确定性）              视图层（模型生成）
  扫描 → 归一 → 时间线  ──────→  摘要 / 交接 / 洞察
  可复现、可审计、零成本          可重算、有版本、有成本
```

**模型只在「这些事实意味着什么」上工作，绝不参与「发生了什么」。**
原因很实际：如果摘要烘进事实层，换模型就没法重算，档案馆会被锁死在
生成它的那一代模型上。原始正文存着，随时能用任何模型重新分析。

### 配置

```bash
node src/cli.js llm --key sk-xxx --model deepseek-chat \
  --base-url https://api.deepseek.com
node src/cli.js llm          # 看当前配置（密钥掩码）
```

密钥写在 `~/.agent-archive/llm.json`（权限 600），**不进项目目录**——
这个目录会进 git，密钥一旦进了历史就洗不掉。

两种请求形状覆盖绝大多数场景：`openai`（`/v1/chat/completions`，
DeepSeek / Kimi / Qwen / GLM / Ollama / LM Studio / 各种中转站都是这个）
和 `anthropic`（`/v1/messages`）。

环境变量优先于配置文件，方便临时切换：`AGENT_ARCHIVE_LLM_API_KEY` /
`_MODEL` / `_BASE_URL` / `_PROVIDER`。

### 生成摘要

```bash
node src/cli.js digest E:\softpi-shop              # 只估算，不花钱
node src/cli.js digest E:\softpi-shop --run        # 真的跑
node src/cli.js digest E:\softpi-shop --limit 20 --run --out digest.md
```

**默认只估算。** 模型调用要花钱，用户得先看到量级再决定：

```
预计成本
  会话        5 场（项目共 732 场）
  已缓存      0 场（这部分不花钱）
  输入        约 98.5k token
```

### 四元组缓存

每份衍生数据的键是：

```
(kind, subject, source_hash, prompt_version, model)
```

改任何一个都是未命中：会话又聊了几轮（hash 变）、提示词改好了
（version 变）、换了个模型（model 变）。**这是视图层能被安全重算的
全部前提**——没有它，三个月后你无法回答"哪些摘要是旧的""换模型后
该重算哪些"。

旧结果不会被删，所以能拿新旧模型做对比。

### 分层

一场会话十几万字、一个项目几百场会话，一次性塞进模型既超上下文
也烧钱。所以逐层收敛：

```
会话正文 ─┬─ 超长就切块 → 每块摘要 → 合并
          └─ 不超长就直接摘要
                 ↓  会话摘要（缓存）
                 ↓  项目摘要（缓存）
```

### 关于云端

不做。理由不是隐私，而是**它加不了核心能力**：知道每家 Agent 把会话
藏在哪里、怎么解开，100% 是本地的事，云端帮不上。云端能加的是多机
同步和团队共享，那是另一个客户群。

真要做的话顺序是：先同步**衍生摘要**，不同步原始会话——原始对话里有
API key、客户信息、内部 URL，上传即不可撤销。（这不是假设：
`secrets` 命令在本机 960 场会话里扫出了 14 条真实凭证。）

### 增量刷新：`refresh`

```bash
node src/cli.js refresh            # 审计：哪些过期了、为什么、要花多少
node src/cli.js refresh --run      # 真的重算
node src/cli.js refresh --project E:\softpi-shop
```

四元组缓存本来就让"变了才重算"成立——换模型、改提示词、会话追加内容，
键自然 miss。所以 `refresh` **不负责重算逻辑**，它解决的是另一个问题：
**花钱之前看得见哪些过期了**。

之前只能对整个项目盲跑 `digest --run`，跑完才知道花了多少。项目一多就
变成"不知道要不要跑、跑了也不知道值不值"。

过期原因分五类，处置方式完全不同：

| 原因 | 含义 | 该不该重算 |
|---|---|---|
| `current` | 四元组全对得上 | 不用 |
| `source-changed` | 会话有新内容 | 应该 |
| `model-changed` | 换了模型 | 想用新模型口径才重算 |
| `prompt-changed` | 提示词改过 | 确认改进过才重算 |
| `dependency-stale` | 本项目里有会话摘要过期 | 跟着重算 |
| `orphan` | 源会话已不在 | 可以清掉 |

一个刻意的边界：**只刷新已经存在的摘要，不给没有摘要的项目新建**。
否则一条 `refresh` 命令可能悄悄花掉一大笔，而用户以为只是"更新一下"。

审计本身一次模型都不调用——它只读本地缓存、重算哈希、比对四元组。

### 网页上的新鲜度提示

项目页和会话页的摘要标题旁会出现「可能已过期」的徽标，命中三种情况之一时：

1. 生成它的模型不是当前配置的模型
2. 提示词版本变过
3. 生成之后这个项目新增了会话

**但网页只做不花钱的检查。** 有一项它查不了：**会话内容变了但数量没变**
（同一场又聊了几轮）。这一项要重读正文才能判断，全量 33 秒，不能放在
每次请求里。

所以提示里会明说「这一项查不了，需要准确结果请运行 `refresh`」。宁可承认
能力边界，也不给一个看起来确定、实际会漏的结论——那比没有提示更糟。

## 本地网页查看器

`serve` 起一个**只读**的本地服务，同一个进程同时提供页面和 JSON：

| 地址 | 内容 |
|---|---|
| `/` | 所有项目 |
| `/p?path=<项目路径>` | 某项目的时间线（默认最近 300 场，`&all=1` 全量） |
| `/s?agent=<名>&id=<id>` | 某场会话的正文 |
| `/search?q=` | 全文搜索，关键词高亮 |
| `/api/projects` | 项目清单 |
| `/api/timeline?path=` | 时间线 |
| `/api/agents?path=` | 各 Agent 分布 |
| `/api/search?q=&agent=&project=&limit=` | 搜索结果 |
| `/api/digest?path=` | 项目摘要（如果有） |
| `/api/session?agent=&id=&message=` | 会话正文，`message` 取单条 |

项目页顶部会展示已生成的摘要（折叠块），会话页顶部展示会话摘要。
摘要是**视图层**，和下面的时间线（事实层）在视觉上分开摆——
点开摘要旁边永远有一句「模型生成的视图，核对细节请点开下面的会话」。

摘要用极简的 Markdown 渲染（标题/列表/加粗/行内代码，约 40 行），
先整体转义再套标签，所以摘要里即使混进 HTML 也不会执行。
为了这点需求引入一个 markdown 解析器不值得。

三个硬约束：

- **只监听 127.0.0.1**，并校验 Host 头——否则恶意网页可以用 DNS
  rebinding 把域名指过来，跨域读走本机会话存档。
- **只处理 GET/HEAD**，没有写操作。
- **会话正文一律 HTML 转义**。这些内容是别的 Agent 写的，不能当可信 HTML。

页面里的折叠块（工具调用、推理）**默认只传摘要**，展开时才去
`/api/session?...&message=N` 取那一条。一场会话的推理加工具输出常有
几十万字，全量内联会把页面撑到几百 KB；按需加载后同一页面只有 118 KB。

前端不引任何外部脚本或样式，全靠一个内联 script 和几十行 CSS，
深色模式跟随系统设置。

## cat：怎么把一场对话读得下去

一场两小时的对话可能有几千行工具输出。全部倒出来，人是不会读的。所以：

| 内容 | 默认 | 展开 |
|---|---|---|
| 用户与助手说的话 | 显示 | — |
| 工具调用 | 压成一行摘要 | `--tools` 展开入参与输出 |
| 推理摘要 | 隐藏 | `--reasoning` |
| 注入内容（环境、指令、提醒） | 折成一行计数 | `--system` |

工具调用摘要认得各家入参形状：Claude Code 的 `{command, description}`、
Codex 的 `{command:["powershell.exe","-NoProfile",...]}`、ZCode 的
`{command, description}`。取的是真正有信息量的那一段，不是整个 JSON。

`--json` 给其他 Agent 或脚本消费，结构是 `{session, messages}`，
消息里是 `{role, parts, ts, meta}`，`parts` 保持原顺序——
说了什么和干了什么是交织的，打乱会读错。

## 当前支持

| Agent | 存储位置 | 备注 |
|---|---|---|
| Claude Code | `~/.claude/projects/<项目>/<uuid>.jsonl` | 斜杠命令需过滤 |
| Codex | `~/.codex/sessions/`、`~/.codex/archived_sessions/` | zstd；续接会话需合并 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | `semantics.origin` 区分注入 |
| OpenCode | `~/.local/share/opencode/opencode.db` | 与 ZCode 同源结构 |
| Qoder | `~/.qoder/cache/projects/<项目>-<hash>/conversation-history/` | **无时间戳、无 cwd** |
| Hermes | `~/.hermes/sessions/*.jsonl` | **无 cwd**，归不到项目 |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` | VSCode 键值库 |
| Antigravity | `~/.gemini/antigravity/conversation_summaries.db` | 部分会话是加密 .pb |
| Kiro | `%APPDATA%/Kiro/.../kiro.kiroagent/` | 正文在执行包里 |
| Copilot Chat | `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/` | 大量空会话 |

**格式差异就是适配成本。** 每家的坑都不一样，都在各自扫描器里写明了：

- **OpenCode** 与 ZCode 同源（session/message/part 三表），但没有
  `semantics.origin`，只能靠 part 类型过滤。108 场里 57 场是子代理、
  3 场归档，真实顶层会话 48 场。
- **Cursor** 消息顺序不在 KV 表里，在
  `composerData.fullConversationHeadersOnly`——按 key 排序会得到乱序对话。
  项目路径要从 `workspaceProjectDir`（`c:\...\.cursor\projects\e-softpi-shop`）
  反解成 `e:/softpi-shop`。
- **Antigravity** 有三套并存的数据。索引库（FTS5）覆盖 21 场，但只有
  3 场有明文 `transcript_full.jsonl`，另 18 场是 `.pb`（熵 8.0，
  gzip/deflate/brotli 全解不开）。**元数据能搜到，正文读不到**——
  doctor 会如实报 1/3 而不是假装能读。
- **Kiro** 的会话文件里 assistant 正文全是占位符 `"On it."`，真回复在
  执行包里（`actions[].output.message`），靠 `executionId` 关联。
- **Copilot** 的 16 个会话文件里 14 个 `requests` 是空数组，文件存在
  不代表有对话。
- **Qoder** 无时间戳（用文件 mtime 近似）、无 cwd（从目录名反推项目名）。
- **Hermes** 是接飞书渠道的助手，根本不绑定工作目录。

`sameProject()` 会把"只记项目名"和"记完整路径"的条目并成同一个项目，
否则 `softpi-shop` 和 `e:/softpi-shop` 会在列表里并排两行。

## 采集体检：`doctor`

`stats` 报的是产量（扫了多少文件、识别出多少会话），`doctor` 报的是**质量**：

```
node src/cli.js doctor
```

它检查三件事，任何一项坏掉都会让下游静默失真：

| 支柱 | 坏了会怎样 |
|---|---|
| 时间 | 时间线排序错乱，用户看不出问题但结论会错 |
| 项目 | 会话进不了任何项目，等于对用户隐身 |
| 标题 | 列表看起来全是垃圾 |

外加：正文抽样可读性、重复 id、以及**本机有哪些 Agent 目录存在但还没接入**。

指标设计上刻意区分了「没有」和「丢了」：

- **无项目**：该 Agent 压根不记录工作目录（Hermes），不算缺陷
- **临时路径**：路径存在但属于 Agent 的临时落脚点
  （`.zcode/workspace/<uuid>`、`Documents/Codex/<日期>`），被 `isProjectPath`
  主动过滤，是设计如此
- **占位标题**：桌面端自动触发的会话没有真人输入，标题退化为来源名
  `(Codex Desktop)`，这是合理降级

所以"待办"里只列真的该修的东西，不会长期挂着已经查清的正常项。

## 跨平台

各 Agent 的存储位置在不同系统上遵循不同约定，`src/platform.js` 统一处理：

| 类型 | Windows | macOS | Linux |
|---|---|---|---|
| VS Code 系应用数据 | `%APPDATA%\<App>` | `~/Library/Application Support/<App>` | `~/.config/<App>` |
| XDG 数据目录 | `%LOCALAPPDATA%\<app>` | 多为 Application Support | `~/.local/share/<app>` |
| 家目录点目录 | `~/.claude` 等，三平台一致 | 同左 | 同左 |

受影响的是 **Cursor / Kiro / Copilot Chat / OpenCode** 四家；
Claude Code、Codex、ZCode、Qoder、Hermes、Antigravity 都用家目录点目录，
本来就跨平台。

实现上**不用 `process.platform` 硬分支选路径**，而是给出候选列表、
按顺序挑第一个真实存在的。这样换机、跨平台拷贝备份、或者某个应用
在某平台上没按约定写盘时，都能命中而不是静默失败。

`isProjectPath` 的临时目录名单同时涵盖 Windows（Desktop/Documents/
AppData）和 macOS（Library/Applications/Movies…）的系统目录；
`assertUnder` 的大小写比较跟随文件系统——Windows/macOS 忽略大小写，
Linux 严格区分（在 Linux 上忽略大小写是个真实的绕过口子）。

> **验证状态**：Windows 上 10 家 Agent 全部实测通过。macOS 与 Linux 的
> 路径约定已实现，但**没有在真机上跑过**——只有 `check-platform.mjs`
> 用模拟平台值验证了"给定平台，选出的路径形状是对的"。真机首次运行时
> 请先跑 `node src/cli.js doctor` 看存储位置那一节。

## 为何只有 10 家

本机装了 13 个 Agent，其中三个**确认读不了**，`doctor` 会把它们单独列成
「已调研、确认读不了」而不是待办：

| Agent | 结论 | 证据 |
|---|---|---|
| Trae | 会话库加密 | `ModularData/ai-chat/database.db` 熵 7.999 bits/byte，无 `SQLite format 3` 头，是 SQLCipher 或类似加密 |
| Windsurf | 会话文件加密 | `.codeium/windsurf/cascade/*.pb` 熵 7.998，无 protobuf 可读结构，`database/` 为空 |
| Cline | 本机无数据 | 所有库 0 行，`-wal` 的几十 KB 全是建表 schema 页，扩展本身也没装 |

**不去破解加密。** 那既不可靠，也会产出错误内容。`doctor` 把「还没做」
和「做不了」分开报，待办里只留前者——否则清单永远挂着几个不可能完成项。

Antigravity 是中间态：21 场里 3 场有明文 `transcript_full.jsonl`，
另 18 场是加密 `.pb`。所以它的元数据能搜、正文只能读 3 场，
`readMessages` 会直接抛错说明原因，`doctor` 的正文抽样如实报 1/3。

## 设计要点

**统一模型**（`src/model.js`）：所有 scanner 产出
`{agent, id, project, title, start, end, source, resume}`。
下游只认这个形状，不关心来源格式。

**项目路径归一化**：Windows 上同一个项目会出现 `e:\softpi-shop`、
`E:\softpi-shop`、`E:/softpi-shop` 三种写法，来自不同 Agent。
比较用小写规范键，展示保留原样。

**路径解释在查询层**：CLI 只把用户敲的文本原样传下去，
`src/query.js` 的 `absProject()` 负责归一成绝对路径。
项目身份属于查询层，不属于展示层。

**缓存**（`src/registry.js`）：以文件路径为键，`(mtime, size)` 都没变就复用
上次的解析结果。这与 CC Switch 的 `FileParseCache` 是同一策略——绝大多数
会话在两次扫描之间没有变化，而重新解析一个 1.8 MB 的 JSONL 要几十毫秒。
实测 2042 个文件第二次扫描命中 2041 个。

**噪音过滤**：各 Agent 会把斜杠命令、环境上下文、AGENTS.md 指令块、
IDE 状态当成用户消息写进会话。这些会污染标题，必须在抽取"第一条真实
用户输入"时剥掉。没有用户输入的会话（自动化、子代理触发）退到助手
第一句话，再退到触发来源。

**只读**：所有 scanner 只读，绝不修改 Agent 的原始会话文件。ZCode 的
SQLite 以 readOnly 打开，用完立即关闭句柄（Windows 上不关会锁文件）。

**越界校验**：正文读取的路径来自缓存里记的 `source` 字段。如果只信它，
一份被改过的缓存就能让本工具读任意文件。所以每次读之前都要求路径落在
该 Agent 自己的根目录之下（`messages.assertUnder`），与 CC Switch 的
`resolve_under_roots` 同一个思路。

## 新增一个 Agent

写一个 `src/scanners/<name>.js`，导出：

```js
export const name = 'xxx';
export function discover() { /* 返回文件路径数组 */ }
export function parse(file) { /* 一个文件一个会话 */ }
// 或者
export function parseAll(file) { /* 一个文件多个会话，返回数组 */ }
// 想看正文再加一个（cat 用）
export function readMessages(session) { /* 返回统一消息数组 */ }
```

然后在 `src/registry.js` 的 `scanners` 数组里加一行。

这不是设计上的偷懒，而是这类工具的唯一组织方式：没有 Agent 提供
"读取我的会话"的标准接口，只能一家一个适配器，把它集中成注册表
才可维护。

## 下一步（还没做）

- 真机验证 macOS / Linux 的路径解析（见「跨平台」一节的说明）
- 批量刷新多项目：现在 `refresh` 一次处理全部，但缺一个"只刷最近活跃项目"的过滤

只有等这个档案馆在你手上真正用起来之后，才值得往上加蒸馏和交接摘要。
