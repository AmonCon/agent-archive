import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnderAny } from '../messages.js';
import { extraRoots } from '../config.js';
import { envOverrides, pathKey } from '../platform.js';
import { isDirEntry, isFileEntry, isDirPath } from '../fsentry.js';
import { lineIterator } from './lines.js';

/**
 * Pi 会话扫描（`~/.pi`），并导出**解析核心**给同构的 omp 复用。
 *
 * ## 存储（CC Switch providers_pi.rs + MAGPIE pi.go）
 *
 *   ~/.pi/agent/sessions/**\/*.jsonl     默认（按项目分子目录，或子代理/fork 嵌套）
 *   <sessionDir>/*.jsonl                settings.sessionDir / PI_CODING_AGENT_SESSION_DIR
 *   ~/.pi/agent/settings.json          含 sessionDir 覆盖
 *
 * 一个文件一场会话：`<time>_<id>.jsonl`（MAGPIE）。首条有效 JSON 是
 * `type=session` 的 header `{id,cwd,timestamp,version,title}`；其后每行一个
 * entry，带 `id` / `parentId`，类型 `message` / `session_info` / `model_change` /
 * `title_change` / `usage`(omp 的 `model_usage`) / `compaction` / `branch_summary`。
 * assistant 的 `message` 里带 `provider` / `model` / `usage` / `responseId` /
 * `durationMs`。
 *
 * ## 核心：会话树 + 活动分支投影（本轮唯一硬骨头）
 *
 * Pi 把会话存成一棵**树**：每个 entry 的 `parentId` 指向父 entry 的 `id`，
 * 「编辑重发 / 重新生成 / 分叉」会追加一条 parentId 指回旧节点的新分支，
 * 被撤销的那条分支仍留在文件里，但不再是当前对话。对齐 CC Switch
 * `providers_pi.rs:368-436` 的 `read_tree`：
 *
 *   1. `latest_id` = 文件中**最后一个有合法 identity 的 entry 的 id**（不是 header
 *      里的某字段）；重复 id 以**最后出现**的为准（fork 复制父 entries 时 id/时间
 *      原样保留，这里按 id 去重，效果等价于 MAGPIE 的「按 id+time 去重、只算
 *      header 之后」）。
 *   2. 从 `latest_id` 沿 `parentId` 回溯，收集落在链上的 `active_entry_indexes`；
 *      **不在链上的 entry（被撤销/分叉的轮次）一律不投影**。
 *   3. 回溯带环检测（visited）与缺父容忍：遇到环或引用了不存在的 id 就停在
 *      「能确定的主干」，绝不虚构分支、绝不死循环。
 *   4. 投影结果按**文件顺序**（entry_index 升序）输出，不按回溯顺序。
 *   5. version < 2 是老格式：没有 id/parentId，用 `legacy-N` 串成一条线性链。
 *
 * 上限（pi.rs:18-20）：MAX_TREE_ENTRIES=500k / MAX_SESSION_BYTES=128MiB /
 * MAX_TREE_ID_BYTES=256；id 还须符合 `is_valid_tree_id`（首尾字母数字、中段
 * `[A-Za-z0-9_.-]`）。超限/无 header 就如实返回 null，不硬解。
 *
 * ## 标题与「网关调用」
 *
 * 标题按项目规矩取**第一句真人输入**（活动分支上第一条 user 消息，按标签形状
 * 剥掉注入）；显式标题槽（header.title / `session_info.name` / `type:title` /
 * `title_change`，取全局最后一个）仅作兜底——omp 用 Dialect 把它提到优先位。
 * `provider === 'magpie' | 'dial'` 是网关调用：档案馆只读，把它当普通消息进
 * 正文，但**不作为成本来源**（usage/model/provider 都不写进消息模型）。
 *
 * ## 对 P0 零依赖
 *
 * structureSpec 纯数据、discoverWithin 纯函数（只 readdir/stat），
 * 不 import structure.js / source.js / kit.js。
 */

export const name = 'pi';

/** 与 CC Switch pi.rs:18-20 一致的安全上限。 */
const MAX_TREE_ENTRIES = 500_000;
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_TREE_ID_BYTES = 256;
/** 遍历深度上限，对齐 structure.js 的 `**`（0..8 段）。 */
const WALK_MAX_DEPTH = 8;

/** Dialect：pi 与 omp 共用整份解析器，只靠行为位区分（对齐 CC Switch pi.rs:56-76）。 */
export const PI_DIALECT = Object.freeze({
  // 标题优先级：false = 第一句真人输入优先（项目规矩）；true = 显式标题槽优先。
  titleSlotFirst: false,
  // 恢复命令前缀；omp 走 env 前缀、拿不准，留 null 不猜。
  resume: 'pi --session',
});

/** 造一份 Dialect（omp 用它覆盖行为位，不复制解析器）。 */
export function makeDialect(overrides = {}) {
  return Object.freeze({ ...PI_DIALECT, ...overrides });
}

/**
 * 本机默认候选根。按 lead 口径以「应用根（点目录 `.pi` 那一层）」为主，
 * 同时把环境变量直接指到的 agent / session 目录也列进来（discoverWithin 对
 * root 形态宽容）。顺序：config.extraRoots > 环境变量 > 平台默认。
 *
 * `PI_CODING_AGENT_SESSION_DIR` 与 `settings.json.sessionDir` 若是**相对路径**
 * 明确不枚举（CC Switch pi.rs:78-88,204-215：相对值依赖启动进程 cwd，全局
 * 会话浏览器没有权威 cwd）；只有绝对路径（含展开 `~/`）才收。
 */
function localRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p));
    if (!out.some((x) => pathKey(x) === pathKey(abs))) out.push(abs);
  };

  for (const p of extraRoots(name)) add(expandHome(p));
  // CC Switch settings 的 pi_config_dir / 大写环境变量（应用根那一层）
  for (const p of envOverrides(['PI_CONFIG_DIR', 'pi_config_dir'])) add(p);

  const agentDirs = envOverrides(['PI_CODING_AGENT_DIR']);
  for (const p of agentDirs) add(p);

  // 默认应用根（.pi 那一层）
  add(path.join(os.homedir(), '.pi'));

  // settings.json 的 sessionDir：只读绝对路径
  for (const d of [...agentDirs, path.join(os.homedir(), '.pi', 'agent')]) {
    const sd = readSessionDirSetting(d);
    if (sd) add(sd);
  }
  // 环境变量 sessionDir：相对值不枚举
  const raw = rawEnv('PI_CODING_AGENT_SESSION_DIR');
  if (raw) {
    const expanded = expandHome(raw);
    if (path.isAbsolute(expanded)) add(expanded);
  }
  return out;
}

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

/** settings.json 里的 sessionDir（绝对才收；jsonc/坏文件读不了就跳过，不猜）。 */
function readSessionDirSetting(agentDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const sd = o && o.sessionDir;
    if (typeof sd !== 'string' || !sd.trim()) return null;
    const expanded = expandHome(sd);
    return path.isAbsolute(expanded) ? expanded : null;
  } catch {
    return null;
  }
}

/** 声明「我会去哪些目录」（doctor / 反向发现用）：覆盖 discover() 会扫的所有根。 */
export function candidateRoots() {
  return localRoots();
}

/**
 * 声明式结构：probes 全相对**应用根 `.pi`**。
 *
 * 会话文件在 `agent/sessions` 下，`**` 跨 0..8 段同时覆盖两种布局：
 *   - MAGPIE 的 `<time>_<id>.jsonl`（flat，0 段）
 *   - CC Switch 的 `sessions/<project>/*.jsonl` 与子代理/fork 嵌套（多段）
 * `agent/settings.json` 是可选旁路（sessionDir 覆盖）。
 * rootAnchor 从标志性子路径 `agent`(1 段) 上溯 up=1 回到 `.pi`；
 * allowSelf 允许「直接把 agent 这一层当根」的传法。
 * dirHints 用 `.pi`：与 omp 的 probes 完全同形，宿主 identify() 靠唯一
 * dirHintMatch 消歧（同构绝不按分数猜）。
 */
export const structureSpec = {
  agent: name,
  probes: [
    { glob: 'agent/sessions/**/*.jsonl', kind: 'file', weight: 4 },
    { path: 'agent/sessions', kind: 'dir', weight: 1 },
    { path: 'agent/settings.json', kind: 'file', weight: 1, optional: true },
  ],
  rootAnchor: { from: 'agent', up: 1, allowSelf: true },
  dataPaths: ['agent/sessions'],
  format: 'pi-session-tree-jsonl',
  minScore: 4,
  dirHints: ['.pi'],
};

/** 契约 A：discover() 无参，一行封装。 */
export function discover() {
  return discoverWithin(localRoots(), {});
}

/** 契约 B：纯函数。每个 root 是应用根，按 dataPaths 找会话文件。 */
export function discoverWithin(roots, ctx = {}) {
  return walkPiFiles(roots, structureSpec.dataPaths);
}

/**
 * 共享遍历核心（pi 与 omp 复用）：只 readdir/stat，不读文件内容。
 *
 * 对 root 形态宽容：标准应用根走 `root/<dataPath>`；root 本身就是 agent 层时
 * 走 `root/sessions`；root 本身就是名为 `sessions` 的目录（显式 sessionDir）
 * 时直接遍历 root。最后一条加了 basename 约束，避免把一个随便放了几份
 * 无关 .jsonl 的 decoy 目录误当会话根。
 */
export function walkPiFiles(roots, dataPaths = ['agent/sessions']) {
  const out = [];
  const seen = new Set();
  const visitedDirs = new Set();
  for (const root of roots || []) {
    for (const dir of piSessionDirsUnder(root, dataPaths)) {
      collectJsonl(dir, out, seen, visitedDirs, 0);
    }
  }
  return out.sort();
}

function piSessionDirsUnder(root, dataPaths) {
  const out = [];
  for (const sub of dataPaths) {
    const d = path.join(root, sub);
    if (isDirPath(d)) out.push(d);
  }
  const flat = path.join(root, 'sessions');
  if (isDirPath(flat)) out.push(flat);
  // root 自身就是 sessions 目录（显式 PI_CODING_AGENT_SESSION_DIR 覆盖）：
  //  ① 目录名就叫 sessions；② 或 root 下有符合 MAGPIE `<time>_<id>.jsonl`
  //     形状的扁平会话文件（pi.go:86-91）。decoy 的 random.jsonl 不含 `_`，
  //     不会误命中。「相对 sessionDir 不可全局枚举」由 localRoots 的绝对路径检查把关。
  if (
    !out.length &&
    isDirPath(root) &&
    (pathKey(path.basename(root)) === 'sessions' || hasFlatPiSessionFile(root))
  ) {
    out.push(root);
  }
  return out;
}

/** root 下直接有 `<time>_<id>.jsonl` 形状的文件吗（flat sessions 目录）。 */
function hasFlatPiSessionFile(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isFileEntry(e, path.join(dir, e.name)) && /_[^\\/]*\.jsonl$/i.test(e.name)) return true;
    }
  } catch {
    /* 读不到就不认 */
  }
  return false;
}

function collectJsonl(dir, out, seen, visitedDirs, depth) {
  if (depth > WALK_MAX_DEPTH) return;
  const dirKey = pathKey(dir);
  if (visitedDirs.has(dirKey)) return; // junction / 符号链接成环时止步
  visitedDirs.add(dirKey);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (isFileEntry(e, p) && /\.jsonl$/i.test(e.name)) {
      const key = pathKey(p);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    } else if (isDirEntry(e, p)) {
      // CC Switch pi.rs:722-743：subagent-artifacts 里是没有 header 的产物，跳过
      if (e.name === 'subagent-artifacts') continue;
      collectJsonl(p, out, seen, visitedDirs, depth + 1);
    }
  }
}

/** id 形状（对齐 pi.rs:664-673 的 is_valid_tree_id）。 */
function isTreeId(id) {
  if (typeof id !== 'string' || !id) return false;
  if (Buffer.byteLength(id, 'utf8') > MAX_TREE_ID_BYTES) return false;
  if (!/^[A-Za-z0-9]/.test(id) || !/[A-Za-z0-9]$/.test(id)) return false;
  return /^[A-Za-z0-9_.-]+$/.test(id);
}

/**
 * 一个 entry 的 (id, parentId)。对齐 pi.rs:541-564 的 entry_identity：
 * version < 2 用 `legacy-N` 线性链；否则 id 必须是合法 tree id，
 * parentId 缺省/null 视为根，合法字符串才收，其它一律不参与树。
 */
function entryIdentity(o, version, entryIndex, legacyPrev) {
  if (version < 2) return { id: `legacy-${entryIndex}`, parentId: legacyPrev };
  if (!isTreeId(o.id)) return null;
  const p = o.parentId;
  if (p == null) return { id: o.id, parentId: null };
  if (typeof p === 'string' && isTreeId(p)) return { id: o.id, parentId: p };
  return null;
}

/**
 * 读一份 Pi 系会话文件并做**活动分支投影**。返回
 * `{ header, explicitName, activeEntries }`，读不了/超限/无有效 header 返回 null。
 *
 * 沿用项目其它 JSONL scanner 的一遍逐行读（坏行/半行跳过，不因一行坏 JSON
 * 放弃整场会话），靠 128MiB / 500k 两个上限兜住内存。
 */
function readTree(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SESSION_BYTES) return null;

  const rows = [];
  try {
    for (const line of lineIterator(file)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o);
    }
  } catch {
    return null;
  }
  if (!rows.length) return null;

  // header = 第一条 type=session。允许 omp 的 `{"type":"title"}` 标题槽出现在
  // header 之前：header 之前的行只贡献元数据，不进树、不占 entry_index。
  let headerIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'session') {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;
  const header = rows[headerIndex];
  const v = Number(header.version);
  if (Number.isFinite(v) && v === 0) return null; // pi.rs:526 明确拒绝 version 0
  const version = Number.isFinite(v) && v > 0 ? v : 1; // 未来版本按当前语义读

  // 显式标题槽：全局最后一个非空值（pi.rs:438-449 的 global name 语义 +
  // MAGPIE pi.go 的 title_change 逐次覆盖）。header 也在候选里。
  let explicitName = null;
  const consider = (val) => {
    if (typeof val === 'string' && val.trim()) explicitName = val.trim();
  };
  consider(header.title);
  for (let i = 0; i < rows.length; i++) {
    if (i === headerIndex) continue;
    const o = rows[i];
    if (o.type === 'title' || o.type === 'title_change') consider(o.title);
    else if (o.type === 'session_info') consider(o.name);
  }

  // 建树：header 之后每行一个 entry，entry_index 从 1 递增
  const parents = new Map(); // id -> { parentId, entryIndex }；重复 id 用最新
  const rowByIndex = new Map();
  let latestId = null;
  let legacyPrev = null;
  let entryIndex = 0;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    entryIndex++;
    if (entryIndex > MAX_TREE_ENTRIES) return null;
    const o = rows[i];
    rowByIndex.set(entryIndex, o);
    const ident = entryIdentity(o, version, entryIndex, legacyPrev);
    if (!ident) continue;
    parents.set(ident.id, { parentId: ident.parentId, entryIndex });
    latestId = ident.id;
    legacyPrev = ident.id;
  }

  // 从 latest_id 沿 parentId 回溯，带环检测与缺父容忍（pi.rs:416-430）
  const active = new Set();
  const visited = new Set();
  let cur = latestId;
  while (cur) {
    if (visited.has(cur)) break; // 环：停在已读主干
    visited.add(cur);
    const node = parents.get(cur);
    if (!node) break; // 缺父：停在能确定的主干
    active.add(node.entryIndex);
    cur = node.parentId;
  }

  // 按文件顺序（entry_index 升序）投影，不按回溯顺序
  const activeEntries = [];
  for (let k = 1; k <= entryIndex; k++) {
    if (active.has(k)) activeEntries.push(rowByIndex.get(k));
  }
  return { header, explicitName, activeEntries };
}

/** 消息时间：优先 message.timestamp，其次 entry.timestamp（pi.rs:460-464）。 */
function messageDate(o) {
  const m = o && o.message;
  const v = m && m.timestamp != null ? m.timestamp : o && o.timestamp;
  return asDate(v);
}

function asDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 真人输入：按标签形状剥注入块（不硬编码标签名单），斜杠/帮助命令不算人话。 */
function humanText(raw) {
  let t = String(raw == null ? '' : raw);
  t = t.replace(/<([A-Za-z][\w:.-]*)[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('/') || t.startsWith('?')) return null;
  return t;
}

/** 助手文本只压空白，不剥标签（代码块里的 `<tag>` 要留着）。 */
function plainText(raw) {
  const t = String(raw == null ? '' : raw).trim();
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
      else if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
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
  if (s === 'toolresult' || s === 'bashexecution' || s === 'tool') return 'tool';
  if (s === 'branchsummary' || s === 'compactionsummary') return 'system';
  return null;
}

/** content 数组里的 thinking / toolCall / tool_result 片段压成对应 part。 */
function contentParts(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const t = String(c.type || '').toLowerCase();
    if (t === 'thinking' || t === 'reasoning') {
      const p = reasoningPart(typeof c.thinking === 'string' ? c.thinking : c.text);
      if (p) out.push(p);
    } else if (t === 'toolcall' || t === 'tool_use' || t === 'tool_call' || t === 'function_call') {
      const input = c.input != null ? c.input : c.arguments != null ? c.arguments : null;
      out.push(toolPart({ name: c.name || c.toolName || 'tool', input, callId: c.id || c.callId || null }));
    } else if (t === 'tool_result' || t === 'toolresult' || t === 'function_call_result') {
      const output =
        typeof c.output === 'string'
          ? c.output
          : typeof c.content === 'string'
            ? c.content
            : typeof c.text === 'string'
              ? c.text
              : null;
      out.push(
        toolPart({
          name: c.name || c.toolName || 'tool',
          callId: c.toolCallId || c.tool_use_id || c.callId || c.id || null,
          output,
          status: c.isError || c.is_error ? 'error' : c.status || 'completed',
        })
      );
    }
  }
  return out;
}

/** 活动分支上第一句真人输入（只认 type=message 且 role=user）。 */
function firstUserText(activeEntries) {
  for (const o of activeEntries) {
    if (!o || o.type !== 'message') continue;
    const m = o.message;
    if (!m || roleOf(m) !== 'user') continue;
    const t = humanText(contentText(m.content != null ? m.content : m.text));
    if (t) return t;
  }
  return null;
}

/**
 * 共享解析核心：一个文件一场会话。omp 通过 opts.dialect 复用它。
 * 读不了/超限/无 header 返回 null（如实，不虚构会话）。
 */
export function parsePiFile(file, opts = {}) {
  const dialect = opts.dialect || PI_DIALECT;
  const tree = readTree(file);
  if (!tree) return null;
  const { header, explicitName, activeEntries } = tree;

  const id = isTreeId(header.id) ? header.id : path.basename(file, '.jsonl');
  const cwd = typeof header.cwd === 'string' && header.cwd.trim() ? header.cwd.trim() : null;
  const firstUser = firstUserText(activeEntries);
  const title = dialect.titleSlotFirst
    ? explicitName || firstUser || null
    : firstUser || explicitName || null;

  let start = asDate(header.timestamp);
  let end = null;
  for (const o of activeEntries) {
    const d = messageDate(o);
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
    agent: opts.agent || name,
    id,
    project: cwd,
    title,
    start,
    end: end || start,
    source: file,
    resume: dialect.resume ? `${dialect.resume} ${file}` : null,
    kind: 'main',
    parent: null,
  });
}

/**
 * 共享正文核心：只投影**活动分支上的 type=message entry**。
 *
 * 其余 entry（session_info / model_change / title_change / usage / model_usage /
 * compaction / branch_summary）是运行时记录，参与树的连通但不冒充对话。
 * 这样 pi 的 `{provider,modelId}` 与 omp 的单串 `provider/id`、以及 omp 多出来
 * 的 model_usage 都按形状兼容，无需第二份解析器。
 *
 * 网关 provider（magpie / dial）当普通消息进正文，但不作为成本来源：
 * usage / model / provider 都不写进消息模型（档案馆只记事实，不计成本）。
 *
 * 读不了/超限/无 header 抛错说明原因，不返回空数组冒充「没有会话」。
 */
export function readPiFile(file, opts = {}) {
  const tree = readTree(file);
  if (!tree) throw new Error(`读不到 Pi 系会话文件（可能超限或无有效 header）：${file}`);

  const out = [];
  for (const o of tree.activeEntries) {
    if (!o || o.type !== 'message') continue;
    const m = o.message;
    if (!m) continue;
    const role = roleOf(m);
    const ts = messageDate(o);
    const raw = m.content != null ? m.content : m.text;
    const parts = [];

    if (role === 'user') {
      const t = humanText(contentText(raw));
      if (t) parts.push(textPart(t));
    } else if (role === 'assistant') {
      const t = plainText(contentText(raw));
      if (t) parts.push(textPart(t));
    } else if (role === 'tool') {
      let text = contentText(raw);
      if (!text && String(m.role).toLowerCase() === 'bashexecution') {
        text = `$ ${m.command || ''}\n${m.output || ''}`.trim();
      }
      if (text) {
        parts.push(
          toolPart({
            name: m.toolName || m.name || 'tool',
            callId: m.toolCallId || null,
            output: text,
            status: m.isError ? 'error' : 'completed',
          })
        );
      }
    } else if (role === 'system') {
      const t = plainText(m.summary != null ? m.summary : contentText(raw));
      if (t) parts.push(textPart(t));
    }
    for (const p of contentParts(raw)) parts.push(p);
    if (!parts.length) continue;

    const outRole =
      role === 'user'
        ? 'user'
        : role === 'assistant'
          ? 'assistant'
          : role === 'system'
            ? 'system'
            : parts.every((p) => p.kind === 'tool')
              ? 'tool'
              : 'system';
    out.push(makeMessage({ role: outRole, parts, ts, meta: null }));
  }
  return out;
}

/** 一个文件一场会话。 */
export function parse(file) {
  return parsePiFile(file, { agent: name, dialect: PI_DIALECT });
}

/**
 * 读正文。越界校验用 `ctx.roots`（显式数据源）优先，否则本机根——
 * 保证外部备份里的文件不会被 assertUnderAny 误杀。
 */
export function readMessages(session, ctx = {}) {
  const roots = ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
  const file = assertUnderAny(roots, session.source);
  return readPiFile(file, { agent: name, dialect: PI_DIALECT });
}
