import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnderAny } from '../messages.js';
import { envOverrides } from '../platform.js';
import { isDirEntry, isFileEntry } from '../fsentry.js';

/**
 * DeepSeek Harness（dsh）会话扫描。
 *
 * 存储：`$DSH_HOME/sessions/<cwd 转义>/<session 目录>/session.v<N>.jsonl[.zstd]`
 *
 * 三个容易踩的点：
 *
 *   1. 数据根不一定是 `~/.dsh`。Windows 桌面版默认把 DSH_HOME 指到
 *      `~/DeepSeekHarness`，所以环境变量优先，再依次试几个默认位置。
 *   2. 文件默认 zstd 压缩，而且是**多帧追加**——每批事件单独一帧，
 *      不是一个大帧。Node 的 zstdDecompressSync 只解第一帧，直接读
 *      会得到一行 header 就没了。这里按帧魔数切开逐帧解。
 *   3. 子代理会话也是一个 session 文件（header 带 parentSession），
 *      它们是父会话内部的一步。和 Codex 的子代理一样跳过，否则同一场
 *      对话会在时间线里出现好几次。
 *
 * 事件格式（每行 {type, seq, time, data}）：
 *   user/message       真人输入；data.source.kind === "user" 才是人打的
 *   assistant/message  完整回复；流式的 *-chunks 事件是它的增量，必须忽略
 *   tool/call / tool/result  工具调用与结果，按 callId 配对
 *   session/title      dsh 自己生成的标题，优先用
 * 其余是运行时记录（system/message、request/*、job/*、todo/*…），不是对话。
 */

export const name = 'dsh';

/** zstd 帧魔数。多帧文件里每帧都以它开头。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** session.jsonl / session.v4.jsonl / session.v4.jsonl.zstd */
const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * dsh 的数据根（只保留真的有 sessions 目录的）。
 *
 * DSH_HOME 是官方覆盖；`~/.dsh` 是 CLI 默认；`~/DeepSeekHarness` 是
 * Windows 桌面版的默认数据目录；后两个是 macOS/Linux 桌面版的常见位置。
 */
function dshDirs() {
  const home = os.homedir();
  const roots = [
    ...envOverrides(['DSH_HOME']),
    path.join(home, '.dsh'),
    path.join(home, 'DeepSeekHarness'),
    path.join(home, 'Library', 'Application Support', 'DeepSeekHarness'),
    path.join(home, '.config', 'deepseek-harness'),
  ];
  const out = [];
  for (const r of roots) {
    if (isDir(path.join(r, 'sessions')) && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * 解压多帧 zstd。
 *
 * 按魔数切分，逐段尝试解压；如果这一段失败（魔数恰好出现在压缩数据里），
 * 就把它并到下一段再试。zstd 帧之间没有 padding，所以切分点就是魔数位置。
 * 找不到魔数时按未压缩处理，让纯 .jsonl 走同一条路径。
 */
export function decompressFrames(buf) {
  const starts = [];
  let i = 0;
  while (true) {
    const p = buf.indexOf(ZSTD_MAGIC, i);
    if (p === -1) break;
    starts.push(p);
    i = p + 4;
  }
  if (!starts.length) return buf;
  if (starts[0] !== 0) starts.unshift(0);

  const chunks = [];
  let k = 0;
  while (k < starts.length) {
    let j = k + 1;
    let done = null;
    while (j <= starts.length) {
      const end = j < starts.length ? starts[j] : buf.length;
      try {
        done = zlib.zstdDecompressSync(buf.subarray(starts[k], end));
        k = j;
        break;
      } catch {
        j++;
      }
    }
    if (done === null) break; // 尾部残缺，保留已解出的部分
    chunks.push(done);
  }
  return Buffer.concat(chunks);
}

function readLines(file) {
  const raw = fs.readFileSync(file);
  const buf = file.endsWith('.zstd') ? decompressFrames(raw) : raw;
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim());
}

/**
 * 一个 session 目录只取一个文件：版本号最大的；同版本取 mtime 最新的。
 * 旧版本文件在会话被升级后不会删除，全读会让同一场对话重复。
 */
function pickSessionFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best = null;
  for (const e of entries) {
    const efull = path.join(dir, e.name);
    if (!isFileEntry(e, efull)) continue;
    const m = e.name.match(SESSION_FILE);
    if (!m) continue;
    const version = m[1] ? Number(m[1]) : 0;
    const full = efull;
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const score = [version, mtime, m[2] ? 1 : 0];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
      best = { file: full, score };
    }
  }
  return best ? best.file : null;
}

export function discover() {
  const out = [];
  for (const root of dshDirs()) {
    const sessions = path.join(root, 'sessions');
    let workspaces;
    try {
      workspaces = fs.readdirSync(sessions, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const w of workspaces) {
      const wd = path.join(sessions, w.name);
      if (!isDirEntry(w, wd)) continue;
      let sessionDirs;
      try {
        sessionDirs = fs.readdirSync(wd, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessionDirs) {
        const sd = path.join(wd, s.name);
        if (!isDirEntry(s, sd)) continue;
        const file = pickSessionFile(sd);
        if (file) out.push(file);
      }
    }
  }
  return out;
}

export function parse(file) {
  let lines;
  try {
    lines = readLines(file);
  } catch {
    return null;
  }
  if (!lines.length) return null;

  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!header || header.type !== 'session') return null;

  // 子代理会话（header.parentSession 非空）以前整条 return null。现在照常
  // 采集并标记归属：子代理会话里记着实际干的活，丢掉只存一半事实；
  // 时间线默认按 kind === 'main' 过滤，列表不会因此翻倍。

  let start = toDate(header.createdAt);
  let end = null;
  let title = null;
  let firstUser = null;

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    const d = toDate(o.time);
    if (d) {
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }

    if (o.type === 'session/title' && o.data && o.data.title) title = o.data.title;

    if (o.type === 'user/message' && !firstUser) {
      // source.kind 缺失时按真人处理（早期版本没有这个字段）；
      // 标题生成、工具注入等内部消息的 kind 是别的值。
      const kind = o.data && o.data.source && o.data.source.kind;
      if (!kind || kind === 'user') {
        const t = contentText(o.data && o.data.content);
        if (t) firstUser = t;
      }
    }
  }

  const id = header.id || path.basename(path.dirname(file));
  return makeSession({
    agent: name,
    id,
    project: header.cwd,
    title: title || firstUser,
    // fork 出来的会话以原会话的事件开头，header.createdAt 是 fork 时间；
    // 取事件时间包络，start 才是这场对话真正开始的时候。
    start: start || end,
    end: end || start,
    source: file,
    resume: null,
    kind: header.parentSession ? 'subagent' : 'main',
    parent: header.parentSession || null,
  });
}

export function readMessages(session) {
  const roots = dshDirs().map((d) => path.join(d, 'sessions'));
  if (!roots.length) throw new Error('没有找到 DeepSeek Harness 数据目录');

  const file = assertUnderAny(roots, session.source);
  const lines = readLines(file);
  const out = [];
  const pending = new Map();

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = o.time;

    if (o.type === 'user/message') {
      const kind = o.data && o.data.source && o.data.source.kind;
      if (kind && kind !== 'user') continue;
      const p = textPart(contentText(o.data && o.data.content));
      if (p) out.push(makeMessage({ role: 'user', parts: [p], ts }));
      continue;
    }

    if (o.type === 'assistant/message') {
      const parts = contentParts(o.data && o.data.message && o.data.message.content, pending);
      if (parts.length) out.push(makeMessage({ role: 'assistant', parts, ts }));
      continue;
    }

    if (o.type === 'tool/call') {
      const data = o.data || {};
      pending.set(data.callId, { name: data.name, input: parseArgs(data.arguments) });
      continue;
    }

    if (o.type === 'tool/result') {
      const data = o.data || {};
      const callId = data.toolCallId || (data.message && data.message.source && data.message.source.callId);
      const call = pending.get(callId) || {};
      out.push(
        makeMessage({
          role: 'tool',
          parts: [
            toolPart({
              name: call.name,
              input: call.input,
              callId,
              output: contentText(data.content),
            }),
          ],
          ts,
        })
      );
    }
    // 其余是流式增量（*-chunks）、请求头、系统通知、任务登记等运行时事件。
    // 它们在 assistant/message 里已经有完整内容，读进来只会重复。
  }

  return out;
}

function contentParts(content, pending) {
  const arr = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  const parts = [];
  for (const p of arr) {
    if (!p || !p.type) continue;
    if (p.type === 'text') {
      const part = textPart(p.text);
      if (part) parts.push(part);
    } else if (p.type === 'reasoning' || p.type === 'thinking') {
      const part = reasoningPart(p.text || p.thinking);
      if (part) parts.push(part);
    } else if (p.type === 'tool_use' || p.type === 'tool_call' || p.type === 'tool-call') {
      parts.push(toolPart({ name: p.name, input: p.input, callId: p.id }));
      pending.set(p.id, { name: p.name, input: p.input });
    }
  }
  return parts;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** dsh 的 tool/call 把参数存成 JSON 字符串；解析失败就保留原文。 */
function parseArgs(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
