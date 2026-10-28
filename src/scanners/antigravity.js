import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadOnly } from '../sqlite-read.js';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';
import { extraRoots } from '../config.js';

/**
 * Gemini / Antigravity 会话扫描。
 *
 * 存储：~/.gemini/antigravity/
 *
 * 这个 Agent 有三套并存的数据，取舍如下：
 *
 *   1. conversation_summaries.db —— 21 场会话的索引，含 FTS5 全文。
 *      用它取元数据（标题、时间、workspace_uris），最全也最稳。
 *
 *   2. brain/<id>/.system_generated/logs/transcript_full.jsonl —— 明文逐行
 *      JSON，每行一个 step，带 source（USER_EXPLICIT/MODEL）、type、
 *      created_at、content、thinking、tool_calls。**这是读正文的首选**。
 *      但只有 3 场会话有这份文件。
 *
 *   3. conversations/<id>.db —— SQLite，正文在 step_payload 的 protobuf
 *      BLOB 里。字符串是明文 UTF-8，能抽出来，但结构不可靠。
 *
 * 另有 18 场是 .pb 文件（熵 8.0，gzip/deflate/brotli 全部解不开），
 * 是加密或不透明格式。那批只做元数据索引，不提供正文读取，
 * 索引里有 L3 摘要（user_body / agent_body）可以搜到。
 *
 * 所以：元数据覆盖 21 场，正文能读 3 场。这个差异在 doctor 里会体现出来。
 */

export const name = 'antigravity';

/**
 * 所有可能的 Antigravity 数据根。
 *
 * **只有主根 `~/.gemini/antigravity/` 是真的数据源。**
 *
 * 曾以为 `antigravity-ide` / `antigravity-backup` 是"另外两个变体、各藏
 * 18 场"，实测是误判：这两个目录里的 `.pb` 文件名与主根**完全一致**，
 * 它们是 `antigravity/` 的备份或 IDE 镜像副本。把它们当独立来源扫，
 * 只会把同一批会话报两遍。
 *
 * 保留这个数组是为了"哪天真有独立变体"时能一行加上去；
 * 目前只有第一项会在本机命中。
 */
const ROOT_NAMES = ['antigravity'];

function geminiDir() {
  // 配置文件里的根 = `.gemini` 这一层，取第一个真实存在的
  for (const r of extraRoots(name)) {
    try {
      if (fs.statSync(r).isDirectory()) return r;
    } catch {
      /* 试下一个 */
    }
  }
  return path.join(os.homedir(), '.gemini');
}

/** 所有存在的变体根。 */
function roots() {
  const out = [];
  for (const n of ROOT_NAMES) {
    const p = path.join(geminiDir(), n);
    try {
      if (fs.statSync(p).isDirectory()) out.push(p);
    } catch {
      /* 不存在 */
    }
  }
  return out;
}

/** 兼容旧调用点：主根（有 summaries.db 的那个）。 */
function root() {
  return path.join(geminiDir(), 'antigravity');
}

function summaryDbIn(rootDir) {
  return path.join(rootDir, 'conversation_summaries.db');
}

function conversationsDir(rootDir) {
  return path.join(rootDir, 'conversations');
}

/** 声明"我会去哪里找数据"（`.gemini` 这一层；给 doctor 与反向发现用）。 */
export function candidateRoots() {
  return [geminiDir()];
}

export function discover() {
  const out = [];
  for (const r of roots()) {
    const db = summaryDbIn(r);
    try {
      fs.accessSync(db, fs.constants.R_OK);
      out.push(db);
    } catch {
      /* 这个根没有索引库 */
    }
  }
  return out;
}

let cachedDb = null;
let cachedPath = null;

function getDb(file) {
  const p = file || summaryDbIn(root());
  if (cachedDb && cachedPath === p) return cachedDb;
  closeStore();
  try {
    cachedDb = openReadOnly(p);
    if (!cachedDb) {
      cachedPath = p;
      return null;
    }
    cachedDb.prepare('pragma busy_timeout = 5000').run();
    cachedPath = p;
  } catch {
    cachedDb = null;
    cachedPath = null;
  }
  return cachedDb;
}

export function closeStore() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* 已关闭 */
    }
    cachedDb = null;
    cachedPath = null;
  }
}

/**
 * 会话清单。
 *
 * workspace_uris 是 JSON 数组，形如 ["file:///e%3A/my-app"]。
 * 解码后作为项目路径——这是这里唯一能拿到项目的地方。
 */
export function parseAll(file) {
  const db = getDb(file);
  const rootDir = path.dirname(file);

  // 这个根下的 conversations 目录：有 .db 文件但我们没索引到的，
  // 说明 summaries 表不全（实测 27 个 conversation db 只索引了 21 条）。
  // 那些会话单独补进来，标题先用占位，正文能不能读由 readMessages 决定。
  const convIds = listConversationIds(rootDir);

  const out = [];
  const seen = new Set();

  if (db) {
    let rows = [];
    try {
      rows = db
        .prepare(
          `select conversation_id, title, step_count, last_modified_time,
                  workspace_uris, status, source
           from conversation_summaries`
        )
        .all();
    } catch {
      /* 表不存在就只走文件列表 */
    }

    for (const r of rows) {
      const project = pickWorkspace(r.workspace_uris);
      const end = parseTime(r.last_modified_time);

      // 索引里的 title 常常是空的或 "(untitled)"。正文文件名在 brain/<id>/ 下，
      // 读首条用户输入成本太高（21 场要开 21 个目录），这里退到一步：
      // 用 FTS 表的 user_body 首行做标题——它就在同一个库里。
      let title = r.title;
      if (!title || title === '(untitled)') {
        title = titleFromFts(db, r.conversation_id);
      }

      seen.add(String(r.conversation_id));
      out.push(
        makeSession({
          agent: name,
          id: r.conversation_id,
          project,
          title,
          // 索引里只有"最后修改时间"，没有开始时间。
          // 用同一个值填两头，doctor 的零时长统计能反映出这一点。
          start: end,
          end,
          source: `${file}#${r.conversation_id}`,
          resume: null,
        })
      );
    }
  }

  // 有 conversation db 但索引里没有的：补进来。
  // 标题用文件 mtime 归日，project 拿不到（db 里的 workspace 信息要开库）。
  for (const cid of convIds) {
    if (seen.has(cid)) continue;
    const p = path.join(conversationsDir(rootDir), `${cid}.db`);
    let end = null;
    try {
      end = fs.statSync(p).mtime;
    } catch {
      /* 读不到 mtime 就留空 */
    }
    out.push(
      makeSession({
        agent: name,
        id: cid,
        project: null,
        title: '(未索引)',
        start: end,
        end,
        source: `${file}#${cid}?unindexed`,
        resume: null,
      })
    );
  }

  return out;
}

/** conversations/*.db 的会话 id 列表。 */
function listConversationIds(rootDir) {
  const dir = conversationsDir(rootDir);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * 从 FTS 表里取一段正文当标题。
 *
 * conversation_summaries.db 里有一张 conversations_fts，它的 user_body
 * 是可直接读的正文摘录。索引里的 title 为空时用它兜底，
 * 比让标题显示 "(untitled)" 有用得多。
 */
function titleFromFts(db, conversationId) {
  try {
    const row = db
      .prepare(
        `select user_body from conversations_fts
         where conversation_id = ? and coalesce(user_body, '') <> ''
         order by chunk_index asc limit 1`
      )
      .get(conversationId);
    if (!row || !row.user_body) return null;
    const t = String(row.user_body).replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** workspace_uris 是 JSON 数组，取第一个能解成路径的。 */
function pickWorkspace(raw) {
  if (!raw) return null;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;

  for (const uri of list) {
    const p = uriToPath(uri);
    if (p) return p;
  }
  return null;
}

/** file:///e%3A/my-app → e:/my-app */
function uriToPath(uri) {
  const s = String(uri || '');
  if (!s.startsWith('file:')) return null;
  let p = s.slice(5).replace(/^\/+/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  p = p.replace(/\\/g, '/');
  const m = p.match(/^([a-zA-Z]):?\/?(.*)$/);
  if (m) return `${m[1].toLowerCase()}:/${m[2]}`;
  return null;
}

function parseTime(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 读一场会话的正文。
 *
 * 现在有多个变体根，正文要先在**所有**根里找——会话可能来自
 * antigravity-ide 而不是主根。找不到再抛错。
 *
 * 只支持有 transcript_full.jsonl 的那几场。没有的抛错——不假装成功，
 * 也不从加密的 .pb 里硬抠（那是不可靠的启发式，会产出错误内容）。
 */
export function readMessages(session) {
  const id = session.id;

  const candidates = roots().map((r) =>
    path.join(r, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl')
  );

  let text = null;
  let from = null;
  for (const p of candidates) {
    try {
      text = fs.readFileSync(p, 'utf8');
      from = p;
      break;
    } catch {
      /* 这个根下没有 */
    }
  }

  if (text === null) {
    // 越界校验：只有当路径落在某个已知根里才允许（防止 source 被改）
    if (from) assertUnder(path.dirname(from), from);
    throw new Error(
      '这场会话没有明文转录（Antigravity 有 18 场是加密的 .pb 格式）。' +
        '标题和摘要可从索引检索，正文读不到。'
    );
  }

  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = parseTime(o.created_at);
    const parts = [];

    if (typeof o.thinking === 'string' && o.thinking.trim()) {
      const p = reasoningPart(o.thinking);
      if (p) parts.push(p);
    }

    const body = cleanContent(o.content);
    if (body) {
      const p = textPart(body);
      if (p) parts.push(p);
    }

    // tool_calls 是一段 JSON 字符串
    if (typeof o.tool_calls === 'string' && o.tool_calls.trim()) {
      let calls;
      try {
        calls = JSON.parse(o.tool_calls);
      } catch {
        calls = null;
      }
      if (Array.isArray(calls)) {
        for (const c of calls) {
          if (!c || typeof c !== 'object') continue;
          parts.push(
            toolPart({
              name: c.name || 'tool',
              input: c.args === undefined ? null : c.args,
              callId: c.id || null,
            })
          );
        }
      }
    }

    if (!parts.length) continue;

    // source: USER_EXPLICIT / MODEL / SYSTEM
    const role =
      o.source === 'USER_EXPLICIT' ? 'user' : o.source === 'MODEL' ? 'assistant' : 'system';

    out.push(makeMessage({ role, parts, ts, meta: o.type ? { kind: o.type } : null }));
  }

  return out;
}

/**
 * 去掉内容外层的包装标签。
 *
 * 用户输入被包在 <USER_REQUEST>...</USER_REQUEST> 里，外面可能还有
 * 系统注入。取标签内的内容，取不到就用原文。
 */
function cleanContent(content) {
  if (typeof content !== 'string') return '';
  const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (m) return m[1].trim();
  // 其余注入型标签整段丢掉
  let out = content.replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, (whole, tag) => {
    const t = String(tag).toLowerCase();
    return t === 'code' || t === 'pre' ? whole : '';
  });
  return out.trim();
}
