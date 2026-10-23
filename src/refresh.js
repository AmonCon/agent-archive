import { scanAll } from './registry.js';
import { readSessionContent } from './query.js';
import { latestArtifact, listArtifacts, hashText } from './derive.js';
import { loadConfig, estimateTokens } from './llm.js';
import {
  sessionToText,
  projectSubject,
  SESSION_PROMPT_VERSION,
  PROJECT_PROMPT_VERSION,
} from './digest.js';
import { projectKey } from './model.js';

/**
 * 衍生数据的增量刷新。
 *
 * 四元组缓存 (kind, subject, source_hash, prompt_version, model) 本身已经
 * 保证了"变了才重算"——换模型、改提示词、会话追加内容，键自然就 miss。
 * 所以这个模块**不负责重算逻辑**，它解决的是另一个问题：
 *
 *   **在花钱之前，看得见哪些过期了、为什么过期、要花多少。**
 *
 * 之前只能对整个项目盲跑 `digest --run`，跑完才知道花了多少。项目一多，
 * 就变成"不知道要不要跑、跑了也不知道值不值"。
 *
 * 过期原因分四类，处置方式完全不同：
 *   model-changed    换了模型 → 想用新模型的口径就重算，不换就别管
 *   prompt-changed   提示词改过 → 只有改进过才值得重算
 *   source-changed   会话又追加了内容 → 应该重算
 *   dependency-stale 本项目里有会话摘要过期 → 项目摘要跟着失效
 *   orphan          源会话已经不在了 → 摘要没有归属，可以清掉
 */

/** 默认参与项目摘要的会话数，必须与 digest.js 保持一致才能算出同一个哈希。 */
const DEFAULT_LIMIT = 60;

/**
 * 审计全部衍生数据。
 *
 * @param {object} opts
 * @param {string} opts.project 只看某个项目
 * @param {number} opts.limit   参与项目摘要的会话数（与生成时一致）
 */
export async function auditDerived({ project, limit = DEFAULT_LIMIT } = {}) {
  const cfg = loadConfig();
  const { sessions } = scanAll({});

  const byKey = new Map();
  for (const s of sessions) byKey.set(`${s.agent}|${s.id}`, s);

  // 项目键 → 会话列表，供项目摘要审计用
  const byProject = new Map();
  for (const s of sessions) {
    if (!s.project) continue;
    const k = projectKey(s.project);
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(s);
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => (a.start || 0) - (b.start || 0));
  }

  const wantSubject = project ? projectSubject(project) : null;

  // ---- 会话摘要 ----
  const sessionArts = listArtifacts({ kind: 'session_summary', limit: 100000 });
  const sessionRows = [];

  for (const a of sessionArts) {
    if (wantSubject && `session:${a.subject}` !== wantSubject && !a.subject.startsWith(`${project}|`)) {
      // 按项目过滤时，用会话反查它属于哪个项目；这里先留全集，下面再筛
    }
    const [agent, ...rest] = String(a.subject).split('|');
    const id = rest.join('|');
    const s = byKey.get(`${agent}|${id}`);

    if (!s) {
      sessionRows.push({
        agent,
        id,
        title: '(源会话已不存在)',
        status: 'orphan',
        reason: '源会话已不在任何 Agent 存储里',
        model: a.model,
        promptVersion: a.promptVersion,
        createdAt: a.createdAt,
        chars: 0,
      });
      continue;
    }

    let text;
    try {
      const messages = await readSessionContent(s);
      text = sessionToText(s, messages);
    } catch {
      sessionRows.push({
        agent,
        id,
        title: s.title,
        status: 'unreadable',
        reason: '正文读不出来（格式加密或已损坏）',
        model: a.model,
        promptVersion: a.promptVersion,
        createdAt: a.createdAt,
        chars: 0,
      });
      continue;
    }

    const hash = hashText(text);
    const status = classify({
      cachedModel: a.model,
      cachedPrompt: a.promptVersion,
      cachedHash: a.sourceHash,
      currentModel: cfg.model,
      currentPrompt: SESSION_PROMPT_VERSION,
      currentHash: hash,
    });

    sessionRows.push({
      agent,
      id,
      title: s.title,
      project: s.project,
      status,
      reason: reasonText(status),
      model: a.model,
      promptVersion: a.promptVersion,
      createdAt: a.createdAt,
      chars: text.length,
    });
  }

  // ---- 项目摘要 ----
  // 先记下哪些会话摘要已经过期。项目摘要的依赖检查必须包含"内容变了"这一项，
  // 否则会话追加了内容、会话摘要该重算，而项目摘要还自以为是新的。
  const staleSessionKeys = new Set(
    sessionRows.filter((r) => r.status !== 'current').map((r) => `${r.agent}|${r.id}`)
  );

  const projArts = listArtifacts({ kind: 'project_digest', limit: 100000 });
  const projectRows = [];

  for (const a of projArts) {
    const key = String(a.subject).replace(/^project:/, '');
    const list = byProject.get(key) || [];
    if (!list.length) {
      projectRows.push({
        subject: a.subject,
        project: key,
        status: 'orphan',
        reason: '该项目已没有任何会话',
        model: a.model,
        createdAt: a.createdAt,
        sessionCount: 0,
        staleDeps: 0,
        chars: 0,
      });
      continue;
    }

    const picked = list.slice(-Math.min(Math.max(limit, 1), 300));

    // 用当前最新的会话摘要拼出"生成时应当用的材料"
    const parts = [];
    let missing = 0;
    let staleDeps = 0;
    for (const s of picked) {
      const art = latestArtifact({ kind: 'session_summary', subject: `${s.agent}|${s.id}` });
      if (!art) {
        missing++;
        continue;
      }
      parts.push(`${s.title}\n${art.body}`);

      // 这份依赖是否过期：模型/提示词变了，或它自己该重算（内容变了）
      const depKey = `${s.agent}|${s.id}`;
      if (art.model !== cfg.model || art.promptVersion !== SESSION_PROMPT_VERSION) staleDeps++;
      else if (staleSessionKeys.has(depKey)) staleDeps++;
    }

    let status;
    if (missing > 0) status = 'missing-dependency';
    else if (staleDeps > 0) status = 'dependency-stale';
    else {
      status = classify({
        cachedModel: a.model,
        cachedPrompt: a.promptVersion,
        cachedHash: a.sourceHash,
        currentModel: cfg.model,
        currentPrompt: PROJECT_PROMPT_VERSION,
        currentHash: hashText(parts.join('\n\n')),
      });
    }

    projectRows.push({
      subject: a.subject,
      project: key,
      status,
      reason:
        status === 'missing-dependency'
          ? `${missing} 场会话还没有摘要`
          : status === 'dependency-stale'
            ? `${staleDeps} 场会话的摘要已过期`
            : reasonText(status),
      model: a.model,
      createdAt: a.createdAt,
      sessionCount: picked.length,
      staleDeps,
      chars: parts.join('\n\n').length,
    });
  }

  // 按项目筛选（放在最后统一做，避免上面两段各写一遍）
  let rows = sessionRows;
  let prows = projectRows;
  if (project) {
    const key = projectKey(String(project).replace(/\\/g, '/'));
    rows = sessionRows.filter((r) => r.project && projectKey(r.project) === key);
    prows = projectRows.filter((r) => r.project === key);
  }

  const staleSessions = rows.filter((r) => r.status !== 'current');
  const staleProjects = prows.filter((r) => r.status !== 'current');

  return {
    model: cfg.model || '(未配置)',
    promptVersions: { session: SESSION_PROMPT_VERSION, project: PROJECT_PROMPT_VERSION },
    sessions: rows,
    projects: prows,
    summary: {
      sessions: {
        total: rows.length,
        current: rows.length - staleSessions.length,
        stale: staleSessions.length,
      },
      projects: {
        total: prows.length,
        current: prows.length - staleProjects.length,
        stale: staleProjects.length,
      },
      // 粗估：过期的会话摘要要重读正文，过期的项目摘要要再吃一遍会话摘要
      estTokensIn:
        estimateTokens(staleSessions.reduce((n, r) => n + (r.chars || 0), 0)) +
        estimateTokens(staleProjects.reduce((n, r) => n + (r.chars || 0), 0)),
      estTokensOut:
        estimateTokens(staleSessions.length * 350) + estimateTokens(staleProjects.length * 900),
    },
  };
}

/** 比较四元组，给出状态。 */
function classify({ cachedModel, cachedPrompt, cachedHash, currentModel, currentPrompt, currentHash }) {
  if (cachedHash !== currentHash) return 'source-changed';
  if (cachedModel !== currentModel) return 'model-changed';
  if (cachedPrompt !== currentPrompt) return 'prompt-changed';
  return 'current';
}

function reasonText(status) {
  switch (status) {
    case 'current':
      return '最新';
    case 'source-changed':
      return '内容变了（会话有追加）';
    case 'model-changed':
      return '模型换了';
    case 'prompt-changed':
      return '提示词改过';
    default:
      return status;
  }
}

/**
 * 快速新鲜度检查（不读会话正文）。
 *
 * 网页每次请求都要调，所以不能像 auditDerived 那样读全部会话算哈希
 * （全量 33 秒）。这里只做三项**零成本**检查：
 *
 *   1. 模型是否还是生成它的那个
 *   2. 提示词版本是否还是生成它的那个
 *   3. 生成之后这个项目有没有**新增会话**
 *
 * 查不了的那项必须说清楚：**会话内容变了但数量没变**（同一场又聊了几轮）
 * 这个检查发现不了，要准确结果得跑 `agent-archive refresh`。
 * 宁可承认能力边界，也不要给一个看起来确定、实际会漏的结论。
 */
export function quickFreshness({ kind, artifact, projectSessions }) {
  if (!artifact) return { status: 'none' };

  const cfg = loadConfig();
  const issues = [];

  if (cfg.model && artifact.model !== cfg.model) {
    issues.push({ type: 'model-changed', detail: `生成时用的是 ${artifact.model}` });
  }

  if (kind === 'project') {
    if (artifact.promptVersion !== PROJECT_PROMPT_VERSION) {
      issues.push({
        type: 'prompt-changed',
        detail: `生成时提示词版本 ${artifact.promptVersion}，当前 ${PROJECT_PROMPT_VERSION}`,
      });
    }
  } else if (artifact.promptVersion !== SESSION_PROMPT_VERSION) {
    issues.push({
      type: 'prompt-changed',
      detail: `生成时提示词版本 ${artifact.promptVersion}，当前 ${SESSION_PROMPT_VERSION}`,
    });
  }

  // 生成之后有会话新增，说明材料肯定变了
  if (Array.isArray(projectSessions) && artifact.createdAt) {
    const t = artifact.createdAt.getTime();
    const newer = projectSessions.filter((s) => s.start && s.start.getTime() > t).length;
    if (newer > 0) {
      issues.push({ type: 'new-sessions', detail: `生成之后新增了 ${newer} 场会话` });
    }
  }

  return {
    status: issues.length ? 'possibly-stale' : 'likely-current',
    issues,
    // 让调用方能把"我查过了"和"我查不了"分开说
    unchecked: ['会话内容有变化但数量没变（同一场又聊了几轮）'],
    checkedAt: new Date(),
  };
}
