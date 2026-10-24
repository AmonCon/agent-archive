import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';

/**
 * Codex 会话扫描。
 *
 * 存储：~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl[.zst]
 *      ~/.codex/archived_sessions/*.jsonl[.zst]
 * 首行 session_meta 的 payload.cwd 给出项目路径。
 * 后续每行是与 timestamp/ordinal/type/payload 的事件；真正对话在
 * response_item 的 payload.type === 'message' 里。
 *
 * .zst 是整文件 zstd 压缩（不是逐帧追加），Node 22+ 自带 zstd 解压。
 * 大文件只解压前若干字节用于取元数据，避免为列个标题解压几百 MB。
 */

export const name = 'codex';

/** 只看开头这么多字节就够拿到 session_meta 和第一条用户消息。 */
const HEAD_BYTES = 256 * 1024;

/**
 * Codex 的数据根候选。
 *
 * `CODEX_HOME` 是官方支持的覆盖（codex-rs 的 home-dir 模块里，
 * 设了就必须存在且是目录，否则 Codex 自己会报错——所以这里
 * 只把**存在的**候选算进去，不要替用户造一个）。
 *
 * 三个平台一致：`~/.codex`。**不要去找 `~/Library/Application Support/Codex`**
 * ——那是 Codex 桌面版存应用状态的地方，rollout 会话仍在 `~/.codex/sessions`。
 */
function codexDirs() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const norm = path.resolve(p);
    if (!out.some((x) => sameNorm(x, norm))) out.push(norm);
  };

  for (const p of envOverrideList('CODEX_HOME')) add(p);
  add(path.join(os.homedir(), '.codex'));

  return out;
}

/** 兼容旧调用点。 */
function codexDir() {
  return codexDirs()[0];
}

export function discover() {
  const all = [];

  for (const root of codexDirs()) {
    for (const sub of ['sessions', 'archived_sessions']) {
      walk(path.join(root, sub), all, 0);
    }
  }

  // 多根时同一文件可能被看到两次（一个根是指向另一个的链接）。
  // 按"文件系统语义下的同一路径"去重，而不是按原字符串——
  // Windows/macOS 上大小写不同但指向同一文件的情况真实存在。
  const out = [];
  const seen = new Set();
  for (const p of all) {
    const key = sameNorm(p, '') ? p : String(p).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function sameNorm(a, b) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const na = String(a).replace(/\\/g, '/');
  const nb = String(b).replace(/\\/g, '/');
  return ci ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 环境变量可能是逗号分隔的多值。 */
function envOverrideList(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === '~' ? os.homedir() : s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s));
}

function walk(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && /\.jsonl(\.zst)?$/.test(e.name)) out.push(full);
  }
}

function readHead(file) {
  let fh;
  try {
    fh = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fh, buf, 0, HEAD_BYTES, 0);
    let data = buf.subarray(0, n);
    if (file.endsWith('.zst')) {
      try {
        data = zlib.zstdDecompressSync(data);
      } catch {
        // 截断的 zstd 帧解不开：退回整文件解压，仍失败就放弃这个文件
        try {
          data = zlib.zstdDecompressSync(fs.readFileSync(file));
        } catch {
          return null;
        }
      }
    }
    return data.toString('utf8');
  } finally {
    fs.closeSync(fh);
  }
}

export function parse(file) {
  const text = readHead(file);
  if (!text) return null;

  let cwd = null;
  let sessionId = null;
  let firstUserText = null;
  let firstAssistantText = null;
  let originator = null;
  let isSubagent = false;
  let start = null;
  let end = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      // 截断的最后一行很正常，忽略
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

    const payload = o.payload;
    if (!payload) continue;

    if (o.type === 'session_meta') {
      cwd = cwd || payload.cwd || null;
      // 用 id 而不是 session_id：子代理（subagent）的 rollout 里，
      // session_id 指向**父会话**，只有 id 是自己的。用 session_id 会把
      // 几十个子代理会话全记成同一条，时间线里重复出现几十次。
      sessionId = sessionId || payload.id || payload.session_id || null;
      originator = originator || payload.originator || null;
      isSubagent = isSubagent || isSubagentSource(payload.source);
      continue;
    }

    // response_item 里的 message 是真对话；event_msg 的 item_completed
    // 是同一内容的另一份记录，用它取标题会重复且更啰嗦
    if (o.type === 'response_item' && payload.type === 'message') {
      // developer 角色装的是注入的系统指令，不是人说的话
      if (payload.role === 'developer') continue;
      if (payload.role === 'user' && !firstUserText) {
        const t = extractText(payload.content);
        if (t && !isNoise(t)) firstUserText = stripBlocks(t);
      } else if (payload.role === 'assistant' && !firstAssistantText) {
        const t = extractText(payload.content);
        if (t) firstAssistantText = t;
      }
    }
  }

  if (!sessionId) {
    // 退化：从文件名 rollout-2025-10-29T23-54-08-<uuid>.jsonl.zst 取 uuid
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = m ? m[1] : path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
  }

  if (!start && !end) return null;

  // 子代理会话（guardian、reviewer 之类）是父会话内部的一步，
  // 不是用户发起的对话。列出来只会让时间线翻倍，所以整条跳过——
  // 与 ZCode 扫描器跳过 parent_id 的处理保持一致。
  if (isSubagent) return null;

  return makeSession({
    agent: name,
    id: sessionId,
    project: cwd,
    // 没有用户输入的会话（自动化、子代理触发）用助手第一句兜底，
    // 再退到触发来源，最后才是占位符
    title: firstUserText || firstAssistantText || (originator ? `(${originator})` : null),
    start,
    end,
    source: file,
    resume: `codex resume ${sessionId}`,
  });
}

/**
 * 判断一份 rollout 是不是子代理会话。
 *
 * Codex 在 session_meta.source 里标出触发者：
 *   { subagent: { other: 'guardian' } }  子代理
 *   { vscode: {} } / 'cli' / 'exec'      用户直接发起
 * 后者的形状不统一（对象或字符串都有），所以只认"确实带 subagent 键"这一种。
 */
function isSubagentSource(source) {
  if (!source) return false;
  if (typeof source === 'string') return source.toLowerCase() === 'subagent';
  if (typeof source === 'object') return Object.prototype.hasOwnProperty.call(source, 'subagent');
  return false;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (typeof c.text === 'string') parts.push(c.text);
    else if (typeof c.content === 'string') parts.push(c.content);
  }
  return parts.join('\n').trim();
}

/**
 * Codex 会在用户消息前面塞环境上下文、IDE 状态和 AGENTS.md 指令块，
 * 这些不是用户说的话。一条消息可能整体就是这些块，也可能是"块 + 用户
 * 正文"，所以按块切割、只丢块内的内容，而不是整条消息丢弃。
 */
function isNoise(text) {
  const cleaned = stripBlocks(text);
  return cleaned.trim().length === 0;
}

export function stripBlocks(text) {
  let out = text;

  // 先处理"没有闭合标签的注入块"：Codex 的 <app-context> 会嵌套
  // <recommended_plugins> 而不闭合外层，实测一条 4.4 万字的消息整条都是
  // 这种内容，成对标签规则匹配不到，后面就漏了。
  //
  // 判据是"开标签之前几乎没有内容"——那种情况下整条都是注入。
  // 必须先做，因为下一步会把标签本身也删掉，那时就找不到边界了。
  const unclosed = out.match(/<([a-z][\w-]*)(?:\s[^>]*)?>/i);
  if (unclosed && !KEEP_TAGS.has(String(unclosed[1]).toLowerCase())) {
    const before = out.slice(0, unclosed.index).trim();
    if (before.length < 40) out = before;
  }

  // Codex 把项目指令以 "# AGENTS.md instructions for <路径>" 开头注入，正文包在
  // <INSTRUCTIONS> 里。整段是给模型的说明，不是用户提问。先按成对标签剥掉。
  out = out.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, '');
  // 没有闭合标签时（旧版本），从标题行剥到下一个空行后的非空段落
  out = out.replace(/# AGENTS\.md instructions for [^\n]*\s*<INSTRUCTIONS>[\s\S]*?(?=\n\n|$)/gi, '');
  // 标题行本身没有路径时也要剥（实测有会话标题就是这一行）
  out = out.replace(/^#+\s*AGENTS\.md instructions\b[^\n]*/gim, '');

  // 其余注入块统一处理，而不是逐个列标签名。
  //
  // 实测本机 904 场会话里有 273 场的标题是这类标签：<recommended_plugins>（193）、
  // <external_codex_apps_open_page>（47）、<command-name>（23）、
  // <in-app-browser-context>、<turn_aborted>……Codex 每加一个功能就多一种标签，
  // 硬编码名单永远追不上。所以按形状剥：自闭合标签、成对标签，整段去掉。
  out = out.replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, (m, tag) =>
    KEEP_TAGS.has(String(tag).toLowerCase()) ? m : ''
  );
  // 自闭合 / 无闭合标签的行（<turn_aborted> 之类）
  out = out.replace(/<([a-z][\w-]*)(?:\s[^>]*)?\/?>/gi, (m, tag) =>
    KEEP_TAGS.has(String(tag).toLowerCase()) ? m : ''
  );

  // "# Context from my IDE setup:" 段落
  out = out.replace(/# Context from my IDE setup:[\s\S]*?(?=\n\s*\n[A-Z\u4e00-\u9fa5]|$)/i, '');

  return out.trim();
}

/**
 * 需要原样保留的标签。
 *
 * 用户自己会在消息里写代码片段和少量标记，这些不能当注入剥掉。
 * 目前只保留最常出现在代码讨论里的几个——宁可漏剥一个注入块，
 * 也不能把用户真正说的话删掉。
 */
const KEEP_TAGS = new Set(['code', 'pre', 'b', 'i', 'em', 'strong', 'br', 'p', 'a', 'span', 'div']);

/**
 * 读一场会话的完整正文。
 *
 * Codex 的正文全在 response_item 里，三类事件拼成一场对话：
 *   message            文本（user / assistant）
 *   reasoning          推理摘要（只给 summary，不给完整思维链）
 *   function_call      工具调用，与后面的 function_call_output 用 call_id 配对
 *
 * 会话几乎都是 .zst 整文件压缩，没法只读头部，只能整体解压。
 * 一个 157 KB 的会话解开约 80 行，成本可以接受；解不开就抛错，不假装成功。
 */
export function readMessages(session) {
  // 续接会话的 source 是多段路径（"a.jsonl.zst|b.jsonl"），
  // 按顺序把每一段的正文读出来再拼起来，才是完整的一场对话。
  const parts = String(session.source).split('|').filter(Boolean);
  const out = [];
  for (const src of parts) {
    const real = assertUnder(codexDir(), src);
    let text;
    if (real.endsWith('.zst')) {
      text = zlib.zstdDecompressSync(fs.readFileSync(real)).toString('utf8');
    } else {
      text = fs.readFileSync(real, 'utf8');
    }
    out.push(...parseRollout(text));
  }
  return out;
}

/** 解析一份 rollout 的正文，返回统一消息数组。 */
function parseRollout(text) {
  const out = [];
  const calls = new Map();
  // 工具输出记在旁路表里，遍历结束再回填——output 通常出现在 call 之后，
  // 边走边配会全部配空。
  const outputs = new Map();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.type !== 'response_item') continue;
    const p = o.payload;
    if (!p || !p.type) continue;

    if (p.type === 'message') {
      const t = extractText(p.content);
      if (!t) continue;

      // Codex 用 developer 角色承载注入的系统指令（桌面端上下文、
      // 推荐插件清单之类），它们不是对话。整条剥一遍，剥空了就丢掉。
      // user 消息里同样会夹带这些块，所以两者都要过 stripBlocks。
      const isDeveloper = p.role === 'developer';
      const cleaned = p.role === 'assistant' ? t : stripBlocks(t);
      const part = textPart(cleaned);
      if (!part) continue;

      out.push(
        makeMessage({
          role: isDeveloper ? 'system' : p.role === 'assistant' ? 'assistant' : 'user',
          parts: [part],
          ts: o.timestamp,
          meta: isDeveloper ? { kind: 'developer' } : null,
        })
      );
    } else if (p.type === 'reasoning') {
      const sums = Array.isArray(p.summary) ? p.summary : [];
      const t = sums
        .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
        .filter(Boolean)
        .join('\n\n');
      const part = reasoningPart(t);
      if (!part) continue;
      out.push(makeMessage({ role: 'system', parts: [part], ts: o.timestamp, meta: { channel: 'reasoning' } }));
    } else if (p.type === 'function_call') {
      const part = toolPart({
        name: p.name,
        input: parseArgs(p.arguments),
        callId: p.call_id,
      });
      calls.set(p.call_id, part);
      out.push(makeMessage({ role: 'assistant', parts: [part], ts: o.timestamp }));
    } else if (p.type === 'function_call_output') {
      outputs.set(p.call_id, unwrapOutput(p.output));
    }
  }

  // 回填输出
  for (const [callId, part] of calls) {
    if (outputs.has(callId)) {
      part.output = outputs.get(callId);
      part.status = 'completed';
    }
  }

  // 配不上调用的孤立输出也要露出来，否则会静默丢内容
  for (const [callId, output] of outputs) {
    if (calls.has(callId)) continue;
    out.push(
      makeMessage({
        role: 'tool',
        parts: [toolPart({ name: 'function_call_output', callId, output, status: 'completed' })],
      })
    );
  }

  return out;
}

/** function_call 的 arguments 是一段 JSON 字符串，解析失败就原样留着。 */
function parseArgs(s) {
  if (typeof s !== 'string') return s === undefined ? null : s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * function_call_output 的 output 通常是包了一层的 JSON：
 *   {"output":"...","metadata":{"exit_code":1,...}}
 * 真正的命令行输出在 output 字段里。原样打印会把转义符和元数据一起倒出来，
 * 所以能拆就拆，拆不动就当纯文本。
 */
function unwrapOutput(raw) {
  if (typeof raw !== 'string') return raw == null ? '' : JSON.stringify(raw);
  if (!raw.startsWith('{')) return raw;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return raw;
    const body = typeof o.output === 'string' ? o.output : raw;
    const code = o.metadata && typeof o.metadata.exit_code === 'number' ? o.metadata.exit_code : null;
    return code && code !== 0 ? `${body}\n[exit ${code}]` : body;
  } catch {
    return raw;
  }
}
