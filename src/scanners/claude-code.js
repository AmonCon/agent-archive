import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession, projectKey } from '../model.js';
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
  // 以下只用于扫描器内部判断"谁是原、谁是复制/分叉"，postProcess 用完即弃，
  // 不进最终会话模型的约定字段（见 tmp 的说明）。
  let firstUuid = null;
  let leafUuid = null;
  let msgCount = 0;
  const summaryUuids = [];

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

    // compaction summary：不参与时间/标题，但复制过的会话会共享它的 uuid，
    // 分叉点在压缩之后时，首条消息 uuid 可能不同，靠它才能认出来
    if (o.type === 'summary') {
      if (o.uuid) summaryUuids.push(o.uuid);
      if (o.leafUuid) summaryUuids.push(o.leafUuid);
      continue;
    }

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

    // 主线程的消息 uuid：首条是所有复制/分叉共享的根，末条用于区分
    // "内容完全一样（复制）"和"之后还有新内容（分叉）"
    if (o.uuid) {
      if (!firstUuid) firstUuid = o.uuid;
      leafUuid = o.uuid;
      msgCount++;
    }

    if (o.cwd && !cwd) cwd = o.cwd;

    if (role === 'user' && !firstUserText) {
      const t = extractText(o.message.content);
      if (t && !isNoise(t)) firstUserText = t;
    }
  }

  if (!start && !end) return null;

  const session = makeSession({
    agent: name,
    id: sessionId,
    project: cwd,
    title: aiTitle || firstUserText,
    start,
    end,
    source: file,
    resume: `claude --resume ${sessionId}`,
  });
  // 临时字段：跟着扫描缓存走（parse 结果会被序列化存盘），供 postProcess
  // 在跨文件聚组时使用。postProcess 负责删掉，不进入最终模型。
  session.tmp = { firstUuid, leafUuid, summaryUuids, msgCount };
  return session;
}

/**
 * 识别同一 Claude 项目下的复制 / 分叉会话。
 *
 * `--fork-session` 与 `/branch` 会把整段历史复制进一个新的 session 文件，
 * 于是同一段对话在磁盘上有多个 .jsonl。按文件逐个 parse 时它们看起来是
 * 几场独立会话，列表会虚高。
 *
 * 判定（与 magpie 的 cc_copies.go 同一思路，规则从简）：
 *   - 先按「首条消息 uuid」+「compaction summary uuid」聚组，同一组是共享
 *     历史的文件；
 *   - 组内 start 最早的是原会话；start 相同按文件路径字典序（不猜 mtime）；
 *   - 与原会话 leafUuid 相同 → 完全复制，记 copyOf；
 *     不同 → 之后还有新内容，是分叉，记 branchOf。
 *
 * 复制品由 mainOnly 过滤掉；分叉保留在时间线里，只是带上来源标记。
 * 没有任何证据（老缓存没有 tmp）的会话一律不动，避免把历史会话误判成复制品。
 */
export function postProcess(sessions) {
  const entries = [];
  for (const s of sessions) {
    if (s.agent !== name) continue;
    const t = s.tmp;
    delete s.tmp;
    if (!t || !t.firstUuid) continue;
    entries.push({ s, t });
  }
  if (entries.length < 2) return sessions;

  // 并查集：共享任一历史 uuid 的文件归为同一条历史
  const parentOf = new Map();
  for (const e of entries) parentOf.set(e.s, e.s);
  const find = (x) => {
    let r = x;
    while (parentOf.get(r) !== r) r = parentOf.get(r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parentOf.set(ra, rb);
  };

  const firstOwner = new Map();
  for (const e of entries) {
    const pk = projectKey(e.s.project) || '';
    for (const u of [e.t.firstUuid, ...(e.t.summaryUuids || [])]) {
      if (!u) continue;
      const k = `${pk}|${u}`;
      const prev = firstOwner.get(k);
      if (prev) union(prev, e.s);
      else firstOwner.set(k, e.s);
    }
  }

  const groups = new Map();
  for (const e of entries) {
    const root = find(e.s);
    const list = groups.get(root);
    if (list) list.push(e);
    else groups.set(root, [e]);
  }

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(compareOriginal);
    const orig = list[0];
    for (const e of list.slice(1)) {
      const sameLeaf = !!e.t.leafUuid && e.t.leafUuid === orig.t.leafUuid;
      if (sameLeaf) e.s.copyOf = orig.s.id;
      else e.s.branchOf = orig.s.id;
    }
  }
  return sessions;
}

/** 原会话排序：start 早的在前；start 相同按文件路径字典序。 */
function compareOriginal(a, b) {
  const ta = a.s.start ? new Date(a.s.start).getTime() : Infinity;
  const tb = b.s.start ? new Date(b.s.start).getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  const sa = String(a.s.source || '');
  const sb = String(b.s.source || '');
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ia = String(a.s.id);
  const ib = String(b.s.id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
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
