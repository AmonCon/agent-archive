import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dispatch } from '../src/mcp.js';
import { clearScanCache } from '../src/registry.js';
import { clearTranscriptCache } from '../src/transcript-cache.js';
import { sandbox } from './helpers.js';

/**
 * MCP 的"失败"必须能分辨。
 *
 * 旧实现里这三种情况回的是同一句话「没有匹配 X 的会话」：
 *   1. Agent 名打错了（我不认识这个 Agent）
 *   2. 会话在档案里、但正文读不出来（源文件被删/移动/格式变了）
 *   3. 确实没有这场会话（id 打错了）
 *
 * 对调用方（通常是另一个模型）来说，同形意味着它只能做同一件事：换个 id
 * 再试。而 1 该换 Agent 名，2 该去查文件，3 才该换 id。分不清就永远修不好。
 *
 * 这里锁死两件事：三句话互不相同，且各自带着能机器分辨的 code。
 * **刻意不断言具体措辞**——文案会改，语义不该改。
 */

/** 调一个工具，返回 dispatch 包好的 MCP 结果。 */
function call(name, args) {
  return dispatch({ method: 'tools/call', params: { name, arguments: args } });
}

/** 造一场可解析的 DSH 会话，返回源文件路径。 */
function writeDshSession(box, id) {
  const dir = box.path('.dsh', 'sessions', 'E--p', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session', id, createdAt: '2026-01-01T00:00:00Z', cwd: 'E:/p' }) +
      '\n' +
      JSON.stringify({
        type: 'user/message',
        time: '2026-01-01T00:01:00Z',
        data: { content: '帮我看看这个' },
      }) +
      '\n'
  );
  return file;
}

/** 每个用例都要先清进程内缓存，否则会读到上一个用例的环境。 */
function resetCaches() {
  clearScanCache();
  clearTranscriptCache();
}

test('mcp: 三种失败（未知 Agent / 读不出来 / 确实没有）互不同形', async () => {
  const box = sandbox();
  try {
    const file = writeDshSession(box, 'mcp-read-fail-1');

    await box.run(async () => {
      resetCaches();
      const unknown = await call('read_session', { id: 'whatever', agent: 'no-such-agent' });

      const missing = await call('read_session', { id: 'no-such-session', agent: 'dsh' });

      // 先扫一遍（但不读正文），让会话进入进程内缓存；再删掉源文件，
      // 模拟"档案里还有元数据、源文件却被删/移走"——这是真实会出现的情况，
      // 而不是测试造出来的假想。
      resetCaches();
      await call('list_projects', {});
      fs.rmSync(file);

      const unreadable = await call('read_session', {
        id: 'mcp-read-fail-1',
        agent: 'dsh',
      });

      const texts = [
        unknown.structuredContent.error,
        missing.structuredContent.error,
        unreadable.structuredContent.error,
      ];
      assert.ok(texts.every(Boolean), '三种情况都要给出原因，不能空着');
      assert.notEqual(texts[0], texts[1], '不认识 Agent 不能和"没有这场会话"同形');
      assert.notEqual(texts[1], texts[2], '"没有这场会话"不能和"读不出来"同形');
      assert.notEqual(texts[0], texts[2], '不认识 Agent 也不能和"读不出来"同形');

      // code 才是调用方真正能分支的东西；只靠文案分辨太脆
      assert.equal(unknown.structuredContent.code, 'unknown_agent');
      assert.equal(missing.structuredContent.code, 'not_found');
      assert.equal(unreadable.structuredContent.code, 'read_failed');

      // isError 语义不变：三种都是"工具执行了、但没拿到你要的东西"
      for (const r of [unknown, missing, unreadable]) assert.equal(r.isError, true);

      // "我不认识 X"必须带上可用列表，否则调用方还是只能猜
      assert.ok(Array.isArray(unknown.structuredContent.knownAgents));
      assert.ok(unknown.structuredContent.knownAgents.includes('dsh'));

      // "读不出来"要能说清是哪一场——元数据还在，正好可以指出来
      assert.equal(unreadable.structuredContent.session.id, 'mcp-read-fail-1');
      assert.ok(unreadable.structuredContent.session.title, '要带上标题，让人认出是哪一场');
    });
  } finally {
    box.cleanup();
  }
});

test('mcp: read_session_summary 同样区分"不认识 Agent"与"没有这场会话"', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      resetCaches();
      const unknown = await call('read_session_summary', { id: 'x', agent: 'no-such-agent' });
      const missing = await call('read_session_summary', { id: 'no-such-session', agent: 'dsh' });

      assert.equal(unknown.structuredContent.code, 'unknown_agent');
      assert.equal(missing.structuredContent.code, 'not_found');
      assert.notEqual(unknown.structuredContent.error, missing.structuredContent.error);
    });
  } finally {
    box.cleanup();
  }
});

test('mcp: handler 抛错时也带 code，调用方能分辨而不是只看到一句话', async () => {
  // 现有 12 个工具都倾向于"返回 { error } 而不是抛"，所以 catch 分支是兜底。
  // 兜底也必须可分辨：真有一天某个工具抛了（新工具、或者库内部异常），
  // 调用方拿到的不能又是一句没有类别的话。
  //
  // 用一个临时工具触发它——比找某个"恰好会抛"的参数可靠，也不会因为
  // 以后有人给那个参数加了容错而失效。
  const { TOOLS } = await import('../src/mcp.js');
  const boom = {
    name: 'aa-boom',
    title: '测试用：必抛的工具',
    description: '这条不是产品工具，只在 test/mcp-errors.test.js 里临时挂上来验 catch 分支。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const e = new Error('模拟内部崩溃');
      e.code = 'internal_boom';
      throw e;
    },
  };
  TOOLS.push(boom);
  try {
    const res = await call('aa-boom', {});
    assert.equal(res.isError, true, 'isError 语义不变：工具执行失败');
    assert.equal(res.structuredContent.code, 'internal_boom', '抛出的错误的 code 要透出来');
    // 只看 text 的客户端也得能分辨，所以 code 要出现在文本里
    assert.match(res.content[0].text, /internal_boom/);
    assert.match(res.content[0].text, /模拟内部崩溃/);
  } finally {
    const i = TOOLS.indexOf(boom);
    if (i >= 0) TOOLS.splice(i, 1);
  }
});