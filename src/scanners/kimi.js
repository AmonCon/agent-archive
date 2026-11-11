import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnderAny } from '../messages.js';
import { envOverrides, pathKey } from '../platform.js';
import { extraRoots } from '../config.js';
import { isDirEntry, isFileEntry } from '../fsentry.js';
import { lineIterator } from './lines.js';

/**
 * Kimi Code 会话扫描。
 *
 * ## 存储（两家上游说的是同一个应用根的两种落盘形态）
 *
 *   MAGPIE  (sessions/kimi.go, calls_kimi.go)
 *     sessions/<workdir slug>/<id>/agents/<agent>/wire.jsonl   —— 只追加正文/调用
 *     sessions/<workdir slug>/<id>/state.json                  —— 标题/cwd/时间/父
 *     session_index.jsonl                                     —— 根级，state 缺 cwd 时查它
 *     wire 里的记录：usage.record / turn.prompt / context.append_loop_event(step.end,tool.call)
 *                    / forked / llm.request / metadata …
 *
 *   CC Switch (session_manager/providers/kimi.rs)
 *     sessions/<workspace>/<id>/state.json  或  <id>/session-meta/state.json
 *     sessions/<workspace>/<id>/agents/main/wire.jsonl
 *     wire 里的正文：agent.message.appended / human.agent.message.appended（新）
 *                    / context.append_message（旧）/ agent.switched（分支切换）
 *
 * 所以「两种目录形态都认」= state.json 两个位置都认、agents 下任意 agent 的 wire 都读
 * （CC Switch 只看 main），会话目录允许 1~3 层（不只是 workspace/id 两层）。
 *
 * ## 三个坑
 *
 * 1. **协议 1.0/1.4/1.5 的 usage 与 step.end 顺序不同**：1.4 先 step.end 后 usage、
 *    1.5 反过来，老版还缺 agentId。这里只用 `usage.record` 本身的 time/model/usage，
 *    **绝不拿 step.end 去配 usage**（配错会静默算错一整轮）。
 * 2. **fork 整段复制父 wire，时间都不变**：MAGPIE 在复制段后追加
 *    `{"type":"forked",...}` marker，只有最后一个 marker 之后的记录算 fork 自己的；
 *    没有 marker 的 fork 再按 kimiCallKey(agentId,time,model,usage) 去重。
 * 3. **cwd 可能不在 state.json**：按 cwd > workDir > custom.cwd > session_index.jsonl
 *    的顺序找；都找不到就留 null，**不猜**。
 *
 * 如实留空：CC Switch 的 `agent.switched` 完整「活动分支投影」（沿 base.line 回溯的
 * 树形链）上游是一套 60 行的段/链/环检测算法，本扫描器识别该记录但不猜它的语义，
 * 也不隐藏任何轮次——保留全部记录比投影错更诚实。
 */

export const name = 'kimi';

/** 应用根那一层（`.kimi-code` / `KIMI_CODE_HOME`）。 */
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
  const home = os.homedir();
  return dedupeAbs([
    ...extraRoots(name),
    ...envOverrides(['KIMI_CODE_HOME']),
    path.join(home, '.kimi-code'),
    // dirHints 里的变体名；多一次 readdir 的成本，换变体用户不漏
    path.join(home, '.kimi'),
  ]);
}

export function candidateRoots() {
  return localRoots();
}

export function discover() {
  return discoverWithin(localRoots(), {});
}

/** 显式数据源：描述「应用根之下」认什么（纯数据，宿主靠鸭子类型读取）。 */
export const structureSpec = {
  agent: 'kimi',
  probes: [
    { glob: 'sessions/*/*/agents/*/wire.jsonl', kind: 'file', weight: 4 },
    { glob: 'sessions/*/*/state.json', kind: 'file', weight: 2, optional: true },
    { path: 'sessions', kind: 'dir', weight: 1 },
  ],
  rootAnchor: { from: 'sessions', up: 1, allowSelf: true },
  dataPaths: ['sessions'],
  format: 'kimi wire.jsonl（usage.record/正文）+ state.json（两种位置）',
  minScore: 4,
  dirHints: ['.kimi-code', '.kimi'],
};

/**
 * 显式数据源遍历：roots 里的每一项直接就是应用根（`.kimi-code` 那一层）。
 * 只做 readdir/stat，不读文件内容。返回每个会话目录的一个代表文件路径。
 *
 * 深度放宽到 4 层而不是写死 `<workspace>/<id>`：两家上游的层数不完全一致，
 * 少认一层会静默丢整家会话。
 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const root of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
    const sessions = path.join(root, 'sessions');
    let top;
    try {
      top = fs.readdirSync(sessions, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of top) {
      const full = path.join(sessions, d.name);
      if (!isDirEntry(d, full)) continue;
      collectSessionDirs(full, out, seen, 4);
    }
  }
  return out;
}

function collectSessionDirs(dir, out, seen, depth) {
  const key = pathKey(dir);
  if (seen.has(key)) return;
  if (isSessionDir(dir)) {
    seen.add(key);
    const rep = representativeOf(dir);
    if (rep) out.push(rep);
    return;
  }
  if (depth <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isDirEntry(e, full)) collectSessionDirs(full, out, seen, depth - 1);
  }
}

/** 会话目录：有 state.json（两个位置）或 agents 子目录下的 wire.jsonl 即算。 */
function isSessionDir(dir) {
  if (isFileSync(path.join(dir, 'state.json'))) return true;
  if (isFileSync(path.join(dir, 'session-meta', 'state.json'))) return true;
  return allWireFiles(dir).length > 0;
}

/** 代表文件：优先 main 的 wire，其次任意 agent 的 wire，最后 state.json。 */
function representativeOf(dir) {
  const wires = allWireFiles(dir);
  const main = wires.find((w) => path.basename(path.dirname(w)) === 'main');
  if (main) return main;
  if (wires.length) return wires[0];
  for (const rel of ['state.json', path.join('session-meta', 'state.json')]) {
    const p = path.join(dir, rel);
    if (isFileSync(p)) return p;
  }
  return null;
}

/** agents 下所有 agent 的 wire.jsonl（main 排前，其余字典序）。 */
function allWireFiles(dir) {
  const agents = path.join(dir, 'agents');
  let names;
  try {
    names = fs.readdirSync(agents, { withFileTypes: true })
      .filter((e) => isDirEntry(e, path.join(agents, e.name)))
      .map((e) => e.name);
  } catch {
    return [];
  }
  names.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  const out = [];
  for (const n of names) {
    const w = path.join(agents, n, 'wire.jsonl');
    if (isFileSync(w)) out.push(w);
  }
  return out;
}

/** 代表文件 → 会话目录（agents 段之上 / session-meta 之上 / state.json 所在层）。 */
function sessionDirOf(file) {
  const parts = String(file).split(/[\\/]/);
  const ai = parts.lastIndexOf('agents');
  if (ai >= 2) return parts.slice(0, ai).join(path.sep);
  const d = path.dirname(file);
  if (path.basename(d) === 'session-meta') return path.dirname(d);
  return d;
}

/** 代表文件 → 应用根（sessions 段的父目录），用于查 session_index.jsonl。 */
function homeOf(file) {
  const parts = String(file).split(/[\\/]/);
  const i = parts.lastIndexOf('sessions');
  return i > 0 ? parts.slice(0, i).join(path.sep) : null;
}

function readState(dir) {
  for (const rel of ['state.json', path.join('session-meta', 'state.json')]) {
    const p = path.join(dir, rel);
    try {
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (o && typeof o === 'object') return o;
    } catch {
      /* 试下一个位置 */
    }
  }
  return null;
}

/** 时间戳：毫秒数 / 秒数 / 数字字符串 / RFC3339 / ISO。拿不到返回 null。 */
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

function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** cwd：cwd > workDir > custom.cwd > session_index.jsonl 的 workDir。 */
function projectOf(st, file, id) {
  if (st) {
    for (const v of [st.cwd, st.workDir, st.custom && st.custom.cwd]) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  const home = homeOf(file);
  return home ? indexedWorkDir(home, id) : null;
}

/** session_index.jsonl：一行一场，{sessionId, workDir}；tombstone 行跳过。 */
function indexedWorkDir(home, id) {
  const file = path.join(home, 'session_index.jsonl');
  try {
    for (const line of lineIterator(file)) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || o.deleted) continue;
      if (o.sessionId === id || o.id === id) {
        const wd = o.workDir || o.cwd;
        if (typeof wd === 'string' && wd.trim()) return wd.trim();
      }
    }
  } catch {
    /* 没有索引文件是正常状态 */
  }
  return null;
}

function customTitleOf(st) {
  if (!st) return null;
  if (typeof st.customTitle === 'string' && st.customTitle.trim()) return st.customTitle.trim();
  if (typeof st.title === 'string' && st.title.trim() && (st.isCustomTitle === true || st.titleKind === 'custom')) {
    return st.title.trim();
  }
  return null;
}

function appTitleOf(st) {
  return st && typeof st.title === 'string' && st.title.trim() ? st.title.trim() : null;
}

const MESSAGE_TYPES = new Set([
  'agent.message.appended',
  'human.agent.message.appended',
  'context.append_message',
]);
const INJECTION_KINDS = new Set(['injection', 'system_trigger', 'retry', 'compaction_summary']);

function isMessageRecord(o) {
  return !!o && MESSAGE_TYPES.has(o.type);
}

function rawMessageOf(o) {
  if (o.type === 'context.append_message') return o.message || null;
  return (o.message && o.message.message) || null;
}

function isInjected(o, raw) {
  const kind = (o.meta && o.meta.origin && o.meta.origin.kind)
    || (raw && raw.origin && raw.origin.kind)
    || (o.origin && o.origin.kind);
  return INJECTION_KINDS.has(kind);
}

/** content 可以是字符串、[{type:'text',text}]、[{text}]、{text}。 */
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

/** turn.prompt（origin.kind==='user'）里的真人输入文本。 */
function promptText(o) {
  if (!o || o.type !== 'turn.prompt') return null;
  if (!o.origin || o.origin.kind !== 'user') return null;
  const parts = Array.isArray(o.input) ? o.input : [];
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')
    .trim() || null;
}

function userTextOf(o, hasHuman) {
  if (isMessageRecord(o)) {
    const raw = rawMessageOf(o);
    if (!raw || raw.role !== 'user' || isInjected(o, raw)) return null;
    return extractText(raw.content || raw.text) || null;
  }
  // 没有新版投影时才把 turn.prompt 当真人首句，避免与正文重复
  if (!hasHuman) return promptText(o);
  return null;
}

/** 扫一遍 wire：第一句真人输入 + 时间范围（fork 复制段按 marker 截断）。 */
function scanWires(wires) {
  let firstUser = null;
  let startMs = null;
  let endMs = null;
  for (const w of wires) {
    const local = [];
    try {
      for (const line of lineIterator(w)) {
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o && o.type === 'forked') {
          local.length = 0; // 复制段是父的，不算这个 fork 自己的
          continue;
        }
        local.push(o);
      }
    } catch {
      continue;
    }
    const hasHuman = local.some(isMessageRecord);
    for (const o of local) {
      const t = tsToMs(o && o.time);
      if (t != null) {
        if (startMs == null || t < startMs) startMs = t;
        if (endMs == null || t > endMs) endMs = t;
      }
      if (!firstUser) {
        const txt = userTextOf(o, hasHuman);
        if (txt && !/^\s*<[^>]+>\s*$/.test(txt)) firstUser = txt;
      }
    }
  }
  return { firstUser, startMs, endMs };
}

export function parse(file) {
  const dir = sessionDirOf(file);
  if (!dir) return null;
  const st = readState(dir);
  const wires = allWireFiles(dir);
  if (!st && !wires.length) return null;

  // CC Switch 的过滤：archived / 子会话（custom.session_kind==='child'）不列
  if (st && (st.archived === true || (st.custom && st.custom.session_kind === 'child'))) return null;

  const id = path.basename(dir);
  const info = scanWires(wires);
  const startMs = tsToMs(st && st.createdAt) ?? info.startMs;
  const endMs = tsToMs(st && st.updatedAt)
    ?? tsToMs(st && st.lastActiveAt)
    ?? info.endMs
    ?? startMs;

  return makeSession({
    agent: name,
    id,
    project: projectOf(st, file, id),
    title: info.firstUser || customTitleOf(st) || appTitleOf(st) || null,
    start: startMs,
    end: endMs,
    source: file,
    resume: `kimi --session ${id}`,
    branchOf: (st && st.forkedFrom) || null,
  });
}

/** 一条 usage.record 的去重键（MAGPIE 的 kimiCallKey：agent,time,model,usage）。 */
function usageKey(o) {
  let usage = '';
  try {
    usage = JSON.stringify(o.usage || {});
  } catch {
    usage = '';
  }
  return `${o.agentId || ''}|${o.time || ''}|${o.model || ''}|${usage}`;
}

function usageLabel(o) {
  const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : '未知模型';
  return `用量记录：${model}`;
}

/** 一条 wire 记录 → 0~多条消息对象（不含 turn.prompt 的兜底，那个在外层处理）。 */
function recordsToMessages(o, hasHuman) {
  if (!o || typeof o !== 'object') return [];
  const ts = tsToMs(o.time);

  // 只用 usage.record 本身：不读 step.end、不与它配对，协议 1.4/1.5 都一样
  if (o.type === 'usage.record') {
    const p = textPart(usageLabel(o));
    return [{
      role: 'system',
      parts: p ? [p] : [],
      ts,
      meta: {
        kind: 'usage.record',
        key: usageKey(o),
        agentId: o.agentId || null,
        model: o.model || null,
        usage: o.usage || null,
      },
    }];
  }

  if (isMessageRecord(o)) {
    const raw = rawMessageOf(o);
    if (!raw) return [];
    const role = raw.role;
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) return [];
    const injected = role === 'system' || isInjected(o, raw);
    const parts = [];
    if (role === 'tool') {
      const text = extractText(raw.content);
      parts.push(toolPart({
        name: 'tool_result',
        callId: raw.toolCallId || null,
        output: text || null,
      }));
    } else {
      const content = raw.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || !c.type) continue;
          if (c.type === 'text') {
            const p = textPart(c.text);
            if (p) parts.push(p);
          } else if (c.type === 'think') {
            const p = reasoningPart(c.think);
            if (p) parts.push(p);
          }
        }
      } else {
        const p = textPart(extractText(content));
        if (p) parts.push(p);
      }
      for (const c of Array.isArray(raw.toolCalls) ? raw.toolCalls : []) {
        parts.push(toolPart({
          name: c.name || 'tool',
          input: c.arguments === undefined ? null : c.arguments,
          callId: c.id || null,
        }));
      }
    }
    if (!parts.length) return [];
    return [{
      role: injected ? 'system' : role,
      parts,
      ts,
      meta: injected ? { kind: 'cli-noise' } : null,
    }];
  }

  // agent.switched / step.end / step.begin / llm.request / metadata / forked …
  // 都不是对话消息，也不参与 usage 配对。识别但不猜语义（见文件头说明）。
  return [];
}

function rootsOf(ctx) {
  return ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
}

/**
 * 读正文：同一个会话目录下所有 agent 的 wire.jsonl 一起读。
 * ctx.roots 存在时优先用它做越界校验（外部数据源的文件不该被本机根误杀）。
 */
export function readMessages(session, ctx = {}) {
  const roots = rootsOf(ctx);
  const file = assertUnderAny(roots, session.source);
  const dir = sessionDirOf(file);
  if (!dir) throw new Error(`读不到 Kimi 会话目录：${session.source}`);
  const wires = allWireFiles(dir);

  const out = [];
  const seenUsage = new Set();
  for (const w of wires) {
    const safe = assertUnderAny(roots, w);
    const local = [];
    for (const line of lineIterator(safe)) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && o.type === 'forked') {
        local.length = 0;
        continue;
      }
      local.push(o);
    }
    const hasHuman = local.some(isMessageRecord);

    // 老版 wire 只有 turn.prompt 没有 message.appended：补成 user 消息
    const leading = [];
    if (!hasHuman) {
      for (const o of local) {
        const t = promptText(o);
        if (t) leading.push(makeMessage({ role: 'user', parts: [textPart(t)], ts: tsToMs(o && o.time) }));
      }
    }

    for (const m of leading) out.push(m);
    for (const o of local) {
      for (const m of recordsToMessages(o, hasHuman)) {
        if (m.meta && m.meta.kind === 'usage.record') {
          if (seenUsage.has(m.meta.key)) continue; // fork 复制的 usage 只算一次
          seenUsage.add(m.meta.key);
        }
        out.push(makeMessage(m));
      }
    }
  }
  return out;
}
