import http from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:7799';

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(BASE + p, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      })
      .on('error', reject);
  });
}

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`);
  }
};

console.log('=== 页面 ===');
for (const p of ['/', '/env', '/env?tab=mcp', '/env?tab=skills', '/env?tab=usage', '/env?tab=memory', '/env?tab=audit']) {
  const r = await get(p);
  const ok = r.status === 200 && /text\/html/.test(r.type) && r.body.includes('<!doctype html>');
  check(`${p} 返回 HTML`, ok, `status=${r.status} len=${r.body.length}`);

  // 每页都要有 tab 导航
  if (ok && p.startsWith('/env')) {
    check(`  ${p} 有 tab 导航`, r.body.includes('class="tabs"'));
  }
}

console.log('\n=== 非法 tab 回落 ===');
const bad = await get('/env?tab=<script>alert(1)</script>');
check('非法 tab 不报错且不注入脚本', bad.status === 200 && !bad.body.includes('<script>alert(1)</script>'));
check('非法 tab 回落到总览', bad.body.includes('各 Agent 的能力面'));

console.log('\n=== JSON 接口 ===');
for (const [p, key] of [
  ['/api/env', 'summary'],
  ['/api/env?tab=mcp', 'services'],
  ['/api/env?tab=skills', 'skills'],
  ['/api/env?tab=usage', 'installed'],
  ['/api/env?tab=memory', 'locations'],
  ['/api/env?tab=audit', 'findings'],
]) {
  const r = await get(p);
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {}
  check(`${p} 返回 JSON 且含 ${key}`, r.status === 200 && j && j[key] !== undefined, `status=${r.status}`);
}

console.log('\n=== 页面内容正确性 ===');
const ov = await get('/env');
check('总览显示 Agent 数', /\d+/.test(ov.body) && ov.body.includes('Agent 有数据'));
check('总览列出 supabase', ov.body.includes('supabase'));
check('总览列出 gitnexus', ov.body.includes('gitnexus'));

const mcp = await get('/env?tab=mcp');
check('MCP 页显示别名', mcp.body.includes('adbsupabase') || mcp.body.includes('别名'));
check('MCP 页提到安装形态不一致', mcp.body.includes('安装形态不一致'));

const usage = await get('/env?tab=usage');
check('使用率页有百分比', /\d+\.\d%/.test(usage.body));
check('使用率页说明覆盖范围', usage.body.includes('Codex') && usage.body.includes('SKILL.md'));

const mem = await get('/env?tab=memory');
check('记忆页区分指令与记忆', mem.body.includes('指令') && mem.body.includes('记忆'));

console.log('\n=== 只读约束 ===');
// 非 GET 必须 405
const post = await new Promise((resolve) => {
  const req = http.request(BASE + '/env', { method: 'POST' }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.end();
});
check('POST 被拒绝', post.status === 405, `status=${post.status}`);

// 非本机 Host 必须 403
const evil = await new Promise((resolve) => {
  const req = http.request(
    BASE + '/env',
    { headers: { host: 'evil.example.com' } },
    (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }
  );
  req.end();
});
check('外部 Host 被拒绝（防 DNS rebinding）', evil.status === 403, `status=${evil.status}`);

console.log('\n=== 凭证泄漏检查（最关键）===');
const all = [];
for (const p of ['/env', '/env?tab=mcp', '/env?tab=skills', '/env?tab=memory', '/env?tab=audit', '/api/env']) {
  all.push((await get(p)).body);
}
const blob = all.join('\n');
const leaks = [
  { name: '阿里云 AK 值', re: /LTAI[0-9A-Za-z]{8,}/ },
  { name: 'Secret 值', re: /bw4etJIp/ },
];
for (const l of leaks) {
  check(`页面里没有 ${l.name}`, !l.re.test(blob));
}
check('但保留了键名（"有凭证"要能报出来）', blob.includes('ALIBABA_CLOUD_ACCESS_KEY_SECRET'));

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}（${failed} 项失败）`);
process.exit(failed ? 1 : 0);
