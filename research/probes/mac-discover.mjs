#!/usr/bin/env node
/**
 * 扫描这台机器上**实际存在**的 Agent 数据 —— 单文件、零依赖、只读。
 *
 * 上一个脚本（mac-check.mjs）是"按已知路径去核对"，
 * 这个脚本是"不知道该有哪些，先看有什么"。
 *
 * 两者的区别很实际：mac-check 在 Mac 上报 0/11，不是因为路径都错了，
 * 而是因为那台机器装的是**别的 Agent**。按名单找永远找不到名单外的东西。
 *
 * 做法：
 *   1. 枚举家目录下的所有点目录 + ~/Library/Application Support 下的所有目录
 *   2. 对每个目录算"数据签名"：有多少 jsonl / sqlite / md，有没有会话表
 *   3. 看 PATH 上有哪些 agent 类可执行文件
 *   4. 综合判断：这个目录像不像某个 Agent 的数据
 *
 * 只读，不写任何人的目录。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const lines = [];
const say = (s = '') => {
  console.log(s);
  lines.push(s);
};
const tildify = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/* ------------------------------ 1. 基本环境 ------------------------------ */

say('='.repeat(68));
say('这台机器上有什么 Agent 数据');
say('='.repeat(68));
say();
say(`平台      ${process.platform}`);
say(`家目录    ${HOME}`);
say(`Node      ${process.version}`);
try {
  const real = fs.realpathSync(HOME);
  if (real !== HOME) say(`⚠️ 家目录是软链 → ${real}`);
} catch {}
say();

/* ------------------------------ 2. 递归统计签名 ------------------------------ */

/**
 * 扫一个目录，统计里面的"数据形状"。
 *
 * 只下到 4 层、最多 4000 个文件：Agent 的数据目录通常很浅，
 * 而我们不想因为某个缓存目录里有十万个文件就卡住。
 */
function profile(dir) {
  const sig = {
    jsonl: 0,
    json: 0,
    sqlite: 0,
    md: 0,
    pb: 0,
    other: 0,
    dirs: 0,
    bytes: 0,
    maxDepthHit: false,
    names: new Set(),
  };

  let budget = 4000;

  const walk = (d, lvl) => {
    if (lvl > 4 || budget <= 0) {
      if (budget <= 0) sig.maxDepthHit = true;
      return;
    }
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (--budget <= 0) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        sig.dirs++;
        if (lvl < 2) sig.names.add(e.name);
        walk(full, lvl + 1);
        continue;
      }
      // 符号链接按文件算，不跟进（避免环）
      const n = e.name.toLowerCase();
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {}
      sig.bytes += size;
      if (n.endsWith('.jsonl') || n.endsWith('.jsonl.zst')) sig.jsonl++;
      else if (n.endsWith('.db') || n.endsWith('.sqlite') || n.endsWith('.sqlite3')) sig.sqlite++;
      else if (n.endsWith('.json')) sig.json++;
      else if (n.endsWith('.md')) sig.md++;
      else if (n.endsWith('.pb')) sig.pb++;
      else sig.other++;
    }
  };

  walk(dir, 0);
  return sig;
}

/**
 * 从目录名和内容猜这是哪家的数据。
 *
 * 依据：
 *   - 目录名里出现 agent 名字
 *   - 有 state.db / sessions / projects / conversation 之类结构
 *   - 有 SKILL.md / mcp.json / config.toml 这类能力配置
 */
function guessAgent(name, sig, dir) {
  const low = name.toLowerCase();
  const known = [
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['zcode', 'ZCode'],
    ['qoder', 'Qoder'],
    ['hermes', 'Hermes'],
    ['cursor', 'Cursor'],
    ['opencode', 'OpenCode'],
    ['gemini', 'Gemini / Antigravity'],
    ['antigravity', 'Antigravity'],
    ['kiro', 'Kiro'],
    ['copilot', 'Copilot'],
    ['openclaw', 'OpenClaw'],
    ['trae', 'Trae'],
    ['windsurf', 'Windsurf'],
    ['cline', 'Cline'],
    ['continue', 'Continue'],
    ['aider', 'Aider'],
    ['zed', 'Zed'],
    ['warp', 'Warp'],
    ['witsy', 'Witsy'],
    ['chatgpt', 'ChatGPT Desktop'],
    ['anthropic', 'Claude Desktop'],
  ];
  for (const [k, label] of known) {
    if (low.includes(k)) return { agent: label, why: `目录名含 "${k}"` };
  }

  // 看子目录名
  const names = [...sig.names].map((s) => s.toLowerCase());
  if (names.includes('sessions') && sig.jsonl > 0) return { agent: '未知（有 sessions/*.jsonl）', why: 'sessions + jsonl' };
  if (names.includes('projects') && sig.jsonl > 0) return { agent: '未知（有 projects/*.jsonl）', why: 'projects + jsonl' };
  if (names.includes('skills') && sig.md > 0) return { agent: '未知（有 skills/SKILL.md）', why: 'skills + md' };
  if (sig.sqlite > 0) return { agent: '未知（有 SQLite）', why: 'sqlite' };

  return null;
}

/**
 * 找一个目录里**最像主库**的 SQLite 文件。
 *
 * 第一版取的是"递归里第一个找到的 db"，于是 Codex 报的是
 * ~/.codex/goals_1.sqlite（一个只有 2 行的小库），而不是真正的
 * 会话存储。这种错很隐蔽——它确实读到了 SQLite，但读错了库，
 * 结论就从"已支持"变成"未支持"。
 *
 * 判据按重要性排：
 *   1. 大小（主库通常远大于附属库）
 *   2. 路径里不含 backup / cache / tmp / log
 *   3. 文件名像主库（state / session / chat / db.sqlite / opencode.db）
 */
function findMainDb(root) {
  const cands = [];
  const walk = (d, lvl) => {
    if (lvl > 4) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (/^(backup|backups|cache|tmp|logs?|node_modules|\.git)$/i.test(e.name)) continue;
        walk(full, lvl + 1);
        continue;
      }
      if (!/\.(db|sqlite|sqlite3)$/i.test(e.name)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {}
      if (size < 8192) continue; // 空库/占位库
      cands.push({ path: full, size, name: e.name });
    }
  };
  walk(root, 0);

  if (!cands.length) return null;

  // 打分：大小取对数（避免一个超大库压倒一切），路径与文件名给加分
  const score = (c) => {
    let s = Math.log2(Math.max(c.size, 1024));
    const rel = c.path.toLowerCase().replace(/\\/g, '/');
    if (/backup|cache|tmp|log/.test(rel)) s -= 12;
    if (/^(state|main|index|opencode|db)\.(db|sqlite|sqlite3)$/i.test(c.name)) s += 8;
    if (/db\.sqlite$/.test(c.name)) s += 4;
    return s;
  };

  cands.sort((a, b) => score(b) - score(a));
  return cands[0];
}
/**
 * 试着从 SQLite 里认出会话表。
 *
 * 只读打开、只查 sqlite_master 与行数，不改任何字节。
 * 这一步能把"看起来像"变成"确实是会话库"。
 */
function sqliteTables(file) {
  if (!DatabaseSync) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = db
      .prepare("select name from sqlite_master where type='table'")
      .all()
      .map((r) => r.name);
    const rows = {};
    // 只数会话相关的表，且只数行数（不读内容）
    for (const t of tables) {
      if (!/session|message|thread|conversation|chat/i.test(t)) continue;
      try {
        rows[t] = db.prepare(`select count(*) n from "${t}"`).get().n;
      } catch {}
    }
    return { tables: tables.length, sessionTables: rows };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/* ------------------------------ 3. 枚举候选目录 ------------------------------ */

const candidates = [];

// 家目录下的点目录
let homeEnts = [];
try {
  homeEnts = fs.readdirSync(HOME, { withFileTypes: true });
} catch {}
for (const e of homeEnts) {
  if (!e.name.startsWith('.')) continue;
  if (['.Trash', '.cache', '.npm', '.nvm', '.gitconfig', '.zshrc', '.bashrc'].includes(e.name)) continue;
  const full = path.join(HOME, e.name);
  if (!isDir(full)) continue;
  candidates.push({ name: e.name, dir: full, where: '家目录点目录' });
}

// Application Support
const asDir = path.join(HOME, 'Library', 'Application Support');
let asEnts = [];
try {
  asEnts = fs.readdirSync(asDir, { withFileTypes: true });
} catch {}
for (const e of asEnts) {
  if (!e.isDirectory()) continue;
  candidates.push({ name: e.name, dir: path.join(asDir, e.name), where: 'Application Support' });
}

/* ------------------------------ 4. 逐个画像 ------------------------------ */

say('--- 扫描候选目录 ---');
say();

const found = [];

for (const c of candidates) {
  const sig = profile(c.dir);
  // 太小或太没特征的跳过（空目录、纯配置文件）
  if (sig.jsonl === 0 && sig.sqlite === 0 && sig.pb === 0 && sig.md < 3) continue;

  const guess = guessAgent(c.name, sig, c.dir);
  if (!guess) continue;

  // 有没有 SQLite 会话表
  let dbInfo = null;
  let dbPath = null;
  if (sig.sqlite > 0) {
    const main = findMainDb(c.dir);
    if (main) {
      dbPath = main.path;
      dbInfo = sqliteTables(dbPath);
    }
  }

  found.push({ ...c, sig, guess, dbPath, dbInfo });
}

// 按"像不像真数据"排序：有会话表的优先
found.sort((a, b) => {
  const score = (x) => {
    let s = 0;
    if (x.dbInfo && Object.keys(x.dbInfo.sessionTables || {}).length) s += 100;
    s += Math.min(x.sig.jsonl, 50);
    s += x.sig.sqlite * 2;
    return s;
  };
  return score(b) - score(a);
});

for (const f of found) {
  const sig = f.sig;
  const size = sig.bytes > 1024 * 1024 ? (sig.bytes / 1024 / 1024).toFixed(0) + 'MB' : Math.round(sig.bytes / 1024) + 'KB';
  say(`${f.guess.agent}`);
  say(`   位置    ${tildify(f.dir)}   （${f.where}）`);
  say(`   判断依据 ${f.guess.why}`);
  say(`   内容    jsonl ${sig.jsonl} · sqlite ${sig.sqlite} · json ${sig.json} · md ${sig.md} · pb ${sig.pb}  |  ${size}`);
  if (f.dbPath) {
    say(`   数据库   ${tildify(f.dbPath)}`);
    if (f.dbInfo) {
      const st = Object.entries(f.dbInfo.sessionTables || {});
      if (st.length) {
        say(`   会话表   ${st.map(([t, n]) => `${t}(${n} 行)`).join(', ')}`);
      } else {
        say(`   会话表   （${f.dbInfo.tables} 张表，没有名字像会话的）`);
      }
    } else {
      say(`   会话表   读不了`);
    }
  }
  say();
}

/* ------------------------------ 5. PATH 上的可执行文件 ------------------------------ */

say('--- PATH 上的 Agent 可执行文件 ---');
say();

const AGENT_BINS = [
  'claude', 'codex', 'zcode', 'qoder', 'hermes', 'cursor', 'opencode',
  'gemini', 'kiro', 'copilot', 'openclaw', 'aider', 'cline', 'continue',
  'ollama', 'llm', 'sgpt', 'warp',
];

const onPath = [];
for (const b of AGENT_BINS) {
  try {
    const out = execFileSync('which', [b], { encoding: 'utf8', timeout: 2000 }).trim();
    if (out) onPath.push({ bin: b, path: out });
  } catch {}
}

if (onPath.length) {
  for (const x of onPath) say(`  ✓ ${x.bin.padEnd(12)} ${x.path.replace(HOME, '~')}`);
} else {
  say('  （PATH 上没有找到已知的 Agent 命令行工具）');
}
say();

/* ------------------------------ 6. 结论 ------------------------------ */

say('='.repeat(68));
say('结论');
say('='.repeat(68));
say();

const withSessions = found.filter((f) => f.dbInfo && Object.keys(f.dbInfo.sessionTables || {}).length);

/**
 * 本工具**已经支持**的 Agent。
 *
 * 这个列表是给结论用的：扫到 ~/.codex 不代表"读不了 Codex"，
 * 可能只是路径与假设一致、适配器已经写好了。第一版没有这层判断，
 * 把 codex / zcode / opencode 全列成"还读不了"，结论是错的。
 *
 * 目录名里的关键词 → scanner 名。
 */
const SUPPORTED = [
  ['claude', 'claude-code'],
  ['codex', 'codex'],
  ['zcode', 'zcode'],
  ['qoder', 'qoder'],
  ['hermes', 'hermes'],
  ['cursor', 'cursor'],
  ['gemini/antigravity', 'antigravity'],
  ['kiro', 'kiro'],
  ['code/user/workspacestorage', 'copilot'],
];

/**
 * OpenCode 单独判断：它的数据在 `~/.local/share/opencode`，
 * 但扫描候选目录时枚举到的是 `~/.local` 这一层。
 * 所以要往下看一眼有没有 share/opencode，而不是匹配目录名。
 */
function supportedBy(dir) {
  const rel = dir.toLowerCase().replace(/\\/g, '/');
  for (const [k, agent] of SUPPORTED) {
    if (rel.includes(k)) return agent;
  }
  // ~/.local 里如果有 share/opencode/opencode.db，那就是 OpenCode
  if (isDir(path.join(dir, 'share', 'opencode'))) return 'opencode';
  return null;
}

const rows = found.map((f) => ({
  ...f,
  supported: supportedBy(f.dir),
  hasData: Boolean(f.dbInfo && Object.keys(f.dbInfo.sessionTables || {}).length) || f.sig.jsonl > 0,
}));

const unreadable = rows.filter((r) => r.hasData && !r.supported);
const readable = rows.filter((r) => r.hasData && r.supported);
const configOnly = rows.filter((r) => !r.hasData);

if (readable.length) {
  say(`已被本工具支持并且有数据：${readable.length} 处`);
  for (const r of readable) {
    const how = r.dbInfo && Object.keys(r.dbInfo.sessionTables || {}).length ? 'SQLite 会话表' : `${r.sig.jsonl} 个 jsonl`;
    say(`  ✓ ${r.guess.agent.padEnd(26)} ${tildify(r.dir)}   (${how})`);
  }
  say('');
}

if (unreadable.length) {
  say(`扫到数据但本工具还没适配：${unreadable.length} 处`);
  say('');
  for (const r of unreadable) {
    say(`  → ${r.guess.agent}   ${tildify(r.dir)}`);
    if (r.dbInfo && Object.keys(r.dbInfo.sessionTables || {}).length) {
      const st = Object.entries(r.dbInfo.sessionTables);
      say(`      会话表：${st.map(([t, n]) => `${t}(${n} 行)`).join(', ')}`);
    } else if (r.sig.jsonl) {
      say(`      ${r.sig.jsonl} 个 jsonl`);
    }
  }
  say('');
  say('这些是新发现的 Agent。把这份输出发回来就能照着实现在');
  say('src/scanners/ 里加适配器——有会话表名和行数就够写解析了。');
  say('');
}

if (configOnly.length) {
  say(`只有配置/资源、没有会话数据：${configOnly.length} 处`);
  say('  ' + configOnly.map((r) => r.guess.agent).join('、'));
  say('');
}

if (!rows.length) {
  say('没有扫到任何像 Agent 数据的目录。');
  say('');
  say('可能的原因：');
  say('  1. 这台机器上确实没装过 AI Agent');
  say('  2. Agent 数据放在了很特别的位置（不在家目录点目录、也不在 Application Support）');
  say('  3. 数据被沙盒化到 ~/Library/Containers/ 下（脚本还没扫那里）');
  say('');
  say('如果是第 2、3 种，请把这份输出发回来——上面的"扫描候选目录"');
  say('部分会说明它到底看了哪些目录。');
}

/* ------------------------------ 7. 报告 ------------------------------ */

say();
const reportPath = path.join(os.tmpdir(), 'agent-archive-discover.txt');
try {
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`报告已写入：${reportPath}`);
} catch {
  console.log('（报告写入失败，直接复制上面的输出）');
}
