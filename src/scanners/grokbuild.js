import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, assertUnderAny } from '../messages.js';
import { envOverrides, pathKey } from '../platform.js';
import { extraRoots } from '../config.js';
import { isDirEntry, isFileEntry } from '../fsentry.js';
import { lineIterator } from './lines.js';

/**
 * Grok Build 会话扫描。
 *
 * ## 存储：元数据与正文彻底分离，且两家上游读的正文文件不同
 *
 *   summary.json（元数据，会话目录里递归找，sessions/ + archived_sessions/）
 *     info.id / info.cwd / generated_title（或 session_summary）
 *     created_at / updated_at / last_active_at
 *     parent_session_id / session_kind（CC Switch/MAGPIE 侧字段）
 *
 *   正文，同目录二选一（**目录里出现哪个就读哪个**）：
 *     CC Switch 固定名 chat_history.jsonl —— 行 type ∈ {system,user,assistant,tool}
 *     MAGPIE    updates.jsonl           —— 一行一 ACP 事件
 *       params.update.sessionUpdate ∈ { user_message_chunk, turn_completed, hook_execution, … }
 *       turn_completed 带 usage.modelUsage；timestamp 是秒
 *
 * ## 坑
 *
 * 1. **reasoning 记录含加密/内部态，不是对话消息**：CC Switch 的 load_messages
 *    对 type 不在 {system,user,assistant,tool} 的行一律跳过。这里照做——留着会把
 *    一坨内部态当成一条发言。
 * 2. **活跃正文文件可达数十~上百 MiB**：一律用 lineIterator() 逐行读，上限加在
 *    记录粒度（单行超长只丢那一行，后面的话还在）；parse 找标题时最多读前 2000 行。
 * 3. **两个正文文件都在时行为必须确定**：优先 chat_history.jsonl（CC Switch 的
 *    规范正文、对话形状明确）；只读这一个，绝不把两股消息混进同一场会话。
 * 4. **tool_calls 配对形状上游自标「待核实」**：只取能确定的 name/arguments/id，
 *    不猜配对；type=tool 行的 tool_call_id/call_id 有就记、没有就留空。
 * 5. **title 取第一句真人输入**：正文里拿得到就用它，generated_title /
 *    session_summary 这类应用标题只作兜底。
 *
 * session_kind 以 subagent 开头时标 kind:'subagent' + parent；否则 parent_session_id
 * 是 fork/restore 来源，记 branchOf（不标子代理，免得从主时间线消失）。
 */

export const name = 'grokbuild';

const CHAT = 'chat_history.jsonl';
const UPDATES = 'updates.jsonl';
const TITLE_SCAN_LINES = 2000;
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
    ...envOverrides(['GROK_HOME']),
    path.join(os.homedir(), '.grok'),
  ]);
}

export function candidateRoots() {
  return localRoots();
}

export function discover() {
  return discoverWithin(localRoots(), {});
}

/**
 * 显式数据源：描述「应用根之下」认什么（纯数据）。
 *
 * 派单给的单层 summary.json 探针只匹配一层目录；MAGPIE/CC Switch 的真实布局是
 * `sessions/<URLenc cwd>/<id>/summary.json`（两层）。补一条 `**` 版强特征覆盖真实
 * 布局（`**` 跨 0..8 段，也能匹配一层），否则真实数据会被 scoreStructure 判不中。
 */
export const structureSpec = {
  agent: 'grokbuild',
  probes: [
    { glob: 'sessions/*/summary.json', kind: 'file', weight: 4 },
    { glob: 'sessions/**/summary.json', kind: 'file', weight: 4 },
    { glob: 'sessions/*/chat_history.jsonl', kind: 'file', weight: 2, optional: true },
    { glob: 'sessions/*/updates.jsonl', kind: 'file', weight: 2, optional: true },
    { path: 'sessions', kind: 'dir', weight: 1 },
    { path: 'archived_sessions', kind: 'dir', weight: 1, optional: true },
  ],
  rootAnchor: { from: 'sessions', up: 1, allowSelf: true },
  dataPaths: ['sessions', 'archived_sessions'],
  format: 'grok summary.json 元数据 + chat_history.jsonl / updates.jsonl 正文（分离）',
  minScore: 4,
  dirHints: ['.grok'],
};

/** 显式数据源遍历：roots 是应用根（`.grok` 那一层），递归找 summary.json。 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const root of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
    for (const sub of ['sessions', 'archived_sessions']) {
      collectSummaries(path.join(root, sub), out, seen, WALK_DEPTH);
    }
  }
  return out;
}

function collectSummaries(dir, out, seen, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isFileEntry(e, full) && e.name === 'summary.json') {
      const k = pathKey(full);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(full);
      }
    } else if (depth > 0 && isDirEntry(e, full)) {
      collectSummaries(full, out, seen, depth - 1);
    }
  }
}

function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 时间戳：毫秒数 / 秒数 / 数字字符串 / RFC3339 / ISO。 */
function tsToMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e11 ? v : v * 1000) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n > 1e11 ? n : n * 1000;
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

/** content 可以是字符串、"Hi"、[{type:'text',text}]、{text}。 */
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

function parseMaybeJson(v) {
  if (v == null || typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** 正文文件择一：chat_history.jsonl 优先，其次 updates.jsonl，行为确定。 */
function bodyFileOf(dir) {
  const chat = path.join(dir, CHAT);
  if (isFileSync(chat)) return chat;
  const upd = path.join(dir, UPDATES);
  if (isFileSync(upd)) return upd;
  return null;
}

/** CC Switch 形状的一行 → 一条消息对象（tool_calls 不配对，只取确定字段）。 */
function chatMessage(o) {
  const type = o.type;
  const text = extractText(o.content);
  const ts = tsToMs(o.timestamp ?? o.ts);
  if (type === 'system') {
    const p = textPart(text);
    return p ? { role: 'system', parts: [p], ts, meta: { kind: 'injected' } } : null;
  }
  if (type === 'user') {
    const p = textPart(text);
    return p ? { role: 'user', parts: [p], ts, meta: null } : null;
  }
  if (type === 'assistant') {
    const parts = [];
    const p = textPart(text);
    if (p) parts.push(p);
    for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
      const fn = c.function || c;
      parts.push(toolPart({
        name: fn.name || c.name || 'tool',
        input: parseMaybeJson(fn.arguments ?? c.arguments),
        callId: c.id || null,
      }));
    }
    return parts.length ? { role: 'assistant', parts, ts, meta: null } : null;
  }
  if (type === 'tool') {
    return {
      role: 'tool',
      parts: [toolPart({
        name: 'tool_result',
        callId: o.tool_call_id || o.call_id || null,
        output: text || null,
      })],
      ts,
      meta: null,
    };
  }
  return null;
}

/** turn_completed 的 usage.modelUsage：如实记成一条系统记录（不编对话文本）。 */
function usageMessage(u, o) {
  if (!u.usage || typeof u.usage !== 'object') return null;
  const models = u.usage.modelUsage && typeof u.usage.modelUsage === 'object'
    ? Object.keys(u.usage.modelUsage)
    : [];
  const label = models.length ? `用量记录：${models.join('、')}` : '用量记录';
  const p = textPart(label);
  return {
    role: 'system',
    parts: p ? [p] : [],
    ts: tsToMs(o.timestamp),
    meta: { kind: 'turn_completed', usage: u.usage },
  };
}

/**
 * 逐行把正文摊平成消息对象（generator，不整份读进内存）。
 *
 * 两种形状兼容：CC Switch 的 type 四选一 / MAGPIE 的 params.update.sessionUpdate。
 * user_message_chunk 连续片段累积成一条 user 消息，避免一句话碎成几十条。
 * reasoning / hook_execution / 未知类型一律跳过。
 */
export function* bodyMessages(body, maxLines = Infinity) {
  let n = 0;
  let chunkText = '';
  let chunkTs = null;
  function* flush() {
    if (chunkText.trim()) {
      const p = textPart(chunkText.trim());
      if (p) yield { role: 'user', parts: [p], ts: chunkTs, meta: null };
    }
    chunkText = '';
    chunkTs = null;
  }

  for (const line of lineIterator(body)) {
    if (++n > maxLines) break;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const type = o.type;

    if (type === 'system' || type === 'user' || type === 'assistant' || type === 'tool') {
      yield* flush();
      const m = chatMessage(o);
      if (m) yield m;
      continue;
    }
    // reasoning 记录含加密/内部态，不是对话消息；其它未知 type 也不当对话
    if (type === 'reasoning' || type === 'hook_execution') continue;

    const u = o.params && o.params.update;
    if (u && typeof u === 'object' && u.sessionUpdate) {
      if (u.sessionUpdate === 'user_message_chunk') {
        const t = extractText(u.content);
        if (t) {
          chunkText += t;
          if (chunkTs == null) chunkTs = tsToMs(o.timestamp);
        }
        continue;
      }
      yield* flush();
      if (u.sessionUpdate === 'turn_completed') {
        const m = usageMessage(u, o);
        if (m) yield m;
      }
      // hook_execution 等：跳过（MAGPIE 明确不当对话）
    }
  }
  yield* flush();
}

function readJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

export function parse(file) {
  const o = readJson(file);
  if (!o) return null;
  const info = (o.info && typeof o.info === 'object') ? o.info : {};
  const dir = path.dirname(file);
  const id = (typeof info.id === 'string' && info.id.trim())
    ? info.id.trim()
    : path.basename(dir);

  const startMs = tsToMs(o.created_at);
  const endMs = tsToMs(o.last_active_at) ?? tsToMs(o.updated_at) ?? startMs;

  // 标题优先取正文里的第一句真人输入（最多读前 2000 行，别拖大文件）
  let firstUser = null;
  const body = bodyFileOf(dir);
  if (body) {
    try {
      for (const m of bodyMessages(body, TITLE_SCAN_LINES)) {
        if (m.role === 'user') {
          const p = m.parts.find((x) => x.kind === 'text');
          if (p && p.text.trim()) {
            firstUser = p.text.trim();
            break;
          }
        }
      }
    } catch {
      /* 正文读不了不影响元数据；标题留空由应用标题兜底 */
    }
  }
  const appTitle = (typeof o.generated_title === 'string' && o.generated_title.trim())
    ? o.generated_title.trim()
    : (typeof o.session_summary === 'string' && o.session_summary.trim())
      ? o.session_summary.trim()
      : null;

  const kind = typeof o.session_kind === 'string' ? o.session_kind : '';
  const parent = typeof o.parent_session_id === 'string' ? o.parent_session_id : '';
  const isSubagent = kind.startsWith('subagent');

  return makeSession({
    agent: name,
    id,
    project: (typeof info.cwd === 'string' && info.cwd.trim()) ? info.cwd.trim() : null,
    title: firstUser || appTitle || null,
    start: startMs,
    end: endMs,
    source: file,
    resume: `grok --resume ${id}`,
    kind: isSubagent ? 'subagent' : 'main',
    parent: isSubagent && parent ? parent : null,
    branchOf: !isSubagent && parent ? parent : null,
  });
}

function rootsOf(ctx) {
  return ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
}

/** 读一场会话正文：source 是 summary.json，正文在同目录二选一。 */
export function readMessages(session, ctx = {}) {
  const roots = rootsOf(ctx);
  const summaryFile = assertUnderAny(roots, session.source);
  const dir = path.dirname(summaryFile);
  const body = bodyFileOf(dir);
  if (!body) {
    throw new Error(`读不到 Grok 会话正文（${CHAT} / ${UPDATES} 都不存在）：${dir}`);
  }
  const safe = assertUnderAny(roots, body);
  const out = [];
  for (const m of bodyMessages(safe)) {
    out.push(makeMessage({ role: m.role, parts: m.parts, ts: m.ts, meta: m.meta }));
  }
  return out;
}
