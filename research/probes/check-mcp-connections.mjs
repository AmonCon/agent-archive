import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/**
 * 逐个 Agent 端到端验收：能不能真的连上 ADB Supabase 数据库。
 *
 * 完整链路（缺一步都不算通）：
 *   1. initialize + tools/list   进程活着
 *   2. list projects             阿里云凭证有效、权限够
 *   3. get project api keys      能访问目标项目、拿得到连接信息
 *   4. execute_sql select 1      数据库真的通
 *
 * 两个实现细节：
 *   - MCP 的返回是**双层嵌套**的（text 字段里又是一段 JSON），
 *     所以逐层解开再取值，不能直接对字符串做正则。
 *   - service_role key 靠 JWT 的 payload 里的 role 字段识别，
 *     不依赖 name 字段的措辞（各家叫法不一致）。
 *
 * 密钥只在内存里用，不打印、不落盘。
 */

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const TIMEOUT_MS = 120000;

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

/* ------------------------------ 解析配置 ------------------------------ */

function jsonServer(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  let found = null;
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.env && o.env.ALIBABA_CLOUD_ACCESS_KEY_ID) {
      found = { command: o.command, args: Array.isArray(o.args) ? o.args : [], cwd: o.cwd, env: o.env };
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(j);
  return found;
}

function tomlServer(file, name) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = { command: null, args: [], cwd: null, env: {} };
  let inMain = false;
  let inEnv = false;
  let inArgs = false;

  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      const sec = line.match(/^\s*\[([^\]]+)\]/);
      const s = sec ? sec[1] : '';
      inMain = s === `mcp_servers.${name}`;
      inEnv = s === `mcp_servers.${name}.env`;
      inArgs = false;
      continue;
    }
    if (!inMain && !inEnv) continue;

    if (inArgs) {
      for (const m of line.match(/'[^']*'|"[^"]*"/g) || []) out.args.push(m.slice(1, -1));
      if (/\]\s*$/.test(line)) inArgs = false;
      continue;
    }

    const kv = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const [, k, raw] = kv;

    if (k === 'command') out.command = raw.replace(/^["']|["']$/g, '');
    else if (k === 'cwd') out.cwd = raw.replace(/^["']|["']$/g, '');
    else if (k === 'args') {
      const inline = raw.replace(/^\[/, '').replace(/\]\s*$/, '');
      for (const m of inline.match(/'[^']*'|"[^"]*"/g) || []) out.args.push(m.slice(1, -1));
      if (!/\]\s*$/.test(raw)) inArgs = true;
    } else if (/^[A-Z_]+$/.test(k)) out.env[k] = raw.replace(/^["']|["']$/g, '');
  }
  return out.command ? out : null;
}

/* ------------------------------ 工具 ------------------------------ */

function textOf(res) {
  if (!res || !Array.isArray(res.content)) return '';
  return res.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

/**
 * 逐层解开 MCP 的双层包装，直到拿到真正的内容对象。
 * 结构形如 {content:[{type:"text",text:"<又一段 JSON>"}]}。
 */
function unwrap(raw) {
  let cur = raw;
  for (let i = 0; i < 5; i++) {
    let parsed;
    try {
      parsed = JSON.parse(cur);
    } catch {
      return null;
    }
    if (
      parsed &&
      Array.isArray(parsed.content) &&
      parsed.content[0] &&
      typeof parsed.content[0].text === 'string'
    ) {
      cur = parsed.content[0].text;
      continue;
    }
    return parsed;
  }
  return null;
}

/** 从 JWT 的 payload 里读 role，用来识别 service_role key。 */
function jwtRole(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.role || null;
  } catch {
    return null;
  }
}

/* ------------------------------ MCP 会话 ------------------------------ */

function openSession({ command, args, cwd, env }) {
  const usesNpx = /npx/i.test(String(command));
  const child = spawn(command, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: usesNpx,
    windowsHide: true,
  });

  let buf = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const w = pending.get(m.id);
      if (w) {
        pending.delete(m.id);
        w(m);
      }
    }
  });

  const rpc = (method, params, ms = 45000) => {
    const id = nextId++;
    const m = { jsonrpc: '2.0', id, method };
    if (params !== undefined) m.params = params;
    try {
      child.stdin.write(JSON.stringify(m) + '\n');
    } catch {
      return Promise.resolve({ error: { message: 'stdin 已关闭' } });
    }
    return new Promise((res) => {
      pending.set(id, res);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          res({ error: { message: '响应超时' } });
        }
      }, ms);
    });
  };

  return { child, rpc };
}

/* ------------------------------ 跑一个配置 ------------------------------ */

async function testOne(server) {
  const started = Date.now();
  const { child, rpc } = openSession(server);

  const done = (r) => {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    return { ...r, ms: Date.now() - started };
  };

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-archive-verify', version: '1' },
    });
    if (!init.result) return done({ ok: false, note: 'initialize 失败' });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tl = await rpc('tools/list');
    const tools = (tl.result && tl.result.tools) || [];
    if (!tools.length) return done({ ok: false, note: '没有可用工具' });

    // ---- 1. 列项目 ----
    const lr = await rpc('tools/call', { name: 'list_aliyun_supabase_projects', arguments: { max_results: 10 } });
    if (lr.error) return done({ ok: false, note: '列项目无响应' });
    if (lr.result && lr.result.isError) {
      return done({ ok: false, note: '列项目失败: ' + textOf(lr.result).slice(0, 120) });
    }
    const listData = unwrap(textOf(lr.result));
    const projects = (listData && Array.isArray(listData.items)) ? listData.items : [];
    if (!projects.length) return done({ ok: false, note: '看不到任何项目', toolCount: tools.length });

    const project = projects[0];
    const url = project.publicConnectUrl;
    if (!url) return done({ ok: false, note: '项目里没有 publicConnectUrl', toolCount: tools.length, projectCount: projects.length });

    // ---- 2. 取连接信息，找 service_role ----
    const kr = await rpc('tools/call', { name: 'get_supabase_project_api_keys', arguments: {} });
    if (kr.error) return done({ ok: false, note: '取连接信息无响应' });
    if (kr.result && kr.result.isError) {
      return done({
        ok: false,
        note: '取连接信息失败: ' + textOf(kr.result).slice(0, 120),
        toolCount: tools.length,
        projectCount: projects.length,
      });
    }
    const keyData = unwrap(textOf(kr.result));
    const apiKeys = (keyData && Array.isArray(keyData.apiKeys)) ? keyData.apiKeys : [];
    const roles = apiKeys.map((k) => jwtRole(k.apiKey)).filter(Boolean);
    const service = apiKeys.find((k) => jwtRole(k.apiKey) === 'service_role');
    if (!service) {
      return done({
        ok: false,
        note: `没找到 service_role key（拿到 ${apiKeys.length} 个，role: ${roles.join('/') || '未知'}）`,
        toolCount: tools.length,
        projectCount: projects.length,
      });
    }

    // ---- 3. 真的查一次 ----
    const sr = await rpc(
      'tools/call',
      { name: 'execute_sql', arguments: { url, api_key: service.apiKey, sql: 'select 1 as ok' } },
      60000
    );
    if (sr.error) return done({ ok: false, note: 'SQL 无响应' });
    if (sr.result && sr.result.isError) {
      return done({ ok: false, note: 'SQL 被拒: ' + textOf(sr.result).slice(0, 140) });
    }
    const sqlData = unwrap(textOf(sr.result));
    const rows = sqlData && Array.isArray(sqlData) ? sqlData : sqlData && sqlData.rows ? sqlData.rows : null;
    const sample = JSON.stringify(sqlData).slice(0, 80);
    const sqlOk = /"ok"\s*:\s*1/.test(sample) || /"ok"\s*:\s*1/.test(textOf(sr.result));

    return done({
      ok: sqlOk,
      toolCount: tools.length,
      projectCount: projects.length,
      project: project.projectName || project.projectId,
      sql: sqlOk ? 'select 1 成功' : '返回: ' + sample,
    });
  } catch (e) {
    return done({ ok: false, note: '异常: ' + e.message });
  }
}

/* ------------------------------ 主流程 ------------------------------ */

const results = [];

for (const t of TARGETS) {
  if (!fs.existsSync(t.file)) {
    results.push({ agent: t.agent, ok: false, note: '配置文件不存在' });
    continue;
  }
  const server = t.kind === 'toml' ? tomlServer(t.file, t.name) : jsonServer(t.file);
  if (!server) {
    results.push({ agent: t.agent, ok: false, note: '解析不出 MCP 定义' });
    continue;
  }

  let cmd = server.command;
  let args = server.args;
  if (/^cmd(\.exe)?$/i.test(String(cmd))) {
    const i = args.findIndex((a) => /\.js$/i.test(String(a)));
    if (i >= 0) {
      cmd = process.execPath;
      args = args.slice(i);
    }
  }

  process.stdout.write(`测试 ${t.agent}… `);
  const r = await testOne({ command: cmd, args, cwd: server.cwd, env: server.env });
  console.log(r.ok ? '通过' : '失败');
  results.push({ agent: t.agent, ...r });
}

console.log('\n=== 结果 ===\n');
let pass = 0;
for (const r of results) {
  const detail = [
    r.toolCount ? `${r.toolCount} 工具` : null,
    r.project ? `项目 ${r.project}` : null,
    r.sql || null,
    r.note || null,
    r.ms ? `${(r.ms / 1000).toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  console.log(`${r.ok ? '✓' : '✗'} ${r.agent.padEnd(28)} ${detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} 个 Agent 能完整连上数据库`);
process.exit(pass === results.length ? 0 : 1);
