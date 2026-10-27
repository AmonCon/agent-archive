import fs from 'node:fs';
import path from 'node:path';
import { scanCached, scanners } from './registry.js';
import {
  projectKey,
  normalizeProject,
  belongsTo,
  durationMs,
  isProjectPath,
  sameProject,
} from './model.js';

/**
 * 查询层。
 *
 * 档案馆只有两种问题值得回答：
 *   1. 这个项目里发生过什么？（按项目归集，时间线）
 *   2. 全机器上我都在哪些项目干过活？（项目清单）
 *
 * 不做搜索、不做向量检索——那些是档案馆跑起来之后才该考虑的事。
 *
 * 项目路径的解释权在这一层，不在 CLI：调用方给的是用户敲的文本（可能是 .、
 * 相对路径或绝对路径），归一成绝对路径是"项目身份"的一部分，不是展示逻辑。
 */

/** 把用户给的路径文本归一成绝对路径。不访问文件系统。 */
function absProject(p) {
  if (!p) return null;
  return path.resolve(process.cwd(), p);
}

export function listProjects({ noCache = false, showAll = false } = {}) {
  const { sessions, stats } = scanCached({ noCache });

  const byKey = new Map();
  // 不绑定项目的会话（Hermes 这类接聊天渠道的助手）单独归一堆。
  // 它们进不了任何项目的时间线，但也不该从档案馆里消失。
  const unbound = [];

  for (const s of sessions) {
    if (!s.project) {
      unbound.push(s);
      continue;
    }
    if (!showAll && !isProjectPath(s.project)) continue;
    const key = projectKey(s.project);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        display: normalizeProject(s.project),
        agents: new Set(),
        sessions: [],
        start: null,
        end: null,
      };
      byKey.set(key, entry);
    }
    entry.agents.add(s.agent);
    entry.sessions.push(s);
    if (s.start && (!entry.start || s.start < entry.start)) entry.start = s.start;
    if (s.end && (!entry.end || s.end > entry.end)) entry.end = s.end;
  }

  const projects = mergeSameProjects([...byKey.values()])
    .map((e) => ({
      ...e,
      agents: [...e.agents].sort(),
      count: e.sessions.length,
    }))
    .sort((a, b) => (b.end || 0) - (a.end || 0));

  return {
    projects,
    stats,
    totalSessions: sessions.length,
    unbound: summarizeUnbound(unbound),
  };
}

/**
 * 合并指向同一个项目的条目。
 *
 * 同一个项目在不同 Agent 里的记录粒度不同：Codex 给的是 "e:/my-app"，
 * Qoder 只给 "my-app"。不合并就会在列表里并排出现两行，
 * 看着像两个项目。合并时优先保留带完整路径的那个作为显示名。
 */
function mergeSameProjects(entries) {
  const out = [];
  for (const e of entries) {
    const hit = out.find((x) => sameProject(x.display, e.display));
    if (!hit) {
      out.push({ ...e, agents: new Set(e.agents) });
      continue;
    }
    // 显示名取更完整的那个（带盘符/斜杠的）
    if (e.display.includes('/') && !hit.display.includes('/')) hit.display = e.display;
    for (const a of e.agents) hit.agents.add(a);
    hit.sessions.push(...e.sessions);
    if (e.start && (!hit.start || e.start < hit.start)) hit.start = e.start;
    if (e.end && (!hit.end || e.end > hit.end)) hit.end = e.end;
  }
  return out;
}

/** 把"没有项目归属"的会话按 Agent 汇总，供列表末尾单独展示。 */
function summarizeUnbound(sessions) {
  if (!sessions.length) return null;
  const byAgent = new Map();
  for (const s of sessions) {
    const e = byAgent.get(s.agent) || { agent: s.agent, count: 0, start: null, end: null };
    e.count++;
    if (s.start && (!e.start || s.start < e.start)) e.start = s.start;
    if (s.end && (!e.end || s.end > e.end)) e.end = s.end;
    byAgent.set(s.agent, e);
  }
  return {
    count: sessions.length,
    agents: [...byAgent.values()].sort((a, b) => b.count - a.count),
  };
}

/**
 * 给定项目路径，返回该项目的会话时间线。
 * 子目录的项目（monorepo 里的子包）也算进来，由 belongTo 判断。
 */
export function projectTimeline(target, { noCache = false, includeNested = true } = {}) {
  const { sessions, stats } = scanCached({ noCache });
  const abs = absProject(target);
  const targetKey = projectKey(abs);

  const matched = sessions.filter((s) => {
    if (!s.project) return false;
    return includeNested ? belongsTo(s.project, targetKey) : projectKey(s.project) === targetKey;
  });

  matched.sort((a, b) => (a.start || 0) - (b.start || 0));

  const agents = new Set();
  const days = new Map();
  let first = null;
  let last = null;

  for (const s of matched) {
    agents.add(s.agent);
    if (s.start && (!first || s.start < first)) first = s.start;
    if (s.end && (!last || s.end > last)) last = s.end;
    if (s.start) {
      const day = s.start.toISOString().slice(0, 10);
      days.set(day, (days.get(day) || 0) + 1);
    }
  }

  return {
    target: normalizeProject(abs),
    targetKey,
    sessions: matched,
    summary: {
      count: matched.length,
      agents: [...agents].sort(),
      first,
      last,
      totalMs: matched.reduce((n, s) => n + durationMs(s), 0),
      days: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    },
    stats,
    // 未归到任何项目的会话，用于诊断路径识别是否漏了
    orphanCount: sessions.filter((s) => !s.project).length,
  };
}

/** 项目内按 Agent 分组，看"这个项目我在哪些工具里干过"。 */
export function groupByAgent(sessions) {
  const m = new Map();
  for (const s of sessions) {
    if (!m.has(s.agent)) m.set(s.agent, []);
    m.get(s.agent).push(s);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

/**
 * 读原始会话内容的入口，交给各 scanner 自己做。
 *
 * 不清洗路径：越界校验在 scanner 内部（messages.assertUnder）完成，
 * 因为只有它知道自己的根目录在哪。
 */
export async function readSessionContent(session) {
  const scanner = scanners.find((s) => s.name === session.agent);
  if (!scanner) throw new Error(`未知的 Agent: ${session.agent}`);
  if (!session.source) throw new Error('这个会话没有可读的源文件');
  if (typeof scanner.readMessages !== 'function') {
    throw new Error(`${session.agent} 的正文读取还没实现`);
  }
  return scanner.readMessages(session);
}

/**
 * 找一场会话来读。
 *
 * 参数是给终端用的短标识，不要求用户背完整 ID：
 *   - 完整 id 或 id 的前缀（大小写不敏感）
 *   - 也可以只给项目路径，此时返回该项目最近的一场
 *
 * 命中多场时返回候选列表而不是猜一个——静默挑错比报错更烦人。
 */
export function findSessions({ query, agent, project, limit = 10 } = {}) {
  const { sessions } = scanCached({});
  let pool = sessions;

  if (agent) pool = pool.filter((s) => s.agent === agent);
  if (project) {
    const key = projectKey(absProject(project));
    pool = pool.filter((s) => s.project && belongsTo(s.project, key));
  }
  if (query) {
    const q = String(query).toLowerCase();
    pool = pool.filter((s) => s.id.toLowerCase().startsWith(q) || s.id.toLowerCase() === q);
  }

  const sorted = pool
    .slice()
    .sort((a, b) => (b.end || b.start || 0) - (a.end || a.start || 0));

  return { matches: sorted.slice(0, limit), total: sorted.length };
}

export { fs, path };
