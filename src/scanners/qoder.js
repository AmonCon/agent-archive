import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart, assertUnder } from '../messages.js';
import { pathKey } from '../platform.js';

/**
 * Qoder 会话扫描。
 *
 * Qoder 有两套存储，格式和粒度都不同：
 *
 *   旧（cache）：
 *     ~/.qoder[-cn]/cache/projects/<项目名>-<hash>/conversation-history/<id>/<id>.jsonl
 *     简版 {role, message:{content}}，没有时间戳、没有 cwd，只能靠 mtime
 *     和目录名近似。半年前的会话基本都在这里。
 *
 *   新（projects）：
 *     ~/.qoder[-cn]/projects/<工作区转义路径>/<sessionId>.jsonl
 *     与 Claude Code 同构：每行带 type / timestamp / cwd / sessionId，
 *     工具调用和结果都写在文件里。**这是现在的主存储**——本机 334 个
 *     文件里 316 个是真人会话，只读旧格式会漏掉九成以上。
 *
 * 国际版和中国版是两套独立安装，各有一份，都要读。macOS 上还有
 * Application Support 下的变体目录。
 *
 * 旧格式的实测教训（保留）：本机同时装了 `.qoder` 和 `.qoder-cn`，
 * 前者 7 场、后者 12 场，只读一个会漏一半。
 */

export const name = 'qoder';

/** Qoder 的配置根（可能有多套安装）。 */
function configRoots() {
  const home = os.homedir();

  // QODER_CONFIG_DIR 是官方支持的根目录覆盖，优先于所有默认位置——
  // 用户明确指到别处就该听他的。逗号分隔是社区工具的常见约定。
  const overrides = String(process.env.QODER_CONFIG_DIR || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === '~' ? home : s.startsWith('~/') || s.startsWith('~\\') ? path.join(home, s.slice(2)) : s));

  return [
    ...overrides,
    path.join(home, '.qoder'),
    path.join(home, '.qoder-cn'),
    path.join(home, 'Library', 'Application Support', 'Qoder'),
    path.join(home, 'Library', 'Application Support', 'QoderCN'),
    path.join(home, 'Library', 'Application Support', 'Qoder CN'),
    path.join(home, 'Library', 'Application Support', 'QoderWork'),
    path.join(home, 'Library', 'Application Support', 'com.qoder.app.stable'),
    path.join(home, 'Library', 'Application Support', 'com.qodercn.app.stable'),
    path.join(home, '.config', 'Qoder'),
  ];
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 旧格式的 projects 根：`<配置根>/cache/projects`。
 *
 * 覆盖变量也可能直接指到 projects 目录，两种都接受。
 */
function cacheRoots() {
  const out = [];
  for (const r of configRoots()) {
    const direct = path.basename(r) === 'projects';
    const c = direct ? r : path.join(r, 'cache', 'projects');
    if (isDir(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** 新格式的 projects 根：`<配置根>/projects`。 */
function projectRoots() {
  const out = [];
  for (const r of configRoots()) {
    const p = path.basename(r) === 'projects' ? r : path.join(r, 'projects');
    if (isDir(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** 所有可能装会话的根，供正文越界校验使用。 */
function allRoots() {
  return [...cacheRoots(), ...projectRoots()];
}

export function discover() {
  const out = [];
  const seen = new Set();
  const add = (file) => {
    // 同一个目录可能通过两个候选根都被看到（符号链接、大小写）。
    // 去重规则跟随文件系统，和 platform.js 保持一致——别在这里另写一份。
    const key = pathKey(file);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };

  // 旧格式：<项目>/conversation-history/<id>/<id>.jsonl
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
          if (fs.statSync(file).isFile()) add(file);
        } catch {
          /* 目录存在但 jsonl 不在，跳过 */
        }
      }
    }
  }

  // 新格式：<工作区>/<sessionId>.jsonl
  // 只认 UUID 文件名：工作区目录下也可能放别的 jsonl（配置、导出），
  // 靠形状区分比靠内容试读便宜。
  const uuidFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
  for (const root of projectRoots()) {
    let workspaces;
    try {
      workspaces = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const w of workspaces) {
      if (!w.isDirectory()) continue;
      const dir = path.join(root, w.name);
      let files;
      try {
        files = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile() || !uuidFile.test(f.name)) continue;
        add(path.join(dir, f.name));
      }
    }
  }

  return out;
}

/** 新格式的一行是不是事件（旧格式没有顶层 type + sessionId）。 */
function isProjectFormat(first) {
  return first && typeof first.type === 'string' && (first.sessionId || first.type === 'workspace-directories');
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

  let first;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  return isProjectFormat(first) ? parseProjectSession(file, lines, first) : parseLegacy(file, lines);
}

/**
 * 旧格式：只有 role/message，没有时间戳和 cwd。
 *
 * 项目只能从目录名反推（"softpi-shop-5e450c46" → "softpi-shop"），
 * 时间只能取文件 mtime。两处都如实标出，不猜一个看起来合理的值。
 */
function parseLegacy(file, lines) {
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
      const cleaned = cleanUserText(t);
      if (cleaned) firstUserText = cleaned;
    } else if (role === 'assistant' && !firstAssistantText) {
      firstAssistantText = t;
    }
  }

  if (!messageCount) return null;

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
    project: projectName,
    title: firstUserText || firstAssistantText,
    start: mtime,
    end: mtime,
    source: file,
    resume: null,
  });
}

/**
 * 新格式：每行一个事件，首行 workspace-directories 给出真实 cwd。
 *
 * 时间戳是现成的（ISO 或毫秒），项目路径是现成的，不再需要用 mtime
 * 和目录名近似——这正是新格式值得单独解析的原因。
 */
function parseProjectSession(file, lines, first) {
  let sessionId = first.sessionId || path.basename(file, '.jsonl');
  let project = Array.isArray(first.directories) ? first.directories[0] : null;
  let title = null;
  let fallbackTitle = null;
  let start = null;
  let end = null;
  let human = false;

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.sessionId) sessionId = o.sessionId;
    if (!project && o.cwd) project = o.cwd;

    const d = toDate(o.timestamp);
    if (d) {
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }

    if (o.type === 'ai-title' && o.title) title = o.title;
    if (o.type === 'user' && o.message) {
      const t = cleanUserText(extractText(o.message));
      // "# Input / Tool: ..." 是 Qoder 把工具调用包装成的 user 消息，
      // 不是人说的话。整场只有这种时，它是一场工具会话，不该进时间线。
      if (t && isToolEnvelope(t)) continue;
      if (t) {
        human = true;
        if (!title) title = t;
      }
    } else if (o.type === 'assistant' && o.message && !fallbackTitle) {
      fallbackTitle = extractText(o.message.content);
    }
  }

  // 纯工具会话（本机有 2 个）没有人类输入，归档它们只会污染时间线
  if (!human) return null;

  if (!start && !end) {
    try {
      const mtime = fs.statSync(file).mtime;
      start = mtime;
      end = mtime;
    } catch {
      return null;
    }
  }

  return makeSession({
    agent: name,
    id: sessionId,
    project,
    title: title || fallbackTitle,
    start,
    end: end || start,
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

/** 毫秒数字或 ISO 字符串都接受。 */
function toDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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
 * 清洗新格式的用户消息。
 *
 * 浏览器标注消息长这样：真正的用户话在 <user_comment> 里，外面裹着
 * 整块页面证据（DOM 路径、元素文本、截图坐标）。直接取全文会让标题
 * 变成一大段 HTML，所以先取 user_comment，再剥其余注入块。
 */
export function cleanUserText(text) {
  if (!text) return '';

  let out = text;
  // 顺序重要：先在整段里找 user_comment，再去掉 browser_annotation 外壳，
  // 否则会把里面唯一的人话一起删掉。
  const m = out.match(/<user_comment>([\s\S]*?)<\/user_comment>/i);
  if (m) out = m[1];

  out = out.replace(/<browser_annotation[^>]*>[\s\S]*?<\/browser_annotation>/gi, '');
  out = out.replace(/<untrusted_page_evidence>[\s\S]*?<\/untrusted_page_evidence>/gi, '');
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  out = out.replace(/<user_comment>|<\/user_comment>/gi, '');
  out = stripQoderContext(out);

  return out.replace(/\s+/g, ' ').trim();
}

/** Qoder 把工具调用包装成 "# Input\nTool: \"Bash\"..." 的 user 消息。 */
function isToolEnvelope(text) {
  return /^#\s*Input\b/i.test(String(text || '').trim());
}

/**
 * 读一场会话的完整正文。
 *
 * 越界校验要对**所有**根目录逐个试：会话可能来自 .qoder 也可能来自
 * .qoder-cn，可能在新格式也可能在旧格式，事先不知道是哪个。全部都不
 * 匹配才抛错——这里不做"第一个根目录"的假设，否则中国版的会话会被拒绝。
 */
export function readMessages(session) {
  const roots = allRoots();
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

  const lines = fs
    .readFileSync(real, 'utf8')
    .split('\n')
    .filter((l) => l.trim());

  let first;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    return [];
  }

  return isProjectFormat(first) ? readProjectMessages(lines) : readLegacyMessages(lines);
}

function readLegacyMessages(lines) {
  const out = [];
  for (const line of lines) {
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
          const t = role === 'user' ? cleanUserText(p.text) : p.text;
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

/**
 * 新格式正文。
 *
 * 只认四种事件：user / assistant / tool_use / tool_result。
 * attachment（技能清单）、active-leaf（对话树指针）、file-history-snapshot
 * （文件备份）、runtime-config、progress 都是运行时记录，不是对话内容。
 */
function readProjectMessages(lines) {
  const out = [];
  const pending = new Map();

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;

    const ts = o.timestamp;

    if (o.type === 'user' && o.message) {
      const texts = [];
      const results = [];
      const c = o.message.content;
      const arr = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];

      for (const p of arr) {
        if (!p || !p.type) continue;
        if (p.type === 'text') {
          const t = cleanUserText(p.text);
          if (t && !isToolEnvelope(t)) texts.push(textPart(t));
        } else if (p.type === 'tool_result') {
          const call = pending.get(p.tool_use_id) || {};
          results.push(
            toolPart({
              name: call.name,
              input: call.input,
              callId: p.tool_use_id,
              output: contentToText(p.content),
            })
          );
        }
        // image 等二进制片段没有统一的正文表示，跳过而不是猜一个占位符
      }

      if (texts.length) out.push(makeMessage({ role: 'user', parts: texts, ts }));
      if (results.length) out.push(makeMessage({ role: 'tool', parts: results, ts }));
      continue;
    }

    if (o.type === 'assistant' && o.message) {
      const parts = [];
      const c = o.message.content;
      const arr = Array.isArray(c) ? c : [];
      for (const p of arr) {
        if (!p || !p.type) continue;
        if (p.type === 'text') {
          const part = textPart(p.text);
          if (part) parts.push(part);
        } else if (p.type === 'thinking' || p.type === 'reasoning') {
          const part = reasoningPart(p.thinking || p.text);
          if (part) parts.push(part);
        } else if (p.type === 'tool_use' || p.type === 'tool-call') {
          parts.push(toolPart({ name: p.name || p.toolName, input: p.input, callId: p.id }));
          pending.set(p.id, { name: p.name || p.toolName, input: p.input });
        }
      }
      if (parts.length) out.push(makeMessage({ role: 'assistant', parts, ts }));
    }
  }

  return out;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 从目录名反推项目名。
 *
 * "softpi-shop-5e450c46" → "softpi-shop"
 * 末尾那段是 8 位十六进制哈希，剥掉它才是项目名。哈希长度按实际观察是 8，
 * 但为了不把形如 "my-project-2" 的名字误剥，只在确实是 8 位 hex 时才剥。
 */
export function projectFromDirName(dirName) {
  const m = String(dirName).match(/^(.*)-([0-9a-f]{8})$/i);
  return m ? m[1] : dirName;
}
