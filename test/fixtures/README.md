# 共享 fixture

**一份数据，多个入口。** 扫描器解析、Web 渲染、MCP 读取都用这里的样本。

规则：

- 每个样本都是**按真实形状合成的最小样本**（几十行），保留结构、去掉隐私。
  真实用户会话里有项目名、提问、路径，仓库要开源，不能放。
- 增加一个样本 = 在 `samples/` 放文件 + 在 `index.js` 的 `FIXTURES` 里登记
  「物化到 sandbox 的哪个路径、用哪个扫描器、期望看到什么」。
- `test/fixtures-contract.test.js` 会对每个登记过的样本跑一遍全链路；
  新样本没被登记或被契约用例覆盖到，元测试会报。

| 样本 | 锁的坑 |
|---|---|
| `workbuddy.jsonl` | 用户消息裹着 `<system-reminder>` 注入上下文（真话在 `<user_query>`）；编辑重发留下旧版 + `resend-fork-notice`；`function_call` 的 `id` 是消息 id、`callId` 才是工具 id；限流失败也写成 assistant message；`ai-title` 优先 |
| `claude-fork-*.jsonl`（3 个） | `--fork-session` / `/branch` 把历史整段复制：首条与末条 uuid 相同的是复制品、末条不同的是分叉 |
| `codex-main.jsonl` + `codex-sub-{new,old}.jsonl` | Codex 三代父 id 写法：新版 `session_id == id` + `parent_thread_id`；旧版 `session_id` 直接指父；guardian 子代理没有父 id |
| `dsh-multiframe.zstd` | DSH 的 `.zstd` 是**多帧追加**，`zstdDecompressSync` 只解第一帧会得到空会话 |
| `qoder-legacy.jsonl` | Qoder 旧格式：没有时间戳、没有 cwd，项目只能从目录名反推、时间取 mtime |

这些样本是从两个上游项目（MAGPIE / cc-switch）的源码读出的格式契约，
加上本机的真实数据的形状合成的；判断记录在 `research/upstream/LESSONS.md`。

## 两类夹具，缺一不可

- **数据夹具**（`fixtures-contract.test.js`）：同一份字节，扫描 / Web / MCP
  三个入口读出来的内容必须一致。它抓的是「解析对了但渲染丢了」。
- **环境夹具**（`fixtures-env.test.js`）：**同一份数据 + 不同的环境输入**
  （`DSH_HOME` 的大小写、`CODEX_HOME` 指向空目录、`WORKBUDDY_CONFIG_DIR`、
  配置里的 `roots`）。它抓的是「数据没错、环境一变就读不到」。

上一轮那个真 bug（`DSH_HOME` 写成小写 → 同一会话被当两场 → 正文 ENOENT）
用数据夹具**抓不到**，因为坏的不是数据。所以两类都要有。