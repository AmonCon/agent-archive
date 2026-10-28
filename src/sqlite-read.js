import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * 零副作用的只读 SQLite 打开。
 *
 * ## 问题
 *
 * `new DatabaseSync(file, { readOnly: true })` 并不真的"什么都不碰"。实测（本机
 * Hermes state.db，复制到临时目录后打开，前后各列一次目录）：
 *
 *     before  [ state.db ]
 *     during  [ state.db, state.db-shm, state.db-wal ]
 *     after   [ state.db, state.db-shm, state.db-wal ]
 *
 * 也就是说，一个声称只读的工具，会在 Agent 自己的目录里**新建两个文件**。
 * 后果不只是脏：`-wal` 的存在会让 Agent 下次启动走不同的 checkpoint 路径，
 * 而这两个文件的时间戳还会污染其他工具（包括本项目自己）的"有没有变化"判断。
 *
 * ## 两种情形分开处理
 *
 * MAGPIE 在 Cursor 上踩过同一个坑，处理方式值得照抄：
 *
 *   1. **没有 `-wal`**（或 wal 为空）→ `immutable=1`。
 *      SQLite 承诺这是"文件不会变"的读法，实测零文件创建。
 *      代价是会忽略 WAL——但没有 WAL 要忽略。
 *
 *   2. **有 `-wal`** → 把 db + wal 复制到自己临时目录再读。
 *      不能直接上 `immutable=1`：实测它会**完全忽略 WAL**，连表都看不见
 *      （在未 checkpoint 的库上 `select` 直接报 "no such table"）。
 *      复制一份是唯一既能看到最新数据、又不碰 Agent 目录的做法。
 *
 * ## 复制不便宜，所以带缓存
 *
 * 复制一个 250 MB 的 state.db 要几百毫秒。所以按 `(size, mtime)` 记住上次
 * 复制的那份，源没变就复用——这与 registry 的缓存判据同一思路。
 *
 * ## 什么时候不该用这个
 *
 * 每次调用都会重新判断。如果调用方需要长时间持有一个连接（如 readMessages
 * 按会话反复查），应当自己缓存返回的 db，并在结束时 close()。
 */

/** 临时副本的缓存：源路径 -> { stamp, dir, dbPath } */
const copies = new Map();

/**
 * 打开一个只读数据库。
 *
 * @param {string} file 数据库文件路径
 * @returns {DatabaseSync|null} 打不开返回 null
 */
export function openReadOnly(file) {
  if (!file) return null;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const wal = `${file}-wal`;
  const walStat = statOrNull(wal);
  const walHasData = !!walStat && walStat.size > 0;

  if (!walHasData) {
    // 无 WAL：immutable 读法，零副作用。
    // 空 wal 也算"没有要读的"——此时 immutable 与普通只读结果一致。
    try {
      return new DatabaseSync(toUri(file, true), { readOnly: true });
    } catch {
      /* 退到普通只读 */
    }
  }

  // 有 WAL：复制到自己的临时目录
  const copy = copyFor(file, st, walStat);
  if (!copy) return null;
  try {
    return new DatabaseSync(copy.dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * 把 db + wal 复制到临时目录，并尽量复用上一次的副本。
 *
 * 复用判据是 db 与 wal 的 (size, mtime) 都没变。任一变了就重做一份。
 * 旧副本不删——它不是泄漏，是下一次可能还要用的缓存；进程退出时由
 * `cleanupCopies()` 统一清。
 */
function copyFor(file, dbStat, walStat) {
  const stamp = `${dbStat.size}:${dbStat.mtimeMs}:${walStat ? `${walStat.size}:${walStat.mtimeMs}` : 'nowal'}`;
  const hit = copies.get(file);
  if (hit && hit.stamp === stamp) return hit;

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-archive-sqlite-'));
  } catch {
    return null;
  }

  const dbName = path.basename(file);
  const dbPath = path.join(dir, dbName);
  try {
    fs.copyFileSync(file, dbPath);
    if (walStat && walStat.size > 0) {
      // wal 必须与 db 同名同目录才会被 SQLite 认出来
      fs.copyFileSync(`${file}-wal`, `${dbPath}-wal`);
    }
  } catch {
    safeRm(dir);
    return null;
  }

  // 旧副本留着占空间没有意义，且可能被误当作"最新"——直接换掉
  if (hit) safeRm(hit.dir);

  const rec = { stamp, dir, dbPath };
  copies.set(file, rec);
  return rec;
}

/** 进程退出时清理临时副本。 */
export function cleanupCopies() {
  for (const rec of copies.values()) safeRm(rec.dir);
  copies.clear();
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响正确性 */
  }
}

/**
 * 转成 SQLite URI。Windows 路径要正向斜杠，且盘符里的冒号不能被当成 URI 分隔。
 */
function toUri(file, immutable) {
  let p = path.resolve(file).replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p; // C:/x -> /C:/x
  const q = immutable ? '?immutable=1' : '';
  return `file:${encodeURI(p)}${q}`;
}

/** 供测试用：当前缓存了几份副本。 */
export function copyCount() {
  return copies.size;
}

/**
 * 找出一个**带版本号的** SQLite 库，取版本最高的那个。
 *
 * ## 为什么不能写死文件名
 *
 * 这类应用库的名字里带 schema 版本，升级时会把 `state_5.sqlite` 改成
 * `state_6.sqlite`（Codex 就是这么做的，cc-switch 的源码注释里也承认
 * "每次 bump 版本号就改这一处"——那是它自己的维护负担）。
 *
 * 对我们更糟：写死等于**在用户升级后静默少掉一部分能力**。本机写死
 * `state_5.sqlite` 时，读不到只表现为"标题和结束时间又变回粗的"，不报错。
 *
 * 所以要按前缀扫描、取数字最大的那个；同时接受无版本号的写法
 * （`memories.sqlite`），因为它可能是某些版本或某些移植版的形态。
 *
 * @param {string} dir 目录
 * @param {string} base 不带扩展名的前缀，如 'state'、'memories'
 * @returns {string|null} 找到的完整路径
 */
export function findVersionedDb(dir, base) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  // state.sqlite / state_5.sqlite / state_12.sqlite，排除 -wal/-shm
  const re = new RegExp(`^${escapeRe(base)}(?:_(\\d+))?\\.sqlite$`, 'i');
  let best = null;
  for (const n of names) {
    const m = n.match(re);
    if (!m) continue;
    const ver = m[1] ? Number(m[1]) : 0;
    if (!best || ver > best.ver) best = { ver, file: path.join(dir, n) };
  }
  return best ? best.file : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { crypto };
