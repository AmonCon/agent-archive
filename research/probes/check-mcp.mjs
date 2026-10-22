import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', '..', 'src', 'mcp.js');

const child = spawn(process.execPath, ['--no-warnings', serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;
const stderr = [];

child.stderr.on('data', (c) => stderr.push(String(c)));

child.stdout.on('data', (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('!! 非 JSON 输出:', line.slice(0, 200));
      continue;
    }
    const wait = pending.get(msg.id);
    if (wait) {
      pending.delete(msg.id);
      wait(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`超时: ${method}`));
    }, 60000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

try {
  // 1. 握手
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  push('initialize 成功', !!init.result, init.result && init.result.protocolVersion);
  push('声明 tools 能力', !!(init.result && init.result.capabilities && init.result.capabilities.tools));
  push('有 serverInfo', !!(init.result && init.result.serverInfo));
  notify('notifications/initialized');

  // 2. 列工具
  const list = await rpc('tools/list');
  const tools = (list.result && list.result.tools) || [];
  push('tools/list 返回工具', tools.length >= 8, `${tools.length} 个`);
  push('每个工具都有 inputSchema', tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  push('每个工具都标记只读', tools.every((t) => t.annotations && t.annotations.readOnlyHint === true));

  const names = tools.map((t) => t.name);
  push('含 list_projects', names.includes('list_projects'));
  push('含 project_timeline', names.includes('project_timeline'));
  push('含 search_sessions', names.includes('search_sessions'));
  push('含 read_session', names.includes('read_session'));
  push('含 read_digest', names.includes('read_digest'));
  push('含 read_session_summary', names.includes('read_session_summary'));

  // 3. 调 list_projects
  const lp = await rpc('tools/call', { name: 'list_projects', arguments: {} });
  const lpData = lp.result && lp.result.structuredContent;
  push('list_projects 有项目', !!lpData && lpData.projects.length > 0, lpData && `${lpData.projects.length} 个项目`);
  push('list_projects 不含正文', !!lpData && !JSON.stringify(lpData).includes('"text"'));

  // 4. 调 project_timeline
  const project = lpData.projects[0].project;
  const tl = await rpc('tools/call', { name: 'project_timeline', arguments: { project, limit: 5 } });
  const tlData = tl.result && tl.result.structuredContent;
  push('project_timeline 返回会话', !!tlData && tlData.sessions.length > 0, tlData && `${tlData.sessions.length} 条`);
  push('project_timeline 遵守 limit', !!tlData && tlData.sessions.length <= 5);
  push('project_timeline 标记是否截断', !!tlData && typeof tlData.truncated === 'boolean');

  // 5. 调 search_sessions
  const se = await rpc('tools/call', { name: 'search_sessions', arguments: { query: '迁移', limit: 3 } });
  const seData = se.result && se.result.structuredContent;
  push('search 有结果', !!seData && Array.isArray(seData.hits), seData && `${seData.hits && seData.hits.length} 条`);

  // 6. 调 read_session（最关键的：必须有界）
  if (tlData && tlData.sessions.length) {
    const s = tlData.sessions[0];
    const rd = await rpc('tools/call', {
      name: 'read_session',
      arguments: { id: s.id, agent: s.agent, maxChars: 500 },
    });
    const rdData = rd.result && rd.result.structuredContent;
    push('read_session 返回正文', !!rdData && typeof rdData.text === 'string', rdData && `${rdData.returnedChars} 字`);
    push('read_session 遵守 maxChars', !!rdData && rdData.returnedChars <= 500, rdData && `${rdData.returnedChars}`);
    push('read_session 报告总量', !!rdData && typeof rdData.totalChars === 'number', rdData && `总 ${rdData.totalChars}`);
    push('read_session 给出续读位置', !!rdData && (rdData.hasMore === false || typeof rdData.nextOffset === 'number'));

    // 分段续读
    if (rdData && rdData.hasMore) {
      const rd2 = await rpc('tools/call', {
        name: 'read_session',
        arguments: { id: s.id, agent: s.agent, maxChars: 500, offset: rdData.nextOffset },
      });
      const d2 = rd2.result && rd2.result.structuredContent;
      push('分段续读可用', !!d2 && d2.offset === rdData.nextOffset, d2 && `offset ${d2.offset}`);
      push('续读内容与首段不同', !!d2 && d2.text !== rdData.text);
    }
  }

  // 7. 视图层工具：没有摘要时必须老实说"没有"，不能现编
  // 用一个必定没有摘要的路径，否则测试结果会随本地摘要库变化
  const dg = await rpc('tools/call', {
    name: 'read_digest',
    arguments: { project: 'E:/__agent_archive_no_digest__' },
  });
  const dgData = dg.result && dg.result.structuredContent;
  push('read_digest 可用', !!dgData && typeof dgData.exists === 'boolean');
  push('无摘要时给出提示而非编造', !!dgData && dgData.exists === false && !!dgData.hint, dgData && String(dgData.hint || '').slice(0, 40));

  const ss = await rpc('tools/call', {
    name: 'read_session_summary',
    arguments: { id: tlData.sessions[0].id, agent: tlData.sessions[0].agent },
  });
  const ssData = ss.result && ss.result.structuredContent;
  push('read_session_summary 可用', !!ssData && typeof ssData.exists === 'boolean');

  // 8. 统计里要能看到视图层进度
  const st = await rpc('tools/call', { name: 'session_stats', arguments: {} });
  const stData = st.result && st.result.structuredContent;
  push('stats 含 derived 段', !!stData && !!stData.derived, stData && stData.derived ? `摘要 ${stData.derived.sessionSummaries} 场` : '');

  // 9. 错误处理
  const bad = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  push('未知工具返回错误', !!bad.error || (bad.result && bad.result.isError), bad.error && bad.error.code);

  const noId = await rpc('tools/call', { name: 'read_session', arguments: { id: 'zzzz_nonexistent' } });
  const noIdData = noId.result && noId.result.structuredContent;
  push('找不到的会话有明确错误', !!noIdData && !!noIdData.error, noIdData && noIdData.error);

  const unknown = await rpc('no/such/method');
  push('未知方法返回 -32601', !!unknown.error && unknown.error.code === -32601);

  // 8. ping
  const ping = await rpc('ping');
  push('ping 有响应', !!ping.result);

  // 9. stdout 纯净性
  push('stderr 有日志（不污染 stdout）', stderr.length > 0);
} catch (e) {
  push('测试异常', false, e.message);
} finally {
  child.stdin.end();
  child.kill();
}

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
