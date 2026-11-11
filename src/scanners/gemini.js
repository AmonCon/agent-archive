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
 * Gemini CLI 会话扫描。
 *
 * ## 存储
 *
 *   <config>/tmp/<hash>/chats/session-*.jsonl     新版「回放日志」
 *   <config>/tmp/<hash>/chats/session-*.json      旧版单对象
 *   <config>/tmp/<hash>/.project_root             项目 cwd（与 chats 同级）
 *
 * 两处上游对文件名的写法略有差异：CC Switch 认 `session-*.json(l)`，
 * MAGPIE 的 `geminiTmpDir()` 认 `chats/*.json`。这里两种都收——
 * chats 目录下的 `.json` / `.jsonl` 都当会话文件，只按扩展名区分解析方式。
 *
 * ## 新版 .jsonl 不是普通 JSONL，是回放日志
 *
 * `loadConversationRecord` 每行是一条「操作」而不是一条消息：
 *
 *   - 带 `id` 的行      原位 upsert 到有序 messages（同 id 覆盖、保持位置）
 *   - `$set`             合并到记录顶层；带 `messages` 时整体替换整个数组
 *   - `$rewindTo`        删掉该 id 对应的那条及它之后的所有消息
 *
 * 回放完得到的对象形如 `{ sessionId, startTime, lastUpdated, messages[] }`。
 * 旧 `.json` 就是这份对象的单文件快照。
 *
 * **同名共存只认 `.jsonl`**：`session-X.json` 与 `session-X.jsonl` 同时存在时，
 * 旧文件是回放日志的旧快照，读它会拿到被 `$rewindTo` 撤销的内容。
 *
 * ## 标题
 *
 * 取 messages 里第一句真人输入。要跳过：
 *   - `<session_context>` / `<hook_context>` 这类上下文注入（按标签形状剥，
 *     不硬编码标签名单）；
 *   - `/` 开头的斜杠命令、`?` 开头的帮助命令。
 *
 * 项目路径只从 `.project_root` 读，读不到返回 null，不猜。
 *
 * ## 对 P0 零依赖
 *
 * `structureSpec` 是纯数据、`discoverWithin` 是纯函数（只 readdir/stat，
 * 不读文件内容），不 import structure.js / source.js / kit.js。
 */

export const name = 'gemini';

/**
 * 本机默认候选根（应用根那一层 `<config>`，通常是 `~/.gemini`）。
 * 顺序：config.extraRoots > 环境变量覆盖 > 平台默认。
 *
 * 环境变量认三种写法：大写 `GEMINI_CONFIG_DIR`（项目惯例）、CC Switch
 * settings 的键名 `gemini_config_dir`、Gemini CLI 自身的 `GEMINI_CLI_HOME`。
 */
function localRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!out.includes(abs)) out.push(abs);
  };
  for (const p of extraRoots(name)) add(p);
  for (const p of envOverrides(['GEMINI_CONFIG_DIR', 'gemini_config_dir', 'GEMINI_CLI_HOME'])) add(p);
  add(path.join(os.homedir(), '.gemini'));
  return out;
}

/** 声明「我会去哪些目录」（doctor / 反向发现用）。 */
export function candidateRoots() {
  return localRoots();
}

/**
 * 声明式结构（给宿主的 identify/scoreStructure 用）。
 *
 * 应用根是 `~/.gemini`（点目录那一层），所有 probes 都相对它：会话在
 * `tmp/<hash>/chats/`，`.project_root` 与 `chats` 同级在 `tmp/<hash>/` 下。
 * rootAnchor 从标志性子路径 `tmp` 上溯 1 层回到应用根；dataPaths 只给 `tmp`，
 * discoverWithin 在它下面逐层找 chats。dirHints 用 `.gemini` 消歧。
 */
export const structureSpec = {
  agent: name,
  probes: [
    { glob: 'tmp/*/chats/session-*.jsonl', kind: 'file', weight: 4 },
    { glob: 'tmp/*/chats', kind: 'dir', weight: 1 },
    { glob: 'tmp/*/.project_root', kind: 'file', weight: 1, optional: true },
  ],
  rootAnchor: { from: 'tmp', up: 1 },
  dataPaths: ['tmp'],
  format: 'gemini-cli-chat-replay-jsonl',
  minScore: 3,
  dirHints: ['.gemini'],
};

/** 契约 A：`discover()` 无参，一行封装。 */
export function discover() {
  return discoverWithin(localRoots(), {});
}

/**
 * 契约 B：`discoverWithin(roots, ctx)` 纯函数。
 *
 * 每个 root 直接就是应用根（`~/.gemini` 那一层）。按 structureSpec.dataPaths
 * （`tmp`）在 root 下找 `tmp/<hash>/chats/` 里的会话文件；同时兼容 root 本身
 * 就是某一层 hash 目录（`<root>/chats` 直接存在）的传法。
 * 只做 readdir/stat，不读文件内容。
 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const root of roots || []) {
    for (const chats of chatDirsUnder(root, structureSpec.dataPaths)) {
      for (const file of sessionFilesIn(chats)) {
        const key = pathKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(file);
      }
    }
  }
  return out;
}

/** 一个应用根下所有可能的 chats 目录（按 dataPaths 下钻 + 兼容 hash 层传法）。 */
function chatDirsUnder(root, dataPaths) {
  const out = [];
  // 兼容：root 本身可能就是 hash 层，chats/ 直接在它下面
  const direct = path.join(root, 'chats');
  if (isDirPath(direct)) out.push(direct);

  // 主路径：dataPaths（tmp）下的每个 hash 目录里找 chats/
  for (const sub of dataPaths) {
    const base = path.join(root, sub);
    if (!isDirPath(base)) continue;
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const hashDir = path.join(base, e.name);
      if (!isDirEntry(e, hashDir)) continue;
      const chats = path.join(hashDir, 'chats');
      if (isDirPath(chats)) out.push(chats);
    }
  }
  return out;
}

/**
 * chats 目录里的会话文件：`.json` 与 `.jsonl` 都收（两种上游写法都认），
 * 同名（去掉扩展名后相同）时**只留 `.jsonl`**。
 */
function sessionFilesIn(chatsDir) {
  const byBase = new Map();
  let entries;
  try {
    entries = fs.readdirSync(chatsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const p = path.join(chatsDir, e.name);
    if (!isFileEntry(e, p)) continue;
    const m = /^(.*)\.(jsonl|json)$/i.exec(e.name);
    if (!m) continue;
    const base = m[1];
    const ext = m[2].toLowerCase();
    const prev = byBase.get(base);
    if (!prev || (prev.ext === 'json' && ext === 'jsonl')) byBase.set(base, { ext, p });
  }
  return [...byBase.values()].map((v) => v.p).sort();
}

/** 读一份会话记录：`.jsonl` 走回放，`.json` 直接整份解。 */
function readRecord(file) {
  if (/\.jsonl$/i.test(file)) {
    const lines = [];
    try {
      for (const line of lineIterator(file)) lines.push(line);
    } catch {
      return null;
    }
    return replayLog(lines);
  }
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * 回放日志 → `{ sessionId, startTime, lastUpdated, messages[] }`。
 *
 * 语义（对应用户给的规格，也对应上游 loadConversationRecord）：
 *   - 带 `id` 的行：原位 upsert（同 id 覆盖该位置，不新增）
 *   - `$set`：其余字段合并进顶层；`messages` 整体替换数组
 *   - `$rewindTo`：删该 id 那条及之后的所有消息
 *   - 无 id / 无操作符的行：当作顶层元数据（header 行）合并
 *
 * 坏行、半行跳过，不因一行坏 JSON 放弃整场会话。
 */
function replayLog(lines) {
  let record = {};
  let messages = [];
  let index = new Map();
  let saw = false;

  const setMessages = (arr) => {
    messages = Array.isArray(arr) ? arr.slice() : [];
    index = new Map();
    messages.forEach((m, i) => {
      const k = idOf(m);
      if (k != null) index.set(k, i);
    });
  };

  const applyObject = (o, skipMessages = false) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === '$set' || k === '$rewindTo' || k === 'id') continue;
      if (k === 'messages') {
        if (!skipMessages) setMessages(v);
        continue;
      }
      record[k] = v;
    }
  };

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    saw = true;

    if ('$rewindTo' in o) {
      const target = String(o.$rewindTo);
      let idx = index.has(target) ? index.get(target) : -1;
      if (idx < 0 && /^\d+$/.test(target)) idx = Number(target); // 也认下标写法
      if (idx >= 0) setMessages(messages.slice(0, idx)); // 删该条及之后
      continue;
    }

    if (o.$set && typeof o.$set === 'object') {
      applyObject(o.$set);
      continue;
    }

    if (o.id != null) {
      const id = String(o.id);
      if (index.has(id)) messages[index.get(id)] = o; // 原位替换
      else {
        index.set(id, messages.length);
        messages.push(o);
      }
      applyObject(o, true); // 同一行上的顶层元数据（sessionId 等）
      continue;
    }

    applyObject(o); // header / 快照行
  }

  if (!saw) return null;
  record.messages = messages;
  return record;
}

function idOf(m) {
  if (!m || typeof m !== 'object') return null;
  const v = m.id != null ? m.id : m.messageId != null ? m.messageId : null;
  return v != null ? String(v) : null;
}

/** `.project_root` 与 chats 同级（都在 tmp/<hash> 下）。读不到就 null。 */
function projectRootOf(file) {
  const hashDir = path.dirname(path.dirname(file));
  const p = path.join(hashDir, '.project_root');
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    const first = raw.split(/\r?\n/)[0].trim().replace(/^["']|["']$/g, '').trim();
    return first || null;
  } catch {
    return null; // 不猜 cwd
  }
}

/** 一个文件一场会话。 */
export function parse(file) {
  const record = readRecord(file);
  if (!record) return null;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const id =
    record.sessionId != null && String(record.sessionId).trim()
      ? String(record.sessionId)
      : path.basename(file).replace(/\.(jsonl|json)$/i, '');
  const project = projectRootOf(file);
  const title = firstUserTitle(messages);

  let start = record.startTime ?? null;
  let end = record.lastUpdated ?? null;
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
    title,
    start,
    end: end || start,
    source: file,
    resume: null, // 不猜恢复命令
    kind: 'main',
    parent: null,
  });
}

/** 第一句真人输入：跳过纯注入、上下文注入块、斜杠/帮助命令。 */
function firstUserTitle(messages) {
  for (const m of messages) {
    if (roleOf(m) !== 'user') continue;
    const t = userText(m);
    if (t) return t;
  }
  return null;
}

/** 按标签形状剥掉注入块；剩下的若以 / 或 ? 开头是命令，不是真人话。 */
function userText(m) {
  const raw = messageText(m);
  if (!raw) return null;
  const t = stripInjections(raw);
  if (!t) return null;
  if (t.startsWith('/') || t.startsWith('?')) return null;
  return t;
}

/** 不硬编码标签名单：成对标签块整体剥掉，残留的单独标签也清掉。 */
function stripInjections(raw) {
  let t = String(raw || '').replace(/<([A-Za-z][\w:.-]*)[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

function roleOf(m) {
  const r = m && (m.role || m.type || m.author || m.speaker);
  if (!r) return null;
  const s = String(r).toLowerCase();
  if (s === 'user' || s === 'human') return 'user';
  if (s === 'model' || s === 'gemini' || s === 'assistant' || s === 'ai') return 'assistant';
  return null;
}

/** content / text / parts[] 几种写法都取得到文本。 */
function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  const c = m.content != null ? m.content : m.text;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = [];
    for (const p of c) {
      if (!p) continue;
      if (typeof p === 'string') parts.push(p);
      else if (typeof p.text === 'string') parts.push(p.text);
      else if (typeof p.content === 'string') parts.push(p.content);
    }
    return parts.join('\n').trim();
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
  return '';
}

/** 工具调用（若该版本写进 messages）压成摘要，不整段塞输出。 */
function toolPartsOf(m) {
  const list = m && (m.toolCalls || m.functionCalls || m.tool_calls || m.tools);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c) continue;
    const name = c.name || c.toolName || (c.function && c.function.name) || 'tool';
    const rawInput = c.args != null ? c.args : c.arguments != null ? c.arguments : c.input != null ? c.input : c.function && c.function.arguments;
    let input = rawInput;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* 原样保留 */
      }
    }
    const output = typeof c.output === 'string' ? c.output : typeof c.result === 'string' ? c.result : null;
    out.push(toolPart({ name, input: input == null ? null : input, callId: c.id || c.callId || null, output, status: c.status || null }));
  }
  return out;
}

/**
 * 读正文。越界校验用 `ctx.roots`（显式数据源）优先，否则本机根——
 * 保证外部备份里的文件不会被 assertUnderAny 误杀。
 */
export function readMessages(session, ctx = {}) {
  const roots = ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
  const file = assertUnderAny(roots, session.source);
  const record = readRecord(file);
  if (!record) throw new Error(`读不到 Gemini 会话文件：${session.source}`);
  const messages = Array.isArray(record.messages) ? record.messages : [];

  const out = [];
  for (const m of messages) {
    const role = roleOf(m);
    const ts = (m && (m.timestamp || m.ts || m.time)) || null;

    if (role === 'user') {
      const text = userText(m);
      if (text) out.push(makeMessage({ role: 'user', parts: [textPart(text)], ts }));
      continue;
    }
    if (role === 'assistant') {
      const text = stripInjections(messageText(m));
      const parts = [];
      if (text) parts.push(textPart(text));
      for (const t of toolPartsOf(m)) parts.push(t);
      if (parts.length) out.push(makeMessage({ role: 'assistant', parts, ts }));
      continue;
    }

    // 角色未知但有工具调用：工具结果单独成条，不冒充谁说的话
    const tools = toolPartsOf(m);
    if (tools.length) out.push(makeMessage({ role: 'tool', parts: tools, ts }));
  }
  return out;
}
