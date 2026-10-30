/**
 * 技能（SKILL.md 目录）的跨 Agent 识别。
 *
 * 本机实测：至少 366 处技能安装，其中 `~/.agents/skills` 的 72 个至少还有
 * 四份副本（Claude / Codex / Qoder / Hermes 各自一份目录）。同一个技能
 * 在五个地方装着，只按目录名认会把列表撑爆，所以身份按**内容哈希**算，
 * 名字只作为"别名"。
 *
 * 为什么用内容而不是名字：
 *   - 名字会改（`design-taste-frontend` / `design-taste-frontend-v1` 是两代）
 *   - 同名不同内容真的存在（ZCode 插件缓存里同一个技能有 0.1.1 / 0.1.4 两版）
 *   - 用户真正关心的是"我有哪些能力"，不是"某家目录里有几个文件夹"
 *
 * 只读，而且**只读元数据**（name / description / 版本 / 哈希），
 * 正文不进输出——技能正文动辄几十 KB，一次全量返回会撑爆上下文。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { userDataCandidates } from '../platform.js';
import { statePath } from '../paths.js';

/**
 * 各 Agent 的技能目录。
 *
 * depth 是往下找 SKILL.md 的层数：`~/.hermes/skills/<分类>/<技能>/SKILL.md`
 * 是两层，ZCode 插件缓存 `cache/<marketplace>/<plugin>/<version>/skills/<技能>/SKILL.md`
 * 深得多。给得太浅会漏，太深会把 node_modules 里的东西扫进来。
 */
const ROOTS = [
  {
    agent: 'claude-code',
    dirs: () => [path.join(os.homedir(), '.claude', 'skills')],
    depth: 2,
  },
  {
    // 跨 Agent 的公共技能目录：Claude / Codex / Qoder / Kiro 都会读这里
    agent: 'shared-agents',
    shared: true,
    dirs: () => [path.join(os.homedir(), '.agents', 'skills')],
    depth: 2,
  },
  {
    agent: 'codex',
    dirs: () => [path.join(os.homedir(), '.codex', 'skills')],
    depth: 3,
  },
  {
    agent: 'zcode',
    dirs: () => [path.join(os.homedir(), '.zcode', 'cli', 'plugins', 'cache')],
    // 插件缓存按 `<插件>/<版本>/skills/<技能>` 组织，升级后旧版本不删。
    // 本机实测 122 个安装只对应 57 个不同技能——`docx` 有 8 份
    // （0.1.0 一路到 0.2.1）、`pdf` 8 份、`computer-use` 6 份。
    //
    // 这不是"装了 8 个不同技能"，是"同一个技能留了 8 个历史版本"。
    // 所以这个根要按 (技能名, 插件) 只保留**版本最高**的那一份：
    // 缓存目录里的版本号就是权威，新的覆盖旧的。
    depth: 6,
    latestOnly: true,
    // 从路径里读版本号：.../browser-use/0.4.2/skills/control-browser
    versionOf: (dir) => {
      const m = String(dir).replace(/\\/g, '/').match(/\/(\d+\.\d+\.\d+(?:-[\w.]+)?)\//);
      return m ? m[1] : null;
    },
  },
  {
    agent: 'qoder',
    dirs: () => [path.join(os.homedir(), '.qoder', 'skills')],
    depth: 3,
  },
  {
    agent: 'hermes',
    dirs: () => [path.join(os.homedir(), '.hermes', 'skills')],
    depth: 3,
  },
  {
    agent: 'kiro',
    dirs: () => [path.join(os.homedir(), '.kiro', 'skills')],
    depth: 3,
  },
  {
    agent: 'cursor',
    dirs: () => [path.join(os.homedir(), '.cursor', 'skills-cursor')],
    depth: 2,
  },
  {
    agent: 'opencode',
    dirs: () => [
      path.join(os.homedir(), '.config', 'opencode', 'skills'),
      ...userDataCandidates('opencode').map((r) => path.join(r, 'skills')),
    ],
    depth: 2,
  },
  {
    // Gemini / Antigravity 的技能目录
    agent: 'gemini',
    dirs: () => [path.join(os.homedir(), '.gemini', 'config', 'skills')],
    depth: 2,
  },
];

/** 目录里最大的 SKILL.md 也不会超过这个尺寸，超过就不读了。 */
const MAX_SKILL_BYTES = 512 * 1024;

/**
 * 找某个根目录下的所有技能目录（含 SKILL.md 的那一层）。
 *
 * 一旦在某一层发现 SKILL.md 就停止下探——技能目录里可能有子目录
 * （references/、scripts/），它们不是独立技能。
 *
 * **必须跟随符号链接。** 本机实测 Qoder 的 3 个、Kiro 的 28 个技能
 * 全是指向 `~/.agents/skills/<name>` 的链接，用 Dirent.isDirectory()
 * 判断会把它们全部漏掉，而且漏得静默——显示"0 个技能"而不是报错。
 * 这正是"用链接共享技能"的典型做法，也是跨 Agent 识别的主战场。
 *
 * 用 lstat + stat 区分"链接"和"真目录"：链接不参与环路保护判断，
 * 真目录才记录已访问路径。环路只在真目录链上才可能形成。
 */
function findSkillDirs(root, maxDepth) {
  const out = [];
  const visitedReal = new Set();
  const MAX_VISITS = 5000;

  const walk = (dir, lvl) => {
    if (lvl > maxDepth) return;
    if (visitedReal.size > MAX_VISITS) return;

    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (ents.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(dir);
      return;
    }
    // SKILL.md 也可能本身是个链接（少见但可能）
    for (const e of ents) {
      if (e.name !== 'SKILL.md') continue;
      try {
        if (fs.statSync(path.join(dir, e.name)).isFile()) {
          out.push(dir);
          return;
        }
      } catch {
        /* 断链 */
      }
    }

    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;

      // 符号链接：直接 stat 目标，看是文件还是目录。
      // 链接才需要真实的环路保护——它可能指回自己的祖先。
      if (e.isSymbolicLink()) {
        const full = path.join(dir, e.name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // 断链，跳过
        }
        if (st.isFile() && e.name === 'SKILL.md') continue; // 已在上面处理
        if (st.isDirectory()) {
          let real;
          try {
            real = fs.realpathSync(full);
          } catch {
            continue;
          }
          // 已经沿这条真实路径走过，说明成环
          if (visitedReal.has(real)) continue;
          visitedReal.add(real);
          walk(full, lvl + 1);
        }
        continue;
      }

      if (!e.isDirectory()) continue;

      // 真目录不可能成环（没有链接就没有回边），所以这里**不调
      // realpathSync**。Windows 上每次 realpath 要 1-2ms，ZCode 插件
      // 缓存有 700 多个目录，光这一步就是 1.2 秒——实测整个技能扫描
      // 3.2 秒里有 1.2 秒花在这里，而它防的是一个不存在的风险。
      walk(path.join(dir, e.name), lvl + 1);
    }
  };

  // 根目录本身可能是链接：这一步需要真实的绝对路径
  try {
    visitedReal.add(fs.realpathSync(root));
  } catch {
    return out;
  }

  walk(root, 0);
  return out;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 只取 name / description / version / license 这几个标量字段。
 * 技能 frontmatter 里偶尔会有嵌套（metadata.author / homepage），
 * 我们不进去——这里要的是"这个技能是什么"，不是它的全部元数据。
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};

  const out = {};
  const lines = m[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 只处理顶层标量：`key: value`
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;

    const [, key, rawVal] = kv;
    if (!['name', 'description', 'version', 'license', 'author'].includes(key)) continue;

    let val = rawVal.trim();

    // 折叠块标量：`description: >` 或 `|`，值在后面的缩进行
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!/^\s+\S/.test(l) && l.trim() !== '') break;
        buf.push(l.trim());
        i = j;
      }
      out[key] = buf.join(' ').trim();
      continue;
    }

    out[key] = unquoteYaml(val);
  }

  return out;
}

function unquoteYaml(s) {
  const t = String(s).trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(t)) {
    let inner = t.slice(1, -1);
    // 只处理最常见的两个转义，够用
    inner = inner.replace(/\\"/g, '"').replace(/\\n/g, ' ');
    return inner;
  }
  return t;
}

/**
 * 解析缓存。
 *
 * 键是 SKILL.md 的路径，命中条件是 (mtime, size) 都没变——与会话层
 * `registry.js` 的 FileParseCache 同一策略。理由也一样：技能不会天天变，
 * 而 435 个文件读 + 哈希要 1.5 秒，MCP 常驻进程每来一次 inventory
 * 调用都付一遍这个成本。
 *
 * 缓存放在用户目录而不是项目里：这是运行态数据，不该污染被读的项目。
 * 写不进去不影响正确性，只是下次慢一点。
 */
const CACHE_VERSION = 1;

function cacheFile() {
  return statePath('cache', `skills-v${CACHE_VERSION}.json`);
}

let memCache = null;

function loadCache() {
  if (memCache) return memCache;
  try {
    memCache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    memCache = {};
  }
  return memCache;
}

let cacheDirty = false;

export function saveSkillCache() {
  if (!cacheDirty) return;
  try {
    const dir = path.dirname(cacheFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(loadCache()), 'utf8');
    cacheDirty = false;
  } catch {
    /* 写不进去不影响正确性 */
  }
}

/** 测试用：丢掉内存缓存，强制重建。 */
export function clearSkillCache() {
  memCache = null;
  cacheDirty = false;
}

/**
 * 读一个技能目录的元数据。
 *
 * 只读一次 SKILL.md：正文和哈希都从同一个 buffer 出。
 * 第一版分两个函数、各读一遍，等于每个技能多一次 IO（435 个就是
 * 435 次多余读 + 435 次多余 stat）。
 */
function readSkill(dir, agent, viaSymlink = false) {
  const file = path.join(dir, 'SKILL.md');

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (st.size > MAX_SKILL_BYTES) return null;

  const cache = loadCache();
  const hit = cache[file];
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { ...hit.value, agent, viaSymlink };
  }

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }

  const text = buf.toString('utf8');
  const fm = parseFrontmatter(text);
  const dirName = path.basename(dir);
  const name = fm.name || dirName;

  // 符号链接和它的目标要能对上，否则同一个技能在共享目录和 Kiro
  // 目录里会被当成两份不同来源
  let realPath = dir;
  try {
    realPath = fs.realpathSync(dir);
  } catch {
    /* 保持原样 */
  }

  const value = {
    name,
    dirName,
    description: fm.description || '',
    version: fm.version || null,
    hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    path: dir,
    realPath,
    bytes: st.size,
  };

  cache[file] = { mtimeMs: st.mtimeMs, size: st.size, value };
  cacheDirty = true;

  return { ...value, agent, viaSymlink };
}

/**
 * 扫描本机所有技能。
 *
 * @returns {{installs: Array, roots: Array, errors: Array}}
 */
export function scanSkills() {
  const installs = [];
  const roots = [];
  const seenPaths = new Set();

  for (const src of ROOTS) {
    let dirs;
    try {
      dirs = src.dirs();
    } catch {
      continue;
    }

    for (const root of dirs) {
      if (!root || seenPaths.has(root)) continue;
      seenPaths.add(root);

      let st;
      try {
        st = fs.statSync(root);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      const found = findSkillDirs(root, src.depth);
      roots.push({ agent: src.agent, root, found: found.length, shared: Boolean(src.shared) });

      // 只保留最新版本的根（插件缓存这类按版本堆积的目录）：
      // 同一个技能名在同一插件下可能留了七八个历史版本，
      // 那些是缓存残留，不是"装了七八个技能"。
      const keep = src.latestOnly ? keepLatest(found, src.versionOf) : found;
      const dropped = found.length - keep.length;
      if (dropped > 0) {
        const r = roots[roots.length - 1];
        r.superseded = dropped;
        r.kept = keep.length;
      }

      for (const dir of keep) {
        // 这个技能目录本身是不是从别处链过来的
        let viaSymlink = false;
        try {
          viaSymlink = fs.lstatSync(dir).isSymbolicLink();
        } catch {
          /* 保持 false */
        }
        const s = readSkill(dir, src.agent, viaSymlink);
        if (s) installs.push(s);
      }
    }
  }

  saveSkillCache();
  return { installs, roots, errors: [] };
}

/**
 * 同一插件同一技能名只留版本最高的一份。
 *
 * 分组键是"插件目录名 + 技能目录名"：`browser-use` 的 `control-browser`
 * 和 `computer-use` 的 `computer-use` 是不同插件，不能合并。
 * 版本号从路径里读；读不到版本的（没有版本段的目录）原样保留，
 * 因为无法判断谁新谁旧，宁可多报一个也不猜。
 */
function keepLatest(dirs, versionOf) {
  const best = new Map();
  const noVersion = [];

  for (const dir of dirs) {
    const ver = versionOf ? versionOf(dir) : null;
    if (!ver) {
      noVersion.push(dir);
      continue;
    }
    // 插件名取版本号上一级目录
    const norm = String(dir).replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/' + ver + '/');
    const plugin = idx >= 0 ? norm.slice(0, idx).split('/').pop() : '';
    const skill = norm.split('/').pop();
    const key = `${plugin}/${skill}`;

    const prev = best.get(key);
    if (!prev || compareVersion(ver, prev.version) > 0) {
      best.set(key, { dir, version: ver });
    }
  }

  return [...[...best.values()].map((x) => x.dir), ...noVersion];
}

/** 语义化版本比较，只处理数字段。 */
function compareVersion(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 按内容哈希聚合：同一份技能装在几个地方算一个能力。
 *
 * 哈希缺失（文件读不到 / 太大）的那些单独按名字归，标记 `hashMissing`。
 */
export function groupByHash(installs) {
  const map = new Map();

  for (const s of installs) {
    const key = s.hash ? `h:${s.hash}` : `n:${s.name}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        name: s.name,
        description: s.description,
        hash: s.hash || null,
        versions: new Set(),
        agents: new Set(),
        names: new Set(),
        dirNames: new Set(),
        locations: [],
        bytes: s.bytes,
        hashMissing: !s.hash,
      };
      map.set(key, g);
    }

    if (s.description && s.description.length > (g.description || '').length) {
      g.description = s.description;
    }
    if (s.version) g.versions.add(s.version);
    g.agents.add(s.agent);
    g.names.add(s.name);
    if (s.dirName) g.dirNames.add(s.dirName);
    g.locations.push({
      agent: s.agent,
      path: s.path,
      // 链接到共享目录 vs 真装了一份副本。前者不占空间、
      // 改一处全生效；后者要各自同步，容易漂。
      symlink: s.viaSymlink,
    });
  }

  const out = [];
  for (const g of map.values()) {
    out.push({
      name: g.name,
      // 同一个技能在不同 Agent 里可能装成不同**目录名**（frontmatter 的
      // name 一样，目录却叫 alpha-copy）。这些才是真正需要展示的别名：
      // 按名字认会把它当成两个技能。
      //
      // 注意不是按 frontmatter 的 name 收集——哈希覆盖整份 SKILL.md，
      // 同名不同内容必然不同哈希，所以同一个哈希组里不可能有第二个 name。
      // 那个字段曾经是死代码。
      aliases: [...g.dirNames].filter((n) => n !== g.name).sort(),
      description: g.description,
      hash: g.hash,
      hashMissing: g.hashMissing,
      versions: [...g.versions].sort(),
      agents: [...g.agents].sort(),
      // 装了几处。同一份技能在 5 个 Agent 目录里 = 5 处
      installs: g.locations.length,
      // 其中有多少是符号链接。全是链接说明只维护了一份，
      // 这是最好的状态；有真有假说明有人手工复制过，会漂。
      symlinked: g.locations.filter((l) => l.symlink).length,
      locations: g.locations,
    });
  }

  return out.sort((a, b) => b.agents.length - a.agents.length || a.name.localeCompare(b.name));
}

/**
 * 技能摘要。
 *
 * 刻意不返回 description 全文（有些技能描述长达两千字）——
 * 这里给的是清单，深看某个技能要显式按名字取。
 */
export function skillSummary({ includeLocations = false } = {}) {
  const { installs, roots } = scanSkills();
  const groups = groupByHash(installs);

  return {
    installs: installs.length,
    skills: groups.length,
    // "只装在一家"和"多家共享"是两种状态：前者说明还没推广，
    // 后者才是这台机器的真实能力面
    shared: groups.filter((g) => g.agents.length > 1).length,
    single: groups.filter((g) => g.agents.length === 1).length,
    roots: roots.filter((r) => r.found > 0),
    byAgent: countBy(installs, (s) => s.agent),
    list: groups.map((g) => ({
      name: g.name,
      agents: g.agents,
      installs: g.installs,
      description: clip(g.description, 200),
      aliases: g.aliases.length ? g.aliases : undefined,
      versions: g.versions.length > 1 ? g.versions : undefined,
      locations: includeLocations ? g.locations : undefined,
    })),
  };
}

function countBy(list, keyFn) {
  const out = {};
  for (const x of list) {
    const k = keyFn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export { parseFrontmatter, findSkillDirs };
