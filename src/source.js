import path from 'node:path';
import crypto from 'node:crypto';
import { pathKey } from './platform.js';
import { collectCandidates, scoreStructure } from './structure.js';
// 延迟读取注册表：source.js 不认识任何一家 scanner，只认「带 structureSpec 的声明」。
// 命名空间导入在模块加载期不访问 scanners（见 defaultSpecs），避免 registry→source→registry
// 的求值环；P1 里每补一家 structureSpec，plan()/identify() 自动看见，无需改本文件。
import * as registry from './registry.js';

/**
 * 数据源（source）抽象。
 *
 * 产品要的是「通用的跨 Agent 会话识别/归一引擎」：给一批数据（任意目录、别机备份、
 * 导出包）→ 识别是哪家 → 按格式解出。本机真实数据只是**测试样本**，不是默认前提。
 *
 * 两条硬不变量：
 *   - `localSource()` 代表「扫本机」，`scanAll` 见到它/没见到 source 时严格走老 `discover()`；
 *   - 身份只由 `structureSpec` 强匹配决定（scoreStructure），启发式只用来筛候选、报 unmatched。
 */

/**
 * @typedef {object} Source
 * @property {'local'|'explicit'} kind
 * @property {string} id          // 稳定短哈希：缓存命名空间 / manifest 用
 * @property {string[]} roots      // 已 path.resolve 的绝对目录（可多个）
 * @property {string|null} label  // 展示名，如「旧机 2026-10」
 * @property {boolean} autoDetect
 * @property {{home?:string, platform?:string, pathStyle?:'win32'|'posix'}|null} origin
 * @property {string} [agent]     // 显式指定归属（--source-agent，P0 之后才接）
 * @property {Array<{agent:string, root:string}>} [bindings]
 */

/** 扫本机：老行为。id 固定 'local'，缓存文件名保持 scan-v5.json。 */
export function localSource() {
  return { kind: 'local', id: 'local', roots: [], label: null, autoDetect: false, origin: null };
}

/**
 * 造一个显式数据源。
 * input 支持 {paths?, roots?, label?, agent?, bindings?, autoDetect?, origin?} 或一个路径字符串。
 * paths/roots 同义，逗号分隔与数组都收；全部 path.resolve 成绝对路径。
 */
export function createSource(input = {}) {
  const obj = typeof input === 'string' ? { paths: [input] } : input || {};
  // paths/roots 同义，也接受 config 里常用的单数 path（方案 2.8 的 sources[].path）。
  const rawList =
    obj.paths != null ? obj.paths : obj.roots != null ? obj.roots : obj.path != null ? obj.path : [];
  const roots = normalizeList(rawList).map((p) => path.resolve(p));
  const src = {
    kind: 'explicit',
    id: '',
    roots,
    label: obj.label != null ? String(obj.label) : null,
    autoDetect: obj.autoDetect !== false,
    origin: obj.origin && typeof obj.origin === 'object' ? { ...obj.origin } : null,
  };
  src.id = sourceId(src);

  // 显式绑定：--source-agent 语义下把根直接交给某家，跳过结构识别。
  if (obj.agent) src.agent = String(obj.agent);
  if (Array.isArray(obj.bindings)) {
    src.bindings = obj.bindings
      .filter((b) => b && b.agent && (b.root || b.path))
      .map((b) => ({ agent: String(b.agent), root: path.resolve(b.root || b.path) }));
  } else if (src.agent) {
    src.bindings = roots.map((r) => ({ agent: src.agent, root: r }));
  } else {
    src.bindings = [];
  }
  return src;
}

/** 稳定短哈希：缓存命名空间 / manifest 用。local 固定 'local' 以复用老缓存文件。 */
export function sourceId(source) {
  if (!source || source.kind === 'local') return 'local';
  const roots = (source.roots || []).map((r) => pathKey(path.resolve(r))).sort();
  const raw = roots.join('\n') + (source.label || '');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** 从配置读 source（老两键 roots/disabled 的语义完全不动，只叠加 sources/defaultSource）。 */
export function sourceFromConfig(cfg, cliOpts = {}) {
  const sources = cfg && Array.isArray(cfg.sources) ? cfg.sources : [];
  const cli = cliOpts || {};
  const cliPaths = normalizeList(cli.sources != null ? cli.sources : cli.source);
  if (cliPaths.length) {
    return createSource({ paths: cliPaths, label: cli.label, origin: cli.origin, agent: cli.agent });
  }
  const def = cfg && cfg.defaultSource;
  if (def && def !== 'local' && def !== 'sources') {
    const hit = sources.find((s) => s && (s.label === def || s.name === def));
    if (hit) return createSource(hit);
  }
  if (def === 'sources' && sources.length) {
    const first = sources[0];
    if (first && typeof first.path === 'string') {
      return createSource({ paths: [first.path], label: first.label, origin: first.origin, agent: first.agent });
    }
  }
  return localSource();
}

/**
 * 汇总一次调用的 source（CLI/config 的入口）。
 * cliSources 可重复/逗号分隔；cliBindings 形如 `<agent>:<dir>` 或 {agent, root}。
 * 没给任何显式来源时退回 localSource()（默认扫本机，向后兼容）。
 */
export function resolveSource({ cliSources = [], cliBindings = [], withLocal = false, config = null } = {}) {
  const paths = normalizeList(cliSources);
  const bindings = (Array.isArray(cliBindings) ? cliBindings : [])
    .map((b) => {
      if (typeof b === 'string') {
        // 裸 Windows 路径 `C:\dir` 里的冒号不是 `<agent>:<dir>` 的分隔符。
        // 先认盘符（含 UNC），否则会把盘符当 Agent 名、把 `\dir` 当路径，
        // 然后因为“没有叫 C 的扫描器”被静默丢弃。
        if (/^[A-Za-z]:[\\/]/.test(b) || /^\\\\/.test(b)) return { root: b };
        const i = b.indexOf(':');
        return i > 0 ? { agent: b.slice(0, i), root: b.slice(i + 1) } : { root: b };
      }
      return b && b.agent ? { agent: b.agent, root: b.root || b.path || b.dir } : null;
    })
    .filter((b) => b && b.root);

  if (!paths.length && !bindings.length) return sourceFromConfig(config, {});

  const allPaths = [...paths, ...bindings.map((b) => b.root)];
  const src = createSource({
    paths: allPaths,
    bindings: bindings.filter((b) => b.agent && b.root),
  });
  // withLocal：显式 source 之外再叠加本机。P0 不接该选项，先保留标记，
  // 真正叠加本机由后续阶段在 scanAll 里处理，不在这里假装支持。
  if (withLocal) src.withLocal = true;
  return src;
}

/** 注册表里所有带 structureSpec 的声明（延迟读，见文件头 import 注释）。 */
function defaultSpecs() {
  const list = registry && Array.isArray(registry.scanners) ? registry.scanners : [];
  return list.filter((s) => s && s.structureSpec).map((s) => s.structureSpec);
}

/**
 * 在一批根里识别是哪家。
 *
 * 返回 { bindings, unmatched, ambiguous }：
 *   - bindings  [{agent, root, score, evidence[]}]，root 是 scoreStructure 算出的应用根
 *   - unmatched [{path, bytes, files, sessionDirs, hint}]，只报「看到什么」，不下结论
 *   - ambiguous [{path, agents[]}]，同构歧义等显式指定，绝不按最高分猜
 *
 * opts.specs 可覆盖默认声明（测试用它造同构歧义）；其余透传给 collectCandidates。
 */
export function identify(roots, opts = {}) {
  const specs = Array.isArray(opts.specs) ? opts.specs : defaultSpecs();
  // 把各家 rootAnchor.from 的第一段交给候选筛选：projects/ / cli/ 这类目录名
  // 不在 unknown.js 的 SESSION_DIRS 里，靠它才能让对应应用根成为候选。
  const anchorNames = [
    ...(opts.anchorNames || []),
    ...specs.map((s) => s && s.rootAnchor && String(s.rootAnchor.from || '').split('/')[0]).filter(Boolean),
  ];
  const candidates = collectCandidates(roots, { ...opts, anchorNames });
  const bindings = [];
  const unmatched = [];
  const ambiguous = [];
  const seen = new Set();

  for (const c of candidates) {
    const hits = [];
    for (const spec of specs) {
      const r = scoreStructure(spec, c.path);
      if (r.anchor && r.score >= (spec.minScore || 0)) hits.push({ spec, r });
    }

    if (hits.length === 0) {
      // 身份只由强匹配决定；没命中就只陈述看到的东西，不归给任何一家、也不解析
      unmatched.push({
        path: c.path,
        bytes: c.bytes,
        files: c.files,
        sessionDirs: c.sessionDirs,
        hint: c.hint,
      });
      continue;
    }

    // >1 命中：先试 dirHints 消歧（唯一命中才采信），否则进 ambiguous 绝不猜
    let chosen = hits;
    if (hits.length > 1) {
      const hinted = hits.filter((h) => h.r.dirHintMatch);
      if (hinted.length === 1) chosen = hinted;
    }
    if (chosen.length > 1) {
      ambiguous.push({ path: c.path, agents: chosen.map((h) => h.spec.agent) });
      continue;
    }

    const { spec, r } = chosen[0];
    const key = `${spec.agent}|${pathKey(r.anchor)}`;
    if (seen.has(key)) continue; // 同一家同一应用根去重（多个候选指向同一处）
    seen.add(key);
    bindings.push({
      agent: spec.agent,
      root: r.anchor,
      score: r.score,
      evidence: r.evidence.map((e) => e.pattern),
    });
  }

  return { bindings, unmatched, ambiguous };
}

/** plan(source)：识别 + 显式绑定覆盖 + sourceId，registry.scanAll 的唯一入口。 */
export function plan(source, opts = {}) {
  const src = typeof source === 'string' ? createSource({ paths: [source] }) : source;
  if (!src || src.kind === 'local') {
    return { bindings: [], unmatched: [], ambiguous: [], sourceId: 'local' };
  }
  const found = identify(src.roots, opts);
  const bindings = [...found.bindings];
  const seen = new Set(bindings.map((b) => `${b.agent}|${pathKey(b.root)}`));
  for (const b of src.bindings || []) {
    if (!b || !b.agent || !b.root) continue;
    const key = `${b.agent}|${pathKey(b.root)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ agent: b.agent, root: b.root, score: Number.POSITIVE_INFINITY, evidence: ['显式指定'] });
  }
  return {
    bindings,
    unmatched: found.unmatched,
    ambiguous: found.ambiguous,
    sourceId: sourceId(src),
  };
}

/** 把「数组 / 逗号分隔字符串」统一成去空白的字符串数组。 */
function normalizeList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}
