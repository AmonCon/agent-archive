#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, projectTimeline, groupByAgent, findSessions, readSessionContent } from './query.js';
import { search, indexStats } from './search.js';
import { timelineMarkdown } from './export.js';
import { latestProjectDigest, latestSessionSummary } from './digest.js';
import { deriveStats } from './derive.js';
import { durationMs, tildify } from './model.js';

/**
 * MCP server（stdio 传输）。
 *
 * 存在的意义：让用户已有的 Agent 自己来读这份档案。
 * 不引入任何 npm 依赖——MCP 的 stdio 传输就是"stdin/stdout 上一行一个
 * JSON-RPC 消息"，手写足够，而且和这个项目零依赖的原则一致。
 *
 * ⚠ 最重要的设计约束：**默认返回有界内容**。
 * 一场会话的正文常有十几万字（约 5 万 token），一个 Agent 手滑点错
 * 就能烧掉大量额度。所以：
 *   - 列表类工具默认只给摘要字段，不给正文
 *   - 读正文必须显式给 id，并且有 maxChars 上限
 *   - 超出上限时截断并明确告诉调用方"还有多少没给"
 *
 * 所有工具都是只读的。这个 server 不会修改任何 Agent 的原始数据。
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/* ------------------------------ 工具定义 ------------------------------ */

const TOOLS = [
  {
    name: 'list_projects',
    title: '列出项目',
    description:
      '列出本机所有有会话记录的项目，含会话数、涉及哪些 Agent、时间范围。' +
      '这是入口工具：先看有哪些项目，再用 project_timeline 深入。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { projects, totalSessions, unbound } = listProjects({});
      return {
        totalSessions,
        projects: projects.map((p) => ({
          project: tildify(p.display),
          sessions: p.count,
          agents: p.agents,
          first: iso(p.start),
          last: iso(p.end),
        })),
        // 不绑定项目的会话（Hermes 这类聊天渠道助手）单列，
        // 否则调用方会以为这批对话不存在
        withoutProject: unbound
          ? { sessions: unbound.count, agents: unbound.agents.map((a) => a.agent) }
          : null,
      };
    },
  },
  {
    name: 'project_timeline',
    title: '项目时间线',
    description:
      '某个项目下的会话清单，按时间排序。只返回元数据（标题、Agent、时间、时长），' +
      '不含正文。要读正文用 read_session。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目路径，如 E:/my-app 或 .' },
        limit: {
          type: 'number',
          description: '最多返回多少场会话（默认 50，上限 500）',
        },
        agent: { type: 'string', description: '只看某个 Agent 的会话' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: async ({ project, limit = 50, agent }) => {
      const r = projectTimeline(project, {});
      let list = r.sessions;
      if (agent) list = list.filter((s) => s.agent === agent);

      const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const shown = list.slice(-cap);

      // 子代理会话挂在主会话下面。它们是"这场对话内部发生的事"，
      // 不该和主会话并列成一个独立条目，否则时间线会翻倍。
      const childIndex = new Map(r.children.map((c) => [c.parent, c]));

      return {
        project: tildify(r.target),
        total: list.length,
        returned: shown.length,
        truncated: list.length > shown.length,
        summary: {
          agents: r.summary.agents,
          first: iso(r.summary.first),
          last: iso(r.summary.last),
          totalHours: +(r.summary.totalMs / 3600000).toFixed(1),
          // 子会话单列：它们被采集但不占时间线的一行
          subagentSessions: r.summary.subagentCount,
        },
        byAgent: groupByAgent(list).map(([a, ss]) => ({ agent: a, sessions: ss.length })),
        sessions: shown.map((s) => {
          const kids = childIndex.get(s.id);
          return {
            agent: s.agent,
            id: s.id,
            title: s.title,
            start: iso(s.start),
            end: iso(s.end),
            minutes: Math.round(durationMs(s) / 60000),
            resume: s.resume || undefined,
            // 这场会话派生了几个子代理；要知道细节用 read_session 读子会话 id
            subagents: kids ? kids.count : undefined,
            subagentIds: kids ? kids.ids : undefined,
          };
        }),
      };
    },
  },
  {
    name: 'search_sessions',
    title: '全文搜索',
    description:
      '在所有会话正文里搜索关键词，返回命中的会话和命中位置附近的摘录。' +
      '中文、英文、中英混排都可。搜的是人说的话和工具调用摘要，不含完整工具输出。' +
      '需要先建过索引（agent-archive index）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '最多返回多少条（默认 10，上限 50）' },
        agent: { type: 'string', description: '限定某个 Agent' },
        project: { type: 'string', description: '限定某个项目（路径片段即可）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async ({ query, limit = 10, agent, project }) => {
      const r = search(query, {
        limit: Math.min(Math.max(Number(limit) || 10, 1), 50),
        agent,
        project,
      });
      if (!r.ready) {
        return { error: r.message, hint: '在终端运行 `node src/cli.js index` 建立索引后再试。' };
      }
      return {
        query,
        hits: r.hits.map((h) => ({
          agent: h.agent,
          id: h.id,
          title: h.title,
          project: h.project ? tildify(h.project) : null,
          start: iso(h.start),
          snippet: h.snippet,
        })),
      };
    },
  },
  {
    name: 'read_session',
    title: '读会话正文',
    description:
      '读一场会话的正文。**必须先用 project_timeline 或 search_sessions 拿到 id**。' +
      '返回内容默认截断到 maxChars 字符——一场会话常有十几万字，' +
      '一次拉全文会消耗大量上下文。需要更多时用 offset 分段读。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 id（可用前缀）' },
        agent: { type: 'string', description: 'Agent 名，配合 id 精确定位' },
        maxChars: {
          type: 'number',
          description: '最多返回多少字符（默认 8000，上限 40000）',
        },
        offset: { type: 'number', description: '从第几个字符开始（默认 0）' },
        includeTools: {
          type: 'boolean',
          description: '是否包含工具调用与输出（默认 false，只给人说的话）',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id, agent, maxChars = 8000, offset = 0, includeTools = false }) => {
      const { matches, total } = findSessions({ query: id, agent });
      if (!matches.length) return { error: `没有匹配 ${id} 的会话` };
      if (matches.length > 1) {
        return {
          error: `${total} 场会话匹配 ${id}，请用更长的 id 前缀`,
          candidates: matches.slice(0, 5).map((s) => ({
            agent: s.agent,
            id: s.id,
            title: s.title,
          })),
        };
      }

      const session = matches[0];
      const messages = await readSessionContent(session);
      const full = renderMessages(messages, includeTools);

      const cap = Math.min(Math.max(Number(maxChars) || 8000, 500), 40000);
      const from = Math.max(0, Number(offset) || 0);
      const slice = full.slice(from, from + cap);

      return {
        agent: session.agent,
        id: session.id,
        title: session.title,
        // 子代理会话必须标出来：读到的细节是子代理查的，不是主对话说的
        kind: session.kind || 'main',
        parent: session.parent || undefined,
        project: session.project ? tildify(session.project) : null,
        start: iso(session.start),
        end: iso(session.end),
        messageCount: messages.length,
        totalChars: full.length,
        offset: from,
        returnedChars: slice.length,
        hasMore: from + slice.length < full.length,
        nextOffset: from + slice.length < full.length ? from + slice.length : undefined,
        text: slice,
      };
    },
  },
  {
    name: 'read_digest',
    title: '读项目摘要',
    description:
      '读某个项目**已生成**的交接摘要（模型写的，不是原始会话）。' +
      '如果还没生成过，会返回提示而不是现编一个——生成要花钱，由用户在终端显式执行。' +
      '建议流程：先看 read_digest 有没有现成的，没有再用 project_timeline + read_session 自己翻。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目路径，如 E:/my-app' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: async ({ project }) => {
      const d = latestProjectDigest(project);
      if (!d) {
        return {
          exists: false,
          hint:
            '这个项目还没有生成摘要。让用户在终端运行：' +
            `agent-archive digest "${project}" --run` +
            '（先不带 --run 可以只看预估成本）。',
        };
      }
      return {
        exists: true,
        project: tildify(project),
        generatedAt: iso(d.createdAt),
        model: d.model,
        promptVersion: d.promptVersion,
        // 摘要本身是给人读的 Markdown，原样返回
        digest: d.text,
        note: '这是模型生成的视图，不是原始事实。需要核对细节时用 read_session 回原文。',
      };
    },
  },
  {
    name: 'read_session_summary',
    title: '读会话摘要',
    description:
      '读某场会话**已生成**的摘要（比原文短得多）。用于快速判断"这场值得深挖吗"。' +
      '没生成过就返回提示。要拿全文用 read_session。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 id（可用前缀）' },
        agent: { type: 'string', description: 'Agent 名，配合 id 精确定位' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id, agent }) => {
      const { matches, total } = findSessions({ query: id, agent });
      if (!matches.length) return { error: `没有匹配 ${id} 的会话` };
      if (matches.length > 1) {
        return {
          error: `${total} 场会话匹配 ${id}，请用更长的 id 前缀`,
          candidates: matches.slice(0, 5).map((s) => ({ agent: s.agent, id: s.id, title: s.title })),
        };
      }

      const s = matches[0];
      const d = latestSessionSummary(s);
      if (!d) {
        return {
          exists: false,
          session: { agent: s.agent, id: s.id, title: s.title },
          hint: '这场会话还没有摘要。可以直接 read_session 读原文（会分段返回）。',
        };
      }

      return {
        exists: true,
        session: { agent: s.agent, id: s.id, title: s.title },
        generatedAt: iso(d.createdAt),
        model: d.model,
        promptVersion: d.promptVersion,
        summary: d.text,
      };
    },
  },
  {
    name: 'session_stats',
    title: '采集统计',
    description:
      '报告采集质量：多少会话、各 Agent 分布、索引规模、已生成的摘要数量。' +
      '用它判断数据是否可信，或排查"为什么搜不到"。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { projects, totalSessions, stats, unbound } = listProjects({});
      const idx = indexStats();
      const der = deriveStats();
      const summaryCount = der.groups
        .filter((g) => g.kind === 'session_summary')
        .reduce((n, g) => n + g.count, 0);
      const digestCount = der.groups
        .filter((g) => g.kind === 'project_digest')
        .reduce((n, g) => n + g.count, 0);

      return {
        sessions: totalSessions,
        files: stats.files,
        projects: projects.length,
        byAgent: stats.byAgent,
        withoutProject: unbound ? unbound.count : 0,
        index: idx.exists
          ? {
              documents: idx.docs,
              charsMillions: +(idx.chars / 1e6).toFixed(1),
              megabytes: +(idx.bytes / 1e6).toFixed(0),
              builtAt: iso(idx.builtAt),
            }
          : { exists: false, hint: '运行 agent-archive index 建立索引' },
        // 视图层的进度：有多少会话/项目已经有摘要了
        derived: {
          sessionSummaries: summaryCount,
          projectDigests: digestCount,
          models: [...new Set(der.groups.map((g) => g.model))],
        },
      };
    },
  },
  {
    name: 'export_timeline',
    title: '导出时间线 Markdown',
    description:
      '把一个项目的时间线导出成 Markdown 文本。适合贴进文档或交给别的模型。' +
      '只含元数据，不含正文。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目路径，如 E:/my-app' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: async ({ project }) => {
      const md = timelineMarkdown(project, {});
      // 大项目的时间线也可能很长，统一截断
      const cap = 40000;
      return {
        project,
        chars: md.length,
        truncated: md.length > cap,
        markdown: md.slice(0, cap),
      };
    },
  },
  {
    name: 'inventory',
    title: '本机 Agent 能力面',
    description:
      '这台机器上各 Agent 具备什么能力：配了哪些 MCP 服务、装了哪些技能、有哪些记忆与指令文件。' +
      '用于"我刚装了一个新 Agent，想看看别的 Agent 里已有什么"这种场景。' +
      '会按启动指纹把同一个 MCP 服务在多家的注册归并成一条，按内容哈希把同一份技能归并成一条。' +
      '只读，不回传凭证值（只给环境变量的键名），也不合并不同 Agent 的记忆内容。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['overview', 'mcp', 'skills', 'usage', 'memory', 'audit'],
          description:
            'overview=每个 Agent 一行的总览（默认）；mcp=MCP 服务清单，含跨 Agent 归并；' +
            'skills=技能清单；usage=技能使用率（哪些真被调用过）；memory=记忆与指令文件；audit=体检与建议',
        },
        agent: {
          type: 'string',
          description: '只看某个 Agent（如 codex、claude-code、qoder、hermes）',
        },
        limit: {
          type: 'number',
          description: '列表最多返回多少条（默认 50，上限 200）',
        },
      },
      additionalProperties: false,
    },
    handler: async ({ type = 'overview', agent, limit = 50 }) => {
      const { fullInventory, auditEnvironment } = await import('./env/inventory.js');
      const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);

      if (type === 'audit') {
        return auditEnvironment();
      }

      const inv = fullInventory();

      if (type === 'mcp') {
        const list = agent ? inv.mcp.list.filter((s) => s.agents.includes(agent)) : inv.mcp.list;
        return {
          services: list.length,
          registrations: inv.mcp.registrations,
          note: '同一服务在多家的注册已按启动指纹归并。环境变量只给键名，值不读取。',
          mixedForms: inv.mcp.mixedForms,
          list: list.slice(0, cap),
          truncated: list.length > cap,
        };
      }

      if (type === 'skills') {
        const list = agent
          ? inv.skills.list.filter((s) => s.agents.includes(agent))
          : inv.skills.list;
        return {
          skills: inv.skills.skills,
          installs: inv.skills.installs,
          shared: inv.skills.shared,
          note: '按 SKILL.md 内容哈希归并，同一份技能装在几处算一条。',
          byAgent: inv.skills.byAgent,
          list: list.slice(0, cap).map((s) => ({
            name: s.name,
            agents: s.agents,
            installs: s.installs,
            description: s.description,
            aliases: s.aliases,
          })),
          truncated: list.length > cap,
        };
      }

      if (type === 'usage') {
        const { skillUsageSummary } = await import('./env/usage.js');
        return skillUsageSummary({});
      }

      if (type === 'memory') {
        // 记忆一律只给元数据：条数、格式、大小、主题。
        // 正文不在这一层返回——它可能含凭证，也可能被误当成"权威结论"。
        return {
          ...inv.memory,
          list: inv.memory.list.filter((m) => !agent || m.agent === agent).slice(0, cap),
          note: '只给出处与规模，不含正文。不同 Agent 的记忆可能互相矛盾，不做合并。',
        };
      }

      const agents = agent
        ? inv.agents.filter((a) => a.agent === agent)
        : inv.agents;
      return {
        ...inv.summary,
        agents,
        mcpServices: inv.mcp.list.map((s) => ({ service: s.service, agents: s.agents })),
        note:
          '这是环境层的总览：谁装了什么能力。' +
          '会话层（聊过什么）用 list_projects / search_sessions。',
      };
    },
  },
  {
    name: 'model_calls',
    title: '模型调用成本',
    description:
      '每场会话为模型付了多少：调用次数、输入/输出 token、缓存命中率、费用。' +
      '数据来自本地模型网关的调用日志（如 magpie 的 usage.jsonl），不是从会话正文推算的。' +
      '用途：判断一场对话换模型能省多少、哪一步最贵、缓存有没有生效。' +
      '注意：只有经过网关的调用才被记录，所以这是"已观测到的成本"，不是全部成本；' +
      '返回里同时给 matchedSessions 和 totalCalls，别把覆盖率当成 100%。' +
      '没装网关时返回 available:false 和原因，不报错。',
    inputSchema: {
      type: 'object',
      properties: {
        groupBy: {
          type: 'string',
          enum: ['agent', 'model', 'provider', 'session'],
          description: '汇总维度（默认 agent）。要按会话看用 session。',
        },
        agent: {
          type: 'string',
          description: '只看某个 Agent（如 qoder、zcode、dsh）',
        },
        session: {
          type: 'string',
          description: '只看某场会话（会话 id 前缀即可）',
        },
        limit: {
          type: 'number',
          description: '最多返回多少组（默认 20，上限 100）',
        },
      },
      additionalProperties: false,
    },
    handler: async ({ groupBy = 'agent', agent, session, limit = 20 }) => {
      const { readCalls, summarizeCalls, attachToSessions } = await import('./calls.js');
      const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);

      const r = readCalls();
      if (!r.ready) {
        return {
          available: false,
          reason: r.message,
          note: '调用层是可选的。会话层的工具不受影响。',
        };
      }

      let calls = r.calls;
      if (agent) calls = calls.filter((c) => c.agent === agent);
      if (session) calls = calls.filter((c) => c.session && c.session.startsWith(session));

      const rows = summarizeCalls({ calls, groupBy });

      // 只有按会话看时才去扫归档算匹配率：按 Agent 汇总不需要，
      // 而扫一次全量要几秒
      let link = null;
      if (groupBy === 'session' || session) {
        const { scanCached } = await import('./registry.js');
        const { sessions } = scanCached({});
        const l = attachToSessions(calls, sessions);
        link = {
          matchedSessions: l.sessions,
          matchedCalls: l.matched.length,
          totalCalls: l.totalCalls,
          withoutSession: l.withoutSession,
        };
      }

      return {
        available: true,
        sources: r.sources.map((s) => s.display),
        range: r.range,
        calls: calls.length,
        groupBy,
        rows: rows.slice(0, cap).map((g) => ({
          key: g.key,
          calls: g.calls,
          failed: g.failed,
          inputTokens: g.input,
          uncachedInput: g.in,
          cacheRead: g.cacheRead,
          cacheWrite: g.cacheWrite,
          outputTokens: g.out,
          cacheHit: g.cacheHit == null ? null : Number(g.cacheHit.toFixed(3)),
          credits: g.creditsKnown ? Number(g.credits.toFixed(2)) : null,
          avgTtftMs: g.avgTtft == null ? null : Math.round(g.avgTtft),
          outPerSec: g.outPerSec == null ? null : Math.round(g.outPerSec),
        })),
        truncated: rows.length > cap,
        link,
        note:
          'inputTokens 含缓存读写；cacheHit 只看缓存读，不含缓存写。' +
          '费用 credits 由网关按供应商口径记录，缺价时不估。',
      };
    },
  },
];

/* ------------------------------ 渲染 ------------------------------ */

/**
 * 把消息拼成可读文本。
 *
 * 默认不含工具调用——工具输出常有几十万字，而模型真正需要的是
 * "人在说什么"。需要时用 includeTools 打开，但仍然只给摘要。
 */
function renderMessages(messages, includeTools) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts = [];
    for (const p of m.parts) {
      if (p.kind === 'text') parts.push(p.text);
      else if (p.kind === 'tool' && includeTools) {
        const detail = inputSummary(p.input);
        parts.push(`[${p.name}${detail ? ' ' + detail : ''}]`);
      }
    }
    if (!parts.length) continue;
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
    const when = m.ts ? ` ${hhmm(m.ts)}` : '';
    out.push(`## ${who}${when}\n${parts.join('\n')}`);
  }
  return out.join('\n\n');
}

function inputSummary(input) {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input, 80);
  if (typeof input === 'object') {
    if (Array.isArray(input.command)) return clip(input.command.join(' '), 90);
    for (const k of ['command', 'description', 'file_path', 'path', 'query', 'pattern', 'prompt']) {
      if (typeof input[k] === 'string' && input[k]) return clip(input[k], 90);
    }
    return clip(JSON.stringify(input), 60);
  }
  return String(input);
}

/* ------------------------------ 协议 ------------------------------ */

/**
 * stdio 传输：stdin 一行一条 JSON-RPC 消息，stdout 一行一条响应。
 *
 * 硬性要求：stdout 上不能出现任何非 MCP 消息。所以所有日志都走
 * stderr，包括未捕获异常。
 */
function serve() {
  process.stderr.write('agent-archive MCP server 已启动（stdio）\n');

  let buffer = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      handleLine(line).catch((e) => {
        // 处理失败也不能让进程挂掉：回一条错误响应，继续服务
        process.stderr.write(`处理消息出错: ${e && e.stack ? e.stack : e}\n`);
      });
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
  }

  // 通知（没有 id）不需要响应
  const isNotification = msg.id === undefined || msg.id === null;

  try {
    const result = await dispatch(msg);

    if (isNotification) return; // initialized / cancelled 之类，静默处理

    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    if (isNotification) return;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: e && e.code ? e.code : -32603,
        message: e && e.message ? e.message : String(e),
      },
    });
  }
}

async function dispatch(msg) {
  const method = msg.method;
  const params = msg.params || {};

  switch (method) {
    case 'initialize': {
      // 客户端给的版本能支持就用它的，否则用我们最高的
      const asked = params.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-archive', version: '0.1.0' },
        instructions:
          '这是本机跨 Agent 的档案馆，只读。它有两层：' +
          '**会话层**——list_projects 看有哪些项目 → read_digest 看有没有现成的交接摘要 → ' +
          '没有的话用 search_sessions 或 project_timeline 定位 → read_session 读正文（会截断，按需分段）。' +
          '**环境层**——inventory 看这台机器上各 Agent 配了哪些 MCP 服务、装了哪些技能、有哪些记忆。' +
          '刚接触这个环境、或想知道别的 Agent 已具备什么能力时先调 inventory；' +
          '**调用层**——model_calls 看每场会话/每个 Agent 为模型付了多少（token、缓存命中、费用），' +
          '数据来自本地网关日志，只覆盖经过网关的调用。' +
          '要看某个项目发生过什么再用会话层。' +
          '三层都只提供事实与出处，不替你合并结论，也不回传任何凭证值。',
      };
    }

    case 'ping':
      return {};

    case 'tools/list':
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      };

    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        const e = new Error(`未知工具: ${name}`);
        e.code = -32602;
        throw e;
      }

      let data;
      try {
        data = await tool.handler(args);
      } catch (e) {
        // 工具执行错误用 isError，而不是协议错误——
        // 这样模型能看到原因并自己决定怎么改
        return {
          content: [{ type: 'text', text: `执行失败: ${e && e.message ? e.message : e}` }],
          isError: true,
        };
      }

      const text = JSON.stringify(data, null, 2);
      return {
        content: [{ type: 'text', text }],
        structuredContent: data,
        isError: Boolean(data && data.error),
      };
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {};

    default: {
      const e = new Error(`不支持的方法: ${method}`);
      e.code = -32601;
      throw e;
    }
  }
}

function send(obj) {
  // 一行一条，绝不能有内嵌换行
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/* ------------------------------ 小工具 ------------------------------ */

function iso(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

const pad = (n) => String(n).padStart(2, '0');
function hhmm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 直接运行就起服务；被 import 则导出 TOOLS 供测试用
const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) serve();

export { TOOLS, dispatch };
