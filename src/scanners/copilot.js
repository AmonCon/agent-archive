import fs from 'node:fs';
import path from 'node:path';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, assertUnder } from '../messages.js';
import { userDataCandidates, findUnder } from '../platform.js';

/**
 * GitHub Copilot Chat 会话扫描。
 *
 * 存储（VS Code 的用户数据目录，各平台不同）：
 *   Windows  %APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/*.json
 *   macOS    ~/Library/Application Support/Code/User/workspaceStorage/...
 *   Linux    ~/.config/Code/User/workspaceStorage/...
 *
 * 会话按工作区目录散放，每个 workspaceStorage/<hash>/ 对应一个工作区，
 * 路径写在同级的 workspace.json 的 folder 字段（file:///e%3A/my-app）。
 *
 * 两个必须处理的坑：
 *
 *   1. **大量空会话**。本机 16 个文件里只有 2 个有内容（22 轮 + 1 轮），
 *      其余 requests 是空数组。文件存在不代表有对话。
 *
 *   2. **.jsonl 是增量格式**：首行 {"kind":0,"v":"<完整JSON字符串>"}，
 *      后续行是补丁。多数是空的，解出来 requests 也是 []。这里统一
 *      按两种格式都试一遍，取有内容的。
 *
 * 没有显式的 role 字段：用户正文 = requests[].message.text，
 * 助手正文 = requests[].response[] 里 kind 缺省或 text/plain 的 value。
 */

export const name = 'copilot';

const WS_REL = 'User/workspaceStorage';

function workspaceRoot() {
  const found = findUnder(userDataCandidates('Code'), WS_REL);
  if (found) return found;
  return path.join(userDataCandidates('Code')[0], 'User', 'workspaceStorage');
}

export function discover() {
  const root = workspaceRoot();
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }

  for (const d of dirs) {
    const sessionsDir = path.join(root, d.name, 'chatSessions');
    let files = [];
    try {
      files = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!/\.jsonl?$/.test(f.name)) continue;
      out.push(path.join(sessionsDir, f.name));
    }
  }
  return out;
}

/**
 * 解析一个会话文件。
 *
 * .json 就是结构本身；.jsonl 首行是完整快照，后面是增量补丁。
 * 补丁只是字段覆盖，对读正文没有帮助，所以只取首行快照。
 */
function loadSession(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  if (file.endsWith('.jsonl')) {
    const first = raw.split('\n').find((l) => l.trim());
    if (!first) return null;
    try {
      const o = JSON.parse(first);
      if (o && typeof o.v === 'string') {
        try {
          return JSON.parse(o.v);
        } catch {
          return null;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 同级 workspace.json 给出这个工作区的目录。 */
function workspaceFolder(file) {
  // <root>/<hash>/chatSessions/<file> → <root>/<hash>/workspace.json
  const hashDir = path.dirname(path.dirname(file));
  try {
    const wj = JSON.parse(fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf8'));
    const folder = wj && wj.folder;
    if (typeof folder !== 'string') return null;
    return uriToPath(folder);
  } catch {
    return null;
  }
}

function uriToPath(uri) {
  const s = String(uri || '');
  if (!s.startsWith('file:')) {
    // Cursor/Code 有时直接写绝对路径
    return /^[a-zA-Z]:[\\/]/.test(s) ? s.replace(/\\/g, '/') : null;
  }
  let p = s.slice(5).replace(/^\/+/, '');
  // file://%3F/e%3A/... 这种多一段编码的，先解码再剥前缀
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  p = p.replace(/\\/g, '/').replace(/^\?\/?/, '');
  const m = p.match(/^([a-zA-Z]):\/?(.*)$/);
  if (m) return `${m[1].toLowerCase()}:/${m[2]}`;
  return null;
}

export function parse(file) {
  const data = loadSession(file);
  if (!data) return null;

  const requests = Array.isArray(data.requests) ? data.requests : [];
  // 空会话不列：本机 16 个文件里 14 个是这种
  if (!requests.length) return null;

  const times = [];
  let firstUser = null;
  let firstAssistant = null;

  for (const r of requests) {
    const ts = r.timestamp || (r.result && r.result.timings && r.result.timings.totalElapsed);
    if (typeof r.timestamp === 'number') times.push(r.timestamp);

    const u = r.message && r.message.text;
    if (u && !firstUser) firstUser = String(u).trim();

    if (!firstAssistant && Array.isArray(r.response)) {
      const t = r.response
        .filter((x) => x && (!x.kind || x.kind === 'text/plain'))
        .map((x) => x.value || '')
        .join('\n')
        .trim();
      if (t) firstAssistant = t;
    }
  }

  const created = Number(data.creationDate) || (times.length ? Math.min(...times) : null);
  const last = Number(data.lastMessageDate) || (times.length ? Math.max(...times) : null);

  if (!created && !last) {
    // 连时间都没有的，用文件 mtime 兜底
    try {
      const st = fs.statSync(file);
      return makeSession({
        agent: name,
        id: sessionId(file, data),
        project: workspaceFolder(file),
        title: firstUser || firstAssistant || data.customTitle,
        start: st.mtime,
        end: st.mtime,
        source: file,
        resume: null,
      });
    } catch {
      return null;
    }
  }

  return makeSession({
    agent: name,
    id: sessionId(file, data),
    project: workspaceFolder(file),
    title: firstUser || firstAssistant || data.customTitle,
    start: created,
    end: last || created,
    source: file,
    resume: null,
  });
}

function sessionId(file, data) {
  return data.sessionId || path.basename(file).replace(/\.jsonl?$/, '');
}

/**
 * 读一场会话的正文。
 *
 * 一轮 = 一条用户消息 + 一条助手消息。工具调用记在
 * result.metadata.toolCallResults 里，但结构松散，这里只取正文，
 * 免得把不确定的结构硬塞进统一模型。
 */
export function readMessages(session) {
  const root = workspaceRoot();
  const real = assertUnder(root, session.source);
  const data = loadSession(real);
  if (!data) throw new Error('读不了 Copilot 会话');

  const requests = Array.isArray(data.requests) ? data.requests : [];
  const out = [];

  for (const r of requests) {
    const ts = typeof r.timestamp === 'number' ? new Date(r.timestamp) : null;

    const userText = r.message && r.message.text;
    if (userText && String(userText).trim()) {
      const p = textPart(String(userText).trim());
      if (p) out.push(makeMessage({ role: 'user', parts: [p], ts }));
    }

    if (!Array.isArray(r.response)) continue;

    const parts = [];
    for (const x of r.response) {
      if (!x) continue;
      const kind = x.kind || 'text/plain';
      if (kind === 'text/plain' || kind === 'text') {
        const p = textPart(x.value);
        if (p) parts.push(p);
      } else if (kind === 'codeblockUri') {
        // 改动的文件引用，压成一行工具调用，保留"动了哪个文件"这个信息
        const uris = Array.isArray(x.uris) ? x.uris : [];
        for (const u of uris) {
          const p = uriToPath(u.uri || u);
          if (p) parts.push(toolPart({ name: 'edit', input: { file_path: p } }));
        }
      }
    }

    if (parts.length) out.push(makeMessage({ role: 'assistant', parts, ts }));
  }

  return out;
}
