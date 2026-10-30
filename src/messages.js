import path from 'node:path';
import fs from 'node:fs';

/**
 * 统一消息模型与「读正文」所需的小工具。
 *
 * scanner 的 readMessages() 返回这个形状的消息数组：
 *   { role, parts, ts, meta }
 *
 * parts 是有序的片段，因为一场对话里"说了什么"和"干了什么"是交织的：
 *   文本、工具调用、工具结果必须保持原顺序，否则读起来会错位。
 *
 * role 只保留四种值：
 *   user / assistant / tool / system
 * tool 是工具结果单独成条，因为它是"运行"产生的，不是谁说的话。
 */

/** 造一条消息。parts 里的空片段会被丢掉。 */
export function makeMessage({ role, parts, ts, meta }) {
  return {
    role,
    parts: (parts || []).filter(Boolean),
    ts: toDate(ts),
    meta: meta || null,
  };
}

export function textPart(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return null;
  return { kind: 'text', text: t };
}

/**
 * 工具调用与（可选的）其结果。
 * input 保留原对象，展示层自己决定怎么折叠成一行。
 */
export function toolPart({ name, input, callId, output, status }) {
  return {
    kind: 'tool',
    name: name || 'unknown',
    input: input === undefined ? null : input,
    callId: callId || null,
    output: typeof output === 'string' ? output : null,
    status: status || null,
  };
}

export function reasoningPart(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return null;
  return { kind: 'reasoning', text: t };
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v > 1e11 ? v : v * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 文档越界校验。
 *
 * 会话正文是按缓存里记的 source 路径去读的，这个路径来自磁盘上的
 * Agent 存储。如果只信它，一份被改过的缓存就能让本工具读任意文件。
 * 所以每次读之前都要求路径落在该 Agent 自己的根目录之下——与 CC Switch
 * 的 resolve_under_roots 同一个思路。
 *
 * 返回规范化后的绝对路径；不合法就抛错，不做"尽力而为"。
 */
export function assertUnder(root, target) {
  const r = realpathLoose(root);
  const t = realpathLoose(target);
  if (!r || !t) throw new Error(`路径不可访问: ${target}`);

  // 大小写敏感性跟随文件系统：Windows/macOS 默认不敏感，Linux 敏感。
  // 在 Linux 上忽略大小写会让 /a/Foo 通过 /a/foo 的校验，那是个真实的绕过口子。
  const fold = process.platform === 'win32' || process.platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
  const rr = fold(r);
  const tt = fold(t);

  if (tt !== rr && !tt.startsWith(rr + path.sep)) {
    throw new Error(`拒绝读取根目录之外的路径: ${target}`);
  }
  return t;
}

/**
 * 越界校验：路径必须落在**任意一个**给定根目录之下。
 *
 * 为什么需要复数版本：一个 Agent 可能有多个数据根——
 * CLAUDE_CONFIG_DIR 指到外置盘、~/.config/claude 的历史遗留、
 * macOS 上 ~/.cache/.gemini 这类运行时改道。只要 source 是从其中
 * 一个根发现的，读它就是合法的。
 *
 * 语义与 assertUnder 完全一致，只是把"一个根"换成"一组根"：
 * 全部校验不过才抛错。
 */
export function assertUnderAny(roots, target) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  if (!list.length) throw new Error('没有可用的根目录');

  let last;
  for (const r of list) {
    try {
      return assertUnder(r, target);
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error(`拒绝读取根目录之外的路径: ${target}`);
}

/**
 * 尽量取真实路径。文件可能刚被删掉，但父目录通常还在，
 * 所以退一步解析父目录再拼回文件名，一样能挡住 ../ 逃逸。
 */
function realpathLoose(p) {
  if (!p) return null;
  const abs = path.resolve(p);
  try {
    return path.resolve(realpath(abs));
  } catch {
    try {
      return path.join(path.resolve(realpath(path.dirname(abs))), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function realpath(p) {
  return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/**
 * 把工具入参压成一行摘要。
 *
 * CLI、MCP、摘要、导出、网页、索引都要展示"这个工具调用在干什么"，
 * 各写一份迟早会漂移（已经漂移过）。这里收成唯一实现，调用方只决定
 * 截断长度和"没有可读字段时"的退路。
 *
 * 认的形状：
 *   - 字符串：压成一行后按 limit 截断
 *   - Codex 的 shell 调用 {command:["powershell.exe","-NoProfile",...]}：
 *     整串数组没信息量，从后往前找真正的命令
 *   - 常见键：command/description/file_path/path/pattern/query/prompt/skill
 *   - 其余对象：JSON 压成一行按 jsonLimit 截断；fallback:'none' 时返回空，
 *     避免把结构噪音写进提示词或索引
 */
export function summarizeInput(input, { limit = 90, fallback = 'json', jsonLimit = 80 } = {}) {
  if (input == null) return '';
  if (typeof input === 'string') return clipOneLine(input, limit);
  if (typeof input !== 'object') return String(input);

  if (Array.isArray(input.command)) {
    const cmd = input.command;
    const takesArg = (s) => typeof s === 'string' && /^-(NoProfile|Command|c|EncodedCommand)$/i.test(s);
    for (let i = cmd.length - 1; i >= 0; i--) {
      if (typeof cmd[i] === 'string' && cmd[i].length > 3 && !takesArg(cmd[i])) {
        return clipOneLine(cmd[i], limit);
      }
    }
    return clipOneLine(cmd.join(' '), limit);
  }

  for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'prompt', 'skill']) {
    if (typeof input[k] === 'string' && input[k]) return clipOneLine(input[k], limit);
  }

  if (fallback === 'none') return '';
  try {
    return clipOneLine(JSON.stringify(input), jsonLimit);
  } catch {
    // 循环引用等无法序列化的入参，宁可不展示也不抛错
    return '';
  }
}

function clipOneLine(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
