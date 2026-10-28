import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadOnly } from '../sqlite-read.js';
import { extraRoots } from '../config.js';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart } from '../messages.js';

/**
 * ZCode 会话扫描。
 *
 * 存储：~/.zcode/cli/db/db.sqlite（OpenCode 的表结构分支）
 *   session 表直接有 directory、title、time_created、time_updated，
 *   所以元数据一条 SQL 就够，不用翻 message/part。
 *
 * 两个坑：
 * 1. db 带 -wal，只读打开时必须允许读 WAL，否则会漏掉最新数据；
 *    若 Agent 正在写，用 immutable=1 会读到旧快照，这里用只读模式。
 * 2. 标题可能是自动生成的默认值（title_source='default'），
 *    那种情况要回退到第一条用户消息。
 */

export const name = 'zcode';

function dbPath() {
  // 配置文件里可以写多个 `.zcode` 根（外置盘、备份盘……），
  // 取第一个真实存在的；都没有就回默认位置，让 discover 报"没有"。
  for (const root of extraRoots(name)) {
    const p = path.join(root, 'cli', 'db', 'db.sqlite');
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  return path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
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

/** WAL 必须参与缓存判据：新消息先落 wal，主库 mtime 可以长时间不动。 */
export function extraFiles(file) {
  return [`${file}-wal`];
}

/** 打开只读连接；一次扫描复用同一个连接。 */
export function openStore(file) {
  try {
    return openReadOnly(file);
  } catch {
    return null;
  }
}

let cachedDb = null;
let cachedDbPath = null;

function getDb() {
  const p = dbPath();
  if (cachedDb && cachedDbPath === p) return cachedDb;
  cachedDb = openStore(p);
  cachedDbPath = p;
  return cachedDb;
}

export function parseAll(file) {
  const db = getDb();
  if (!db) return [];

  let rows;
  try {
    rows = db
      .prepare(
        `select id, directory, title, coalesce(title_source,'') as title_source,
                time_created, time_updated, coalesce(parent_id,'') as parent_id,
                coalesce(time_deleted,0) as time_deleted
         from session
         where coalesce(time_deleted,0) = 0
         order by time_updated desc`
      )
      .all();
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    const title = r.title_source === 'default' ? null : r.title;
    out.push(
      makeSession({
        agent: name,
        id: r.id,
        project: r.directory,
        title: title || firstUserText(db, r.id),
        start: r.time_created,
        end: r.time_updated,
        source: `${file}#${r.id}`,
        resume: null, // ZCode 是桌面应用，没有命令行恢复方式
        // 子会话照常采集，只标记归属。丢弃会连带丢掉子代理实际干的活。
        kind: r.parent_id ? 'subagent' : 'main',
        parent: r.parent_id || null,
      })
    );
  }
  return out;
}

function firstUserText(db, sessionId) {
  try {
    const row = db
      .prepare(
        `select json_extract(data,'$.role') as role, p.data as part_data
         from message m
         join part p on p.message_id = m.id
         where m.session_id = ? and json_extract(m.data,'$.role') = 'user'
           and json_extract(p.data,'$.type') = 'text'
         order by m.sequence asc, p.sequence asc
         limit 1`
      )
      .get(sessionId);
    if (!row || !row.part_data) return null;
    return JSON.parse(row.part_data).text || null;
  } catch {
    return null;
  }
}

export function closeStore() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* 已关闭 */
    }
    cachedDb = null;
    cachedDbPath = null;
  }
}

/**
 * 读一场会话的完整正文。
 *
 * message.data 里的 semantics 字段是这里最省事的东西：
 *   origin=real_user     真人敲的话
 *   origin=agent_runtime 系统提醒、注入的上下文
 * 用它过滤比猜文本前缀可靠得多，也不依赖中英文措辞。
 *
 * part 按 sequence 展开，只取三类：text / reasoning / tool。
 * step-start、step-finish 是流控标记，不是内容。
 */
export function readMessages(session) {
  const db = getDb();
  if (!db) throw new Error('打不开 ZCode 数据库');

  const rows = db
    .prepare(
      `select m.id, m.sequence, m.data as mdata,
              p.data as pdata, p.sequence as pseq
       from message m
       left join part p on p.message_id = m.id
       where m.session_id = ?
       order by m.sequence asc, p.sequence asc`
    )
    .all(session.id);

  const out = [];
  let current = null;
  let currentId = null;

  for (const r of rows) {
    if (!current || r.id !== currentId) {
      const md = parseJson(r.mdata) || {};
      const sem = md.semantics || {};
      const role = md.role === 'assistant' ? 'assistant' : 'user';

      // 注入内容单独归 system，不冒充用户发言
      const isInjected = sem.origin === 'agent_runtime' && sem.kind !== 'assistant_response';
      current = makeMessage({
        role: isInjected ? 'system' : role,
        parts: [],
        ts: md.time && md.time.created,
        meta: { origin: sem.origin || null, kind: sem.kind || null },
      });
      currentId = r.id;
      out.push(current);
    }

    const pd = parseJson(r.pdata);
    if (!pd) continue;
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

  // 只有空壳（比如一条消息全是流控标记）的丢掉
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
