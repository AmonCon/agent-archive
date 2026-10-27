import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadOnly } from '../sqlite-read.js';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart } from '../messages.js';
import { dataCandidates } from '../platform.js';

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

/**
 * OpenCode 的 db 路径候选。
 *
 * **macOS 上也用 `~/.local/share/opencode`**，不是
 * `~/Library/Application Support`——这是它自己 `global-roots.ts` 里
 * 写死的逻辑（`XDG_DATA_HOME || ~/.local/share`，无 platform 分支）。
 * 看到 `~/.local/share` 别以为是 Linux 专用，macOS 上真的会有。
 *
 * 三个官方覆盖变量：
 *   OPENCODE_DATA_DIR  精确目录（**不再拼 opencode**）
 *   OPENCODE_DB        精确的 db 文件路径
 *   XDG_DATA_HOME      XDG 惯例，三平台都认
 */
function dbPaths() {
  const home = os.homedir();
  const out = [];

  const add = (p) => {
    if (!p) return;
    const norm = path.resolve(p);
    if (!out.some((x) => samePath(x, norm))) out.push(norm);
  };

  // 最精确的：直接给 db 文件
  const direct = process.env.OPENCODE_DB;
  if (direct && String(direct).trim()) {
    add(expandHome(String(direct).trim()));
  }

  // 数据目录（精确，不拼 opencode）
  const dataDir = process.env.OPENCODE_DATA_DIR;
  if (dataDir && String(dataDir).trim()) {
    add(path.join(expandHome(String(dataDir).trim()), 'opencode.db'));
  }

  // XDG
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && String(xdg).trim()) {
    add(path.join(expandHome(String(xdg).trim()), 'opencode', 'opencode.db'));
  }

  // 默认：三平台都是 ~/.local/share/opencode
  add(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));

  // 兜底：某些安装器可能放到 platform.js 的其它候选位置
  for (const root of dataCandidates('opencode')) {
    add(path.join(root, 'opencode.db'));
  }

  return out;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function samePath(a, b) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const na = String(a).replace(/\\/g, '/');
  const nb = String(b).replace(/\\/g, '/');
  return ci ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function dbPath() {
  for (const p of dbPaths()) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  return dbPaths()[0];
}

export function discover() {
  const out = [];
  for (const p of dbPaths()) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      out.push(p);
    } catch {
      /* 不存在 */
    }
  }
  return out;
}

/** WAL 必须参与缓存判据：新消息先落 wal，主库 mtime 可以长时间不动。 */
export function extraFiles(file) {
  return [`${file}-wal`];
}

let cachedDb = null;
let cachedPath = null;

export function openStore(file) {
  try {
    const db = openReadOnly(file);
    if (!db) return null;
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
