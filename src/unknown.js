import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tildify } from './model.js';

/**
 * 反向发现：找出"看起来像 Agent 会话存储、但我们没有适配"的目录。
 *
 * ## 为什么需要
 *
 * 这个工具要装到所有人的机器上。用户装的 Agent 里一定有我们没听说过的那几个——
 * 那时原来的行为是**什么都不说**：列表里没有，doctor 也不提，用户会以为
 * "这个工具不支持我的 Agent"，然后卸载。
 *
 * 更糟的是我们自己也看不见这个缺口：没有反馈渠道，就不知道该补哪一家。
 *
 * 所以这里做的是**从数据形状反推**，不依赖已知名单：扫描常见位置，找那些
 * 含 `*.jsonl` / `*.sqlite` / `sessions/` 之类特征、但不在我们已知根目录下的
 * 目录，列出来让人判断。
 *
 * ## 边界（必须诚实）
 *
 * 这是启发式，会误报也会漏报：
 *   - 误报：某些工具确实用 jsonl 存别的东西（编辑器历史、日志）
 *   - 漏报：加密的、改了扩展名的、藏在非常规位置的，扫不到
 *
 * 所以输出里只给"看到什么"，**不给结论**——不写"这是一个 Agent 会话库"，
 * 只写"这里有 3 个 .jsonl、共 2.1 MB、含 sessions 子目录"。
 *
 * ## 只读且有限
 *
 * 只 readdir + stat，不打开任何文件、不解析内容。遍历有硬上限（深度、条目数），
 * 因为它会在用户机器上跑，不能因为某个目录特别大就卡住。
 */

/**
 * 会话存储的典型子目录名。命中一个就说明"这里像会话存储"。
 */
const SESSION_DIRS = new Set([
  'sessions',
  'session',
  'threads',
  'thread',
  'conversations',
  'conversation',
  'chats',
  'chat',
  'history',
  'transcripts',
  'transcript',
  'messages',
]);

/**
 * 目录名本身像会话存储的词。
 *
 * 这条是**入选的必要条件之一**（另一个是含 sessions 类子目录）。
 * 为什么不能只看"有没有 .jsonl"：本机实测那样会把 `pnpm-cache`（251 个 .jsonl）
 * 和 `pgAdmin`（一个 .db）都报成"疑似会话存储"——包管理器缓存和数据库工具
 * 跟 Agent 无关，报出来只会让人不再信任这个列表。
 */
const NAME_HINT = /session|chat|convers|thread|history|transcript|agent|assistant|prompt/i;

/** 会话存储的典型文件后缀。 */
const SESSION_EXT = /\.(jsonl|jsonl\.zst|jsonl\.zstd|zst|zstd|sqlite|sqlite3|db|vscdb)$/i;

/** 明显不是会话存储的目录名，跳过以免噪声淹没结果。 */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  'cache',
  'caches',
  'logs',
  'log',
  'tmp',
  'temp',
  'crashpad',
  'gpucache',
  'blob_storage',
  'dawncache',
  'dawn_graphitecache',
  'service worker',
  'extensions',
  'resources',
  'locales',
]);

/**
 * 扫一遍本机，返回可疑但未适配的会话存储候选。
 *
 * @param {object} opts
 * @param {Set<string>} [opts.knownPaths] 已知（已适配）的根目录，用于排除
 * @param {string} [opts.home]
 * @param {string} [opts.platform]
 * @param {object} [opts.env]
 * @param {number} [opts.maxDepth] 每个候选内部向下看几层（默认 3）
 * @param {number} [opts.maxEntries] 单个候选最多看多少个目录项（默认 500）
 * @param {number} [opts.limit] 最多返回多少条（默认 12）
 */
export function scanUnknownStores(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const known = opts.knownPaths instanceof Set ? opts.knownPaths : new Set();
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 300;
  const limit = opts.limit ?? 12;

  const roots = scanRoots(home, platform, env);
  const candidates = [];

  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (!isDir(e, full)) continue;
      if (SKIP_NAMES.has(e.name.toLowerCase())) continue;
      if (isKnown(full, known) || isKnown(full, exclude)) continue;
      // 不要报"某个扫描根的上级"：~/.local 本身不该是候选，
      // 我们要的是它下面具体的应用目录
      if (roots.some((r) => normPath(r).startsWith(normPath(full) + '/'))) continue;

      const signals = inspect(full, { maxDepth, maxEntries });
      // 空目录不算候选：本机有 `.lody`、`AppData/Roaming/ZCode` 这种
      // 只有骨架没数据的，列出来只是噪声
      if (!signals.looksLikeSessions || !signals.files) continue;
      candidates.push({ path: full, name: e.name, ...signals });
    }
  }

  // 排序：先看特征强弱，再看体量。体量小的多半是配置目录，排后面。
  candidates.sort((a, b) => b.score - a.score || b.bytes - a.bytes);
  return candidates.slice(0, limit).map((c) => ({
    path: tildify(c.path),
    name: c.name,
    bytes: c.bytes,
    files: c.files,
    sessionDirs: c.sessionDirs,
    extensions: c.extensions,
    hint: hintOf(c),
  }));
}

/**
 * 从"已发现的可读文件"推出每个应用的锚点目录。
 *
 * ## 为什么不直接用 doctor 的已知名单
 *
 * `detectGaps()` 列的是**数据文件**（`state.vscdb`、`workspaceStorage`），
 * 而反向发现扫的是**应用根目录**（`AppData/Roaming/Cursor`）。两者粒度不同，
 * 拿前者排除后者会漏掉一大片——本机实测会把 `AppData/Roaming/Cursor`、
 * `QoderCN`、`DeepSeekHarness` 全报成"未适配"，而它们其实都是已适配的。
 *
 * 所以从扫描结果反推：每个已发现文件的**应用根那一层**，就是"我们认识的地方"。
 * 判定规则按扫描根的类型分：
 *
 *   家目录根   `~/.codex/sessions/...`        → 锚点是 `~/.codex`（点文件即应用目录）
 *              `~/AppData/Roaming/X/...`      → 锚点是 `~/AppData/Roaming/X`（应用数据约定）
 *   其它根     `<root>/<第一段>`              → 锚点是 `<root>/<第一段>`
 *
 * @param {string[]} sources 已发现会话的 source 路径（不是 source 描述串）
 */
export function anchorsFromSources(sources, opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const roots = scanRoots(home, platform, env);
  // 应用数据根下"应用名就是第一段"；家目录根要特殊判断
  const appDataRoots = new Set(
    roots.filter((r) => normPath(r) !== normPath(home)).map((r) => normPath(r))
  );

  const out = new Set();
  for (const src of sources || []) {
    if (!src || typeof src !== 'string') continue;
    // source 可能是 `path#id` 或 `a|b` 的多段形态
    for (const one of src.split('|')) {
      const p = one.split('#')[0];
      if (!p) continue;
      const anchor = anchorOf(p, home, roots, appDataRoots, platform);
      if (anchor) out.add(anchor);
    }
  }
  return out;
}

/** 家目录下这些不是应用目录，不该成为"已适配"的锚点。 */
const USER_DIRS = new Set([
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos',
  'public',
  'onedrive',
  'appdata',
  'library',
  'applications',
  'node_modules',
]);

function anchorOf(file, home, roots, appDataRoots, platform = process.platform) {
  // 按路径段比较，不按字符串长度切片。
  //
  // 原来的写法用 `file.slice(path.resolve(r).length)`，在 Windows 上会把
  // 正斜杠和反斜杠混起来算，长度对不上就切错；换成"两边都规范成 / 再逐段比"
  // 就没有这个问题，而且顺带能处理 `\\?\` 之类的前缀差异。
  const fold = platform === 'win32' || platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
  const split = (p) => String(p).replace(/\\/g, '/').split('/').filter(Boolean);

  const fparts = split(file);
  // **优先匹配最深的根**：macOS 上 `~/Library/Application Support` 既是
  // 家目录的子路径、又是自己的扫描根；先匹配家目录会把第一段当成 `Library`
  // 而它属于用户目录名单，于是永远落不到"按应用名下锚"那条路上。
  const ordered = [...roots].sort((a, b) => split(b).length - split(a).length);
  for (const r of ordered) {
    const rparts = split(r);
    if (fparts.length <= rparts.length) continue;
    let match = true;
    for (let i = 0; i < rparts.length; i++) {
      if (fold(fparts[i]) !== fold(rparts[i])) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const first = fparts[rparts.length];
    if (!first) return null;
    if (appDataRoots.has(normPath(r))) return path.join(r, first);
    // 家目录根：点目录就是应用目录；非点目录只排除明确的用户目录
    // （有些 Agent 不用点文件，比如 DeepSeek Harness 的 ~/DeepSeekHarness）
    if (first.startsWith('.')) return path.join(r, first);
    if (USER_DIRS.has(first.toLowerCase())) return null;
    return path.join(r, first);
  }
  return null;
}

/**
 * 要扫的根目录。
 *
 * 覆盖三类"应用会把数据放这里"的约定：
 *   家目录点文件（~/.xxx）——大多数 CLI Agent
 *   应用数据目录（macOS Application Support / Windows AppData / XDG .config）
 *   本地数据目录（XDG .local/share）——SQLite 类应用
 */
function scanRoots(home, platform, env) {
  const roots = [home];
  if (platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support'));
  } else if (platform === 'win32') {
    if (env.APPDATA) roots.push(env.APPDATA);
    if (env.LOCALAPPDATA) roots.push(env.LOCALAPPDATA);
  }
  roots.push(path.join(home, '.config'));
  roots.push(path.join(home, '.local', 'share'));
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 跟随符号链接的目录判定（见 fsentry.js 里记的那个坑）。 */
function isDir(dirent, full) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/** 路径是否已在我们已知（已适配）的根之下。 */
function isKnown(full, known) {
  const norm = normPath(full);
  for (const k of known) {
    const kn = normPath(k);
    if (norm === kn || norm.startsWith(kn + '/')) return true;
  }
  return false;
}

function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 看一个目录，收集"像会话存储"的信号。
 *
 * ## 两阶段，先便宜后贵
 *
 * 第一版直接递归，在本机跑了 **8.2 秒**——`~/AppData/Roaming` 下有上百个应用，
 * 每个都往下走三层，代价全花在明显无关的目录上（浏览器缓存、GPU 缓存……）。
 *
 * 现在先只看**顶层**：如果顶层既没有 sessions 类子目录、也没有会话形态的文件、
 * 目录名也不像，就直接判定"不是"并返回。真正需要深看的只有很少几个，
 * 这一步把耗时降了一个量级。
 */
function inspect(dir, { maxDepth, maxEntries }) {
  let entriesSeen = 0;
  let bytes = 0;
  let files = 0;
  let sessionDirs = 0;
  const extensions = new Map();

  const nameHint = NAME_HINT.test(path.basename(dir));

  // ---- 阶段一：只看顶层 ----
  let top;
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { score: 0, bytes: 0, files: 0, sessionDirs: 0, extensions: [], looksLikeSessions: false };
  }

  let topSignal = nameHint;
  for (const e of top) {
    if (SESSION_DIRS.has(e.name.toLowerCase())) {
      topSignal = true;
      break;
    }
    if (!e.isDirectory() && SESSION_EXT.test(e.name)) {
      topSignal = true;
      break;
    }
  }
  if (!topSignal) {
    return { score: 0, bytes: 0, files: 0, sessionDirs: 0, extensions: [], looksLikeSessions: false };
  }

  // ---- 阶段二：有信号才深入 ----
  const walk = (d, depth) => {
    if (depth > maxDepth || entriesSeen > maxEntries) return;
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (entriesSeen++ > maxEntries) return;
      const full = path.join(d, e.name);
      if (isDir(e, full)) {
        if (SKIP_NAMES.has(e.name.toLowerCase())) continue;
        if (SESSION_DIRS.has(e.name.toLowerCase())) sessionDirs++;
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

  const looksLikeSessions = sessionDirs > 0 || nameHint;

  const score =
    (sessionDirs > 0 ? 6 : 0) +
    (extensions.get('.jsonl') ? 5 : 0) +
    (extensions.get('.vscdb') ? 4 : 0) +
    (extensions.get('.sqlite') || extensions.get('.db') ? 3 : 0) +
    (nameHint ? 2 : 0) +
    (bytes > 1024 * 1024 ? 2 : bytes > 64 * 1024 ? 1 : 0);

  return {
    score,
    bytes,
    files,
    sessionDirs,
    extensions: [...extensions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([ext, n]) => `${ext}×${n}`),
    looksLikeSessions,
  };
}

/** 给候选一句"我看到什么"，**不给结论**。 */
function hintOf(c) {
  const bits = [];
  if (c.sessionDirs) bits.push(`${c.sessionDirs} 个 sessions 类子目录`);
  if (c.files) bits.push(`${c.files} 个会话形态文件`);
  if (!bits.length) bits.push('目录名像会话存储');
  return bits.join(' · ');
}

/**
 * 把 doctor 的已知路径摊平成 Set，供排除用。
 *
 * @param {Array<{paths: Array<{p?: string}>}>} gaps detectGaps() 的输出
 * @param {string} [home] 家目录（用来展开 ~ 写法）
 */
export function knownPathsFromGaps(gaps, home = os.homedir()) {
  const out = new Set();
  for (const g of gaps || []) {
    for (const t of g.paths || []) {
      if (!t || !t.p) continue;
      out.add(String(t.p).replace(/^~/, home));
    }
  }
  return out;
}
