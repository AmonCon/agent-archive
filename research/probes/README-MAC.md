# 在 Mac 上验证 agent-archive

`mac-check.mjs` 是**单文件**的，不依赖仓库其它文件。复制一个文件过去就能跑。

---

## 最快：一条命令

在 **Mac 的终端**里执行（只需要 Mac 上装了 Node 22+）：

```bash
# 如果 Mac 上已经有仓库
node research/probes/mac-check.mjs

# 如果没有，把 mac-check.mjs 复制过去，然后
node mac-check.mjs
```

跑完会打印一份报告，同时写一份到 `/tmp/agent-archive-mac-check.txt`。
**把那份报告的内容发回来即可。**

不需要 `npm install`，没有依赖。

---

## 怎么把文件传过去

任选一种：

**A. 用 AirDrop / U 盘**
把 `E:\agent-archive\research\probes\mac-check.mjs` 拷到 Mac 桌面。

**B. 用 git（如果 Mac 上能连 GitHub）**

```bash
git clone git@github.com:AmonCon/agent-archive.git
cd agent-archive
node research/probes/mac-check.mjs
```

**C. 用 curl 从 GitHub 直接取**

```bash
curl -O https://raw.githubusercontent.com/AmonCon/agent-archive/main/research/probes/mac-check.mjs
node mac-check.mjs
```

---

## 它做什么

| 检查 | 说明 |
|---|---|
| 环境 | 平台、Node 版本、家目录、家目录是不是软链 |
| 11 个 Agent 的路径 | 所有候选路径、哪个真实存在、有没有环境变量覆盖 |
| 每个位置有多少数据 | 会话文件数 / SQLite 行数 |
| 汇总 | 哪些有数据、哪些路径全都不存在 |

**全程只读。** 不写任何 Agent 的目录，不在别人的数据里留文件。

---

## 怎么判断结果

### 有数据的那些

对照你自己用过的：**如果你记得用过某个 Agent，但它显示 0，说明我们路径假设错了。**
这种情况下不用你改代码，把报告发回来就行——报告里会列出它试过哪些路径，
一看就知道该往哪改。

### 几个正常现象，不是 bug

- **Gemini CLI 显示 0 个 session** —— 如果 `~/.gemini/tmp` 是空的，说明它确实没存会话。
  Gemini CLI 的会话放在 `tmp/` 下且会被清理，可能已经被清掉了。
- **Cursor / Kiro / Copilot 各只有 1-3 个** —— 如果你只用 IDE 不常用这几家，这是正常的。
- **Antigravity 正文读不到** —— 大部分是加密的 `.pb`，只有索引能读。这是已知限制。

### 我在 Mac 上最想确认的四件事

这是本轮改动里"按官方文档推断、但没在真机验证过"的部分：

1. **OpenCode 是不是真的在 `~/.local/share/opencode`**
   而不是 `~/Library/Application Support/opencode`。
   官方源码的 `global-roots.ts` 里没有 darwin 分支，但我想看到实际落盘位置。

2. **Hermes 的 `state.db` 在 macOS 上是不是 `~/.hermes/state.db`**
   源码里写的是 mac/Linux 走 `~/.hermes`、Windows 走 `%LOCALAPPDATA%`。

3. **VS Code 系（Cursor / Kiro / Copilot）在 `~/Library/Application Support/<App>/User/`**
   这条基本确定，但想确认目录名大小写（`Code` 还是 `code`）。

4. **家目录是不是软链** —— 如果是，路径比较必须 realpath，
   影响 `assertUnder` 的越界校验。脚本会明确标出来。

---

## 如果你愿意跑更完整的验证

`mac-check.mjs` 只探路径，不真的解析会话。仓库里还有两个更重的：

```bash
# 真的扫一遍所有会话，验证正文可读性、项目归集
node research/probes/verify-mac.mjs

# 一条命令跑全部六个回归套件
node research/probes/run-all.mjs
```

`verify-mac.mjs` 会读出实际有多少场会话、每家的正文能不能读。
这个更有说服力，但也更慢（分钟级，取决于你 Mac 上有多少会话）。

**先跑 `mac-check.mjs`** —— 如果路径就不对，跑重的那个没意义。
