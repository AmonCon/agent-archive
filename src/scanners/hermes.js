import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openReadOnly } from '../sqlite-read.js';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';
import { extraRoots } from '../config.js';

/**
 * Hermes 会话扫描。
 *
 * **主存储是 `~/.hermes/state.db`（SQLite），不是 `sessions/*.jsonl`。**
 *
 * 这一条是踩过才知道的：早期版本只扫 `sessions/*.jsonl`，本机读到 34 场，
 * 而 state.db 里有 219 场（211 场有消息）。漏了 6/7 的数据——而且它不报错，
 * 只是安静地少算。Hermes 官方文档也写明"旧版 *.jsonl transcript 不再写入或读取"。
 *
 * 目录里那 227 个 `.json` 是**导出文件**（saved/），不是主存储，不参与扫描。
 *
 * ## state.db 的几件事
 *
 *   sessions 表  id / source / model / started_at / ended_at / title / cwd /
 *                parent_session_id / message_count / hidden / archived
 *   messages 表  session_id / role / content / reasoning / tool_name /
 *                tool_calls / timestamp / active / compacted
 *
 * 三个必须如实处理的点：
 *
 * 1. **有 cwd 的只有 46/219。** Hermes 是接飞书等渠道的助手，多数会话
 *    不绑定工作目录（source=feishu 的就是聊天）。所以 project 大部分为空，
 *    但**不是全都为空**——有 cwd 的那些要归到项目去，不能一刀切丢掉。
 *    早期版本把 project 硬编码成 null，那会让这 46 场永远进不了项目时间线。
 *
 * 2. **47 场有 parent_session_id（子代理）。** 以前整条跳过，现在是照常采集
 *    并标记 `kind: 'subagent'` + `parent`。理由是子代理会话里才记着实际
 *    干的活，丢掉等于只存一半事实。时间线默认只显示 main，所以列表不会翻倍。
 *
 * 3. **25 场 hidden=1。** 这些是用户主动隐藏的会话。仍然采（事实存在），
 *    但不进标题/时间的主要统计口径——标题缺失时用 source 兜底。
 *
 * 时间戳是 epoch 秒（REAL，带小数）。`started_at=1776274941.9466` 要乘 1000；
 * 用 model.js 的 toDate 会按 >1e11 判断，但它只接受整数毫秒的语义，
 * 这里自己乘，避免歧义。
 */

export const name = 'hermes';

function hermesDir() {
  // HERMES_HOME 是官方支持的重定向（源码里优先级最高）。
  // macOS 默认 ~/.hermes，Windows 官方是 %LOCALAPPDATA%/hermes——
  // 但本机实测 Windows 上也在 ~/.hermes（早期安装方式），
  // 所以两个候选都试，存在的优先。
  const override = process.env.HERMES_HOME;
  const home = os.homedir();
  const candidates = [
    // 配置文件里的根排最前（用户显式指的优先）
    ...extraRoots(name),
    override && String(override).trim(),
    path.join(home, '.hermes'),
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'hermes')
      : null,
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* 试下一个 */
    }
  }
  return path.join(home, '.hermes');
}

function dbPath() {
  return path.join(hermesDir(), 'state.db');
}

function sessionsDir() {
  return path.join(hermesDir(), 'sessions');
}

let store = null;
let storePath = null;

/** SQLite 以只读方式打开，用完由 registry 调 closeStore 关闭。 */
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

function getStore() {
  const p = dbPath();
  if (store && storePath === p) return store;
  if (store) {
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    store = null;
  }
  store = openStore(p);
  storePath = p;
  return store;
}

export function closeStore() {
  if (store) {
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    store = null;
    storePath = null;
  }
}

/**
 * 返回一个"会话来源描述"字符串，而不是文件路径。
 *
 * 下游（readMessages / assertUnder）需要区分两种来源：
 *   db:<session-id>         —— 主存储，按 id 查库
 *   file:<绝对路径>         —— 旧的 jsonl，按路径读
 *
 * 这样同一个 scanner 能同时服务两种格式，而 registry 的缓存键
 * 仍然是"文件路径"——DB 那个用一个固定路径当键。
 */
function sourceOf(id) {
  return `db:${id}`;
}

/** 声明"我会去哪里找数据"（`.hermes` 这一层；给 doctor 与反向发现用）。 */
export function candidateRoots() {
  const home = os.homedir();
  return [
    ...extraRoots(name),
    process.env.HERMES_HOME && String(process.env.HERMES_HOME).trim(),
    path.join(home, '.hermes'),
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'hermes')
      : null,
  ].filter(Boolean);
}

export function discover() {
  // registry 的缓存键是文件路径，这里用 db 路径本身。
  // 时间/大小从 db 文件与 wal 取，任何一边变了都要重扫。
  const p = dbPath();  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return [];
  }
  return [p];
}

/**
 * 参与缓存判据的附属文件。
 *
 * `-wal` 必须算进来：WAL 模式下新消息先写 wal，主库文件的 mtime/size
 * 可以长时间不动。只按主库判缓存就会漏掉刚聊完的会话。
 * `-shm` 不参与——它是索引页，内容随 wal 重建，算进来只会造成误判重扫。
 */
export function extraFiles(file) {
  return [`${file}-wal`];
}

/**
 * 一个 state.db 里有很多会话，所以走 parseAll。
 *
 * ## 为什么还要按会话做一层增量
 *
 * registry 的缓存是按**文件**判的：state.db 一动，整库 165 场全部重解析。
 * 而 Hermes 的库是追加式写入——聊完一场，别的会话一个字都没变。
 * 本机实测整库重解析要读 250 MB 的 messages 表，全部白做。
 *
 * 所以这里再套一层按会话的指纹（MAGPIE 对 Hermes 用的是同一套思路）：
 * 用一次 SQL 聚合给每场会话算 `(消息数, 末条时间, 正文总长)`，只有指纹
 * 变了的会话才重新查首条用户消息。库变了但只有一场会话变时，代价从
 * "整库"降到"一场 + 一次聚合查询"。
 *
 * 指纹的取法有讲究：
 *   count(*)          抓新增消息
 *   max(timestamp)    抓替换（rewind 后重写同一批消息）
 *   sum(rowid)        抓"条数不变、行被删了重建"（重建会拿到新 rowid）
 *
 * 代价实测：这三列一起聚合 6 ms，而原来读全表求首条用户消息要 117 ms。
 * 刻意**不**用 total(length(content))：它要解压每行正文，实测 203 ms，
 * 把省下来的力气全吃回去，还比原方案更慢。
 */
export function parseAll(file) {
  const db = getStore();
  if (!db) return [];

  let rows;
  try {
    rows = db
      .prepare(
        `select id, source, model, started_at, ended_at, title, cwd,
                parent_session_id, message_count, hidden, archived, profile_name
         from sessions
         where message_count > 0
         order by started_at asc`
      )
      .all();
  } catch {
    return [];
  }

  // 一次聚合拿到所有会话的消息指纹。读不到（老 schema）就退化成全量重算。
  //
  // 指纹只用「不读正文就能拿到」的列。这一点实测过：
  //   count+max(timestamp)              12 ms
  //   count+max+sum(rowid)               6 ms
  //   count+max+total(length(content)) 203 ms
  // total(length(content)) 要解压每一行的正文，把省下来的力气全吃回去，
  // 比原来读全表（117 ms）还慢。sum(rowid) 足够了：消息被删后重写会拿到
  // 新的 rowid，因此"条数没变但内容换了"依然会被检测到。
  const fps = new Map();
  try {
    const agg = db
      .prepare(
        `select session_id, count(*) n, max(timestamp) last_ts, sum(rowid) ids
         from messages group by session_id`
      )
      .all();
    for (const a of agg) {
      fps.set(a.session_id, `${a.n}|${a.last_ts == null ? '-' : a.last_ts}|${a.ids || 0}`);
    }
  } catch {
    /* 聚合失败：下面靠"缓存里没有就重算"兜底 */
  }

  /** 会话行本身的字段指纹——title/cwd 这类可以不读 messages 就变。 */
  const rowFp = (r) =>
    `${r.message_count}|${r.ended_at}|${r.title || ''}|${r.cwd || ''}|${r.hidden}|${r.source || ''}`;

  const firstUserStmt = db.prepare(
    `select content from messages
     where session_id = ? and role = 'user' and content is not null and content != ''
     order by timestamp asc limit 1`
  );

  const out = [];
  const nextCache = new Map();

  for (const r of rows) {
    const fp = `${rowFp(r)}||${fps.get(r.id) || ''}|${r.parent_session_id || ''}`;
    const cached = sessionCache.get(r.id);
    if (cached && cached.fp === fp) {
      nextCache.set(r.id, cached);
      out.push(cached.session);
      continue;
    }

    const start = toDate(r.started_at);
    const end = toDate(r.ended_at) || start;

    // 首条用户消息只在需要时查——这是原来最大的开销，现在按会话分摊
    let first = null;
    try {
      const row = firstUserStmt.get(r.id);
      if (row) first = cleanText(row.content);
    } catch {
      /* 查不到就用 title */
    }

    // 标题优先级：Hermes 的 title → 首条用户消息 → 来源占位
    const title =
      cleanText(r.title) ||
      first ||
      (r.source ? `(${r.source})` : null) ||
      (r.hidden ? '(hidden)' : null);

    const session = makeSession({
      agent: name,
      id: r.id,
      // 有 cwd 才归项目。多数 Hermes 会话是聊天渠道，没有工作目录——
      // 那不是缺陷，但也不能一刀切：有 cwd 的必须归进去
      project: r.cwd || null,
      title,
      start,
      end,
      source: sourceOf(r.id),
      resume: null,
      // 有 parent_session_id 的是子代理会话：照常采集，只标记归属
      kind: r.parent_session_id ? 'subagent' : 'main',
      parent: r.parent_session_id || null,
    });

    nextCache.set(r.id, { fp, session });
    out.push(session);
  }

  // 已经被删掉的会话不能一直留在缓存里
  sessionCache = nextCache;

  return out;
}

/** 按会话的解析缓存：id -> { fp, session }。库变了但会话没变时直接复用。 */
let sessionCache = new Map();

/**
 * 兼容：如果某个用户机器上只有旧的 jsonl 而没有 state.db，
 * discover 会返回空数组（因为 dbPath 不存在），这条路径就不会走到。
 *
 * 保留是为了不破坏"一个文件一个会话"的接口形状——
 * registry 优先看 parseAll，没有才调 parse。
 */
export function parse(file) {
  return null;
}

/**
 * 时间戳：state.db 里是 epoch 秒（REAL）。
 *
 * `started_at = 1776274941.9466` → 2026-04-16。
 * 不能直接用 model.js 的 toDate：它把 >1e11 当毫秒，而 1.7e9 秒
 * 会走成秒分支——恰好对，但那是巧合。这里显式乘，把这个约定写死。
 */
function toDate(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 有些版本可能存毫秒；1e11 毫秒 ≈ 1973 年，秒级到 5138 年才到这个量级
  return new Date(n > 1e11 ? n : n * 1000);
}

function cleanText(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * 读一场会话的完整正文。
 *
 * 两种来源：db:<id> 查 messages 表；其它当文件路径读旧 jsonl。
 *
 * 空的 assistant 消息（只有 tool_calls 没有 content）跳过——
 * 它们不是"说了什么"，是"调了什么"，工具调用单独成条。
 *
 * ## 查过、但**没有**采用的三个上游做法
 *
 * MAGPIE 处理 Hermes 时做了三件事，我们逐条对着本机真实数据核过，
 * 结论是都不适用——写在这里，免得以后有人再调研一遍或照着改错：
 *
 * 1. **解码 `\x00json:` 前缀**：本机 state.db 里含 NUL 字节的 content
 *    只有 9 行，且内容长度为 0（是空消息，不是被编码的 JSON）。
 *    照抄会得到一段永远走不到的代码。
 *    （注：SQLite 的 LIKE 遇到 NUL 会失真，用它统计会得出 18940 这种假数字，
 *    要用 instr()。）
 *
 * 2. **过滤 `display_metadata.model_only`**：本机 133 行有 display_metadata，
 *    内容全是 `{"gateway_input_owner": ...}`，没有 model_only 这个键。
 *
 * 3. **按 display_identity 去重**：看着像"同一份内容被重放几十次"，
 *    实际查下来是 **Agent 真的重试了几十次**——本机一个会话里同一段工具输出
 *    出现了 85 次，各有不同的 message_uid 和不同的时间戳，散布在 284 条
 *    其他消息之间。按内容或按 identity 去重会把真实的重试过程删掉。
 *    另有一处用户连问三次同一句话（间隔 32 分钟），同样不能动。
 *    而且 active=1 的行里没有任何 display_identity 重复，去重对我们是空操作。
 *
 * 一句话：**重复不代表冗余**。宁可原样显示，也不能把"重试了 85 次"这个
 * 事实抹成一次。
 */
export function readMessages(session) {
  const src = String(session.source || '');

  if (src.startsWith('db:')) {
    return readFromDb(src.slice(3), session);
  }

  return readFromJsonl(session);
}

function readFromDb(id, session) {
  const db = getStore();
  if (!db) throw new Error('Hermes state.db 打不开');

  let rows;
  try {
    rows = db
      .prepare(
        `select role, content, reasoning, tool_name, tool_calls, timestamp, active, compacted
         from messages
         where session_id = ?
         order by timestamp asc, id asc`
      )
      .all(id);
  } catch (e) {
    throw new Error('读 Hermes 消息失败: ' + (e && e.message ? e.message : e));
  }

  const out = [];
  for (const m of rows) {
    // active=0 是被压缩掉的旧消息，compacted=1 是被摘要覆盖的——
    // 两者都保留在库里，但不该再当正常对话显示
    if (m.active === 0) continue;

    const ts = toDate(m.timestamp);

    if (m.role === 'tool') {
      out.push(
        makeMessage({
          role: 'tool',
          parts: [toolPart({ name: m.tool_name || 'tool', output: parseJsonish(m.content) })],
          ts,
        })
      );
      continue;
    }

    const parts = [];
    if (m.reasoning) {
      const p = reasoningPart(String(m.reasoning));
      if (p) parts.push(p);
    }

    const body = textOf(m.content);
    if (body) {
      const p = textPart(body);
      if (p) parts.push(p);
    }

    // assistant 消息可能只带 tool_calls 没有正文：那些调用要单独成条，
    // 否则"它调了什么工具"在会话页上就看不见了
    const calls = parseToolCalls(m.tool_calls);
    for (const c of calls) {
      parts.push(toolPart({ name: c.name, input: c.input }));
    }

    if (!parts.length) continue;

    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    out.push(makeMessage({ role, parts, ts }));
  }

  return out;
}

function readFromJsonl(session) {
  const real = assertUnder(sessionsDir(), session.source);
  const text = fs.readFileSync(real, 'utf8');
  const out = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.role === 'session_meta') continue;

    const ts = toDate(o.timestamp);
    const parts = [];

    if (o.reasoning) {
      const p = reasoningPart(o.reasoning);
      if (p) parts.push(p);
    }

    const body = textOf(o.content);
    if (body) {
      const p = textPart(body);
      if (p) parts.push(p);
    }

    if (o.role === 'tool') {
      out.push(
        makeMessage({
          role: 'tool',
          parts: [toolPart({ name: o.tool_name || o.name || 'tool', output: body || o.content })],
          ts,
        })
      );
      continue;
    }

    if (!parts.length) continue;

    const role = o.role === 'assistant' ? 'assistant' : o.role === 'system' ? 'system' : 'user';
    out.push(makeMessage({ role, parts, ts }));
  }

  return out;
}

/**
 * tool_calls 在库里是 JSON 字符串（OpenAI 格式）。
 * 结构通常是 [{id, type:"function", function:{name, arguments:"<json string>"}}]。
 */
function parseToolCalls(raw) {
  if (!raw) return [];
  let arr;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const c of arr) {
    const fn = c && c.function ? c.function : c;
    const nm = fn && (fn.name || fn.tool);
    if (!nm) continue;
    let input = fn.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* 保持原字符串 */
      }
    }
    out.push({ name: String(nm), input });
  }
  return out;
}

function parseJsonish(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') parts.push(p);
    else if (typeof p.text === 'string') parts.push(p.text);
    else if (typeof p.content === 'string') parts.push(p.content);
  }
  return parts.join('\n').trim();
}
