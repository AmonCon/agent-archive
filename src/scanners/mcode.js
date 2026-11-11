import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadOnly } from '../sqlite-read.js';
import { makeSession } from '../model.js';
import { makeMessage, textPart, assertUnderAny } from '../messages.js';
import { envOverrides, pathKey } from '../platform.js';
import { extraRoots } from '../config.js';
import { isDirEntry, isFileEntry } from '../fsentry.js';
import { lineIterator } from './lines.js';

/**
 * MiniMax Code / MCode 会话扫描。
 *
 * **两家上游描述的是两种完全不同的存储形态，都在同一个应用根下，按「目录里
 * 有什么」分派**：
 *
 *   CC Switch（session_manager/providers/mcode.rs）
 *     <data_dir>/v2/sqlite/runtime-state.sqlite
 *       local_runtime_sessions(session_id,title,workspace_dir,created_at_ms,updated_at_ms)
 *       过滤 visibility<>'hidden'、archived=0、parent_session_id IS NULL、
 *            session_kind NOT IN('peek','channel','cron')
 *       两代消息表靠 local_runtime_message_row_migrations 判定：
 *         该 session 有迁移行 → 新表 local_runtime_message_rows(role,data_json,created_at_ms,id)
 *         否则             → 旧表 local_runtime_messages 的 display_messages_json（JSON 数组）
 *       正文是展示行：data_json / 数组元素里的 msg_content，只暴露 user/assistant。
 *
 *   MAGPIE（calls_minimax.go）
 *     <data_dir>/v2/sessions/<yyyy>/<mm>/<dd>/<hh-mm-ss-ms>-session_<b64(id)>/messages.jsonl
 *       一行 {"message_id","turn_id","message":{role,provider,model,usage,timestamp(ms)}}
 *       可能有多代 messages*.jsonl（history-catalog.json 记录），复制进另一代的 reply
 *       保留 message_id → 按 message_id 去重，不当成两场会话。
 *       session id 从目录名 "-session_" 后的 base64 解：4 种编码轮流试
 *       （RawURL / URL / RawStd / Std），解不出就用目录名，**别编**。
 *
 * 环境变量优先级：MINIMAX_DATA_DIR > MAVIS_DATA_DIR > ~/.minimax
 *
 * ## 纪律
 * - SQLite 一律 openReadOnly（含 -wal 判据），每次现开现关，不留跨 source 的
 *   连接缓存；JSONL 一律 lineIterator 逐行读。
 * - 列名按 PRAGMA table_info 探测：旧版/移植版缺列时只对存在的列加过滤，
 *   不因为一个缺列就让整条 SELECT 抛错、静默返回空数组。
 * - 不加顶层 contentProbe：SQLite 头是 "SQLite format 3"，但 JSONL 形态没有
 *   SQLite 文件——顶层探针会把纯 JSONL 备份误杀。两种形态都要认。
 * - JSONL 形态上游没给 cwd 字段：project 留 null，**不猜项目归属**。
 */

export const name = 'mcode';

const DB_REL = path.join('v2', 'sqlite', 'runtime-state.sqlite');
const SESSIONS_REL = path.join('v2', 'sessions');
const WALK_DEPTH = 8;

function dedupeAbs(list) {
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!r) continue;
    let s = String(r).trim();
    if (!s) continue;
    if (s === '~') s = os.homedir();
    else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
    const abs = path.resolve(s);
    const k = pathKey(abs);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(abs);
  }
  return out;
}

function localRoots() {
  return dedupeAbs([
    ...extraRoots(name),
    ...envOverrides(['MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR']),
    path.join(os.homedir(), '.minimax'),
  ]);
}

export function candidateRoots() {
  return localRoots();
}

export function discover() {
  return discoverWithin(localRoots(), {});
}

/** 显式数据源：描述「应用根之下」认什么（纯数据）。 */
export const structureSpec = {
  agent: 'mcode',
  probes: [
    { path: 'v2/sqlite/runtime-state.sqlite', kind: 'file', weight: 5 },
    { glob: 'v2/sessions/**/messages.jsonl', kind: 'file', weight: 4 },
    { path: 'v2/sessions', kind: 'dir', weight: 1 },
  ],
  rootAnchor: { from: 'v2', up: 1 },
  dataPaths: ['v2/sqlite', 'v2/sessions'],
  format: 'mcode runtime-state.sqlite（两代消息表）/ v2/sessions/**/messages.jsonl',
  minScore: 4,
  dirHints: ['.minimax'],
};

/**
 * 显式数据源遍历：roots 直接是应用根（`.minimax` 那一层）。
 * 一个目录里有什么就返回什么：SQLite 库 + 每个会话目录的代表 messages*.jsonl。
 * 只做 readdir/stat，不读文件内容。
 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const root of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
    const db = path.join(root, DB_REL);
    if (isFileSync(db)) {
      const k = pathKey(db);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(db);
      }
    }
    collectSessionFiles(path.join(root, SESSIONS_REL), out, seen, WALK_DEPTH);
  }
  return out;
}

/** 递归到含 messages*.jsonl 的目录为止；多代只取一个代表文件（同属一场会话）。 */
function collectSessionFiles(dir, out, seen, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const msgs = entries
    .filter((e) => isFileEntry(e, path.join(dir, e.name)) && /^messages.*\.jsonl$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  if (msgs.length) {
    const pick = msgs.includes('messages.jsonl') ? 'messages.jsonl' : msgs[0];
    const full = path.join(dir, pick);
    const k = pathKey(full);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(full);
    }
    return;
  }
  if (depth <= 0) return;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isDirEntry(e, full)) collectSessionFiles(full, out, seen, depth - 1);
  }
}

function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** mcode 的时间字段都是毫秒（created_at_ms / timestamp(ms) / 旧表数字串）。 */
function msOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function extractText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (!x) return '';
        if (typeof x === 'string') return x;
        if (typeof x.text === 'string') return x.text;
        if (typeof x.content === 'string') return x.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}

function parseJson(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * SQLite 形态（CC Switch）
 * ------------------------------------------------------------------ */

function tablesOf(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
  } catch {
    return [];
  }
}

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
  } catch {
    return [];
  }
}

function isMigrated(db, id, tables) {
  if (!tables.includes('local_runtime_message_row_migrations')) return false;
  try {
    return !!db.prepare('SELECT 1 FROM local_runtime_message_row_migrations WHERE session_id = ?').get(id);
  } catch {
    return false;
  }
}

/** 一场会话的展示行：按迁移状态二选一（CC Switch 的 EXISTS/NOT EXISTS 语义）。 */
function sessionRows(db, id) {
  const tables = tablesOf(db);
  if (isMigrated(db, id, tables) && tables.includes('local_runtime_message_rows')) {
    const cols = columnsOf(db, 'local_runtime_message_rows');
    if (cols.includes('data_json')) {
      const sel = ['role', 'data_json', 'created_at_ms'].filter((c) => cols.includes(c));
      const order = cols.includes('id') ? ' ORDER BY id' : '';
      try {
        const rows = db.prepare(
          `SELECT ${sel.join(', ')} FROM local_runtime_message_rows WHERE session_id = ?${order}`
        ).all(id);
        return rows.map((r) => {
          const o = parseJson(r.data_json) || {};
          return {
            role: r.role || o.role || null,
            text: extractText(o.msg_content),
            ts: msOrNull(r.created_at_ms) ?? msOrNull(o.timestamp) ?? msOrNull(o.created_at),
            data: o,
          };
        });
      } catch {
        return [];
      }
    }
  }
  if (tables.includes('local_runtime_messages')) {
    try {
      const row = db.prepare('SELECT display_messages_json FROM local_runtime_messages WHERE session_id = ?').get(id);
      const arr = parseJson(row && row.display_messages_json);
      if (Array.isArray(arr)) {
        return arr.map((m) => (m && typeof m === 'object' ? {
          role: m.role || null,
          text: extractText(m.msg_content),
          ts: msOrNull(m.timestamp) ?? msOrNull(m.created_at),
          data: m,
        } : { role: null, text: '', ts: null, data: {} }));
      }
    } catch {
      /* 旧表不存在或缺列：如实返回空 */
    }
  }
  return [];
}

function firstUserText(db, id) {
  for (const r of sessionRows(db, id)) {
    if (r.role === 'user' && r.text && r.text.trim()) return r.text.trim();
  }
  return null;
}

function parseSqlite(file) {
  const db = openReadOnly(file);
  if (!db) return [];
  try {
    const cols = columnsOf(db, 'local_runtime_sessions');
    if (!cols.includes('session_id')) return [];
    const sel = ['session_id', 'title', 'workspace_dir', 'created_at_ms', 'updated_at_ms']
      .filter((c) => cols.includes(c));
    const where = [];
    if (cols.includes('visibility')) where.push("visibility <> 'hidden'");
    if (cols.includes('archived')) where.push('archived = 0');
    if (cols.includes('parent_session_id')) where.push('parent_session_id IS NULL');
    if (cols.includes('session_kind')) where.push("session_kind NOT IN ('peek','channel','cron')");
    const sql = `SELECT ${sel.join(', ')} FROM local_runtime_sessions${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    let rows;
    try {
      rows = db.prepare(sql).all();
    } catch {
      return [];
    }
    const out = [];
    for (const r of rows) {
      const id = String(r.session_id);
      out.push(makeSession({
        agent: name,
        id,
        project: typeof r.workspace_dir === 'string' && r.workspace_dir.trim() ? r.workspace_dir.trim() : null,
        // 标题优先第一句真人输入；SQLite 的 title 是应用/用户起的名，只作兜底
        title: firstUserText(db, id) || (typeof r.title === 'string' ? r.title : null) || null,
        start: msOrNull(r.created_at_ms),
        end: msOrNull(r.updated_at_ms) ?? msOrNull(r.created_at_ms),
        source: `${file}#${id}`,
        resume: `mcode --session ${id}`,
      }));
    }
    return out;
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * JSONL 形态（MAGPIE）
 * ------------------------------------------------------------------ */

/** 4 种 base64 编码轮流试（MAGPIE: RawURL / URL / RawStd / Std），解不出用目录名。 */
function pad(s) {
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

function decodeSessionId(dirName) {
  const marker = '-session_';
  const i = dirName.indexOf(marker);
  if (i < 0) return dirName;
  const enc = dirName.slice(i + marker.length);
  if (!enc) return dirName;
  const std = enc.replace(/-/g, '+').replace(/_/g, '/');
  const variants = [enc, pad(enc), std, pad(std)];
  for (const v of variants) {
    try {
      const b = Buffer.from(v, 'base64');
      if (!b.length) continue;
      const s = b.toString('utf8');
      // 只收可打印 ASCII：解出乱码不是有效 id，别拿它冒充会话身份
      if (/^[\x21-\x7e]+$/.test(s)) return s;
    } catch {
      /* 试下一种 */
    }
  }
  return dirName; // 解不出就用目录名，别编
}

function allMessagesFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^messages.*\.jsonl$/i.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

function parseJsonl(file) {
  const dir = path.dirname(file);
  const id = decodeSessionId(path.basename(dir));
  const seen = new Set();
  let firstUser = null;
  let startMs = null;
  let endMs = null;
  for (const f of allMessagesFiles(dir)) {
    for (const line of lineIterator(f)) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const mid = (o && (o.message_id || o.id)) || null;
      if (mid && seen.has(mid)) continue; // 多代复制的同一条 reply 只算一次
      if (mid) seen.add(mid);
      const m = (o && o.message) || o;
      const t = msOrNull(m && m.timestamp);
      if (t != null) {
        if (startMs == null || t < startMs) startMs = t;
        if (endMs == null || t > endMs) endMs = t;
      }
      if (!firstUser && m && m.role === 'user') {
        const txt = extractText(m.content ?? m.text ?? (o && o.content));
        if (txt.trim()) firstUser = txt.trim();
      }
    }
  }
  return [makeSession({
    agent: name,
    id,
    // JSONL 形态上游没给 cwd 字段：留 null，不猜项目归属
    project: null,
    title: firstUser || null,
    start: startMs,
    end: endMs ?? startMs,
    source: file,
    resume: `mcode --session ${id}`,
  })];
}

/** 一个文件多场会话：SQLite 库返回多场，JSONL 返回单元素数组。 */
export function parseAll(file) {
  const f = String(file || '');
  if (/\.(sqlite|db)$/i.test(f.split('#')[0])) return parseSqlite(f.split('#')[0]);
  if (/\.jsonl$/i.test(f)) return parseJsonl(f);
  return []; // 形状不认：如实返回空，不编
}

/* ------------------------------------------------------------------ *
 * 正文
 * ------------------------------------------------------------------ */

/** source：SQLite 是 "<db>#<id>"，JSONL 是 messages*.jsonl 路径。 */
function splitSource(src) {
  const i = src.lastIndexOf('#');
  if (i >= 0 && /\.(sqlite|db)$/i.test(src.slice(0, i))) {
    return [src.slice(0, i), src.slice(i + 1)];
  }
  return [src, null];
}

function readSqliteMessages(file, id) {
  const db = openReadOnly(file);
  if (!db) throw new Error(`打不开 MCode 数据库：${file}`);
  try {
    const out = [];
    for (const r of sessionRows(db, id)) {
      if (r.role !== 'user' && r.role !== 'assistant') continue; // 只暴露展示行
      const p = textPart(r.text);
      if (!p) continue;
      out.push(makeMessage({ role: r.role, parts: [p], ts: r.ts, meta: null }));
    }
    return out;
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

function readJsonlMessages(file, roots) {
  const dir = path.dirname(file);
  const out = [];
  const seen = new Set();
  for (const f of allMessagesFiles(dir)) {
    const safe = assertUnderAny(roots, f);
    for (const line of lineIterator(safe)) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const mid = (o && (o.message_id || o.id)) || null;
      if (mid && seen.has(mid)) continue;
      if (mid) seen.add(mid);
      const m = (o && o.message) || o;
      if (!m || !['user', 'assistant', 'tool', 'system'].includes(m.role)) continue;
      const p = textPart(extractText(m.content ?? m.text ?? (o && o.content)));
      if (!p) continue;
      const meta = m.usage ? { usage: m.usage, model: m.model || null, provider: m.provider || null } : null;
      out.push(makeMessage({ role: m.role, parts: [p], ts: msOrNull(m.timestamp), meta }));
    }
  }
  return out;
}

function rootsOf(ctx) {
  return ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
}

/** 读正文：按 source 形状分派到 SQLite 或 JSONL；ctx.roots 优先做越界校验。 */
export function readMessages(session, ctx = {}) {
  const roots = rootsOf(ctx);
  const src = String(session.source || '');
  const [file, id] = splitSource(src);
  if (!file) throw new Error('MCode 会话没有 source 路径');
  const safe = assertUnderAny(roots, file);
  if (/\.(sqlite|db)$/i.test(safe)) return readSqliteMessages(safe, id || session.id);
  return readJsonlMessages(safe, roots);
}
