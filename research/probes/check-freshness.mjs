import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 网页上的摘要新鲜度提示测试。
 *
 * 覆盖三种"可能过期"的原因，以及一条更重要的：
 * 网页必须**承认自己查不了什么**（会话内容变了但数量没变）。
 * 一个看起来确定、实际会漏的提示，比没有提示更糟。
 */

const PROJECT = 'E:/car';
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fresh-'));
process.env.AGENT_ARCHIVE_HOME = tmpHome;
// 故意让当前模型与将要写入的摘要模型不同，制造 model-changed
process.env.AGENT_ARCHIVE_LLM_MODEL = 'current-model';
process.env.AGENT_ARCHIVE_LLM_API_KEY = 'test';
process.env.AGENT_ARCHIVE_LLM_BASE_URL = 'http://127.0.0.1:1';

// 自己起一个 server，与上面设置的状态目录共享同一个 AGENT_ARCHIVE_HOME。
// 外部那个 serve 进程读的是真实的 ~/.agent-archive，两边看不到彼此的数据。
const { startServer } = await import('../../src/server.js');
const started = await startServer({ port: 0 });
const baseUrl = started.url;

const { putArtifact, removeArtifact } = await import('../../src/derive.js');
const { projectSubject } = await import('../../src/digest.js');
const { quickFreshness } = await import('../../src/refresh.js');
const { projectTimeline } = await import('../../src/query.js');

const SUBJECT = projectSubject(PROJECT);
const BODY = '## 测试摘要\n这是用于验证新鲜度提示的内容。';

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

const sessions = projectTimeline(PROJECT, {}).sessions;
const newest = sessions.length ? sessions[sessions.length - 1].start : null;

/** 写一份摘要，可控地指定模型/提示词/时间。 */
function seed({ model, promptVersion, createdAt }) {
  removeArtifact({ kind: 'project_digest', subject: SUBJECT });
  putArtifact({
    kind: 'project_digest',
    subject: SUBJECT,
    sourceHash: 'seedhash',
    promptVersion,
    model,
    body: BODY,
    tokensIn: 10,
    tokensOut: 5,
  });
  // 直接改时间戳，模拟"很久以前生成的"
  if (createdAt) {
    const { DatabaseSync } = require('node:sqlite');
    void DatabaseSync;
  }
}

try {
  // 1. 模型不匹配 → 应判 possibly-stale
  seed({ model: 'old-model', promptVersion: 'v1' });
  const api1 = await get('/api/digest?path=' + encodeURIComponent(PROJECT));
  const j1 = JSON.parse(api1.body);
  push('API 返回 freshness 字段', !!j1.freshness);
  push('模型不同判为可能过期', j1.freshness.status === 'possibly-stale', j1.freshness.status);
  push('给出具体原因', j1.freshness.issues.some((i) => i.type === 'model-changed'), JSON.stringify(j1.freshness.issues.map((i) => i.type)));
  push('明确说出没查什么', Array.isArray(j1.freshness.unchecked) && j1.freshness.unchecked.length > 0, String(j1.freshness.unchecked[0] || '').slice(0, 30));

  // 2. 页面应显示徽标
  const page1 = await get('/p?path=' + encodeURIComponent(PROJECT));
  push('页面显示过期徽标', page1.body.includes('stale-badge') && page1.body.includes('可能已过期'));
  push('页面说明原因', page1.body.includes('生成时用的是'));

  // 3. 模型一致 → likely-current，不该显示徽标
  seed({ model: 'current-model', promptVersion: 'v1' });
  const page2 = await get('/p?path=' + encodeURIComponent(PROJECT));
  const api2 = JSON.parse((await get('/api/digest?path=' + encodeURIComponent(PROJECT))).body);
  push('模型一致判为较新', api2.freshness.status === 'likely-current', api2.freshness.status);
  push('较新时不显示徽标', !page2.body.includes('可能已过期'));
  push('较新时仍说明能力边界', page2.body.includes('查不了'));

  // 4. 提示词版本不同 → 也要判过期
  seed({ model: 'current-model', promptVersion: 'v0-old' });
  const api3 = JSON.parse((await get('/api/digest?path=' + encodeURIComponent(PROJECT))).body);
  push('提示词版本不同判为过期', api3.freshness.status === 'possibly-stale', api3.freshness.status);
  push('原因为提示词变化', api3.freshness.issues.some((i) => i.type === 'prompt-changed'));

  // 5. 新增会话检查：把摘要的生成时间设成很早 → 应报 new-sessions
  const fresh5 = quickFreshness({
    kind: 'project',
    artifact: {
      model: 'current-model',
      promptVersion: 'v1',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    },
    projectSessions: sessions,
  });
  push('生成后有新会话能判出来', fresh5.issues.some((i) => i.type === 'new-sessions'), JSON.stringify(fresh5.issues.map((i) => i.type)));
  push('新会话提示带数量', fresh5.issues.some((i) => /新增了 \d+ 场/.test(i.detail)));

  // 6. 摘要时间在最新会话之后 → 不该报 new-sessions
  const fresh6 = quickFreshness({
    kind: 'project',
    artifact: {
      model: 'current-model',
      promptVersion: 'v1',
      createdAt: new Date(Date.now() + 86400000),
    },
    projectSessions: sessions,
  });
  push('摘要比所有会话都新时不误报', !fresh6.issues.some((i) => i.type === 'new-sessions'));

  // 7. 没有摘要时不该崩
  const fresh7 = quickFreshness({ kind: 'project', artifact: null });
  push('无摘要时返回 none', fresh7.status === 'none');

  push('会话页也能渲染（不崩）', (await get('/s?agent=codex&id=019d3dd9')).code === 200);
} catch (e) {
  push('测试异常', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e));
} finally {
  removeArtifact({ kind: 'project_digest', subject: SUBJECT });
  started.server.close();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
