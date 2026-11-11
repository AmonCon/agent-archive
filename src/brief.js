/**
 * 交接单（brief）：把「上一位 Agent 在这一段里干了什么」压成一页事实。
 *
 * 为什么单独一层，而不是塞进 handoff.js：
 *   - handoff 回答「谁换谁、隔了多久」，是纯时间统计；
 *   - brief 回答「上一段具体干了什么」，要读会话正文、抽文件与任务；
 *   - 两者一个是元数据，一个要读正文，混在一起会让 handoff 变慢。
 *
 * 为什么必须确定性、零模型：
 *   网页、MCP、CLI、/api 都用同一份数据。如果这层调模型，
 *   每次打开页面都要花钱，而且同一份记录每次说法可能不一样。
 *   这里只做「摘录 + 计数 + 排序」，不下结论、不猜完成状态。
 */

import { projectHandoffs } from './handoff.js';
import { readSessionContent } from './query.js';

/** 默认读最近几场会话的正文（越多越慢；交接单只需要最后一小段）。 */
export const DEFAULT_READ_SESSIONS = 6;
/** 最近会话列表默认给多少条。 */
export const DEFAULT_RECENT_SESSIONS = 10;
/** 文件清单最多列多少个（按项目内优先、次数降序）。 */
export const DEFAULT_FILE_LIMIT = 30;

const EDIT_TOOLS =
  /^(write|edit|multiedit|notebookedit|apply_patch|create_file|edit_file|str_replace_editor)$/i;
const TODO_TOOLS = /^(todowrite|todo_write|todo)$/i;
const TASK_CREATE = /^TaskCreate$/i;

/**
 * 纯事实提取：不读磁盘，只处理已经拿到的消息。
 *
 * 单拆出来是为了测试能直接喂合成消息，不用造一整套 Agent 存储。
 *
 * @param {object} h projectHandoffs() 的返回值
 * @param {Map<string, Array>} messagesById 会话 id → 统一消息数组
 * @param {{recentSessions?: number, fileLimit?: number}} opts
 */
export function collectBriefFacts(h, messagesById, opts = {}) {
  const recentLimit = opts.recentSessions || DEFAULT_RECENT_SESSIONS;
  const fileLimit = opts.fileLimit || DEFAULT_FILE_LIMIT;

  const runs = h.runList || [];
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  if (!lastRun) return { lastRun: null, previous: null, files: [], tasks: [], recentSessions: [] };

  const finalSession =
    [...lastRun.sessions].reverse().find((s) => (messagesById.get(s.id) || []).length) ||
    lastRun.lastSession ||
    lastRun.sessions[lastRun.sessions.length - 1];

  const finalMessages = messagesById.get(finalSession.id) || [];
  const files = new Map();
  const tasks = [];

  const projectRoot = String(h.project || '')
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/\/+$/, '');

  for (const session of lastRun.sessions) {
    const messages = messagesById.get(session.id) || [];
    for (const m of messages) {
      for (const p of m.parts || []) {
        if (p.kind !== 'tool') continue;
        const name = p.name || '';
        const input = p.input || {};
        if (EDIT_TOOLS.test(name)) collectFile(p, input, files);
        if (TODO_TOOLS.test(name)) collectTodos(input, tasks);
        if (TASK_CREATE.test(name)) collectTaskCreate(input, tasks);
      }
    }
  }

  const ranked = [...files.entries()]
    .map(([path, count]) => ({
      path,
      count,
      inProject: projectRoot
        ? path.replace(/\\/g, '/').toLowerCase().startsWith(projectRoot + '/')
        : false,
    }))
    .sort((a, b) => Number(b.inProject) - Number(a.inProject) || b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, fileLimit);

  const lastHandoff =
    h.handoffs && h.handoffs.length ? h.handoffs[h.handoffs.length - 1] : null;
  const previousRun = runs.length > 1 ? runs[runs.length - 2] : null;

  return {
    lastRun: {
      agent: lastRun.agent,
      count: lastRun.count,
      start: lastRun.start ? lastRun.start.toISOString() : null,
      end: lastRun.end ? lastRun.end.toISOString() : null,
      lastSession: {
        id: finalSession.id,
        agent: finalSession.agent,
        title: finalSession.title,
        start: finalSession.start ? finalSession.start.toISOString() : null,
        end: finalSession.end ? finalSession.end.toISOString() : null,
      },
      lastUserText: lastText(finalMessages, 'user', 1500),
      lastAssistantText: lastText(finalMessages, 'assistant', 2000),
    },
    previous: previousRun
      ? {
          from: previousRun.agent,
          to: lastRun.agent,
          count: previousRun.count,
          kind: lastHandoff ? lastHandoff.kind : 'unknown',
          gapMinutes: lastHandoff ? lastHandoff.gapMinutes : null,
          stale: lastHandoff ? !!lastHandoff.stale : false,
          fromTitle: lastHandoff && lastHandoff.fromLastSession ? lastHandoff.fromLastSession.title : null,
          toTitle: lastHandoff && lastHandoff.toFirstSession ? lastHandoff.toFirstSession.title : null,
        }
      : null,
    files: ranked,
    tasks: dedupeTasks(tasks).slice(-20),
    recentSessions: lastRun.sessions
      .slice(-recentLimit)
      .reverse()
      .map((s) => ({
        id: s.id,
        agent: s.agent,
        title: s.title,
        start: s.start ? s.start.toISOString() : null,
        end: s.end ? s.end.toISOString() : null,
      })),
  };
}

/**
 * 项目交接单。这是网页、MCP、CLI、/api 共用的唯一入口。
 *
 * @param {string} target 项目路径
 * @param {object} opts
 * @param {object} opts.handoffs 已经算好的 projectHandoffs() 结果（网页层已有，省一次扫描）
 * @param {number} opts.readSessions 读最近几场正文（默认 6，0 表示不读正文）
 * @param {number} opts.recentSessions 最近会话列表条数（默认 10）
 * @param {boolean} opts.noCache 忽略扫描缓存
 */
export async function projectBrief(target, opts = {}) {
  const h = opts.handoffs || projectHandoffs(target, { noCache: opts.noCache });
  if (!h.sessions) {
    return {
      project: h.project,
      generatedAt: new Date().toISOString(),
      sessions: 0,
      lastRun: null,
      previous: null,
      files: [],
      tasks: [],
      recentSessions: [],
      readErrors: [],
    };
  }

  const lastRun = h.runList[h.runList.length - 1];
  const rawRead = opts.readSessions;
  const readLimit = rawRead == null ? DEFAULT_READ_SESSIONS : Math.max(0, Number(rawRead) || 0);
  const readSessions = readLimit ? lastRun.sessions.slice(-readLimit) : [];
  const messagesById = new Map();
  const readErrors = [];

  for (const session of readSessions) {
    try {
      const messages = await readSessionContent(session);
      messagesById.set(session.id, messages || []);
    } catch (e) {
      // 一场读不了不该让整张交接单消失；如实记录，让调用方知道缺了什么。
      readErrors.push({ id: session.id, agent: session.agent, error: String(e.message || e) });
    }
  }

  const facts = collectBriefFacts(h, messagesById, {
    recentSessions: opts.recentSessions,
    fileLimit: opts.fileLimit,
  });

  return {
    project: h.project,
    generatedAt: new Date().toISOString(),
    sessions: h.sessions,
    runs: h.runs,
    agents: h.agents,
    first: h.first ? h.first.toISOString() : null,
    last: h.last ? h.last.toISOString() : null,
    ...facts,
    readErrors,
    // 这是事实层的产物：没有模型参与，调用方不要把它当摘要。
    deterministic: true,
  };
}

/* ------------------------------ 文本出口 ------------------------------ */

/**
 * 把交接单渲染成 Markdown。CLI 的 --out、网页的复制按钮、MCP 的 text 摘要
 * 都可以复用这一份，避免四个出口各写一套格式。
 */
export function briefMarkdown(brief) {
  const out = [];
  const p = (n) => String(n).padStart(2, '0');
  const when = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  out.push(`# 交接单 · ${brief.project}`);
  out.push('');
  out.push(
    `> 生成于 ${when(brief.generatedAt)}｜材料：${brief.sessions} 场会话（${when(brief.first)} → ${when(
      brief.last
    )}）｜全部为记录摘录，未做模型推断`
  );
  out.push('');

  if (!brief.lastRun) {
    out.push('（没有可用的会话）');
    return out.join('\n');
  }

  const run = brief.lastRun;
  out.push('## 一、上一位接手的人');
  out.push('');
  out.push(`**${run.agent}** · ${run.count} 场会话 · ${when(run.start)} → ${when(run.end)}`);
  out.push('');
  out.push(`最后停在：**${run.lastSession.title || '(untitled)'}**（最后活动 ${when(run.lastSession.end)}）`);
  out.push('');
  out.push('最后一句用户说：');
  out.push('');
  out.push(quote(run.lastUserText));
  out.push('');
  out.push('最后一条回复（截断）：');
  out.push('');
  out.push(quote(run.lastAssistantText));
  out.push('');

  out.push('## 二、这一段动过的文件');
  out.push('');
  const projectFiles = brief.files.filter((f) => f.inProject);
  const shownFiles = (projectFiles.length ? projectFiles : brief.files).slice(0, 15);
  if (shownFiles.length) {
    out.push('| 文件 | Write/Edit 次数 |');
    out.push('|---|---|');
    for (const f of shownFiles) out.push(`| \`${f.path}\` | ${f.count} |`);
    if (brief.files.length > shownFiles.length) {
      out.push('');
      out.push(
        `（共 ${brief.files.length} 个文件；另外 ${brief.files.length - shownFiles.length} 个项目外/临时文件未列出）`
      );
    }
  } else {
    out.push('（这段会话里没有解析到 Write/Edit 的文件路径）');
  }
  out.push('');

  out.push('## 三、这一段留下的任务');
  out.push('');
  const openTasks = brief.tasks.filter((t) => t.status !== 'done');
  const shownTasks = openTasks.length ? openTasks : brief.tasks;
  if (shownTasks.length) {
    for (const t of shownTasks) {
      const box = t.status === 'done' ? '[x]' : t.status === 'doing' ? '[~]' : '[ ]';
      out.push(`- ${box} ${t.subject}`);
    }
    const done = brief.tasks.length - openTasks.length;
    if (openTasks.length && done) out.push(`- （另有 ${done} 项已完成，未列出）`);
  } else {
    out.push('（这段会话里没有 TodoWrite / TaskCreate 记录）');
  }
  out.push('');

  out.push('## 四、这一段最近几场会话');
  out.push('');
  out.push('| 开始时间 | Agent | 标题 | 会话 id |');
  out.push('|---|---|---|---|');
  for (const s of brief.recentSessions) {
    out.push(`| ${when(s.start)} | ${s.agent} | ${s.title || '(untitled)'} | \`${s.id}\` |`);
  }
  out.push('');

  if (brief.previous) {
    out.push('## 五、更早的一次换手');
    out.push('');
    const gap =
      brief.previous.kind === 'sequential' && brief.previous.gapMinutes != null
        ? `+${brief.previous.gapMinutes}min`
        : brief.previous.kind;
    out.push(`**${brief.previous.from} → ${brief.previous.to}** · 间隔 ${gap}`);
    if (brief.previous.fromTitle) out.push(`- 离开：${brief.previous.fromTitle}`);
    if (brief.previous.toTitle) out.push(`- 接手：${brief.previous.toTitle}`);
    out.push('');
  }

  out.push('## 六、从这里继续');
  out.push('');
  out.push(`- 读最后一场：\`agent-archive cat ${run.lastSession.id}\``);
  out.push(`- 看完整接力：\`agent-archive handoff ${brief.project}\``);
  out.push('');

  if (brief.readErrors && brief.readErrors.length) {
    out.push(`> 注：有 ${brief.readErrors.length} 场会话正文读取失败，未纳入文件与任务统计。`);
    out.push('');
  }

  return out.join('\n');
}

function quote(text) {
  const t = String(text || '').trim();
  if (!t) return '（无）';
  return t
    .split(/\r?\n/)
    .map((line) => '> ' + line)
    .join('\n');
}


function collectFile(part, input, files) {
  const raw = input.file_path || input.filePath || input.path;
  if (typeof raw === 'string' && raw.trim()) {
    const key = raw.trim();
    files.set(key, (files.get(key) || 0) + 1);
    return;
  }
  // apply_patch 的入参通常是一整段补丁文本，里面每段以 "*** Update File: <path>" 开头
  const patch = typeof part.input === 'string' ? part.input : input.patch;
  if (typeof patch === 'string') {
    const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
    let m;
    while ((m = re.exec(patch))) {
      const key = m[1].trim();
      if (key) files.set(key, (files.get(key) || 0) + 1);
    }
  }
}

function collectTodos(input, tasks) {
  const list = Array.isArray(input.todos) ? input.todos : Array.isArray(input.todo) ? input.todo : [];
  for (const item of list) {
    const subject = typeof item === 'string' ? item : item.content || item.subject || '';
    if (!subject) continue;
    tasks.push({ subject: clip(subject, 120), status: normalizeStatus(item.status) });
  }
}

function collectTaskCreate(input, tasks) {
  const subject = input.subject || input.description || '';
  if (subject) tasks.push({ subject: clip(subject, 120), status: normalizeStatus(input.status) });
}

function normalizeStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'completed':
    case 'done':
      return 'done';
    case 'in_progress':
    case 'in-progress':
    case 'doing':
      return 'doing';
    case 'pending':
    case 'todo':
    case 'not_started':
      return 'todo';
    default:
      return 'todo';
  }
}

function dedupeTasks(tasks) {
  // 同一个任务会被 TodoWrite 反复整表重写（pending → in_progress → completed）。
  // 按标题只留最后一次出现的状态，否则一页纸里全是同一条任务的不同版本。
  const bySubject = new Map();
  for (const t of tasks) bySubject.set(t.subject, t);
  return [...bySubject.values()];
}

function lastText(messages, role, limit) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== role) continue;
    const text = (m.parts || [])
      .filter((p) => p.kind === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (text) return clip(text.replace(/<\/?选中文本[^>]*>/g, '').trim(), limit);
  }
  return '';
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
