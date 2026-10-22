import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 摘要流水线的端到端测试。
 *
 * 不碰真实模型：本地起一个假的 OpenAI 兼容服务，返回固定文本。
 * 这样能验证协议形状、分层调用、缓存命中、模型切换导致的失效，
 * 一分钱不花。
 */

const PROJECT = 'E:/car'; // 只有 1 场会话，跑得快

// ---- 假的模型服务 ----
let calls = 0;
const seen = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }
    seen.push({
      path: req.url,
      auth: req.headers.authorization || '',
      model: parsed.model,
      messages: (parsed.messages || []).length,
      promptChars: (parsed.messages || []).reduce((n, m) => n + String(m.content || '').length, 0),
      systemChars: ((parsed.messages || []).find((m) => m.role === 'system') || {}).content
        ? String((parsed.messages || []).find((m) => m.role === 'system').content).length
        : 0,
    });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `【摘要】第 ${calls} 次调用生成的内容。` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      })
    );
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 隔离状态目录：衍生缓存和模型配置都写到临时目录，
// 既不污染真实数据，也让每次测试都是干净起点
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-digest-'));
process.env.AGENT_ARCHIVE_HOME = tmpHome;

// 指向假服务
process.env.AGENT_ARCHIVE_LLM_BASE_URL = `http://127.0.0.1:${port}`;
process.env.AGENT_ARCHIVE_LLM_API_KEY = 'test-key-not-real';
process.env.AGENT_ARCHIVE_LLM_MODEL = 'mock-v1';

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

try {
  const { estimateProject, digestProject } = await import('../../src/digest.js');
  const { listArtifacts, deriveStats, getArtifact, hashText } = await import('../../src/derive.js');

  // 1. 估算不应调用 API
  const before = calls;
  const est = await estimateProject(PROJECT, { limit: 1 });
  push('估算不调用 API', calls === before, `calls=${calls}`);
  push('估算给出输入字符数', !!est.ready && est.inputChars > 0, est.inputChars + ' 字符');
  push('估算给出 token 量级', !!est.ready && est.estTokensIn > 0, est.estTokensIn + ' in');
  push('估算标注模型', !!est.ready && est.model === 'mock-v1');

  // 2. 第一次摘要：应当真的调用
  const r1 = await digestProject(PROJECT, { limit: 1 });
  push('生成成功', r1.ready === true && typeof r1.text === 'string');
  push('第一次未命中缓存', r1.cached === false, `重算 ${r1.cacheMiss} 场`);
  push('调用了模型', calls > before, `${calls - before} 次`);
  push('返回了模型内容', String(r1.text).includes('摘要'));
  push('统计了 token', r1.tokensIn > 0 && r1.tokensOut > 0, `${r1.tokensIn}/${r1.tokensOut}`);

  // 3. 请求形状
  const first = seen[0];
  push('请求路径正确', first.path === '/v1/chat/completions', first.path);
  push('带 Bearer 鉴权', first.auth.startsWith('Bearer '), first.auth.slice(0, 12) + '…');
  push('模型名正确', first.model === 'mock-v1', first.model);
  push('有 system 提示', first.systemChars > 0, first.systemChars + ' 字符');

  // 4. 第二次：应命中缓存，不再调用
  const c1 = calls;
  const r2 = await digestProject(PROJECT, { limit: 1 });
  push('第二次命中缓存', r2.cached === true);
  push('缓存命中不调用模型', calls === c1, `calls=${calls}`);

  // 5. 换模型 → 缓存失效
  process.env.AGENT_ARCHIVE_LLM_MODEL = 'mock-v2';
  const c2 = calls;
  const r3 = await digestProject(PROJECT, { limit: 1 });
  push('换模型后重新生成', r3.cached === false);
  push('换模型确实调用了', calls > c2, `${calls - c2} 次`);

  // 6. force → 强制重算
  const c3 = calls;
  const r4 = await digestProject(PROJECT, { limit: 1, force: true });
  push('--force 强制重算', r4.cached === false && calls > c3);

  // 7. 衍生库内容
  const stats = deriveStats();
  push('衍生库有数据', stats.total > 0, `${stats.total} 条`);
  const kinds = new Set(stats.groups.map((g) => g.kind));
  push('含会话摘要', kinds.has('session_summary'));
  push('含项目摘要', kinds.has('project_digest'));
  push('记录了多个模型', new Set(stats.groups.map((g) => g.model)).size >= 2);

  const arts = listArtifacts({ limit: 20 });
  push('可列出衍生条目', arts.length > 0 && arts[0].subject.length > 0);
  push('条目带提示词版本', arts.every((a) => a.promptVersion));

  // 8. 缓存键的语义：同内容同模型才能命中
  const projectArt = arts.find((a) => a.kind === 'project_digest');
  const miss = getArtifact({
    kind: 'project_digest',
    subject: projectArt.subject,
    sourceHash: 'different-hash',
    promptVersion: projectArt.promptVersion,
    model: projectArt.model,
  });
  push('内容哈希不同则不命中', miss === null);
  push('hashText 稳定', hashText('abc') === hashText('abc') && hashText('abc') !== hashText('abd'));

  // 9. 错误处理：密钥错误时不能静默失败，必须把原因带出来
  process.env.AGENT_ARCHIVE_LLM_API_KEY = '';
  const r5 = await digestProject(PROJECT, { limit: 1, force: true });
  push('缺密钥时明确报错', r5.ready === false && /API Key/.test(String(r5.message || '')), String(r5.message || '').slice(0, 60));
} catch (e) {
  push('测试异常', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
} finally {
  server.close();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* 清理失败无所谓 */
  }
}

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
