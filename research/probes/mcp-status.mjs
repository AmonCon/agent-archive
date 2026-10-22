import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 清点当前配置状态：哪些 Agent 的 MCP 配置用的是哪个 key。
 *
 * 只读。输出每个配置文件的：
 *   - key 指纹（前 8 位，够区分，不足以复现）
 *   - 启动方式
 *   - 是否带 project-id
 *
 * 不打印 secret，也不打印完整 key。
 */

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

/**
 * 本次要检查的配置——都是上一轮清点出来、真正含 key 的文件。
 * 新增 Agent 时往这里加一行。
 */
const TARGETS = [
  { agent: 'ZCode', file: path.join(home, '.zcode', 'cli', 'config.json'), kind: 'json' },
  { agent: 'Claude Code', file: path.join(home, '.claude.json'), kind: 'json' },
  { agent: 'Codex', file: path.join(home, '.codex', 'config.toml'), kind: 'toml', name: 'adbsupabase' },
  { agent: 'Qoder', file: path.join(home, '.qoder', 'mcp.json'), kind: 'json' },
  { agent: 'Gemini (config)', file: path.join(home, '.gemini', 'config', 'mcp_config.json'), kind: 'json' },
  { agent: 'Gemini (antigravity-ide)', file: path.join(home, '.gemini', 'antigravity-ide', 'mcp_config.json'), kind: 'json' },
  { agent: 'Gemini (antigravity-backup)', file: path.join(home, '.gemini', 'antigravity-backup', 'mcp_config.json'), kind: 'json' },
  { agent: 'Trae', file: path.join(appData, 'Trae', 'User', 'mcp.json'), kind: 'json' },
  { agent: 'Qoder (cache)', file: path.join(appData, 'Qoder', 'SharedClientCache', 'mcp.json'), kind: 'json' },
  { agent: 'Qoder (cache/ext)', file: path.join(appData, 'Qoder', 'SharedClientCache', 'extension', 'local', 'mcp.json'), kind: 'json' },
];

/** 从 JSON 里找所有带 ACCESS_KEY 的 server。 */
function jsonServers(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    const env = o.env;
    if (env && typeof env === 'object' && env.ALIBABA_CLOUD_ACCESS_KEY_ID) {
      out.push({
        command: o.command,
        args: Array.isArray(o.args) ? o.args : [],
        cwd: o.cwd,
        env,
      });
    }
    Object.values(o).forEach(walk);
  };
  walk(j);
  return out;
}

/** 从 Codex 的 config.toml 取 [mcp_servers.<name>] 和它的 .env 段。 */
function tomlServer(file, name) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = { command: null, args: [], cwd: null, env: {} };
  let section = '';

  for (const line of text.split('\n')) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (section !== `mcp_servers.${name}` && section !== `mcp_servers.${name}.env`) continue;

    const kv = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const [, k, raw] = kv;

    if (k === 'command') out.command = raw.replace(/^["']|["']$/g, '');
    else if (k === 'cwd') out.cwd = raw.replace(/^["']|["']$/g, '');
    else if (k === 'args') {
      // TOML 数组可能跨行，这里只取单行形式；跨行的由调用方兜底
      const items = raw.match(/'[^']*'|"[^"]*"/g) || [];
      out.args = items.map((s) => s.slice(1, -1));
    } else if (/^[A-Z_]+$/.test(k)) {
      out.env[k] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return out.command ? out : null;
}

/** Codex 的 args 是跨行数组，单独解析一次。 */
function tomlArgsMultiline(file, name) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let inBlock = false;
  let inArgs = false;
  const args = [];
  for (const l of lines) {
    if (/^\s*\[/.test(l)) {
      inBlock = new RegExp(`^\\s*\\[mcp_servers\\.${name}(\\]|\\.)`).test(l);
      inArgs = false;
      continue;
    }
    if (!inBlock) continue;
    if (/^\s*args\s*=\s*\[/.test(l)) {
      inArgs = true;
      const inline = l.replace(/^\s*args\s*=\s*\[/, '').replace(/\]\s*$/, '');
      for (const m of inline.match(/'[^']*'|"[^"]*"/g) || []) args.push(m.slice(1, -1));
      if (/\]\s*$/.test(l)) inArgs = false;
      continue;
    }
    if (inArgs) {
      for (const m of l.match(/'[^']*'|"[^"]*"/g) || []) args.push(m.slice(1, -1));
      if (/\]\s*$/.test(l)) inArgs = false;
    }
  }
  return args;
}

const fp = (v) => (v ? String(v).slice(0, 8) + '…' : '(无)');

const rows = [];

for (const t of TARGETS) {
  if (!fs.existsSync(t.file)) {
    rows.push({ agent: t.agent, status: 'missing', note: '文件不存在' });
    continue;
  }

  let server = null;
  if (t.kind === 'json') {
    const all = jsonServers(t.file);
    server = all[0] || null;
  } else {
    server = tomlServer(t.file, t.name);
    if (server) server.args = tomlArgsMultiline(t.file, t.name);
  }

  if (!server) {
    rows.push({ agent: t.agent, status: 'noparse', note: '解析不出 server 定义' });
    continue;
  }

  const id = server.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const cmd = String(server.command || '');
  const usesNpx = /npx/i.test(cmd);
  const hasProjectId = server.args.some((a) => String(a).startsWith('--project-id'));

  rows.push({
    agent: t.agent,
    status: 'ok',
    file: t.file,
    keyId: id,
    fingerprint: fp(id),
    launch: usesNpx ? 'npx' : 'node（本地安装）',
    hasProjectId,
    command: cmd,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
  });
}

const rel = (p) => (p ? p.replace(home, '~') : '');

console.log('=== Agent MCP 配置现状 ===\n');
for (const r of rows) {
  if (r.status !== 'ok') {
    console.log(`✗ ${r.agent.padEnd(28)} ${r.note}`);
    continue;
  }
  console.log(`✓ ${r.agent.padEnd(28)} key ${r.fingerprint}`);
  console.log(`${' '.repeat(30)}启动: ${r.launch}${r.hasProjectId ? ' · 带 --project-id' : ''}`);
  console.log(`${' '.repeat(30)}${rel(r.file)}`);
}

// 一致性比"是不是某一把特定 key"更有意义：
// 有配置漏改时，这里会直接暴露出来，而不需要脚本知道具体 key 值。
const okRows = rows.filter((r) => r.status === 'ok');
const distinct = new Map();
for (const r of okRows) distinct.set(r.keyId, (distinct.get(r.keyId) || 0) + 1);

console.log(`\n合计 ${okRows.length} 个配置，${distinct.size} 把不同的 key`);
for (const [id, n] of distinct) console.log(`  ${fp(id)}  用在 ${n} 个配置`);

const consistent = distinct.size <= 1 && okRows.length > 0;
console.log(consistent ? '所有配置使用同一把 key ✓' : '存在不一致，需要检查 ✗');
process.exit(consistent ? 0 : 1);
process.exit(oldCount ? 1 : 0);
