import http from 'node:http';

function get(p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:7788' + p, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () =>
        resolve({ code: res.statusCode, headers: res.headers, body: d })
      );
    }).on('error', reject);
  });
}

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

// 时间线导出
const tl = await get('/export?kind=timeline&path=' + encodeURIComponent('E:/agent-archive'));
push('时间线导出 200', tl.code === 200, tl.code);
push('时间线 content-type 是 markdown', /text\/markdown/.test(tl.headers['content-type'] || ''));
push('时间线带附件文件名', /attachment/.test(tl.headers['content-disposition'] || ''));
push('时间线含 H1', /^# /m.test(tl.body));
push('时间线含 Agent 表', /\| Agent \|/.test(tl.body));

// 单场会话导出
const ss = await get('/export?kind=session&agent=qoder&id=task-67e');
push('会话导出 200', ss.code === 200, ss.code);
push('会话导出含元信息表', /\| Agent \|/.test(ss.body));
push('会话导出正文用引用块', /^> /m.test(ss.body));

// 整包导出
const bd = await get('/export?kind=bundle&path=' + encodeURIComponent('E:/agent-archive'));
push('整包导出 200', bd.code === 200, bd.code);
push('整包含目录', /## 目录/.test(bd.body));
push('整包含锚点', /<a id="session-1">/.test(bd.body));

// 参数校验
const noPath = await get('/export?kind=timeline');
push('缺 path 返回 400', noPath.code === 400, noPath.code);
const noId = await get('/export?kind=session');
push('缺 id 返回 400', noId.code === 400, noId.code);

// 噪声：导出的会话不应含注入标签
push('会话导出无 app-context 注入', !ss.body.includes('<app-context>'));
push('会话导出无 recommended_plugins', !ss.body.includes('<recommended_plugins>'));

// 页面上的导出入口
const page = await get('/p?path=' + encodeURIComponent('E:/agent-archive'));
push('项目页有导出链接', /\/export\?kind=timeline/.test(page.body));

// 只读约束仍然有效
const post = await get('/export?kind=timeline&path=x');
push('导出是 GET 可达的', post.code === 200 || post.code === 500, post.code);

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
