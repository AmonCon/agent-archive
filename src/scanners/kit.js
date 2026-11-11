/**
 * 扫描器工具箱：数据源解耦后各家 scanner 共用的最小模板。
 *
 * 契约演进的核心规矩：**旧签名一个不改，只新增可选导出/参数**。
 * 每家把自己的本机根函数留作「默认」，新加一个 `discoverWithin(roots, ctx)`，
 * 让 registry 能把「别的机器拷来的备份」的根显式喂进来。
 */

/**
 * 取本轮生效的根：ctx.roots 有值就用它（显式数据源），否则退回本机默认根函数。
 *
 * 用于 `readMessages(session, ctx)` 这类「保留旧无参行为、但要支持外部根」的地方——
 * 外部备份里的文件不在本机默认根下，不换成 ctx.roots 会被 assertUnderAny 误杀。
 *
 * @param {string} name 扫描器名（仅用于诊断，可留空）
 * @param {{roots?:string[]}} [ctx]
 * @param {() => string[]} defaultRootsFn 本机默认根函数（如 codexDirs）
 * @returns {string[]}
 */
export function rootsFor(name, ctx, defaultRootsFn) {
  if (ctx && Array.isArray(ctx.roots) && ctx.roots.length) return ctx.roots;
  return typeof defaultRootsFn === 'function' ? defaultRootsFn() : [];
}

/**
 * `discoverWithin` 的标准写法（模板片段，供各家照抄；scannerTemplate() 也引用它）。
 *
 * 关键点：
 *   1. `discover()` 保留成一行封装，默认根传本机、ctx 传空 → 旧行为一字不改；
 *   2. `discoverWithin(roots, ctx)` 里每个 root 就是 `structureSpec` 算出的**应用根**
 *      （`.codex` / `.claude` / `.zcode`…），直接 walk 它的 dataPaths 子目录；
 *   3. 去重逻辑照旧；
 *   4. ctx 里带 `{ sourceId, origin, roots }`，需要时可用。
 */
export const discoverWithinTemplate = `// 以 codex 为例（其余家同构）
export const structureSpec = {
  agent: 'codex',
  probes: [ /* 相对应用根的 glob/path，权重见方案 2.4 */ ],
  rootAnchor: { from: 'sessions', up: 1 },
  dataPaths: ['sessions', 'archived_sessions'],
  format: 'codex-rollout',
  minScore: 3,
  dirHints: ['.codex'],
};

export function discover() {
  return discoverWithin(myDefaultRoots(), {}); // 旧签名、旧行为一字不改
}

export function discoverWithin(roots, ctx = {}) {
  const all = [];
  for (const root of roots) {
    for (const sub of structureSpec.dataPaths) walk(path.join(root, sub), all, 0);
  }
  return dedupe(all); // 照旧去重
}
`;
