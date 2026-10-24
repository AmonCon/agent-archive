/**
 * MCP 配置的跨 Agent 识别。
 *
 * 会话层回答"聊过什么"，这一层回答"这台机器上各 Agent 具备什么能力"。
 *
 * 与 cc-switch / magpie 的关键区别：**它们按名字认服务，我们按指纹认。**
 * cc-switch 的 `McpServer.id` 就是原生配置里的键名，所以同一个 supabase
 * 在 Claude 里叫 adbsupabase、在 Qoder 里叫 supabase，会被当成两个服务。
 * 本机的真实数据是：一个 supabase 服务，4 条注册，3 种启动形态，
 * 2 个名字。不按指纹归一，"我到底配了几份、哪份是活的"这个问题就答不了。
 *
 * 另一个硬约束：**env / headers 的值绝不出这个模块。**
 * 本机实测 3 份配置里有明文阿里云 AK。这个模块只回传键名，
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
    paths: () => [path.join(os.homedir(), '.qoder', 'mcp.json')],
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
    // Kiro 的用户级 MCP 配置在这个位置；本机不存在，但别的机器上可能有
    paths: () => [
      path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
      ...userDataCandidates('Kiro').map((r) => path.join(r, 'User', 'settings.json')),
    ],
  },
];

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
      curSub = k === 'env' ? 'env' : null;
      if (k === 'env') {
        out[cur].env = out[cur].env || {};
        continue;
      }
      const val = v.trim();
      if (!val) {
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

    // env 下的键值（6 空格缩进），只记键名
    const envM = line.match(/^ {6}([A-Za-z_][\w.]*)\s*:\s*(.*)$/);
    if (envM && curSub === 'env') {
      out[cur].env[envM[1]] = unquote(envM[2].trim());
    }
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
    // Windows 绝对路径 / POSIX 绝对路径 + .js
    if (/[\\/]/.test(s) && /\.(js|mjs|cjs|ts)$/.test(s)) {
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
 * 把一条原生注册变成统一条目。
 *
 * env / headers **只留键名**，值一律丢掉。这一条不能破。
 */
function normalize(raw, { agent, file, name }) {
  const t = describeTransport(raw || {});

  const envKeys = Object.keys(raw?.env || raw?.environment || {}).sort();
  const headerKeys = Object.keys(raw?.headers || raw?.http_headers || {}).sort();

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
      } catch {
        continue;
      }

      const entry = { file, agent: src.agent, format: src.format, exists: true, servers: 0 };
      files.push(entry);

      try {
        let servers = null;

        if (src.format === 'json-mcpServers' || src.format === 'json-nested') {
          const j = readJson(file);
          if (!j) {
            entry.error = 'JSON 解析失败';
            errors.push({ file, agent: src.agent, error: 'JSON 解析失败' });
            continue;
          }
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
        }

        if (!servers) {
          entry.servers = 0;
          continue;
        }

        for (const [name, raw] of Object.entries(servers)) {
          if (!raw || typeof raw !== 'object') continue;
          registrations.push(normalize(raw, { agent: src.agent, file, name }));
          entry.servers++;
        }
      } catch (e) {
        entry.error = e && e.message ? e.message : String(e);
        errors.push({ file, agent: src.agent, error: entry.error });
      }
    }
  }

  return { registrations, files, errors };
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
    });
  }

  for (const g of map.values()) {
    const fps = [...new Set(g.instances.map((i) => i.fingerprint))];
    const forms = [...new Set(g.instances.map((i) => installFormOf(i.fingerprint)))];
    const names = [...new Set(g.instances.map((i) => i.name))];

    g.fingerprints = fps;
    g.installForms = forms;
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
  const { registrations, files, errors } = scanMcp();
  const services = groupByService(registrations);

  return {
    registrations: registrations.length,
    services: services.length,
    agents: [...new Set(registrations.map((r) => r.agent))].sort(),
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
    errors,
    list: services.map((s) => ({
      service: s.displayName,
      agents: s.agents,
      transport: s.instances[0] ? s.instances[0].transport : null,
      forms: s.installForms,
      registrations: s.instances.length,
      aliases: s.aliases.length > 1 ? s.aliases : undefined,
      envKeys: s.envKeys,
    })),
  };
}

export { fingerprintOf, describeTransport, serviceKeyOf, installFormOf };
