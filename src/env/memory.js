/**
 * 记忆与指令文件的跨 Agent 识别。
 *
 * 这一层最容易做错的地方是**合并**。用户的 Hermes `USER.md` 和 Codex
 * `MEMORY.md` 完全可能写着两条相反的偏好——合并成"你的记忆"是在说谎，
 * 而且新 Agent 读到一句被平滑过的结论，比读到两条带出处的矛盾更危险。
 *
 * 所以这里的产出只有三样：**在哪、是什么格式、有多大**。
 * 正文一律按需读，而且默认只给开头。
 *
 * 另一条：记忆里同样会有明文凭证（本机的 ZCode 项目记忆里就有一条
 * `security-plaintext-aliyun-key-in-zcode-config.md`）。这里不主动
 * 搜凭证——那是 `secrets` 命令的活——但**绝不回传全文**，
 * 免得把记忆里的密钥顺带送进某个模型的上下文。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findVersionedDb } from '../sqlite-read.js';

/**
 * 识别目标。
 *
 * kind 分两类，语义完全不同：
 *   instruction — 每次对话都注入的行为约定（AGENTS.md / SOUL.md / GEMINI.md）
 *   memory      — 跨会话积累的事实与偏好（MEMORY.md / 分片 / SQLite 库）
 *
 * 混在一起看会误导：指令是"现在要求你怎么做"，记忆是"过去学到过什么"。
 */
const TARGETS = [
  {
    agent: 'codex',
    kind: 'instruction',
    path: () => path.join(os.homedir(), '.codex', 'AGENTS.md'),
    scope: 'global',
  },
  {
    agent: 'codex',
    kind: 'memory',
    path: () => path.join(os.homedir(), '.codex', 'memories', 'MEMORY.md'),
    scope: 'global',
    // 实测本机 450 KB / 4312 行——绝不整份读
    large: true,
  },
  {
    agent: 'codex',
    kind: 'memory',
    path: () => path.join(os.homedir(), '.codex', 'memories', 'memory_summary.md'),
    scope: 'global',
  },
  {
    agent: 'hermes',
    kind: 'instruction',
    path: () => path.join(os.homedir(), '.hermes', 'SOUL.md'),
    scope: 'global',
  },
  {
    agent: 'hermes',
    kind: 'memory',
    path: () => path.join(os.homedir(), '.hermes', 'memories', 'MEMORY.md'),
    scope: 'global',
  },
  {
    agent: 'hermes',
    kind: 'memory',
    path: () => path.join(os.homedir(), '.hermes', 'memories', 'USER.md'),
    scope: 'global',
  },
  {
    agent: 'gemini',
    kind: 'instruction',
    path: () => path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    scope: 'global',
  },
  {
    agent: 'claude-code',
    kind: 'instruction',
    path: () => path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    scope: 'global',
  },
  {
    agent: 'opencode',
    kind: 'instruction',
    path: () => path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md'),
    scope: 'global',
  },
  {
    agent: 'qoder',
    kind: 'instruction',
    path: () => path.join(os.homedir(), '.qoder', 'memory', 'MEMORY.md'),
    scope: 'global',
  },
];

/** 目录型记忆：一个索引文件 + 若干分片。 */
const DIR_TARGETS = [
  {
    agent: 'qoder',
    kind: 'memory',
    dir: () => path.join(os.homedir(), '.qoder', 'memory'),
    scope: 'global',
    index: 'MEMORY.md',
  },
  {
    agent: 'qoder',
    kind: 'memory',
    dir: () => path.join(os.homedir(), '.qoder', 'memories'),
    scope: 'global',
    index: 'MEMORY.md',
  },
];

/** SQLite 记忆库：只报表与行数，不碰内容。 */
const DB_TARGETS = [
  {
    agent: 'codex',
    kind: 'memory',
    // 文件名带 schema 版本（memories_1.sqlite），上游升版会改数字。
    // 写死会在用户升级后静默少报一份记忆——按前缀取最高版本，见 fsentry 之外
    // 的说明在 sqlite-read.js 的 findVersionedDb()。
    path: () => findVersionedDb(path.join(os.homedir(), '.codex'), 'memories'),
    scope: 'global',
    // 这张表才是真正的记忆实体（155 行 rollout 摘要）
    entries: { table: 'stage1_outputs', label: '会话记忆条目' },
  },
  {
    agent: 'hermes',
    kind: 'memory',
    path: () => path.join(os.homedir(), '.hermes', 'memory_store.db'),
    scope: 'global',
    entries: { table: 'facts', label: '事实条目' },
  },
];

/** 只读文件开头，够判断"写的是什么"就行。 */
const HEAD_BYTES = 400;

function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readHead(p, bytes = HEAD_BYTES) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 从 markdown 里抽"这条记忆叫什么"。
 *
 * 两种写法并存：frontmatter 的 `name:` 和一级标题 `# xxx`。
 * 本机的 Qoder / ZCode 分片用 frontmatter，Hermes 用 `# 标题`。
 */
function titleOf(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const m = fm[1].match(/^name\s*:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  const h = text.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  return null;
}

function describeFile(t) {
  const p = t.path();
  const st = statOf(p);
  if (!st || !st.isFile()) return null;

  const head = readHead(p);
  return {
    agent: t.agent,
    kind: t.kind,
    scope: t.scope,
    format: 'markdown',
    path: p,
    bytes: st.size,
    // 大文件不读正文，只报大小——450 KB 的记忆读进来毫无用处，
    // 真正要看的时候人会自己打开
    topic: t.large ? null : titleOf(head),
    preview: t.large ? null : clip(head.replace(/^---[\s\S]*?---/, '').trim(), 160),
    large: Boolean(t.large) || st.size > 64 * 1024,
  };
}

/**
 * 目录型记忆：识别索引 + 分片。
 *
 * 只统计条数和每条的标题，不读正文——本机 ZCode 最大的项目记忆有
 * 36 个分片，全读进来没有意义。
 */
function describeDir(t) {
  const dir = t.dir();
  const st = statOf(dir);
  if (!st || !st.isDirectory()) return null;

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  if (!files.length) return null;

  const shards = files.filter((f) => f !== t.index);
  const entries = [];

  for (const f of shards.sort()) {
    const full = path.join(dir, f);
    const s = statOf(full);
    if (!s || !s.isFile()) continue;
    const head = readHead(full, 200);
    entries.push({ file: f, topic: titleOf(head), bytes: s.size });
  }

  const idxPath = path.join(dir, t.index);
  const idx = statOf(idxPath);

  return {
    agent: t.agent,
    kind: t.kind,
    scope: t.scope,
    format: 'dir',
    path: dir,
    index: idx ? { file: t.index, bytes: idx.size } : null,
    bytes: entries.reduce((n, e) => n + e.bytes, 0) + (idx ? idx.size : 0),
    // 分片数 = 这个 Agent 积累了多少条记忆
    entries: entries.length,
    topics: entries.map((e) => ({ file: e.file, topic: e.topic, bytes: e.bytes })),
    large: true,
  };
}

/**
 * 项目级记忆：`<agent>/memories/projects/<项目名-哈希>/memory/*.md`。
 *
 * 这是 ZCode 的做法，也是这一层最有价值的部分——它把记忆按项目分开，
 * 正好能对上会话层的项目维度。目录名尾部有 16 位哈希，剥掉就是项目名。
 */
function describeProjectDirs(agent, rootRel) {
  const root = path.join(os.homedir(), ...rootRel.split('/'));
  let projs;
  try {
    projs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  const out = [];
  for (const e of projs) {
    const memDir = path.join(root, e.name, 'memory');
    let files;
    try {
      files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    if (!files.length) continue;

    const entries = [];
    let bytes = 0;
    for (const f of files) {
      const full = path.join(memDir, f);
      const s = statOf(full);
      if (!s || !s.isFile()) continue;
      bytes += s.size;
      if (f === 'MEMORY.md') continue;
      const head = readHead(full, 200);
      entries.push({ file: f, topic: titleOf(head), bytes: s.size });
    }

    out.push({
      agent,
      kind: 'memory',
      // 项目级：会被某个项目的工作触发，不是全局生效
      scope: 'project',
      project: projectFromDirName(e.name),
      format: 'dir',
      path: memDir,
      bytes,
      entries: entries.length,
      topics: entries.map((x) => ({ file: x.file, topic: x.topic, bytes: x.bytes })),
      large: true,
    });
  }

  return out;
}

/**
 * 目录名 → 项目名。
 *
 * ZCode 的两种命名都见过：
 *   `my-app-45481fe065bba8bd`          → 项目名 + 16 位哈希
 *   `1792567885219-005e7fee-8d63-...`      → 时间戳 + 内部 id（临时工作区）
 *   `default-8f875e8a30f92e9f`             → 内部默认库
 *   `draft-a7a9e10e-...`                   → 草稿会话
 *
 * 只有第一种是真实项目名。后三种如果在识别时当成项目，
 * 会让"这个项目有哪些记忆"里混进一堆 `default`、`projects`、时间戳，
 * 比不认出来更糟——用户会以为那些是真的项目。
 *
 * 所以内部前缀先判，再剥哈希。剥完还要过一道形状检查：
 * 纯数字开头的、以及剩下的部分里还带着 UUID 片段的，都不是项目名。
 */
function projectFromDirName(dir) {
  const s = String(dir);

  // 内部目录：先判，别让后面的哈希剥离规则把它们蒙过去
  if (/^(draft|default|in-id|demo-mcp|projects|tmp|workspace)-/i.test(s)) return null;

  const m = s.match(/^(.*)-([0-9a-f]{16})$/i);
  const candidate = m ? m[1] : s;

  // 时间戳前缀（`1792567885219-...`）是 ZCode 为未绑定项目的会话
  // 生成的临时目录，不是项目名
  if (/^\d{10,}-/.test(candidate)) return null;
  if (/^\d+$/.test(candidate)) return null;

  // 剥离后仍是 UUID 形状：内部 id 套了一层，不是项目
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(candidate)) return null;

  return candidate;
}

/**
 * SQLite 记忆库。
 *
 * 不读内容、不读向量（`hrr_vector` 是二进制，读了也没用），
 * 只给"有几个库、每库多少条"。
 *
 * ⚠️ 为什么不直接 `readOnly: true` 打开：
 * 实测过——即使只读打开，SQLite 也会改写同目录的 `-shm` 文件
 * （共享内存索引的 mtime 每次都变）。那是**别的 Agent 的数据目录**，
 * 我们承诺过"不碰任何 Agent 的原始数据"，改写 mtime 也算碰。
 *
 * 做法是 magpie 的 `openCursorStore` 那一套：库有 `-wal` 时，
 * 把 db + -wal 一起复制到自己的临时目录再打开，读完删掉。
 * 代价是几 MB 的拷贝，换来的是真的一个字节都没动别人的目录。
 */
function describeDb(t) {
  const p = t.path();
  if (!statOf(p)) return null;

  let db;
  let cleanup = () => {};
  let tempCopy = false;

  try {
    const opened = openReadOnlyCopy(p);
    db = opened.db;
    cleanup = opened.cleanup;
    tempCopy = opened.copied;
  } catch {
    return {
      agent: t.agent,
      kind: t.kind,
      scope: t.scope,
      format: 'sqlite',
      path: p,
      bytes: 0,
      error: '打不开（可能被占用或版本不支持）',
    };
  }

  try {
    const st = statOf(p);
    let entries = null;
    if (t.entries) {
      try {
        const row = db.prepare(`select count(*) as n from "${t.entries.table}"`).get();
        entries = { label: t.entries.label, count: Number(row.n) };
      } catch {
        /* 表不存在，可能就是没数据 */
      }
    }

    // 顺带列出还有哪些表，方便判断这是不是同一套记忆系统
    let tables = [];
    try {
      tables = db
        .prepare(
          "select name from sqlite_master where type='table' and name not like '%_fts%' and name not like 'sqlite_%'"
        )
        .all()
        .map((r) => r.name);
    } catch {
      /* 忽略 */
    }

    return {
      agent: t.agent,
      kind: t.kind,
      scope: t.scope,
      format: 'sqlite',
      path: p,
      bytes: st ? st.size : 0,
      // 有没有被复制过，说明这个库当时是否有 -wal（有没有别的 Agent 正在写）
      tempCopy,
      entries: entries ? entries.count : null,
      entryLabel: entries ? entries.label : null,
      tables,
      large: true,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    cleanup();
  }
}

/**
 * 打开一个只读副本。
 *
 * 库里没有 `-wal` 时直接只读打开（不会产生 `-shm`，没有副作用）；
 * 有 `-wal` 时说明还有别的进程在用 WAL 模式，直接打开会写 `-shm`，
 * 所以整份复制到自己的临时目录再读。
 *
 * 用 `AGENT_ARCHIVE_HOME` 之外的系统临时目录：这是短命产物，
 * 不该混进工具的状态目录，也不该在失败时留下垃圾。
 */
function openReadOnlyCopy(file) {
  // 判据是 -wal **文件存在**，不是它有内容。
  // 0 字节的 -wal 也意味着这个库处于 WAL 模式——实测打开它照样会
  // 创建/改写 -shm（Hermes 的库就是 0 字节 -wal，第一版按大小判断，
  // 结果漏掉了它）。
  const hasWal = (() => {
    try {
      fs.statSync(`${file}-wal`);
      return true;
    } catch {
      return false;
    }
  })();

  if (!hasWal) {
    return { db: new DatabaseSync(file, { readOnly: true }), cleanup: () => {}, copied: false };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-archive-db-'));
  const copy = path.join(tmpDir, path.basename(file));

  try {
    fs.copyFileSync(file, copy);
    // -wal 是"还没落盘的新数据"，少了它读到的是旧快照，行数会不对。
    // 0 字节的 -wal 也照拷——SQLite 看到它就按 WAL 模式打开副本，
    // 与原件的行为一致。
    try {
      fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    } catch {
      /* 文件已经没了（另一个进程刚 checkpoint 过），按无 WAL 读 */
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    return {
      db,
      cleanup: () => rmTempDir(tmpDir),
      copied: true,
    };
  } catch (e) {
    rmTempDir(tmpDir);
    throw e;
  }
}

function rmTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结果 */
  }
}

/**
 * 扫描本机所有记忆与指令文件。
 *
 * @returns {{items: Array, byAgent: object, totals: object}}
 */
export function scanMemory() {
  const items = [];

  for (const t of TARGETS) {
    const d = describeFile(t);
    if (d) items.push(d);
  }

  for (const t of DIR_TARGETS) {
    const d = describeDir(t);
    if (d) items.push(d);
  }

  for (const t of DB_TARGETS) {
    const d = describeDb(t);
    if (d) items.push(d);
  }

  items.push(...describeProjectDirs('zcode', '.zcode/cli/memories/projects'));

  const byAgent = {};
  for (const it of items) {
    byAgent[it.agent] = byAgent[it.agent] || { files: 0, entries: 0, instruction: 0, memory: 0 };
    byAgent[it.agent].files++;
    byAgent[it.agent].entries += it.entries || 0;
    byAgent[it.agent][it.kind]++;
  }

  return {
    items,
    byAgent,
    totals: {
      locations: items.length,
      // 指令是"现在要求你怎么做"，记忆是"过去学到过什么"——分开计数
      instructions: items.filter((i) => i.kind === 'instruction').length,
      memories: items.filter((i) => i.kind === 'memory').length,
      // 项目级记忆独自一类：它只在特定项目里生效
      projectScoped: items.filter((i) => i.scope === 'project').length,
      entries: items.reduce((n, i) => n + (i.entries || 0), 0),
    },
  };
}

/**
 * 摘要：给 MCP 和体检用。
 *
 * 刻意**不含 preview 和 topics 的正文**——只给"有没有、多大、多少条"。
 * 要读某一份记忆，用 readMemory(path) 显式取。
 */
export function memorySummary() {
  const { items, byAgent, totals } = scanMemory();

  // 项目级记忆按项目聚合。没有可识别项目名的（ZCode 为未绑定项目的
  // 会话生成的临时目录）仍然列出来——数据是真的存在——但归到
  // `unattributed`，不塞进 projects 里冒充项目。
  const named = items.filter((i) => i.scope === 'project' && i.project);
  const unnamed = items.filter((i) => i.scope === 'project' && !i.project);

  return {
    ...totals,
    byAgent,
    projects: [...new Set(named.map((i) => i.project))].sort(),
    // 这些是项目级记忆，但所在目录是临时工作区，认不出对应哪个项目
    unattributed: unnamed.length
      ? { locations: unnamed.length, entries: unnamed.reduce((n, i) => n + (i.entries || 0), 0) }
      : null,
    list: items.map((i) => ({
      agent: i.agent,
      kind: i.kind,
      scope: i.scope,
      format: i.format,
      project: i.project || undefined,
      // 项目级但认不出项目：标出来，让调用方知道这不是"全局记忆"
      projectUnknown: i.scope === 'project' && !i.project ? true : undefined,
      bytes: i.bytes,
      entries: i.entries ?? undefined,
      preview: i.preview || undefined,
      // 不列 path：本机绝对路径对别的 Agent 没意义，
      // 而且用户家目录结构不该随便进模型上下文。要看路径在终端里看。
    })),
  };
}

/**
 * 按路径读一份记忆的开头。
 *
 * 有这个函数是因为"识别"之后人总要能看内容。但：
 *   - 只允许读记忆目标里出现过的路径（防越权读任意文件）
 *   - 默认只给 4000 字
 */
export function readMemory(targetPath, { maxChars = 4000 } = {}) {
  const { items } = scanMemory();
  const known = items.some((i) => i.path === targetPath || (i.path && targetPath.startsWith(i.path)));
  if (!known) {
    throw new Error(`不在已识别的记忆范围内：${targetPath}`);
  }

  const st = statOf(targetPath);
  if (!st) throw new Error('文件不存在');
  if (st.isDirectory()) throw new Error('这是一个记忆目录，请指定里面的具体文件');

  const text = fs.readFileSync(targetPath, 'utf8');
  return {
    path: targetPath,
    totalChars: text.length,
    truncated: text.length > maxChars,
    content: text.slice(0, maxChars),
  };
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export { titleOf, projectFromDirName };
