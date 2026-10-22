import http from 'node:http';

function req(opts) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 7788, ...opts }, (x) => {
      let d = '';
      x.on('data', (c) => (d += c));
      x.on('end', () => resolve({ code: x.statusCode, body: d }));
    });
    r.on('error', reject);
    r.end();
  });
}

const checks = [];

const hostBad = await req({ path: '/', headers: { host: 'evil.com' } });
checks.push(['恶意 Host 头被拒', hostBad.code === 403, hostBad.code]);

const post = await req({ path: '/', method: 'POST' });
checks.push(['POST 被拒', post.code === 405, post.code]);

const traversal = await req({ path: '/api/session?id=..%2F..%2Fetc%2Fpasswd' });
checks.push(['目录穿越 id 不返回内容', traversal.code !== 200, traversal.code]);

const missing = await req({ path: '/nope' });
checks.push(['未知路径 404', missing.code === 404, missing.code]);

const noId = await req({ path: '/api/session' });
checks.push(['缺 id 返回 400', noId.code === 400, noId.code]);

const page = await req({ path: '/s?agent=zcode&id=session_50af67a1' });
// 页面自身的按需加载脚本是唯一允许的 <script>，且不含 </script> 逃逸
const scriptBlocks = page.body.match(/<script[\s\S]*?<\/script>/gi) || [];
checks.push(['仅有一个内联脚本', scriptBlocks.length === 1, scriptBlocks.length]);
checks.push(['正文已转义', /&lt;/.test(page.body), '']);
checks.push(['折叠块使用按需加载', /class="folded"/.test(page.body), '']);
checks.push(['页面含系统折叠块', /class="msg system"/.test(page.body), '']);
checks.push(['页面不含外部资源引用', !/<script[^>]+src=|<link[^>]+href="http/.test(page.body), '']);

const timeline = await req({ path: '/p?path=E%3A%2Fagent-archive' });
checks.push(['时间线页 200', timeline.code === 200, timeline.code]);
checks.push(['时间线含会话链接', /href="\/s\?agent=/.test(timeline.body), '']);

const apiSession = await req({ path: '/api/session?agent=codex&id=019a30ad' });
let apiOk = false;
let msgCount = 0;
try {
  const j = JSON.parse(apiSession.body);
  apiOk = Array.isArray(j.messages) && typeof j.session.id === 'string';
  msgCount = j.messages.length;
} catch {
  apiOk = false;
}
checks.push(['/api/session 结构正确', apiOk, `${msgCount} 条消息`]);

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
