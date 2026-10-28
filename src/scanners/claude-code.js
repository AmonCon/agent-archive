import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnderAny } from '../messages.js';
import { withOverrides } from '../platform.js';
import { isDirEntry } from '../fsentry.js';
import { extraRoots } from '../config.js';

/**
 * Claude Code 会话扫描。
 *
 * 存储：`~/.claude/projects/<项目路径转义>/<session-uuid>.jsonl`
 * 一行一个 JSON 事件。消息行的 cwd 字段直接给出项目绝对路径，
 * 目录名的转义规则不必反推——那套规则改过版本，从行内字段取更稳。
 *
 * **三个平台一致**，这是官方文档明确写的（`~/.claude` 就在家目录下，
 * Windows 的 `~` 是 `%USERPROFILE%`）。不要去找
 * `~/Library/Application Support/Claude`——那是 **Claude Desktop 桌面应用**，
 * 另一个产品，会话格式也完全不同。
 *
 * 两个候选位置：
 *   CLAUDE_CONFIG_DIR  官方支持，会把 `.claude.json` 一起挪过去
 *                      （devcontainer 文档特别提醒：只挂目录、不设这个变量不够）
 *   ~/.config/claude   社区工具的兼容位置（ccusage 等优先试它）。
 *                      官方不支持，但确实有用户在这留过数据，作为低优先候选。
 *
 * macOS 凭据在 Keychain（service: `Claude Code-credentials`），不在文件里。
 * 本工具不碰凭据，这条只记在这里备查。
 */

export const name = 'claude-code';

/** 所有候选的 projects 根目录（配置 > 环境变量 > 平台默认）。 */
function projectDirs() {
  const defaults = [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects'),
  ];

  // 配置文件里的根：含义是 `.claude` 那一层，也可能用户直接指到 projects，
  // 两种都接受（与环境变量的处理保持一致）
  const configured = extraRoots(name).map((p) =>
    path.basename(p) === 'projects' ? p : path.join(p, 'projects')
  );

  // 覆盖变量指向的是 .claude 本身，要拼上 projects；
  // 但也可能用户直接指到 projects，两种都接受
  const overrides = withOverrides(['CLAUDE_CONFIG_DIR'], []).map((p) =>
    path.basename(p) === 'projects' ? p : path.join(p, 'projects')
  );

  return [...configured, ...overrides, ...defaults];
}

/**
 * 声明"我会去哪里找数据"（给 doctor 与反向发现用，见 codex.js 的说明）。
 *
 * 这里给的是 `.claude` 这一层的应用根，不是 `projects/` 子目录——
 * 两处消费者要的都是"这个应用的数据放哪儿"这个粒度。
 */
export function candidateRoots() {
  const home = os.homedir();
  return [
    ...extraRoots(name),
    ...withOverrides(['CLAUDE_CONFIG_DIR'], []),
    path.join(home, '.claude'),
    path.join(home, '.config', 'claude'),
  ];
}

export function discover() {
  const out = [];
  const seen = new Set();
  for (const root of projectDirs()) {
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      const full = path.join(root, d.name);
      // 跟随符号链接/junction：用户把项目目录搬走后留个链接是常见做法，
      // dirent.isDirectory() 会把它判成"不是目录"从而整家漏掉
      if (!isDirEntry(d, full)) continue;
      let files;
      try {
        files = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(full, f);
        // 同一个项目目录可能通过两个候选位置都被看到（一个是指向另一个的链接）
        const key = process.platform === 'linux' ? p : p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    }
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

  let cwd = null;
  let sessionId = path.basename(file, '.jsonl');
  let firstUserText = null;
  let aiTitle = null;
  let start = null;
  let end = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.sessionId) sessionId = o.sessionId;
    // ai-title 是 Claude 自己生成的标题，优先用它
    if (o.type === 'ai-title' && o.title) aiTitle = o.title;

    const ts = o.timestamp;
    if (ts) {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) {
        if (!start || d < start) start = d;
        if (!end || d > end) end = d;
      }
    }

    const role = o.message && o.message.role;
    if (!role) continue;

    // 这些是 Claude Code 的内部事件，出现在消息流里但不是真对话
    if (o.isSidechain) continue;

    if (o.cwd && !cwd) cwd = o.cwd;

    if (role === 'user' && !firstUserText) {
      const t = extractText(o.message.content);
      if (t && !isNoise(t)) firstUserText = t;
    }
  }

  if (!start && !end) return null;

  return makeSession({
    agent: name,
    id: sessionId,
    project: cwd,
    title: aiTitle || firstUserText,
    start,
    end,
    source: file,
    resume: `claude --resume ${sessionId}`,
  });
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (c && c.type === 'text' && c.text) parts.push(c.text);
  }
  return parts.join('\n').trim();
}

/**
 * 判断一条用户消息是不是噪音。
 *
 * Claude Code 会把斜杠命令、本地命令输出、IDE 上下文当成 user 消息写进
 * 会话。它们会污染标题和摘要，必须在抽取"第一条真实用户输入"时排除。
 */
function isNoise(text) {
  const t = text.trim();
  if (!t) return true;
  const noisePrefixes = [
    '<local-command-caveat>',
    '<local-command-stdout>',
    '<command-name>',
    '<command-message>',
    '<command-args>',
    '<environment_context>',
    '# Context from my IDE setup:',
    '<ide_opened_file>',
  ];
  return noisePrefixes.some((p) => t.startsWith(p));
}

/**
 * 读一场会话的完整正文。
 *
 * 与 parse() 的区别：parse 只扫开头取元数据（快），这里要把整个文件
 * 按时间顺序摊平成消息。tool_result 在 Claude Code 里是 role=user 的
 * 消息，但语义上是工具输出，所以单独归成 tool，不混进用户发言。
 */
export function readMessages(session) {
  const file = assertUnderAny(projectDirs(), session.source);
  const text = fs.readFileSync(file, 'utf8');
  const out = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    // 子代理会话与主线程是两棵树，混进来会让正文读起来像精神分裂
    if (o.isSidechain) continue;

    const msg = o.message;
    if (!msg || !msg.role) continue;

    const parts = [];
    const content = msg.content;
    let noiseOnly = true;

    if (typeof content === 'string') {
      const p = textPart(content);
      if (p) {
        parts.push(p);
        if (!isNoise(content)) noiseOnly = false;
      }
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || !c.type) continue;
        if (c.type === 'text') {
          const p = textPart(c.text);
          if (p) {
            parts.push(p);
            // 一条消息可能整体是斜杠命令的机器输出，别把它算成人说的话
            if (!isNoise(c.text)) noiseOnly = false;
          }
        } else if (c.type === 'thinking') {
          const p = reasoningPart(c.thinking);
          if (p) parts.push(p);
        } else if (c.type === 'tool_use') {
          parts.push(toolPart({ name: c.name, input: c.input, callId: c.id }));
          noiseOnly = false;
        } else if (c.type === 'tool_result') {
          parts.push(
            toolPart({
              name: 'tool_result',
              callId: c.tool_use_id,
              output: flattenToolResult(c.content),
              status: c.is_error ? 'error' : 'completed',
            })
          );
          noiseOnly = false;
        } else if (c.type === 'image') {
          parts.push({ kind: 'text', text: `[图片 ${c.source && c.source.media_type ? c.source.media_type : ''}]` });
          noiseOnly = false;
        }
      }
    }

    if (!parts.length) continue;

    // 只有 tool_result 的用户消息不是用户发言；只有斜杠命令输出的也不是
    const onlyTools = parts.every((p) => p.kind === 'tool');
    const role = onlyTools ? 'tool' : noiseOnly && msg.role !== 'assistant' ? 'system' : msg.role === 'assistant' ? 'assistant' : 'user';
    out.push(
      makeMessage({
        role,
        parts,
        ts: o.timestamp,
        meta: role === 'system' ? { kind: 'cli-noise' } : null,
      })
    );
  }

  return out;
}

/** tool_result 的 content 可以是字符串，也可以是内容数组。 */
function flattenToolResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') parts.push('[图片]');
  }
  return parts.join('\n');
}
