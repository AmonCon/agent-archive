/**
 * 会话目录（TurnIndex）。
 *
 * 一场大会话几十轮，一屏到底很难回到某次提问。这里按"用户发问"切段：
 * 每条有文字的 user 消息开启一轮，直到下一条 user 消息为止。
 * 目录只回答三件事：什么时候问的、问了什么、这一轮是否收尾。
 *
 * 纯函数，不读文件、不看 Agent 差异——消息已经是统一模型了。
 */

/** 提问摘要的字数上限（含省略号）。 */
const QUESTION_MAX = 80;

/**
 * @param {{ role: string, parts: Array, ts: Date|null }[]} messages
 * @returns {{ index: number, start: Date|null, end: Date|null, question: string,
 *            steps: number, errors: number, hasFinalReply: boolean }[]}
 */
export function buildTurns(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];

  const out = [];
  let cur = null;
  // 收尾判断要看位置：只有"最后一个 assistant 文字"落在"最后一个 tool 消息"之后，
  // 才算这一轮把话说完。先记下标，轮次结束后再结算。
  let lastTool = -1;
  let lastReply = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;

    if (m.role === 'user') {
      const q = questionText(m);
      if (q) {
        if (cur) finish(cur, lastTool, lastReply);
        cur = {
          index: i,
          start: asDate(m.ts),
          end: asDate(m.ts),
          question: q,
          steps: 0,
          errors: 0,
          hasFinalReply: false,
        };
        out.push(cur);
        lastTool = -1;
        lastReply = -1;
      }
    }

    // 第一条 user 之前的内容（system 前言）不进目录，也不进任何一轮的统计
    if (!cur) continue;

    const ts = asDate(m.ts);
    if (ts) {
      if (!cur.start || ts < cur.start) cur.start = ts;
      if (!cur.end || ts > cur.end) cur.end = ts;
    }

    if (m.role === 'tool') {
      cur.steps++;
      lastTool = i;
    } else if (m.role === 'assistant' && hasText(m)) {
      lastReply = i;
    }

    for (const p of m.parts || []) {
      if (p && p.kind === 'tool' && p.status === 'error') cur.errors++;
    }
  }

  if (cur) finish(cur, lastTool, lastReply);
  return out;
}

function finish(turn, lastTool, lastReply) {
  turn.hasFinalReply = lastReply >= 0 && lastReply > lastTool;
}

function hasText(m) {
  return (m.parts || []).some((p) => p && p.kind === 'text' && String(p.text || '').trim());
}

/** 首条用户文字压成一行；没有文字的用户消息不开新轮（例如只带附件）。 */
function questionText(m) {
  const part = (m.parts || []).find((p) => p && p.kind === 'text' && String(p.text || '').trim());
  if (!part) return '';
  const line = String(part.text).replace(/\s+/g, ' ').trim();
  if (line.length <= QUESTION_MAX) return line;
  return line.slice(0, QUESTION_MAX - 1) + '…';
}

function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
