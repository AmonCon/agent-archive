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
  if (t !== r && !t.toLowerCase().startsWith(r.toLowerCase() + path.sep)) {
    throw new Error(`拒绝读取根目录之外的路径: ${target}`);
  }
  return t;
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
