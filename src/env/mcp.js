/**
 * MCP 配置的跨 Agent 识别。
 *
 * 会话层回答"聊过什么"，这一层回答"这台机器上各 Agent 具备什么能力"。
 *
 * 与 cc-switch / magpie 的关键区别：**它们按名字认服务，我们按指纹认。**
 * cc-switch 的 `McpServer.id` 就是原生配置里的键名，所以同一个 supabase
 * 在 Claude 里叫 adbsupabase、在 Qoder 里叫 supabase，会被当成两个服务。
 * 真实数据是：一个 supabase 服务，4 条注册，3 种启动形态，
 * 2 个名字。不按指纹归一，"我到底配了几份、哪份是活的"这个问题就答不了。
 *
 * 另一个硬约束：**env / headers 的值绝不出这个模块。**
 * 实测多份 Agent 配置里存在明文云厂商 AK。这个模块只回传键名，
 * 要看值必须走终端，永远不经过 MCP。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userDataCandidates } from '../platform.js';

/**
 * 各 Agent 的 MCP 配置文件。
 *
 * 一个 Agent 可能有多个位置（全局 / 项目级 / 另一种格式），
 * 全部列出，各自独立解析——它们是"注册"，不是"同一份配置的副本"。
 */
function homeDir() {
  return os.homedir();
}

function envDir(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

/** DSH 的 MCP 不是独立文件，而是 profile 的 cordis.patch.yml 里的 loader 条目。 */
function dshPatchFiles() {
  const home = process.env.DSH_HOME || path.join(homeDir(), 'DeepSeekHarness');
  const dir = path.join(home, 'profiles');
  let names;
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.map((n) => path.join(dir, n, 'cordis.patch.yml'));
}

/** 几个候选里取第一个真实存在的文件（有些客户端会在多个文件名之间选一个）。 */
function firstExistingPaths(paths) {
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) return [p];
    } catch {
      /* 试下一个 */
    }
  }
  return [];
}

const SOURCES = [
  {
    agent: 'claude-code',
    format: 'json-mcpServers',
    paths: () => [path.join(os.homedir(), '.claude.json')],
    // ~/.claude.json 里 mcpServers 在顶层；也支持 .claude/settings.json
    note: '顶层 mcpServers',
  },
  {
    agent: 'claude-code',
    format: 'json-mcpServers',
    paths: () => [path.join(os.homedir(), '.claude', 'settings.json')],
    note: '.claude/settings.json',
  },
  {
    agent: 'codex',
    format: 'toml-mcp_servers',
    paths: () => [path.join(os.homedir(), '.codex', 'config.toml')],
  },
  {
    agent: 'zcode',
    format: 'json-nested',
    paths: () => [path.join(os.homedir(), '.zcode', 'cli', 'config.json')],
    // 形状是 { mcp: { servers: { name: {...} } } }，比通用 mcpServers 多一层
    pick: (j) => (j && j.mcp && j.mcp.servers) || null,
  },
  {
    agent: 'qoder',
    format: 'json-mcpServers',
    // Qoder 有两个位置：mcp.json（老）与 settings.json（新，实测 16 条 vs 5 条）
    paths: () => [
      path.join(os.homedir(), '.qoder', 'mcp.json'),
      path.join(os.homedir(), '.qoder', 'settings.json'),
    ],
  },
  {
    agent: 'cursor',
    format: 'json-mcpServers',
    paths: () => [path.join(os.homedir(), '.cursor', 'mcp.json')],
  },
  {
    agent: 'opencode',
    format: 'json-nested',
    paths: () => [
      path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
      // XDG 数据目录也可能放配置
      ...userDataCandidates('opencode').map((r) => path.join(r, 'opencode.json')),
    ],
    // OpenCode 用 mcp 而不是 mcpServers，且 type: local/remote，env 叫 environment
    pick: (j) => (j && j.mcp) || null,
  },
  {
    agent: 'gemini',
    format: 'json-mcpServers',
    paths: () => [path.join(os.homedir(), '.gemini', 'settings.json')],
  },
  {
    agent: 'hermes',
    format: 'yaml-mcp_servers',
    paths: () => [path.join(os.homedir(), '.hermes', 'config.yaml')],
  },
  {
    agent: 'kiro',
    format: 'json-mcpServers',
    // Kiro 的用户级 MCP 配置在这个位置；实测不存在，但别的机器上可能有
    paths: () => [
      path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
      ...userDataCandidates('Kiro').map((r) => path.join(r, 'User', 'settings.json')),
    ],
  },
  {
    // 我们自己的宿主。DSH 把 MCP 声明成 profile 的 loader 条目，
    // 不是 mcpServers 映射——不专门读就会漏掉自己（本机实测就漏了）。
    agent: 'dsh',
    format: 'yaml-dsh-patch',
    paths: () => dshPatchFiles(),
    note: 'profiles/*/cordis.patch.yml 的 @deepseek-ai/dsh-mcp-client 条目',
  },
  {
    agent: 'kimi',
    format: 'json-mcpServers',
    paths: () => [
      path.join(envDir('KIMI_CODE_HOME', path.join(homeDir(), '.kimi-code')), 'mcp.json'),
      path.join(homeDir(), '.kimi', 'mcp.json'),
    ],
  },
  {
    agent: 'mcode',
    format: 'json-mcpServers',
    paths: () => [
      path.join(envDir('MINIMAX_DATA_DIR', envDir('MAVIS_DATA_DIR', path.join(homeDir(), '.minimax'))), 'mcp.json'),
    ],
  },
  {
    agent: 'pi',
    format: 'json-mcpServers',
    // Pi 的 MCP 在 agent 目录下；PI_CODING_AGENT_DIR 优先，其次应用根/agent
    paths: () => [
      path.join(envDir('PI_CODING_AGENT_DIR', path.join(envDir('PI_CONFIG_DIR', path.join(homeDir(), '.pi')), 'agent')), 'mcp.json'),
    ],
  },
  {
    agent: 'omp',
    format: 'json-mcpServers',
    paths: () => [
      path.join(envDir('OMP_DATA_DIR', path.join(homeDir(), '.omp')), 'agent', 'mcp.json'),
    ],
  },
  {
    agent: 'antigravity',
    format: 'json-mcpServers',
    // Antigravity CLI 的 MCP 在自定义目录（首次启动会建 0 字节文件）
    paths: () => [path.join(homeDir(), '.gemini', 'config', 'mcp_config.json')],
  },
  {
    agent: 'copilot',
    format: 'json-mcpServers',
    // GitHub Copilot CLI：stdio 写成 type: local，禁用在 settings.json 的 disabledMcpServers
    paths: () => [path.join(homeDir(), '.copilot', 'mcp-config.json')],
  },
  {
    agent: 'grokbuild',
    format: 'toml-mcp_servers',
    // Grok Build 与 Codex 同为 [mcp_servers] TOML
    paths: () => [path.join(envDir('GROK_HOME', path.join(homeDir(), '.grok')), 'config.toml')],
  },
  {
    agent: 'workbuddy',
    format: 'json-mcpServers',
    // WorkBuddy / WorkBuddy AI 的 MCP 在各自目录的 mcp.json
    paths: () => [
      path.join(envDir('WORKBUDDY_CONFIG_DIR', path.join(homeDir(), '.workbuddy')), 'mcp.json'),
      path.join(homeDir(), '.workbuddy-ai', 'mcp.json'),
    ],
  },
  {
    agent: 'codebuddy',
    format: 'json-mcpServers',
    // CodeBuddy 在 .mcp.json / mcp.json / .codebuddy.json 里取第一个存在的
    paths: () =>
      firstExistingPaths([
        path.join(envDir('CODEBUDDY_CONFIG_DIR', path.join(homeDir(), '.codebuddy')), '.mcp.json'),
        path.join(envDir('CODEBUDDY_CONFIG_DIR', path.join(homeDir(), '.codebuddy')), 'mcp.json'),
        path.join(homeDir(), '.codebuddy.json'),
      ]),
  },
  {
    agent: 'droid',
    format: 'json-mcpServers',
    paths: () => [path.join(homeDir(), '.factory', 'mcp.json')],
  },
  {
    agent: 'devin',
    format: 'json-mcpServers',
    paths: () => [path.join(homeDir(), '.devin', 'mcp_config.json')],
  },
  {
    agent: 'commandcode',
    format: 'json-mcpServers',
    paths: () => [path.join(homeDir(), '.commandcode', 'mcp.json')],
  },
  {
    agent: 'alma',
    format: 'json-mcpServers',
    paths: () => [path.join(homeDir(), '.config', 'alma', 'mcp.json')],
  },
  {
    agent: 'claude-desktop',
    format: 'json-mcpServers',
    // Claude 桌面版：Windows 是 %APPDATA%/Claude，macOS 是
    // ~/Library/Application Support/Claude，Linux 走 XDG。
    // 用 userDataCandidates 而不是自己拼 APPDATA——只拼 APPDATA 的写法
    // 在 macOS 上会永远返回一个不存在的路径。
    paths: () => userDataCandidates('Claude').map((root) => path.join(root, 'claude_desktop_config.json')),
  },
];

/**
 * 把上面这张表投影成"配置目标"清单，给 connect 用。
 *
 * 存在的理由很直接：**路径只能有一张表**。connect 要按 Agent 告诉用户
 * "该往哪个文件里粘"，如果它自己再抄一份路径，两边迟早漂移——
 * 解析器认的位置和打印给你的位置变成两个，而症状是"照你说的贴了，
 * 它还是看不见"。所以这里只做投影：求值 paths，带上 format 和 note。
 *
 * 只读：不读文件内容，也不写任何东西。
 *
 * @returns {Array<{agent: string, format: string, paths: string[], note: string|null}>}
 */
export function mcpConfigTargets() {
  return SOURCES.map((src) => {
    let paths = [];
    try {
      paths = src.paths() || [];
    } catch {
      // 某家的路径求值失败（目录读不到等）不该让整张表消失
      paths = [];
    }
    return {
      agent: src.agent,
      format: src.format,
      paths: paths.filter((p) => typeof p === 'string' && p),
      note: src.note || null,
    };
  });
}

/* ------------------------------ 解析 ------------------------------ */

/**
 * 只解析 `[mcp_servers.*]` 段，不用通用 TOML 库。
 *
 * 理由和会话层一样：为一个字段引入依赖不值得，而这些文件的
 * 其余部分（hooks、projects、skills.config）我们一个都不需要。
 * 支持多行数组——Codex 的 args 就是多行写的，用单行正则会把它们吃掉。
 */
function parseTomlMcpServers(text) {
  const out = {};
  let cur = null;
  let inArgs = false;
  let argsBuf = '';

  const flushArgs = () => {
    if (!cur || !inArgs) return;
    inArgs = false;
    const vals = [...argsBuf.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    out[cur] = out[cur] || {};
    out[cur].args = vals;
    argsBuf = '';
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw;

    // 段头：[mcp_servers.name] 或 [mcp_servers.name.env]
    const hdr = line.match(/^\s*\[mcp_servers\.([^\].\s]+)(?:\.([^\].\s]+))?\]\s*$/);
    if (hdr) {
      flushArgs();
      const [, name, sub] = hdr;
      out[name] = out[name] || {};
      cur = sub === 'env' ? null : name;
      if (sub === 'env') out[name].env = out[name].env || {};
      if (sub === 'env') cur = `${name}.env`;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      flushArgs();
      cur = null;
      continue;
    }
    if (!cur) continue;

    const [owner, sub] = cur.endsWith('.env') ? [cur.slice(0, -4), 'env'] : [cur, null];

    if (inArgs) {
      argsBuf += ' ' + line;
      if (/\]/.test(line)) flushArgs();
      continue;
    }

    if (sub === 'env') {
      const kv = line.match(/^\s*([A-Za-z_][\w.]*)\s*=\s*(['"])(.*?)\2\s*$/);
      if (kv) out[owner].env[kv[1]] = kv[3];
      continue;
    }

    const cmd = line.match(/^\s*command\s*=\s*(['"])(.*?)\1\s*$/);
    if (cmd) {
      out[owner].command = cmd[2];
      continue;
    }

    // 多行 args 的开始：args = [ 之后没有闭合
    const argsOpen = line.match(/^\s*args\s*=\s*\[\s*(.*)$/);
    if (argsOpen) {
      const rest = argsOpen[1];
      if (rest.includes(']')) {
        out[owner].args = [...rest.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
      } else {
        inArgs = true;
        argsBuf = rest;
      }
      continue;
    }

    const url = line.match(/^\s*url\s*=\s*(['"])(.*?)\1\s*$/);
    if (url) out[owner].url = url[2];
  }
  flushArgs();

  return out;
}

/**
 * 极简 YAML：只取 `mcp_servers:` 下的一层映射。
 *
 * Hermes 的 config.yaml 有 14000 字节、几十个顶层键，我们只要一个。
 * 这里按缩进做最小解析，不引 js-yaml——理由同 TOML。
 */
function parseYamlMcpServers(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^mcp_servers\s*:/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return out;

  const inline = lines[start].replace(/^mcp_servers\s*:/, '').trim();
  if (inline === '{}' || inline === '') {
    // 空映射：mcp_servers: {}
    if (inline === '{}') return out;
  }

  let cur = null;
  let curSub = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const indent = line.match(/^\s*/)[0].length;
    // 回到顶层，段结束
    if (indent === 0) break;

    // 服务名（2 空格缩进）
    const nameM = line.match(/^ {2}([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (nameM) {
      cur = nameM[1];
      curSub = null;
      out[cur] = out[cur] || {};
      const rest = nameM[2].trim();
      if (rest && rest !== '{}') {
        // name: {command: x} 这种极少见，忽略内联对象
      }
      continue;
    }

    if (!cur) continue;

    // 子键（4 空格缩进）：command / args / env / url
    const subM = line.match(/^ {4}([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (subM) {
      const [, k, v] = subM;
      curSub = k === 'env' ? 'env' : k === 'args' ? 'args' : null;
      if (k === 'env') {
        out[cur].env = out[cur].env || {};
        continue;
      }
      const val = v.trim();
      if (!val) {
        // `args:` 后面跟块状列表（每行 `- 值`），见下面 argsListM
        if (k === 'args') out[cur].args = out[cur].args || [];
        continue;
      }
      if (k === 'command' || k === 'url') out[cur][k] = unquote(val);
      if (k === 'args') {
        out[cur].args = [...val.matchAll(/'([^']*)'|"([^"]*)"|([^,\s\[\]]+)/g)]
          .map((m) => unquote(m[1] ?? m[2] ?? m[3] ?? ''))
          .filter(Boolean);
      }
      continue;
    }

    // args 的块状列表：
    //     args:
    //       - "-y"
    //       - "@modelcontextprotocol/server-github"
    //
    // 必须支持。不支持的话 args 会读成空数组，服务指纹退化成只有
    // `command: npx`——实测每一种 npx 拉起的服务都会被合并成同一条，
    // 而且不报错。这是"静默出错"里最坏的一种：用户看到的是"我配了 5 个
    // 服务，它说只有 1 个"。
    const argsItemM = line.match(/^ {6,}-\s+(.+)$/);
    if (argsItemM && curSub === 'args') {
      const v = unquote(argsItemM[1].replace(/\s+#.*$/, '').trim());
      if (v) out[cur].args.push(v);
      continue;
    }

    // env 下的键值（6 空格缩进），只记键名
    const envM = line.match(/^ {6}([A-Za-z_][\w.]*)\s*:\s*(.*)$/);
    if (envM && curSub === 'env') {
      out[cur].env[envM[1]] = unquote(envM[2].trim());
    }
  }

  return out;
}

/**
 * DSH 的 `cordis.patch.yml`：MCP server 是 loader 条目，不是 mcpServers 映射。
 *
 * 形状（本机实测）：
 *   - insert:
 *       - id: magpie-mcp-magpie-image
 *         name: "@deepseek-ai/dsh-mcp-client"
 *         config:
 *           serverName: "magpie-image"
 *           transport: "stdio"
 *           command: "..."
 *           args: [ "mcp", "image" ]
 *
 * 这个文件同时装着一堆 UI 插件，只认带 `@deepseek-ai/dsh-mcp-client` 的条目。
 * 值里可能有 YAML 的折行（行尾反斜杠），先把折行接回来再解析。
 */
function parseDshPatch(text) {
  const raw = text.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    while (/\\\s*$/.test(line) && i + 1 < raw.length) {
      line = line.replace(/\\\s*$/, '') + String(raw[++i]).trim();
    }
    lines.push(line);
  }

  const out = {};
  const starts = [];
  lines.forEach((l, i) => {
    if (/^\s*-\s+id:/.test(l)) starts.push(i);
  });

  for (let b = 0; b < starts.length; b++) {
    const block = lines.slice(starts[b], starts[b + 1] ?? lines.length);
    if (!block.some((l) => /name:\s*"?@deepseek-ai\/dsh-mcp-client"?/.test(l))) continue;

    const get = (key) => {
      for (const l of block) {
        const m = l.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
        if (m) return unquote(m[1].replace(/\s+#.*$/, '').trim());
      }
      return null;
    };

    const serverName = get('serverName');
    if (!serverName) continue;

    const transport = (get('transport') || '').toLowerCase();
    const server = {};
    server.type =
      transport === 'streamable-http' || transport === 'http' || transport === 'sse' ? 'http' : 'stdio';

    const command = get('command');
    if (command) server.command = command;
    const url = get('url');
    if (url) server.url = url;

    // args 可能是内联数组，也可能是块状列表
    for (let k = 0; k < block.length; k++) {
      const m = block[k].match(/^\s*args:\s*(.*)$/);
      if (!m) continue;
      const inline = m[1].trim();
      if (inline.startsWith('[')) {
        server.args = [...inline.matchAll(/'([^']*)'|"([^"]*)"|([^,\s[\]]+)/g)]
          .map((x) => unquote(x[1] ?? x[2] ?? x[3] ?? ''))
          .filter(Boolean);
      } else {
        const args = [];
        for (let j = k + 1; j < block.length; j++) {
          const item = block[j].match(/^\s*-\s+(.+)$/);
          if (!item) break;
          args.push(unquote(item[1].replace(/\s+#.*$/, '').trim()));
        }
        server.args = args;
      }
      break;
    }

    // headers 的键名（不取值）
    const headers = {};
    const hi = block.findIndex((l) => /^\s*headers:\s*$/.test(l));
    if (hi >= 0) {
      for (let j = hi + 1; j < block.length; j++) {
        const hm = block[j].match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!hm) break;
        headers[hm[1]] = hm[2];
      }
    }
    if (Object.keys(headers).length) server.headers = headers;

    out[serverName] = server;
  }

  return out;
}

function unquote(s) {
  const t = String(s).trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  return t;
}

/** 读一个 JSON 配置文件，失败返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------ 归一 ------------------------------ */

/**
 * 从原生定义里抽出统一的传输描述。
 *
 * 三家缺 type 字段，只能按有无 url/command 推断——cc-switch 的
 * `codex_entry_transport_type()` 也是这么做的，这是事实上的约定。
 */
function describeTransport(raw) {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : null;

  // OpenCode 用 local/remote；其余用 stdio/http/sse/streamable-http
  const isRemote = type === 'remote' || type === 'http' || type === 'sse' || type === 'streamable-http' || type === 'streamable_http';

  const url = raw.url || raw.serverUrl || raw.endpoint || null;

  // OpenCode 的 command 是数组：[可执行文件, ...参数]。把它拆开，
  // 否则数组被 toString 成 "demo.cmd,mcp" 这种假指纹。
  let command = raw.command || null;
  let args = Array.isArray(raw.args) ? raw.args : [];
  if (Array.isArray(command)) {
    args = [...command.slice(1), ...args];
    command = command[0] || null;
  }

  if (isRemote || (!command && url)) {
    return { transport: 'remote', url: url || null };
  }
  if (command) {
    return { transport: 'stdio', command, args };
  }
  // 有 type 但两个都没有：不认识，别猜
  return { transport: type || 'unknown', command: null, args: [] };
}

/**
 * 启动形态指纹。
 *
 * 这是整个模块的技术核心。同一个服务在不同 Agent 里可以：
 *   - 用 npx 拉最新 vs 指向本地已安装路径
 *   - 用 cmd /c 包一层（Windows）
 *   - 名字完全不同（adbsupabase / supabase）
 *
 * 所以指纹**不能**直接用 command 字符串。做法：从 command+args 里
 * 找出真正启动的那个脚本/包，再做归一。
 *
 * 一个刻意的取舍：npx 拉的最新版和本地已安装版**不视为同一个指纹**，
 * 而是归到同一个服务、标记形态不同。因为它们跑起来确实是两份东西
 * （一份钉住版本、一份随时更新），但用户心里的"服务"是同一个。
 */
function fingerprintOf(t) {
  if (t.transport === 'remote') {
    if (!t.url) return 'remote:unknown';
    // 去掉 query 和末尾斜杠，url 里常带 token
    try {
      const u = new URL(t.url);
      return `remote:${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return `remote:${String(t.url).split('?')[0].toLowerCase()}`;
    }
  }

  if (!t.command) return `${t.transport}:unknown`;

  const flat = [t.command, ...(t.args || [])].map(String);

  // 剥掉 cmd /c、sh -c 这类包装层——Windows 上极常见
  const unwrapped = stripShellWrapper(flat);

  // 找 npx / npm exec 拉起的包名
  const npx = extractNpxPackage(unwrapped);
  if (npx) return `pkg:${npx}#npx`;

  // 本地脚本：先看它是否来自 node_modules/<包名>/——
  // 这是和 npx 对齐的关键。同一个包，一份 npx 拉、一份本地装，
  // command 字符串毫无共同点，但包名是一样的。
  //
  // 保留 #local 后缀：包名回答"这是哪个服务"，后缀回答"怎么装的"。
  // 前者用来合并，后者用来发现"有的地方钉住版本、有的地方每次拉最新"。
  const pkg = extractNodeModulePackage(unwrapped);
  if (pkg) return `pkg:${pkg}#local`;

  // 其余本地脚本：取 dist/ 之后的路径做指纹
  const script = extractScript(unwrapped);
  if (script) return `script:${script}`;

  // 全是可执行文件：用第一个非包装的可执行名
  return `bin:${path.basename(unwrapped[0] || t.command).toLowerCase()}`;
}

/**
 * 从参数里找 node_modules/<包名> 形式的路径，抽出包名。
 *
 * `.../node_modules/@acme/mcp-server-alpha/dist/transports/stdio.js`
 *   → @acme/mcp-server-alpha
 *
 * 这样它就能和 qoder 里 `npx -y @acme/mcp-server-alpha@latest`
 * 归到同一个服务上——两者确实是同一个服务，只是安装方式不同。
 */
function extractNodeModulePackage(parts) {
  for (const p of parts) {
    const norm = String(p).replace(/\\/g, '/');
    const idx = norm.lastIndexOf('node_modules/');
    if (idx === -1) continue;

    const rest = norm.slice(idx + 'node_modules/'.length);
    // scoped 包占两段
    const m = rest.match(/^(@[^/]+\/[^/]+|[^/]+)/);
    if (m) return m[1];
  }
  return null;
}

function stripShellWrapper(parts) {
  if (!parts.length) return parts;
  const base = path.basename(parts[0]).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

  // cmd /c node script.js ...  →  node script.js ...
  if ((base === 'cmd' || base === 'sh' || base === 'bash' || base === 'powershell' || base === 'pwsh') && parts.length > 1) {
    const flag = parts[1].toLowerCase();
    if (flag === '/c' || flag === '-c' || flag === '-lc' || flag === '-lic') {
      return parts.slice(2);
    }
    if (/^\/[ck]$/.test(flag)) return parts.slice(2);
  }
  return parts;
}

function extractNpxPackage(parts) {
  const idx = parts.findIndex((p) => {
    const b = path.basename(String(p)).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    return b === 'npx' || b === 'bunx' || b === 'pnpx';
  });
  if (idx === -1) return null;

  for (let i = idx + 1; i < parts.length; i++) {
    const v = String(parts[i]);
    if (v.startsWith('-')) continue;
    // @scope/name@version → @scope/name
    const m = v.match(/^(@[^/]+\/[^@]+?|[^@/]+?)(?:@[\w.\-^~*]+)?$/);
    return m ? m[1] : v;
  }
  return null;
}

function extractScript(parts) {
  for (const p of parts) {
    const s = String(p);
    // 绝对/相对路径，或直接写脚本名（`node server.js` 在真实配置里很常见）。
    // 早先只认带斜杠的路径，导致所有 `node xxx.js` 都退化成 bin:node，
    // 不同服务被并成同一个——这是"按指纹认"最怕的过度合并。
    if (!s.startsWith('-') && /\.(js|mjs|cjs|ts)$/i.test(s)) {
      // 只取相对 dist/ 之后的路径，避免同一个包在不同盘符下认成两个
      const norm = s.replace(/\\/g, '/');
      const m = norm.match(/\/((?:dist|build|bin|lib)\/.*)$/);
      return m ? m[1].toLowerCase() : path.basename(norm).toLowerCase();
    }
  }
  return null;
}

/**
 * 服务身份：从指纹里抽一个更粗的"这是哪个服务"。
 *
 * 同一服务的不同启动形态（npx 拉最新 vs 本地已安装）指纹不同，
 * 但服务身份相同——去掉 #npx / #local 这个安装方式后缀就是了。
 */
function serviceKeyOf(fp) {
  const bare = fp.replace(/#(?:npx|local)$/, '');
  if (bare.startsWith('pkg:')) return bare.slice(4);
  if (bare.startsWith('npx:')) return bare.slice(4);
  if (bare.startsWith('remote:')) return bare.slice(7);
  if (bare.startsWith('script:')) return bare.slice(7);
  if (bare.startsWith('bin:')) {
    // demo.cmd mcp → bin:demo.cmd → 去掉扩展名
    return bare.slice(4).replace(/\.(cmd|exe|bat|ps1)$/, '');
  }
  return bare;
}

/**
 * 静态检查命令是否在 PATH 上（或绝对路径是否存在）。
 *
 * **刻意不 spawn**：MCP 配置里的 command 是用户写的任意命令，
 * 档案馆是只读查看器，替用户执行配置里的命令等于给配置文件一个
 * 本地代码执行入口。这里只做文件系统层面的存在性判断。
 */
function commandExists(command) {
  if (!command) return null;
  const first = String(command).trim().split(/\s+/)[0].replace(/^"|"$/g, '');
  if (!first) return null;
  if (path.isAbsolute(first)) {
    try {
      return fs.existsSync(first);
    } catch {
      return false;
    }
  }
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      try {
        if (fs.existsSync(path.join(dir, first + ext))) return true;
        if (fs.existsSync(path.join(dir, first + ext.toLowerCase()))) return true;
      } catch {
        /* 单个目录读不了不影响其他目录 */
      }
    }
  }
  return false;
}

/**
 * 把一条原生注册变成统一条目。
 *
 * env / headers **只留键名**，值一律丢掉。这一条不能破。
 */
function normalize(raw, { agent, file, name, disabledByConfig = false }) {
  const t = describeTransport(raw || {});

  const envKeys = Object.keys(raw?.env || raw?.environment || {}).sort();
  const headerKeys = Object.keys(raw?.headers || raw?.http_headers || {}).sort();

  // 启用语义：条目自身的 `enabled: false`（Pi/Copilot 等）与客户端级的
  // `disabledMcpServers` 名单都算停用。停用的不算"可用能力"，但仍列出来——
  // 用户需要知道"它还在配置里，只是被关掉了"。
  // WorkBuddy 等客户端用相反的键：`disabled: true` 表示停用。两个约定都要认，
  // 否则用户明明关了某个服务，能力面还会把它报成“可用”。
  const enabled = raw?.enabled !== false && raw?.disabled !== true && !disabledByConfig;

  // 校验：缺连接字段的条目不能当成"服务"计数——那会让用户以为配了、其实跑不起来。
  let problem = null;
  if (t.transport === 'remote' && !t.url) problem = '远程条目缺少 url';
  else if (t.transport !== 'remote' && !t.command) problem = 'stdio 条目缺少 command';
  else if (t.url) {
    try {
      new URL(t.url);
    } catch {
      problem = 'url 不合法';
    }
  }

  const fp = fingerprintOf(t);
  const key = serviceKeyOf(fp);

  return {
    // 身份：同一服务多条注册共享这个 key
    service: key,
    // 形态：同一服务的不同启动方式（npx 最新 vs 本地安装）指纹不同
    fingerprint: fp,
    // 原生名字：保留原样，这是"在哪个 Agent 里叫什么"
    name,
    agent,
    source: file,
    transport: t.transport,
    command: t.command || null,
    args: t.transport === 'stdio' ? t.args : [],
    url: t.url || null,
    // 只有键名。值绝不出现——这里有一条不可越过的线。
    envKeys,
    headerKeys,
    type: raw?.type || null,
    // 静态可执行性：只有 stdio 有意义；null = 无法判断
    commandFound: t.transport === 'stdio' ? commandExists(t.command) : null,
    // 启用状态：false = 条目在配置里但被用户关掉了
    enabled,
    problem,
  };
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 扫描所有已注册的 MCP 配置。
 *
 * @returns {{registrations: Array, files: Array, errors: Array}}
 */
export function scanMcp() {
  const registrations = [];
  const files = [];
  const errors = [];
  const invalid = [];
  const seenFiles = new Set();

  for (const src of SOURCES) {
    let paths;
    try {
      paths = src.paths();
    } catch {
      continue;
    }

    for (const file of paths) {
      if (!file || seenFiles.has(file)) continue;
      seenFiles.add(file);

      let st;
      try {
        st = fs.statSync(file);
      } catch (e) {
        // 不存在 = 这家没配，是正常状态（cc-switch 同口径：NotFound → 空）。
        // 但**读不到**（权限/IO）不能当成没有——那是未知，要报出来。
        if (e && e.code !== 'ENOENT') {
          files.push({ file, agent: src.agent, format: src.format, exists: true, status: 'unreadable', servers: 0 });
          errors.push({ file, agent: src.agent, error: `读不到：${e.code || e.message}` });
        }
        continue;
      }

      const entry = { file, agent: src.agent, format: src.format, exists: true, status: 'ok', servers: 0 };
      files.push(entry);

      try {
        let servers = null;
        let disabledNames = new Set();

        if (src.format === 'json-mcpServers' || src.format === 'json-nested') {
          const j = readJson(file);
          if (!j) {
            entry.status = 'unparsable';
            entry.error = 'JSON 解析失败';
            errors.push({ file, agent: src.agent, error: 'JSON 解析失败' });
            continue;
          }
          // 客户端级停用名单（Claude Code ~/.claude.json 的 disabledMcpServers 等）
          if (Array.isArray(j.disabledMcpServers)) disabledNames = new Set(j.disabledMcpServers);
          const picked = src.pick ? src.pick(j) : j.mcpServers;
          servers = picked && typeof picked === 'object' ? picked : null;
        } else if (src.format === 'toml-mcp_servers') {
          const text = readText(file);
          if (text == null) throw new Error('读不到文件');
          servers = parseTomlMcpServers(text);
        } else if (src.format === 'yaml-mcp_servers') {
          const text = readText(file);
          if (text == null) throw new Error('读不到文件');
          servers = parseYamlMcpServers(text);
        } else if (src.format === 'yaml-dsh-patch') {
          const text = readText(file);
          if (text == null) throw new Error('读不到文件');
          servers = parseDshPatch(text);
        }

        if (!servers) {
          entry.servers = 0;
          continue;
        }

        for (const [name, raw] of Object.entries(servers)) {
          if (!raw || typeof raw !== 'object') continue;
          const reg = normalize(raw, {
            agent: src.agent,
            file,
            name,
            disabledByConfig: disabledNames.has(name),
          });
          if (reg.problem) {
            // 不静默跳过：坏条目要计数并说明原因，否则用户看到"少了一个服务"
            // 却不知道是解析器没认出来，还是自己配置写错了。
            invalid.push({ file, agent: src.agent, name, problem: reg.problem });
            entry.invalid = (entry.invalid || 0) + 1;
            continue;
          }
          registrations.push(reg);
          entry.servers++;
        }
      } catch (e) {
        entry.status = 'unparsable';
        entry.error = e && e.message ? e.message : String(e);
        errors.push({ file, agent: src.agent, error: entry.error });
      }
    }
  }

  return { registrations, files, errors, invalid };
}

/**
 * 按服务聚合，把"同一个服务的多处注册"折叠成一条。
 *
 * 输出里每条带 `instances: [{agent, name, fingerprint, ...}]`，
 * 让调用方能看到"这个服务在几家配了、分别怎么启动的"。
 */
export function groupByService(registrations) {
  const map = new Map();

  for (const r of registrations) {
    let g = map.get(r.service);
    if (!g) {
      g = {
        service: r.service,
        // 展示名取最短的那个：supabase 比 adbsupabase 更像"真名"
        displayName: r.name,
        agents: [],
        instances: [],
        envKeys: new Set(),
      };
      map.set(r.service, g);
    }

    if (r.name.length < g.displayName.length) g.displayName = r.name;
    if (!g.agents.includes(r.agent)) g.agents.push(r.agent);
    for (const k of r.envKeys) g.envKeys.add(k);

    g.instances.push({
      agent: r.agent,
      name: r.name,
      transport: r.transport,
      fingerprint: r.fingerprint,
      command: r.command,
      args: r.args,
      url: r.url,
      envKeys: r.envKeys,
      // 静态可执行性：false = 命令不在 PATH 上（不等于一定跑不起来，
      // 但这一条能提前解释"为什么它启动失败"）。
      commandFound: r.commandFound,
      // false = 这条注册被客户端停用了
      enabled: r.enabled !== false,
    });
  }

  for (const g of map.values()) {
    const fps = [...new Set(g.instances.map((i) => i.fingerprint))];
    const forms = [...new Set(g.instances.map((i) => installFormOf(i.fingerprint)))];
    const names = [...new Set(g.instances.map((i) => i.name))];

    g.fingerprints = fps;
    g.installForms = forms;
    // 同一个服务全部注册都被停用 → 这个服务当前不可用，但仍列出来
    g.disabled = g.instances.every((i) => i.enabled === false);
    // 同一个服务在不同 Agent 里叫不同名字，这不是错误（各家自己命名），
    // 但值得展示——否则用户看不出"adbsupabase 和 supabase 是同一个东西"
    g.aliases = names.sort();
    // 启动形态不一致 = 有的地方钉住版本、有的每次拉最新。
    // 这是会真出问题的差异：两边跑的可能是不同版本。
    g.mixedForms = forms.length > 1;
    g.envKeys = [...g.envKeys].sort();
    g.agents.sort();
  }

  return [...map.values()].sort((a, b) => b.agents.length - a.agents.length || a.service.localeCompare(b.service));
}

/**
 * 从指纹里读出安装方式。
 *
 *   pkg:xxx#npx    → 每次从 registry 拉（可能不是同一版本）
 *   pkg:xxx#local  → 钉在某个 node_modules 里
 *   bin:xxx        → 装在 PATH 上的可执行文件
 *   script:/remote → 直接指脚本 / 远端地址
 */
function installFormOf(fp) {
  if (fp.endsWith('#npx')) return 'npx';
  if (fp.endsWith('#local')) return 'local';
  if (fp.startsWith('bin:')) return 'binary';
  if (fp.startsWith('script:')) return 'script';
  if (fp.startsWith('remote:')) return 'remote';
  return 'unknown';
}

/** 只给计数与键名的摘要，给 MCP 工具和体检用。 */
export function mcpSummary() {
  const { registrations, files, errors, invalid } = scanMcp();
  const services = groupByService(registrations);

  return {
    registrations: registrations.length,
    // 被用户关掉的注册数（条目还在配置里，只是不生效）
    disabled: registrations.filter((r) => r.enabled === false).length,
    services: services.length,
    agents: [...new Set(registrations.map((r) => r.agent))].sort(),
    // 配置里写了但连接字段不全的条目：不是"没有服务"，是"配坏了"。
    invalid: invalid.length,
    invalidList: invalid.slice(0, 20),
    // stdio 条目的命令不在 PATH 上（静态检查，不执行命令）
    missingCommands: registrations
      .filter((r) => r.commandFound === false)
      .map((r) => ({ service: r.name, agent: r.agent, command: r.command })),
    // 同一服务在不同 Agent 里的启动形态不一致：有的钉版本、有的每次拉最新。
    // 两边跑的可能是不同版本，这是会真出问题的差异。
    mixedForms: services.filter((s) => s.mixedForms).map((s) => ({
      service: s.displayName,
      agents: s.agents,
      forms: s.installForms,
    })),
    // 同一个服务在各家叫不同名字的
    aliased: services.filter((s) => s.aliases.length > 1).map((s) => ({
      service: s.displayName,
      aliases: s.aliases,
    })),
    // 有凭证键的服务：只报服务名和键名，不报值
    withCredentials: services
      .filter((s) => s.envKeys.length)
      .map((s) => ({ service: s.displayName, envKeys: s.envKeys })),
    files: files.length,
    // 每个配置文件的状态（给能力快照用：有文件但读不到 = partial）
    fileStates: files.map((f) => ({
      file: f.file,
      agent: f.agent,
      status: f.status || 'ok',
      servers: f.servers,
      invalid: f.invalid || 0,
    })),
    // 读不到/解析不了的文件数。**不算进"服务数"**：未知不是零。
    filesUnknown: files.filter((f) => f.status === 'unreadable' || f.status === 'unparsable').length,
    errors,
    list: services.map((s) => ({
      service: s.displayName,
      agents: s.agents,
      transport: s.instances[0] ? s.instances[0].transport : null,
      forms: s.installForms,
      registrations: s.instances.length,
      aliases: s.aliases.length > 1 ? s.aliases : undefined,
      envKeys: s.envKeys,
      missingCommand: s.instances.some((i) => i.commandFound === false),
      disabled: s.disabled || undefined,
    })),
  };
}

export { fingerprintOf, describeTransport, serviceKeyOf, installFormOf };
