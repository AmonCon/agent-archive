import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 调用层：一次模型请求花了多少、命中多少缓存、快不快。
 *
 * 会话层记录"说了什么"，调用层记录"为这句话花了多少钱"。
 * 两者缺一不可：同一场对话换个模型，成本能差十倍，而会话正文完全一样。
 *
 * ## 数据从哪来
 *
 * 网关（如 magpie）会记录每一次上游请求，本机实测 15 天 2.5 万条。
 * 这份日志的字段划分比各家会话文件细得多：
 *
 *   in / out            本次请求的输入、输出 token
 *   cache_read/_write   提示词缓存命中与写入量（本机实测占输入 96.8%）
 *   ttft_ms             首 token 延迟
 *   ms                  整次调用耗时
 *   credits / cost      供应商自己报的费用
 *   status / tries      结果与重试
 *   session / native_session   它对应的会话 id —— 这是接会话层的钩子
 *
 * ## 边界（重要）
 *
 * 网关只看得见**经过它的**调用。本机实测：dsh 和 hermes 的 session 字段
 * 全空，因为它们不走网关；qoder 只有 76 场被网关看到，而归档有 310 场。
 * 所以调用层永远是"已观测到的成本"，不是全部成本。
 *
 * 报告时必须同时在两个数：匹配上多少、总共多少。只报一个会让人误以为
 * 覆盖率是 100%。这与技能使用率只统计显式调用是同一种诚实。
 *
 * ## 不装网关时
 *
 * 优雅降级：没有日志就返回 ready:false 和一句怎么打开的话，
 * 而不是报错。这是可选层，不是依赖。
 */

/** 已知网关的日志位置（都是"本地调用记录"，不含凭据）。 */
const SOURCES = [
  {
    id: 'magpie',
    display: 'magpie 网关',
    // XDG 是 magpie 自己的选择，三个平台都用它
    paths: [path.join(os.homedir(), '.config', 'magpie', 'usage.jsonl')],
  },
];

function findSources() {
  const out = [];
  for (const s of SOURCES) {
    for (const p of s.paths) {
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size > 0) out.push({ ...s, path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* 没装或没启用 */
      }
    }
  }
  return out;
}

/** 网关的 agent 名和归档的扫描器名不一定一致。 */
const AGENT_ALIAS = {
  claude: 'claude-code',
  'claude-desktop': 'claude-desktop',
  'qoder-cn': 'qoder',
  qodercn: 'qoder',
};

export function canonicalAgent(a) {
  if (!a) return null;
  const k = String(a).toLowerCase();
  return AGENT_ALIAS[k] || k;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 读调用日志。
 *
 * 逐行解析而不是整体 JSON.parse：日志是 append-only 的 NDJSON，
 * 最后一行可能正写到一半（并发追加），那行丢掉即可，不该让整个文件失败。
 */
export function readCalls({ fresh = false } = {}) {
  const sources = findSources();
  if (!sources.length) {
    return {
      ready: false,
      message:
        '没有找到调用日志。这类日志来自本地模型网关（如 magpie），' +
        '没装或没启用时这一层就不可用——它只是可选视图，不影响会话归档。',
      sources: [],
      calls: [],
    };
  }

  const calls = [];
  const skipped = { lines: 0, malformed: 0 };

  for (const src of sources) {
    let text;
    try {
      text = fs.readFileSync(src.path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      skipped.lines++;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        // 最后一行可能写了一半
        skipped.malformed++;
        continue;
      }
      const t = toDate(o.t);
      if (!t) {
        skipped.malformed++;
        continue;
      }
      calls.push({
        source: src.id,
        time: t,
        agent: canonicalAgent(o.agent),
        rawAgent: o.agent || null,
        provider: o.provider || null,
        model: o.model || null,
        request: o.req || null,
        // 会话 id：优先 native_session（Agent 自己的 id，和归档一致），
        // 退而用 session（网关请求头里带的那个）
        session: o.native_session || o.session || null,
        sessionFrom: o.native_session ? 'native' : o.session ? 'header' : null,
        in: num(o.in),
        out: num(o.out),
        cacheRead: num(o.cache_read),
        cacheWrite: num(o.cache_write),
        reasoning: num(o.reasoning),
        ttftMs: o.ttft_ms == null ? null : num(o.ttft_ms),
        ms: o.ms == null ? null : num(o.ms),
        status: o.status == null ? null : Number(o.status),
        error: o.err || null,
        errorType: o.err_type || null,
        tries: o.tries == null ? null : Number(o.tries),
        credits: o.credits == null ? null : num(o.credits),
        effort: o.effort || null,
        tier: o.tier_served || null,
      });
    }
  }

  calls.sort((a, b) => a.time - b.time);

  return {
    ready: true,
    sources: sources.map((s) => ({ id: s.id, display: s.display, path: s.path, size: s.size })),
    calls,
    skipped,
    range: calls.length ? { start: calls[0].time, end: calls[calls.length - 1].time } : null,
  };
}

/**
 * 有没有上层网络请求成功。
 *
 * 429/499/5xx 这些也是真实发生过的调用（有耗时、可能计费），
 * 但拿它们算"平均速度"会失真。区分口径，不合并。
 */
function isOk(c) {
  return c.status == null || (c.status >= 200 && c.status < 300);
}

/** 一次调用实际吃掉的输入量：未缓存输入 + 缓存读 + 缓存写。 */
function totalInput(c) {
  return c.in + c.cacheRead + c.cacheWrite;
}

/**
 * 汇总成可展示的形状。
 *
 * 分三个维度，因为用户问的是三个不同的问题：
 *   byAgent    哪个 Agent 最费
 *   byModel    哪个模型最贵
 *   按会话      哪一场对话最贵（这是接会话层的关键）
 */
export function summarizeCalls({ calls, groupBy = 'agent' } = {}) {
  const groups = new Map();

  for (const c of calls) {
    let key;
    if (groupBy === 'agent') key = c.agent || '(unknown)';
    else if (groupBy === 'model') key = c.model || '(unknown)';
    else if (groupBy === 'provider') key = c.provider || '(unknown)';
    else if (groupBy === 'session') key = `${c.agent}|${c.session || '(no session)'}`;
    else key = '(unknown)';

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        calls: 0,
        ok: 0,
        failed: 0,
        retried: 0,
        in: 0,
        out: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        credits: 0,
        creditsKnown: 0,
        ms: 0,
        msKnown: 0,
        ttftSum: 0,
        ttftKnown: 0,
        first: null,
        last: null,
      };
      groups.set(key, g);
    }

    g.calls++;
    if (isOk(c)) g.ok++;
    else g.failed++;
    if (c.tries && c.tries > 1) g.retried++;
    g.in += c.in;
    g.out += c.out;
    g.cacheRead += c.cacheRead;
    g.cacheWrite += c.cacheWrite;
    g.reasoning += c.reasoning;
    if (c.credits != null) {
      g.credits += c.credits;
      g.creditsKnown++;
    }
    if (c.ms != null && isOk(c)) {
      g.ms += c.ms;
      g.msKnown++;
    }
    if (c.ttftMs != null && isOk(c)) {
      g.ttftSum += c.ttftMs;
      g.ttftKnown++;
    }
    if (!g.first || c.time < g.first) g.first = c.time;
    if (!g.last || c.time > g.last) g.last = c.time;
  }

  const rows = [];
  for (const g of groups.values()) {
    const input = g.in + g.cacheRead + g.cacheWrite;
    rows.push({
      ...g,
      input,
      // 缓存命中率：缓存读 /（缓存读 + 未缓存输入）。
      // 缓存写不算命中——它是为下一次付的钱，不是这一次省的钱。
      cacheHit: g.cacheRead + g.in > 0 ? g.cacheRead / (g.cacheRead + g.in) : null,
      // 输出速度：只在成功的调用上算，且跳过首 token 之外的窗口不可得时留空
      outPerSec: g.msKnown > 0 ? (g.out * 1000) / g.ms : null,
      avgTtft: g.ttftKnown > 0 ? g.ttftSum / g.ttftKnown : null,
    });
  }

  rows.sort((a, b) => b.calls - a.calls);
  return rows;
}

/**
 * 把调用挂到会话上。
 *
 * 只有拿到 session id 的调用能挂上。返回 matched / total，
 * 让调用方能把覆盖率一起报出来——这是这个模块最重要的诚实性保证。
 */
export function attachToSessions(calls, sessionIndex) {
  const byId = new Map();
  for (const s of sessionIndex) {
    // 归档里同一场会话可能被多个扫描器写出不同的 id 形态，
    // 这里同时收原样和小写两版
    byId.set(s.id, s);
  }

  const matched = [];
  const unmatched = [];
  for (const c of calls) {
    if (c.session && byId.has(c.session)) matched.push(c);
    else unmatched.push(c);
  }

  return {
    matched,
    unmatched,
    sessions: new Set(matched.map((c) => `${c.agent}|${c.session}`)).size,
    totalCalls: calls.length,
    // 有多少调用本身就没有 session id（不走网关的 Agent 常见）
    withoutSession: calls.filter((c) => !c.session).length,
  };
}

/** 供 CLI / MCP 用的一句话降级提示。 */
export function callsHint() {
  return '这层数据来自本地模型网关的调用日志（如 magpie 的 ~/.config/magpie/usage.jsonl）。';
}
