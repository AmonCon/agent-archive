/**
 * CLI 产品层：这台机器装了哪些命令行产品，哪家 Agent 看得见、哪家真的用过。
 *
 * 环境层原来只回答 MCP / 技能 / 记忆，缺了很实用的一维：
 * 同一个 `aliyun` CLI，可能只装在某个 Agent 的私有 bin 目录里，
 * 别的 Agent 根本看不到；也可能装在系统 PATH 上，但只有一家在会话里跑过。
 * 这两种状态对"换个 Agent 还能不能接着干"影响很大，所以单独列出来。
 *
 * 数据分两半，边界必须说清楚：
 *
 *   安装位置  事实。PATH 和已知的 Agent 私有目录里找到的可执行文件。
 *   可见范围  推断。系统/共享目录默认对所有 Agent 可见，Agent 私有目录
 *             只对那一家可见。只是按位置推断，不读每家 Agent 的 PATH。
 *   调用次数  事实。来自全文索引里的 shell 工具调用摘要，只覆盖显式执行过的命令，
 *             和技能使用率一样是下限，不是全貌。
 *
 * 不执行任何 CLI，也不读它们的配置文件——这里只报"存在"和"用过"。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statePath } from '../paths.js';
import { tildify } from '../model.js';
import { openIndex, indexPath, readBody, hasBodyZ } from '../search.js';

/** 产品目录。只用于识别，不代表本机一定装了。 */
const CLI_CATALOG = [
  // 云服务与部署
  { id: 'aliyun', display: '阿里云 CLI', category: 'cloud', binaries: ['aliyun', 'ossutil'] },
  { id: 'aws', display: 'AWS CLI', category: 'cloud', binaries: ['aws'] },
  { id: 'gcloud', display: 'Google Cloud CLI', category: 'cloud', binaries: ['gcloud', 'gsutil'] },
  { id: 'az', display: 'Azure CLI', category: 'cloud', binaries: ['az'] },
  { id: 'supabase', display: 'Supabase CLI', category: 'cloud', binaries: ['supabase'] },
  { id: 'vercel', display: 'Vercel CLI', category: 'cloud', binaries: ['vercel'] },
  { id: 'netlify', display: 'Netlify CLI', category: 'cloud', binaries: ['netlify'] },
  { id: 'fly', display: 'Fly.io CLI', category: 'cloud', binaries: ['flyctl', 'fly'] },
  { id: 'railway', display: 'Railway CLI', category: 'cloud', binaries: ['railway'] },
  { id: 'wrangler', display: 'Cloudflare Wrangler', category: 'cloud', binaries: ['wrangler'] },
  { id: 'firebase', display: 'Firebase CLI', category: 'cloud', binaries: ['firebase'] },
  { id: 'heroku', display: 'Heroku CLI', category: 'cloud', binaries: ['heroku'] },
  { id: 'doctl', display: 'DigitalOcean CLI', category: 'cloud', binaries: ['doctl'] },

  // 代码与仓库
  { id: 'git', display: 'Git', category: 'code', binaries: ['git'] },
  { id: 'gh', display: 'GitHub CLI', category: 'code', binaries: ['gh'] },
  { id: 'glab', display: 'GitLab CLI', category: 'code', binaries: ['glab'] },
  { id: 'gitnexus', display: 'GitNexus', category: 'code', binaries: ['gitnexus'] },
  { id: 'rg', display: 'ripgrep', category: 'code', binaries: ['rg'] },
  { id: 'fd', display: 'fd', category: 'code', binaries: ['fd'] },
  { id: 'jq', display: 'jq', category: 'code', binaries: ['jq'] },

  // 运行时与包管理
  { id: 'node', display: 'Node.js', category: 'runtime', binaries: ['node'] },
  { id: 'npm', display: 'npm', category: 'runtime', binaries: ['npm'] },
  { id: 'pnpm', display: 'pnpm', category: 'runtime', binaries: ['pnpm'] },
  { id: 'yarn', display: 'Yarn', category: 'runtime', binaries: ['yarn'] },
  { id: 'bun', display: 'Bun', category: 'runtime', binaries: ['bun', 'bunx'] },
  { id: 'deno', display: 'Deno', category: 'runtime', binaries: ['deno'] },
  { id: 'python', display: 'Python', category: 'runtime', binaries: ['python', 'python3', 'py'] },
  { id: 'pip', display: 'pip', category: 'runtime', binaries: ['pip', 'pip3'] },
  { id: 'uv', display: 'uv', category: 'runtime', binaries: ['uv'] },
  { id: 'poetry', display: 'Poetry', category: 'runtime', binaries: ['poetry'] },
  { id: 'conda', display: 'Conda', category: 'runtime', binaries: ['conda'] },
  { id: 'cargo', display: 'Cargo', category: 'runtime', binaries: ['cargo'] },
  { id: 'rustup', display: 'Rustup', category: 'runtime', binaries: ['rustup'] },
  { id: 'go', display: 'Go', category: 'runtime', binaries: ['go'] },
  { id: 'java', display: 'Java', category: 'runtime', binaries: ['java'] },

  // 容器与运维
  { id: 'docker', display: 'Docker', category: 'container', binaries: ['docker', 'docker-compose'] },
  { id: 'kubectl', display: 'kubectl', category: 'container', binaries: ['kubectl'] },
  { id: 'helm', display: 'Helm', category: 'container', binaries: ['helm'] },
  { id: 'terraform', display: 'Terraform', category: 'container', binaries: ['terraform'] },
  { id: 'pulumi', display: 'Pulumi', category: 'container', binaries: ['pulumi'] },
  { id: 'ansible', display: 'Ansible', category: 'container', binaries: ['ansible'] },
  { id: 'podman', display: 'Podman', category: 'container', binaries: ['podman'] },
  { id: 'winget', display: 'winget', category: 'system', binaries: ['winget'] },
  { id: 'scoop', display: 'Scoop', category: 'system', binaries: ['scoop'] },
  { id: 'choco', display: 'Chocolatey', category: 'system', binaries: ['choco'] },

  // Agent 自己的 CLI
  { id: 'claude', display: 'Claude Code', category: 'agent', binaries: ['claude'] },
  { id: 'codex', display: 'Codex', category: 'agent', binaries: ['codex'] },
  { id: 'qoder', display: 'Qoder', category: 'agent', binaries: ['qoder'] },
  { id: 'opencode', display: 'OpenCode', category: 'agent', binaries: ['opencode'] },
  { id: 'gemini', display: 'Gemini', category: 'agent', binaries: ['gemini'] },
  { id: 'cursor-agent', display: 'Cursor Agent', category: 'agent', binaries: ['cursor-agent'] },
  { id: 'kiro', display: 'Kiro', category: 'agent', binaries: ['kiro'] },
  { id: 'hermes', display: 'Hermes', category: 'agent', binaries: ['hermes', 'hermes-web-ui', 'hermes-status', 'hermes-web'] },
  { id: 'agent-browser', display: 'Agent Browser', category: 'agent', binaries: ['agent-browser'] },
  { id: 'magpie', display: 'Magpie', category: 'agent', binaries: ['magpie', 'magpie-windows-amd64'] },
  { id: 'playwright', display: 'Playwright', category: 'agent', binaries: ['playwright'] },

  // 协作与内容
  { id: 'lark-cli', display: '飞书 CLI', category: 'collab', binaries: ['lark-cli'] },
  { id: 'himalaya', display: 'Himalaya', category: 'collab', binaries: ['himalaya'] },
  { id: 'ffmpeg', display: 'FFmpeg', category: 'media', binaries: ['ffmpeg'] },
  { id: 'ffprobe', display: 'FFprobe', category: 'media', binaries: ['ffprobe'] },
  // 不加 convert：Windows 自带的磁盘转换工具也叫 convert.exe，会误报
  { id: 'magick', display: 'ImageMagick', category: 'media', binaries: ['magick'] },

  // 数据库
  { id: 'psql', display: 'PostgreSQL psql', category: 'database', binaries: ['psql'] },
  { id: 'mysql', display: 'MySQL CLI', category: 'database', binaries: ['mysql'] },
  { id: 'sqlite3', display: 'SQLite CLI', category: 'database', binaries: ['sqlite3'] },
  { id: 'redis-cli', display: 'Redis CLI', category: 'database', binaries: ['redis-cli'] },
];

export const CLI_CATEGORY_LABELS = {
  cloud: '云服务',
  code: '代码与仓库',
  runtime: '运行时',
  container: '容器与运维',
  system: '系统工具',
  agent: 'Agent 工具',
  collab: '协作',
  media: '媒体',
  database: '数据库',
};

const CATALOG_BY_ID = new Map(CLI_CATALOG.map((p) => [p.id, p]));

const BINARY_TO_PRODUCT = new Map();
for (const p of CLI_CATALOG) {
  for (const b of p.binaries) BINARY_TO_PRODUCT.set(b.toLowerCase(), p.id);
}

// npx / bunx 拉起的常见包名 → 产品 id
const PACKAGE_TO_PRODUCT = new Map([
  ['@supabase/cli', 'supabase'],
  ['supabase', 'supabase'],
  ['@cloudflare/wrangler', 'wrangler'],
  ['wrangler', 'wrangler'],
  ['vercel', 'vercel'],
  ['@anthropic-ai/claude-code', 'claude'],
  ['@openai/codex', 'codex'],
  ['@google/gemini-cli', 'gemini'],
  ['@qoder-ai/qoder', 'qoder'],
  ['opencode-ai', 'opencode'],
  ['gitnexus', 'gitnexus'],
  ['agent-browser', 'agent-browser'],
  ['playwright', 'playwright'],
  ['firebase-tools', 'firebase'],
  ['netlify-cli', 'netlify'],
  ['@railway/cli', 'railway'],
  ['@fly.io/fly', 'fly'],
]);

const SHELL_TOOL_NAMES = new Set([
  'Bash',
  'bash',
  'Shell',
  'shell',
  'exec_command',
  'run_terminal_cmd',
  'run_shell_command',
  'shell_command',
  'execute_command',
  'run_command',
  'runCommand',
  'terminal',
  'Terminal',
  'LocalShell',
  'command_execution',
  'Execute',
  'exec',
  'cmd',
  'powershell',
  'PowerShell',
  'pwsh',
]);

const SKIP_TOKENS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'time',
  'command',
  'builtin',
  'exec',
  'cd',
  'pushd',
  'popd',
]);

/**
 * Agent 私有 bin 目录。
 *
 * 只扫这些明确位置，不做全盘搜索：`.qoder` 之类的目录下面可能有几万个文件，
 * 为了找一个 CLI 把整棵树走一遍不值得。depth 是相对该根还能往下走几层。
 */
const PRIVATE_ROOTS = [
  { agents: ['qoder'], rel: '.qoder/bin', depth: 4 },
  { agents: ['qoder'], rel: '.qoder/.bin', depth: 2 },
  { agents: ['hermes'], rel: '.hermes/bin', depth: 2 },
  { agents: ['codex'], rel: '.codex/.sandbox-bin', depth: 1 },
  { agents: ['codex'], rel: '.cache/codex-runtimes', depth: 6 },
  { agents: ['zcode'], rel: '.zcode/cli', depth: 3 },
  { agents: ['zcode'], rel: '.zcode/bin', depth: 2 },
  { agents: ['opencode'], rel: '.config/opencode/node_modules/.bin', depth: 0 },
  { agents: ['cursor'], rel: '.cursor/bin', depth: 2 },
  { agents: ['kiro'], rel: '.kiro/bin', depth: 2 },
  { agents: ['gemini', 'antigravity'], rel: '.gemini/antigravity/bin', depth: 1 },
  { agents: ['claude-code'], rel: '.claude/bin', depth: 2 },
];

/** 共享 bin 目录：不归属于某一家，所有 Agent 默认都看得到。 */
const SHARED_ROOTS = [
  '.local/bin',
  '.agents/bin',
  '.cargo/bin',
  '.bun/bin',
  '.deno/bin',
  'AppData/Roaming/npm',
];

/** 目录遍历时直接跳过的重目录。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'cache',
  'caches',
  'backups',
  'logs',
  'sessions',
  'memories',
  'extensions',
  'plugins',
  'tmp',
  'temp',
]);

const MAX_WALK_FILES = 2500;

function home() {
  return os.homedir();
}

function normPath(p) {
  return String(p || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

function isInside(child, parent) {
  const c = normPath(child).toLowerCase();
  const p = normPath(parent).replace(/[\\/]+$/, '').toLowerCase();
  if (!c || !p) return false;
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

function privateRoots() {
  return PRIVATE_ROOTS.map((r) => ({
    ...r,
    abs: path.join(home(), ...r.rel.split('/')),
  }));
}

function sharedRoots() {
  return SHARED_ROOTS.map((rel) => ({
    abs: path.join(home(), ...rel.split('/')),
  }));
}

function binaryBase(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
}

/**
 * 一次性把 PATH 目录读成「命令名 → 可执行文件」。
 *
 * 逐产品去 stat 会变成两万次文件检查（几十个产品 × 几十个目录 × 几种后缀），
 * 在 Windows 上要一两秒。改成每个目录 readdir 一次，再按 PATH 顺序取第一个，
 * 既快又和 shell 的解析顺序一致。
 */
function indexPathDirs() {
  const map = new Map();
  const rankOf = (name) => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.exe')) return 0;
    if (lower.endsWith('.cmd')) return 1;
    if (lower.endsWith('.bat')) return 2;
    if (lower.endsWith('.ps1')) return 3;
    return 4;
  };

  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map(normPath)
    .filter(Boolean);

  for (let di = 0; di < dirs.length; di++) {
    const dir = dirs[di];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const base = binaryBase(e.name);
      if (!BINARY_TO_PRODUCT.has(base)) continue;
      const full = path.join(dir, e.name);
      const rank = rankOf(e.name);
      const prev = map.get(base);
      // PATH 里先出现的目录赢；同一个目录内再按 .exe > .cmd > .bat > .ps1
      if (!prev) map.set(base, { path: full, dir: di, rank });
      else if (prev.dir === di && rank < prev.rank) map.set(base, { path: full, dir: di, rank });
    }
  }

  return new Map([...map.entries()].map(([base, v]) => [base, v.path]));
}

/**
 * 在一个目录里找已知 CLI 的可执行文件。
 *
 * 只收 catalog 里有的名字；不把 bin 目录里的所有东西都倒出来——
 * 那些大多是运行时内部工具（runtime-info.exe 之类），对用户没有意义。
 */
function walkKnown(root, depth) {
  const out = [];
  let seen = 0;

  function walk(dir, left) {
    if (left < 0 || seen > MAX_WALK_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen > MAX_WALK_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0 && !SKIP_DIRS.has(e.name.toLowerCase())) walk(full, left - 1);
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      const id = BINARY_TO_PRODUCT.get(binaryBase(e.name));
      if (id) out.push({ id, path: full });
    }
  }

  walk(root, depth);
  return out;
}

function classifyInstall(file) {
  for (const r of privateRoots()) {
    if (isInside(file, r.abs)) return { scope: 'agent', owners: r.agents };
  }
  for (const r of sharedRoots()) {
    if (isInside(file, r.abs)) return { scope: 'shared', owners: [] };
  }
  return { scope: 'system', owners: [] };
}

function addInstall(map, id, install) {
  if (!map.has(id)) map.set(id, []);
  const list = map.get(id);
  const key = normPath(install.path).toLowerCase();
  if (list.some((x) => normPath(x.path).toLowerCase() === key)) return;
  list.push(install);
}

let detectMemo = null;
let detectAt = 0;
const DETECT_TTL_MS = 60_000;

/**
 * 探测本机 CLI 安装位置。
 *
 * PATH 命中优先（那就是 Agent 实际会解析到的那个），私有目录只用来补
 * "没进 PATH、但某个 Agent 自己能找到"的产品。
 */
export function detectCliInstalls({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && detectMemo && now - detectAt < DETECT_TTL_MS) return detectMemo;

  const map = new Map();
  const pathMap = indexPathDirs();

  for (const product of CLI_CATALOG) {
    for (const binary of product.binaries) {
      const hit = pathMap.get(binary.toLowerCase());
      if (hit) addInstall(map, product.id, { path: hit, ...classifyInstall(hit) });
    }
  }

  for (const root of privateRoots()) {
    for (const hit of walkKnown(root.abs, root.depth)) {
      addInstall(map, hit.id, { path: hit.path, scope: 'agent', owners: root.agents });
    }
  }

  for (const root of sharedRoots()) {
    for (const hit of walkKnown(root.abs, 0)) {
      addInstall(map, hit.id, { path: hit.path, scope: 'shared', owners: [] });
    }
  }

  detectMemo = map;
  detectAt = now;
  return map;
}

/** 测试或显式刷新用。 */
export function clearCliCaches() {
  detectMemo = null;
  detectAt = 0;
}

function indexStat() {
  try {
    return fs.statSync(indexPath());
  } catch {
    return null;
  }
}

function usageCacheFile() {
  // 解析规则变了就换版本号，避免读到旧口径的缓存
  return statePath('cache', 'cli-usage-v2.json');
}

function tokenize(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) {
    const t = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    if (t) out.push(t);
  }
  return out;
}

function packageProduct(pkg) {
  const clean = String(pkg || '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/@[\d.]+$/, '')
    .replace(/@latest$/i, '');
  if (PACKAGE_TO_PRODUCT.has(clean)) return PACKAGE_TO_PRODUCT.get(clean);
  const base = clean.split('/').pop();
  if (PACKAGE_TO_PRODUCT.has(base)) return PACKAGE_TO_PRODUCT.get(base);
  return BINARY_TO_PRODUCT.get(binaryBase(base)) || null;
}

function productFromSegment(segment) {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length) {
    let t = tokens[i];
    if (!t) {
      i++;
      continue;
    }
    // KEY=VALUE 形式的环境变量前缀
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    t = t.replace(/^['"]|['"]$/g, '');
    const base = binaryBase(t);

    if (SKIP_TOKENS.has(base)) {
      i++;
      // sudo -E / env -i 这类选项
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      continue;
    }

    if (base === 'timeout') {
      i += 2; // timeout 30 cmd
      continue;
    }

    if (base === 'cmd' || base === 'cmd.exe') {
      if (String(tokens[i + 1] || '').toLowerCase() === '/c') {
        i += 2;
        continue;
      }
    }

    if (base === 'npx' || base === 'bunx' || base === 'pnpx') {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      return packageProduct(tokens[i]);
    }

    if ((base === 'npm' || base === 'pnpm' || base === 'yarn') && tokens[i + 1]) {
      const sub = String(tokens[i + 1]).toLowerCase();
      if (sub === 'exec' || sub === 'dlx') {
        i += 2;
        while (i < tokens.length && tokens[i].startsWith('-')) i++;
        return packageProduct(tokens[i]);
      }
    }

    return BINARY_TO_PRODUCT.get(base) || null;
  }
  return null;
}

/**
 * 从一段 shell 命令里认出 CLI 产品。
 *
 * 按 `&&`、`;`、`|` 分段，取第一段里真正出现产品的命令。
 * 这样 `cd 项目 && aliyun ecs ...` 仍然记到 aliyun 头上，
 * 而 `git log | head` 只记 git（不会把 head 也算成产品）。
 */
export function commandProduct(command) {
  const segments = String(command || '')
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((s) => s.trim().replace(/^&\s+/, ''))
    .filter(Boolean);
  for (const segment of segments) {
    const product = productFromSegment(segment);
    if (product) return product;
  }
  return null;
}

function extractShellCommands(body) {
  const out = [];
  const re = /\[([A-Za-z][\w.-]*)\s+([^\]]{1,300})\]/g;
  let m;
  while ((m = re.exec(String(body || '')))) {
    if (SHELL_TOOL_NAMES.has(m[1])) out.push(m[2]);
  }
  return out;
}

/**
 * 从全文索引里统计各 Agent 跑过哪些 CLI。
 *
 * 和技能使用率同一个思路：索引已经把工具调用压成一行摘要，不再重读会话。
 * 只查带 shell 工具名标记的行，避免把 3000 多场正文全部读进内存。
 */
export function scanCliUsage({ fresh = false } = {}) {
  const st = indexStat();
  if (!st) {
    return { ready: false, message: '索引还没建，先运行：agent-archive index', calls: [], byAgent: new Map() };
  }

  const cachePath = usageCacheFile();
  if (!fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.indexMtimeMs === st.mtimeMs && cached.indexSize === st.size) {
        return {
          ready: true,
          calls: cached.calls,
          byAgent: new Map(Object.entries(cached.byAgent || {})),
          cached: true,
        };
      }
    } catch {
      /* 没缓存或坏了，重扫 */
    }
  }

  let db;
  try {
    db = openIndex({ create: false });
  } catch {
    db = null;
  }
  if (!db) {
    return { ready: false, message: '索引打不开', calls: [], byAgent: new Map() };
  }

  const calls = [];
  try {
    // 正文可能是压缩的 body_z，body 为 null；先用 fts_text 里的工具名 token
    // 粗筛（超集），再用 extractShellCommands 精确匹配 "[Name " 前缀。
    const like = [...SHELL_TOOL_NAMES]
      .map((n) => `fts_text like '%${n}%'`)
      .join(' or ');
    const rows = db
      .prepare(
        `select agent, id, project, title, start, body${hasBodyZ(db) ? ', body_z' : ''} from doc where ${like}`
      )
      .all();

    for (const r of rows) {
      for (const command of extractShellCommands(readBody(r))) {
        const product = commandProduct(command);
        if (!product) continue;
        calls.push({
          product,
          agent: r.agent,
          session: r.id,
          project: r.project || null,
          title: r.title || null,
          start: r.start || null,
          command: String(command).slice(0, 160),
        });
      }
    }
  } catch {
    /* 表结构不对就当没有 */
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }

  const byAgent = {};
  for (const c of calls) {
    byAgent[c.agent] = (byAgent[c.agent] || 0) + 1;
  }
  const payload = { indexMtimeMs: st.mtimeMs, indexSize: st.size, calls, byAgent };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
  } catch {
    /* 缓存写不进去不影响正确性 */
  }

  return { ready: true, calls, byAgent: new Map(Object.entries(byAgent)), cached: false };
}

function visibilityOf(installs, presentAgents) {
  const all = Array.isArray(presentAgents) && presentAgents.length ? presentAgents : [];
  if (installs.some((i) => i.scope === 'system' || i.scope === 'shared')) {
    return { scope: 'system', agents: all, privateOwners: [] };
  }
  if (installs.length) {
    const owners = [...new Set(installs.flatMap((i) => i.owners || []))].sort();
    return { scope: 'agent', agents: owners, privateOwners: owners };
  }
  return { scope: 'unknown', agents: [], privateOwners: [] };
}

/**
 * 环境层的 CLI 摘要。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fresh] 忽略缓存（CLI 的 --no-cache 用）
 * @param {string[]} [opts.presentAgents] 本机存在的 Agent；不传就只用安装/使用记录里出现的
 */
export function cliSummary({ fresh = false, presentAgents = null } = {}) {
  const installsByProduct = detectCliInstalls({ fresh });
  const usage = scanCliUsage({ fresh });

  const usedByProduct = new Map();
  for (const c of usage.calls || []) {
    if (!usedByProduct.has(c.product)) usedByProduct.set(c.product, new Map());
    const byAgent = usedByProduct.get(c.product);
    if (!byAgent.has(c.agent)) {
      byAgent.set(c.agent, { agent: c.agent, calls: 0, lastUsed: null, examples: [] });
    }
    const u = byAgent.get(c.agent);
    u.calls++;
    if (c.start && (!u.lastUsed || Number(c.start) > u.lastUsed)) u.lastUsed = Number(c.start);
    if (u.examples.length < 2 && !u.examples.includes(c.command)) u.examples.push(c.command);
  }

  const knownAgents = new Set(presentAgents || []);
  for (const list of installsByProduct.values()) {
    for (const inst of list) for (const a of inst.owners || []) knownAgents.add(a);
  }
  for (const a of Object.keys(usage.byAgent || {})) knownAgents.add(a);
  const allAgents = [...knownAgents].sort();

  const products = [];
  for (const p of CLI_CATALOG) {
    const installs = installsByProduct.get(p.id) || [];
    const usedMap = usedByProduct.get(p.id);
    if (!installs.length && !usedMap) continue;

    const usedBy = usedMap
      ? [...usedMap.values()].sort((a, b) => b.calls - a.calls)
      : [];
    const vis = visibilityOf(installs, allAgents);
    const calls = usedBy.reduce((n, u) => n + u.calls, 0);

    products.push({
      id: p.id,
      display: p.display,
      category: p.category,
      binaries: p.binaries,
      detected: installs.length > 0,
      used: calls > 0,
      calls,
      scope: vis.scope,
      // 可见范围只报"能确定看见的"：系统/共享 → 全部；私有 → 那一家。
      // 只有调用记录、没找到可执行文件的产品，可见性是未知，不塞进这里，
      // 否则"用过"会被误读成"看得见"。
      agents: vis.scope === 'system' ? allAgents : vis.agents,
      privateOwners: vis.privateOwners,
      installs: installs
        .slice()
        .sort((a, b) => {
          const rank = (x) => (x.scope === 'system' ? 0 : x.scope === 'shared' ? 1 : 2);
          return rank(a) - rank(b) || a.path.localeCompare(b.path);
        })
        .map((i) => ({
          path: i.path,
          displayPath: tildify(i.path),
          scope: i.scope,
          owners: i.owners || [],
        })),
      usedBy,
      lastUsed: usedBy.reduce((m, u) => (u.lastUsed && (!m || u.lastUsed > m) ? u.lastUsed : m), null),
    });
  }

  products.sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls;
    if (a.detected !== b.detected) return a.detected ? -1 : 1;
    return a.display.localeCompare(b.display, 'zh');
  });

  const byAgent = {};
  for (const a of allAgents) byAgent[a] = { visible: [], used: [] };
  for (const p of products) {
    for (const a of p.agents) {
      if (byAgent[a] && !byAgent[a].visible.includes(p.id)) byAgent[a].visible.push(p.id);
    }
    for (const u of p.usedBy) {
      if (byAgent[u.agent]) byAgent[u.agent].used.push({ id: p.id, calls: u.calls });
    }
  }
  for (const a of Object.keys(byAgent)) {
    byAgent[a].used.sort((x, y) => y.calls - x.calls);
  }

  const privateOnly = products.filter((p) => p.detected && p.scope === 'agent');
  const usedOnly = products.filter((p) => !p.detected && p.used);

  return {
    ready: true,
    categories: CLI_CATEGORY_LABELS,
    products,
    privateOnly,
    usedOnly,
    byAgent,
    summary: {
      products: products.length,
      detected: products.filter((p) => p.detected).length,
      used: products.filter((p) => p.used).length,
      calls: products.reduce((n, p) => n + p.calls, 0),
      systemVisible: products.filter((p) => p.detected && p.scope === 'system').length,
      privateOnly: privateOnly.length,
      usedOnly: usedOnly.length,
      agentsWithCli: Object.values(byAgent).filter((x) => x.visible.length).length,
    },
    note:
      '安装位置是读取到的事实；可见范围按可执行文件所在目录推断（系统/共享目录对各家可见，' +
      'Agent 私有目录只对那一家可见）。调用次数按索引里的命令摘要统计，' +
      '可能包含同一命令在正文里重复出现的次数——用它判断"哪家真的用过"，不要当成精确调用数。',
    usageReady: usage.ready,
    usageMessage: usage.ready ? undefined : usage.message,
    cached: usage.cached,
  };
}

export { CLI_CATALOG, CATALOG_BY_ID };
