import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';

/**
 * Hermes 会话扫描。
 *
 * 存储：~/.hermes/sessions/YYYYMMDD_HHMMSS_<hash>.jsonl
 *
 * 格式干净：一行一个 {role, content, reasoning, timestamp}，
 * 首行 role=session_meta 带 tools/model/platform。
 *
 * 两个必须如实处理的限制：
 *
 * 1. **没有 cwd。** Hermes 是接飞书等渠道的助手，不绑定项目目录。
 *    所以它的会话归不到任何项目——这不是缺陷，是它跟编码 Agent 的
 *    定位差异。列进项目清单没有意义，但不该从档案馆里消失，
 *    因此 project 留空，由上层决定怎么展示。
 *
 * 2. **时间戳没有时区。** 形如 "2026-04-28T16:07:52.990679"，按本机
 *    本地时间解释。new Date() 对无时区字符串正是这个语义，符合预期。
 */

export const name = 'hermes';

function sessionsDir() {
  return path.join(os.homedir(), '.hermes', 'sessions');
}

export function discover() {
  const root = sessionsDir();
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(root, e.name));
  }
  return out;
}

export function parse(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let meta = null;
  let firstUserText = null;
  let firstAssistantText = null;
  let start = null;
  let end = null;
  let turns = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.role === 'session_meta') {
      meta = o;
      continue;
    }

    const d = parseTs(o.timestamp);
    if (d) {
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }

    turns++;
    if (o.role === 'user' && !firstUserText) {
      const t = textOf(o.content);
      if (t) firstUserText = t;
    } else if (o.role === 'assistant' && !firstAssistantText) {
      const t = textOf(o.content);
      if (t) firstAssistantText = t;
    }
  }

  if (!turns) return null;

  // 文件名 20260428_160732_1e25bfbe.jsonl 里带时间，时间戳缺失时兜底
  const base = path.basename(file, '.jsonl');
  const m = base.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/);
  const id = base;

  if (!start && m) {
    start = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );
  }
  if (!end) end = start;

  return makeSession({
    agent: name,
    id,
    // Hermes 不绑定工作目录，project 留空——不编造一个路径
    project: null,
    title: firstUserText || firstAssistantText || (meta && meta.platform ? `(${meta.platform})` : null),
    start,
    end,
    source: file,
    resume: null,
  });
}

/**
 * 解析 Hermes 的时间戳。
 *
 * 形如 "2026-04-28T16:07:52.990679"：无时区，按本地时间解释。
 * 微秒精度 JS 只保留毫秒，多余的位数直接截断，不影响排序。
 */
function parseTs(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return new Date(ts > 1e11 ? ts : ts * 1000);
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') parts.push(p);
    else if (typeof p.text === 'string') parts.push(p.text);
    else if (typeof p.content === 'string') parts.push(p.content);
  }
  return parts.join('\n').trim();
}

/**
 * 读一场会话的完整正文。
 *
 * Hermes 的 assistant 消息把思维链单独放在 reasoning 字段里，
 * 正文在 content。两者分开保留，展示层自己决定折不折。
 * tool 消息是工具返回值，单独成条。
 */
export function readMessages(session) {
  const real = assertUnder(sessionsDir(), session.source);
  const text = fs.readFileSync(real, 'utf8');
  const out = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    // 首行的 session_meta 是工具清单和模型信息，不是对话内容
    if (o.role === 'session_meta') continue;

    const ts = parseTs(o.timestamp);
    const parts = [];

    if (o.reasoning) {
      const p = reasoningPart(o.reasoning);
      if (p) parts.push(p);
    }

    const body = textOf(o.content);
    if (body) {
      const p = textPart(body);
      if (p) parts.push(p);
    }

    if (o.role === 'tool') {
      // 工具返回常是 JSON 字符串，原样留着；展示层会截断
      out.push(
        makeMessage({
          role: 'tool',
          parts: [toolPart({ name: o.tool_name || o.name || 'tool', output: body || o.content })],
          ts,
        })
      );
      continue;
    }

    if (!parts.length) continue;

    const role = o.role === 'assistant' ? 'assistant' : o.role === 'system' ? 'system' : 'user';
    out.push(makeMessage({ role, parts, ts }));
  }

  return out;
}
