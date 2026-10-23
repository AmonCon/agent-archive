import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { statePath } from './paths.js';

/**
 * 衍生数据缓存。
 *
 * 模型生成的摘要是**视图**，不是事实。它必须能被安全地重算，
 * 所以缓存键是四元组：
 *
 *     (kind, subject, source_hash, prompt_version, model)
 *
 * 改其中任何一个都是一次未命中：
 *   - 会话又聊了几轮 → source_hash 变 → 重算
 *   - 提示词改好了     → prompt_version 变 → 重算
 *   - 换了个模型       → model 变 → 重算，但旧结果还在，可以对比
 *
 * 这解决了三个迟早会遇到的问题：换模型后哪些摘要是旧的、提示词改进后
 * 怎么只重算受影响的、内容变了怎么发现。没有这层，三个月后整个
 * 衍生层就是一锅不知道新鲜度的粥。
 *
 * 数据库和事实层（索引）分开存：事实层坏了大不了重建，衍生层清掉
 * 也无非是重新花钱，两边的生命周期完全不同。
 */

const DERIVE_VERSION = 1;

const SCHEMA = [
  `create table if not exists artifact (
     kind text not null,
     subject text not null,
     source_hash text not null,
     prompt_version text not null,
     model text not null,
     created_at integer not null,
     body text not null,
     tokens_in integer not null default 0,
     tokens_out integer not null default 0,
     primary key (kind, subject, source_hash, prompt_version, model)
   )`,
  'create index if not exists artifact_subject on artifact(kind, subject)',
  'create index if not exists artifact_time on artifact(created_at)',
];

function dir() {
  return statePath('derived');
}

export function derivePath() {
  return path.join(dir(), `derived-v${DERIVE_VERSION}.sqlite`);
}

function open({ create = true } = {}) {
  const file = derivePath();
  if (!create && !fs.existsSync(file)) return null;
  fs.mkdirSync(dir(), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.prepare('pragma journal_mode = wal').get();
  } catch {
    /* 默认模式也能跑 */
  }
  try {
    db.prepare('pragma busy_timeout = 5000').run();
  } catch {
    /* 老版本不支持 */
  }
  for (const stmt of SCHEMA) db.prepare(stmt).run();
  return db;
}

/** 内容哈希。只用于缓存键，不做安全用途。 */
export function hashText(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

const SQL_GET = `select body, tokens_in, tokens_out, created_at, model
                 from artifact
                 where kind = ? and subject = ? and source_hash = ?
                   and prompt_version = ? and model = ?`;

const SQL_PUT = `insert or replace into artifact
                 (kind, subject, source_hash, prompt_version, model, created_at, body, tokens_in, tokens_out)
                 values (?,?,?,?,?,?,?,?,?)`;

/** 查缓存。未命中返回 null。 */
export function getArtifact({ kind, subject, sourceHash, promptVersion, model }) {
  const db = open({ create: false });
  if (!db) return null;
  try {
    const row = db.prepare(SQL_GET).get(kind, subject, sourceHash, promptVersion, model);
    if (!row) return null;
    return {
      body: row.body,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      createdAt: new Date(row.created_at),
      model: row.model,
    };
  } finally {
    db.close();
  }
}

export function putArtifact({ kind, subject, sourceHash, promptVersion, model, body, tokensIn, tokensOut }) {
  const db = open();
  try {
    db.prepare(SQL_PUT).run(
      kind,
      subject,
      sourceHash,
      promptVersion,
      model,
      Date.now(),
      body,
      tokensIn || 0,
      tokensOut || 0
    );
  } finally {
    db.close();
  }
}

const SQL_LIST_BY_KIND = `select kind, subject, source_hash, prompt_version, model, created_at,
                                 length(body) as size, tokens_in, tokens_out
                          from artifact where kind = ? order by created_at desc limit ?`;

const SQL_LIST_ALL = `select kind, subject, source_hash, prompt_version, model, created_at,
                             length(body) as size, tokens_in, tokens_out
                      from artifact order by created_at desc limit ?`;

/** 列出已有衍生数据，用来判断"哪些是旧模型生成的"。 */
export function listArtifacts({ kind, limit = 100 } = {}) {
  const db = open({ create: false });
  if (!db) return [];
  try {
    const rows = kind
      ? db.prepare(SQL_LIST_BY_KIND).all(kind, limit)
      : db.prepare(SQL_LIST_ALL).all(limit);
    return rows.map((r) => ({
      kind: r.kind,
      subject: r.subject,
      sourceHash: r.source_hash,
      promptVersion: r.prompt_version,
      model: r.model,
      createdAt: new Date(r.created_at),
      size: r.size,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
    }));
  } finally {
    db.close();
  }
}

/**
 * 取某个主题下最新的一份衍生数据。
 *
 * 展示场景用：网页和 MCP 想知道"这个项目有没有现成的摘要"，
 * 但它们算不出当前的 source_hash（那要先读一遍全部会话）。
 * 所以按时间取最新的一份，并把它的元信息一并带出来——
 * 用户能看到这是什么时候、用哪个模型生成的。
 */
const SQL_LATEST = `select body, model, prompt_version, source_hash, created_at, tokens_in, tokens_out
                    from artifact where kind = ? and subject = ?
                    order by created_at desc limit 1`;

export function latestArtifact({ kind, subject }) {
  const db = open({ create: false });
  if (!db) return null;
  try {
    const row = db.prepare(SQL_LATEST).get(kind, subject);
    if (!row) return null;
    return {
      body: row.body,
      model: row.model,
      promptVersion: row.prompt_version,
      sourceHash: row.source_hash,
      createdAt: new Date(row.created_at),
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
    };
  } finally {
    db.close();
  }
}

const SQL_DELETE = `delete from artifact where kind = ? and subject = ?`;

/** 删掉某个主题下的衍生数据（所有模型/版本）。 */
export function removeArtifact({ kind, subject }) {
  const db = open({ create: false });
  if (!db) return 0;
  try {
    const r = db.prepare(SQL_DELETE).run(kind, subject);
    return Number(r && r.changes) || 0;
  } finally {
    db.close();
  }
}

const SQL_STATS = `select kind, model, prompt_version, count(*) c, sum(tokens_in) ti, sum(tokens_out) tout
                   from artifact group by kind, model, prompt_version`;

export function deriveStats() {
  const db = open({ create: false });
  if (!db) return { exists: false, groups: [], total: 0 };
  try {
    const rows = db.prepare(SQL_STATS).all();
    const groups = rows.map((r) => ({
      kind: r.kind,
      model: r.model,
      promptVersion: r.prompt_version,
      count: r.c,
      tokensIn: r.ti || 0,
      tokensOut: r.tout || 0,
    }));
    return {
      exists: true,
      groups,
      total: groups.reduce((n, g) => n + g.count, 0),
    };
  } catch {
    return { exists: true, groups: [], total: 0 };
  } finally {
    db.close();
  }
}

/**
 * 找出"同样主题下用过哪些模型"。
 *
 * 换模型后最想知道的就是这个：旧结论是哪个模型给的、要不要重算。
 */
const SQL_MODELS = `select distinct model, prompt_version, count(*) c
                    from artifact where subject = ? group by model, prompt_version`;

export function modelsFor(subject) {
  const db = open({ create: false });
  if (!db) return [];
  try {
    return db
      .prepare(SQL_MODELS)
      .all(subject)
      .map((r) => ({ model: r.model, promptVersion: r.prompt_version, count: r.c }));
  } finally {
    db.close();
  }
}
