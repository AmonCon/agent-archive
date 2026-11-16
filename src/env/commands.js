/**
 * 斜杠命令（slash commands）的跨 Agent 识别（只读）。
 *
 * 环境层回答"这台机器上各 Agent 具备什么能力"。MCP 回答"连了哪些服务"，
 * 技能回答"装了哪些 SKILL.md"，这一层回答"我到底定义了多少个 /命令、
 * 它们在几家各有一份"。
 *
 * 六个来源（都是各家自己的目录，顶层文件 only）：
 *
 *   Claude Code    <claude dir>/commands/*.md       YAML frontmatter + body
 *   OpenCode       <config>/commands/*.md          同上；另读 <config>/command/
 *   Pi             <agent dir>/prompts/*.md        同上
 *   Gemini CLI     ~/.gemini/commands/*.toml       TOML description/prompt
 *   Qwen Code      <qwen home>/commands/*.md|*.toml 两种都读
 *   Factory Droid  ~/.factory/commands/*.md        同 Markdown
 *
 * Codex 的 `~/.codex/prompts` **只列出、不解析**：0.165 之后它已经不读
 * 自定义 prompts 了（skills 取代），列出来是为了让用户看见"这里还有旧的"，
 * 标成 `legacy: true`，不给 description/promptLength（null = 未知，不是空）。
 *
 * ## 安全边界
 *
 * 与 `env/mcp.js` 同一条线：**prompt 正文绝不出这个模块**。命令正文可能有
 * 几十 KB，也可能写着用户的私有内容；这里只返回 `promptLength`（UTF-8 字节，
 * 与 100 KB 上限同口径）和 `hash`。要看正文请用户自己打开源文件。
 *
 * ## 身份
 *
 * 同名且 `sha256(description + "\0" + prompt)` 相同 → 同一个命令，`agents`
 * 记多家；同名但 hash 不同 → 两条，`conflict: true`，让页面要求用户挑一个。
 * 与 `skills.js` 的 `groupByHash` 同一套身份模型，只是 key 换成命令内容。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { envOverrides, pathKey, userDataCandidates } from '../platform.js';
import { parseFrontmatter } from './skills.js';

/** 单个命令文件的上限（各家自己的加载器也都有类似上限）。 */
const MAX_COMMAND_BYTES = 1024 * 1024;

/** prompt 正文上限：与 magpie / Gemini 系的 100 KB 同口径。 */
const MAX_PROMPT_BYTES = 100 * 1024;

/** description 折叠空白后的 rune 上限；超了截断而不是丢掉整个命令。 */
const MAX_DESCRIPTION_RUNES = 1000;

/** 文件名即命令名：小写字母/数字/-/_，1–64 字节，首尾不能是 -/_。 */
const COMMAND_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/** 固定展示顺序；`agents` / `sources` 都按它排，测试与页面才稳定。 */
const AGENT_ORDER = ['claude-code', 'opencode', 'pi', 'gemini', 'qwen', 'droid', 'codex'];

/* ------------------------------ 路径 ------------------------------ */

function uniqPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    if (!p) continue;
    const abs = path.resolve(String(p));
    const key = pathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/** Claude Code 的配置根（`CLAUDE_CONFIG_DIR` 优先，`~/.claude` 默认）。 */
function claudeConfigDirs() {
  const home = os.homedir();
  return uniqPaths([
    ...envOverrides(['CLAUDE_CONFIG_DIR']),
    path.join(home, '.claude'),
    // 社区工具（ccusage 等）确实会留在这里；官方不支持，但作为低优先候选
    path.join(home, '.config', 'claude'),
  ]);
}

/** OpenCode 的配置根（`OPENCODE_CONFIG_DIR` 优先，XDG / 平台默认兜底）。 */
function opencodeConfigDirs() {
  const home = os.homedir();
  const defaults = [];
  for (const xdg of envOverrides(['XDG_CONFIG_HOME'])) defaults.push(path.join(xdg, 'opencode'));
  defaults.push(path.join(home, '.config', 'opencode'));
  defaults.push(...userDataCandidates('opencode'));
  return uniqPaths([...envOverrides(['OPENCODE_CONFIG_DIR']), ...defaults]);
}

/** Pi 的 agent 目录（`PI_CODING_AGENT_DIR` 精确目录，`PI_CONFIG_DIR` 是应用根）。 */
function piAgentDirs() {
  const home = os.homedir();
  return uniqPaths([
    ...envOverrides(['PI_CODING_AGENT_DIR']),
    ...envOverrides(['PI_CONFIG_DIR', 'pi_config_dir']).map((r) => path.join(r, 'agent')),
    path.join(home, '.pi', 'agent'),
  ]);
}

/** Gemini CLI 的配置根（项目惯例：GEMINI_CONFIG_DIR / gemini_config_dir）。 */
function geminiConfigDirs() {
  const home = os.homedir();
  return uniqPaths([
    ...envOverrides(['GEMINI_CONFIG_DIR', 'gemini_config_dir', 'GEMINI_CLI_HOME']),
    path.join(home, '.gemini'),
  ]);
}

/** Qwen Code 的应用根（`QWEN_HOME` 优先，`~/.qwen` 默认）。 */
function qwenHomes() {
  const home = os.homedir();
  return uniqPaths([...envOverrides(['QWEN_HOME', 'QWEN_CONFIG_DIR']), path.join(home, '.qwen')]);
}

/** Factory Droid 的应用根：`FACTORY_HOME_OVERRIDE` 是"家目录"，`.factory` 在其下。 */
function droidConfigDirs() {
  const home = os.homedir();
  const out = [];
  for (const h of envOverrides(['FACTORY_HOME_OVERRIDE'])) out.push(path.join(h, '.factory'));
  out.push(path.join(home, '.factory'));
  return uniqPaths(out);
}

function codexHomes() {
  const home = os.homedir();
  return uniqPaths([...envOverrides(['CODEX_HOME']), path.join(home, '.codex')]);
}

/**
 * 所有候选根，按 7 家生成。每个根都带 `exts` 与 `legacy`：
 * Codex 的 prompts 只列不解析。
 */
function rootSpecs() {
  const specs = [];
  const add = (agent, dir, exts, legacy = false) => specs.push({ agent, dir, exts, legacy });

  for (const dir of claudeConfigDirs()) add('claude-code', path.join(dir, 'commands'), ['.md']);

  for (const dir of opencodeConfigDirs()) {
    // OpenCode 的 config.ts 同时 glob `command/` 与 `commands/`
    add('opencode', path.join(dir, 'commands'), ['.md']);
    add('opencode', path.join(dir, 'command'), ['.md']);
  }

  for (const dir of piAgentDirs()) add('pi', path.join(dir, 'prompts'), ['.md']);
  for (const dir of geminiConfigDirs()) add('gemini', path.join(dir, 'commands'), ['.toml']);
  for (const dir of qwenHomes()) add('qwen', path.join(dir, 'commands'), ['.md', '.toml']);
  for (const dir of droidConfigDirs()) add('droid', path.join(dir, 'commands'), ['.md']);
  for (const dir of codexHomes()) add('codex', path.join(dir, 'prompts'), ['.md'], true);

  // 同一个目录可能被两个候选拼出来（例如 PI_CONFIG_DIR 就是 ~/.pi）：
  // 同一个 Agent 下按路径去重，避免同一份文件报两遍。
  const out = [];
  const seen = new Set();
  for (const s of specs) {
    const key = `${s.agent}\0${pathKey(s.dir)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/* ------------------------------ 解析 ------------------------------ */

/** 折叠空白：description 在展示与 hash 里都用这一份。 */
function foldWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function runeLength(s) {
  return [...String(s)].length;
}

/** 按 rune 截断，保留最后一个字符位置的省略号。 */
function clipRunes(s, max) {
  const runes = [...String(s)];
  if (runes.length <= max) return String(s);
  return runes.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** prompt 规范化：CRLF → LF，去掉开头空行与结尾空白（与上游读入口径一致）。 */
function normalizePrompt(p) {
  return String(p == null ? '' : p)
    .replace(/\r\n/g, '\n')
    .replace(/^\n+/, '')
    .replace(/[ \n\t]+$/, '');
}

/** 命令身份：description + NUL + prompt 的 sha256，取前 16 位十六进制。 */
function commandHash(description, prompt) {
  return crypto
    .createHash('sha256')
    .update(description, 'utf8')
    .update('\0', 'utf8')
    .update(prompt, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * 解析 Markdown 命令：YAML frontmatter 的 description + 正文为 prompt。
 *
 * 复用 skills.js 的 `parseFrontmatter`（同一套引号/块标量处理）；frontmatter
 * 坏掉时按"没有 frontmatter、整份是正文"处理——这是上游 `splitFront` 的
 * 容错口径，不会因为一个坏描述就把命令丢掉。
 */
function parseMarkdownCommand(text) {
  const s = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = s.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return { description: '', prompt: s };
  const front = parseFrontmatter(s);
  return { description: front.description || '', prompt: s.slice(m[0].length) };
}

/** 找多行字符串的结束引号：跳过被反斜杠转义的引号。 */
function findTripleClose(s, quote) {
  if (quote === "'''") return s.indexOf(quote);
  let from = 0;
  for (;;) {
    const idx = s.indexOf(quote, from);
    if (idx < 0) return -1;
    let slashes = 0;
    for (let j = idx - 1; j >= 0 && s[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) return idx;
    from = idx + 1;
  }
}

/** TOML 基本字符串的转义（只处理 TOML 文档里的基本形式）。 */
function unescapeBasic(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) return { error: '反斜杠结尾没有转义字符' };
    // 多行字符串的行尾反斜杠：吞掉换行和下一行前导空白
    if (n === '\n') {
      i++;
      while (i + 1 < raw.length && /[ \t]/.test(raw[i + 1])) i++;
      continue;
    }
    const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
    if (Object.prototype.hasOwnProperty.call(simple, n)) {
      out += simple[n];
      i++;
      continue;
    }
    if (n === 'u' || n === 'U') {
      const len = n === 'u' ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + len);
      if (hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) return { error: '非法 unicode 转义' };
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) return { error: '非法 unicode 码点' };
      out += String.fromCodePoint(cp);
      i += 1 + len;
      continue;
    }
    return { error: `非法转义 \\${n}` };
  }
  return { value: out };
}

/**
 * 读一个 TOML 值（只关心 description / prompt 两个顶层字段）。
 *
 * `lines[i]` 是 `key = ...` 那一行，`rest` 是等号后面的部分。
 * 返回 `{value, end}`（`end` 是值结束的行号）或 `{error}`。
 */
function readTomlValue(lines, i, rest) {
  const v = rest.trim();

  if (v.startsWith('"""') || v.startsWith("'''")) {
    const quote = v.slice(0, 3);
    const parts = [];
    let lineNo = i;
    let chunk = v.slice(3);
    for (;;) {
      const idx = findTripleClose(chunk, quote);
      if (idx >= 0) {
        parts.push(chunk.slice(0, idx));
        const tail = chunk.slice(idx + 3).trim();
        if (tail && !tail.startsWith('#')) return { error: `第 ${lineNo + 1} 行多行字符串后还有内容` };
        let value = parts.join('\n');
        // TOML：紧跟在开引号后的换行会被裁掉
        if (value.startsWith('\n')) value = value.slice(1);
        if (quote === '"""') {
          const un = unescapeBasic(value);
          if (un.error) return un;
          value = un.value;
        }
        return { value, end: lineNo };
      }
      parts.push(chunk);
      lineNo++;
      if (lineNo >= lines.length) return { error: '多行字符串没有闭合' };
      chunk = lines[lineNo];
    }
  }

  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0];
    let idx = -1;
    for (let j = 1; j < v.length; j++) {
      if (quote === '"' && v[j] === '\\') {
        j++;
        continue;
      }
      if (v[j] === quote) {
        idx = j;
        break;
      }
    }
    if (idx < 0) return { error: '字符串没有闭合' };
    const tail = v.slice(idx + 1).trim();
    if (tail && !tail.startsWith('#')) return { error: '字符串后还有内容' };
    const raw = v.slice(1, idx);
    if (quote === "'") return { value: raw, end: i };
    const un = unescapeBasic(raw);
    if (un.error) return un;
    return { value: un.value, end: i };
  }

  return { error: `不是字符串值：${clipRunes(v, 40)}` };
}

/**
 * 极简 TOML：只读顶层 `description` / `prompt`。
 *
 * 不为两个字段引入 TOML 依赖。只要求支持真实 Gemini/Qwen 命令文件的基本
 * 形状（`key = "..."`、`key = '...'`、`"""..."""`、`'''...'''`、注释）；
 * 表头之后的内容全部忽略。坏掉的字符串/不可识别的顶层行返回 `{error}`，
 * 由调用方记成 `unparsable`，**不静默当成空命令**。
 */
function parseTomlCommand(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 顶层键必须出现在第一个表头之前；后面的都是 [xxx] 段里的内容
    if (/^\[\[?[^\]]*\]\]?$/.test(trimmed)) break;

    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) {
      // 极简解析只认 `key = value`；不认识的顶层行（数组续行、内联表等）
      // 直接跳过。这里刻意不做完整 TOML 校验——为一个字段引入解析器不值得，
      // 而且误杀合法文件比漏掉一行无关内容更糟。
      continue;
    }

    const [, key, rest] = kv;
    if (key !== 'description' && key !== 'prompt') continue;

    const val = readTomlValue(lines, i, rest);
    if (val.error) return val;
    out[key] = val.value;
    i = val.end;
  }

  return out;
}

/* ------------------------------ 扫描 ------------------------------ */

function sortAgents(agents) {
  return [...agents].sort((a, b) => {
    const ia = AGENT_ORDER.indexOf(a);
    const ib = AGENT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function sortSources(sources) {
  return [...sources].sort(
    (a, b) =>
      AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent) ||
      a.path.localeCompare(b.path)
  );
}

/** 读一个根的状态：missing 是正常状态，不算 unknown；读不到/不是目录才是未知。 */
function rootState(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { status: 'missing' };
    return { status: 'unreadable', message: `读不到：${(e && e.code) || e.message}` };
  }
  if (!st.isDirectory()) return { status: 'unparsable', message: '不是目录' };
  return { status: 'ok' };
}

/** 扫一个根目录（顶层 only；符号链接文件按真实文件处理）。 */
function scanRoot(spec, errors) {
  const root = { agent: spec.agent, path: spec.dir, status: 'ok' };
  const state = rootState(spec.dir);
  if (state.status !== 'ok') {
    root.status = state.status;
    if (state.message) errors.push({ agent: spec.agent, path: spec.dir, code: state.status, message: state.message });
    return { root, records: [] };
  }

  let entries;
  try {
    entries = fs.readdirSync(spec.dir, { withFileTypes: true });
  } catch (e) {
    root.status = 'unreadable';
    errors.push({ agent: spec.agent, path: spec.dir, code: 'unreadable', message: `读不到目录：${(e && e.code) || e.message}` });
    return { root, records: [] };
  }

  const records = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const ext = spec.exts.find((x) => entry.name.toLowerCase().endsWith(x));
    if (!ext) continue;

    const file = path.join(spec.dir, entry.name);
    const name = entry.name.slice(0, -ext.length);

    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        errors.push({ agent: spec.agent, path: file, code: 'unreadable', message: `读不到：${(e && e.code) || e.message}` });
      }
      continue;
    }
    if (!st.isFile()) continue;

    if (st.size > MAX_COMMAND_BYTES) {
      errors.push({ agent: spec.agent, path: file, code: 'too-large', message: `文件超过 1 MB（${st.size} 字节）` });
      continue;
    }

    if (!COMMAND_NAME_RE.test(name)) {
      errors.push({
        agent: spec.agent,
        path: file,
        code: 'invalid-name',
        message: `命令名不合法：${name}（只允许小写字母/数字/-/_，1-64 字节，首尾不能是 -/_）`,
      });
      continue;
    }

    if (spec.legacy) {
      // Codex 只列出：不读正文（promptLength = null 表示未知，不是 0）
      records.push({
        agent: spec.agent,
        path: file,
        name,
        description: '',
        descLength: 0,
        promptLength: null,
        hash: null,
        legacy: true,
      });
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      errors.push({ agent: spec.agent, path: file, code: 'unreadable', message: `读不到：${(e && e.code) || e.message}` });
      continue;
    }

    const text = buf.toString('utf8');
    const parsed = ext === '.toml' ? parseTomlCommand(text) : parseMarkdownCommand(text);
    if (parsed.error) {
      errors.push({ agent: spec.agent, path: file, code: 'unparsable', message: parsed.error });
      continue;
    }

    const description = clipRunes(foldWhitespace(parsed.description), MAX_DESCRIPTION_RUNES);
    const prompt = normalizePrompt(parsed.prompt);
    if (!prompt) {
      errors.push({ agent: spec.agent, path: file, code: 'no-prompt', message: '没有 prompt 正文' });
      continue;
    }

    const promptLength = Buffer.byteLength(prompt, 'utf8');
    if (promptLength > MAX_PROMPT_BYTES) {
      errors.push({ agent: spec.agent, path: file, code: 'prompt-too-large', message: `prompt 超过 100 KB（${promptLength} 字节）` });
      continue;
    }

    records.push({
      agent: spec.agent,
      path: file,
      name,
      description,
      descLength: runeLength(description),
      promptLength,
      hash: commandHash(description, prompt),
      legacy: false,
    });
  }

  return { root, records };
}

/**
 * 扫描所有 Agent 的斜杠命令。
 *
 * @returns {{
 *   items: Array<{
 *     name: string,
 *     description: string,
 *     descLength: number,
 *     promptLength: number|null,
 *     agents: string[],
 *     sources: Array<{agent: string, path: string, hash: string|null}>,
 *     hash: string|null,
 *     conflict: boolean,
 *     legacy?: boolean,
 *   }>,
 *   errors: Array<{agent: string, path: string, code: string, message: string}>,
 *   roots: Array<{agent: string, path: string, status: string}>,
 * }}
 */
export function scanCommands() {
  const records = [];
  const errors = [];
  const roots = [];

  for (const spec of rootSpecs()) {
    const r = scanRoot(spec, errors);
    roots.push(r.root);
    records.push(...r.records);
  }

  // 按名字分组：同名且内容 hash 相同才合并；同名不同 hash 各保留一条并标冲突
  const byName = new Map();
  for (const r of records) {
    let list = byName.get(r.name);
    if (!list) {
      list = [];
      byName.set(r.name, list);
    }
    list.push(r);
  }

  const items = [];
  for (const [name, list] of byName) {
    const parsed = list.filter((r) => !r.legacy);
    const legacy = list.filter((r) => r.legacy);
    const byHash = new Map();

    for (const r of parsed) {
      let g = byHash.get(r.hash);
      if (!g) {
        g = {
          name,
          description: r.description,
          descLength: r.descLength,
          promptLength: r.promptLength,
          hash: r.hash,
          agents: new Set(),
          sources: [],
        };
        byHash.set(r.hash, g);
      }
      g.agents.add(r.agent);
      g.sources.push({ agent: r.agent, path: r.path, hash: r.hash });
    }

    const conflict = byHash.size > 1;
    for (const g of byHash.values()) {
      items.push({
        name: g.name,
        description: g.description,
        descLength: g.descLength,
        promptLength: g.promptLength,
        agents: sortAgents(g.agents),
        sources: sortSources(g.sources),
        hash: g.hash,
        conflict,
      });
    }

    if (legacy.length) {
      // Codex 的旧 prompts：同名合成一条"仅列出"的记录，内容未知因此不参与合并/冲突
      const agents = new Set();
      const sources = [];
      for (const r of legacy) {
        agents.add(r.agent);
        sources.push({ agent: r.agent, path: r.path, hash: null });
      }
      items.push({
        name,
        description: '',
        descLength: 0,
        promptLength: null,
        agents: sortAgents(agents),
        sources: sortSources(sources),
        hash: null,
        conflict: false,
        legacy: true,
      });
    }
  }

  items.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      String(a.hash || '').localeCompare(String(b.hash || '')) ||
      String(a.sources[0] ? a.sources[0].path : '').localeCompare(String(b.sources[0] ? b.sources[0].path : ''))
  );
  errors.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));

  return { items, errors, roots };
}

/**
 * 命令摘要（给 MCP 工具 / 环境总览 / 体检用）。
 *
 * `conflicts` 是**条目数**（同名不同内容会有两条，各算一次）；
 * `conflictNames` 是**名字数**，页面显示"有几组重名"用后者更直观。
 */
export function commandSummary() {
  const { items, errors, roots } = scanCommands();

  const byAgent = {};
  for (const item of items) {
    for (const source of item.sources) byAgent[source.agent] = (byAgent[source.agent] || 0) + 1;
  }

  const conflictItems = items.filter((i) => i.conflict);

  return {
    commands: items.length,
    files: items.reduce((n, i) => n + i.sources.length, 0),
    // 同一命令在多家各有一份（同名同内容合并后的条目）
    shared: items.filter((i) => i.agents.length > 1).length,
    conflicts: conflictItems.length,
    conflictNames: new Set(conflictItems.map((i) => i.name)).size,
    // Codex 的旧 prompts：只列出，不代表当前可用
    legacy: items.filter((i) => i.legacy).length,
    agents: sortAgents(new Set(items.flatMap((i) => i.agents))),
    byAgent,
    // 读不到/解析不了的根：未知 ≠ 零；missing（没装）不算 unknown
    rootsUnknown: roots.filter((r) => r.status === 'unreadable' || r.status === 'unparsable').length,
    rootsMissing: roots.filter((r) => r.status === 'missing').length,
    errors,
    roots: roots.filter((r) => r.status !== 'missing'),
    list: items.map((i) => ({
      name: i.name,
      description: clipRunes(i.description, 200),
      agents: i.agents,
      sources: i.sources.length,
      promptLength: i.promptLength,
      hash: i.hash,
      conflict: i.conflict || undefined,
      legacy: i.legacy || undefined,
    })),
  };
}
