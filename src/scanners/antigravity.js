import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';

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

function root() {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function summaryDb() {
  return path.join(root(), 'conversation_summaries.db');
}

export function discover() {
  const p = summaryDb();
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return [];
  }
  return [p];
}

let cachedDb = null;

function getDb() {
  if (cachedDb) return cachedDb;
  try {
    cachedDb = new DatabaseSync(summaryDb(), { readOnly: true });
    cachedDb.prepare('pragma busy_timeout = 5000').run();
  } catch {
    cachedDb = null;
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
  }
}

/**
 * 会话清单。
 *
 * workspace_uris 是 JSON 数组，形如 ["file:///e%3A/softpi-shop"]。
 * 解码后作为项目路径——这是这里唯一能拿到项目的地方。
 */
export function parseAll(file) {
  const db = getDb();
  if (!db) return [];

  let rows;
  try {
    rows = db
      .prepare(
        `select conversation_id, title, step_count, last_modified_time,
                workspace_uris, status, source
         from conversation_summaries`
      )
      .all();
  } catch {
    return [];
  }

  const out = [];
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
  return out;
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

/** file:///e%3A/softpi-shop → e:/softpi-shop */
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
 * 只支持有 transcript_full.jsonl 的那几场。没有的抛错——不假装成功，
 * 也不从加密的 .pb 里硬抠（那是不可靠的启发式，会产出错误内容）。
 */
export function readMessages(session) {
  const id = session.id;
  const logPath = path.join(
    root(),
    'brain',
    id,
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  );

  const real = assertUnder(root(), logPath);

  let text;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch {
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
