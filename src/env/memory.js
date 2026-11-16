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
 * 另一条：记忆里同样会有明文凭证（实测的 ZCode 项目记忆里就有一条
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
    // 实测 450 KB / 4312 行——绝不整份读
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
/** frontmatter 完整校验的上限：正常 frontmatter 只有几十行，超过这个长度本身就是坏的。 */
const FRONTMATTER_BYTES = 64 * 1024;

/**
 * stat 的失败不是一回事：
 *   ENOENT / ENOTDIR → 路径确实不存在（missing，正常状态）
 *   其余（EACCES / EPERM / EIO / ELOOP…）→ 存在但读不到（unreadable，未知）
 *
 * 把前者当"没有"是对的，把后者当"没有"就会让用户以为这份记忆不存在——
 * 在体检工具里，这是最坏的一种假阴性。
 */
function statResult(p) {
  try {
    return { stat: fs.statSync(p) };
  } catch (e) {
    return { error: e };
  }
}

function statusForError(e) {
  const code = e && e.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
}

function errorText(prefix, e) {
  const code = e && e.code ? e.code : '';
  const msg = e && e.message ? e.message : String(e);
  return code ? `${prefix}：${code}` : `${prefix}：${msg}`;
}

/**
 * 读文件开头。
 *
 * 与旧 readHead 的区别：失败时不是返回空串——空串会把"读不到"伪装成
 * "空文件"。这里保留错误，交给调用方决定记 unreadable 还是 unparsable。
 */
function readHeadResult(p, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return { ok: true, text: buf.subarray(0, n).toString('utf8'), bytesRead: n };
  } catch (e) {
    return { ok: false, error: e };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关闭失败不影响已经读到的内容 */
      }
    }
  }
}

/**
 * 校验 frontmatter 的**形状**，不做完整 YAML 解析。
 *
 * 记忆文件实际只有两类：`---` 包裹的 `key: value`，或者没有 frontmatter
 * 直接以 `# 标题` 开头（Hermes 就是这样）。这里只回答"它是不是一份结构
 * 完整、语法上没坏掉的 frontmatter"：
 *   - 有开头 `---` 但没闭合 → unparsable
 *   - 有闭合，但中间出现既不是 `key: value`、也不是缩进续行/列表项/注释的行 → unparsable
 *
 * 不为几种字段引 YAML 库，理由与 mcp.js 的极简 YAML 解析一致。
 */
function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(src)) return { present: false, data: null };

  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) {
    // 没有闭合线。可能是真的坏 frontmatter，也可能只是文档以分隔线 `---`
    // 开头——后者在 markdown 里合法，不能当成解析失败。
    // 判据：紧跟其后的**连续一段**（到第一个空行为止）全都长得像 YAML
    // 字段，才算"有 frontmatter 意图但没闭合"。
    const block = [];
    for (const line of src.replace(/^---\r?\n/, '').split(/\r?\n/)) {
      if (!line.trim()) break;
      block.push(line);
    }
    const looksLikeFrontmatter =
      block.length > 0 &&
      block.every(
        (l) =>
          /^\s*[A-Za-z0-9_.-]+\s*:\s*/.test(l) || /^\s+-\s+/.test(l) || /^\s+\S/.test(l) || /^\s*#/.test(l)
      );
    if (!looksLikeFrontmatter) return { present: false, data: null };
    return { present: true, data: null, error: 'frontmatter 未闭合' };
  }

  const body = m[1];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s*[A-Za-z0-9_.-]+\s*:\s*.*$/.test(line)) continue;
    if (/^\s+-\s+.*$/.test(line)) continue;
    if (/^\s+\S/.test(line)) continue;
    return { present: true, data: body, error: `frontmatter 第 ${i + 1} 行无法解析：${line.trim().slice(0, 60)}` };
  }
  return { present: true, data: body };
}

/**
 * 从文件头判断 frontmatter 是否可解析。
 *
 * 400 字节内没看到闭合线时可能是 frontmatter 较长，再多读一段确认；
 * 超过 64 KB 还没闭合的 frontmatter 本身就坏了。
 */
function frontmatterCheck(p, headText) {
  const src = String(headText || '').replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(src)) return { error: null };

  if (/\r?\n---(?:\r?\n|$)/.test(src)) {
    return { error: parseFrontmatter(src).error || null };
  }

  const more = readHeadResult(p, FRONTMATTER_BYTES);
  if (!more.ok) return { readError: more.error };
  return { error: parseFrontmatter(more.text).error || null };
}

/**
 * 从 markdown 里抽"这条记忆叫什么"。
 *
 * 两种写法并存：frontmatter 的 `name:` 和一级标题 `# xxx`。
 * 实测的 Qoder / ZCode 分片用 frontmatter，Hermes 用 `# 标题`。
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

/**
 * 识别一个单文件目标。
 *
 * @returns {{path: string|null, status: 'ok'|'missing'|'unreadable'|'unparsable', item?: object, error?: string}}
 */
function describeFile(t) {
  let p;
  try {
    p = t.path();
  } catch (e) {
    return { path: null, status: 'unreadable', error: errorText('路径解析失败', e) };
  }
  // 版本化库这种目标：目录里没有匹配文件时 path() 返回 null，属于"确实没有"。
  if (!p) return { path: null, status: 'missing' };

  const st = statResult(p);
  if (st.error) {
    const status = statusForError(st.error);
    return { path: p, status, error: status === 'unreadable' ? errorText('读不到', st.error) : null };
  }
  // 同名目录占位（Windows 上模拟权限失败的一种可控方式）也归为"存在但读不到"，
  // 不能说成"没有这份记忆"。
  if (!st.stat.isFile()) {
    return { path: p, status: 'unreadable', error: '目标存在但不是文件（目录或其他类型）' };
  }

  const head = readHeadResult(p);
  if (!head.ok) return { path: p, status: 'unreadable', error: errorText('读不到', head.error) };

  const fm = frontmatterCheck(p, head.text);
  if (fm.readError) return { path: p, status: 'unreadable', error: errorText('读不到', fm.readError) };
  if (fm.error) return { path: p, status: 'unparsable', error: fm.error };

  return {
    path: p,
    status: 'ok',
    item: {
      agent: t.agent,
      kind: t.kind,
      scope: t.scope,
      status: 'ok',
      format: 'markdown',
      path: p,
      bytes: st.stat.size,
      // 大文件不读正文，只报大小——450 KB 的记忆读进来毫无用处，
      // 真正要看的时候人会自己打开
      topic: t.large ? null : titleOf(head.text),
      preview: t.large ? null : clip(head.text.replace(/^---[\s\S]*?---/, '').trim(), 160),
      large: Boolean(t.large) || st.stat.size > 64 * 1024,
    },
  };
}

/**
 * 读一个目录里的 markdown 分片，返回分片元数据 + 每个文件的读取状态。
 *
 * 分片状态要单独留：目录能列出来，不等于每个分片都能读。某一个分片坏了
 * 时，其它分片仍然有效，坏的这一个记 unparsable/unreadable 并进 errors。
 */
function readShardFiles(dir, t) {
  const entries = [];
  const files = [];
  const errors = [];

  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return { entries, files, errors, count: 0, readdirError: e };
  }

  for (const f of names.filter((n) => n !== t.index).sort()) {
    const full = path.join(dir, f);
    const s = statResult(full);
    if (s.error) {
      const status = statusForError(s.error);
      files.push({ file: full, agent: t.agent, kind: t.kind, scope: t.scope, status });
      if (status === 'unreadable') errors.push({ file: full, agent: t.agent, error: errorText('读不到', s.error) });
      continue;
    }
    if (!s.stat.isFile()) {
      files.push({ file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unreadable' });
      errors.push({ file: full, agent: t.agent, error: '目标存在但不是文件（目录或其他类型）' });
      continue;
    }

    const head = readHeadResult(full, 200);
    if (!head.ok) {
      files.push({ file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unreadable' });
      errors.push({ file: full, agent: t.agent, error: errorText('读不到', head.error) });
      continue;
    }
    const fm = frontmatterCheck(full, head.text);
    if (fm.readError) {
      files.push({ file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unreadable' });
      errors.push({ file: full, agent: t.agent, error: errorText('读不到', fm.readError) });
      continue;
    }
    if (fm.error) {
      files.push({ file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unparsable' });
      errors.push({ file: full, agent: t.agent, error: fm.error });
      continue;
    }

    files.push({ file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'ok', bytes: s.stat.size });
    entries.push({ file: f, topic: titleOf(head.text), bytes: s.stat.size });
  }

  return { entries, files, errors, count: names.length };
}

/**
 * 索引文件（MEMORY.md）单独读：它是目录记忆的入口，坏了也要报 unknown。
 */
function describeIndex(dir, t) {
  const full = path.join(dir, t.index);
  const s = statResult(full);
  if (s.error) {
    const status = statusForError(s.error);
    return {
      index: null,
      // 索引文件不存在是正常形态（很多目录只放分片），不记进 files。
      file: status === 'missing' ? null : { file: full, agent: t.agent, kind: t.kind, scope: t.scope, status },
      error: status === 'unreadable' ? { file: full, agent: t.agent, error: errorText('读不到', s.error) } : null,
    };
  }
  if (!s.stat.isFile()) {
    return {
      index: null,
      file: { file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unreadable' },
      error: { file: full, agent: t.agent, error: '目标存在但不是文件（目录或其他类型）' },
    };
  }

  const head = readHeadResult(full, 200);
  if (!head.ok) {
    return {
      index: null,
      file: { file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unreadable' },
      error: { file: full, agent: t.agent, error: errorText('读不到', head.error) },
    };
  }
  const fm = frontmatterCheck(full, head.text);
  if (fm.readError) {
    return {
      index: null,
      file: { file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unreadable' },
      error: { file: full, agent: t.agent, error: errorText('读不到', fm.readError) },
    };
  }
  if (fm.error) {
    return {
      index: null,
      file: { file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'unparsable' },
      error: { file: full, agent: t.agent, error: fm.error },
    };
  }

  return {
    index: { file: t.index, bytes: s.stat.size },
    file: { file: full, agent: t.agent, kind: t.kind, scope: t.scope, status: 'ok', bytes: s.stat.size },
    error: null,
  };
}

/**
 * 目录型记忆：识别索引 + 分片。
 *
 * 只统计条数和每条的标题，不读正文——实测 ZCode 最大的项目记忆有
 * 36 个分片，全读进来没有意义。
 *
 * @returns {{path: string|null, status: string, item?: object, files?: Array, errors?: Array, error?: string}}
 */
function describeDir(t) {
  let dir;
  try {
    dir = t.dir();
  } catch (e) {
    return { path: null, status: 'unreadable', error: errorText('路径解析失败', e) };
  }
  if (!dir) return { path: null, status: 'missing' };

  const st = statResult(dir);
  if (st.error) {
    const status = statusForError(st.error);
    return { path: dir, status, error: status === 'unreadable' ? errorText('读不到目录', st.error) : null };
  }
  if (!st.stat.isDirectory()) {
    return { path: dir, status: 'unreadable', error: '目标存在但不是目录' };
  }

  const shard = readShardFiles(dir, t);
  if (shard.readdirError) {
    return {
      path: dir,
      status: statusForError(shard.readdirError) === 'missing' ? 'missing' : 'unreadable',
      error: errorText('读不到目录', shard.readdirError),
    };
  }

  const idx = describeIndex(dir, t);
  const files = [...shard.files];
  const errors = [...shard.errors];
  if (idx.file) files.push(idx.file);
  if (idx.error) errors.push(idx.error);

  // 目录存在但没有 markdown 文件：这是一个空的记忆目录，正常状态；
  // 不产出 item（保持旧的"0 条记忆 = 不列"语义），但 roots 里能看见它。
  if (!shard.count && !idx.index) {
    return { path: dir, status: 'ok', item: null, files, errors };
  }

  return {
    path: dir,
    status: 'ok',
    files,
    errors,
    item: {
      agent: t.agent,
      kind: t.kind,
      scope: t.scope,
      status: 'ok',
      format: 'dir',
      path: dir,
      index: idx.index,
      bytes: shard.entries.reduce((n, e) => n + e.bytes, 0) + (idx.index ? idx.index.bytes : 0),
      // 分片数 = 这个 Agent 积累了多少条记忆
      entries: shard.entries.length,
      topics: shard.entries.map((e) => ({ file: e.file, topic: e.topic, bytes: e.bytes })),
      large: true,
    },
  };
}

/**
 * 项目级记忆：`<agent>/memories/projects/<项目名-哈希>/memory/*.md`。
 *
 * 这是 ZCode 的做法，也是这一层最有价值的部分——它把记忆按项目分开，
 * 正好能对上会话层的项目维度。目录名尾部有 16 位哈希，剥掉就是项目名。
 *
 * @returns {{rootPath: string|null, rootStatus: string, items: Array, roots: Array, files: Array, errors: Array}}
 */
function describeProjectDirs(agent, rootRel) {
  const out = { rootPath: null, rootStatus: 'missing', items: [], roots: [], files: [], errors: [] };

  let root;
  try {
    root = path.join(os.homedir(), ...rootRel.split('/'));
  } catch (e) {
    out.rootStatus = 'unreadable';
    out.errors.push({ root: null, agent, error: errorText('路径解析失败', e) });
    return out;
  }
  out.rootPath = root;

  const rootStat = statResult(root);
  if (rootStat.error) {
    out.rootStatus = statusForError(rootStat.error);
    if (out.rootStatus === 'unreadable') {
      out.errors.push({ root, agent, error: errorText('读不到目录', rootStat.error) });
    }
    return out;
  }
  if (!rootStat.stat.isDirectory()) {
    out.rootStatus = 'unreadable';
    out.errors.push({ root, agent, error: '目标存在但不是目录' });
    return out;
  }
  out.rootStatus = 'ok';

  let projs;
  try {
    projs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    out.rootStatus = 'unreadable';
    out.errors.push({ root, agent, error: errorText('读不到目录', e) });
    return out;
  }

  for (const e of projs) {
    const memDir = path.join(root, e.name, 'memory');
    const mst = statResult(memDir);
    if (mst.error) {
      // 项目目录下没有 memory/ 是正常形态（这个项目还没积累记忆），不报；
      // 只有确实存在但读不到才算未知。
      if (statusForError(mst.error) === 'unreadable') {
        out.roots.push({ root: memDir, agent, kind: 'memory', scope: 'project', status: 'unreadable', found: 0 });
        out.errors.push({ root: memDir, agent, error: errorText('读不到目录', mst.error) });
      }
      continue;
    }
    if (!mst.stat.isDirectory()) {
      out.roots.push({ root: memDir, agent, kind: 'memory', scope: 'project', status: 'unreadable', found: 0 });
      out.errors.push({ root: memDir, agent, error: '目标存在但不是目录' });
      continue;
    }

    const shard = readShardFiles(memDir, { agent, kind: 'memory', scope: 'project', index: 'MEMORY.md' });
    if (shard.readdirError) {
      out.roots.push({ root: memDir, agent, kind: 'memory', scope: 'project', status: 'unreadable', found: 0 });
      out.errors.push({ root: memDir, agent, error: errorText('读不到目录', shard.readdirError) });
      continue;
    }

    out.roots.push({
      root: memDir,
      agent,
      kind: 'memory',
      scope: 'project',
      status: 'ok',
      found: shard.entries.length,
    });
    const idx = describeIndex(memDir, { agent, kind: 'memory', scope: 'project', index: 'MEMORY.md' });
    out.files.push(...shard.files);
    if (idx.file) out.files.push(idx.file);
    out.errors.push(...shard.errors);
    if (idx.error) out.errors.push(idx.error);

    // 只有 MEMORY.md 也算一份项目记忆（它是索引），不能因为分片为 0 就不列。
    const bytes = shard.entries.reduce((n, x) => n + x.bytes, 0) + (idx.index ? idx.index.bytes : 0);
    if (!shard.count && !idx.index) continue;

    out.items.push({
      agent,
      kind: 'memory',
      // 项目级：会被某个项目的工作触发，不是全局生效
      scope: 'project',
      status: 'ok',
      project: projectFromDirName(e.name),
      format: 'dir',
      path: memDir,
      bytes,
      entries: shard.entries.length,
      topics: shard.entries.map((x) => ({ file: x.file, topic: x.topic, bytes: x.bytes })),
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
  let p;
  try {
    p = t.path();
  } catch (e) {
    return { path: null, status: 'unreadable', error: errorText('路径解析失败', e) };
  }
  // 版本化库：目录里没有匹配文件 → 确实没有。
  if (!p) return { path: null, status: 'missing' };

  const st = statResult(p);
  if (st.error) {
    const status = statusForError(st.error);
    return { path: p, status, error: status === 'unreadable' ? errorText('读不到', st.error) : null };
  }
  if (!st.stat.isFile()) {
    return { path: p, status: 'unreadable', error: '目标存在但不是文件（目录或其他类型）' };
  }

  let db;
  let cleanup = () => {};
  let tempCopy = false;

  try {
    const opened = openReadOnlyCopy(p);
    db = opened.db;
    cleanup = opened.cleanup;
    tempCopy = opened.copied;
  } catch (e) {
    return {
      path: p,
      status: 'unreadable',
      error: `打不开（可能被占用或版本不支持）：${(e && (e.code || e.message)) || e}`,
    };
  }

  try {
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
      path: p,
      status: 'ok',
      item: {
        agent: t.agent,
        kind: t.kind,
        scope: t.scope,
        status: 'ok',
        format: 'sqlite',
        path: p,
        bytes: st.stat.size,
        // 有没有被复制过，说明这个库当时是否有 -wal（有没有别的 Agent 正在写）
        tempCopy,
        entries: entries ? entries.count : null,
        entryLabel: entries ? entries.label : null,
        tables,
        large: true,
      },
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
 * 扫描实测所有记忆与指令文件。
 *
 * 每个目标都带四态：`ok` / `missing` / `unreadable` / `unparsable`。
 *   - missing     = 路径确实不存在（最常见：这家 Agent 没装 / 没记忆）
 *   - unreadable  = 路径存在，但 stat/read 失败（权限、IO、同名目录占位…）
 *   - unparsable  = 文件读到了，但 frontmatter 结构坏了
 *
 * `items` 只收 ok 的条目（保持原有字段与语义）；坏掉的目标进入 `files` /
 * `roots` 的 status 与 `errors`，由 summary 决定怎么展示——绝不能悄悄当成
 * "0 份记忆"。
 *
 * @returns {{items: Array, files: Array, roots: Array, byAgent: object, totals: object, errors: Array}}
 */
export function scanMemory() {
  const items = [];
  const files = [];
  const roots = [];
  const errors = [];

  const collectFile = (t, r) => {
    files.push({ file: r.path, agent: t.agent, kind: t.kind, scope: t.scope, status: r.status });
    if (r.status === 'ok') items.push(r.item);
    if (r.error) errors.push({ file: r.path, agent: t.agent, error: r.error });
  };

  for (const t of TARGETS) collectFile(t, describeFile(t));

  for (const t of DIR_TARGETS) {
    const r = describeDir(t);
    roots.push({
      root: r.path,
      agent: t.agent,
      kind: t.kind,
      scope: t.scope,
      status: r.status,
      found: r.item ? r.item.entries : 0,
    });
    if (r.item) items.push(r.item);
    if (r.files) files.push(...r.files);
    if (r.errors) errors.push(...r.errors);
    if (r.error) errors.push({ root: r.path, agent: t.agent, error: r.error });
  }

  for (const t of DB_TARGETS) collectFile(t, describeDb(t));

  const proj = describeProjectDirs('zcode', '.zcode/cli/memories/projects');
  roots.push({
    root: proj.rootPath,
    agent: 'zcode',
    kind: 'memory',
    scope: 'project',
    status: proj.rootStatus,
    found: proj.items.length,
  });
  items.push(...proj.items);
  files.push(...proj.files);
  roots.push(...proj.roots);
  errors.push(...proj.errors);

  const byAgent = {};
  for (const it of items) {
    byAgent[it.agent] = byAgent[it.agent] || { files: 0, entries: 0, instruction: 0, memory: 0 };
    byAgent[it.agent].files++;
    byAgent[it.agent].entries += it.entries || 0;
    byAgent[it.agent][it.kind]++;
  }

  const fileUnknown = files.filter((f) => f.status === 'unreadable' || f.status === 'unparsable').length;
  const rootUnknown = roots.filter((r) => r.status === 'unreadable' || r.status === 'unparsable').length;

  return {
    items,
    files,
    roots,
    byAgent,
    totals: {
      locations: items.length,
      // 指令是"现在要求你怎么做"，记忆是"过去学到过什么"——分开计数
      instructions: items.filter((i) => i.kind === 'instruction').length,
      memories: items.filter((i) => i.kind === 'memory').length,
      // 项目级记忆独自一类：它只在特定项目里生效
      projectScoped: items.filter((i) => i.scope === 'project').length,
      entries: items.reduce((n, i) => n + (i.entries || 0), 0),
      // 这两个计数只用于说明"未知 ≠ 0"：unknown 不进上面的任何能力计数。
      missing: [...files, ...roots].filter((x) => x.status === 'missing').length,
      unknown: fileUnknown + rootUnknown,
    },
    errors,
  };
}

/**
 * 摘要：给 MCP 和体检用。
 *
 * 刻意**不含 preview 和 topics 的正文**——只给"有没有、多大、多少条"。
 * 要读某一份记忆，用 readMemory(path) 显式取。
 *
 * `filesUnknown` / `rootsUnknown` 是"读不到/解析不了"的数量：它们**没有**
 * 被算进 locations/instructions/memories，调用方据此显示"未知，未计入"。
 */
export function memorySummary() {
  const { items, byAgent, totals, files, roots, errors } = scanMemory();

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
    // 读不到/解析不了的记忆文件与目录根：未知不是零，必须单独可见。
    filesUnknown: files.filter((f) => f.status === 'unreadable' || f.status === 'unparsable').length,
    rootsUnknown: roots.filter((r) => r.status === 'unreadable' || r.status === 'unparsable').length,
    errors,
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
      // 不列 path：实测绝对路径对别的 Agent 没意义，
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
  const { items, files, roots } = scanMemory();
  // 目标可能因为 unreadable/unparsable 不在 items 里，但它仍然属于已识别范围；
  // 这样报错会是"读不到"而不是误导性的"不在范围内"。
  const inside = (target, prefix) => {
    if (!prefix) return false;
    if (target === prefix) return true;
    const withSep = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
    return target.startsWith(withSep);
  };
  const known =
    items.some((i) => i.path && inside(targetPath, i.path)) ||
    files.some((f) => f.file === targetPath) ||
    roots.some((r) => r.root && inside(targetPath, r.root));
  if (!known) {
    throw new Error(`不在已识别的记忆范围内：${targetPath}`);
  }

  const st = statResult(targetPath);
  if (st.error) {
    if (statusForError(st.error) === 'missing') throw new Error('文件不存在');
    throw new Error(errorText('读不到', st.error));
  }
  if (st.stat.isDirectory()) throw new Error('这是一个记忆目录，请指定里面的具体文件');

  let text;
  try {
    text = fs.readFileSync(targetPath, 'utf8');
  } catch (e) {
    throw new Error(errorText('读不到', e));
  }
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
