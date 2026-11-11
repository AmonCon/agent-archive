import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from './platform.js';
import { SKIP_NAMES, NAME_HINT, SESSION_EXT, SESSION_DIRS, SYSTEM_PREFIXES } from './unknown.js';

/**
 * 结构识别：`structureSpec` 声明「我在一个应用根下认什么」，这里负责
 * 「拿一个目录去对这份声明打分」。
 *
 * 这是数据源解耦的地基：**身份只由结构强匹配决定**，不靠名字猜、不靠
 * 本机路径。给一批任意目录（别的机器拷来的备份、导出包）也能识别是哪家。
 *
 * 零 npm 依赖：glob 段匹配自己写，只读 readdir + stat，不解析任何会话内容
 * （唯一的例外是 `contentProbe`，只在 spec 命中之后读文件头 256B 内做同构消歧）。
 */

/**
 * @typedef {object} StructureSpec
 * @property {string} agent
 * @property {Array<{glob?:string, path?:string, kind?:'file'|'dir', weight:number, optional?:boolean}>} probes
 * @property {{from:string, up:number, allowSelf?:boolean}} rootAnchor  // 命中项上溯 N 层 = 应用根
 * @property {string[]} dataPaths    // 相对应用根，交给 discoverWithin
 * @property {string} format
 * @property {number} minScore
 * @property {string[]} [dirHints]   // 应用根首选目录名（同构消歧）
 * @property {{bytes:number, test:(head:string)=>boolean}} [contentProbe]
 * @property {string[]} [deny]
 */

/** `**` 允许跨越的最大段数，对齐 codex.js:176 的 walk 深度上限 8。 */
const GLOB_MAX_DEPTH = 8;

/**
 * 相对路径的 glob 段匹配。
 *
 * - `/` 分段（也把 `\` 归一成 `/`），首尾斜杠忽略
 * - `*` 在**单段内**匹配任意字符，不跨 `/`
 * - `**` 跨 0..8 段
 * - 大小写按 `platform.pathKey`（win32/darwin 折小写、linux 原样）
 * - 只匹配相对应用根的路径，不接绝对路径
 */
export function matchRel(rel, pattern) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean).map(pathKey);
  const pat = String(pattern).replace(/\\/g, '/').split('/').filter(Boolean).map(pathKey);
  return matchFrom(parts, 0, pat, 0);
}

function matchFrom(parts, pi, pat, gi) {
  if (gi === pat.length) return pi === parts.length;
  const p = pat[gi];
  if (p === '**') {
    // k - pi 就是 `**` 吃掉的段数，超过上限就不再展开
    for (let k = pi; k <= parts.length; k++) {
      if (k - pi > GLOB_MAX_DEPTH) break;
      if (matchFrom(parts, k, pat, gi + 1)) return true;
    }
    return false;
  }
  if (pi >= parts.length) return false;
  if (!matchSeg(parts[pi], p)) return false;
  return matchFrom(parts, pi + 1, pat, gi + 1);
}

function matchSeg(seg, p) {
  if (p === '*') return true;
  if (!p.includes('*')) return seg === p;
  // 段内通配：把 `*` 换成 `[^/]*`，其余字符按字面转义
  const re = new RegExp('^' + p.split('*').map(escapeRe).join('[^/]*') + '$');
  return re.test(seg);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 枚举一个目录下的所有条目，返回相对 `/` 路径与是否目录。
 * 用于把 spec 的 probes 逐条去对；深度与条目数都有硬上限，防止一个异常目录拖住识别。
 */
function enumerate(root, maxDepth = GLOB_MAX_DEPTH, maxEntries = 4000) {
  const out = [];
  const walk = (abs, relParts, depth) => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let es;
    try {
      es = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (out.length >= maxEntries) break;
      const full = path.join(abs, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          /* 断链按文件处理 */
        }
      }
      const relParts2 = [...relParts, e.name];
      out.push({ rel: relParts2.join('/'), isDir });
      if (isDir) walk(full, relParts2, depth + 1);
    }
  };
  walk(root, [], 0);
  return out;
}

/**
 * 由候选目录 + spec 算出「应用根」绝对路径。
 *
 * `rootAnchor.from` 是标志性子路径（`sessions` / `projects` / `cli/db/db.sqlite`…），
 * 在 dir 子树里找它（允许任意深度，用双星段前缀匹配），再从命中位置**上溯 up 层**得到应用根。
 * 例如 codex：命中 `sessions`、up=1 → 应用根就是 `sessions` 的父目录（`.codex`）；
 * zcode：命中 `cli/db/db.sqlite`、up=3 → 应用根就是 `.zcode`。
 * 返回 null 表示「这个目录下压根没有该 spec 的标志结构」。
 */
export function anchorOf(dir, spec) {
  const base = path.resolve(dir);
  const ra = spec && spec.rootAnchor;
  if (!ra || !ra.from) return base; // 没写 rootAnchor：候选目录本身就是应用根

  const from = String(ra.from).replace(/\\/g, '/');
  const fromLast = pathKey(from.split('/').filter(Boolean).pop() || from);
  const up = Number.isFinite(ra.up) ? ra.up : 0;
  const entries = enumerate(base);

  // 找最浅的匹配项：'**/<from>' 覆盖嵌套，'<from>' 覆盖恰好在根下的情形
  let best = null;
  for (const e of entries) {
    if (matchRel(e.rel, from) || matchRel(e.rel, `**/${from}`)) {
      if (!best || e.rel.split('/').length < best.split('/').length) best = e.rel;
    }
  }

  // allowSelf：候选目录自己就叫这个名字时，允许「自己就是应用根」
  if (!best && ra.allowSelf && pathKey(path.basename(base)) === fromLast) {
    return base;
  }
  if (!best) return null;

  const segs = best.split('/');
  const cut = Math.max(0, segs.length - up);
  return cut ? path.join(base, ...segs.slice(0, cut)) : base;
}

/**
 * 给一个目录按 spec 打分。
 *
 * 返回 `{ score, evidence, anchor, dirHintMatch }`。`anchor` 是算出的应用根绝对路径，
 * 命中后 plan() 把它作为 `binding.root` 交给 `discoverWithin(roots, ctx)`。
 * 关键：**分数只来自 probes 的强匹配**，启发式信号（collectCandidates）只用来筛候选，
 * 不参与判定身份——pnpm-cache 的 251 个 .jsonl 不会因为「像会话」就被归给某一家。
 */
export function scoreStructure(spec, dir) {
  const empty = { score: 0, evidence: [], anchor: null, dirHintMatch: false };
  if (!spec || !dir) return empty;
  const anchor = anchorOf(dir, spec);
  if (!anchor) return empty;
  const entries = enumerate(anchor);

  // deny：命中任一黑名单直接判 0，避免「目录形状对但其实是别的东西」
  for (const d of spec.deny || []) {
    if (entries.some((e) => matchRel(e.rel, d))) return empty;
  }

  let score = 0;
  const evidence = [];
  for (const probe of spec.probes || []) {
    const pattern = probe.glob || probe.path;
    if (!pattern) continue;
    const hit = entries.find((e) => {
      if (probe.kind === 'file' && e.isDir) return false;
      if (probe.kind === 'dir' && !e.isDir) return false;
      return matchRel(e.rel, pattern);
    });
    if (hit) {
      score += probe.weight;
      evidence.push({ pattern, rel: hit.rel, weight: probe.weight });
    }
    // optional 缺失不扣分；非 optional 缺失也不显式扣分，由 minScore 兜底——
    // 少了关键 probe 分数自然够不到阈值，效果一样但规则更简单。
  }

  const dh = dirHintMatch(spec, anchor);

  // contentProbe 只在「路径结构已经命中」之后用于同构消歧，且只读文件头
  if (spec.contentProbe && score >= spec.minScore) {
    const target = contentTarget(entries, spec, evidence);
    let ok = false;
    if (target) {
      const head = readHead(path.join(anchor, target), spec.contentProbe.bytes || 16);
      try {
        ok = Boolean(spec.contentProbe.test(head));
      } catch {
        ok = false; // 探针抛错退回「歧义」，绝不硬猜
      }
    }
    if (!ok) return { ...empty, anchor, dirHintMatch: dh };
  }

  return { score, evidence, anchor, dirHintMatch: dh };
}

function dirHintMatch(spec, anchor) {
  const b = pathKey(path.basename(anchor));
  return (spec.dirHints || []).some((h) => pathKey(String(h)) === b);
}

/** 内容探针读哪个文件：优先 rootAnchor.from 指向的文件，退到首个命中的文件型 probe。 */
function contentTarget(entries, spec, evidence) {
  const from = spec && spec.rootAnchor && String(spec.rootAnchor.from || '');
  if (from) {
    const f = entries.find((e) => !e.isDir && (matchRel(e.rel, from) || matchRel(e.rel, `**/${from}`)));
    if (f) return f.rel;
  }
  const first = evidence.find((x) => {
    const e = entries.find((y) => y.rel === x.rel);
    return e && !e.isDir;
  });
  return first ? first.rel : null;
}

/** 只读前 n 字节（定点读，不整文件载入），读不到返回空串。 */
function readHead(file, n) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, n));
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString('utf8');
  } catch {
    return '';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 在给定 roots 下收集「值得拿去对 spec 打分」的候选目录。
 *
 * 两阶段、先便宜后贵（复用 unknown.inspect 的思路）：
 *   阶段一只看顶层：有 sessions 类子目录 / 会话形态文件 / 目录名像会话 → 才有信号；
 *   阶段二有信号才深入，统计 files/bytes/sessionDirs/extensions，给一句「看到什么」。
 *
 * 命中信号的目录**不再下钻**，避免把 `.codex/sessions`、`pgAdmin/sessions` 这类子目录
 * 也当成独立候选（噪声）。SKIP_NAMES / SYSTEM_PREFIXES 与可配 excludeNames 控制下钻范围。
 * 返回候选带绝对路径与事实信号，**结论留给 identify()**。
 */
export function collectCandidates(roots, opts = {}) {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 300;
  const exclude = new Set((opts.excludeNames || []).map((s) => String(s).toLowerCase()));
  // spec 的 rootAnchor.from 第一段（sessions / projects / cli…）也是「应用根」的信号：
  // claude 的 projects/ 不在 SESSION_DIRS 里，没有这一条就永远发现不了它的应用根。
  const anchorNames = new Set((opts.anchorNames || []).map((s) => String(s).toLowerCase()));
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  const out = [];
  for (const r of list) walkCandidates(path.resolve(r), 0, maxDepth, maxEntries, exclude, anchorNames, out);
  return out;
}

function walkCandidates(dir, depth, maxDepth, maxEntries, exclude, anchorNames, out) {
  if (depth > maxDepth) return;
  let top;
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  let signal = NAME_HINT.test(path.basename(dir));
  for (const e of top) {
    const childDir = isDirLike(e, path.join(dir, e.name));
    const lower = e.name.toLowerCase();
    if (childDir && (SESSION_DIRS.has(lower) || anchorNames.has(lower))) signal = true;
    else if (!childDir && SESSION_EXT.test(e.name)) signal = true;
  }

  if (signal) {
    const sig = inspectSignals(dir, maxDepth, maxEntries, anchorNames);
    // 光有「名字像」但既无会话文件、也无 sessions 子目录的空壳不报：
    // 与 unknown.js「空目录不算候选」一致，避免噪声淹没未识别清单。
    if (sig.files > 0 || sig.sessionDirs > 0) {
      out.push({ path: dir, name: path.basename(dir), ...sig, hint: describeSeen(sig) });
    }
    return; // 候选项不再下钻，避免嵌套候选
  }

  let budget = maxEntries;
  for (const e of top) {
    if (budget-- <= 0) break;
    const lower = e.name.toLowerCase();
    // anchorNames 是各家 structureSpec 的标志性子目录（projects/tmp/cli/agent…）。
    // 它们对通用扫描是噪声（tmp/cache 等被 SKIP_NAMES 收了），但对某家恰恰是数据载体：
    // 例如 Gemini CLI 的会话就在 ~/.gemini/tmp/<hash>/chats/。跳过它们会让这些家的
    // 应用根永远成不了候选 —— 所以这里与 inspectSignals 都要豁免。
    if (SKIP_NAMES.has(lower) && !anchorNames.has(lower)) continue;
    if (SYSTEM_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (exclude.has(lower)) continue;
    const full = path.join(dir, e.name);
    if (isDirLike(e, full)) walkCandidates(full, depth + 1, maxDepth, maxEntries, exclude, anchorNames, out);
  }
}

/** 跟随符号链接的目录判定（对齐 unknown.js / fsentry.js 的坑）。 */
function isDirLike(e, full) {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 两阶段看一个候选目录，收集「看到了什么」的事实信号。
 * `anchorNames` 是各家 structureSpec 的标志性子目录名，命中 SKIP_NAMES 也要下钻
 * （否则 ~/.gemini/tmp/... 里的会话文件永远统计不到，see 上面 walkCandidates 的注释）。
 */
function inspectSignals(dir, maxDepth, maxEntries, anchorNames = new Set()) {
  let seen = 0;
  let bytes = 0;
  let files = 0;
  let sessionDirs = 0;
  const extensions = new Map();

  const walk = (d, depth) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (seen++ > maxEntries) return;
      const full = path.join(d, e.name);
      if (isDirLike(e, full)) {
        const lower = e.name.toLowerCase();
        if (SKIP_NAMES.has(lower) && !anchorNames.has(lower)) continue;
        if (SESSION_DIRS.has(lower)) sessionDirs++;
        walk(full, depth + 1);
        continue;
      }
      if (!SESSION_EXT.test(e.name)) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      files++;
      bytes += st.size;
      const ext = (e.name.match(/(\.[a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
      extensions.set(ext, (extensions.get(ext) || 0) + 1);
    }
  };
  walk(dir, 0);

  const nameHint = NAME_HINT.test(path.basename(dir));
  return {
    files,
    bytes,
    sessionDirs,
    extensions: [...extensions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([ext, n]) => `${ext}×${n}`),
    looksLikeSessions: sessionDirs > 0 || nameHint,
  };
}

/** 「看到什么」句式：只陈述事实，不下「这是某家 Agent」的结论。 */
function describeSeen(s) {
  const bits = [];
  if (s.sessionDirs) bits.push(`${s.sessionDirs} 个 sessions 类子目录`);
  if (s.files) bits.push(`${s.files} 个会话形态文件`);
  if (s.extensions && s.extensions.length) bits.push(s.extensions.join('、'));
  if (s.bytes) bits.push(`共 ${formatBytes(s.bytes)}`);
  if (!bits.length) bits.push('目录名像会话存储，但没有可识别的会话形态文件');
  return `看到 ${bits.join(' · ')}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
