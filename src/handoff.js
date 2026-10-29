import { scanCached } from './registry.js';
import { projectKey, isProjectPath, isSubagent, belongsTo, normalizeProject, durationMs } from './model.js';

/**
 * 跨 Agent 交接视图。
 *
 * ## 它回答什么问题
 *
 * 时间线回答"发生过什么"，但它按会话列，一个项目几百场就没人看得完。
 * 交接视图回答的是另一个问题：**这个项目被哪些 Agent 轮流接手过，
 * 每次换手之间隔了多久**。
 *
 * 把连续同一 Agent 的会话压成一段"run"，891 场会话就变成 223 段。
 * 换手点才是需要人看一眼的地方：换手间隔越长，上下文丢失的风险越大。
 *
 * ## 为什么必须有这一层
 *
 * 用户真实的用法是换工具：这个项目先用 Codex，界面问题换 Antigravity，
 * 后端又回 Codex。每换一次，新 Agent 都不知道前面发生了什么——它只看得到
 * 自己的会话。档案馆是唯一能看见"整条接力"的地方，所以这件事只能在这里做。
 *
 * ## 一个必须如实处理的细节：会话会重叠
 *
 * 本机实测 my-app 的 222 次换手里有 **76 次间隔为负**——上一段还没结束，
 * 下一段已经开始了。原因很实际：会话的 end 是最后一条消息的时间，一个开了
 * 好几天、偶尔回一句的会话会"横跨"别人的工作。
 *
 * 所以这里不把负间隔当成异常，也不取绝对值假装是正数，而是单列成
 * `overlap`。把并行当成"接续"会让"换手间隔"这个指标彻底失真。
 *
 * ## 边界
 *
 * 只统计主会话。子代理会话是父会话内部的步骤，不是一次"接手"。
 * 只统计能归到真实项目的会话（临时工作区、聊天渠道会话不参与）。
 */

/** 换手间隔超过这个时长就提示"上下文可能已丢失"。 */
const STALE_GAP_MS = 7 * 24 * 3600 * 1000;

/**
 * 把一个项目的会话序列压成 run，并算出每次换手。
 *
 * @param {string} target 项目路径（用户输入的原文，由这里归一化）
 * @param {object} opts
 * @param {number} opts.minGapMinutes 只关心间隔超过这个值的换手（默认 0 = 全部）
 * @returns {object}
 */
export function projectHandoffs(target, { minGapMinutes = 0, noCache = false } = {}) {
  const { sessions } = scanCached({ noCache });
  const key = projectKey(normalizeProject(resolveTarget(target)));

  const inProject = sessions
    .filter((s) => !isSubagent(s) && s.project && isProjectPath(s.project))
    .filter((s) => belongsTo(s.project, key))
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  const runs = buildRuns(inProject);
  const handoffs = buildHandoffs(runs);

  const agents = new Set(runs.map((r) => r.agent));
  const filtered = handoffs.filter(
    (h) => h.kind === 'overlap' || (h.gapMs || 0) >= minGapMinutes * 60000
  );

  return {
    project: normalizeProject(resolveTarget(target)),
    projectKey: key,
    sessions: inProject.length,
    runs: runs.length,
    agentCount: agents.size,
    agents: [...agents].sort(),
    first: inProject.length ? inProject[0].start : null,
    last: inProject.length
      ? inProject.reduce((m, s) => (s.end && (!m || s.end > m) ? s.end : m), null)
      : null,
    handoffs: filtered,
    handoffCount: handoffs.length,
    // 没有换手（单 Agent 或只有一段）也要如实说，不要让人以为算错了
    singleAgent: agents.size <= 1,
    summary: summarize(handoffs),
    runList: runs,
  };
}

function resolveTarget(target) {
  // 这里不做 cwd 解析：调用方（CLI）负责把用户输入变成绝对路径。
  // 本模块只做归一化和匹配，保持与 query.js 的分工一致。
  return target;
}

/**
 * 连续同一 Agent 的会话合成一段。
 *
 * 分段的判据是 agent 相等，不是"时间相邻"——同一个 Agent 隔了一周再回来，
 * 中间没有别人插手，那仍然是一段连续的工作，不该被拆开。
 */
function buildRuns(sessions) {
  const runs = [];
  for (const s of sessions) {
    const last = runs[runs.length - 1];
    if (last && last.agent === s.agent) {
      last.count++;
      last.sessions.push(s);
      if (s.start && (!last.start || s.start < last.start)) last.start = s.start;
      if (s.end && (!last.end || s.end > last.end)) last.end = s.end;
      last.lastSession = s;
    } else {
      runs.push({
        agent: s.agent,
        count: 1,
        sessions: [s],
        start: s.start,
        end: s.end,
        firstSession: s,
        lastSession: s,
      });
    }
  }
  return runs;
}

/**
 * 算相邻 run 之间的换手。
 *
 * 间隔 = 下一段的开始 - 上一段的结束。三种情况分开：
 *
 *   sequential  正常的先后接续（gap >= 0）
 *   overlap     时间重叠（gap < 0）——两边同时在干活，不是"交接"
 *   unknown     有一边没有时间戳，算不出间隔
 *
 * 重叠不合并成一个数：把它算成 0 会让"平均换手间隔"偏小，
 * 取绝对值则完全虚构了一段等待时间。
 */
function buildHandoffs(runs) {
  const out = [];
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1];
    const next = runs[i];

    let gapMs = null;
    let kind = 'unknown';
    if (prev.end && next.start) {
      gapMs = next.start - prev.end;
      kind = gapMs < 0 ? 'overlap' : 'sequential';
    }

    out.push({
      index: i,
      from: prev.agent,
      to: next.agent,
      // 上一段最后一场：下一个 Agent 接手时"之前停在哪儿"
      fromLastSession: brief(prev.lastSession),
      fromSessions: prev.count,
      fromStart: prev.start,
      fromEnd: prev.end,
      // 下一段第一场：接手时"从哪儿开始"
      toFirstSession: brief(next.firstSession),
      toSessions: next.count,
      toStart: next.start,
      toEnd: next.end,
      gapMs,
      gapMinutes: gapMs == null ? null : Math.round(gapMs / 60000),
      kind,
      // 间隔超过一周就标出来：这类换手基本等于重新开始
      stale: gapMs != null && gapMs >= STALE_GAP_MS,
    });
  }
  return out;
}

function brief(s) {
  if (!s) return null;
  return {
    id: s.id,
    agent: s.agent,
    title: s.title,
    start: s.start,
    end: s.end,
    minutes: Math.round(durationMs(s) / 60000),
  };
}

/**
 * 汇总换手特征。
 *
 * 平均间隔只在 sequential 上算：把 overlap 混进来算平均没有意义
 * （它们不是等待时间）。重叠数单独报。
 */
function summarize(handoffs) {
  const seq = handoffs.filter((h) => h.kind === 'sequential');
  const gaps = seq.map((h) => h.gapMs).sort((a, b) => a - b);
  const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : null);

  const pairs = new Map();
  for (const h of handoffs) {
    const k = `${h.from}→${h.to}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }

  return {
    sequential: seq.length,
    overlap: handoffs.filter((h) => h.kind === 'overlap').length,
    unknown: handoffs.filter((h) => h.kind === 'unknown').length,
    stale: handoffs.filter((h) => h.stale).length,
    medianGapMs: q(0.5),
    maxGapMs: gaps.length ? gaps[gaps.length - 1] : null,
    // 哪条接力线最常走，回答"这个项目我的主力组合是什么"
    topPairs: [...pairs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pair, n]) => ({ pair, count: n })),
  };
}

/** 供 CLI / MCP 复用的换手标签。 */
export function handoffLabel(h) {
  if (h.kind === 'overlap') return '并行';
  if (h.kind === 'unknown') return '时间未知';
  if (h.stale) return '长期中断';
  return '接续';
}

/** 终端里默认列多少次换手。 */
export const DISPLAY_LIMIT = 12;

/**
 * 挑出该给人看的那几次换手。
 *
 * 两个决定：
 *
 * 1. **按间隔从大到小排。** 间隔越大，接手的 Agent 越不知道前面发生了什么——
 *    那正是这个命令存在的理由。按时间顺序排，最重要的信息会埋在中间。
 *    间隔未知（`gapMinutes == null`）排最后：它既说不出"隔了很久"，
 *    也不该占掉前几名的位置。
 *
 * 2. **默认只给前 12 条。** 真实项目上动辄两三百次换手（本机一个项目 233 次），
 *    全打出来第一屏看不见概况，用户会以为命令卡住了。
 *
 * `rest` 是被截掉的条数，CLI 用它提示怎么查看更多。
 */
export function pickHandoffs(handoffs, { all = false, limit = DISPLAY_LIMIT } = {}) {
  const ordered = [...handoffs].sort((a, b) => {
    const av = a.gapMinutes == null ? Number.NEGATIVE_INFINITY : a.gapMinutes;
    const bv = b.gapMinutes == null ? Number.NEGATIVE_INFINITY : b.gapMinutes;
    return bv - av;
  });
  const shown = all ? ordered : ordered.slice(0, limit);
  return { shown, total: ordered.length, rest: ordered.length - shown.length };
}
