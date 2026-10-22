#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, projectTimeline, groupByAgent, findSessions, readSessionContent } from './query.js';
import { search, indexStats } from './search.js';
import { timelineMarkdown } from './export.js';
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
        },
        byAgent: groupByAgent(list).map(([a, ss]) => ({ agent: a, sessions: ss.length })),
        sessions: shown.map((s) => ({
          agent: s.agent,
          id: s.id,
          title: s.title,
          start: iso(s.start),
          end: iso(s.end),
          minutes: Math.round(durationMs(s) / 60000),
          resume: s.resume || undefined,
        })),
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
    name: 'session_stats',
    title: '采集统计',
    description:
      '报告采集质量：多少会话、各 Agent 分布、覆盖率的三个支柱（时间/项目/标题）、索引规模。' +
      '用它判断数据是否可信，或排查"为什么搜不到"。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { projects, totalSessions, stats, unbound } = listProjects({});
      const idx = indexStats();
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
          '这是本机跨 Agent 的会话档案馆，只读。' +
          '先用 list_projects 看有哪些项目，再用 project_timeline 或 search_sessions 定位，' +
          '最后用 read_session 读正文（内容会截断，按需分段）。',
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
