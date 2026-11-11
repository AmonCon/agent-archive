# 合成数据源样本（sources/mixed-bundle）

这些是**按真实形状合成的最小样本**，只用于「数据源解耦」测试，绝不含任何本机真实会话。
与 samples/ 的区别：本目录**不物化到假家目录**，而是被 	est/source-e2e.test.js
整份拷进 sourceBox() 的临时目录，当作「别的机器拷来的备份」喂给 --source——
证明识别不依赖把 HOME 伪装成那台机器。

形状（对应方案第 4 节 ⑨ 误报固化）：

- codex-backup/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl —— 唯一应被强匹配识别并解析的块。
- decoys/pnpm-cache/*.jsonl —— 一堆 .jsonl，但不是 sessions/**/rollout-*；
  没有任何 spec 命中，只能进「未识别候选」，绝不归给任何 agent、绝不解析。
- decoys/pgAdmin/sessions/neutral.db —— 有 sessions/ 子目录但不是 Codex rollout；
  同样只进「未识别候选」。文件名特意不叫 `state.db`：那恰好会命中 hermes 的
  单文件探针（`identify()` 单一命中时不校验 dirHints），把一个无关目录绑成 hermes。
  这里要测的是「有 sessions 子目录但无强特征」，不引入额外变量
  （见 `research/upstream/LESSONS.md` 第四轮的已知边界）。
- decoys/empty-agent/ —— 空壳，按 unknown.js 的老规矩不报。

期望的 plan()：bindings 只有 codex 一条；pnpm-cache / pgAdmin 出现在 unmatched，
hint 是「看到 …」句式（只陈述看到什么，不下结论）；empty-agent 不出现。