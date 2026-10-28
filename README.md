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

## 它长什么样

一个项目、四场会话、三家 Agent。下面是**真实输出**——用合成数据跑出来的，
项目名和对话是编的，格式、排序和换手判断都是真的。

```bash
$ node src/cli.js timeline C:/example/my-app
C:/example/my-app
4 个会话 · claude-code / codex / qoder · 2026-03-02 17:12 → 2026-03-05 16:52 · 累计 2.3h

2026-03-02
  codex        17:12  36min  我的应用里，登录之后刷新页面就掉登录态。帮我看下。

2026-03-03
  qoder        18:00  31min  登录问题昨天在 Codex 那边修了，但测试环境还是复现。

2026-03-04
  codex        22:03  38min  购物车在 Safari 上数字不更新，Chrome 正常。

2026-03-05
  claude-code  16:20  32min  把这三件事的修复写进 CHANGELOG，并补两个回归用例。
```

`handoff` 把同一批会话压成**接力链**——谁在什么时候接手、中间隔了多久：

```bash
$ node src/cli.js handoff C:/example/my-app
4 场会话压成 4 段 · 3 家 Agent · 2026-03-02 17:12 → 2026-03-05 16:52

换手概况
  3 次接续
  接续间隔中位数 1.0d
  最常走的接力线：codex→qoder(1)  qoder→codex(1)  codex→claude-code(1)

codex       → qoder            +1.0d 接续
    离开: 我的应用里，登录之后刷新页面就掉登录态。帮我看下。
    接手: 登录问题昨天在 Codex 那边修了，但测试环境还是复现。
qoder       → codex            +1.1d 接续
    离开: 登录问题昨天在 Codex 那边修了，但测试环境还是复现。
    接手: 购物车在 Safari 上数字不更新，Chrome 正常。
codex       → claude-code     +17.6h 接续
    离开: 购物车在 Safari 上数字不更新，Chrome 正常。
    接手: 把这三件事的修复写进 CHANGELOG，并补两个回归用例。
```

**间隔是重点。** 隔了一天再换手，新 Agent 不会知道前面修过什么——除非你
手动把上下文粘过去。「接续间隔中位数 1.0d」这个数字，比任何摘要都更能说明
问题出在哪：你换了工具，但记忆没跟着换。

`handoff` 也会如实区分"并行"（上一段还没结束下一段就开始了，不是真正的交接）
和"长期中断"（隔了一周以上），不会把两种完全不同的情况混成一个数字。


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

## 用法

需要 **Node 22.15 或更高**。理由不是口味：读 `.zst` 压缩会话要用 zlib 的 zstd
支持（22.15 起），读各家 SQLite 会话库要用 `node:sqlite`（22.5 起）。
版本不够时入口会直接说清楚缺什么、要升到哪个版本，而不是在某个 scanner 里
抛一段看不懂的 TypeError——第一个跑起来的用户很可能就在老 Node 上。

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

## 深入：按主题看

上面的用法够日常用了。以下是每个设计决定**为什么这么定**——都是踩过之后写下的，
按主题分组，可以按需跳读：

- **扫描与合并**：搜索与中文分词 · 续接会话合并 · 子代理会话 · 时间戳 · 符号链接 · 解析失败 · 缓存原子写
- **接口**：跨 Agent 接力 · 导出 · MCP server · 本地网页查看器 · `cat`
- **成本与安全**：调用层 `calls` · 凭证扫描 `secrets`
- **环境层**：MCP / 技能 / 记忆 · 采集体检 `doctor`
- **跨平台**：三个系统的路径差异 · 为何只有 10 家
- **扩展**：给别人家的 Agent 写扫描器 · 反向发现没适配的存储 · 设计要点 · 下一步

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

### 剥离嵌入的父会话副本

子代理被采集之后，索引体积一度从 143 MB 涨到 386 MB。查下来不是"子代理本身
就该这么大"，而是有一类子代理在**复制父会话**：

Codex 的 guardian 子代理不做活，专门审阅父会话的每个动作。它收到的 prompt 长这样：

```
The following is the Codex agent history whose request action you are assessing...
>>> TRANSCRIPT START
[1] user: ...          ← 父会话的完整片段，含工具输出、测试日志、文件内容
>>> TRANSCRIPT END
The Codex agent has requested the following action:
>>> APPROVAL REQUEST START
Planned action JSON: {...}
>>> APPROVAL REQUEST END
```

**而且一场子代理里有几十轮**——每审一个动作就嵌一份。本机实测 1543 场子代理里
650 场是这类，合计 74.7 M 字符，占子代理索引量的 86%。同一份对话被索引两遍，
搜「支付回调」时命中结果被复制品挤占。顺带：这些嵌入片段里常有明文 API key。

所以索引层加了 `stripEmbeddedTranscript()`，剥掉标记包住的部分：

| 块 | 处理 |
|---|---|
| `TRANSCRIPT START … END` | 剥（父会话副本） |
| `TRANSCRIPT DELTA START … END` | 剥（增量副本，**且会嵌套在上一块里**） |
| `APPROVAL REQUEST START … END` | 剥（待审动作的完整参数） |

**只剥标记内，标记外全部保留**——那里才是这场子代理的产出：它对每个动作的
判断（`{"outcome":"allow","rationale":"..."}`）。那是父会话没有的信息。

两个踩过的坑，都写进注释了：

1. **只认 `TRANSCRIPT START` 会漏掉 DELTA 变体**。第一版剥完仍有 400K+，
   因为后面几十轮用的是 `TRANSCRIPT DELTA START`。
2. **必须先剥 DELTA 再剥普通块**。DELTA 块有时整块落在普通块内部，反过来的话
   非贪婪匹配先吃掉外层，把内层 DELTA 的 END 留成孤立标记（实测残留 96 场）。

效果：索引 386 MB → **205 MB**，子代理正文 82.7 M → 19.9 M 字符。
主会话 1433 场**一场都没被碰**（规则只匹配带 `>>>` 前缀的标记，
正常对话里提到 "transcript" 这个词不会命中）。

验证方式：拿 31 场原始 rollout 直接跑规则，残留 0；再对全库查标记，只剩 1 场
——那是我们正在讨论这个话题的会话本身。

## 时间戳：三个静默缺陷

这一节记录本版修掉的三处"看起来正常、实际算错"的时间问题。它们的共同点是
**不报错**：都不抛异常、都返回一个看起来合理的值，只是那个值是错的。

### 一、只读文件头会让结束时间早算

Codex 的 rollout 是 `.jsonl[.zst]`，为避免为列个标题解压几百 MB，扫描器只读
前 256 KB。写这段时的想法是"截断的 zstd 帧解压会失败，失败了就退回整文件"。

**这个兜底从来没触发过。** `zlib.zstdDecompressSync()` 遇到截断帧不抛错，
而是安静地返回已解码的部分。实测在一份 87 MB 的 rollout 上它"成功"返回了
**0.3%** 的内容，于是结束时间取到的是开头的几条事件。

| 指标 | 修复前 |
|---|---|
| 结束时间差 >1 小时 | 268 场 |
| 结束时间差 >1 天 | 91 场 |
| 最大偏差 | 26 天 |

整文件解压能修（2032 个文件、1.7 GB，实测 110 秒），但不值得——**Codex 自己
维护了一份更准的记录**。`~/.codex/state_5.sqlite` 的 `threads` 表里每个线程有
`updated_at` / `title` / `tokens_used`。拿它和完整解压的真实末条对照：

| 判据 | 平均偏差 | 最大偏差 |
|---|---|---|
| `threads.updated_at` | **1 秒** | 1 秒 |
| 文件 mtime | 507 秒 | 2420 秒 |

所以用那张表修，代价是一次 48 毫秒的查询。这也正是 cc-switch 的做法
（它把 state_5 的用户标题和 mtime 兜底结合起来）。明文 `.jsonl` 另走一条
更便宜的路：直接读尾部 64 KB 取真实末条。

### 二、导入会话的时间戳全是导入时刻

37 场 `external-import-turn` 会话，文件里**每个事件的顶层 `timestamp` 都是
导入那一刻**（集中在一秒内），真实时间在 `payload.started_at` / `completed_at`
（Unix 秒）里。

不修的话这些会话在时间线上全部堆到导入那一天，`start` 和 `end` 都是。
注意 `payload.completed_at_ms` 名字有误导性——它装的也是导入时刻，不是完成时间。

### 三、旁路数据改了，索引不跟着改

索引按源文件的 `(mtime, size)` 判复用。但上面两处修的是**会话元数据**，
源文件一个字没动——于是索引里一直显示旧的占位标题和错的起止时间。

修法是把 `title` / `start` / `end` 也纳入复用比较。代价是比三个值，
比重新读正文便宜得多。

修完的效果：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 时间差 >1 小时 | 268 场 | **0** |
| 最大偏差 | 26 天 | 727 秒 |
| 平均偏差 | — | 1.8 秒 |
| 标题覆盖率（doctor） | 94.1% | **98.9%** |
| 无真人输入 | 5.9% | 1.1% |

换手视图的时间随之重算（my-app 的并行从 87 次变 117 次，中位间隔更准）。

### 实现上的一处取舍：`enrich` 不进磁盘缓存

旁路数据的修正放在 `scanner.enrich()` 里，在 registry 合并之后跑，**不写进
磁盘缓存**。因为会话文件的解析结果按 `(mtime, size, 头哈希)` 缓存，如果把
state_5.sqlite 也算进每个 rollout 的指纹，Codex 每写一次状态库就会让 2037 个
缓存条目全部作废——一次几十秒，而正确性没有任何额外收益。

enrich 自己的读取按 `(size, mtime)` 在进程内记忆，所以重算很便宜。

## 测试

```bash
npm test          # node --no-warnings --test
```

14 个用例，1.3 秒。零依赖——用 Node 内置的 `node:test`。

### 测试不依赖这台机器

这是最关键的一条设计。**每个用例自己在临时目录里造一份假机器**：

`os.homedir()` 在运行时跟随 `USERPROFILE`（Windows）/ `HOME`（POSIX），所以
把家目录指到临时目录之后，**所有扫描器自然只看得到用例造的数据**——不需要给
每一家单独做环境变量覆盖，也不可能碰到跑测试那台机器上的真实会话。

这件事对开源产品是必须的：真实数据有 2400 多个文件、几个几百 MB 的库，
全扫一遍要一分多钟；换成空家目录是毫秒级。更重要的是，**别人的机器上路径、
版本、格式都和我们不一样**，测试如果依赖开发者的家目录，那它只证明了
"我这台机器能跑"。

### 用例锁的是踩过的坑，不是当前实现
| 用例 | 锁住的事实 |
|---|---|
| 旧版子代理 `session_id` 指向父会话 | `id` 必须是自己，不能拿 `session_id` 当归并键 |
| 新版父 id 在 `parent_thread_id` | 只认旧写法会漏 41 场 |
| guardian 没有父 id | 如实留 `null`，不推测填一个假值 |
| 导入会话 | 用 `payload.started_at`/`completed_at`，不用导入时刻 |
| 明文长文件 | 尾部读取能拿到真实结束时间 |
| 旁路表 | 用 `state_9.sqlite` 而不是 `state_5`，证明没有写死版本号 |
| 真实用户第一句 | 不被应用标题覆盖 |
| 解析失败 | 会话保留、计数正确、下一轮重试、修好后恢复 |
| 缓存 | 原子写、不留临时文件、损坏不崩 |
| 空结果 | 不算解析失败（否则本机凭空报 15 个假警报） |

上游改了格式，这些用例会先红——比用户机器上静默少数据好。

**还缺的**：目前只覆盖 Codex、注册表和跨平台路径。Hermes（`\x00json:` 编码、
compaction 摘要）、DSH（多帧 zstd）、Qoder（新旧两套存储）、Cursor（protobuf）
都还没有契约测试。按 `test/codex.test.js` 的形状加即可。

### 跨平台路径也是被测的

这个工具只在 Windows 上真机跑过，macOS / Linux 的路径假设全部来自官方文档和
源码核对。造不出一台 Mac，但可以让路径解析**接受平台注入**：

```js
userDataCandidates('Cursor', { platform: 'darwin', home: '/Users/demo', env: {} })
// → ['/Users/demo/Library/Application Support/Cursor', ...]
```

于是能在本机断言"在 macOS 上会得到什么候选列表"。`test/platform.test.js` 锁住了
README 里写的那些反直觉事实，比如 **OpenCode 在 macOS 上也用 `~/.local/share`**
（它源码没有 darwin 分支）。哪天有人"顺手"给它加个 Application Support 分支，
测试会红。

这**不替代真机验证**：它验证的是"我们怎么想"，不是"系统怎么表现"。
真机验证仍然待做——`research/probes/mac-check.mjs` 就是为此准备的。

## 打包与发布

`npm pack` 出来 226 KB / 43 个文件，只含 `src/` 和三个文档：

```json
"files": ["src/", "README.md", "LICENSE", "NOTICE.md"]
```

`research/`（含第三方源码副本与调研脚本）和 `test/` 不进包——安装的人不需要
它们，而 `research/reference-src/` 里有别人的代码，随包分发只会带来许可上的混乱。

`bin` 两个入口都带 shebang，`npx agent-archive` 和全局安装都能直接用。

**许可**：MIT。`research/reference-src/` 下是 MIT 项目的源码副本，版权与许可
声明在 `NOTICE.md`——这也是它不随 npm 包分发的原因之一。

## 会话正文缓存：为什么读第二次要快

读一场大会话很贵：本机实测 Codex 的 89 MB `.zst` 读一次 **1.1 秒**
（整文件解压 + 逐行 JSON 解析）。而原来**读第二次仍然要 1 秒**——没有任何缓存。

这不是"偶尔慢一下"：网页每刷新一次读一次、`cat` 一次读一次、导出读一遍。
用户在会话页上按 F5 就要等一秒。

所以加了一层进程内缓存（`src/transcript-cache.js`），做法与 cc-switch 的
`TranscriptCache` 同一个设计——按源文件指纹失效，LRU 同时按**条数**和**字符数**
双限（8 场 / 96 M 字符）：

| 场景 | 加缓存前 | 加缓存后 |
|---|---|---|
| 同一场大会话第二次读 | 1082 ms | **0.4 ms** |
| 网页会话页第二次请求 | 1.3 s（只有扫描缓存） | 0.33 s |

三条边界：

- **只缓存解析好的消息数组，不缓存原始字节**——瓶颈是解析，不是 IO。
- **共享引用，不深拷贝**：几万个 part 克隆一次就把缓存的意义抵消了。
  所以调用方不得修改返回的数组；现有调用方（export / digest / server / mcp /
  search）都只读。
- **指纹算不出来就不缓存**：文件刚被删、stat 失败时宁可重读，也不能把过期
  内容当成新的。多段 `a|b`、`path#id`、`db:id` 四种 source 形态都能取指纹。

## 索引：为什么不做字节游标增量

原本的计划是给索引加"字节游标"——只读文件新增的部分。动手前先量了一下
成本分布，结论是**不值得做**：

| 环节 | 40 场抽样耗时 |
|---|---|
| 读文件 + 解析 | **11.9 s** |
| 拆成索引文本 | 7 ms |
| 中文二元组分词 | 36 ms |

成本几乎全在读取上，而稳态下的索引本来就不慢：

```
第一次（全量）  90 s
第二次（无变化） 2.8 s   复用 3102 / 重建 0
```

也就是说 90 秒只在首次建索引或 `--force` 时出现。字节游标能把"大量会话各追加
几行"那次从 22 秒压到更低，但**它救不了首次全量**，而首次全量恰恰是最痛的一次。

真正能同时改善首次索引、网页、`cat`、导出的是上面那层正文缓存——一次改动，
四个消费者都受益。所以索引层保持"按 (mtime, size) 复用解析结果"不变。

**如果以后要再做**：该做的是按解析策略分三类（追加型日志走游标、整份重写的
走整读、SQLite 走每会话指纹）——magpie 就是这么分的，见
`research/upstream/LESSONS.md`。

## 配置：路径在别人机器上不一样

```bash
agent-archive config init     # 生成一份配置模板
agent-archive config          # 看当前配置生效成什么样
agent-archive config path     # 配置文件在哪
```

`~/.agent-archive/config.json`：

```json
{
  "roots": {
    "codex": ["D:/archive/.codex"],
    "claude-code": ["/Volumes/work/.claude"]
  },
  "disabled": ["kiro"]
}
```

`roots.<agent>` 里每一项的含义 = 该 Agent 的**家目录**（`~/.codex`、`~/.claude`
那一层）。往下怎么拼（Codex 是 `sessions/`、Hermes 是 `state.db`）由扫描器自己
知道，用户不需要懂。`disabled` 里的 Agent 不会被扫描。

### 为什么不能只靠环境变量

大部分 Agent 都支持环境变量覆盖（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、
`HERMES_HOME`…），终端里很好用。但两种真实场景下很别扭：

1. **GUI 拉起的 MCP server**：Claude Desktop / Cursor 启动子进程时不一定继承
   你 shell 里设的变量。用户改了半天"没生效"，也不知道为什么。
2. **一台机器上有多份数据**：`CODEX_HOME` 只能指一个。用户想同时看本机盘和
   外置盘上的两份，环境变量表达不了。

配置文件两个问题都能解决，而且与环境变量**不冲突**：配置里的根排在前面
（用户显式写的优先），环境变量与平台默认继续作为后备候选。

### 三条边界

- **没有配置文件是正常状态**，不是错误。
- **配置写坏了只让这一层失效**：当作空配置继续跑，原因在 `agent-archive config`
  里显示。配置是让事情变方便，不该成为新的单点故障。
- **改完立即生效**：按 `(mtime, size)` 缓存，长驻的 serve / MCP 也能感知。

## 扩展：给别人家的 Agent 写一个扫描器

> 具体步骤（读格式、写契约、跑验证、注意事项）见 **[CONTRIBUTING.md](./CONTRIBUTING.md)**。
> 这一节只说为什么这么设计。

内置的十一家是"我们碰巧知道"的。世界上的 Agent 远不止这些，而且新的一家随时
会出现。**支持某家不该需要改我们的代码、提 PR、等发版。**

所以扫描器是开放的：

```bash
agent-archive scanner init myagent     # 生成一份能跑通的骨架
agent-archive scanner path             # 看目录（默认 ~/.agent-archive/scanners）
agent-archive scanner check <文件>      # 校验契约
agent-archive scanner list             # 看哪些生效了、哪些加载失败
```

把文件放进那个目录，下次运行就生效。

### 契约

```js
export const name = 'xxx';                 // 必需，唯一标识
export function discover() {}              // 必需，返回文件路径数组
export function parse(file) {}             // 二选一：一个文件一场会话，返回会话或 null
export function parseAll(file) {}          // 二选一：一个文件多场会话，返回数组
export function readMessages(session) {}   // 可选，读正文（不写就只进清单）
export function extraFiles(file) {}        // 可选，参与缓存指纹的附属文件（如 -wal）
export function enrich(sessions) {}        // 可选，用旁路数据修正元数据
export function closeStore() {}            // 可选，用完关句柄
```

会话对象用 `model.js` 的 `makeSession()` 造，字段是
`{agent, id, project, title, start, end, source, resume, kind, parent}`。
子代理会话标 `kind: 'subagent'` 并填 `parent`，时间线会自动把它们挂在父会话下。

### 三条边界

**一、一个坏文件不能拖垮整次扫描。** 加载失败、契约不合格、`discover()` 抛错，
都只影响它自己：其余扫描器和内置的照常工作，`doctor` 与 `scanner list` 会把
失败原因列出来。开放扩展必须付这个代价——别人的代码跑在我们的进程里，
至少要保证隔离在**文件**级别。

**二、不能与内置重名。** 重名会让人分不清是哪份在跑，直接拒绝加载。

**三、它是代码，不是配置。** 用户扫描器在本进程里执行，能读写任何东西。
README 不假装它是沙箱——只该放自己信任的文件。

### 扫描器和配置的分工

| 你的情况 | 用哪个 |
|---|---|
| 同一个 Agent，数据在别的位置 | `config.json` 的 `roots`（不用写代码） |
| 一家我们不认识的 Agent | `scanner init` 写一个扫描器 |
| 某家不用 / 太慢 / 坏了 | `config.json` 的 `disabled` |

### 和「反向发现」是同一个闭环

`doctor` 会列出"看起来像会话存储、但我们读不懂"的目录。看到这些之后有两条路：
提到 issue 等我们支持，**或者自己花二十分钟写一个扫描器**。后者不需要等任何人
——这也是这个项目愿意开放扫描器的原因。

## 反向发现：这台机器上还有什么我读不懂

这是"给所有人用"最直接的一条。

用户装的 Agent 里一定有几个我们没听说过。**原来的行为是沉默**——列表里没有、
doctor 也不提，用户会以为"这工具不支持我的 Agent"，然后卸载。我们自己也不知道
该补哪一家。

`doctor` 现在会扫一遍常见位置，把"看起来像会话存储、但不在已接入范围"的目录列出来：

```
未适配的会话存储（启发式猜测）
  这些目录不在已接入范围内，但内容看起来像会话记录。
  只是"看到什么"，不下结论——是不是、要不要支持，需要人判断。
  ? ~/AppData/Roaming/SomeAgent                    57.2MB  1 个 sessions 类子目录 · 6 个会话形态文件
  ? ~/.some-agent-cli                              21.5MB  2 个 sessions 类子目录 · 4 个会话形态文件
  ? ~/AppData/Roaming/AnotherApp                    1.9MB  1 个 sessions 类子目录 · 9 个会话形态文件
  ? ~/.yet-another                                  11.4MB  1 个 sessions 类子目录 · 37 个会话形态文件
  如果要支持其中某个，把这一行（路径 + 里面有什么）提到 issue 即可。
```

（路径与数字是示意——真实输出会列出**你这台机器上**装了什么。）

同样的信息也经 MCP 的 `session_stats` 的 `unknownStores` 字段给到其他 Agent。

### 三条设计上的克制

**一、只报"看到什么"，不下结论。** 不写"这是一个 Agent 会话库"，只写
"这里有 1 个 sessions 类子目录、6 个会话形态文件"。因为这是启发式，会误报
（`pgAdmin` 也有 `sessions/` 目录）也会漏报（加密的、改扩展名的扫不到）。
给一个确定性口吻的结论比不给更糟。

**二、入选要求"有 sessions 类子目录"或"目录名像会话存储"，光有 `.jsonl` 不算。**
第一版只看扩展名，结果本机把 `pnpm-cache`（251 个 .jsonl）、`pgAdmin`、
`~/.config/magpie` 全报了出来。一个充满误报的列表，用户第二次就不会看了。

**三、已知范围要从"已发现的会话"反推，不能只看我们写的适配清单。**
适配清单列的是**数据文件**（`state.vscdb`），而这里扫的是**应用根目录**
（`AppData/Roaming/Cursor`）。拿前者排除后者会漏掉一大片——本机实测会把
`Cursor`、`QoderCN`、`DeepSeekHarness` 全报成"未适配"，而它们本来就读得好好的。

### 性能：8.2 秒 → 0.55 秒

第一版递归扫三层，本机 8.2 秒——`~/AppData/Roaming` 下上百个应用，每个都往下走，
代价全花在浏览器缓存、GPU 缓存这类明显无关的目录上。

改成**两阶段**：先只看顶层，没有 sessions 类子目录、也没有会话形态文件、名字也不像，
就直接判否。真正需要深看的只有很少几个，耗时降了一个量级。

遍历有硬上限（深度 3、单目录 300 个条目），只 `readdir` + `stat`，**不打开任何文件**。
它会在别人的机器上跑，不能因为某个目录特别大就卡住。

## 跟踪上游参照

我们借鉴的三个项目（MAGPIE、cc-switch、AutoSwarm）都在持续演进，MAGPIE 几乎
每天有提交。靠"重新通读一遍"来跟会失控，而且每次重读都会重新推导同样的结论。

所以把它们当成**长期订阅源**：

```bash
node research/upstream/refresh.mjs            # 只看有没有新提交
node research/upstream/refresh.mjs --diff     # 拉新版本，只列我们关注范围内的改动
node research/upstream/refresh.mjs --update   # 读完确认，把 pin 推进到最新
```

- `research/upstream/sources.json` 记住"我们读到哪一版"（commit）
- `research/upstream/LESSONS.md` 是判断台账：每条写清**已采用 / pending /
  不适用 / 已否决**，以及落到了哪个文件

于是"继续研究"变成一次几分钟的 diff 复核。上次跑的时候它立刻发现 AutoSwarm
在我们读完后又有了新提交——这正是这种机制要解决的问题。

本地镜像放在 `~/.agent-archive/upstream-cache/<id>`，不进仓库：仓库里只保留
"读到哪一版"和"学到了什么"，不复制别人的源码。

## 符号链接与 junction：一整家会话可能被静默漏掉

`fs.readdirSync(dir, { withFileTypes: true })` 返回的 Dirent，对符号链接和
Windows junction 一律报 `isDirectory() === false`——它回答的是"这个目录项本身
是不是目录"，不是"它指向的东西是不是目录"。实测：

```
link     dirent.isDirectory()=false | lstat.isSymbolicLink()=true | stat.isDirectory()=true
target   dirent.isDirectory()=true  | lstat.isSymbolicLink()=false | stat.isDirectory()=true
```

后果是**静默丢一整家会话**：用户把 `~/.codex/sessions/2026` 搬到别的盘、在原处
留一个 junction（Windows 上最常见的腾空间做法），扫描器一个文件都读不到，
而 doctor 报的是"这个 Agent 没装"——不是报错，是安静地少一家。

这个坑在环境层已经踩过一次（技能扫描因为同样的原因漏掉 Qoder 的 3 个和 Kiro 的
28 个技能，症状也是"0 个技能"而不是报错）。当时只修了那一处，会话扫描器里一直留着。
现在统一成 `src/fsentry.js` 的 `isDirEntry()` / `isFileEntry()`，8 个扫描器的
17 处 Dirent 判定全部替换。

**实测验证**（子目录级 junction，这才是会失效的场景）：

```
<config>/projects/E--fake  -->  <另一个盘>/E--fake
  dirent.isDirectory() = false   ← 旧逻辑在这里跳过整段
  新逻辑发现: projects\E--fake\1111....jsonl
```

**保留例外**：kiro 的 `listJson()` 刻意跳过文件级符号链接，注释写明是
"避免被指到根目录之外"的安全考虑——那处不动。

## 解析失败不再让会话消失

扫描器解析失败时，原来的处理是 `continue`：这场会话从本轮结果里消失，而且
缓存条目被丢掉，下次也补不回来。更糟的是"解析成功但结果为空"——那会被当成
"这场对话没有内容"直接缓存下来，**一次暂时性失败就变成了永久错误**。

本机实测：把一场 DSH 会话的 jsonl 写坏，下一次扫描它就从时间线上没了，
`failures` 还是 0。

现在的处理：

| 情况 | 判据 | 处置 |
|---|---|---|
| 解析抛异常 | `ok: false` | 计 `failures`，保留上一次结果 |
| 曾经有会话、这次解析为空 | `emptied` | 计 `emptied`，保留上一次结果 |
| 本来就不是会话 | 扫描器返回 null | 正常，不计失败 |

**第三行是关键。** 如果把"返回空"一律当失败，本机会凭空报出 15 个"解析失败"
（Copilot 的 16 个会话文件里 14 个 `requests` 是空数组、Codex 有 2 个 rollout
没有时间戳）——这正是这个项目一直在避免的那种假警报。

保留旧结果时**沿用旧指纹**，这样下一轮仍会判定"变了"并重试；若写新指纹，
下一轮会命中缓存，会话就永远停在旧内容上。

实测（故意写坏一场 DSH 会话）：

```
好数据:  sessions 41  failures 0  emptied 0
损坏后:  sessions 41  failures 0  emptied 1  keptStale 1   ← 会话保住了
修复后:  sessions 41  failures 0  emptied 0                ← 自动恢复
```

`doctor` 会把 `emptied` / `keptStale` 报出来。不报的话，"会话数没变"可能掩盖
一场正在被写坏的会话——那正是这个项目一贯要避免的那种沉默。

## 缓存的原子写

`saveCache()` 从 `writeFileSync` 改成同目录临时文件 → `fsync` → `rename`。

原因是这份缓存有 1 MB 量级，写一半崩了会留下截断的 JSON；下次 `loadCache`
解析失败返回 `{}`，看起来是"优雅降级"，实际是整机全量重扫一次（实测 50 秒），
而用户不知道发生了什么。

CLI、serve、MCP 可能同时写这份缓存，原子替换也让并发写不会互相截断——
最后写完的赢，而不是两败俱伤。这个做法取自 MAGPIE 的 `steady.WriteFile`
和 cc-switch 的 `stage_write`。

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
| `credits` | 供应商自报的**额度消耗**，单位由各家自定，不是货币金额 |
| `status` / `tries` | 结果、重试次数 |
| `session` / `native_session` | **接会话层的钩子** |

本机实测：输入里 **96.8% 是缓存读**。没有这个口径，任何成本视图都是错的。

**边界要一起报。** 网关只看得见经过它的调用：本机 dsh 和 hermes 的
`session` 字段全空（不走网关），qoder 只有 76 场被网关看到而归档有 310 场。
所以 `calls` 同时给两个数——`86 场会话可对上 · 17704/25868 次调用（68%）`。
只报前者会让人以为覆盖率是 100%。这和技能使用率只统计显式调用是同一种诚实。

**没装网关就优雅降级**：返回 `ready: false` 和一句怎么启用的说明，不报错。
调用层是可选视图，不是依赖。

### 三类数字不能混在一起

这一层最容易误读的地方不是缺数据，而是**把不同性质的行算进同一个分母**。
本机对着 3.2 万条真实日志核过，三处必须分开：

| 情况 | 本机实测 | 为什么不能混 |
|---|---|---|
| 网关**本地拒绝**（`rejected: true`，如 "provider switched off"） | 44 条 | 它没往上打、credits 是 0、ms 只有 1 毫秒。混进去会让"这个模型很爱失败""平均耗时很低"两个结论同时失真。现在单独计 `rejected`，并给 `upstreamCalls` |
| `credits` 被当成"费用" | 21850 条有值，17112 条为正 | 它是**供应商自报的额度消耗**，单位由各家自定（次数/积分/美元都有）。写"费用"会让人拿它做预算决策 |
| `req` 与 `served` 不同 | 30410 条有 served，其中 75% 字面不同 | **绝大多数不是"模型被替换"**，而是路由组别名：`group/auto-deepseek-v4-1-flash` 解析成 `deepseek-v4.1-flash`。按字面比会报出一个 75% 的假警报，所以只在明细里给出 `served`，不做"替换率"统计 |

会话匹配也必须带 agent：ZCode 和 OpenCode 都用 `session_xxx` 这类 id，
只按 id 会跨家错挂。改成 `agent|id` 之后，本机能对上的调用从 17704 次
增加到 20653 次——之前有些调用挂到了别家的同 id 会话上。

**上游有、我们没有的两个字段**：MAGPIE 的日志里有 `handed_on`（失败后转交
下一跳）和 `source=reported`（客户端自报的直连调用），本机 3.2 万条里
**一条都没有**，所以不做相应处理。查过、不适用，写在这里免得以后重复调研。

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

> **验证状态**：
>
> | 平台 | 状态 | 证据 |
> |---|---|---|
> | Windows 11 | ✅ 真机 | 10 家 Agent、1131 场会话、解析失败 0、重复 id 0 |
> | macOS 26.7.1 (Darwin 25.6, x64) | ✅ 真机 | 97 个用例全过（2.0 s）；`doctor` 在干净机器上跑通 |
> | Linux | ⏳ 仅 CI | `.github/workflows/test.yml` 的 ubuntu job |
>
> **macOS 那次真机验证抓出两个只有干净机器才会暴露的问题**：
> 零会话时 doctor 首屏全是 ✗（覆盖率分母为 0 被当成失败）；反向发现的
> "已知路径"排除清单因为读错字段（`paths` vs `hits`）**一直是空的**，
> 导致同一屏里既写"已接入：Qoder"又把它列成"未适配"。两个都修了。
>
> CI 在三平台 × Node 22.15 / 24 上跑同一套测试（22.15 是 `engines` 声明的
> 最低版本，等于顺带验证那句话是不是真的）。
>
> **想在另一台机器上验，一条命令：**
>
> ```bash
> node research/probes/remote-verify.mjs --host user@192.168.1.10 \
>   --node-bin /tmp/node/bin        # 远端没装 Node 时，指向临时解压出来的 bin
> ```
>
> 它把当前 HEAD 打包传过去、跑测试、把结果带回来，跑完删远端临时目录。
> 远端不需要装依赖（项目零依赖），只要求能免密 ssh 登录。全程不碰远端
> 任何 Agent 的真实数据——测试都在临时目录里自造数据。
>
> 如果只是想看路径层面（不跑测试、不动数据）：`node research/probes/mac-check.mjs`。
>
> **已用上游源码做过一次交叉核对**（magpie 是跨平台的，它的路径函数按 GOOS
> 参数化并有 darwin/windows 测试）：Hermes、Claude Code、Qoder、DSH、ZCode
> 五家的 macOS 规则与我们一致，其中 ZCode 的结论值得单独说——它**故意不跟随**
> `$HOME` 覆盖，会话库始终在 `USERPROFILE\.zcode\cli\db`（上游注释里有
> ZCode 3.14.3 的实测记录）。详见 `research/upstream/LESSONS.md`。
> 核对还发现一处覆盖缺口：`~/.gemini/antigravity-cli` 我们没扫。
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
