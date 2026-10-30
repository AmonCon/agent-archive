import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { scanCached } from './registry.js';
import { readSessionContent } from './query.js';
import { statePath } from './paths.js';
import { summarizeInput } from './messages.js';

/**
 * 全文索引。
 *
 * 为什么需要：实测全量读一遍 2225 场会话要 74 秒、710 M 字符。
 * 每次搜索都实时扫是不可能的，所以正文必须先在本地落一份索引。
 *
 * 用 SQLite FTS5，因为它在 Node 里白拿——`node:sqlite` 已经够用，
 * 不需要引入任何第三方依赖，也不需要额外的服务进程。
 *
 * 中文的处理是这里唯一有技巧的地方：FTS5 自带的 unicode61 分词器
 * 不切中文（整段中文是一个词），trigram 又要求查询≥3字符，
 * 「缓存」「迁移」这类两字词都查不到。所以入库时额外写入一遍
 * 中文二元组（"数据库" → "数据 据库"），查询时做同样的转换。
 * 实测两字、三字、中英混排都能正确命中。
 */

const INDEX_VERSION = 1;

/**
 * 建表语句。
 *
 * 逐条列出、逐条执行，而不是拼成一整段脚本：这些都是固定 DDL，
 * 不含任何外部输入，分开写既让人一眼看出没有拼接，
 * 也不依赖某个一次性执行整段 SQL 的接口。
 */
const SCHEMA_STATEMENTS = [
  'create table if not exists meta (k text primary key, v text)',
  `create table if not exists doc (
     key text primary key,
     agent text not null,
     id text not null,
     project text,
     title text,
     start integer,
     end integer,
     chars integer not null default 0,
     mtime real,
     size integer,
     kind text not null default 'main',
     body text,
     body_z blob,
     fts_text text
   )`,
  'create index if not exists doc_agent on doc(agent)',
  'create index if not exists doc_start on doc(start)',
  // FTS 表挂在 doc 上（content=），自己不存正文。
  //
  // 首次建库用 FTS5 原生的 rebuild 一次性建倒排——逐条 insert 的代价随
  // 索引规模增长，几百条之后就慢得不可接受。建好之后由触发器增量维护
  // （见 TRIGGER_STATEMENTS）：改一场只动一场，不再全量重建 226 MB。
  //
  // 索引的是 doc.fts_text（正文 + 中文二元组），原始正文另存在 doc.body，
  // 供摘录使用。两列都在 doc 里，FTS 只引用它需要的那个。
  `create virtual table if not exists doc_fts using fts5(
     fts_text, content='doc', content_rowid='rowid', tokenize='unicode61'
   )`,
];

/** 每批写入多少场。批越小占内存越少；批越大事务开销摊得越薄。 */
const BATCH = 50;

/**
 * 从 doc 的一行取回原始正文。
 *
 * 正文按 zlib deflate 存在 body_z（实测压缩率约 23%），老数据仍是明文 body。
 * 读取一律走这里，调用方不用关心是哪一种。两种情况都没有就是空串。
 *
 * 解压失败（例如库被截断）返回空串而不是抛：读路径是搜索、摘录、凭证扫描，
 * 一行坏数据不该让整个功能报错。
 */
export function readBody(row) {
  if (!row) return '';
  if (row.body !== null && row.body !== undefined) return String(row.body);
  if (row.body_z) {
    try {
      return inflateRawSync(row.body_z).toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

/** 写库时的压缩入口，和 readBody 保持同一对。 */
function compressBody(body) {
  return deflateRawSync(Buffer.from(String(body), 'utf8'));
}

/**
 * 库里有没有 body_z 列。
 *
 * 只读打开（search / secrets）不会跑迁移，升级后第一次查询可能仍然是老库。
 * 直接 `select body_z` 会报 no such column，整个查询变成空结果——所以读路径
 * 先探一下列，没有就只读明文 body。
 */
export function hasBodyZ(db) {
  try {
    return db.prepare('pragma table_info(doc)').all().some((c) => c.name === 'body_z');
  } catch {
    return false;
  }
}

/**
 * FTS5 外部内容表的同步触发器。
 *
 * doc_fts 是 external content 表（content='doc'），它自己不存正文，
 * 所以 doc 每次变更都要有人告诉它：新增了什么、删掉的是哪一行的旧值。
 * 这三条触发器就是那个"人"。
 *
 * 为什么用触发器而不是在 JS 里手动 insert：
 *   - doc 的写入分散在多处（增量写入、清理已消失的会话、--force 全量重写），
 *     手写维护迟早漏一处，而漏掉的表现是**搜索静默缺结果**；
 *   - FTS5 的 'delete' 命令要求给出**入索引时的那份原文**，
 *     触发器里的 old.fts_text 天然就是它。
 *
 * `if not exists` 让老索引库（只有 doc、没有触发器）在下次打开时自动补上，
 * 不需要重建。
 */
const TRIGGER_STATEMENTS = [
  `create trigger if not exists doc_fts_ai after insert on doc begin
     insert into doc_fts(rowid, fts_text) values (new.rowid, new.fts_text);
   end`,
  `create trigger if not exists doc_fts_ad after delete on doc begin
     insert into doc_fts(doc_fts, rowid, fts_text) values('delete', old.rowid, old.fts_text);
   end`,
  `create trigger if not exists doc_fts_au after update on doc begin
     insert into doc_fts(doc_fts, rowid, fts_text) values('delete', old.rowid, old.fts_text);
     insert into doc_fts(rowid, fts_text) values (new.rowid, new.fts_text);
   end`,
];

const TRIGGER_NAMES = ['doc_fts_ai', 'doc_fts_ad', 'doc_fts_au'];

/** 补上同步触发器（幂等）。每次可写打开都跑，老库因此自动升级。 */
function ensureTriggers(db) {
  for (const stmt of TRIGGER_STATEMENTS) db.prepare(stmt).run();
}

/**
 * 摘掉同步触发器。
 *
 * 只用于全量构建：几千场逐行触发会把首次建库拖慢一个量级，
 * 而整库写完用一次 rebuild 就能建好倒排。
 */
function dropTriggers(db) {
  for (const name of TRIGGER_NAMES) db.prepare(`drop trigger if exists ${name}`).run();
}

function indexDir() {
  return statePath('index');
}

function indexFile() {
  return path.join(indexDir(), `fulltext-v${INDEX_VERSION}.sqlite`);
}

export function indexPath() {
  return indexFile();
}

/**
 * 把正文转成检索用的 token 序列。
 *
 * FTS5 的 unicode61 分词器不切中文，整段中文会变成一个 token，
 * 搜「缓存」永远搜不到。而 trigram 要求查询至少 3 个字符，
 * 「迁移」「缓存」这类两字词同样搜不到。
 *
 * 所以自己切：
 *   - 中文：连续汉字段切成长度为 2 的滑窗（"数据库迁移" → 数据 据库 库迁 迁移）
 *   - 非中文：原样保留，交给 unicode61 按空格/标点切词
 *
 * 注意这里生成的是**替代**文本，不是"原文 + 二元组"。
 * 实测原文叠加二元组会让索引文本膨胀 4 倍（120 场就 34 M 字符），
 * 建索引慢到不可用。只留 token 序列，索引大小和原文同量级。
 */
function toIndexTokens(s) {
  if (!s) return '';
  const out = [];
  let buf = [];
  let han = [];

  const flushHan = () => {
    if (han.length === 1) {
      // 单字没有二元组，原样留着，免得彻底搜不到
      out.push(han[0]);
    } else {
      for (let i = 0; i < han.length - 1; i++) out.push(han[i] + han[i + 1]);
    }
    han = [];
  };
  const flushBuf = () => {
    if (buf.length) {
      // 英文按非字母数字切开：FTS5 的 unicode61 会把 "better-harness"
      // 分成两个 token，这里保持同一口径，否则查询端给出的复合词
      // 在索引里根本不存在，永远匹配不上。
      for (const w of buf.join('').split(/[^A-Za-z0-9_]+/)) {
        if (w) out.push(w);
      }
      buf = [];
    }
  };

  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      flushBuf();
      han.push(ch);
    } else {
      flushHan();
      buf.push(ch);
    }
  }
  flushHan();
  flushBuf();

  return out.join(' ');
}

/**
 * 从原始正文里取一段围绕关键词的摘录。
 *
 * 不能用 FTS5 的 snippet()：索引里存的是"原文 + 中文二元组"，
 * snippet 会把二元组也当成正文取出来，摘录变成
 * 「约 约束 束：」这样的碎片。所以索引文本只用来匹配，
 * 摘录回原始正文里另找。
 */
function excerpt(body, query, width = 90) {
  if (!body) return '';
  const flat = body.replace(/\s+/g, ' ');
  const q = String(query || '').trim();
  if (!q) return flat.slice(0, width * 2).trim();

  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return flat.slice(0, width * 2).trim();

  const start = Math.max(0, idx - width);
  const end = Math.min(flat.length, idx + q.length + width);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

/**
 * 查询串做同样的切分，保证"缓存"能被切成 token 去匹配。
 *
 * 多个 token 之间是 AND（FTS5 的默认语义）：搜「数据库迁移」要求
 * 「数据」「据库」「库迁」「迁移」都出现，实际上等于按短语前缀匹配，
 * 正是我们要的行为。
 */
function queryFor(q) {
  const t = String(q || '').trim();
  if (!t) return null;
  // 去掉 FTS5 的语法字符，避免用户输入被当成表达式解析
  const safe = t.replace(/["*():^]/g, ' ').trim();
  if (!safe) return null;
  const tokens = toIndexTokens(safe);
  return tokens || null;
}

/**
 * 清掉 0 字节 WAL 与配套 SHM。
 *
 * Node 24 + Windows 上实测：写连接正常关闭后会留下 0 字节的 `-wal` 和
 * `-shm`，下一次打开同一个库直接报 `disk I/O error`，直到手工删掉这两个
 * 文件才恢复。0 字节 WAL 表示没有任何未 checkpoint 的帧，删掉不影响数据；
 * 非空 WAL 一律不动。被其他进程占用时删不掉，交给后面的 immutable 兜底。
 */
function clearEmptySidecars(file) {
  const wal = `${file}-wal`;
  try {
    if (fs.statSync(wal).size !== 0) return;
  } catch {
    return;
  }
  for (const p of [wal, `${file}-shm`]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 被占用就保持原样 */
    }
  }
}

/**
 * 打开索引库。
 *
 * WAL + busy timeout 是必须的：建索引时会长时间持有写事务，
 * 而 `serve` 起的网页在同一时刻可能正在搜。没有这两项，
 * 查询会直接抛 "database is locked"，用户看到的就是一个报错的页面。
 * WAL 让读写互不阻塞，timeout 给偶发的写锁冲突一个等待窗口。
 */
function openIndex({ create = true } = {}) {
  const file = indexFile();
  if (!create && !fs.existsSync(file)) return null;

  // 读路径一律只读打开：查看器本身是只读的，不需要为了查一次
  // 去写 schema 或切 WAL。
  if (!create) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let db;
      try {
        db = new DatabaseSync(file, { readOnly: true });
        db.prepare('pragma busy_timeout = 5000').run();
        // 真的读一次库，确认 WAL/SHM 没被别的进程锁死
        db.prepare('select count(*) c from sqlite_master').get();
        return db;
      } catch {
        try {
          if (db) db.close();
        } catch {
          /* 关不掉也不影响后面的兜底 */
        }
        // 第一次失败先清掉 0 字节边车再试一次；还可能只是被写锁占住，
        // 那就别再动文件，交给下面的 immutable 兜底。
        if (attempt === 0) clearEmptySidecars(file);
        else break;
      }
    }
    // 索引文件被写锁占住时，普通只读连接可能连 -shm 都建不出来。
    // 查看器只要求能读，退到 immutable 打开即可，代价是可能读到
    // 最后一次 checkpoint 的版本——档案场景里这比整页报错好。
    return new DatabaseSync('file:' + file.replace(/\\/g, '/') + '?immutable=1', {
      readOnly: true,
    });
  }

  // 写打开前先清一次：上一个写进程异常退出时留下的空 WAL 会让本次 open
  // 直接 disk I/O error。只在确认 WAL 为 0 字节时动手，见函数注释。
  clearEmptySidecars(file);
  fs.mkdirSync(indexDir(), { recursive: true });

  const db = new DatabaseSync(file);
  // journal_mode 是持久化设置，设一次即可；timeout 每次连接都要设
  try {
    db.prepare('pragma journal_mode = wal').get();
  } catch {
    /* 已经设过或正在被写锁占用，用默认模式也能跑 */
  }
  try {
    db.prepare('pragma busy_timeout = 5000').run();
  } catch {
    /* 老版本不支持，忽略 */
  }

  for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run();
  migrate(db);
  // 老库在这里补齐触发器；新库也在这里建。之后 doc 的增删改自动同步到 FTS。
  ensureTriggers(db);
  return db;
}

/**
 * 老索引库的列迁移。
 *
 * `create table if not exists` 不会给已存在的表加列，所以新增字段要单独补。
 * 迁移必须是幂等的：每次打开都跑一遍，加过就跳过。
 *
 * kind 列的意义：同一个词可能在主会话和子代理会话里都出现，搜索结果必须
 * 能区分——否则用户读到一段"子代理查到的细节"会以为是主对话说的。
 */
function migrate(db) {
  let cols;
  try {
    cols = db.prepare('pragma table_info(doc)').all();
  } catch {
    return;
  }
  const has = new Set(cols.map((c) => c.name));
  if (!has.has('kind')) {
    try {
      db.prepare("alter table doc add column kind text not null default 'main'").run();
    } catch {
      /* 并发建索引时可能已被别人加上 */
    }
  }
  if (!has.has('body_z')) {
    try {
      db.prepare('alter table doc add column body_z blob').run();
    } catch {
      /* 并发建索引时可能已被别人加上 */
    }
  }
  migrateBodyZ(db);
}

/**
 * 把老库里的明文正文压进 body_z，一次性迁移。
 *
 * 进度用 meta.body_z_done 标记：每批 50 行各自提交，处理过的行 body 已置空，
 * 下次 select 不会再选中。所以中断后重跑天然从断点继续，标记只在全部完成后写。
 *
 * 迁移期间临时摘掉 FTS 触发器：这条 update 只动 body/body_z，fts_text 一个字符
 * 都不变，触发器却会为每一行做一次等价的 delete+insert，在全量倒排上纯属白付
 * 代价。崩溃的话触发器由 openIndex 在 migrate 之后补回，倒排内容本来就没变。
 */
function migrateBodyZ(db) {
  let done;
  try {
    done = db.prepare("select v from meta where k = 'body_z_done'").get();
  } catch {
    return;
  }
  if (done) return;

  const sel = db.prepare('select rowid as rid, body from doc where body is not null limit ?');
  const hasRows = sel.get(BATCH);
  if (!hasRows) {
    db.prepare("insert or replace into meta (k, v) values ('body_z_done','1')").run();
    return;
  }

  dropTriggers(db);

  const upd = db.prepare('update doc set body_z = ?, body = null where rowid = ?');
  const begin = db.prepare('begin');
  const commit = db.prepare('commit');
  const rollback = db.prepare('rollback');

  for (;;) {
    const rows = sel.all(BATCH);
    if (!rows.length) break;
    begin.run();
    try {
      for (const r of rows) upd.run(compressBody(r.body), r.rid);
      commit.run();
    } catch (e) {
      rollback.run();
      throw e;
    }
  }

  db.prepare("insert or replace into meta (k, v) values ('body_z_done','1')").run();

  // 迁移完成后回收空闲页。不 VACUUM 的话文件不会变小（只是停止增长），
  // 压缩就白做了。这是一次性操作，失败不影响正确性：被并发读占用或磁盘
  // 不够时保持原样即可。
  try {
    db.prepare('vacuum').run();
  } catch {
    /* 下次打开不会重试（body_z_done 已写），文件只是没缩小 */
  }
}

/**
 * 从会话的 source 字段推出"索引该按什么判过期"。
 *
 * source 有四种形态，前三种都是路径，第四种不是：
 *
 *   /path/a.jsonl                单文件
 *   /path/a.jsonl|/path/b.jsonl  registry 按 agent|id 合并的多段（Codex 续接）
 *   /path/db.sqlite#session_id   SQLite 源，'#' 前面才是路径
 *   db:<session-id>              Hermes——只记了会话 id，没有路径
 *
 * 这里曾经有两个真实缺陷，都会让索引**静默不更新**：
 *
 *   1. 多段 source 直接 statSync 整个字符串，必然 ENOENT，mtime 记 null。
 *      而 null === null 成立，于是"永远命中缓存"，会话再怎么追加都不重建。
 *      本机实测 28 场 Codex 会话中招。
 *   2. Hermes 的 db: 前缀同样 statSync 失败，本机 165 场全部 mtime=null，
 *      等于 Hermes 的索引一旦建成就冻结在第一次。
 *
 * 两条都造成"搜不到刚聊过的内容"，且不报错。修法是：
 *   - 多段取**最大** mtime、求和 size：任一段有新内容就算过期（早的段不需要再重建）
 *   - db: 形态回退到 Hermes 自己的库路径
 *
 * 取最大而不是最小：包络的结束时间由最后一段决定，索引正文也包含全部段。
 *
 * @returns {{mtime: number, size: number} | null}
 */
function sourceStamp(session) {
  if (!session || !session.source) return null;

  const src = String(session.source);

  if (src.startsWith('db:')) {
    const db = hermesDbPath();
    if (!db) return null;
    return statStamp([db], { sumSize: false });
  }

  // 多段路径：每段各自 stat，取最晚 mtime
  const parts = src.split('|');
  const files = parts.map((one) => one.split('#')[0]).filter(Boolean);
  if (!files.length) return null;
  return statStamp(files, { sumSize: true });
}

/** 对一组文件求"联合指纹"；任一文件不可读就返回 null（宁可重扫也不误判未变）。 */
function statStamp(files, { sumSize = false } = {}) {
  let mtime = 0;
  let size = 0;
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      return null;
    }
    mtime = Math.max(mtime, st.mtimeMs);
    size = sumSize ? size + st.size : st.size;
  }
  return { mtime, size };
}

/** Hermes 的库路径。与 scanners/hermes.js 的 hermesDir() 保持同一套候选顺序。 */
function hermesDbPath() {
  const home = os.homedir();
  const candidates = [
    process.env.HERMES_HOME && String(process.env.HERMES_HOME).trim(),
    path.join(home, '.hermes'),
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'hermes')
      : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    const p = path.join(dir, 'state.db');
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 建索引 / 增量更新。
 *
 * 只重读"源文件变了"的会话。判断依据是同一个源文件的 (mtime, size)，
 * 与 registry 的扫描缓存同源，两边不会打架。
 *
 * 倒排的维护分两条路：
 *
 *   - 增量（doc 表里已经有东西）：doc 的增删改由触发器同步进 doc_fts，
 *     改一场就只动一场。**不再调用 rebuild**——那会把整个倒排重建一遍，
 *     改一场也要付全量代价。
 *   - 全量（首次建库 / force）：先摘掉触发器，把会话批量写进 doc，
 *     最后用 FTS5 原生的 rebuild 一次建完倒排，再把触发器装回去。
 *
 * 全量为什么不能逐行触发：每条插入都要在越来越大的倒排索引上做局部重排，
 * 实测处理到六十来场就几乎停住；先写后 rebuild 才能一次 bulk 建完。
 *
 * 写入用事务批提交：SQLite 默认每条 insert 单独 fsync，几千条会拖成几分钟。
 */
export async function buildIndex({ force = false, onProgress } = {}) {
  const db = openIndex();
  // 复制品（Claude 的 --fork-session / 完全复制）与原会话内容一字不差，
  // 索引它们只会让每个关键词多出一条重复命中。它们仍然可以被 read_session
  // 按 id 读到；这里只是不进全文索引。现有索引里的复制品会在下面的
  // 「已不在 live 集合」清理里被删掉。
  const { sessions } = scanCached({});
  const indexable = sessions.filter((s) => !s.copyOf);

  const existing = new Map();
  for (const r of db.prepare('select key, mtime, size, title, start, end from doc').all()) {
    existing.set(r.key, { mtime: r.mtime, size: r.size, title: r.title, start: r.start, end: r.end });
  }

  // doc 表里一场都没有 = 首次建库；force 是用户显式要求全部重读。
  // 这两条路走全量 rebuild，所以先把触发器摘掉。
  const full = force || existing.size === 0;
  if (full) dropTriggers(db);

  let reused = 0;
  let rebuilt = 0;
  let failed = 0;

  const delDoc = db.prepare('delete from doc where key = ?');
  const insDoc = db.prepare(
    `insert into doc (key, agent, id, project, title, start, end, chars, mtime, size, kind, body, body_z, fts_text)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  const begin = db.prepare('begin');
  const commit = db.prepare('commit');
  const rollback = db.prepare('rollback');

  let pending = 0;

  // ---- 阶段一：收集正文 ----
  for (let i = 0; i < indexable.length; i++) {
    const s = indexable[i];
    const key = `${s.agent}|${s.id}`;

    let mtime = null;
    let size = null;
    const stamp = sourceStamp(s);
    if (stamp) {
      mtime = stamp.mtime;
      size = stamp.size;
    }

    const prev = existing.get(key);
    // 复用条件不只是"源文件没变"。
    //
    // 会话的 title/start/end 可能被**旁路数据**修正（Codex 的 threads 表就改
    // 这三个，见 scanners/codex.js 的 enrich），而源文件一个字没动。只看
    // (mtime, size) 的话，索引会一直显示旧的占位标题和错误的起止时间。
    // 所以这三个字段也要比一遍——比一次字符串/数字，比重新读正文便宜得多。
    const metaSame =
      prev &&
      prev.title === s.title &&
      prev.start === (s.start ? s.start.getTime() : null) &&
      prev.end === (s.end ? s.end.getTime() : null);

    if (prev && prev.mtime === mtime && prev.size === size && metaSame && !force) {
      reused++;
      if (onProgress) onProgress({ phase: 'collect', i, total: indexable.length, reused, rebuilt, failed });
      continue;
    }

    let body = null;
    try {
      const messages = await readSessionContent(s);
      body = messagesToText(messages);
    } catch {
      failed++;
      if (onProgress) onProgress({ phase: 'collect', i, total: indexable.length, reused, rebuilt, failed });
      continue;
    }

    if (pending === 0) begin.run();
    try {
      delDoc.run(key);
      insDoc.run(
        key,
        s.agent,
        s.id,
        s.project,
        s.title,
        s.start ? s.start.getTime() : null,
        s.end ? s.end.getTime() : null,
        body.length,
        mtime,
        size,
        s.kind || 'main',
        null,
        compressBody(body),
        toIndexTokens(body)
      );
      pending++;
      rebuilt++;
    } catch {
      failed++;
    }

    if (pending >= BATCH) {
      commit.run();
      pending = 0;
    }

    if (onProgress) onProgress({ phase: 'collect', i, total: indexable.length, reused, rebuilt, failed });
  }

  // 会话已经不在任何 Agent 存储里的，索引也清掉
  const live = new Set(indexable.map((x) => `${x.agent}|${x.id}`));
  let removed = 0;
  for (const key of existing.keys()) {
    if (live.has(key)) continue;
    if (pending === 0) begin.run();
    delDoc.run(key);
    pending++;
    removed++;
  }

  if (pending > 0) {
    try {
      commit.run();
    } catch (e) {
      rollback.run();
      // 全量路径下触发器是摘掉的，已经提交的批没进 FTS。这里补一次 rebuild
      // 再抛，别让索引停在"doc 有、倒排没有"的半截状态。
      if (full) {
        try {
          rebuildFts(db);
          ensureTriggers(db);
        } catch {
          /* 尽力而为；下次打开还会补触发器 */
        }
      }
      db.close();
      throw new Error('写入索引时出错，已回滚最后一批: ' + (e && e.message ? e.message : e));
    }
  }

  // ---- 阶段二：同步倒排 ----
  //
  // 增量：这里已经无事可做——doc 的增删改在写入时就被触发器同步进了
  // doc_fts，改一场只付一场的代价。
  //
  // 全量：写入期间触发器是摘掉的，所以必须用一次 rebuild 补建倒排，
  // 再把触发器装回去。
  let fts = 'incremental';
  if (full) {
    if (onProgress) onProgress({ phase: 'index', i: indexable.length, total: indexable.length, reused, rebuilt, failed });
    rebuildFts(db);
    ensureTriggers(db);
    fts = 'rebuild';
  }

  db.prepare('insert or replace into meta (k, v) values (?,?)').run('built_at', String(Date.now()));
  db.close();

  return { total: indexable.length, reused, rebuilt, failed, removed, fts };
}

/**
 * 重建倒排索引。
 *
 * 用 FTS5 的 'rebuild' 命令：它按 content 表一次性扫全表建倒排，
 * 内部做的正是一次排序合批，比逐条 insert 快一个数量级
 * （逐条插入实测几百条后就卡到不可接受）。
 *
 * 只在首次建库、--force 和 `reindex` 三种场景用。日常增量更新由
 * doc_fts_* 触发器维护，不会走到这里——改一场不必付全量的代价。
 */
export function rebuildFts(db) {
  const t0 = Date.now();
  db.prepare("insert into doc_fts(doc_fts) values('rebuild')").run();
  return { ms: Date.now() - t0 };
}

/**
 * 把消息摊平成一段可检索文本。
 *
 * 只索引人说的话和工具调用摘要，不索引完整工具输出：输出动辄几万字，
 * 多是日志和源码，放进去既占空间又把真正的对话信号淹没。
 * 推理也不进索引——那是模型的思考过程，不是"发生过什么"。
 */
function messagesToText(messages) {
  const out = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'text') out.push(stripEmbeddedTranscript(p.text));
      else if (p.kind === 'tool') {
        const detail = p.input ? summarizeInput(p.input, { limit: 300, jsonLimit: 300 }) : '';
        out.push(`[${p.name}${detail ? ' ' + detail : ''}]`);
      }
    }
  }
  return out.join('\n');
}

/**
 * 剥掉子代理 prompt 里"嵌入的父会话 transcript / 待审动作"。
 *
 * ## 这是什么
 *
 * Codex 有一类子代理（guardian）不是去做活，而是**审阅**父会话。它每审一个
 * 动作，就收到一条这样的消息：
 *
 *     The following is the Codex agent history whose request action you are assessing...
 *     >>> TRANSCRIPT START
 *     [1] user: ...
 *     ...（父会话的完整片段，含工具输出、测试日志、文件内容）
 *     >>> TRANSCRIPT END
 *     The Codex agent has requested the following action:
 *     >>> APPROVAL REQUEST START
 *     Planned action JSON: { ... }
 *     >>> APPROVAL REQUEST END
 *
 * 而且**一场子代理里有几十轮**：本机实测最大的一场 718 KB 里嵌了 30+ 组，
 * 每一组都是"父会话片段 + 一个待审动作"。父会话那边本来就有这些内容。
 *
 * ## 为什么要剥
 *
 * 本机实测 1543 场子代理里 650 场是这类，合计 74.7 M 字符，占子代理索引
 * 总量的 86%。同一份对话被索引两遍，搜索「支付回调」时命中结果被复制品
 * 挤占。顺带：这些嵌入片段里常有明文 API key（实测就有），少索引一份就
 * 少一个泄漏面。
 *
 * ## 剥到什么程度
 *
 * 只剥标记包住的部分，**标记之外全部保留**——那里才是这场子代理的产出：
 * 它对每个动作的判断（"allow"/"deny" 及理由）。那是父会话没有的信息。
 *
 * 用全局正则而不是 indexOf：一场里有几十组，只剥第一组等于没剥。
 *
 * 导出是为了能单独测：这条规则直接决定索引里存什么，不该只能靠建完整
 * 索引来验证。
 */
export function stripEmbeddedTranscript(text) {
  if (typeof text !== 'string' || !text) return text;

  let out = text;

  // 1) 嵌入的父会话片段。
  //
  // 有两种变体，而且**会嵌套**：DELTA 块（"自上次审阅以来的增量"）有时整块
  // 落在普通 TRANSCRIPT 块内部。必须**先剥 DELTA 再剥普通块**——
  // 反过来的话，非贪婪匹配会先吃掉外层的 START...END，把内层 DELTA 的
  // END 留成一个孤立的标记（实测残留 96 场）。
  out = out.replace(
    />>> TRANSCRIPT DELTA START[\s\S]*?>>> TRANSCRIPT DELTA END/g,
    '（已剥离：父会话增量副本）'
  );
  out = out.replace(
    />>> TRANSCRIPT START[\s\S]*?>>> TRANSCRIPT END/g,
    '（已剥离：此处嵌入了父会话的 transcript 副本）'
  );
  // 没有 END 的截断情况：从 START 剥到末尾。
  // 两种变体都要覆盖，且 DELTA 优先。
  out = out.replace(/>>> TRANSCRIPT (?:DELTA )?START[\s\S]*$/, '（已剥离：截断的父会话 transcript）');
  // 配对缺失后残留的孤立 END 标记也清掉，否则它会留在索引里当噪音
  out = out.replace(/>>> TRANSCRIPT (?:DELTA )?END/g, '');

  // 2) 待审动作的计划 JSON。它同样是从父会话抄来的，且常含明文密钥。
  out = out.replace(
    />>> APPROVAL REQUEST START[\s\S]*?>>> APPROVAL REQUEST END/g,
    '（已剥离：此处是待审动作的完整参数）'
  );
  out = out.replace(/>>> APPROVAL REQUEST START[\s\S]*$/, '（已剥离：截断的待审动作）');

  // 3) 剥完后如果只剩一堆同样的引导句，压成一句，避免 30 份模板噪音
  const boiler =
    'The following is the Codex agent history whose request action you are assessing.';
  if (out.includes(boiler)) {
    const firstIdx = out.indexOf(boiler);
    const head = out.slice(0, firstIdx);
    const tail = out.slice(firstIdx);
    // 引导句本身保留一份，其余重复的清掉
    const cleanedTail = tail.split(boiler).filter(Boolean).join('\n');
    out = `${head}${boiler}\n${cleanedTail}`;
  }

  const trimmed = out.replace(/\n{3,}/g, '\n\n').trim();
  return trimmed || '（这场子代理的 prompt 全部是嵌入的父会话副本，已从索引中剥离）';
}

/**
 * 搜索。
 *
 * 返回每场会话最相关的一段摘录，而不是整篇——搜索结果的价值在于
 * "让你想起那场对话"，不是把内容再读一遍。
 *
 * **子代理会话默认也搜**：它们记着主会话没记的细节（子代理实际查了什么、
 * 看到了什么），把它们排除会让搜索结果变浅。每条结果都带 `kind`，
 * 调用方据此标注"这是子代理会话"，不要让用户误以为主对话说过这话。
 * 只想要主会话时传 `includeSubagents: false`。
 */
export function search(query, { limit = 20, agent, project, includeSubagents = true } = {}) {
  const db = openIndex({ create: false });
  if (!db) {
    return { ready: false, hits: [], total: 0, message: '索引还没建，先运行：agent-archive index' };
  }

  const match = queryFor(query);
  if (!match) {
    db.close();
    return { ready: true, hits: [], total: 0 };
  }

  let sql = `select d.key, d.agent, d.id, d.project, d.title, d.start, d.end, d.chars,
                    coalesce(d.kind,'main') as kind,
                    d.body as hit_body,
                    ${hasBodyZ(db) ? 'd.body_z as hit_body_z,' : ''}
                    bm25(doc_fts) as score
             from doc_fts
             join doc d on d.rowid = doc_fts.rowid
             where doc_fts match ?`;
  const params = [match];

  if (agent) {
    sql += ' and d.agent = ?';
    params.push(agent);
  }
  if (project) {
    sql += ' and lower(d.project) like ?';
    params.push('%' + project.toLowerCase().replace(/\\/g, '/') + '%');
  }
  if (!includeSubagents) {
    sql += " and coalesce(d.kind,'main') = 'main'";
  }

  sql += ' order by score limit ?';
  params.push(limit);

  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } catch {
    db.close();
    return { ready: true, hits: [], total: 0, message: '查询语法无法识别' };
  }

  const hits = rows.map((r) => ({
    agent: r.agent,
    id: r.id,
    project: r.project,
    title: r.title,
    start: r.start ? new Date(r.start) : null,
    end: r.end ? new Date(r.end) : null,
    chars: r.chars,
    kind: r.kind || 'main',
    snippet: excerpt(readBody({ body: r.hit_body, body_z: r.hit_body_z }), query),
    score: r.score,
  }));

  db.close();
  return { ready: true, hits, total: hits.length };
}

/** 只重建倒排索引时用：内部已经打开好的连接交给它。 */
export { openIndex };
/** 索引规模，供 stats 展示。 */
export function indexStats() {
  const db = openIndex({ create: false });
  if (!db) return { exists: false, docs: 0, chars: 0, builtAt: null, bytes: 0 };
  const row = db.prepare('select count(*) c, coalesce(sum(chars),0) n from doc').get();
  const meta = db.prepare("select v from meta where k = 'built_at'").get();
  db.close();
  let bytes = 0;
  try {
    bytes = fs.statSync(indexFile()).size;
  } catch {
    /* 无所谓 */
  }
  return {
    exists: true,
    docs: row.c,
    chars: row.n,
    builtAt: meta ? new Date(Number(meta.v)) : null,
    bytes,
  };
}
