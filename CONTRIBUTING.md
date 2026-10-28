# 参与开发

这份文档面向"想动手改这个项目的人"。README 讲的是**为什么这么设计**，这里讲
**具体怎么做**。两者不重复。

- 想给自己那家 Agent 加支持 → 第 1 节
- 想改代码、但不清楚测试怎么写 → 第 2 节
- 想在没有 Mac 的情况下验证跨平台 → 第 3 节
- 不确定该改配置还是写代码 → 第 4 节

---

## 1. 给一家新 Agent 加支持

### 先别写代码

在动手之前，先确认三件事。**顺序不能反**——写错方向的适配器比没有更糟。

**一、它的数据到底在哪。** 别信网上的路径，去自己机器上找：

```bash
agent-archive doctor
```

它会列出「未适配的会话存储」，那是从数据结构反推的候选（含 sessions 类子目录、
会话形态文件）。如果目标 Agent 在里面，路径就有了。没有的话，自己翻一下：

```bash
ls ~/.<agent>            # 大多数 CLI 在这
```

**二、会话记录长什么样。** 打开一个文件看前几行。你需要判断：

- 是"一个文件一场会话"，还是"一个文件里很多场"（SQLite、或按 id 分目录）
- 时间戳字段叫什么，是秒还是毫秒
- 项目路径（cwd）在哪一层
- 有没有子代理标记（`parent_*` 之类）

**三、它的时间戳语义。** 这一步最容易被跳过，也最容易出错。我们踩过的两种：

- **导入的会话**：Codex 的 `external-import-turn`，所有事件的顶层时间戳都是
  "导入那一刻"，真实时间是 payload 里的 `started_at`/`completed_at`。
  按顶层时间读，半年前的对话会全堆到导入那天。
- **WAL 模式的库**：主库文件的 mtime 可以几十秒不动，新数据在 `-wal` 里。
  只看主库会漏掉刚聊的会话（见第 2 节的测试写法）。

### 生成骨架

```bash
agent-archive scanner init myagent      # 生成 ~/.agent-archive/scanners/myagent.js
agent-archive scanner path              # 目录在哪
```

骨架是可运行的（`discover()` 返回空数组），先跑通再填内容：

```bash
agent-archive scanner check ~/.agent-archive/scanners/myagent.js
agent-archive scanner list
```

### 契约

```js
export const name = 'xxx';                 // 必需，唯一标识，不能与内置重名

export function discover() {}              // 必需，返回文件路径数组

export function parse(file) {}             // 二选一：一个文件一场会话，返回会话或 null
export function parseAll(file) {}          // 二选一：一个文件多场会话，返回数组

export function readMessages(session) {}   // 可选，读正文；不写就只进清单
export function extraFiles(file) {}        // 可选，参与缓存指纹的附属文件（如 -wal）
export function enrich(sessions) {}        // 可选，用旁路数据修正元数据
export function closeStore() {}            // 可选，用完关句柄
export function candidateRoots() {}        // 可选但强烈建议：声明你会去哪些目录
```

### 返回普通对象就行

**不需要 import 这个项目的任何模块。** `parse`/`parseAll` 返回普通对象，缺省值
由宿主补（`agent` 取扫描器名、`kind` 缺省 `main`、时间接受 Date / ISO 字符串 /
毫秒数）：

```js
export function parse(file) {
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    id: meta.id,                 // 必需
    project: meta.path || null,  // cwd，拿不到就 null（不要编一个）
    title: meta.title || null,
    start: meta.createdAt,       // 毫秒数、ISO 字符串或 Date 都行
    end: meta.updatedAt,
    source: file,                // readMessages 用它读正文
  };
}
```

子代理会话再加两个字段：`kind: 'subagent'` 和 `parent: '<父会话 id>'`。

内置扫描器用 `src/model.js` 的 `makeSession()`，效果一样。用户扫描器不必依赖
它——仓库一移动或升级，绝对路径 import 就断了。

### 四条必须遵守的规矩

**一、只读。** 不写、不改、不移动任何 Agent 的文件。要读 SQLite，用
`src/sqlite-read.js` 的 `openReadOnly()`——它处理了"只读打开仍会创建
`-shm`/`-wal`"和"有 WAL 时必须复制再读"两种情况。

**二、拿不到就留 null，不要猜。** 项目路径反解不出来、父会话 id 没写，
都返回 null。错的路径会静默污染项目归集，比缺数据难发现得多。

**特别注意：cwd 指向 Agent 自己的内部目录时要返回 null。** 实测 Accio 有些会话的
`path` 是它自己的工作区（`~/.accio/accounts/<id>/agents/<id>/project`）——那不是
用户项目，当成项目列出来会污染清单。宿主会按 `candidateRoots()` 兜底过滤一层，
但扫描器自己判更准。

**三、子代理会话要采集，不要丢。** 标 `kind: 'subagent'` + `parent`。
它们在主会话里只是一句"派个代理去查"，实际查了什么全在子会话里。
时间线默认只显示主会话，所以采集它们不会让列表翻倍。

**四、声明 `candidateRoots()`。**

```js
export function candidateRoots() {
  return [path.join(os.homedir(), '.myagent')];
}
```

`doctor` 和反向发现都消费它。**不声明会出现自相矛盾**：扫描器能读到某目录，
反过来说这个目录"未适配"。粒度是**应用根那一层**（`~/.codex`、`~/.claude`）。

### 验证

```bash
agent-archive scanner list          # 你那个是不是 source=user、加载成功
agent-archive doctor                # 覆盖率、正文抽样、"有目录但没有会话"
agent-archive projects              # 会话进没进项目
agent-archive timeline <项目路径>    # 时间对不对
agent-archive cat <会话id> --tools   # 正文读得出来吗
```

`doctor` 的「正文抽样」是 `N/M` 形式。不是 M/M 就说明 `readMessages` 有问题。

---

## 2. 写测试

这个项目**零依赖**，测试用 Node 内置的：

```bash
npm test                      # 跑全部
node --test test/dsh.test.js  # 跑一个文件
```

### 用 `sandbox()` 造假机器，不要读真实数据

```js
import { sandbox } from './helpers.js';

const box = sandbox();
try {
  box.write('.myagent/sessions/a.jsonl', JSON.stringify({...}) + '\n');
  await box.run(() => {
    // 这里 os.homedir() 指向临时目录，所有扫描器只看得到我们造的数据
  });
} finally {
  box.cleanup();
}
```

`sandbox()` 会把 `USERPROFILE`/`HOME` 指到临时目录。**这是必须的**：

- 真实数据换台机器就没了，测试会失效
- 本机 2400 多个文件全扫一遍要一分多钟；空家目录是毫秒级
- 测试绝不能碰用户真实的会话文件

注意：`box.write()` 是相对**假家目录**的路径；`box.dir` 是沙盒根，别混。

### 锁"踩过的坑"，不锁"当前实现"

好测试的判据：**如果换个实现方式、行为不变，测试还应该绿**。

反面例子：

```js
// ❌ 复述实现：改了内部结构就红，但用户看到的行为没变
assert.equal(session.start.getTime(), 1774599070054);
```

正面例子：

```js
// ✅ 锁事实：时间戳是秒不是毫秒，用错了会掉到 1970
assert.equal(s.start.getUTCFullYear(), 2026, 'epoch 秒不能被当毫秒');
```

### 不要断言运行时能力

这条是 CI 教的。曾经写过：

```js
// ❌ CI 上红了：Node 24.12 只解第一帧，24.22 已经会解全部帧
assert.ok(!zstdDecompressSync(raw).includes('第二帧'), '前提：只解第一帧');
```

运行时能力会随版本漂。**只断言我们自己的行为**：

```js
// ✅ 不管原生怎么表现，扫描器都必须读到后续帧
assert.ok(scanner.decompressFrames(raw).includes('第二帧内容'));
```

### 要覆盖的几类形状

新 Agent 的测试至少覆盖：

| 类别 | 为什么 |
|---|---|
| 时间戳单位 | 秒/毫秒搞错会全掉到 1970，但不会报错 |
| 多场会话 | `parseAll` 少返回一场，用户看不到 |
| 子代理 | 漏标 `parent`，子会话就挂不到父会话下 |
| 读不出 | 加密/占位符格式要抛错说明原因，不能返回空数组冒充"没有会话" |
| 缓存失效 | 附属文件（`-wal`）变了要重扫 |
| 空输入 | 空文件、半行 JSON 不能让整场会话消失 |

### 失败就红，不要 `skip`

为了保持全绿而 `skip` 的用例会烂在那里。我们有过三个这样的 skip，后来全部
修好转绿了——它们各自对应一个真实缺陷（Cursor 的 `workspaceId`、DSH 的工具
输出、Qoder 的子代理）。

如果确实测不了（比如需要真实账号），就**删掉这条测试**，并在代码注释里写清
为什么测不了，别留一个永远 skip 的占位。

---

## 3. 在没有第二台机器的情况下验证

```bash
# 本机：三平台矩阵在 CI 里跑（.github/workflows/test.yml）
# 另一台机器（macOS / Linux），一条命令：
node research/probes/remote-verify.mjs --host user@192.168.1.10 \
  --node-bin /tmp/node/bin     # 远端没装 Node 时，指向临时解压的 bin
```

它做的事：`git archive` 打包当前 HEAD → `scp` 过去 → 远端解开 → 跑 `npm test`
→ 把结果带回来 → 删远端临时目录。

- 不用 `git clone`：仓库可能是私有的，远端不一定有你的凭据；而且这样测的
  就是你本地这个 commit
- 不用 `npm install`：零依赖，只要求远端 Node ≥ 22.15
- 不碰远端任何 Agent 的真实数据（测试自己造假数据）

远端没装 Node 时，用官方 tarball 解到 `/tmp` 即可，不要动系统环境：

```bash
mkdir -p /tmp/aa-node && cd /tmp/aa-node
curl -fsSL https://nodejs.org/dist/v24.12.0/node-v24.12.0-darwin-x64.tar.gz | tar -xz
```

---

## 4. 配置、扫描器、还是禁用

三种需求，三种做法，别用错工具：

| 你的情况 | 做法 |
|---|---|
| 同一个 Agent，数据在别的位置（外置盘、备份） | `agent-archive config init`，写 `roots.<agent>` |
| 一家我们完全不认识的 Agent | `agent-archive scanner init` 写扫描器 |
| 某家不用 / 太慢 / 坏了 | 配置文件里的 `disabled` |

`roots.<agent>` 里每一项的含义是**该 Agent 的家目录**（`~/.codex` 那一层），
往下怎么拼由扫描器自己知道——用户不需要懂内部结构。

配置文件排在环境变量之前，所以它也能解决"GUI 拉起的 MCP server 不继承
shell 环境变量"这个场景。

---

## 5. 别把本机写进仓库

这个仓库是公开的。开发过程中最容易被顺手写下来的，不是密钥，而是**真实环境**：
真实项目名当作路径示例、真实局域网地址当作 `--host` 示例、真实的
`C:\Users\<你的用户名>` 当作测试夹具。这些东西不会让任何测试失败。

所以提交前跑一遍：

```bash
npm run privacy
```

它只查被跟踪的文件（没被跟踪的不会公开），规则是通用的：密钥形状、私钥块、
非占位符的用户目录、内网地址、机器名、真实邮箱。CI 里也有一道同样的门。

两条约定：

- **示例一律用占位符**：`E:\my-app`、`192.168.1.10`、`C:\Users\me`。
  保留示例的结构，只换掉身份——`c:\Users\me\.cursor\projects\e-my-app`
  比删掉整段注释有用。
- **有些名字连"不能出现"都不能公开**。这类词写进 `.privacy-deny`（一行一个，
  已被 gitignore），检查器读到就报，但只报位置、不回显内容。CI 上没有这个文件，
  所以它守的是你自己的机器——正好是泄露最容易发生的地方。

如果确实有一行必须包含敏感形状（比如 `src/secrets.js` 里识别私钥的正则），
在行尾加 `privacy-ok` 并说明理由。

---

## 什么会被合

这些约束是这个项目的立身之本，不是风格偏好：

1. **零 npm 依赖。** 用 `node:` 内建模块。为此我们手写了 MCP 的 stdio 传输、
   TOML/YAML 的最小解析器。
2. **只读。** 不提供删除、修改、注入 Agent 数据的功能。
3. **一次提交一个目标。** 顺手的重构单独提。
4. **新 Agent 必须带测试**，且测试能在空家目录下跑（见第 2 节）。
5. **必须声明 `candidateRoots()`**，否则 doctor 会自相矛盾。
6. **报错要让人能自己判断。** 宁可说"读不了，因为 X"，也不要"尽力而为"地
   猜一个看起来合理的值。

最后一条最重要：这个项目的价值在于**如实记录事实**。一个静默的错误比一个
明确的失败危险得多——用户看不出问题，却会据此做出错误决定。
