import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart } from '../messages.js';
import { isDirEntry, isFileEntry } from '../fsentry.js';
import { extraRoots } from '../config.js';
import { readHeadTail, headLines, tailLines, allLines, jsonLines } from './headtail.js';

/**
 * WorkBuddy（腾讯的桌面 Agent）会话扫描。
 *
 * ## 存储
 *
 *   ~/.workbuddy/projects/<工作区转义>/<session-id>.jsonl
 *   ~/.workbuddy/projects/<工作区转义>/<session-id>/subagents/agent-*.jsonl
 *   ~/.workbuddy/projects/<工作区转义>/<session-id>.meta.json   （老会话的 cwd）
 *
 * 与 Claude Code 同构：一行一个事件，行内带 `timestamp`（**毫秒**）、
 * `sessionId`、`cwd`。事件类型是 OpenAI Agents SDK 的那套：
 *
 *   message              role=user 的 content 是 input_text；assistant 是 output_text
 *   reasoning            rawContent[].type === 'reasoning_text'
 *   function_call        工具调用，id 就是 callId
 *   function_call_result 工具结果，按 callId 配对
 *   ai-title             应用生成的标题（`aiTitle` 字段）
 *   session-meta         首行之一，带 sessionId
 *   file-history-snapshot / resend-fork-notice  运行时记录，不是对话
 *
 * ## 两个坑
 *
 * 1. **用户消息里裹着几 KB 的注入上下文。** 真人那句话在文件末尾的
 *    `<user_query>…</user_query>` 里，前面是 `<system-reminder
 *    data-role="user-context">` 整块（OS、shell、身份文件、技能清单）。
 *    直接取全文会让标题变成一坨模板文本。所以标题和正文都只取
 *    `<user_query>` 的内容，没有这层标签时才剥掉 system-reminder。
 *
 * 2. **失败回复也是一条 assistant message。** 限流、网络错误时 WorkBuddy
 *    会把错误原文写成 `status:"incomplete"` 的 assistant 消息，同时
 *    `providerData.error` 里带错误码。那不是模型说的话，读正文时要跳过，
 *    否则会话里会冒出「429 queue.full.title」这种垃圾。
 *
 * ## 扫描期只要头尾
 *
 * 单个会话文件本机最大 3.2 MB，但这类文件只会越写越长（同 Claude Code）。
 * 元数据（标题、cwd、起止时间）在头尾：`ai-title` 通常很早出现，结束时间
 * 在最后一行。所以走 `headtail.js` 的快路径，缺字段时整读兜底。
 */

export const name = 'workbuddy';

/** 数据根候选：环境变量覆盖 + 配置覆盖 + 默认位置（含 `.workbuddy-ai` 变体）。 */
function roots() {
  const list = [
    ...extraRoots(name),
    ...(process.env.WORKBUDDY_CONFIG_DIR ? [process.env.WORKBUDDY_CONFIG_DIR] : []),
    path.join(os.homedir(), '.workbuddy'),
    // 同产品的另一个客户端（`.workbuddy-ai`），布局相同，多数机器上是空壳。
    // 一起探的成本只有一次 readdir，收益是那些真的在里面写过会话的用户不会漏。
    path.join(os.homedir(), '.workbuddy-ai'),
  ];
  const out = [];
  for (const r of list) {
    const abs = path.resolve(String(r).replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** 声明"我会去哪里找数据"（给 doctor 与反向发现用）。 */
export function candidateRoots() {
  return roots();
}

/**
 * 发现会话文件。
 *
 * 只认 `projects/` 下**文件名是会话 id 的 `.jsonl`**：
 *   - `<id>.file-rollback.ndjson` 是文件回滚记录，不是对话；
 *   - `subagents/<id>/tool-results/*.txt` 是工具产物；
 *   - `app/`、`plugins/`、`binaries/` 下有几万个与对话无关的文件。
 *
 * 子代理放在 `<id>/subagents/agent-*.jsonl`，属于主会话那一棵树。
 */
export function discover() {
  const out = [];
  for (const root of roots()) {
    const projects = path.join(root, 'projects');
    let workspaces;
    try {
      workspaces = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const w of workspaces) {
      const wsDir = path.join(projects, w.name);
      if (!isDirEntry(w, wsDir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(wsDir, e.name);
        if (isFileEntry(e, p) && isSessionFile(e.name)) {
          out.push(p);
        } else if (isDirEntry(e, p)) {
          // 会话目录：<id>/subagents/*.jsonl
          const subs = path.join(p, 'subagents');
          let subEntries;
          try {
            subEntries = fs.readdirSync(subs, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const s of subEntries) {
            const sp = path.join(subs, s.name);
            if (isFileEntry(s, sp) && s.name.endsWith('.jsonl')) out.push(sp);
          }
        }
      }
    }
  }
  return out;
}

/** `<session-id>.jsonl` 才算会话；`*.file-rollback.ndjson`、`*.meta.json` 都不算。 */
function isSessionFile(name) {
  if (!name.endsWith('.jsonl')) return false;
  if (name.includes('.file-rollback')) return false;
  return name.length > '.jsonl'.length;
}

/** 文件是不是子代理转录（路径里有 `subagents` 这一段）。 */
function isSubagentPath(file) {
  return file.split(/[\\/]/).includes('subagents');
}

/**
 * 一个文件的"身份"：主会话是文件名（去掉扩展名），子代理是它自己的文件名。
 *
 * 两者都可能重名（不同项目下都有 `agent-xxx.jsonl` 的概率不高，但退一步：
 * 合并键是 `agent|id`，同名会被当成同一场会话）。所以子代理 id 里带上
 * 父会话 id 的前 8 位做命名空间，避免撞名。
 */
function identityOf(file) {
  const base = path.basename(file, '.jsonl');
  if (!isSubagentPath(file)) return { id: base, parent: null, kind: 'main' };
  // <…>/<parent-id>/subagents/agent-xxx.jsonl
  const parentDir = path.basename(path.dirname(path.dirname(file)));
  const parent = parentDir && parentDir !== '.' ? parentDir : null;
  return {
    id: parent ? `${parent.slice(0, 8)}:${base}` : base,
    parent,
    kind: 'subagent',
  };
}

/** 从目录名/cwd 里拿项目路径；拿不到就 null（宁可缺，不猜）。 */
function projectFromLine(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.cwd === 'string' && o.cwd.trim()) return cleanProject(o.cwd.trim());
  return null;
}

/**
 * WorkBuddy 自己的「临时工作区」不是用户的项目。
 *
 * 它没绑定真实目录时会开一个 `~/WorkBuddy/<时间戳>` 当工作区（本机 8 个会话
 * 都是这种）。把它们当项目列出来，项目清单里会塞满
 * `WorkBuddy/2026-08-28-15-48-29` 这种噪声——错的路径比缺数据更难发现。
 * 真绑定了项目目录的（如 `e:/my-app`，占位示例）照常保留。
 */
function cleanProject(p) {
  const scratch = path.join(os.homedir(), 'WorkBuddy');
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const n = norm(p);
  if (n === norm(scratch) || n.startsWith(norm(scratch) + '/')) return null;
  return p;
}

/**
 * 用户消息里那句真话。
 *
 * WorkBuddy 把 OS/shell/身份文件/技能清单全部塞进 `<system-reminder
 * data-role="user-context">`，真人输入在文件末尾的 `<user_query>` 里。
 * 没有 `<user_query>` 时（早期版本或纯注入消息）剥掉 reminder 再返回。
 */
export function extractUserText(text) {
  const raw = String(text || '');
  const q = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (q) return q[1].trim();
  return raw
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 是不是一条"纯注入"的 user 消息（剥完什么都不剩）。 */
function isInjectionOnly(text) {
  return extractUserText(text) === '';
}

export function parse(file) {
  let ht;
  try {
    ht = readHeadTail(file);
  } catch {
    return null;
  }

  const fast = parseParts(file, headLines(ht), tailLines(ht), ht.whole);
  if (!fast) return null;
  if (!fast.incomplete || ht.whole) return fast.session;

  try {
    const lines = allLines(file);
    const full = parseParts(file, lines, [], true);
    return full ? full.session : null;
  } catch {
    return fast.session;
  }
}

/**
 * 解析头段 + 尾段。
 *
 * 标题、cwd、起止时间都可能出现在中段（比如很晚才生成 ai-title），
 * 所以缺字段时返回 `incomplete`，由 `parse()` 决定要不要整读。
 */
function parseParts(file, head, tail, complete) {
  const { id, parent, kind } = identityOf(file);

  let project = null;
  let title = null;
  let fallbackTitle = null;
  let start = null;
  let end = null;
  let sawAny = false;

  for (const o of jsonLines(head)) {
    sawAny = true;
    if (!project) project = projectFromLine(o);
    const d = msToDate(o.timestamp);
    if (d) {
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }
    if (o.type === 'ai-title' && (o.aiTitle || o.title)) {
      title = String(o.aiTitle || o.title);
    }
    if (!title && !fallbackTitle && o.type === 'message') {
      if (o.role === 'user') {
        const t = extractUserText(authorText(o.content));
        if (t && !isInjectionOnly(t)) title = t;
      } else if (o.role === 'assistant' && !hasProviderError(o)) {
        fallbackTitle = authorText(o.content);
      }
    }
  }

  // 尾段只补结束时间：标题的定义是"第一句真人输入"，它在开头；
  // 尾段里的 user 消息是对话后段的内容，不该拿来当标题。
  for (const o of jsonLines(tail)) {
    sawAny = true;
    const d = msToDate(o.timestamp);
    if (d && (!end || d > end)) end = d;
  }

  if (!sawAny) return null;

  // 老会话的 cwd 可能只写在 <id>.meta.json 里
  if (!project) project = projectFromMeta(file);

  const incomplete =
    !complete && (!project || (!title && !fallbackTitle) || (!start && !end));

  if (!start && !end) {
    try {
      const st = fs.statSync(file);
      start = st.mtime;
      end = st.mtime;
    } catch {
      return null;
    }
  }

  return {
    incomplete,
    session: makeSession({
      agent: name,
      id,
      project,
      title: title || fallbackTitle,
      start,
      end: end || start,
      source: file,
      // 桌面应用：没有命令行恢复方式
      resume: null,
      kind,
      parent,
    }),
  };
}

/** `<id>.meta.json` 里的 cwd（老会话迁移过来的那批才有）。 */
function projectFromMeta(file) {
  const meta = `${file.slice(0, -'.jsonl'.length)}.meta.json`;
  try {
    const o = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const cwd = o && (o.cwd || o.projectPath || o.workspace);
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
  } catch {
    return null;
  }
}

/** 毫秒时间戳（本机实测全是 13 位毫秒）；容忍秒级与 ISO。 */
function msToDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** content 数组里所有文本拼接。 */
function authorText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p.text === 'string') parts.push(p.text);
    else if (typeof p.content === 'string') parts.push(p.content);
  }
  return parts.join('\n').trim();
}

/** 失败回复也写成 assistant message，带 providerData.error——它不是模型说的话。 */
function hasProviderError(o) {
  return Boolean(o && o.providerData && o.providerData.error);
}

/**
 * 读一场会话的完整正文。
 *
 * 事件 → 消息的映射：
 *   message(user)              剥掉注入上下文，只留 `<user_query>` 里的话
 *   message(assistant)         output_text；带 providerData.error 的跳过
 *   reasoning                  rawContent[].reasoning_text → reasoningPart
 *   function_call              工具调用（**callId 字段**才是工具 id，`id` 是消息 id）
 *   function_call_result       按 callId 补到对应工具调用的 output 上
 *
 * ## 编辑重发：被改掉的那几版不该出现在正文里
 *
 * WorkBuddy 允许改一条已发出的用户消息再重发。实现方式是追加一条新的
 * user message，再写一条 `resend-fork-notice` 指回被改的那条
 * （`editedUserItemId`）。本机实测一个会话里 6 条 user 消息只有 3 个真正
 * 到达过模型：前两版都被后一版取代了。
 *
 * 所以先扫一遍收集"被取代的 id"，输出时跳过它们。**这不是去重**：每条
 * 消息 id 都唯一，只是它们从未作为一次独立发言到达模型；留着会让正文里
 * 同一句话连说三遍，读者会以为发生过三次对话。
 *
 * 其余类型（file-history-snapshot / ai-title / session-meta）是运行时记录，
 * 不是对话。
 */
export function readMessages(session) {
  let lines;
  try {
    lines = allLines(session.source);
  } catch {
    throw new Error(`读不到 WorkBuddy 会话文件：${session.source}`);
  }

  const out = [];
  const pending = new Map();

  // 第一遍：被"编辑重发"取代的 user 消息 id
  const superseded = new Set();
  for (const o of jsonLines(lines)) {
    if (o.type === 'resend-fork-notice' && o.editedUserItemId) {
      superseded.add(String(o.editedUserItemId));
    }
  }

  for (const o of jsonLines(lines)) {
    const ts = msToDate(o.timestamp);

    if (o.type === 'message') {
      if (hasProviderError(o)) continue;
      const text = authorText(o.content);
      if (o.role === 'user') {
        if (o.id && superseded.has(String(o.id))) continue; // 被改掉的那一版
        const t = extractUserText(text);
        if (t && !isInjectionOnly(t)) {
          out.push(makeMessage({ role: 'user', parts: [textPart(t)], ts }));
        }
      } else if (o.role === 'assistant') {
        if (text) out.push(makeMessage({ role: 'assistant', parts: [textPart(text)], ts }));
      }
      continue;
    }

    if (o.type === 'reasoning') {
      const texts = [];
      for (const p of Array.isArray(o.rawContent) ? o.rawContent : []) {
        if (p && p.type === 'reasoning_text' && p.text) texts.push(p.text);
      }
      const joined = texts.join('\n').trim();
      if (joined) out.push(makeMessage({ role: 'assistant', parts: [reasoningPart(joined)], ts }));
      continue;
    }

    if (o.type === 'function_call') {
      const callId = o.callId || o.id || null;
      const input = parseMaybeJson(o.arguments);
      const part = toolPart({
        name: o.name || 'tool',
        input,
        callId,
        status: o.status || null,
      });
      pending.set(callId, part);
      out.push(makeMessage({ role: 'tool', parts: [part], ts }));
      continue;
    }

    if (o.type === 'function_call_result') {
      const callId = o.callId || o.id || null;
      const output = resultText(o.output);
      const part = pending.get(callId);
      if (part) {
        part.output = output;
        part.status = o.status || part.status;
      } else {
        // 结果先于调用出现（或调用行被截断）：单独成一条，不丢内容
        out.push(
          makeMessage({
            role: 'tool',
            parts: [
              toolPart({ name: o.name || 'tool', input: null, callId, output, status: o.status || null }),
            ],
            ts,
          })
        );
      }
      continue;
    }
  }

  return out;
}

/** `function_call_result.output` 可能是 {type:'text',text} 或字符串。 */
function resultText(output) {
  if (output == null) return null;
  if (typeof output === 'string') return output;
  if (typeof output.text === 'string') return output.text;
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
}

function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}