import fs from 'node:fs';
import path from 'node:path';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, assertUnder } from '../messages.js';
import { userDataCandidates, findUnder } from '../platform.js';

/**
 * Kiro 会话扫描。
 *
 * 存储（各平台位置由 platform.userDataCandidates 处理）：
 *   Windows  %APPDATA%/Kiro/User/globalStorage/kiro.kiroagent/
 *   macOS    ~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/
 *   Linux    ~/.config/Kiro/User/globalStorage/kiro.kiroagent/
 *
 *   sessions/sessions.json              全局会话索引
 *   sessions/<id>.json                  单场会话
 *   workspace-sessions/<b64url(路径)>/  按工作区分的会话
 *     └ sessions.json + <id>.json
 *   <hash>/<hash>/<file>                执行包（executor bundles）
 *
 * **最大的坑：会话文件里 assistant 的正文全是占位符 "On it."**。
 * 真正的回复在相邻的执行包里：actions[].output 里的 {"message": "..."}。
 * 会话文件的 history[].executionId 就是去执行包索引里找的钥匙。
 *
 * 工作区目录名是 base64url(工作区绝对路径)，去掉尾部 = 填充。
 * 解出来是 "e:\my-app" 这样的真路径——比 Cursor 的 slug 可靠。
 */

export const name = 'kiro';

const AGENT_REL = 'User/globalStorage/kiro.kiroagent';

function agentRoot() {
  const found = findUnder(userDataCandidates('Kiro'), AGENT_REL);
  if (found) return found;
  return path.join(userDataCandidates('Kiro')[0], 'User', 'globalStorage', 'kiro.kiroagent');
}

export function discover() {
  const root = agentRoot();
  const out = [];

  // 全局会话
  for (const f of listJson(path.join(root, 'sessions'))) out.push(f);

  // 工作区会话
  const wsRoot = path.join(root, 'workspace-sessions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(wsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    for (const f of listJson(path.join(wsRoot, d.name))) out.push(f);
  }
  return out;
}

/** 目录下的 <id>.json，跳过索引文件 sessions.json。只接受普通文件名。 */
function listJson(dir) {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const f of files) {
    // 只收普通文件：符号链接和目录都跳过，避免被指到根目录之外
    if (!f.isFile()) continue;
    if (!f.name.endsWith('.json') || f.name === 'sessions.json') continue;
    out.push(path.join(dir, f.name));
  }
  return out;
}

export function parse(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!data || !data.sessionId) return null;

  const history = Array.isArray(data.history) ? data.history : [];
  if (!history.length) return null;

  let firstUser = null;
  for (const h of history) {
    const msg = h && h.message;
    if (!msg) continue;
    if (msg.role !== 'user') continue;
    const t = extractText(msg.content);
    if (t && !firstUser) firstUser = t;
  }

  // 会话文件里没有可靠的对话时间戳，用文件 mtime 近似
  let start = null;
  let end = null;
  try {
    const st = fs.statSync(file);
    start = st.mtime;
    end = st.mtime;
  } catch {
    return null;
  }

  // 工作区路径：优先用会话里记的，否则从目录名 base64 解
  let project = data.workspaceDirectory || data.workspacePath || null;
  if (!project) {
    project = decodeWorkspaceDir(path.basename(path.dirname(file)));
  }

  return makeSession({
    agent: name,
    id: data.sessionId,
    project,
    title: data.title || firstUser || null,
    start,
    end,
    source: file,
    resume: null,
  });
}

/** "ZTpcc29mdHBpLXNob3A_" → "e:/my-app" */
export function decodeWorkspaceDir(name) {
  if (!name) return null;
  try {
    const b64 = String(name).replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const decoded = Buffer.from(b64 + pad, 'base64').toString('utf8');
    if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith('/')) {
      return decoded.replace(/\\/g, '/');
    }
    return null;
  } catch {
    return null;
  }
}

function extractText(content) {
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

export function readMessages(session) {
  const real = assertUnder(agentRoot(), session.source);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (e) {
    throw new Error(`读不了 Kiro 会话: ${e && e.message ? e.message : e}`);
  }

  const history = Array.isArray(data.history) ? data.history : [];
  const out = [];

  for (const h of history) {
    const msg = h && h.message;
    if (!msg) continue;

    const isUser = msg.role === 'user';
    const body = extractText(msg.content);
    const exec = h.executionId ? loadExecution(h.executionId) : null;
    const parts = [];

    if (body && !isPlaceholder(body)) {
      const p = textPart(body);
      if (p) parts.push(p);
    }

    if (exec) {
      for (const a of exec.actions || []) {
        const actionType = String(a.actionType || '');
        const output = parseMaybeJson(a.output);
        const sayText = output && typeof output.message === 'string' ? output.message : null;

        if ((actionType === 'say' || actionType === 'model') && sayText) {
          const p = textPart(sayText);
          if (p) parts.push(p);
        } else if (
          actionType.startsWith('tooluse_') ||
          actionType === 'readFiles' ||
          actionType === 'grepSearch'
        ) {
          parts.push(
            toolPart({
              name: actionType.replace(/^tooluse_/, ''),
              input: parseMaybeJson(a.input),
              status: a.actionState || null,
            })
          );
        }
      }
    }

    if (!parts.length) continue;
    out.push(makeMessage({ role: isUser ? 'user' : 'assistant', parts }));
  }

  return out;
}

/** 会话文件里的 assistant 正文只是这个占位符，没有信息量。 */
function isPlaceholder(t) {
  return /^on it\.?$/i.test(String(t || '').trim());
}

function parseMaybeJson(s) {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * 在执行包目录里按 executionId 找正文。
 *
 * 布局是 <agentRoot>/<hash>/<hash>/<file>，文件名不是 executionId，
 * 所以只能逐文件打开看。本机只有 6 个执行包，全扫一遍可接受。
 *
 * 每一层都过 assertUnder：目录名来自磁盘，理论上可以是任何东西，
 * 拼接前必须确认还在 agentRoot 之内。
 */
const execCache = new Map();

const SKIP_DIRS = new Set([
  'sessions',
  'workspace-sessions',
  'index',
  'skills',
  'steering',
  'powers',
]);

function loadExecution(executionId) {
  if (execCache.has(executionId)) return execCache.get(executionId);

  const root = agentRoot();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    execCache.set(executionId, null);
    return null;
  }

  for (const d of dirs) {
    if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;

    let sub;
    try {
      sub = assertUnder(root, path.join(root, d.name));
    } catch {
      continue;
    }

    let inner = [];
    try {
      inner = fs.readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const i of inner) {
      if (!i.isDirectory()) continue;

      let dir2;
      try {
        dir2 = assertUnder(root, path.join(sub, i.name));
      } catch {
        continue;
      }

      let files = [];
      try {
        files = fs.readdirSync(dir2, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const f of files) {
        if (!f.isFile() || f.name.endsWith('.json')) continue;

        let full;
        try {
          full = assertUnder(root, path.join(dir2, f.name));
        } catch {
          continue;
        }

        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (j && j.executionId === executionId) {
            execCache.set(executionId, j);
            return j;
          }
        } catch {
          /* 不是 JSON，跳过 */
        }
      }
    }
  }

  execCache.set(executionId, null);
  return null;
}
