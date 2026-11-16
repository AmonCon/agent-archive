import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openReadOnly, findVersionedDb } from './sqlite-read.js';
import { priceFor, estimateCost } from './pricing.js';
import { dayKey } from './model.js';
import { statePath } from './paths.js';

/**
 * 用量层：各家 Agent 自己记下的 token 消耗。
 *
 * 和 `calls.js` 的分工：`calls` 读的是**网关**日志，只看得见经过网关的请求；
 * 这里读的是 Agent 自己的账本，不需要装网关，但各家记的粒度、口径都不同。
 *
 * ## 为什么不能把几个数直接相加
 *
 * 同一列 `input_tokens`，几家的含义不一样（实测，不是猜的）：
 *
 *   ZCode      input 含缓存。`provider_total_tokens = input + output`，
 *              而 cache_read 是 input 的子集 → 缓存读会被算成全价输入。
 *   OpenCode   input 不含缓存。实测某场 cache_read 6600 万、input 310 万，
 *              缓存读不可能大于总输入 → 只能是分开记的。
 *   Hermes     input 不含缓存。同样实测 cache_read(2.2 亿) > input(7500 万)。
 *   DSH        input 不含缓存。`totalTokens` 恒等于 input + output +
 *              cacheRead + cacheWrite，所以 input 是未缓存部分。
 *   Codex      只有 `threads.tokens_used` 一个会话级总量，没有缓存拆分，
 *              连它是哪种语义都看不出来。
 *
 * 所以每条记录都带 `semantic`（total / fresh / unknown），并统一换算成
 * `fresh`（不含缓存的输入）。聚合时**语义未知的行不参与缓存命中率**，
 * 因为把两种口径混进同一个分母，得出来的百分比没有任何意义。
 *
 * ## 为什么成本大多算不出来
 *
 * 只有 Agent 自己报了钱，我们才显示钱。Hermes 有 estimated_cost_usd，
 * OpenCode 有 cost，其余没有——**没有价就是没有价，不是 0 元**。
 * 把未知当 0 是最危险的错：汇总出来很便宜，其实是没法算。
 * 以后要接价目表，也应该单独做，并且明确标成"估算"。
 *
 * ## 覆盖是可选的
 *
 * 每家 Agent 的库版本都可能变。读不到就记一条 reason 继续跑，
 * 不能让某个 Agent 的表结构变化把整个用量层带崩。
 */

/* ------------------------------ 归一化 ------------------------------ */

/**
 * 把原始 input 换算成"不含缓存的输入"。
 *
 * semantic='total' 时 input 已包含缓存读写，要减掉；减成负数说明源的数据自相矛盾，
 * 归零而不是报负数——负数会悄悄污染求和。
 */
export function normalizeFresh({ input, cacheRead = 0, cacheWrite = 0, semantic }) {
  if (semantic === 'total') return Math.max(input - cacheRead - cacheWrite, 0);
  return input;
}

function makeRow(parts) {
  const input = Number(parts.input) || 0;
  const cacheRead = Number(parts.cacheRead) || 0;
  const cacheWrite = Number(parts.cacheWrite) || 0;
  return {
    agent: parts.agent,
    source: parts.source || parts.agent,
    fidelity: parts.fidelity || 'request',
    at: parts.at,
    session: parts.session || null,
    model: parts.model || null,
    provider: parts.provider || null,
    // 这个源是不是按"模型请求数"计的。会话级总量的源这里是 null。
    calls: parts.calls == null ? null : Number(parts.calls),
    input,
    semantic: parts.semantic || 'unknown',
    fresh: normalizeFresh({ input, cacheRead, cacheWrite, semantic: parts.semantic || 'unknown' }),
    output: Number(parts.output) || 0,
    cacheRead,
    cacheWrite,
    reasoning: Number(parts.reasoning) || 0,
    durationMs: parts.durationMs == null ? null : Number(parts.durationMs),
    ttftMs: parts.ttftMs == null ? null : Number(parts.ttftMs),
    // 只有源自己报的钱才填；null 表示"没算过"，不是 0。
    cost: parts.cost == null ? null : Number(parts.cost),
    costStatus: parts.costStatus || null,
    currency: parts.currency || null,
  };
}

/* ------------------------------ 定位 ------------------------------ */

/** 借扫描器的 discover 找库，避免路径逻辑两处各写一遍、日后漂移。 */
async function dbFromScanner(id) {
  try {
    const mod = await import(`./scanners/${id}.js`);
    const files = await mod.discover();
    return files.find((f) => /\.(sqlite|db|db3)$/i.test(f)) || null;
  } catch {
    return null;
  }
}

function columns(db, table) {
  try {
    return db.prepare(`pragma table_info("${table}")`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------ 各家读取 ------------------------------ */

/** ZCode：model_usage 一次模型请求一行，字段最全。 */
async function readZcode({ dbPath } = {}) {
  const file = dbPath || (await dbFromScanner('zcode'));
  if (!file) return { ready: false, reason: '没有找到 ZCode 的会话库' };
  const db = openReadOnly(file);
  if (!db) return { ready: false, reason: 'ZCode 的库打不开' };
  try {
    if (!columns(db, 'model_usage').length) {
      return { ready: false, reason: '这个版本的 ZCode 没有 model_usage 表' };
    }
    const rows = db
      .prepare(
        `select session_id, model_id, provider_id, status, started_at,
                input_tokens, output_tokens, reasoning_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                duration_ms, time_to_first_token_ms
         from model_usage`
      )
      .all();
    return {
      ready: true,
      fidelity: 'request',
      rows: rows
        .filter((r) => Number.isFinite(r.started_at))
        .map((r) =>
          makeRow({
            agent: 'zcode',
            fidelity: 'request',
            at: r.started_at,
            session: r.session_id,
            model: r.model_id || null,
            provider: r.provider_id || null,
            calls: 1,
            input: r.input_tokens,
            // 实测 10,273 行里 provider_total 全部等于 input + output，
            // 而 cache_read 是 input 的子集 → input 是"整段提示词"，含缓存。
            // 实测没有 cache_creation > 0 的行，所以缓存写是否也在 input 里
            // 未实测；按同一套字段的语义一并减掉，并在文档里标明了这一点。
            semantic: 'total',
            output: r.output_tokens,
            reasoning: r.reasoning_tokens,
            cacheRead: r.cache_read_input_tokens,
            cacheWrite: r.cache_creation_input_tokens,
            durationMs: r.duration_ms,
            ttftMs: r.time_to_first_token_ms,
          })
        ),
    };
  } finally {
    closeQuietly(db);
  }
}

/** Hermes：session_model_usage 按「会话 × 模型」一行，少数行带成本。 */
async function readHermes({ dbPath } = {}) {
  const file = dbPath || (await dbFromScanner('hermes'));
  if (!file) return { ready: false, reason: '没有找到 Hermes 的 state.db' };
  const db = openReadOnly(file);
  if (!db) return { ready: false, reason: 'Hermes 的库打不开' };
  try {
    // 老版本可能只有 sessions 表，没有 session_model_usage
    const table = columns(db, 'session_model_usage').length
      ? 'session_model_usage'
      : columns(db, 'sessions').length
        ? 'sessions'
        : null;
    if (!table) return { ready: false, reason: '这个版本的 Hermes 没有用量表' };

    // 两张表的列不完全一样。缺的列要在 SELECT 里补 null——
    // 写成 `case when 0 then x else null end` 也会解析 x，列不存在照样报错。
    const cols = columns(db, table);
    const expr = (name) => (cols.includes(name) ? name : `null as ${name}`);
    const sessionCol = cols.includes('session_id') ? 'session_id' : 'id as session_id';

    const rows = db
      .prepare(
        `select ${sessionCol}, ${expr('model')}, ${expr('billing_provider')}, ${expr('api_call_count')},
                input_tokens, output_tokens, ${expr('cache_read_tokens')}, ${expr('cache_write_tokens')},
                ${expr('reasoning_tokens')}, ${expr('estimated_cost_usd')}, ${expr('actual_cost_usd')},
                ${expr('cost_status')}, ${expr('first_seen')}, ${expr('last_seen')}
         from ${table}`
      )
      .all();

    const out = [];
    for (const r of rows) {
      const at = toMs(r.first_seen) ?? toMs(r.last_seen);
      if (at == null) continue;
      // 实收优先于估算；两个都是 0 时当"没算过"，不当免费
      const actual = Number(r.actual_cost_usd);
      const est = Number(r.estimated_cost_usd);
      const hasActual = Number.isFinite(actual) && actual > 0;
      const hasEst = Number.isFinite(est) && est > 0;
      out.push(
        makeRow({
          agent: 'hermes',
          fidelity: 'session-model',
          at,
          session: r.session_id,
          model: r.model || null,
          provider: r.billing_provider || null,
          calls: Number.isFinite(r.api_call_count) && r.api_call_count > 0 ? r.api_call_count : null,
          input: r.input_tokens,
          // 实测 cache_read > input → input 不含缓存
          semantic: 'fresh',
          output: r.output_tokens,
          reasoning: r.reasoning_tokens,
          cacheRead: r.cache_read_tokens,
          cacheWrite: r.cache_write_tokens,
          cost: hasActual ? actual : hasEst ? est : null,
          costStatus: hasActual ? 'actual' : hasEst ? 'estimated' : r.cost_status || 'unknown',
          currency: hasActual || hasEst ? 'USD' : null,
        })
      );
    }
    return { ready: true, fidelity: 'session-model', rows: out };
  } finally {
    closeQuietly(db);
  }
}

/**
 * OpenCode：session_v2 每场会话一行，带 cost。
 *
 * 新库同时有 session 和 session_v2 两张表。v2 有数据就用 v2，
 * 两张都读会把同一场会话算两遍。
 */
async function readOpencode({ dbPath } = {}) {
  const file = dbPath || (await dbFromScanner('opencode'));
  if (!file) return { ready: false, reason: '没有找到 OpenCode 的库' };
  const db = openReadOnly(file);
  if (!db) return { ready: false, reason: 'OpenCode 的库打不开' };
  try {
    const table = ['session_v2', 'session'].find((t) => columns(db, t).length);
    if (!table) return { ready: false, reason: '这个版本的 OpenCode 没有会话表' };

    const rows = db
      .prepare(
        `select id, model, cost, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, time_created
         from ${table}`
      )
      .all();

    const out = [];
    for (const r of rows) {
      const totalIn = Number(r.tokens_input) || 0;
      const outTok = Number(r.tokens_output) || 0;
      if (totalIn + outTok === 0) continue; // 空会话，记账没有意义
      const m = parseModel(r.model);
      const cost = Number(r.cost);
      out.push(
        makeRow({
          agent: 'opencode',
          fidelity: 'session-total',
          at: r.time_created,
          session: r.id,
          model: m.id,
          provider: m.provider,
          calls: null,
          input: totalIn,
          // 实测 cache_read 远大于 input → input 不含缓存
          semantic: 'fresh',
          output: outTok,
          reasoning: r.tokens_reasoning,
          cacheRead: r.tokens_cache_read,
          cacheWrite: r.tokens_cache_write,
          cost: Number.isFinite(cost) && cost > 0 ? cost : null,
          costStatus: Number.isFinite(cost) && cost > 0 ? 'estimated' : 'unknown',
          currency: Number.isFinite(cost) && cost > 0 ? 'USD' : null,
        })
      );
    }
    return { ready: true, fidelity: 'session-total', rows: out };
  } finally {
    closeQuietly(db);
  }
}

/**
 * Claude Code：JSONL 里每条 assistant 消息带 usage，按 message.id 去重。
 *
 * Anthropic 的 input_tokens 本来就不含缓存（缓存读写是另两个字段），
 * 所以这里是 fresh 语义，不需要换算。
 */
async function readClaudeCode({ files } = {}) {
  let list = files;
  if (!list) {
    try {
      const mod = await import('./scanners/claude-code.js');
      list = await mod.discover();
    } catch {
      list = [];
    }
  }
  if (!list || !list.length) return { ready: false, reason: '没有找到 Claude Code 的会话文件' };

  const out = [];
  // 同一 message.id 可能因流式写入出现多次，取 output 最大的那条代表整次回复。
  //
  // seen 必须跨文件共享，不能每个文件一份：Claude Code 的 --fork-session /
  // /branch 会把整段历史复制到新文件，同一个 message.id 会在原件与副本里
  // 各出现一次。按文件去重会把同一段历史算两遍（MAGPIE 的 ccRest 就是
  // 按「副本有、keeper 没有」统计的）。message.id 是每次模型回复的唯一
  // 标识，按它全局去重既覆盖流式重复，也覆盖分叉/复制。取 output 最大的
  // 那条仍然保留——流式过程中同一 id 的输出会不断增长。
  const seen = new Map();
  for (const file of list) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = o.message;
      if (!msg || !msg.usage) continue;
      const id = msg.id || o.uuid;
      if (!id) continue;
      const u = msg.usage;
      const prev = seen.get(id);
      const outTok = Number(u.output_tokens) || 0;
      if (prev && prev.output >= outTok) continue;
      seen.set(id, {
        at: o.timestamp ? Date.parse(o.timestamp) : null,
        session: o.sessionId || null,
        model: msg.model || null,
        input: u.input_tokens,
        output: outTok,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      });
    }
  }
  // 所有文件读完后再一次性出 rows：seen 是跨文件共享的，不能每读完一个
  // 文件就把累计结果推一遍（那会把前面文件的记录重复 N 次）。
  for (const v of seen.values()) {
    if (v.at == null) continue;
    out.push(
      makeRow({
        agent: 'claude-code',
        fidelity: 'request',
        at: v.at,
        session: v.session,
        model: v.model,
        calls: 1,
        input: v.input,
        semantic: 'fresh',
        output: v.output,
        cacheRead: v.cacheRead,
        cacheWrite: v.cacheWrite,
      })
    );
  }
  return { ready: true, fidelity: 'request', rows: out };
}

/**
 * Codex：只有 threads.tokens_used 一个会话级总量。
 *
 * 没有缓存拆分，也看不出这个数是否含缓存，所以标成 unknown：
 * token 总量可以用，但不参与缓存命中率。
 */
async function readCodex({ dbPath } = {}) {
  let file = dbPath;
  if (!file) {
    try {
      const mod = await import('./scanners/codex.js');
      for (const root of mod.candidateRoots?.() || []) {
        const p = findVersionedDb(root, 'state');
        if (p) {
          file = p;
          break;
        }
      }
    } catch {
      /* 没装 Codex */
    }
  }
  if (!file) return { ready: false, reason: '没有找到 Codex 的线程索引' };

  const db = openReadOnly(file);
  if (!db) return { ready: false, reason: 'Codex 的库打不开' };
  try {
    if (!columns(db, 'threads').length) {
      return { ready: false, reason: '这个版本的 Codex 没有 threads 表' };
    }
    const rows = db
      .prepare(`select id, cwd, updated_at, tokens_used from threads where tokens_used > 0`)
      .all();
    const out = [];
    for (const r of rows) {
      const at = toMs(r.updated_at);
      if (at == null) continue;
      out.push(
        makeRow({
          agent: 'codex',
          fidelity: 'session-total',
          at,
          session: r.id,
          calls: null,
          input: r.tokens_used,
          semantic: 'unknown',
          cost: null,
          costStatus: 'unknown',
        })
      );
    }
    return { ready: true, fidelity: 'session-total', rows: out };
  } finally {
    closeQuietly(db);
  }
}

/* ------------------------------ DSH ------------------------------ */

/**
 * DSH（DeepSeek Harness）的会话日志：每个 `assistant/message` 事件就是一次
 * 模型请求，`data.usage` 直接写在事件里，所以这一源是**请求级**的。
 *
 * ## 口径是算出来的，不是猜的
 *
 * 实测 8400+ 条真实 usage：`totalTokens === inputTokens + outputTokens +
 * cacheReadTokens + cacheWriteTokens` 全部成立，说明 `inputTokens` 是
 * **不含缓存**的输入（和 OpenCode / Hermes 同一种语义）。
 *
 * 但上游可能变。所以每条记录都拿 totalTokens 反推一次口径：
 *   total == input+output+cacheRead+cacheWrite  → fresh（input 不含缓存）
 *   total == input+output                        → total（input 含缓存，要减）
 *   其他不一致                                     → unknown（不进命中率）
 *   没有 total（实测 63 条，只多了 reasoningTokens）→ fresh
 * 这样 DSH 哪天换了记账方式，这里不会静默算错——只会变成 unknown，被排除出
 * 缓存命中率（与各家同一套处理）。
 *
 * ## 成本
 *
 * DSH 不报钱，所以 `cost` 一律 null：没有价就是没有价，不写 0。
 *
 * ## 性能
 *
 * 多帧 zstd 只能逐帧解，实测 106 个会话约 3 秒。按 `size:mtimeMs:ctimeMs`
 * 落盘缓存，只重读变化的文件；缓存写失败只影响下次启动速度，不影响正确性。
 */
const DSH_CACHE_VERSION = 1;

function dshCacheFile() {
  return statePath('cache', `dsh-usage-v${DSH_CACHE_VERSION}.json`);
}

function loadDshCache() {
  try {
    const o = JSON.parse(fs.readFileSync(dshCacheFile(), 'utf8'));
    if (o && o.version === DSH_CACHE_VERSION && o.entries && typeof o.entries === 'object') return o.entries;
  } catch {
    /* 没有或坏了，重读 */
  }
  return {};
}

function saveDshCache(entries) {
  const file = dshCacheFile();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: DSH_CACHE_VERSION, entries }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 缓存写不进去只影响下次启动速度，不影响正确性 */
  }
}

const dshNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 从 totalTokens 反推这一条的 input 口径。
 * @returns {'fresh'|'total'|'unknown'}
 */
function dshSemantic(u, input, output, cacheRead, cacheWrite) {
  const total = Number(u.totalTokens);
  if (u.totalTokens == null || !Number.isFinite(total)) return 'fresh';
  if (total === input + output + cacheRead + cacheWrite) return 'fresh';
  if (total === input + output) return 'total';
  return 'unknown';
}

/** 解析一个 DSH 会话文件；返回 { id, rows }，rows 用紧凑数组，便于落盘。 */
function readDshFile(mod, file) {
  let buf;
  try {
    buf = mod.decompressFrames(fs.readFileSync(file));
  } catch {
    return null;
  }
  let id = null;
  let headerDone = false;
  const rows = [];
  for (const text of buf.toString('utf8').split('\n')) {
    if (!text.trim()) continue;
    if (!headerDone) {
      headerDone = true;
      try {
        const h = JSON.parse(text);
        if (h && h.type === 'session' && typeof h.id === 'string') id = h.id;
      } catch {
        /* header 坏了就退回目录名 */
      }
      continue;
    }
    // 廉价预筛：绝大多数行是 tool/result 等运行时事件，解析它们只是浪费。
    if (!text.includes('"assistant/message"')) continue;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      continue;
    }
    if (!o || o.type !== 'assistant/message') continue;
    const d = o.data || {};
    const u = d.usage;
    if (!u || typeof u !== 'object') continue;
    const at = typeof o.time === 'number' ? o.time : null;
    if (at == null) continue;
    const input = dshNum(u.inputTokens);
    const output = dshNum(u.outputTokens);
    const cacheRead = dshNum(u.cacheReadTokens);
    const cacheWrite = dshNum(u.cacheWriteTokens);
    const reasoning = dshNum(u.reasoningTokens);
    const model = (d.message && d.message.source && d.message.source.model) || null;
    rows.push([
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      at,
      model,
      dshSemantic(u, input, output, cacheRead, cacheWrite),
    ]);
  }
  return { id: id || path.basename(path.dirname(file)), rows };
}

/** DSH：读所有会话文件里的 assistant/message.usage。 */
async function readDsh({ files: filesOverride } = {}) {
  let mod;
  try {
    mod = await import('./scanners/dsh.js');
  } catch {
    return { ready: false, reason: 'DSH 扫描器不可用' };
  }

  let files = Array.isArray(filesOverride) && filesOverride.length ? filesOverride : null;
  if (!files) {
    try {
      files = mod.discover();
    } catch {
      files = [];
    }
  }
  if (!files.length) return { ready: false, reason: '没有找到 DSH 的会话目录' };

  const cached = loadDshCache();
  const next = {};
  const rows = [];
  const fileSet = new Set(files);
  let changed = false;

  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      // 暂时 stat 不到（被占用 / 正在删）：保留旧缓存，别把它当成"内容变了"。
      if (cached[file]) next[file] = cached[file];
      continue;
    }
    const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = cached[file];
    let entry = hit && hit.stamp === stamp && Array.isArray(hit.rows) ? hit : null;
    if (!entry) {
      entry = readDshFile(mod, file);
      changed = true;
      if (entry) entry.stamp = stamp;
    }
    if (!entry) continue;
    next[file] = entry;
    for (const r of entry.rows) {
      rows.push(
        makeRow({
          agent: 'dsh',
          source: 'dsh',
          fidelity: 'request',
          at: r[5],
          session: entry.id,
          model: r[6],
          calls: 1,
          input: r[0],
          output: r[1],
          cacheRead: r[2],
          cacheWrite: r[3],
          reasoning: r[4],
          semantic: r[7] || 'fresh',
          cost: null,
          costStatus: 'unknown',
        })
      );
    }
  }

  // 会话文件被删掉时要顺手把缓存条目也删掉，否则缓存会一直长。
  let pruned = false;
  for (const key of Object.keys(cached)) if (!fileSet.has(key)) pruned = true;
  if (changed || pruned) saveDshCache(next);
  if (!rows.length) return { ready: false, reason: '有 DSH 会话但没有找到 token 记录' };
  return { ready: true, fidelity: 'request', rows };
}

/* ------------------------------ WorkBuddy ------------------------------ */

/**
 * WorkBuddy：会话 JSONL 里每次模型请求的 `providerData.rawUsage`。
 *
 * 口径（对照 cc-switch `session_usage_workbuddy.rs`）：
 *   - `prompt_tokens` 是 OpenAI 口径，**已含缓存命中**：
 *     `prompt_cache_hit_tokens + prompt_cache_miss_tokens == prompt_tokens`。
 *     所以按 semantic='total' 入库，由 normalizeFresh 减掉缓存读写。
 *   - `completion_tokens` 已含思考 token；`completion_tokens_details.reasoning_tokens`
 *     只是单列展示，不能再加到 output 上。
 *   - `rawUsage.credit` 是 WorkBuddy 积分，不是钱——**不当作成本**。
 *   - 一次请求的 rawUsage 记在该请求的最后一个事件上：可能是 assistant
 *     message，也可能是 function_call（工具调用常常承载大部分 token）。
 *   - 子代理文件 `<session>/subagents/*.jsonl` 的请求算父会话的。
 *   - 事件 id 在同一份文件里唯一；按它批内去重，文件重写/重复读取不会重复计。
 *
 * 这里不做持久化字节游标：用量层本来就是全量重算的只读汇总，按事件 id
 * 去重足够；引入游标反而要维护 dedup 账本，风险更大。
 */
async function readWorkbuddy({ files } = {}) {
  let list = files;
  if (!list) {
    try {
      const mod = await import('./scanners/workbuddy.js');
      list = mod.discover();
    } catch {
      list = [];
    }
  }
  if (!list || !list.length) return { ready: false, reason: '没有找到 WorkBuddy 的会话文件' };

  const rows = [];
  const seen = new Set();

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const maxNum = (...vals) => Math.max(0, ...vals.map(num));

  for (const file of list) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // 子代理文件：<…>/<sessionId>/subagents/agent-xxx.jsonl
    const parts = String(file).split(/[\\/]/);
    const subIdx = parts.lastIndexOf('subagents');
    const parentSession = subIdx > 0 ? parts[subIdx - 1] : null;
    const isSubagent = subIdx > 0;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const pd = o && o.providerData;
      if (!pd || typeof pd !== 'object') continue;
      const raw = pd.rawUsage && typeof pd.rawUsage === 'object' ? pd.rawUsage : null;
      const sdk = !raw && pd.usage && typeof pd.usage === 'object' ? pd.usage : null;
      if (!raw && !sdk) continue;

      const id = o.id || o.uuid;
      if (!id) continue;
      const session = parentSession || o.sessionId || null;
      const key = `${session || ''}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let reasoning = 0;

      if (raw) {
        input = num(raw.prompt_tokens);
        output = num(raw.completion_tokens);
        cacheRead = maxNum(
          raw.prompt_cache_hit_tokens,
          raw.cache_read_input_tokens,
          raw.cached_tokens,
          raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens
        );
        cacheWrite = maxNum(raw.cache_creation_input_tokens, raw.prompt_cache_write_tokens);
        reasoning = maxNum(
          raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens,
          raw.completion_thinking_tokens
        );
      } else {
        input = num(sdk.inputTokens);
        output = num(sdk.outputTokens);
        const inDetails = Array.isArray(sdk.inputTokensDetails) ? sdk.inputTokensDetails : [];
        cacheRead = maxNum(...inDetails.map((d) => d && d.cached_tokens));
        const outDetails = Array.isArray(sdk.outputTokensDetails) ? sdk.outputTokensDetails : [];
        reasoning = maxNum(...outDetails.map((d) => d && d.reasoning_tokens));
      }

      const model = String(pd.model || pd.requestModelId || '').replace(/^custom-[^:]+:/, '') || null;
      const at = toMs(o.timestamp);
      if (at == null) continue;

      rows.push(
        makeRow({
          agent: 'workbuddy',
          source: 'workbuddy',
          fidelity: 'request',
          at,
          session,
          model,
          calls: 1,
          input,
          semantic: 'total',
          output,
          cacheRead,
          cacheWrite,
          reasoning,
          cost: null,
          costStatus: 'unknown',
        })
      );
    }
  }

  if (!rows.length) return { ready: false, reason: '有 WorkBuddy 会话但没有找到 rawUsage 记录' };
  return { ready: true, fidelity: 'request', rows };
}

/* ------------------------------ 工具 ------------------------------ */

/** 时间可能是毫秒数、秒数或 ISO 字符串，三种都见过。 */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : d;
}

/** OpenCode 把模型存成 JSON 字符串；解析失败就当没有。 */
function parseModel(v) {
  if (!v) return { id: null, provider: null };
  if (typeof v === 'object') return { id: v.id || null, provider: v.providerID || null };
  try {
    const o = JSON.parse(String(v));
    return { id: o.id || null, provider: o.providerID || null };
  } catch {
    return { id: String(v), provider: null };
  }
}

/* ------------------------------ 入口 ------------------------------ */

export const SOURCES = [
  { id: 'zcode', display: 'ZCode', read: readZcode },
  { id: 'hermes', display: 'Hermes', read: readHermes },
  { id: 'opencode', display: 'OpenCode', read: readOpencode },
  { id: 'claude-code', display: 'Claude Code', read: readClaudeCode },
  { id: 'codex', display: 'Codex', read: readCodex },
  { id: 'dsh', display: 'DSH', read: readDsh },
  { id: 'workbuddy', display: 'WorkBuddy', read: readWorkbuddy },
];

/**
 * 读所有可用的用量源。
 *
 * `sources` 可覆盖（测试用），每个源是 `{ id, display, read }`；
 * `paths` 可按源指定库文件，避开真实实测数据。
 */
export async function readUsage({ sources, paths = {} } = {}) {
  const list = Array.isArray(sources) && sources.length ? sources : SOURCES;
  const all = [];
  const reports = [];

  for (const s of list) {
    let r;
    try {
      r = await s.read({ dbPath: paths[s.id], files: paths[`${s.id}:files`] });
    } catch (e) {
      r = { ready: false, reason: e && e.message ? e.message : '读取失败' };
    }
    const rows = Array.isArray(r.rows) ? r.rows : [];
    all.push(...rows);
    reports.push({
      id: s.id,
      display: s.display,
      ready: r.ready === true && rows.length > 0,
      reason: r.ready === true && rows.length === 0 ? '有库但没有记录用量' : r.reason || null,
      rows: rows.length,
      fidelity: r.fidelity || null,
    });
  }

  all.sort((a, b) => a.at - b.at);
  return {
    ready: all.length > 0,
    rows: all,
    reports,
    range: all.length ? { start: all[0].at, end: all[all.length - 1].at } : null,
  };
}

/** 聚合维度：agent / model / project / session / day。 */
export function summarizeUsage({ rows = [], groupBy = 'agent', sessionIndex = [], catalog = null } = {}) {
  const sessionProject = new Map();
  for (const s of sessionIndex) {
    if (s.project) sessionProject.set(`${s.agent}|${s.id}`, s.project);
  }

  const groups = new Map();
  for (const r of rows) {
    const key = groupKey(r, groupBy, sessionProject);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        rows: 0,
        calls: 0,
        callsKnown: 0,
        fresh: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        // 只累计能判断语义的行，命中率才有意义
        hitRead: 0,
        hitBase: 0,
        hitExcluded: 0,
        cost: 0,
        costKnown: 0,
        costUnknown: 0,
        // 自报成本之外的另一本账：按价目表估出来的，分开累计，
        // 混进同一个数就再也分不清哪部分是供应商认过的钱
        costEst: 0,
        costEstRecords: 0,
        costApproxRecords: 0,
        unpricedRecords: 0,
        semantics: new Set(),
        agents: new Set(),
        first: null,
        last: null,
      };
      groups.set(key, g);
    }

    g.rows++;
    g.agents.add(r.agent);
    if (r.calls != null) {
      g.calls += r.calls;
      g.callsKnown++;
    }
    g.fresh += r.fresh;
    g.output += r.output;
    g.cacheRead += r.cacheRead;
    g.cacheWrite += r.cacheWrite;
    g.reasoning += r.reasoning;
    g.semantics.add(r.semantic);

    if (r.semantic === 'unknown') {
      g.hitExcluded++;
    } else {
      g.hitRead += r.cacheRead;
      g.hitBase += r.cacheRead + r.fresh;
    }

    if (r.cost == null) {
      g.costUnknown++;
      // 没有自报成本时按价目表估一个；没有价就记成未定价，不当 0
      const price = catalog ? priceFor(r.model, catalog) : null;
      const est = price ? estimateCost(r, price) : null;
      if (est) {
        g.costEst += est.usd;
        g.costEstRecords++;
        if (est.approximated) g.costApproxRecords++;
      } else {
        g.unpricedRecords++;
      }
    } else {
      g.cost += r.cost;
      g.costKnown++;
    }

    if (!g.first || r.at < g.first) g.first = r.at;
    if (!g.last || r.at > g.last) g.last = r.at;
  }

  const out = [];
  for (const g of groups.values()) {
    out.push({
      key: g.key,
      rows: g.rows,
      calls: g.callsKnown ? g.calls : null,
      fresh: g.fresh,
      output: g.output,
      cacheRead: g.cacheRead,
      cacheWrite: g.cacheWrite,
      reasoning: g.reasoning,
      // 缓存命中率：缓存读 / (缓存读 + 未缓存输入)。缓存写是"为下次付的钱"，
      // 不算命中。语义未知的行不进分子也不进分母。
      cacheHit: g.hitBase > 0 ? g.hitRead / g.hitBase : null,
      cacheHitExcluded: g.hitExcluded,
      cost: g.costKnown ? g.cost : null,
      costKnown: g.costKnown,
      costUnknown: g.costUnknown,
      // 估算成本：只覆盖"没自报、但价目表里有价"的记录
      costEst: g.costEstRecords ? g.costEst : null,
      costEstRecords: g.costEstRecords,
      costApproxRecords: g.costApproxRecords,
      unpricedRecords: g.unpricedRecords,
      agents: [...g.agents],
      semantics: [...g.semantics],
      first: g.first,
      last: g.last,
    });
  }

  out.sort((a, b) => b.fresh + b.output - (a.fresh + a.output));
  return out;
}

function groupKey(r, groupBy, sessionProject) {
  if (groupBy === 'model') return r.model || '(未知模型)';
  if (groupBy === 'session') return `${r.agent}|${r.session || '(无会话)'}`;
  if (groupBy === 'day') return dayKey(r.at) || '(未知日期)';
  if (groupBy === 'project') {
    return (r.session && sessionProject.get(`${r.agent}|${r.session}`)) || '(未绑定项目)';
  }
  return r.agent || '(未知)';
}

/** 一句话说明这一层是什么、边界在哪。 */
export function usageHint() {
  return '这一层读的是各家 Agent 自己记的 token 账本，不需要网关；没有价目表，只有 Agent 自报的成本。';
}
