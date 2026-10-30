import { listProjects, projectTimeline, groupByAgent, readSessionContent } from './query.js';
import { durationMs, tildify, dayKey } from './model.js';
import { summarizeInput } from './messages.js';

/**
 * Markdown 导出。
 *
 * 三种粒度，对应三种实际用途：
 *
 *   timeline  一个项目的会话清单 —— 看"这个项目经历了什么"
 *   session   一场对话的完整正文 —— 给别的模型读、存档、贴进 issue
 *   bundle    一个项目下所有会话正文合成一份 —— 完整交接材料
 *
 * 都是纯函数：吃数据、吐字符串，不碰文件系统。CLI 和网页共用同一份实现，
 * 所以"网页上看到的"和"导出的"永远是同一份内容。
 *
 * 正文一律做 Markdown 转义（表格竖线、标题井号），否则会话里随便一句
 * "## 结论" 就会把导出文档的层级搞乱。
 */

/* ------------------------------ 时间线 ------------------------------ */

/**
 * 导出一个项目的时间线。
 *
 * @param {string} target 项目路径或名称
 * @param {object} opts
 * @param {boolean} opts.includeTitles 是否附上每场会话的首句（默认 false，只列清单）
 */
export function timelineMarkdown(target, { includeTitles = false } = {}) {
  const r = projectTimeline(target, {});
  const groups = groupByAgent(r.sessions);

  const lines = [];
  lines.push(`# ${esc(tildify(r.target))}`);
  lines.push('');

  if (!r.sessions.length) {
    lines.push('这个项目下没有找到会话。');
    return lines.join('\n') + '\n';
  }

  const { summary } = r;
  lines.push(
    `${summary.count} 场会话 · ${summary.agents.join(' / ')} · ` +
      `${fmtDate(summary.first)} → ${fmtDate(summary.last)} · 累计 ${fmtDur(summary.totalMs)}`
  );
  lines.push('');

  // 各 Agent 分布
  lines.push('## 各 Agent');
  lines.push('');
  lines.push('| Agent | 会话 | 累计时长 | 时间范围 |');
  lines.push('|---|---:|---:|---|');
  for (const [agent, ss] of groups) {
    const total = ss.reduce((n, s) => n + durationMs(s), 0);
    const first = ss.reduce((a, s) => (!a || (s.start && s.start < a) ? s.start : a), null);
    const last = ss.reduce((a, s) => (!a || (s.end && s.end > a) ? s.end : a), null);
    lines.push(
      `| ${esc(agent)} | ${ss.length} | ${fmtDur(total) || '—'} | ${fmtDate(first)} → ${fmtDate(last)} |`
    );
  }
  lines.push('');

  // 按天分组的时间线
  lines.push('## 时间线');
  lines.push('');
  let day = null;
  for (const s of r.sessions) {
    const d = s.start ? dayKey(s.start) : '未知日期';
    if (d !== day) {
      day = d;
      lines.push(`### ${d}`);
      lines.push('');
    }
    const dur = fmtDur(durationMs(s));
    const time = s.start ? fmtTime(s.start) : '';
    lines.push(`- \`${esc(s.agent)}\` ${time}${dur ? ' · ' + dur : ''} — ${esc(s.title)}`);
    if (includeTitles) {
      lines.push(`  - id: \`${esc(s.id)}\``);
    }
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`由 agent-archive 导出 · ${fmtDate(new Date())}`);
  return lines.join('\n') + '\n';
}

/* ------------------------------ 单场会话 ------------------------------ */

/**
 * 导出一场会话的完整正文。
 *
 * @param {object} session 统一模型里的会话对象
 * @param {object} opts
 * @param {boolean} opts.tools     是否展开工具调用与输出
 * @param {boolean} opts.reasoning 是否包含推理摘要
 * @param {boolean} opts.system    是否包含注入内容
 */
export async function sessionMarkdown(session, { tools = false, reasoning = false, system = false } = {}) {
  const messages = await readSessionContent(session);

  const lines = [];
  // 标题可能是整段提问（Qoder 会把提示词整段当标题），H1 里要收短
  lines.push(`# ${esc(clipTitle(session.title))}`);
  lines.push('');

  // 元信息表：这几项是"这份文档从哪来"的关键线索
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Agent | \`${esc(session.agent)}\` |`);
  lines.push(`| 会话 ID | \`${esc(session.id)}\` |`);
  if (session.project) lines.push(`| 项目 | \`${esc(tildify(session.project))}\` |`);
  lines.push(`| 时间 | ${fmtDate(session.start)} → ${fmtDate(session.end)} |`);
  const dur = fmtDur(durationMs(session));
  if (dur) lines.push(`| 时长 | ${dur} |`);
  if (session.resume) lines.push(`| 恢复 | \`${esc(session.resume)}\` |`);
  lines.push('');

  let foldedSystem = 0;
  let foldedTools = 0;
  let foldedReasoning = 0;

  for (const m of messages) {
    // 系统注入默认跳过，只统计字数，末尾说明
    if (m.role === 'system' && !system) {
      foldedSystem += m.parts.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
      continue;
    }

    const kept = [];
    for (const p of m.parts) {
      if (p.kind === 'text') kept.push({ ...p });
      else if (p.kind === 'reasoning') {
        if (!reasoning) {
          foldedReasoning++;
          continue;
        }
        kept.push({ ...p });
      } else if (p.kind === 'tool') {
        if (!tools) {
          foldedTools++;
          kept.push({ kind: 'tool-line', text: toolLine(p) });
          continue;
        }
        kept.push({ ...p });
      }
    }
    if (!kept.length) continue;

    const label = roleLabel(m.role);
    const when = m.ts ? ` · ${fmtTime(m.ts)}` : '';
    lines.push(`## ${label}${when}`);
    lines.push('');

    for (const p of kept) {
      if (p.kind === 'text') {
        lines.push(quoteText(p.text));
        lines.push('');
      } else if (p.kind === 'reasoning') {
        lines.push('<details>');
        lines.push('<summary>推理</summary>');
        lines.push('');
        lines.push(quoteText(p.text));
        lines.push('');
        lines.push('</details>');
        lines.push('');
      } else if (p.kind === 'tool-line') {
        lines.push(`> \`${esc(p.text)}\``);
        lines.push('');
      } else if (p.kind === 'tool') {
        lines.push(`<details>`);
        lines.push(`<summary><code>${esc(p.name)}</code> ${esc(summarizeInput(p.input))}</summary>`);
        lines.push('');
        if (p.input) {
          lines.push('**入参**');
          lines.push('');
          lines.push('```json');
          lines.push(pretty(p.input));
          lines.push('```');
          lines.push('');
        }
        if (p.output) {
          lines.push('**输出**');
          lines.push('');
          lines.push('```');
          lines.push(p.output);
          lines.push('```');
          lines.push('');
        }
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  const notes = [];
  if (foldedSystem) notes.push(`系统注入 ${foldedSystem} 字`);
  if (foldedTools) notes.push(`工具调用 ${foldedTools} 处`);
  if (foldedReasoning) notes.push(`推理 ${foldedReasoning} 段`);
  if (notes.length) {
    lines.push('---');
    lines.push('');
    lines.push(
      `已折叠：${notes.join('、')}。导出时加 \`--tools\` / \`--reasoning\` / \`--system\` 可展开。`
    );
    lines.push('');
  }

  lines.push(`由 agent-archive 导出 · ${fmtDate(new Date())}`);
  return lines.join('\n') + '\n';
}

/* ------------------------------ 整包 ------------------------------ */

/**
 * 把一个项目下所有会话正文合成一份文档。
 *
 * 这是"交接材料"：新接手的人或模型从头读一遍，就知道这个项目
 * 在各个 Agent 里发生过什么。默认只含正文和工具调用摘要，
 * 不含完整工具输出——那会让文档膨胀十倍而信息密度骤降。
 */
export async function bundleMarkdown(target, { limit = 0, onProgress } = {}) {
  const r = projectTimeline(target, {});
  const all = limit > 0 ? r.sessions.slice(-limit) : r.sessions;

  const lines = [];
  lines.push(`# ${esc(tildify(r.target))} · 完整会话归档`);
  lines.push('');
  lines.push(
    `${all.length} 场会话 · ${r.summary.agents.join(' / ')} · ` +
      `${fmtDate(r.summary.first)} → ${fmtDate(r.summary.last)}`
  );
  lines.push('');

  // 目录：方便跳转
  lines.push('## 目录');
  lines.push('');
  all.forEach((s, i) => {
    const anchor = `session-${i + 1}`;
    lines.push(
      `${i + 1}. [${esc(s.title)}](#${anchor}) — \`${esc(s.agent)}\` ${fmtDate(s.start)}`
    );
  });
  lines.push('');

  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (onProgress) onProgress({ i, total: all.length, title: s.title });

    lines.push('---');
    lines.push('');
    lines.push(`<a id="session-${i + 1}"></a>`);
    lines.push('');
    lines.push(`## ${i + 1}. ${esc(s.title)}`);
    lines.push('');
    lines.push(
      `\`${esc(s.agent)}\` · \`${esc(s.id)}\` · ${fmtDate(s.start)} → ${fmtDate(s.end)}`
    );
    lines.push('');

    let messages;
    try {
      messages = await readSessionContent(s);
    } catch (e) {
      lines.push(`> 读不了这场会话：${esc(e && e.message ? e.message : String(e))}`);
      lines.push('');
      continue;
    }

    for (const m of messages) {
      if (m.role === 'system') continue; // 注入内容不进交接材料

      const parts = [];
      for (const p of m.parts) {
        if (p.kind === 'text') parts.push(quoteText(p.text));
        else if (p.kind === 'tool') parts.push(`> \`${esc(toolLine(p))}\``);
      }
      if (!parts.length) continue;

      lines.push(`**${roleLabel(m.role)}**${m.ts ? ' · ' + fmtTime(m.ts) : ''}`);
      lines.push('');
      lines.push(parts.join('\n\n'));
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`由 agent-archive 导出 · ${fmtDate(new Date())}`);
  return lines.join('\n') + '\n';
}

/* ------------------------------ 工具 ------------------------------ */

/**
 * 正文转引用块。
 *
 * 用 > 包住原文，一是视觉上区分"谁说的话"，二是让原文里偶然出现的
 * 标题井号失效——否则一段 "# 结论" 会把文档大纲撕开。
 */
function quoteText(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trimEnd();
  if (!t) return '';
  return t
    .split('\n')
    .map((l) => (l.trim() ? '> ' + l : '>'))
    .join('\n');
}

function roleLabel(role) {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'tool') return '工具输出';
  return '系统';
}

function toolLine(p) {
  const detail = summarizeInput(p.input, { limit: 90, jsonLimit: 70 });
  const mark = p.status && p.status !== 'completed' ? ` ✗${p.status}` : '';
  return `[${p.name}${detail ? ' ' + detail : ''}]${mark}`;
}

function oneLine(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 标题在 H1 里用，超过一行就截断；完整内容在正文里本来就有。 */
function clipTitle(t) {
  return oneLine(t, 60);
}

function pretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Markdown 转义。
 *
 * 只处理会破坏结构的字符：表格竖线、行首井号、反引号配对。
 * 过度转义会让正文变得难读，所以点到为止。
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ')
    .trim();
}

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(
    dt.getMinutes()
  )}`;
}

function fmtTime(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function fmtDur(ms) {
  if (!ms || ms < 1000) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = ms / 3600000;
  return h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

export { listProjects };
