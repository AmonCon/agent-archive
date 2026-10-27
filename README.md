# agent-archive

跨 Agent 的项目级会话档案馆。

给定一个项目路径，把所有 Agent 在这个项目里发生过的会话，按时间合并成一条线。

> 许可证：MIT（见 [LICENSE](./LICENSE)）。
> `research/reference-src/` 下是第三方项目的源码副本（MIT），
> 版权与许可声明见 [NOTICE.md](./NOTICE.md)。

## 为什么只做这一件事

跨 Agent 的记忆、蒸馏、交接摘要都建立在"你首先得知道发生过什么"之上。
而各家 Agent 的会话存储格式互不兼容、路径各不相同，这件事没有标准答案，
只能逐家适配。

本工具只做三件事：**扫描 → 归一 → 时间线**。不做蒸馏，不做向量检索，
不往 Agent 里注入任何东西。它先把事实记录下来，其余都是可选视图。

在此之上还有一层**环境层**（`env`）：识别本机每个 Agent 配了哪些 MCP 服务、
装了哪些技能、有哪些记忆。会话层回答"聊过什么"，环境层回答"会什么"——
两层都只提供事实与出处，不替任何 Agent 做决定。

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
node src/cli.js timeline E:\my-app

# 跨 Agent 接力：谁在什么时候接手、中间隔了多久
node src/cli.js handoff E:\my-app
node src/cli.js handoff E:\my-app --min-gap 1440   # 只看隔了一天以上的换手

# 不分天，平铺
node src/cli.js timeline . --flat

# 这个项目在各 Agent 里的分布
node src/cli.js agents E:\my-app

# 扫描统计与缓存位置
node src/cli.js stats

# 采集体检：覆盖率、缺口、正文可读性
node src/cli.js doctor

# 模型调用成本（按 Agent / 模型 / 会话）
node src/cli.js calls
node src/cli.js calls --by session

# 扫描归档里的明文凭证（只报告，掩码输出）
node src/cli.js secrets

# 配置模型（用户自己的 API Key）
node src/cli.js llm --key sk-xxx --model deepseek-chat --base-url https://api.deepseek.com

# 生成项目摘要（默认只估算成本，加 --run 才真的调模型）
node src/cli.js digest E:\my-app
node src/cli.js digest E:\my-app --run --out digest.md

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
node src/cli.js export E:\my-app              # 项目时间线
node src/cli.js export E:\my-app --bundle     # 该项目全部会话正文
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

另外 Codex 的**子代理会话**（`source: {subagent: {...}}`）以前整条跳过。
现在照常采集，标记成 `kind: 'subagent'` 并记下父会话——理由见下面「子代理会话」一节。

## 子代理会话：为什么不丢掉

这是本版最大的一次数据修正。

早期所有扫描器都把子代理会话整条丢掉，理由是"它们 `session_id` 指向父会话，
按它归并会让几十个子代理挤成一条，时间线重复出现几十次"。这个理由只对了一半：
**该修的是标识，不是把它们扔了。**

主会话只记"我让子代理去查一下 X"，子代理会话里才是"具体查了什么、看到了什么"。
扔掉等于档案馆只存了一半事实。本机实测：

| Agent | 主会话 | 子代理会话 |
|---|---|---|
| Codex | 675 | **1322** |
| ZCode | 198 | 98 |
| OpenCode | 48 | 57 |
| Hermes | 165 | 46 |
| DSH | 20 | 20 |
| 合计 | 1452 | **1543** |

也就是说，按这场对话被执行的步骤算，档案馆以前漏掉的比存下来的还多。

### 模型层加了两个字段

`makeSession()` 新增 `kind`（`main` / `subagent`）和 `parent`（父会话 id）。
缺省是 `main`，这样老缓存不会把历史数据误判成子代理。

下游的默认行为跟着改：**时间线、项目列表、项目会话数只算主会话**，
子代理会话单列一个数字。这样列表不会因为多存了 1543 条而翻倍，
但数据一条没丢——`read_session` 能按 id 直接读，搜索也能命中。

### 父会话要沿链上溯，不能只看一层

Codex 支持**多级委派**：子代理还能再派子代理。本机 1543 场子代理里有 181 场的
直接父会话本身也是子代理。只判断"父是不是 main"，这 181 场会被误报成孤儿，
而且挂不到任何时间线节点下（父节点根本不显示）。

所以 `indexChildren()` 沿 `parent` 链上溯到最近的 main 祖先，并保留 `depth`
说明层级；`doctor` 的归属判定也用同一套逻辑。上溯带 64 跳上限防环。

### Codex 取父 id 有三代写法

| 写法 | 父 id 在哪 | 本机占比 |
|---|---|---|
| 旧版 | `session_id` 指向父，`id` 指向自己 | 少量 |
| 新版 | `parent_thread_id`（`source.subagent.thread_spawn` 里又写一遍） | 绝大多数 |
| guardian | **根本没有** | 27 场 |

第三种是 `source.subagent.other = "guardian"` 这类内部看护线程，rollout 里
压根没写父 id。这是数据源限制，不是解析错误——`doctor` 把它单列成「无父id」
如实报数，**不用推测去填一个看起来合理的父 id**。

当前归属率：

```
1543 场 · 归属 1513 · 孤儿 3 · 无父id 27 · 归属率 99.8%
  ! codex          1322 场  无父id 27
  ✓ zcode            98 场
  ✓ opencode         57 场
  ! hermes           46 场  孤儿 3
  ✓ dsh              20 场
```

孤儿是"有父 id 但链断了"（父会话被删或跨项目），与"没取到父 id"分开报——
两者处置完全不同：前者可能是正常的历史清理，后者说明某家的字段取错了。

### 搜索里也要标出来

索引表加了 `kind` 列（老库打开时自动 `alter table` 补上，幂等）。
搜索结果默认**包含**子代理会话——它们记着主会话没记的细节，排除会让结果变浅；
但每条都带 `[子代理]` 标记，用户读到一段细节时得知道那是子代理查到的，
不是主对话说过的。只想要主会话时传 `includeSubagents: false`。

## 跨 Agent 接力：`handoff`

时间线按会话列，一个项目几百场就没人看得完。`handoff` 换一个角度：
**这个项目被哪些 Agent 轮流接手过，每次换手之间隔了多久。**

把连续同一 Agent 的会话压成一段"run"，本机 my-app 的 891 场会话
变成 223 段——人只需要看换手点。

```
node src/cli.js handoff E:\my-app
```

```
E:/my-studio
38 场会话压成 12 段 · 4 家 Agent · 2026-05-26 15:57 → 2026-10-23 20:54

换手概况
  7 次接续 · 4 次并行 · 2 次长期中断
  接续间隔中位数 1.3d
  最常走的接力线：qoder→codex(3)  codex→qoder(2)  ...

qoder       → codex        重叠5.9d 并行
    离开: 这个项目是生图的吗
    接手: [@gmail](plugin://...) Summarize inbox, draft replies...
codex       → qoder          +14min 接续
    离开: 你先了解一下我们这个项目
    接手: 我还有一个想法，我希望你能帮我做一个...
```

### 为什么这件事只能在这里做

用户真实的用法是换工具：这个项目先用 Codex，界面问题换 Antigravity，后端又回
Codex。每换一次，新 Agent 都不知道前面发生了什么——**它只看得到自己的会话**。
档案馆是唯一能看见整条接力的地方。

所以这个视图最实用的读法是：**换手间隔长的地方，就是上下文最容易丢的地方**，
那几场会话值得优先读。

### 一个必须如实处理的细节：会话会重叠

本机实测 my-app 的 224 次换手里有 **87 次间隔为负**——上一段还没结束，
下一段已经开始了。原因很实际：会话的 `end` 是最后一条消息的时间，一个开了
好几天、偶尔回一句的会话会"横跨"别人的工作。

三种情况分开报，**不合并成一个数**：

| 类型 | 含义 | 为什么不合并 |
|---|---|---|
| `sequential` | 正常先后接续（间隔 ≥ 0） | — |
| `overlap` | 时间重叠（间隔 < 0） | 算成 0 会让"平均换手间隔"偏小；取绝对值则虚构了一段等待时间 |
| `unknown` | 有一边没有时间戳 | 算不出来就是算不出来 |

平均间隔只在 `sequential` 上算，重叠数单独报。把并行当成"接续"会让
"换手间隔"这个指标彻底失真。

间隔超过一周的标成 `stale`（长期中断）——这类换手基本等于重新开始。

### 三处入口

| 位置 | 内容 |
|---|---|
| `handoff <项目>` | 终端，带每个换手点前后的会话标题 |
| `project_handoffs` | MCP 工具，让别的 Agent 自己判断"该先读哪场" |
| `/handoff?path=` | 网页，表格形式；项目页顶部也有一行入口 |

网页只在项目页给一行摘要（`N 次换手 · N 次并行`），详情在独立页面——
项目页已经很长，再塞一张换手表会把它压垮。

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

### 十个工具

| 工具 | 作用 |
|---|---|
| `list_projects` | 有哪些项目、多少会话、哪些 Agent |
| `project_timeline` | 某项目的会话清单（只有元数据），每条带派生的子代理数 |
| `project_handoffs` | **跨 Agent 接力**：谁在什么时候接手、间隔多久 |
| `search_sessions` | 全文搜索，返回命中处摘录（含子代理会话，带标记） |
| `read_digest` | 读**已生成**的项目摘要；没有就提示怎么生成，不现编 |
| `read_session_summary` | 读某场会话已有的摘要，用来判断值不值得深挖 |
| `read_session` | 读正文，**分段**，默认 8000 字 |
| `session_stats` | 采集质量、索引规模、已有摘要数量 |
| `export_timeline` | 导出 Markdown |
| `inventory` | **环境层**：各 Agent 的 MCP / 技能 / 使用率 / 记忆（`type` 切换） |
| `model_calls` | **调用层**：每场会话/每个 Agent 的 token、缓存命中、费用 |

`read_digest` 和 `read_session_summary` 是视图层的入口。它们**只读已有的
摘要，不会替你调模型**——生成要花钱，必须由用户在终端显式执行。
推荐给 Agent 的调用顺序也写在 `initialize` 的 instructions 里：

```
list_projects → read_digest（有现成交接材料吗）→
  没有就 project_handoffs 看接力（哪次换手间隔最长）→
  search_sessions / project_timeline 定位 → read_session 读正文
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

## 调用层：`calls`——为一场对话付了多少钱

```bash
node src/cli.js calls                  # 按 Agent 汇总
node src/cli.js calls --by model       # 按模型
node src/cli.js calls --by session     # 按会话，并报出与会话层的匹配率
```

会话层记录"说了什么"，调用层记录"**为它花了多少**"。同一场对话换个模型，
成本能差十倍，而正文完全一样——只看会话看不出这件事。

数据来自**本地模型网关的调用日志**（本机实测 `~/.config/magpie/usage.jsonl`
15 天 2.5 万条）。网关记得比会话文件细：

| 字段 | 含义 |
|---|---|
| `in` / `out` | 本次请求的未缓存输入、输出 token |
| `cache_read` / `cache_write` | 提示词缓存命中与写入 |
| `ttft_ms` / `ms` | 首 token 延迟、整次耗时 |
| `credits` | 供应商自己报的费用（缺价时不估） |
| `status` / `tries` | 结果、重试次数 |
| `session` / `native_session` | **接会话层的钩子** |

本机实测：输入里 **96.8% 是缓存读**。没有这个口径，任何成本视图都是错的。

**边界要一起报。** 网关只看得见经过它的调用：本机 dsh 和 hermes 的
`session` 字段全空（不走网关），qoder 只有 76 场被网关看到而归档有 310 场。
所以 `calls` 同时给两个数——`86 场会话可对上 · 17704/25868 次调用（68%）`。
只报前者会让人以为覆盖率是 100%。这和技能使用率只统计显式调用是同一种诚实。

**没装网关就优雅降级**：返回 `ready: false` 和一句怎么启用的说明，不报错。
调用层是可选视图，不是依赖。

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
node src/cli.js digest E:\my-app              # 只估算，不花钱
node src/cli.js digest E:\my-app --run        # 真的跑
node src/cli.js digest E:\my-app --limit 20 --run --out digest.md
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
node src/cli.js refresh --project E:\my-app
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
| `/env` | **能力面**：各 Agent 的 MCP / 技能 / 记忆（`?tab=` 切换） |
| `/api/projects` | 项目清单 |
| `/api/timeline?path=` | 时间线 |
| `/api/agents?path=` | 各 Agent 分布 |
| `/api/search?q=&agent=&project=&limit=` | 搜索结果 |
| `/api/digest?path=` | 项目摘要（如果有） |
| `/api/session?agent=&id=&message=` | 会话正文，`message` 取单条 |
| `/api/env?tab=` | 能力面数据，`tab` 取 `mcp`/`skills`/`usage`/`memory`/`audit` |

`/env` 用六个 tab 而不是一个长页：技能清单有 290 行、记忆有 21 处，
全堆一页会让人找不到重点。默认落在总览——那才是第一眼该看的。

`tab` 参数只认白名单里的值，别的一律回落到总览，不把用户输入拼进页面。
页面上的环境变量**只有键名**：值在 `env/mcp.js` 的 `normalize()` 里
就被丢掉了，这一层根本拿不到。

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
| Qoder | `~/.qoder[-cn]/projects/<工作区>/<uuid>.jsonl`（新）· `cache/projects/...`（旧） | 新格式带时间戳和 cwd；旧格式只能靠 mtime |
| DeepSeek Harness | `$DSH_HOME/sessions/<cwd>/<session>/session.v<N>.jsonl[.zstd]` | 多帧 zstd；子代理跳过 |
| Hermes | **`~/.hermes/state.db`**（SQLite） | 多数无 cwd；`sessions/*.jsonl` 已废弃 |
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
  项目路径要从 `workspaceProjectDir`（`c:\...\.cursor\projects\e-my-app`）
  反解成 `e:/my-app`。
- **Antigravity** 有三套并存的数据。索引库（FTS5）覆盖 21 场，但只有
  3 场有明文 `transcript_full.jsonl`，另 18 场是 `.pb`（熵 8.0，
  gzip/deflate/brotli 全解不开）。**元数据能搜到，正文读不到**——
  doctor 会如实报 1/3 而不是假装能读。
- **Kiro** 的会话文件里 assistant 正文全是占位符 `"On it."`，真回复在
  执行包里（`actions[].output.message`），靠 `executionId` 关联。
- **Copilot** 的 16 个会话文件里 14 个 `requests` 是空数组，文件存在
  不代表有对话。
- **Qoder** 有两套存储。`cache/projects/.../conversation-history/` 是旧格式，
  没有时间戳也没有 cwd，只能靠文件 mtime 和目录名近似；`projects/<工作区>/<uuid>.jsonl`
  是现在的主存储，每行带 `timestamp` / `cwd` / `sessionId`，工具调用和结果都在文件里。
  本机实测新格式 291 场、旧格式只有 19 场——**只读旧格式会漏掉九成以上**。
  新格式里 `attachment`（技能清单）、`active-leaf`（对话树指针）、
  `file-history-snapshot`（文件备份）是运行时事件，不是对话内容，读正文时按类型过滤。
- **DeepSeek Harness** 的会话文件默认是 `.zstd`，而且是**多帧追加**——
  每批事件单独一帧，不是一个大帧。Node 的 `zstdDecompressSync` 只解第一帧，
  直接读会得到一行 header 就结束；扫描器按帧魔数切开逐帧解。
  Windows 桌面版把 `DSH_HOME` 指到 `~/DeepSeekHarness`，不是 `~/.dsh`。
  子代理也是独立 session 文件（header 带 `parentSession`），和 Codex 子代理一样跳过。
  正文里 `user/message` / `assistant/message` / `tool/call` / `tool/result` 是对话，
  `*-chunks` 是流式增量、`request/*` 是请求头，读进来只会重复。
- **Hermes** 的主存储是 `state.db`（SQLite），**不是 `sessions/*.jsonl`**。
  这是本项目最大的一次数据修正：早期只扫 jsonl，本机读到 34 场，
  而库里实际有 219 场（211 场有消息，去掉子代理和空会话后 165 场）。
  Hermes 官方文档也写明旧版 `*.jsonl` 不再写入或读取。
  **有 cwd 的只有 46/219**——多数是接飞书渠道的聊天，不绑定目录，
  但那 46 场必须归到项目，硬编码 `project: null` 会让它们永远进不了时间线。

`sameProject()` 会把"只记项目名"和"记完整路径"的条目并成同一个项目，
否则 `my-app` 和 `e:/my-app` 会在列表里并排两行。

## 环境层：`env`——这台机器上各 Agent 会什么

会话层回答"聊过什么"，环境层回答"**具备什么能力**"，调用层回答"**花了多少**"。

```
node src/cli.js env              # 每个 Agent 一行
node src/cli.js env mcp          # MCP 服务清单，跨 Agent 归并
node src/cli.js env skills       # 技能清单，按内容去重
node src/cli.js env usage        # 技能使用率：哪些真用过
node src/cli.js env memory       # 记忆与指令文件
node src/cli.js env audit        # 体检
```

对应的 MCP 工具是 `inventory`（`type` 取 `overview` / `mcp` / `skills` / `usage` / `memory` / `audit`）。
**这是给新 Agent 用的入口**：它自己调一次 `inventory`，就知道这台机器上别的
Agent 配了什么、装了什么、记得什么，再自己决定要不要跟进——本工具不替它搬。

### 技能使用率：本机 290 个技能里用过 25 个

这是环境层唯一"两边数据都要"的功能，也是别的工具做不了的：要同时知道
**装了哪些技能**（技能目录）和**用过哪些**（会话里的工具调用）。

本机实测：290 个技能，用过 25 个，**使用率 8.6%**。调用最多的是
`control-browser`（32 次），其余大多一两次。265 个从没被调用过。

**但"从没用过"是个上限，不是定论。** 实测各家的做法不一样：

| Agent | 怎么用技能 | 能否统计 |
|---|---|---|
| ZCode / Claude Code | 调 `Skill` 工具，`input.skill` 给名字 | ✅ |
| Codex | **没有 Skill 工具**，直接 Read 那个 SKILL.md | ❌ |
| Hermes | 走自己的机制，形态未统一 | ❌ |

所以只统计**显式调用 Skill 工具**的记录。Codex 那 269 场提到 "Skill" 的
会话里，绝大多数只是在正文里聊到这个词（讨论技能、贴 GitHub URL）。

这里有一个刻意的取舍：**不把"读了 SKILL.md 就算用过"算进来。**
那会显著抬高使用率，但也会让"从没用过"这个结论失去意义——而后者
才是这个功能的价值。宁可报一个偏保守的下限，并在输出里明说覆盖范围。

### 同名的技能可能是不同实现

`env usage` 里会看到三个 `xlsx`，那不是重复行。本机确实有三个内容哈希
不同的 xlsx 技能（ZCode 两个版本 + Hermes 一份）。它们各自匹配到同一批
使用记录，所以调用次数一样——输出里会标 `[同名 3 份实现]` 区分。

### 为什么单独一层，而不是并进会话表

会话是按项目组织的，换 Agent 就断了。MCP / 技能 / 记忆是**可迁移的能力与偏好**，
恰恰是新 Agent 最想要的东西，而且现在没有任何标准接口。两层共用同一个做法：
没有协议可依附，只能一家一个适配器，集中成注册表。

### MCP：按启动指纹认，不按名字认

这是和参照项目最大的分歧。cc-switch 的 `McpServer.id` 就是原生配置里的键名，
所以同一个服务在不同 Agent 里名字不同时，它会被算成两个。

本机的真实数据（`env mcp` 实测）：

```
● supabase  4 条注册 / 4 家
    别名    adbsupabase / supabase
    启动    local / npx
```

一个 supabase 服务，4 条注册，**2 个名字，3 种启动形态**。如果按名字认，
"我到底配了几份、哪份是活的"就永远答不了。所以身份从 `command + args` 推：

1. 剥掉 `cmd /c`、`sh -c` 这类包装层（Windows 上极常见）
2. 找 `npx` 拉起的包名 → `pkg:@scope/name#npx`
3. 找 `node_modules/<包名>/` → `pkg:@scope/name#local`
4. 其余取 `dist/` 之后的脚本路径，或可执行文件名

**服务身份 = 去掉安装方式后缀的包名**，所以 npx 拉的和本地装的能归到一起；
而 `#npx` / `#local` 这个后缀单独保留，正好回答"两边装的到底是不是一个东西"。
`supabase` 就因此报出「安装形态不一致」——一边钉版本、一边每次拉最新。

各家格式差异（都在 `src/env/mcp.js` 里写明）：

| Agent | 位置 | 形状 |
|---|---|---|
| Claude Code | `~/.claude.json` | 顶层 `mcpServers` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<名>]` + `[.<名>.env]`，**多行 args 数组** |
| ZCode | `~/.zcode/cli/config.json` | 多一层：`mcp.servers` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp`，`type: local/remote`，**`command` 是数组** |
| Hermes | `~/.hermes/config.yaml` | `mcp_servers`，**无 `type` 字段** |
| Gemini | `~/.gemini/settings.json` | `mcpServers` |

TOML 和 YAML 都是手写的最小解析器，只取 `mcp_servers` 那一段——
为一个字段引依赖不值得，而 Codex 的多行数组用单行正则会被吃掉半行
（第一版就是这么失败的）。

### 凭证：只给键名，值永不出这个模块

本机实测 **3 份配置里有明文阿里云 AccessKey**（Claude 全局、ZCode、Qoder）。
MCP 工具如果原样回传 `env`，等于把这些凭证直接送进某个模型的上下文。

所以规则是硬的：`normalize()` 只保留 `Object.keys(env)`，值在那一行就被丢掉，
下游任何一层都拿不到。`env audit` 会提醒"这个服务有明文凭证"，
但也只说键名，并明确写「值未读取、未传输」。

要看值请自己打开配置文件。这个工具自己不能成为泄漏渠道——
和 `secrets` 命令「掩码比命中更激进」是同一条教训。

### 技能：按内容哈希认，而且必须跟随符号链接

本机 375 处安装、290 个独立技能。同一个技能在五个目录里装着，按名字认会撑爆列表。

身份用 `SKILL.md` 的 SHA-256：名字会改（`design-taste-frontend` 和
`-v1` 是两代），同名不同内容也真的存在（同一插件的新旧版本就是）。

**踩过的坑**：第一版用 `Dirent.isDirectory()` 遍历，Qoder 的 3 个和 Kiro 的
28 个技能全部漏掉，而且**静默漏**——显示"0 个技能"而不是报错。原因是它们
全是指向 `~/.agents/skills/<name>` 的符号链接，`isDirectory()` 对链接返回 false。

而这恰恰是最典型的跨 Agent 场景：用链接共享一份技能。修法是 `lstat` + `stat`，
真目录才参与环路保护（链接不记录已访问路径，否则会误判成环）。
现在 Kiro 显示 28 个、Qoder 32 个，`lark-*` 系列正确报成三家共享。

每条产出还带 `symlinked` 计数：全是链接说明只维护一份（好），
有真有假说明有人手工复制过（会漂）。

### 插件缓存里的历史版本不能算"多个技能"

ZCode 的插件缓存按 `<插件>/<版本>/skills/<技能>` 组织，升级后旧版本不删。
本机 122 个技能里面有 **60 个是历史版本残留**——`docx` 8 份（0.1.0 一路到
0.2.1）、`pdf` 8 份、`computer-use` 6 份。

那不是"装了 8 个不同技能"，是同一个技能留了 8 个版本。所以这个根按
`(插件, 技能名)` 只保留**版本号最高**的一份。ZCode 从 122 落到 62，
全机从 300 落到 290——这才是真实数字。

版本判断只处理数字段（`0.2.1` > `0.1.5`）；读不到版本号的目录原样保留，
宁可多报一个也不猜谁新谁旧。

### 性能：从 3.2 秒到 0.55 秒

第一版全量扫一次 3.2 秒，而 MCP 是常驻进程、每次 `inventory` 都重扫一遍。
三段优化，每一段都是先量再改：

| 改法 | 省下 | 为什么快 |
|---|---|---|
| 不陪每个真目录做 `realpathSync` | 1.2 s | 环路只可能由符号链接造成，真目录没有回边。Windows 上每次 realpath 要 1-2ms，ZCode 缓存有 700 多个目录 |
| 一次读文件，正文和哈希共用同一个 buffer | ~0.15 s | 原先是 `readSkill` 和 `hashSkill` 各读一遍 |
| 以 `(mtime, size)` 为键做解析缓存 | ~1.0 s | 与会话层 `registry.js` 的 FileParseCache 同一策略 |

汇总层还有 30 秒 TTL 的缓存，因为一个会话里 `inventory` 可能被连调几次
（先看 overview，再按类型细看）。缓存返回 `structuredClone`，**不是同一引用**——
MCP 工具会拿列表去 filter/map，一旦改到缓存对象，后面所有调用都读到污染数据，
症状是"技能数莫名多一个"，极难查。

## 记忆：只报出处，绝不合并

这是最容易做错的一层。用户的 Hermes `USER.md` 和 Codex `MEMORY.md`
完全可能写着两条相反的偏好。合并成"你的记忆"是在说谎，而且新 Agent
读到一句被平滑过的结论，比读到两条带出处的矛盾更危险。

所以产出只有三样：**在哪、什么格式、有多大**。正文不在这层返回。

指令和记忆分开计数，因为语义不同：

- **instruction** — 每轮注入的行为约定（`AGENTS.md` / `SOUL.md` / `GEMINI.md`）
- **memory** — 跨会话积累的事实（`MEMORY.md` / 分片目录 / SQLite 库）

本机 21 处、322 条，覆盖 3 种格式：

| Agent | 形态 |
|---|---|
| Codex | `memories/MEMORY.md`（**450 KB，只报大小不读**）+ `memories_1.sqlite`（155 条） |
| Hermes | `memories/MEMORY.md` + `USER.md` + `memory_store.db`（14 条事实） |
| Qoder | `memory/` 目录：索引 + 8 个分片 |
| ZCode | **项目级**：`memories/projects/<项目>-<哈希>/memory/*.md`，10 处共 145 条 |

ZCode 的项目级记忆是这一层最有价值的部分——它按项目分开，正好能对上
会话层的项目维度。但目录名会混进临时工作区（`1792567885219-...`、`default-...`、
`draft-...`），这些如果当成项目名，会让"这个项目有哪些记忆"里全是噪音。
所以先判内部前缀、再剥 16 位哈希、最后过一道形状检查；认不出项目的
归到 `unattributed`，**不塞进项目列表冒充项目**。

### 体检 `env audit`

和会话层的 `doctor` 同一个思路：报数字，不报感觉。检查的都是
"看起来正常、实际会让人做错判断"的东西：

| 检查 | 为什么值得报 |
|---|---|
| 安装形态不一致 | npx 每次拉最新、本地安装钉版本，两边行为可能不同 |
| 同名不同别名 | 不是错误，但会让人以为配了两份 |
| 明文凭证 | 会被每个读到该配置的 Agent 拿到 |
| 记忆格式分散 | 换 Agent 后旧记忆不会自动跟过去 |
| 有数据但无配置能力 | 可能没配过，也可能这家配置放在没适配的位置 |
| 技能只在共享目录 | **共享目录本身不生效**，要有 Agent 目录里的链接或副本才读得到 |

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

- **无项目**：该 Agent 多数不记录工作目录（Hermes 165 场里只有 37 场归到了项目），不算缺陷
- **临时路径**：路径存在但属于 Agent 的临时落脚点
  （`.zcode/workspace/<uuid>`、`Documents/Codex/<日期>`），被 `isProjectPath`
  主动过滤，是设计如此
- **占位标题**：桌面端自动触发的会话没有真人输入，标题退化为来源名
  `(Codex Desktop)`，这是合理降级

所以"待办"里只列真的该修的东西，不会长期挂着已经查清的正常项。

## 跨平台

各 Agent 的存储位置在不同系统上遵循不同约定。`src/platform.js` 负责应用数据类路径，
**但大多数 Agent 的家目录点目录三平台一致**，真正需要单独处理的是少数几个。

| 类型 | Windows | macOS | Linux |
|---|---|---|---|
| VS Code 系应用数据 | `%APPDATA%\<App>` | `~/Library/Application Support/<App>` | `~/.config/<App>` |
| XDG 数据目录 | `%LOCALAPPDATA%\<app>` | **通常是 `~/.local/share`，不是 Application Support** | `~/.local/share/<app>` |
| 家目录点目录 | `~/.claude` 等，三平台一致 | 同左 | 同左 |

受影响的是 **Cursor / Kiro / Copilot Chat / OpenCode** 四家。

### macOS 上最容易搞错的三件事

这三条都是查了官方文档和源码才确认的，和直觉不一样：

**一、OpenCode 在 macOS 上不用 Application Support。**
它自己的 `global-roots.ts` 里写死 `XDG_DATA_HOME || ~/.local/share`，
没有 `process.platform === 'darwin'` 分支。所以 macOS 上也是
`~/.local/share/opencode/opencode.db`。看到 `~/.local/share` 别以为是 Linux 专用。
（有意思的是：OpenCode 的**管理员级配置**确实在
`/Library/Application Support/opencode/`——有 `~` 和没 `~` 是两个完全不同的位置。）

**二、`~/Library/Application Support/Claude` 是桌面应用，不是 Claude Code。**
Claude Code 的 CLI 三平台都用 `~/.claude/`，官方文档从没给过 Application Support 路径。
两者是不同产品、不同会话格式。

**三、Hermes 在 Windows 上官方位置是 `%LOCALAPPDATA%/hermes`，mac/Linux 是 `~/.hermes`。**
这是少数**真的按平台分叉**的一家（源码里 `sys.platform == "win32"` 判断）。

### 环境变量是比平台推断更可靠的一层

这是跨平台最值得投入的部分：**每个 OS 的默认路径都可能不同，但环境变量是
各家自己定义的、跨平台语义一致的**。用户把 `CLAUDE_CONFIG_DIR` 指到外置盘，
在哪个系统上都该找到。

已支持的覆盖变量（逗号分隔多值，支持 `~` 展开）：

| Agent | 变量 |
|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Codex | `CODEX_HOME` |
| OpenCode | `OPENCODE_DATA_DIR`、`OPENCODE_DB`、`XDG_DATA_HOME` |
| Qoder | `QODER_CONFIG_DIR` |
| Hermes | `HERMES_HOME` |
| Cursor | `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR` |
| Kiro | `KIRO_HOME` |
| Antigravity | `ANTIGRAVITY_DATA_DIR` |
| Gemini | `GEMINI_CLI_HOME` |

**Gemini CLI 有一个 macOS 专属的改道**：在 `sandbox-exec` 下写 `~/.gemini`
会被 Seatbelt 拦，运行时目录（含会话）改到 `~/.cache/.gemini`。
源码注释原文如此。所以两个位置都要探测。

实现上**不用 `process.platform` 硬分支选路径**，而是给出候选列表、
按顺序挑第一个真实存在的。这样换机、跨平台拷贝备份、或者某个应用
在某平台上没按约定写盘时，都能命中而不是静默失败。

`isProjectPath` 的临时目录名单同时涵盖 Windows（Desktop/Documents/
AppData）和 macOS（Library/Applications/Movies…）的系统目录；
`assertUnder` 的大小写比较跟随文件系统——Windows/macOS 忽略大小写，
Linux 严格区分（在 Linux 上忽略大小写是个真实的绕过口子）。
多根场景用 `assertUnderAny`：路径落在**任意一个**候选根下就合法
（`CLAUDE_CONFIG_DIR` 指到外置盘、`~/.config/claude` 的历史遗留都要能读）。

### macOS 上还要注意的几处细节

- **`/var` 是 `/private/var` 的符号链接**，`/tmp`、`/var/folders/...` 同理。
  路径相等比较必须 `realpath` 两侧，否则同一条路径会判不相等。
- **APFS 默认大小写不敏感**，但可以挂载 case-sensitive 卷。
  所以去重前先 `realpath`，不要依赖"大小写不敏感"当去重手段。
  （`claude-code-log` 就把 `/private/var/folders/` 硬编码进临时路径过滤表——
  这是路径比较必须 realpath 的典型证据。）
- **沙盒化的 app** 会把 `$HOME` 重定向到
  `~/Library/Containers/<bundle-id>/Data/`。Desktop 类应用值得两个位置都探。
- **在后台服务（launchd）里跑时 `HOME` 可能不是用户家目录**。
  Hermes 源码专门用 `pwd.getpwuid(os.getuid()).pw_dir` 兜底。

> **验证状态**：Windows 上 10 家 Agent 全部实测通过（1131 场会话，
> 解析失败 0、重复 id 0）。**macOS 与 Linux 仍未在真机跑过**——
> 路径约定已按官方文档和源码核对过，但这个仓库里没有第二台机器可用。
>
> **在 Mac / Linux 上首次使用，跑这一个就够：**
>
> ```bash
> node research/probes/mac-check.mjs
> ```
>
> 它是**单文件、零依赖**的，不需要 clone 整个仓库——把文件复制过去
> `node mac-check.mjs` 就能跑。会输出一份报告到
> `/tmp/agent-archive-mac-check.txt`，直接贴回来即可。
>
> 它做路径层面的自检：11 个 Agent 的候选路径哪些真实存在、
> 每个位置有多少会话文件、哪些环境变量被读进来。**全程只读。**
>
> 想跑更完整的验证（真的解析会话、验证正文可读性）：
>
> ```bash
> node research/probes/audit-paths.mjs    # 秒级：路径假设对不对
> node research/probes/verify-mac.mjs     # 分钟级：实际读到多少会话
> node research/probes/run-all.mjs        # 全部七个回归套件
> ```

### Cursor 的路径反解是个特例

Cursor 的项目目录名是「绝对路径把所有分隔符换成 `-`」——
`/Users/alice/my-repo` → `Users-alice-my-repo`。这个编码**有损**：
`Users-a-my-app` 可能是 `/Users/a/my-app`，也可能是 `/Users/a/my/app`。

所以取项目路径有明确的优先级：

1. `workspaceStorage/<hash>/workspace.json` 里的真实路径（权威来源）
2. 目录名反解，且**只在能确定形状时**（Windows 盘符 / `Users-` / `home-` 前缀）
3. 其余情况返回 `null`

第 3 条是关键：**宁可留空，也不给一个看起来合理、实际错误的路径。**
错的路径会静默污染项目归集，比缺数据难发现得多。

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

**项目路径归一化**：Windows 上同一个项目会出现 `e:\my-app`、
`E:\my-app`、`E:/my-app` 三种写法，来自不同 Agent。
比较用小写规范键，展示保留原样。

**路径解释在查询层**：CLI 只把用户敲的文本原样传下去，
`src/query.js` 的 `absProject()` 负责归一成绝对路径。
项目身份属于查询层，不属于展示层。

**缓存**（`src/registry.js`）：以文件路径为键，`(mtime, size)` 都没变就复用
上次的解析结果。这与 CC Switch 的 `FileParseCache` 是同一策略——绝大多数
会话在两次扫描之间没有变化，而重新解析一个 1.8 MB 的 JSONL 要几十毫秒。
实测 2042 个文件第二次扫描命中 2041 个。

**但只信 `(mtime, size)` 会漏数。** 恢复备份、云盘回写、`git checkout` 都会
保留 mtime；某些文件系统的 mtime 精度只有 1-2 秒，同一 tick 内两次写入看不出
差别；等长原地改写 size 完全不变。这三种情况都会让"没变化"这个判断成立，
而内容其实变了。所以命中前还要比一次**文件头 256 字节的哈希**——这是 MAGPIE
的判据，代价是每个命中文件多一次小读。

分两层跑，顺序不能反：先 stat（0.5 秒/2400 文件），只有 stat 说"没变"的才去
算头哈希。反过来每次先算头哈希会把扫描时间翻倍，收益完全一样。

**已知盲区**：只改文件中间、头不变、mtime 又被保留的改写，这一层检测不到。
堵它要对全文做采样哈希，实测 1.6 秒（2400 文件、129 MB），比整个扫描还慢。
真需要准确结果时用 `--no-cache`。

**SQLite 源必须把 `-wal` 一起算进缓存指纹。** Hermes、ZCode、OpenCode 都是
WAL 模式，新消息先写 `-wal`，主库文件的 mtime/size 可以长时间不动。只按
主库判断就会漏数，而且不报错：本机实测 Hermes 的 wal 比主库新 24 秒、
积了 3.4 MB 新消息，缓存却仍然命中。

扫描器通过 `extraFiles(file)` 声明自己的附属文件，registry 统一合并成指纹
（`CACHE_VERSION` 因此升到 3，旧缓存自动作废一次）。这条思路来自 MAGPIE
对 Hermes 的做法——它把 `(size, mtime)` 拼成 revision 并覆盖 checkpoint 后
wal 被截断的情况；这里的差别是"带哪些文件"由 scanner 自己声明。

**附属文件只看 size，不看 mtime。** 这条是从实测里学到的：SQLite 的 wal 在
没有新数据时，mtime 也会被读标记、checkpoint 元数据反复推动。本机连续三次
采样，两个库的 wal size 一模一样、mtime 却一直在走。按 mtime 判，等于每次
扫描都认定"变了"，Hermes 和 ZCode 会被无条件整库重解析。WAL 是追加式的，
size 不变就意味着主库里没有新的未合并页，所以只比 size 既能抓住真实变化，
又不会被读写痕迹误伤。

**索引侧的 source 解析也得认这几种形态。** `source` 有四种写法：单文件、
多段 `|`（Codex 续接会话合并而成）、`path#id`（SQLite 源）、`db:<id>`
（Hermes 只记会话 id）。曾经只做了 `split('#')[0]`，另外两种直接
`statSync` 失败、`mtime` 记成 null；而 `null === null` 成立，索引就
**永远不会重建**——本机 28 场 Codex + 165 场 Hermes 全部中招，表现是
"搜不到刚聊过的内容"。现在多段取最大 mtime、求和 size，`db:` 回退到
Hermes 库路径。修完 `mtime is null` 的记录从 193 条降到 0。

**长驻进程用 `scanCached()`，别直接调 `scanAll()`。** serve 和 MCP 都是常驻的，
一个页面会打出好几个请求（项目列表、时间线、摘要徽标），以前每个请求都完整
重扫一遍。加了 30 秒 TTL 后实测：首请求 2.35 秒，后续 12 毫秒。返回的是
`structuredClone`，不是缓存对象本身——下游会拿 sessions 去 filter/sort，
一处误改会污染后面所有调用（`inventory` 层踩过：技能数莫名多一个）。

CLI、doctor、refresh 这些一次性进程仍用 `scanAll()`：它们只扫一次，TTL 没有收益。

**噪音过滤**：各 Agent 会把斜杠命令、环境上下文、AGENTS.md 指令块、
IDE 状态当成用户消息写进会话。这些会污染标题，必须在抽取"第一条真实
用户输入"时剥掉。没有用户输入的会话（自动化、子代理触发）退到助手
第一句话，再退到触发来源。

**只读**：所有 scanner 只读，绝不修改 Agent 的原始会话文件。ZCode 的
SQLite 以 readOnly 打开，用完立即关闭句柄（Windows 上不关会锁文件）。

**但 `readOnly: true` 并不真的不落盘。** 实测（把 Hermes 的 state.db 复制到
临时目录后打开，前后各列一次目录）：打开之后目录里多出 `-shm` 和 `-wal`
两个文件。一个声称只读的工具，会在 Agent 自己的目录里新建文件——不只是脏，
`-wal` 的存在还会让 Agent 下次启动走不同的 checkpoint 路径，并且这两个文件的
时间戳会污染其他工具（包括本项目）的"有没有变化"判断。

所以统一走 `src/sqlite-read.js`，分两种情形：

| 情形 | 做法 | 理由 |
|---|---|---|
| 没有 `-wal`（或 wal 为空） | `immutable=1` | 零文件创建，代价是会忽略 WAL——但没有 WAL 要忽略 |
| 有 `-wal` | 复制 db + wal 到临时目录再读 | `immutable=1` 会**完全忽略 WAL**，实测在未 checkpoint 的库上连表都看不见（`no such table`）；复制是唯一既看得到最新数据、又不碰 Agent 目录的做法 |

临时副本按 `(size, mtime)` 缓存，源没变就复用，不必每次复制 250 MB 的库。
这是 MAGPIE 在 Cursor 上踩过同一个坑后的处理方式。

**Hermes 再套一层按会话的增量。** registry 的缓存是按文件判的，state.db 一动
整库 165 场全部重解析——而 Hermes 是追加式写入，聊完一场，别的会话一个字都没变。
所以 `hermes.js` 里用一次 SQL 聚合给每场会话算指纹（`count(*)` + `max(timestamp)`
+ `sum(rowid)`），只有指纹变了的才去查首条用户消息。

指纹刻意**不**用 `total(length(content))`：实测它要解压每行正文，203 ms，
比原来读全表求首条消息（117 ms）还慢，把省下来的力气全吃回去。三列合起来
只要 6 ms。效果：整库解析从 379 ms 降到 3-4 ms（稳态）。

越界校验**：正文读取的路径来自缓存里记的 `source` 字段。如果只信它，
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
// SQLite 源再加一个：参与缓存判据的附属文件（WAL 等）
export function extraFiles(file) { return [`${file}-wal`]; }
```

然后在 `src/registry.js` 的 `scanners` 数组里加一行。

这不是设计上的偷懒，而是这类工具的唯一组织方式：没有 Agent 提供
"读取我的会话"的标准接口，只能一家一个适配器，把它集中成注册表
才可维护。

## 下一步（还没做）

- 在 Mac / Linux 上跑一次 `research/probes/verify-mac.mjs`，按输出修正平台差异
- 批量刷新多项目：现在 `refresh` 一次处理全部，但缺一个"只刷最近活跃项目"的过滤

只有等这个档案馆在你手上真正用起来之后，才值得往上加蒸馏和交接摘要。
