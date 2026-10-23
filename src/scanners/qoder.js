import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';

/**
 * Qoder 会话扫描。
 *
 * 存储（按应用变体分多个目录）：
 *   ~/.qoder/cache/projects/<项目名>-<hash>/conversation-history/<id>/<id>.jsonl
 *   ~/.qoder-cn/cache/projects/…      国际版 / 中国版是两套独立安装
 *   macOS 上还可能在 ~/Library/Application Support/ 下的 Qoder 变体目录
 *
 * **实测教训**：本机同时装了 `.qoder` 和 `.qoder-cn`，前者 7 场、
 * 后者 12 场。只读 `.qoder` 会漏掉一半。所以这里遍历所有变体目录。
 *
 * 格式极简：一行一个 {role, message:{content:[{type,text}]}}。
 * 与 Claude Code 相似，但**没有时间戳、没有 cwd**——这是它最大的短板：
 *
 *   - 时间：只能用文件 mtime 近似（精确到文件最后修改，不是对话时间）
 *   - 项目：只能从目录名反推（"my-app-5e450c46" → "my-app"）
 *
 * 这两点都会在结果里如实标出，不做"猜一个看起来合理的值"那种事。
 * 好在 Qoder 的项目目录名带的是项目名而非转义路径，反推结果可读。
 */

export const name = 'qoder';

/** 所有可能的 Qoder 数据根目录（已存在的）。 */
function cacheRoots() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.qoder', 'cache', 'projects'),
    path.join(home, '.qoder-cn', 'cache', 'projects'),
    path.join(home, 'Library', 'Application Support', 'Qoder', 'cache', 'projects'),
    path.join(home, 'Library', 'Application Support', 'QoderCN', 'cache', 'projects'),
    path.join(home, 'Library', 'Application Support', 'Qoder CN', 'cache', 'projects'),
    path.join(home, 'Library', 'Application Support', 'QoderWork', 'cache', 'projects'),
    path.join(home, 'Library', 'Application Support', 'com.qoder.app.stable', 'cache', 'projects'),
    path.join(home, 'Library', 'Application Support', 'com.qodercn.app.stable', 'cache', 'projects'),
    path.join(home, '.config', 'Qoder', 'cache', 'projects'),
  ];

  const out = [];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) out.push(c);
    } catch {
      /* 不存在 */
    }
  }
  return out;
}

/** 兼容旧调用：返回第一个存在的根目录。 */
function cacheRoot() {
  return cacheRoots()[0] || path.join(os.homedir(), '.qoder', 'cache', 'projects');
}

export function discover() {
  const out = [];
  for (const root of cacheRoots()) {
    let projects;
    try {
      projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const history = path.join(root, p.name, 'conversation-history');
      let convs;
      try {
        convs = fs.readdirSync(history, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const c of convs) {
        if (!c.isDirectory()) continue;
        const file = path.join(history, c.name, `${c.name}.jsonl`);
        try {
          if (fs.statSync(file).isFile()) out.push(file);
        } catch {
          /* 目录存在但 jsonl 不在，跳过 */
        }
      }
    }
  }
  return out;
}

/**
 * 从目录名反推项目名。
 *
 * "my-app-5e450c46" → "my-app"
 * 末尾那段是 8 位十六进制哈希，剥掉它才是项目名。哈希长度按实际观察是 8，
 * 但为了不把形如 "my-project-2" 的名字误剥，只在确实是 8 位 hex 时才剥。
 */
export function projectFromDirName(dirName) {
  const m = String(dirName).match(/^(.*)-([0-9a-f]{8})$/i);
  return m ? m[1] : dirName;
}

export function parse(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;

  let firstUserText = null;
  let firstAssistantText = null;
  let messageCount = 0;

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    messageCount++;
    const role = o.role;
    const t = extractText(o.message);
    if (!t) continue;
    if (role === 'user' && !firstUserText) {
      const cleaned = stripQoderContext(t);
      if (cleaned) firstUserText = cleaned;
    } else if (role === 'assistant' && !firstAssistantText) {
      firstAssistantText = t;
    }
  }

  if (!messageCount) return null;

  // 目录结构：projects/<项目>-<hash>/conversation-history/<id>/<id>.jsonl
  const dirName = path.basename(path.dirname(path.dirname(path.dirname(file))));
  const projectName = projectFromDirName(dirName);
  const id = path.basename(file, '.jsonl');

  let mtime = null;
  try {
    mtime = fs.statSync(file).mtime;
  } catch {
    /* 没有就算了 */
  }

  return makeSession({
    agent: name,
    id,
    // 只有项目名，没有盘符和完整路径。带上名字本身，
    // 让它在项目列表里可辨认，而不是硬编一个假路径。
    project: projectName,
    title: firstUserText || firstAssistantText,
    // 时间戳缺失，用文件 mtime 作为近似，并在 meta 里标明来源
    start: mtime,
    end: mtime,
    source: file,
    resume: null,
  });
}

function extractText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const p of c) {
    if (!p) continue;
    if (typeof p.text === 'string') parts.push(p.text);
    else if (typeof p.content === 'string') parts.push(p.content);
  }
  return parts.join('\n').trim();
}

/**
 * 剥掉 Qoder 塞进用户消息里的附件上下文。
 *
 * 它会把附加的文件夹内容整个展开在消息前面，真正的提问包在
 * <user_query> 里。有的消息没有这层标签，只剩一句
 * "'e:\path' (see above for folder content)" 的占位，那种整条都是噪声。
 */
export function stripQoderContext(text) {
  if (!text) return '';

  let out = text;
  // 先剥外层的附件块，再取 <user_query>；标签内部可能还残留占位语，
  // 所以两种顺序都要走一遍，而不是命中一个就返回。
  out = out.replace(/<folder_content[\s\S]*?<\/folder_content>/gi, '');
  out = out.replace(/<user_info>[\s\S]*?<\/user_info>/gi, '');
  out = out.replace(/<rules>[\s\S]*?<\/rules>/gi, '');
  out = out.replace(/Here are some folder\(s\) I manually attached to my message:/gi, '');

  const m = out.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (m) out = m[1];

  // "见上文" 这种指代没有独立信息量
  out = out.replace(/['"][^'"]*['"]\s*\(see above[^)]*\)/gi, '');
  return out.replace(/[ \t]+/g, ' ').trim();
}

/**
 * 读一场会话的完整正文。
 *
 * 越界校验要对**所有**根目录逐个试：会话可能来自 .qoder，也可能来自
 * .qoder-cn，事先不知道是哪个。全部都不匹配才抛错——这里不做"第一个
 * 根目录"的假设，否则中国版的会话会被拒绝读取。
 *
 * part 类型只见过 text（tool 调用记录在 agent-tools/*.txt 里，是给人看的
 * 纯文本，不是结构化数据），所以主要处理 text，遇到别的类型跳过、不猜。
 */
export function readMessages(session) {
  const roots = cacheRoots();
  if (!roots.length) throw new Error('没有找到 Qoder 数据目录');

  let real = null;
  let lastErr = null;
  for (const root of roots) {
    try {
      real = assertUnder(root, session.source);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!real) {
    throw lastErr || new Error(`拒绝读取根目录之外的路径: ${session.source}`);
  }
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

    const role = o.role === 'assistant' ? 'assistant' : o.role === 'system' ? 'system' : 'user';
    const parts = [];
    const c = o.message && o.message.content;

    if (typeof c === 'string') {
      const p = textPart(c);
      if (p) parts.push(p);
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p || !p.type) continue;
        if (p.type === 'text') {
          const t = role === 'user' ? stripQoderContext(p.text) : p.text;
          const part = textPart(t);
          if (part) parts.push(part);
        } else if (p.type === 'thinking' || p.type === 'reasoning') {
          const part = reasoningPart(p.thinking || p.text);
          if (part) parts.push(part);
        } else if (p.type === 'tool_use' || p.type === 'tool-call') {
          parts.push(
            toolPart({
              name: p.name || p.toolName,
              input: p.input,
              callId: p.id,
            })
          );
        }
      }
    }

    if (!parts.length) continue;
    out.push(makeMessage({ role, parts }));
  }

  return out;
}
