import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openReadOnly, findVersionedDb } from './sqlite-read.js';
import { priceFor, estimateCost } from './pricing.js';
import { dayKey } from './model.js';

/**
 * 用量层：各家 Agent 自己记下的 token 消耗。
 *
 * 和 `calls.js` 的分工：`calls` 读的是**网关**日志，只看得见经过网关的请求；
 * 这里读的是 Agent 自己的账本，不需要装网关，但各家记的粒度、口径都不同。
 *
 * ## 为什么不能把几个数直接相加
 *
 * 同一列 `input_tokens`，四家的含义不一样（本机实测，不是猜的）：
 *
 *   ZCode      input 含缓存。`provider_total_tokens = input + output`，
 *              而 cache_read 是 input 的子集 → 缓存读会被算成全价输入。
 *   OpenCode   input 不含缓存。实测某场 cache_read 6600 万、input 310 万，
 *              缓存读不可能大于总输入 → 只能是分开记的。
 *   Hermes     input 不含缓存。同样实测 cache_read(2.2 亿) > input(7500 万)。
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
            // 本机没有 cache_creation > 0 的行，所以缓存写是否也在 input 里
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
  for (const file of list) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // 同一 message.id 可能因流式写入出现多次，取 output 最大的那条代表整次回复
    const seen = new Map();
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
];

/**
 * 读所有可用的用量源。
 *
 * `sources` 可覆盖（测试用），每个源是 `{ id, display, read }`；
 * `paths` 可按源指定库文件，避开真实本机数据。
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
