import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart } from '../messages.js';

/**
 * Cursor 会话扫描。
 *
 * 存储：<APPDATA>/Cursor/User/globalStorage/state.vscdb（VSCode 的 SQLite 键值库）
 *
 * 两张关键表/键：
 *   composerHeaders     一场会话一行（composerId, createdAt, isArchived, isSubagent）
 *   cursorDiskKV        composerData:<id>  会话元信息（名字、消息顺序）
 *                       bubbleId:<id>:<bid> 单条消息
 *
 * 消息顺序在 composerData.fullConversationHeadersOnly 里，bubble 本身
 * 无序存储。bubble 的字段名很杂，实际用到的只有三个：
 *   text        正文
 *   thinking    推理（{text, ...}）
 *   toolFormerData  工具调用（含 name / params / result）
 *
 * 时间在 composer.createdAt 与 bubble.createdAt 上，都是毫秒时间戳。
 * 项目路径在 bubble.workspaceProjectDir，形如
 * "c:\\Users\\...\\.cursor\\projects\\e-softpi-shop"，需要反解成 e:\softpi-shop
 * ——Cursor 把路径里的 \ 和 : 换成了 -，并且全部小写。
 */

export const name = 'cursor';

function dbPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
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

function getDb() {
  const p = dbPath();
  if (cachedDb && cachedPath === p) return cachedDb;
  closeStore();
  try {
    cachedDb = new DatabaseSync(p, { readOnly: true });
    cachedDb.prepare('pragma busy_timeout = 5000').run();
  } catch {
    cachedDb = null;
  }
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

/**
 * 一场会话一个文件。
 *
 * Cursor 把所有会话塞在同一个 SQLite 里，所以这里的 "file" 是数据库路径，
 * 会话由 composerHeaders 逐行给出。用 parseAll 一次产出全部，
 * 避免每个会话都重新打开 3.8 MB 的库。
 */
export function parseAll(file) {
  const db = getDb();
  if (!db) return [];

  let rows;
  try {
    rows = db
      .prepare(
        `select composerId, createdAt, isArchived, isSubagent
         from composerHeaders
         where coalesce(isSubagent, 0) = 0`
      )
      .all();
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    const s = buildSession(db, r, file);
    if (s) out.push(s);
  }
  return out;
}

function buildSession(db, row, file) {
  const id = row.composerId;
  if (!id || id === 'empty-state-draft') return null;

  let data;
  try {
    const got = db.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${id}`);
    if (!got) return null;
    data = JSON.parse(got.value);
  } catch {
    return null;
  }

  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];

  // 空会话不算会话。Cursor 会为"新建但没聊"的 composer 也写一行，
  // 它们只有 createdAt 和空消息列表，列进时间线纯属噪声。
  if (!headers.length) return null;

  // 会话级别的时间：createdAt 来自 composer，最后一条消息的 createdAt 作结束
  let start = row.createdAt ? new Date(row.createdAt) : null;
  let end = null;
  let project = null;
  let firstUser = null;
  let firstAssistant = null;

  for (const h of headers) {
    const ts = parseTime(h.createdAt);
    if (ts) {
      if (!start || ts < start) start = ts;
      if (!end || ts > end) end = ts;
    }
  }

  // 只需要开头几条就能拿到标题和项目路径；全量读留到 readMessages
  const probe = headers.slice(0, 12);
  for (const h of probe) {
    let j;
    try {
      const got = db.prepare('select value from cursorDiskKV where key = ?').get(`bubbleId:${id}:${h.bubbleId}`);
      if (!got) continue;
      j = JSON.parse(got.value);
    } catch {
      continue;
    }
    if (!project && j.workspaceProjectDir) project = cursorProjectDir(j.workspaceProjectDir);
    if (!project && Array.isArray(j.workspaceUris)) {
      for (const u of j.workspaceUris) {
        const p = uriToPath(u);
        if (p) {
          project = p;
          break;
        }
      }
    }
    const txt = String(j.text || '').trim();
    if (!txt) continue;
    if (h.type === 1 && !firstUser) firstUser = txt;
    else if (h.type === 2 && !firstAssistant) firstAssistant = txt;
  }

  if (!start && !end) return null;

  return makeSession({
    agent: name,
    id,
    // Cursor 自己给会话起的名字（如 "Project familiarization"），没有就用首句
    project,
    title: data.name || firstUser || firstAssistant,
    start,
    end: end || start,
    source: `${file}#${id}`,
    resume: null,
  });
}

/**
 * 把 Cursor 的 workspaceProjectDir 还原成真实路径。
 *
 * 形如 "c:\\Users\\X\\.cursor\\projects\\e-softpi-shop"：
 * 后面的 e-softpi-shop 是 "e:\\softpi-shop" 把 \ 和 : 换成 - 的结果。
 * 这个映射不可逆（分不清 "e-softpi-shop" 是 e:\softpi-shop 还是 e:/softpi-shop
 * 还是 e-\softpi-shop），但盘符 + 单层项目名这个形状是稳妥的。
 *
 * 拿不准时返回 null，而不是编一个看起来像的路径。
 */
export function cursorProjectDir(dir) {
  const s = String(dir || '');
  const m = s.match(/\.cursor[\\/]projects[\\/](.+)$/i);
  if (!m) return null;
  return slugToPath(m[1]);
}

function slugToPath(slug) {
  // 形如 "e-softpi-shop" → "e:/softpi-shop"
  const m = String(slug).match(/^([a-z])-(.+)$/i);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = m[2];
  if (!rest) return null;
  return `${drive}:/${rest}`;
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
  // 去掉 Windows 上编码后的冒号
  p = p.replace(/^([a-z])%3A/i, '$1:').replace(/^([a-z]):?\/?/i, (mm, d) => d.toLowerCase() + ':/');
  return p || null;
}

function parseTime(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v);
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== '') return new Date(n);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 读一场会话的完整正文。
 *
 * 顺序必须走 fullConversationHeadersOnly——bubble 在 KV 表里是无序的，
 * 按 key 排序会得到一段乱序的对话。
 */
export function readMessages(session) {
  const db = getDb();
  if (!db) throw new Error('打不开 Cursor 数据库');

  const id = String(session.source).split('#')[1] || session.id;

  let data;
  try {
    const got = db.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${id}`);
    if (!got) throw new Error('会话不存在');
    data = JSON.parse(got.value);
  } catch (e) {
    throw new Error(`读不了会话 ${id}: ${e && e.message ? e.message : e}`);
  }

  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  const out = [];

  for (const h of headers) {
    let j;
    try {
      const got = db
        .prepare('select value from cursorDiskKV where key = ?')
        .get(`bubbleId:${id}:${h.bubbleId}`);
      if (!got) continue;
      j = JSON.parse(got.value);
    } catch {
      continue;
    }

    const parts = [];

    // 推理
    if (j.thinking && typeof j.thinking.text === 'string') {
      const p = reasoningPart(j.thinking.text);
      if (p) parts.push(p);
    }

    // 工具调用
    if (j.toolFormerData && typeof j.toolFormerData === 'object') {
      const t = j.toolFormerData;
      parts.push(
        toolPart({
          name: t.name || t.toolName || 'tool',
          input: t.params !== undefined ? t.params : t.rawArgs,
          output: typeof t.result === 'string' ? t.result : t.result ? JSON.stringify(t.result) : null,
          status: t.status || null,
        })
      );
    }

    // 正文：type 1 用户、type 2 助手
    const txt = String(j.text || '').trim();
    if (txt) {
      const p = textPart(txt);
      if (p) parts.push(p);
    }

    if (!parts.length) continue;

    out.push(
      makeMessage({
        role: h.type === 1 ? 'user' : 'assistant',
        parts,
        ts: parseTime(h.createdAt) || parseTime(j.createdAt),
      })
    );
  }

  return out;
}
