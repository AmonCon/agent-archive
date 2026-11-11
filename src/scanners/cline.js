import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, assertUnderAny } from '../messages.js';
import { extraRoots } from '../config.js';
import { envOverrides, pathKey } from '../platform.js';
import { isDirEntry, isFileEntry, isDirPath } from '../fsentry.js';

/**
 * Cline 会话扫描（MAGPIE 的 JSON 目录形态）。
 *
 * ## 存储（MAGPIE cline.go:14-60）
 *
 *   <sessions>/<id>/<id>.json            manifest：cwd / 起始时间 / 首 prompt /
 *                                        metadata.title / metadata.fork.forkedAt
 *   <sessions>/<id>/<id>.messages.json   { messages: [...] }，正文
 *   <sessions>/<id>/<agent id>.messages.json   子代理转录
 *
 * ⚠️ 按 MAGPIE 的 **JSON 目录形态** 做，不沿用 doctor.js 里旧的
 * `~/.cline/data/db/sessions.db`（空库/加密）「本机无数据」结论——那是另一套
 * 判断，与本扫描器无关。
 *
 * ## 路径链（4 级，按优先级，MAGPIE cline.go:29-43）
 *
 *   $CLINE_SESSION_DATA_DIR
 *   → $CLINE_DATA_DIR/sessions
 *   → $CLINE_DIR/data/sessions
 *   → ~/.cline/data/sessions
 *
 * ## 两个必须锁住的坑
 *
 * 1. **`.messages.json` 是整体重写、非追加**（cline.go:16-18,110-114）。
 *    不能 tail 续读、不能按行增量，必须每次整份 `readFileSync` + `JSON.parse`；
 *    半写坏/读不了就如实返回 null，不假装成「空会话」。
 * 2. **fork 只算 `forkedAt` 之后的消息**（cline.go:22-24,122-129,180-183）。
 *    从别的会话 fork 出来的会以父会话的消息副本开头，那些副本的 `ts` 早于
 *    `metadata.fork.forkedAt`，要截断掉，否则同一次对话被重复记。
 *
 * assistant 消息带 `modelInfo.id` / `ts`(毫秒) / `metrics`。我们是只读档案馆，
 * `ts` 用来定时间，`modelInfo` / `metrics` 是 per-request 用量，不写进消息模型
 * （不计成本、不照抄字段）。
 *
 * 标题取首 prompt（`manifest.prompt`，按标签形状剥掉 Cline 的 `<user_input>`
 * 包装）/ `metadata.title` / 正文第一句 user 输入；拿不到留 null，不猜。
 *
 * ## 对 P0 零依赖
 *
 * structureSpec 纯数据、discoverWithin 纯函数（只 readdir/stat），
 * 不 import structure.js / source.js / kit.js。
 */

export const name = 'cline';

function rawEnv(k) {
  const v = process.env[k];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function expandHome(p) {
  const s = String(p == null ? '' : p).trim();
  if (s === '~') return os.homedir();
  if (/^~[\\/]/.test(s)) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 4 级路径链算出的 sessions 目录（MAGPIE 语义：取第一个命中的）。 */
function clineSessionDir() {
  const d = rawEnv('CLINE_SESSION_DATA_DIR');
  if (d) return expandHome(d);
  const data = rawEnv('CLINE_DATA_DIR');
  if (data) return path.join(expandHome(data), 'sessions');
  const dir = rawEnv('CLINE_DIR');
  if (dir) return path.join(expandHome(dir), 'data', 'sessions');
  return path.join(os.homedir(), '.cline', 'data', 'sessions');
}

/**
 * 本机默认候选根：应用根（`.cline` 层）为主，同时把 4 级链算出的 sessions
 * 目录列进来（discoverWithin 对 root 形态宽容，显式数据源与本机共用一份遍历）。
 */
function localRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p));
    if (!out.some((x) => pathKey(x) === pathKey(abs))) out.push(abs);
  };
  for (const p of extraRoots(name)) add(expandHome(p));
  for (const p of envOverrides(['CLINE_DIR', 'CLINE_HOME'])) add(p);
  add(path.join(os.homedir(), '.cline'));
  add(clineSessionDir());
  return out;
}

/** 声明「我会去哪些目录」。 */
export function candidateRoots() {
  return localRoots();
}

/**
 * 声明式结构：probes 全相对**应用根 `.cline`**。
 * 会话文件在 `data/sessions/<id>/`，单段 `*` 匹配 `<id>`；`minScore 5` 要求
 * 必须有真实 `.messages.json` 才认（光有目录不算）。
 * rootAnchor 从标志性子路径 `data/sessions`(2 段) 上溯 up=2 回到 `.cline`。
 */
export const structureSpec = {
  agent: name,
  probes: [
    { glob: 'data/sessions/*/*.messages.json', kind: 'file', weight: 5 },
    { path: 'data/sessions', kind: 'dir', weight: 1 },
  ],
  rootAnchor: { from: 'data/sessions', up: 2, allowSelf: true },
  dataPaths: ['data/sessions'],
  format: 'cline-manifest-plus-messages-json-whole',
  minScore: 5,
  dirHints: ['.cline'],
};

/** 契约 A：discover() 无参，一行封装。 */
export function discover() {
  return discoverWithin(localRoots(), {});
}

/**
 * 契约 B：纯函数。每个 root 是应用根（`.cline`），按 dataPaths 找 sessions 目录，
 * 再收 `<id>/` 下的 `*.messages.json`。只 readdir/stat，不读文件内容。
 *
 * 对 root 形态宽容：应用根走 `root/data/sessions`；root 是 data 层走
 * `root/sessions`；root 本身叫 `sessions`（4 级链/显式 sessionDir）时直接遍历。
 * 最后一条的 basename 约束避免把随便一个放了无关 .json 的 decoy 误当会话根。
 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const root of roots || []) {
    for (const sessions of clineSessionsDirsUnder(root, structureSpec.dataPaths)) {
      let ids;
      try {
        ids = fs.readdirSync(sessions, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of ids) {
        const dir = path.join(sessions, d.name);
        if (!isDirEntry(d, dir)) continue;
        let files;
        try {
          files = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of files) {
          const p = path.join(dir, e.name);
          if (!isFileEntry(e, p) || !/\.messages\.json$/i.test(e.name)) continue;
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

function clineSessionsDirsUnder(root, dataPaths) {
  const out = [];
  for (const sub of dataPaths) {
    const d = path.join(root, sub);
    if (isDirPath(d)) out.push(d);
  }
  const flat = path.join(root, 'sessions');
  if (isDirPath(flat)) out.push(flat);
  // root 自身就是 sessions 目录（显式 CLINE_SESSION_DATA_DIR 覆盖）：
  //  ① 目录名就叫 sessions；② 或 root 下有 `<id>/<id>.messages.json` 形状的
  //     子目录。decoy 里一堆无关 .json 不会被误命中。
  if (
    !out.length &&
    isDirPath(root) &&
    (pathKey(path.basename(root)) === 'sessions' || hasFlatClineSession(root))
  ) {
    out.push(root);
  }
  return out;
}

/** root 下有 `<id>/…messages.json` 形状的子目录吗（sessions 目录）。 */
function hasFlatClineSession(dir) {
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const sub = path.join(dir, d.name);
      if (!isDirEntry(d, sub)) continue;
      for (const e of fs.readdirSync(sub, { withFileTypes: true })) {
        if (/\.messages\.json$/i.test(e.name)) return true;
      }
    }
  } catch {
    /* 读不到就不认 */
  }
  return false;
}

/**
 * 整份读一份会话：messages +（main 才有）manifest + fork 起点。
 * 返回 null 只表示「正文文件读不了 / 半写坏」，如实不假装空会话。
 *
 * ⚠️ 这里是 `readFileSync` + `JSON.parse` 整份读，**不是**逐行/tail：
 * Cline 每次把 messages.json 整体重写，按行续读会读到上一次的残留。
 */
function readBundle(file) {
  const dirId = path.basename(path.dirname(file));
  const fileId = path.basename(file).replace(/\.messages\.json$/i, '');
  const main = fileId === dirId;

  let manifest = null;
  let since = null;
  if (main) {
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), `${dirId}.json`), 'utf8'));
      const fork = manifest && manifest.metadata && manifest.metadata.fork;
      const forkedAt = fork && fork.forkedAt;
      if (forkedAt != null && forkedAt !== '') {
        const d = new Date(forkedAt);
        if (!Number.isNaN(d.getTime())) since = d.getTime();
      }
    } catch {
      // 没有 manifest / 读不到：如实留空，不猜 cwd/title/fork
    }
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 整体重写可能半写坏；读不了就返回 null
  }
  const all = doc && Array.isArray(doc.messages) ? doc.messages : [];
  // fork 截断：只算 forkedAt 起（含）的消息；无 ts 的无法证明在其之后，跳过。
  const messages =
    since == null
      ? all
      : all.filter((m) => {
          const ts = msOf(m && m.ts);
          return ts != null && ts >= since;
        });

  return { messages, main, dirId, fileId, since, manifest };
}

/** 毫秒时间戳：数字（ms）/ ISO 字符串都能解成毫秒数；解不了返回 null。 */
function msOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e11 ? v : v * 1000) : null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function asDate(v) {
  const ms = msOf(v);
  return ms == null ? null : new Date(ms);
}

/** 按标签形状去掉标签本身、保留标签之间的真人话（不硬编码标签名单）。 */
function clineText(raw) {
  let t = String(raw == null ? '' : raw);
  t = t.replace(/<\/?([A-Za-z][\w:.-]*)\b[^>]*>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t || null;
}

/** content 可以是字符串、parts 数组、{text} 对象。 */
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

function roleOf(m) {
  const s = String((m && m.role) || '').toLowerCase();
  if (s === 'user' || s === 'human') return 'user';
  if (s === 'assistant' || s === 'model' || s === 'ai') return 'assistant';
  return 'tool';
}

/** 正文里第一句真人输入（fork 截断之后的 messages）。 */
function firstUserText(messages) {
  for (const m of messages) {
    if (!m || roleOf(m) !== 'user') continue;
    const t = clineText(contentText(m.content != null ? m.content : m.text));
    if (t) return t;
  }
  return null;
}

function manifestField(manifest, key) {
  return manifest && manifest[key] != null ? manifest[key] : null;
}

/** 一个 .messages.json 一场会话。 */
export function parse(file) {
  const b = readBundle(file);
  if (!b) return null;
  const { messages, main, dirId, fileId, since, manifest } = b;

  const id = main ? dirId : `${dirId}:${fileId}`;
  const project = clineText(manifestField(manifest, 'cwd'));
  const metaTitle = manifest && manifest.metadata ? manifest.metadata.title : null;
  const title =
    clineText(manifestField(manifest, 'prompt')) ||
    clineText(metaTitle) ||
    firstUserText(messages) ||
    null;

  // start 取 manifest.started_at（真实起始时间，不是导入时刻）；fork 时若它早于
  // forkedAt 就不当本会话起点（对齐 MAGPIE cline.go:126-128）。
  let start = asDate(manifestField(manifest, 'started_at'));
  if (since != null && start && start.getTime() < since) start = null;
  let end = null;
  for (const m of messages) {
    const d = asDate(m && m.ts);
    if (!d) continue;
    if (!start || d < start) start = d;
    if (!end || d > end) end = d;
  }
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
    kind: main ? 'main' : 'subagent',
    parent: main ? null : dirId,
  });
}

/**
 * 读正文：整份读（非 tail），越界校验用 ctx.roots（显式数据源）优先，否则本机根。
 * `modelInfo.id` / `metrics` 是 per-request 用量，档案馆只读、不计成本，不写进消息。
 */
export function readMessages(session, ctx = {}) {
  const roots = ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
  const file = assertUnderAny(roots, session.source);
  const b = readBundle(file);
  if (!b) throw new Error(`读不到 Cline 会话文件（整体重写可能半写坏）：${session.source}`);

  const out = [];
  for (const m of b.messages) {
    if (!m) continue;
    const role = roleOf(m);
    const ts = asDate(m.ts);
    const text = clineText(contentText(m.content != null ? m.content : m.text));
    const parts = [];
    if (role === 'user' || role === 'assistant') {
      if (text) parts.push(textPart(text));
    } else if (text) {
      parts.push(toolPart({ name: m.toolName || m.name || 'tool', callId: m.toolCallId || null, output: text }));
    }
    if (!parts.length) continue;
    out.push(makeMessage({ role, parts, ts, meta: null }));
  }
  return out;
}
