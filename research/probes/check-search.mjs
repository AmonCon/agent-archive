import http from 'node:http';

function get(p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:7788' + p, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

// 中文搜索
const api = await get('/api/search?q=' + encodeURIComponent('迁移'));
let j = null;
try {
  j = JSON.parse(api.body);
} catch {
  j = null;
}
push('/api/search 返回 200', api.code === 200, api.code);
push('/api/search 有结果', !!j && j.hits.length > 0, j ? j.hits.length : '-');
push('摘录可读（不含二元组碎片）', !!j && j.hits.every((h) => !/[\u4e00-\u9fa5] [\u4e00-\u9fa5] [\u4e00-\u9fa5]/.test(h.snippet)));

// 英文搜索
const en = await get('/api/search?q=supabase');
let je = null;
try {
  je = JSON.parse(en.body);
} catch {
  je = null;
}
push('英文搜索有结果', !!je && je.hits.length > 0, je ? je.hits.length : '-');

// 缺参数
const noq = await get('/api/search');
push('缺 q 返回 400', noq.code === 400, noq.code);

// 页面
const page = await get('/search?q=' + encodeURIComponent('迁移'));
push('/search 页面 200', page.code === 200, page.body.length + 'B');
push('页面有关键词高亮', /<mark>/.test(page.body));
push('页面通过 esc 转义正文', /&lt;/.test(page.body) || !/<script>alert/.test(page.body));

// 首页搜索框
const home = await get('/');
push('首页有搜索入口', home.body.includes('class="search topbar"'));

// 空查询
const empty = await get('/search');
push('空查询显示引导', empty.code === 200 && empty.body.includes('已索引'));

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
