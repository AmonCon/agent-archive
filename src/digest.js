import path from 'node:path';
import { projectTimeline, findSessions, readSessionContent } from './query.js';
import { chat, loadConfig, estimateTokens, estimateCost } from './llm.js';
import { getArtifact, putArtifact, hashText, latestArtifact } from './derive.js';
import { tildify, durationMs, projectKey } from './model.js';

/**
 * 摘要流水线。
 *
 * 分层是这里唯一可行的方法：一场会话十几万字，一个项目几百场会话，
 * 一次性塞进模型既超上下文也烧钱。所以：
 *
 *   会话正文 ─┬─ 超长就切块 → 每块摘要 → 合并
 *             └─ 不超长就直接摘要
 *                    ↓
 *              会话摘要（缓存）
 *                    ↓
 *              项目摘要（缓存）
 *
 * 每一层的产物都进衍生缓存，键含内容哈希 + 提示词版本 + 模型。
 * 所以重复跑只花没算过的那部分钱。
 */

/** 提示词版本。改了提示词就把它 +1，旧缓存自动失效。 */
const SESSION_PROMPT_VERSION = 'v1';
const PROJECT_PROMPT_VERSION = 'v1';

/** 一次请求最多塞多少字符。留够余量给输出和系统提示。 */
const CHUNK_CHARS = 24000;

/** 项目摘要最多吃多少场会话的摘要；超了就取最近的。 */
const DEFAULT_SESSION_LIMIT = 60;

const SESSION_SYSTEM =
  '你在整理程序员的 AI 编程助手会话记录。只依据材料说话，' +
  '不补充材料里没有的内容。材料不足的项目直接写"无"。';

const PROJECT_SYSTEM =
  '你在为一个软件项目写交接材料。只依据材料说话。' +
  '材料里没有依据的推断必须标注"待确认"，不要编造。';

/**
 * 把一场会话摊平成纯文本。
 *
 * 不含完整工具输出——那些是日志和源码，占篇幅但对"这场对话在干什么"
 * 贡献很小。工具调用只留一行摘要，用来保留"动过哪些文件"这条线索。
 */
function sessionToText(session, messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts = [];
    for (const p of m.parts) {
      if (p.kind === 'text') parts.push(p.text);
      else if (p.kind === 'tool') {
        const d = summarizeInput(p.input);
        parts.push(`[${p.name}${d ? ' ' + d : ''}]`);
      }
    }
    if (!parts.length) continue;
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
    out.push(`${who}：${parts.join('\n')}`);
  }
  return out.join('\n\n');
}

function summarizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input, 60);
  if (typeof input === 'object') {
    if (Array.isArray(input.command)) return clip(input.command.join(' '), 70);
    for (const k of ['command', 'description', 'file_path', 'path', 'query', 'pattern', 'prompt']) {
      if (typeof input[k] === 'string' && input[k]) return clip(input[k], 70);
    }
    return '';
  }
  return '';
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 按段落边界切块，尽量不把一句话切开。 */
function chunk(text, size) {
  if (text.length <= size) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      // 往回找一个换行，切得自然一点
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + size * 0.6) end = nl;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/* ------------------------------ 会话摘要 ------------------------------ */

function sessionPrompt(title, project, text) {
  return `下面是一场 AI 编程助手会话的记录（已剥离完整工具输出）。会话标题：${title}${
    project ? `，所属项目：${tildify(project)}` : ''
  }。

请提炼：

1. **要解决的问题**：一句话。
2. **实际做了什么**：要点，最多 5 条。
3. **做出的决定及理由**：有就列，没有写"无"。
4. **遗留问题**：没做完或没结论的，有就列，没有写"无"。

只写材料里有依据的内容。总长控制在 350 字以内。

---
${text}`;
}

const COMBINE_SESSION_PROMPT = `下面是同一场会话被切成的若干片段的摘要。请把它们合并成一份连贯摘要，去掉重复，保留：
1. 要解决的问题
2. 实际做了什么
3. 做出的决定及理由
4. 遗留问题

控制在 350 字以内。只依据给出的片段摘要，不要补充。

---
`;

/**
 * 摘要一场会话。
 *
 * @returns {{text, cached, tokensIn, tokensOut, chunks}}
 */
export async function summarizeSession(session, { force = false } = {}) {
  const messages = await readSessionContent(session);
  const text = sessionToText(session, messages);
  const sourceHash = hashText(text);
  const cfg = loadConfig();
  const subject = `${session.agent}|${session.id}`;

  if (!force) {
    const hit = getArtifact({
      kind: 'session_summary',
      subject,
      sourceHash,
      promptVersion: SESSION_PROMPT_VERSION,
      model: cfg.model,
    });
    if (hit) {
      return { text: hit.body, cached: true, tokensIn: 0, tokensOut: 0, chunks: 0 };
    }
  }

  const parts = chunk(text, CHUNK_CHARS);
  let tokensIn = 0;
  let tokensOut = 0;
  let body;

  if (parts.length === 1) {
    const r = await chat({
      messages: [
        { role: 'system', content: SESSION_SYSTEM },
        { role: 'user', content: sessionPrompt(session.title, session.project, parts[0]) },
      ],
    });
    body = r.text;
    tokensIn += r.usage.input;
    tokensOut += r.usage.output;
  } else {
    // map：每块单独摘要
    const partials = [];
    for (let i = 0; i < parts.length; i++) {
      const r = await chat({
        messages: [
          { role: 'system', content: SESSION_SYSTEM },
          {
            role: 'user',
            content: `这是一场长会话的第 ${i + 1}/${parts.length} 片段。请只针对本片段提炼要点（问题、做了什么、决定、遗留），200 字以内。\n\n---\n${parts[i]}`,
          },
        ],
      });
      partials.push(`片段 ${i + 1}：\n${r.text}`);
      tokensIn += r.usage.input;
      tokensOut += r.usage.output;
    }
    // reduce
    const r = await chat({
      messages: [
        { role: 'system', content: SESSION_SYSTEM },
        { role: 'user', content: COMBINE_SESSION_PROMPT + partials.join('\n\n') },
      ],
    });
    body = r.text;
    tokensIn += r.usage.input;
    tokensOut += r.usage.output;
  }

  putArtifact({
    kind: 'session_summary',
    subject,
    sourceHash,
    promptVersion: SESSION_PROMPT_VERSION,
    model: cfg.model,
    body,
    tokensIn,
    tokensOut,
  });

  return { text: body, cached: false, tokensIn, tokensOut, chunks: parts.length };
}

/* ------------------------------ 项目摘要 ------------------------------ */

function projectPrompt(name, items, meta) {
  const lines = items.map(
    (x, i) => `${i + 1}. [${x.agent} ${x.start ? x.start.toISOString().slice(0, 10) : ''}] ${x.title}\n${indent(x.summary, '   ')}`
  );
  return `项目：${name}
共 ${meta.total} 场会话（按时间取最近 ${items.length} 场），涉及 ${meta.agents.join(' / ')}，
时间跨度 ${meta.first} → ${meta.last}。

下面是这些会话的摘要。请写一份交接材料：

1. **项目在做什么**：一句话。
2. **演进主线**：按时间排列，最多 6 条，每条一句话。
3. **反复出现的决策或约定**：有就列。
4. **明确的未完成事项**：有就列。
5. **值得注意的坑**：有就列。

只依据给出的摘要。没把握的标"待确认"。控制在 900 字以内。

---
${lines.join('\n\n')}`;
}

const COMBINE_PROJECT_PROMPT = `下面是同一个项目的分批摘要。请合并成一份连贯的交接材料，
去重，保留：项目在做什么、演进主线、决策与约定、未完成事项、坑。
控制在 900 字以内。只依据给出的材料。

---
`;

export async function digestProject(project, { limit = DEFAULT_SESSION_LIMIT, force = false } = {}) {
  const r = projectTimeline(project, {});
  const cfg = loadConfig();

  if (!r.sessions.length) {
    return { ready: false, message: '这个项目下没有会话' };
  }

  const all = r.sessions;
  const picked = all.slice(-Math.min(Math.max(limit, 1), 300));
  const subject = `project:${r.targetKey}`;

  // 先算内容哈希：它是"这些会话的摘要集合"的指纹
  const items = [];
  let cacheMiss = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const failures = [];

  for (const s of picked) {
    try {
      const one = await summarizeSession(s, { force });
      if (!one.cached) cacheMiss++;
      tokensIn += one.tokensIn;
      tokensOut += one.tokensOut;
      items.push({
        agent: s.agent,
        title: s.title,
        start: s.start,
        summary: one.text,
      });
    } catch (e) {
      failures.push({ id: s.id, error: e && e.message ? e.message : String(e) });
    }
  }

  if (!items.length) {
    // 全部失败时，把第一个真实原因带出来。
    // 否则上层只能看到"都失败了"，而真正的问题可能是密钥没配。
    const first = failures[0];
    return {
      ready: false,
      message: first ? `所有会话摘要都失败了：${first.error}` : '所有会话摘要都失败了',
      failures,
      tokensIn,
      tokensOut,
    };
  }

  const joined = items.map((x) => `${x.title}\n${x.summary}`).join('\n\n');
  const sourceHash = hashText(joined);

  if (!force) {
    const hit = getArtifact({
      kind: 'project_digest',
      subject,
      sourceHash,
      promptVersion: PROJECT_PROMPT_VERSION,
      model: cfg.model,
    });
    if (hit) {
      return {
        ready: true,
        text: hit.body,
        cached: true,
        sessions: items.length,
        totalSessions: all.length,
        cacheMiss,
        tokensIn,
        tokensOut,
        failures,
      };
    }
  }

  const meta = {
    total: all.length,
    agents: r.summary.agents,
    first: fmtDay(r.summary.first),
    last: fmtDay(r.summary.last),
  };

  let body;
  const chunks = chunk(joined, CHUNK_CHARS);
  if (chunks.length === 1) {
    const res = await chat({
      messages: [
        { role: 'system', content: PROJECT_SYSTEM },
        { role: 'user', content: projectPrompt(tildify(r.target), items, meta) },
      ],
    });
    body = res.text;
    tokensIn += res.usage.input;
    tokensOut += res.usage.output;
  } else {
    // 会话摘要多到装不下：分批合并，再汇总
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      const res = await chat({
        messages: [
          { role: 'system', content: PROJECT_SYSTEM },
          {
            role: 'user',
            content: `这是项目材料第 ${i + 1}/${chunks.length} 批。请提炼这批里的：主线、决策、未完成事项、坑。400 字以内。\n\n---\n${chunks[i]}`,
          },
        ],
      });
      partials.push(`第 ${i + 1} 批：\n${res.text}`);
      tokensIn += res.usage.input;
      tokensOut += res.usage.output;
    }
    const res = await chat({
      messages: [
        { role: 'system', content: PROJECT_SYSTEM },
        { role: 'user', content: COMBINE_PROJECT_PROMPT + partials.join('\n\n') },
      ],
    });
    body = res.text;
    tokensIn += res.usage.input;
    tokensOut += res.usage.output;
  }

  putArtifact({
    kind: 'project_digest',
    subject,
    sourceHash,
    promptVersion: PROJECT_PROMPT_VERSION,
    model: cfg.model,
    body,
    tokensIn,
    tokensOut,
  });

  return {
    ready: true,
    text: body,
    cached: false,
    sessions: items.length,
    totalSessions: all.length,
    cacheMiss,
    tokensIn,
    tokensOut,
    failures,
  };
}

/**
 * 估一份项目摘要要花多少钱，一次 API 都不调。
 *
 * 这是必须有的：用户要在花钱之前知道大概多少。读取会话正文是本地操作，
 * 不花钱，所以可以精确算出输入字符数。
 */
export async function estimateProject(project, { limit = DEFAULT_SESSION_LIMIT } = {}) {
  const r = projectTimeline(project, {});
  if (!r.sessions.length) return { ready: false, message: '这个项目下没有会话' };

  const picked = r.sessions.slice(-Math.min(Math.max(limit, 1), 300));
  let totalChars = 0;
  let sessionCount = 0;
  let cachedCount = 0;
  const cfg = loadConfig();

  for (const s of picked) {
    try {
      const messages = await readSessionContent(s);
      const text = sessionToText(s, messages);
      totalChars += text.length;
      sessionCount++;

      const hit = getArtifact({
        kind: 'session_summary',
        subject: `${s.agent}|${s.id}`,
        sourceHash: hashText(text),
        promptVersion: SESSION_PROMPT_VERSION,
        model: cfg.model,
      });
      if (hit) cachedCount++;
    } catch {
      /* 读不出就跳过，估值略低一点无妨 */
    }
  }

  // 每场会话的输出大致 350 字；项目层再吃一遍这些摘要
  const summaryChars = sessionCount * 350;
  const estIn = estimateTokens(totalChars) + estimateTokens(summaryChars);
  const estOut = estimateTokens(sessionCount * 350) + estimateTokens(900);

  return {
    ready: true,
    target: tildify(r.target),
    totalSessions: r.sessions.length,
    sessions: sessionCount,
    cachedSessions: cachedCount,
    inputChars: totalChars,
    estTokensIn: estIn,
    estTokensOut: estOut,
    estCost: estimateCost({ input: estIn, output: estOut }),
    model: cfg.model,
    promptVersions: { session: SESSION_PROMPT_VERSION, project: PROJECT_PROMPT_VERSION },
  };
}

/* ------------------------------ 读取已有摘要 ------------------------------ */

/**
 * 项目摘要的缓存键前缀。
 *
 * 与 digestProject 内部保持一致：先把用户给的路径归一成绝对路径，
 * 再取规范化的项目键。这样 CLI 生成的摘要，网页和 MCP 能按同样的键找到。
 */
export function projectSubject(project) {
  return `project:${projectKey(path.resolve(process.cwd(), project))}`;
}

/**
 * 取某个项目最新的一份摘要（不生成、不花钱）。
 *
 * 展示场景用：网页和 Agent 想知道"这个项目有没有现成的交接材料"。
 * 不在这里校验新鲜度——那要先读一遍全部会话算出哈希，代价太大。
 * 改为把生成时间和模型一起返回，让调用方自己判断够不够新。
 */
export function latestProjectDigest(project) {
  const subject = projectSubject(project);
  const art = latestArtifact({ kind: 'project_digest', subject });
  if (!art) return null;
  return {
    subject,
    text: art.body,
    model: art.model,
    promptVersion: art.promptVersion,
    createdAt: art.createdAt,
    tokensIn: art.tokensIn,
    tokensOut: art.tokensOut,
  };
}

/** 取某场会话已有的摘要。没有就返回 null。 */
export function latestSessionSummary(session) {
  const subject = `${session.agent}|${session.id}`;
  const art = latestArtifact({ kind: 'session_summary', subject });
  if (!art) return null;
  return {
    subject,
    text: art.body,
    model: art.model,
    promptVersion: art.promptVersion,
    createdAt: art.createdAt,
  };
}

/* ------------------------------ 工具 ------------------------------ */

function indent(s, pad) {
  return String(s)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtDay(d) {
  if (!d) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export { SESSION_PROMPT_VERSION, PROJECT_PROMPT_VERSION, sessionToText };
