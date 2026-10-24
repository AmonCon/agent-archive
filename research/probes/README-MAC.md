# 在 Mac 上验证 agent-archive

两个单文件脚本，都零依赖，复制过去就能跑。

| 脚本 | 什么时候用 |
|---|---|
| `mac-discover.mjs` | **先跑这个**。不知道这台 Mac 上装了什么，看它有什么 |
| `mac-check.mjs` | 已知装了什么，核对我们的路径假设对不对 |

**如果 `mac-check.mjs` 报 0/11，别急着改代码——先跑 `mac-discover.mjs`。**
0/11 通常不是路径写错，而是这台机器装的是别的 Agent（比如 OpenClaw），
不在我们假设的名单里。按名单找永远找不到名单外的东西。

---

## 第一步：看这台机器上有什么

```bash
node mac-discover.mjs
```

它会枚举 `~` 下的所有点目录和 `~/Library/Application Support`，
对每个目录算数据签名（多少 jsonl / sqlite / md / pb），
再试读 SQLite 找会话表。

输出分三段：

1. **已被本工具支持并且有数据** —— 这些是能直接读的
2. **扫到数据但本工具还没适配** —— 这些是新发现，发回来就能加适配器
3. **只有配置/资源** —— 装了但没聊过，或只是资源文件

关键是第 2 段。它给出目录位置、会话表名、行数——有这个就能写解析器。

---

## 第二步：核对已知 Agent 的路径

```bash
node mac-check.mjs
```

检查 11 个已知 Agent 的候选路径哪些真实存在、每个位置有多少数据、
有没有环境变量覆盖。

跑完会打印报告并写到 `/tmp/agent-archive-mac-check.txt`。

---

## 两条常见报错

**`zsh: permission denied: ~/Desktop/mac-check.mjs`**
同步过来的文件没有可执行权限。用 `node` 显式调用就好：
`node ~/Desktop/mac-check.mjs`

**`Cannot find module '/Users/xxx/mac-check.mjs'`**
shell 不在桌面目录。先 `cd ~/Desktop`，或者用完整路径
`node ~/Desktop/mac-check.mjs`。

---

## 它做什么

| 检查 | 说明 |
|---|---|
| 环境 | 平台、Node 版本、家目录、家目录是不是软链 |
| 11 个 Agent 的路径 | 所有候选路径、哪个真实存在、有没有环境变量覆盖 |
| 每个位置有多少数据 | 会话文件数 / SQLite 行数 |
| PATH 上的可执行文件 | `which claude` 这类，判断装了什么工具 |
| 汇总 | 哪些有数据、哪些路径全都不存在 |

**全程只读。** 不写任何 Agent 的目录，只往 `os.tmpdir()` 写一份报告。

---

## 怎么判断结果

### 有数据的那些

对照你自己用过的：**如果你记得用过某个 Agent，但它显示 0，说明我们路径假设错了。**
把报告发回来就行——报告里会列出它试过哪些路径。

### 几个正常现象，不是 bug

- **Gemini CLI 显示 0 个 session** —— 它的会话放在 `~/.gemini/tmp/` 下且会被清理。
- **Antigravity 正文读不到** —— 大部分是加密的 `.pb`，只有索引能读。
- **`node:sqlite` 的 ExperimentalWarning** —— 无害。Node 22 起内置 SQLite
  还在实验阶段，警告可以忽略，脚本用 `--no-warnings` 跑就没有了。

---

## 我在 Mac 上最想确认的几件事

按官方文档和源码推断、但没在真机验证过的：

1. **OpenCode 是不是真的在 `~/.local/share/opencode`**
   而不是 `~/Library/Application Support/opencode`。
   官方源码的 `global-roots.ts` 里没有 darwin 分支。

2. **Hermes 的 `state.db` 在 macOS 上是不是 `~/.hermes/state.db`**
   源码写的是 mac/Linux 走 `~/.hermes`、Windows 走 `%LOCALAPPDATA%`。

3. **VS Code 系（Cursor / Kiro / Copilot）在 `~/Library/Application Support/<App>/User/`**
   这条基本确定，但想确认目录名大小写（`Code` 还是 `code`）。

4. **家目录是不是软链** —— 如果是，路径比较必须 realpath。

5. **这台机器上有没有我们不认识的 Agent** —— 这条最有价值，
   只能靠 `mac-discover.mjs` 回答。

---

## 完整的验证（可选）

```bash
node research/probes/verify-mac.mjs   # 真的解析会话，验证正文可读性
node research/probes/run-all.mjs      # 全部七个回归套件
```

`verify-mac.mjs` 需要整个仓库，不只是单个文件。

