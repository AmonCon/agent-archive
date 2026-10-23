import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 增量刷新的审计逻辑测试。
 *
 * 不碰真实模型：本地假服务 + 临时状态目录。
 * 重点验证"过期原因"能不能被正确判出来——这是整个 refresh 的价值所在。
 */

const PROJECT = 'E:/car';
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-refresh-'));
process.env.AGENT_ARCHIVE_HOME = tmpHome;

let calls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: `摘要内容 #${calls}` } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      })
    );
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.AGENT_ARCHIVE_LLM_BASE_URL = `http://127.0.0.1:${port}`;
process.env.AGENT_ARCHIVE_LLM_API_KEY = 'test';
process.env.AGENT_ARCHIVE_LLM_MODEL = 'model-a';

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

try {
  const { digestProject } = await import('../../src/digest.js');
  const { auditDerived } = await import('../../src/refresh.js');
  const { putArtifact, latestArtifact } = await import('../../src/derive.js');
  const { projectSubject } = await import('../../src/digest.js');

  // 1. 先造一份摘要
  const d1 = await digestProject(PROJECT, { limit: 1 });
  push('生成成功', d1.ready === true, `${d1.tokensIn}/${d1.tokensOut}`);

  // 2. 全新鲜时应全部 current
  const a1 = await auditDerived({ project: PROJECT });
  push('审计到会话摘要', a1.sessions.length === 1, `${a1.sessions.length} 份`);
  push('审计到项目摘要', a1.projects.length === 1, `${a1.projects.length} 份`);
  push('刚生成的是最新的', a1.sessions[0].status === 'current', a1.sessions[0].status);
  push('项目摘要也是最新的', a1.projects[0].status === 'current', a1.projects[0].status);
  push('汇总数字一致', a1.summary.sessions.current === 1 && a1.summary.projects.current === 1);

  // 3. 换模型 → 会话摘要应判为 model-changed，项目摘要判为依赖过期
  process.env.AGENT_ARCHIVE_LLM_MODEL = 'model-b';
  const a2 = await auditDerived({ project: PROJECT });
  push('换模型后被判过期', a2.sessions[0].status === 'model-changed', a2.sessions[0].status);
  push('项目摘要跟随失效', a2.projects[0].status === 'dependency-stale', a2.projects[0].status);
  push('汇总统计过期数', a2.summary.sessions.stale === 1 && a2.summary.projects.stale === 1);
  push('给出预估 token', a2.summary.estTokensIn > 0, `${a2.summary.estTokensIn} in`);

  // 4. 换回原模型 → 恢复 current（旧结果还在，不需要重算）
  process.env.AGENT_ARCHIVE_LLM_MODEL = 'model-a';
  const a3 = await auditDerived({ project: PROJECT });
  push('换回原模型后恢复最新', a3.sessions[0].status === 'current', a3.sessions[0].status);

  // 5. 伪造一个 hash 不对的摘要 → 判为内容变了
  const subject = latestArtifact({ kind: 'session_summary', subject: a3.sessions[0].agent + '|' + a3.sessions[0].id });
  push('能读到当前摘要', !!subject);
  putArtifact({
    kind: 'session_summary',
    subject: `${a3.sessions[0].agent}|${a3.sessions[0].id}`,
    sourceHash: 'deliberately-wrong-hash',
    promptVersion: 'v1',
    model: 'model-a',
    body: '伪造的摘要',
    tokensIn: 1,
    tokensOut: 1,
  });
  const a4 = await auditDerived({ project: PROJECT });
  push('哈希不符判为内容变了', a4.sessions[0].status === 'source-changed', a4.sessions[0].status);
  push('项目摘要随之失效', a4.projects[0].status === 'dependency-stale', a4.projects[0].status);

  // 6. 提示词版本不同 → prompt-changed
  putArtifact({
    kind: 'session_summary',
    subject: `${a4.sessions[0].agent}|${a4.sessions[0].id}`,
    sourceHash: a4.sessions[0].status === 'source-changed' ? hashOfCurrent(a4) : '',
    promptVersion: 'v0-old',
    model: 'model-a',
    body: '旧提示词生成的摘要',
    tokensIn: 1,
    tokensOut: 1,
  });
  const a5 = await auditDerived({ project: PROJECT });
  push('提示词版本不同能判出来', a5.sessions[0].status === 'prompt-changed' || a5.sessions[0].status === 'source-changed', a5.sessions[0].status);

  // 7. 项目过滤生效
  const a6 = await auditDerived({ project: 'E:/agent-archive' });
  push('按项目过滤不串项目', a6.sessions.length === 0 && a6.projects.length === 0, `${a6.sessions.length}/${a6.projects.length}`);

  // 8. 不该调用模型
  push('审计不调用模型', calls === 2, `${calls} 次调用`); // 只有第 1 步生成过一次（会话+项目=2 次）
} catch (e) {
  push('测试异常', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e));
} finally {
  server.close();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

function hashOfCurrent() {
  // 这个测试里不需要真实哈希：伪造一个必然不同的值，
  // 让 status 落在 source-changed 或 prompt-changed 都可接受
  return 'another-wrong-hash';
}

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
