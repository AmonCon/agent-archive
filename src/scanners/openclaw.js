import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, assertUnderAny } from '../messages.js';
import { extraRoots } from '../config.js';
import { envOverrides, pathKey } from '../platform.js';
import { isDirEntry, isFileEntry, isDirPath } from '../fsentry.js';
import { lineIterator } from './lines.js';

/**
 * OpenClaw 会话扫描。
 *
 * ## 存储
 *
 *   <config>/agents/<agent>/sessions/*.jsonl
 *   <config>/agents/<agent>/sessions.json   旁路索引（displayName）
 *
 * `<config>` 默认 `~/.openclaw`；本机实测的变体目录叫 `~/.openclaw-autoclaw`，
 * 布局相同，一起纳入候选根（candidateRoots 里声明，doctor 才不会自相矛盾）。
 *
 * ## 格式
 *
 * JSONL，与 Pi 同构但**没有树形分支**：按文件顺序全取，不做活动分支投影。
 *
 *   - `type=session` 的 `id` / `cwd` / `timestamp`（header，元数据）
 *   - `type=message` 的 `message.role` / `message.content`
 *   - 其余类型（model_change / compaction / thinking …）是运行时记录，不当对话
 *
 * 标题优先级：`sessions.json` 里的 `displayName` > 第一句真人 user 输入 > null。
 * 网关注入会在用户文本尾部追加 `\n[message_id: …]`，标题和正文都要剥掉。
 *
 * ## 对 P0 零依赖
 *
 * `structureSpec` 纯数据、`discoverWithin` 纯函数（只 readdir/stat），
 * 不 import structure.js / source.js / kit.js。
 */

export const name = 'openclaw';

/** 本机默认候选根（应用根那一层）。 */
function localRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!out.includes(abs)) out.push(abs);
  };
  for (const p of extraRoots(name)) add(p);
  // CC Switch settings 的键名 openclaw_config_dir；大写是项目惯例写法
  for (const p of envOverrides(['OPENCLAW_CONFIG_DIR', 'openclaw_config_dir'])) add(p);
  add(path.join(os.homedir(), '.openclaw'));
  add(path.join(os.homedir(), '.openclaw-autoclaw')); // 本机实测变体名，布局相同
  return out;
}

/** 声明「我会去哪些目录」。必须包含 `.openclaw-autoclaw` 变体。 */
export function candidateRoots() {
  return localRoots();
}

/**
 * 声明式结构（相对应用根 = `.openclaw` / `.openclaw-autoclaw` 那一层）。
 *
 * rootAnchor 从标志性子路径 `agents` 上溯 1 层回到应用根；allowSelf 表示
 * 直接把 `agents` 这一层当根时也认。dataPaths 是 discoverWithin 要扫的子目录。
 */
export const structureSpec = {
  agent: name,
  probes: [
    { glob: 'agents/*/sessions/*.jsonl', kind: 'file', weight: 4 },
    { path: 'sessions.json', kind: 'file', weight: 1, optional: true },
  ],
  rootAnchor: { from: 'agents', up: 1, allowSelf: true },
  dataPaths: ['agents'],
  format: 'openclaw-pi-jsonl',
  minScore: 3,
  dirHints: ['.openclaw', '.openclaw-autoclaw'],
};

/** 契约 A：`discover()` 无参，一行封装。 */
export function discover() {
  return discoverWithin(localRoots(), {});
}

/** 契约 B：纯函数。root 就是应用根，按 dataPaths（agents）下钻找 sessions/。 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const root of roots || []) {
    for (const sub of structureSpec.dataPaths) {
      const base = path.join(root, sub);
      if (!isDirPath(base)) continue;
      let agents;
      try {
        agents = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const a of agents) {
        const agentDir = path.join(base, a.name);
        if (!isDirEntry(a, agentDir)) continue;
        const sessionsDir = path.join(agentDir, 'sessions');
        if (!isDirPath(sessionsDir)) continue;
        let entries;
        try {
          entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const p = path.join(sessionsDir, e.name);
          if (!isFileEntry(e, p) || !/\.jsonl$/i.test(e.name)) continue;
          const key = pathKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(p);
        }
      }
    }
  }
  return out.sort();
}

/** 逐行读 JSON 对象；坏行/半行跳过，文件读不到返回 null。 */
function readRows(file) {
  const out = [];
  try {
    for (const line of lineIterator(file)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && typeof o === 'object') out.push(o);
    }
  } catch {
    return null;
  }
  return out;
}

/** 一个文件一场会话。 */
export function parse(file) {
  const rows = readRows(file);
  if (!rows || !rows.length) return null;

  let id = null;
  let project = null;
  let start = null;
  let end = null;
  let firstUser = null;

  for (const o of rows) {
    const d = asDate(o.timestamp);
    if (d) {
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }
    if (o.type === 'session') {
      if (o.id != null && String(o.id).trim()) id = String(o.id);
      const cwd = o.cwd || (o.session && o.session.cwd);
      if (!project && typeof cwd === 'string' && cwd.trim()) project = cwd.trim();
      continue;
    }
    if (o.type === 'message' && !firstUser) {
      const msg = o.message || o;
      if (roleOf(msg) === 'user') {
        const t = humanText(contentText(msg.content != null ? msg.content : msg.text));
        if (t) firstUser = t;
      }
    }
  }

  if (!id) id = path.basename(file, '.jsonl');
  const display = displayNameFor(file, id);

  if (!start && !end) {
    try {
      const st = fs.statSync(file);
      start = st.mtime;
      end = st.mtime;
    } catch {
      return null;
    }
  }

  return makeSession({
    agent: name,
    id,
    project,
    title: display || firstUser || null, // displayName 优先于首条 user，拿不到不猜
    start,
    end: end || start,
    source: file,
    resume: null, // 网关管理，没有恢复命令
    kind: 'main',
    parent: null,
  });
}

/**
 * 读正文：无树形分支，按文件顺序全取。
 * 越界校验用 `ctx.roots`（显式数据源）优先，否则本机根。
 */
export function readMessages(session, ctx = {}) {
  const roots = ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
  const file = assertUnderAny(roots, session.source);
  const rows = readRows(file);
  if (!rows) throw new Error(`读不到 OpenClaw 会话文件：${session.source}`);

  const out = [];
  for (const o of rows) {
    if (o.type !== 'message') continue; // header 与运行时记录不是对话
    const msg = o.message || o;
    const role = roleOf(msg);
    const raw = contentText(msg.content != null ? msg.content : msg.text);
    const parts = [];

    if (role === 'user') {
      const t = humanText(raw);
      if (t) parts.push(textPart(t));
    } else if (role === 'assistant') {
      const t = plainText(raw);
      if (t) parts.push(textPart(t));
    }
    for (const p of contentToolParts(msg.content)) parts.push(p);
    if (!parts.length) continue;

    const outRole = role === 'user' || role === 'assistant' ? role : 'tool';
    out.push(makeMessage({ role: outRole, parts, ts: asDate(o.timestamp) }));
  }
  return out;
}

/** sessions.json 的 displayName：agent 目录 / sessions 目录 / 应用根三处都试。 */
function displayNameFor(file, id) {
  const sessionsDir = path.dirname(file);
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  const appRoot = path.dirname(agentsDir);
  const candidates = [
    path.join(agentDir, 'sessions.json'),
    path.join(sessionsDir, 'sessions.json'),
    path.join(appRoot, 'sessions.json'),
  ];
  let map = new Map();
  for (const c of candidates) {
    try {
      map = parseDisplayMap(JSON.parse(fs.readFileSync(c, 'utf8')));
    } catch {
      continue;
    }
    if (map.size) break;
  }
  if (!map.size) return null;
  return map.get(String(id)) || map.get(path.basename(file, '.jsonl')) || null;
}

/** sessions.json 形状宽容：对象映射 / {sessions:[…]} / 数组 / 字符串值都认。 */
function parseDisplayMap(o) {
  const map = new Map();
  if (!o || typeof o !== 'object') return map;
  const add = (key, v) => {
    if (key == null) return;
    const name =
      typeof v === 'string' ? v : v && typeof v === 'object' ? v.displayName || v.title || v.name : null;
    if (name) map.set(String(key), String(name));
  };
  const list = Array.isArray(o) ? o : Array.isArray(o.sessions) ? o.sessions : null;
  if (list) {
    for (const e of list) {
      if (e && typeof e === 'object') add(e.id || e.sessionId || e.key || e.session_id, e);
    }
    return map;
  }
  const src = o.sessions && typeof o.sessions === 'object' ? o.sessions : o;
  for (const [k, v] of Object.entries(src)) add(k, v);
  return map;
}

function roleOf(m) {
  const s = m && String(m.role || '').toLowerCase();
  if (s === 'user' || s === 'human') return 'user';
  if (s === 'assistant' || s === 'model' || s === 'ai') return 'assistant';
  return null;
}

/** content 可以是字符串、对象、parts 数组。 */
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (!c) continue;
      if (typeof c === 'string') parts.push(c);
      else if (typeof c.text === 'string') parts.push(c.text);
      else if (typeof c.content === 'string') parts.push(c.content);
    }
    return parts.join('\n').trim();
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** 剥掉网关追加在尾部的 `\n[message_id: …]` 注入。 */
function stripGatewayTail(text) {
  return String(text || '').replace(/\s*\n?\[message_id:\s*[^\]]*\]\s*$/i, '');
}

/** 真人输入：剥网关注入 + 按形状剥 <tag>…</tag> 上下文块；剩下为空就不是人话。 */
function humanText(raw) {
  let t = stripGatewayTail(String(raw || ''));
  if (!t) return null;
  t = t
    .replace(/<([A-Za-z][\w:.-]*)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

/** 助手文本只剥网关尾部，不做标签剥离（代码块里的 `<tag>` 要留着）。 */
function plainText(raw) {
  const t = stripGatewayTail(String(raw || '')).trim();
  return t || null;
}

/** content 数组里的工具调用/结果压成摘要。 */
function contentToolParts(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const t = String(c.type || '');
    if (t === 'tool_use' || t === 'tool_call' || t === 'function_call') {
      const input = c.input != null ? c.input : c.arguments != null ? c.arguments : null;
      out.push(toolPart({ name: c.name || 'tool', input, callId: c.id || c.callId || null }));
    } else if (t === 'tool_result' || t === 'function_call_result') {
      const output = typeof c.output === 'string' ? c.output : typeof c.content === 'string' ? c.content : null;
      out.push(
        toolPart({
          name: c.name || 'tool',
          callId: c.tool_use_id || c.callId || c.id || null,
          output,
          status: c.is_error ? 'error' : c.status || null,
        })
      );
    }
  }
  return out;
}

function asDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
