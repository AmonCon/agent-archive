import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart } from '../messages.js';
import { dataCandidates, findUnder } from '../platform.js';

/**
 * OpenCode 会话扫描。
 *
 * 存储（XDG 数据目录，各平台不同）：
 *   Linux    ~/.local/share/opencode/opencode.db
 *   Windows  %LOCALAPPDATA%/opencode/opencode.db
 *   macOS    ~/Library/Application Support/opencode/opencode.db
 *
 * 结构与 ZCode 几乎同源（都是 OpenCode 系），session / message / part
 * 三张表，正文在 part.data 的 JSON 里。区别有两个：
 *
 *   1. OpenCode 的 session 表自带 directory、title、time_created，元数据
 *      一条 SQL 就够，不用翻 message。
 *   2. message.data 里没有 ZCode 那样的 semantics.origin 字段，区分不了
 *      "真人说的话"和"注入的上下文"。这里靠 part 类型过滤：
 *      step-start / step-finish 是流控标记，tool / reasoning 单独归类。
 *
 * 子代理会话（parent_id 非空）跳过：它们是父会话内部的一步，
 * 与 ZCode 的处理一致。
 */

export const name = 'opencode';

function dbPath() {
  // XDG 数据目录：Linux 是 ~/.local/share，Windows 是 %LOCALAPPDATA%，
  // macOS 多数程序退回 Application Support。候选列表见 platform.js。
  const found = findUnder(dataCandidates('opencode'), 'opencode.db');
  if (found) return found;
  return path.join(dataCandidates('opencode')[0], 'opencode.db');
}

export function discover() {
  const p = dbPath();
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return [];
  }
  return [p];
}

let cachedDb = null;
let cachedPath = null;

export function openStore(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('pragma busy_timeout = 5000').run();
    return db;
  } catch {
    return null;
  }
}

function getDb() {
  const p = dbPath();
  if (cachedDb && cachedPath === p) return cachedDb;
  closeStore();
  cachedDb = openStore(p);
  cachedPath = p;
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

export function parseAll(file) {
  const db = getDb();
  if (!db) return [];

  let rows;
  try {
    rows = db
      .prepare(
        `select id, directory, title, time_created, time_updated, coalesce(parent_id,'') as parent_id
         from session
         where coalesce(time_archived, 0) = 0
         order by time_updated desc`
      )
      .all();
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    // 子代理会话是父会话内部的一步，单独列会让时间线翻倍
    if (r.parent_id) continue;

    out.push(
      makeSession({
        agent: name,
        id: r.id,
        project: r.directory,
        title: r.title,
        start: r.time_created,
        end: r.time_updated,
        source: `${file}#${r.id}`,
        resume: null,
      })
    );
  }
  return out;
}

/**
 * 读一场会话的完整正文。
 *
 * part 按 sequence 展开，只取 text / reasoning / tool。
 * step-start、step-finish、patch、file、compaction 是流控或元信息，不是内容。
 */
export function readMessages(session) {
  const db = getDb();
  if (!db) throw new Error('打不开 OpenCode 数据库');

  let rows;
  try {
    rows = db
      .prepare(
        `select m.id, m.data as mdata, p.data as pdata
         from message m
         left join part p on p.message_id = m.id
         where m.session_id = ?
         order by m.time_created asc, p.time_created asc`
      )
      .all(session.id);
  } catch (e) {
    throw new Error(`读不了会话 ${session.id}: ${e && e.message ? e.message : e}`);
  }

  const out = [];
  let current = null;
  let currentId = null;

  for (const r of rows) {
    if (!current || r.id !== currentId) {
      const md = parseJson(r.mdata) || {};
      current = makeMessage({
        role: md.role === 'assistant' ? 'assistant' : 'user',
        parts: [],
        ts: md.time && md.time.created,
      });
      currentId = r.id;
      out.push(current);
    }

    const pd = parseJson(r.pdata);
    if (!pd || !pd.type) continue;

    if (pd.type === 'text') {
      const p = textPart(pd.text);
      if (p) current.parts.push(p);
    } else if (pd.type === 'reasoning') {
      const p = reasoningPart(pd.text);
      if (p) current.parts.push(p);
    } else if (pd.type === 'tool') {
      const st = pd.state || {};
      current.parts.push(
        toolPart({
          name: pd.tool,
          input: st.input === undefined ? null : st.input,
          callId: pd.callID || null,
          output: typeof st.output === 'string' ? st.output : null,
          status: st.status || null,
        })
      );
    }
  }

  return out.filter((m) => m.parts.length > 0);
}

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
