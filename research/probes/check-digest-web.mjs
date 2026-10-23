import http from 'node:http';
import { putArtifact, removeArtifact } from '../../src/derive.js';
import { projectSubject } from '../../src/digest.js';

/**
 * 网页上的摘要展示测试。
 *
 * 不调模型：直接往衍生库塞一份带 markdown 结构的假摘要，
 * 验证 /api/digest 与项目页的渲染，测完删掉。
 */

const PROJECT = 'E:/car';
const SUBJECT = projectSubject(PROJECT);
const MARKER = '测试摘要标记ABC';

const FAKE = `## 项目在做什么
这是一个 **测试用的** 摘要，用来验证渲染。

### 演进主线
1. 第一条主线
2. 第二条主线，带 \`行内代码\`

### 未完成事项
- 未完成甲
- 未完成乙

注意：这里有一段 **加粗** 和 <b>不该执行的标签</b>。
${MARKER}`;

putArtifact({
  kind: 'project_digest',
  subject: SUBJECT,
  sourceHash: 'testhash0001',
  promptVersion: 'v1',
  model: 'mock-display',
  body: FAKE,
  tokensIn: 100,
  tokensOut: 50,
});

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

try {
  // API
  const api = await get('/api/digest?path=' + encodeURIComponent(PROJECT));
  let j = null;
  try {
    j = JSON.parse(api.body);
  } catch {
    j = null;
  }
  push('/api/digest 返回 200', api.code === 200, api.code);
  push('报告摘要存在', !!j && j.exists === true);
  push('带模型与生成时间', !!j && !!j.model && !!j.generatedAt, j && j.model);
  push('返回 markdown 原文', !!j && String(j.digest).includes(MARKER));

  // 缺参数
  const noPath = await get('/api/digest');
  push('缺 path 返回 400', noPath.code === 400, noPath.code);

  // 页面渲染
  const page = await get('/p?path=' + encodeURIComponent(PROJECT));
  push('项目页 200', page.code === 200, page.body.length + 'B');
  push('页面含摘要块', page.body.includes('class="digest"'));
  push('渲染了标题', /<h[2-5]>.*项目在做什么/.test(page.body));
  push('渲染了加粗', /<strong>测试用的<\/strong>/.test(page.body));
  push('渲染了有序列表', /<ol>/.test(page.body));
  push('渲染了无序列表', /<ul>/.test(page.body));
  push('渲染了行内代码', /<code>行内代码<\/code>/.test(page.body));
  push('正文里的标签被转义', page.body.includes('&lt;b&gt;不该执行的标签&lt;/b&gt;'));
  push('没有裸的 markdown 星号', !page.body.includes('**测试用的**'));

  // 不存在的项目
  const none = await get('/api/digest?path=' + encodeURIComponent('E:/agent-archive'));
  let jn = null;
  try {
    jn = JSON.parse(none.body);
  } catch {
    jn = null;
  }
  push('无摘要项目返回 exists:false', !!jn && jn.exists === false, jn && String(jn.hint || '').slice(0, 30));
} catch (e) {
  push('测试异常', false, e.message);
} finally {
  const n = removeArtifact({ kind: 'project_digest', subject: SUBJECT });
  console.log(`(清理了 ${n} 条测试数据)\n`);
}

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
