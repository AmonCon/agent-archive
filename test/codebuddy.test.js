import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tempDir, withEnv } from './helpers.js';

/**
 * CodeBuddy 扫描器的格式契约（与 WorkBuddy 完全同构，坑全都一样）。
 *
 * 锁的是形状事实，不是当前实现：
 *  1. 标题取 `<user_query>` 里的真话，不是几 KB 的 system-reminder 注入；
 *  2. `timestamp` 是毫秒，当秒读会掉到 1970；
 *  3. `function_call.id` 是消息 id，**`callId` 才是工具 id**，拿错配不上结果；
 *  4. 编辑重发留旧版 user message + `resend-fork-notice`，被改掉的那一版不该出现；
 *  5. `providerData.error` 的失败回复不是模型说的话；
 *  6. 子代理在 `<id>/subagents/` 下要标 kind/parent；
 *  7. `structureSpec` 的 `dirHints: ['.codebuddy']` 是与 claude/workbuddy/qoder
 *     同构消歧的唯一依据；`discoverWithin` 纯函数、`ctx.roots` 不被误杀。
 *
 * 全部用 sandbox/tempDir 自造合成样本，不读本机 `~/.codebuddy` 真实内容。
 */

const scanner = await import('../src/scanners/codebuddy.js');

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

const CLEAN_ENV = { CODEBUDDY_CONFIG_DIR: null };
async function inBox(box, fn) {
  return withEnv(CLEAN_ENV, () => box.run(fn));
}

const ID = 'cccc1111-2222-4333-8444-555555555555';
const PARENT = 'dddd1111-2222-4333-8444-555555555555';

function userMsg(id, query, ts, { cwd = 'E:\\proj' } = {}) {
  return {
    id,
    timestamp: ts,
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: `<system-reminder data-role="user-context">\n<user_info>\nOS Version: win32\nShell: bash\n</user_info>\n</system-reminder>\n<user_query>${query}</user_query>`,
      },
    ],
    sessionId: ID,
    cwd,
  };
}
function assistantMsg(id, text, ts, extra = {}) {
  return {
    id,
    timestamp: ts,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
    sessionId: ID,
    cwd: 'E:\\proj',
    ...extra,
  };
}
function writeSession(box, { id = ID, events, root = '.codebuddy' }) {
  return box.write(`${root}/projects/e-proj/${id}.jsonl`, jsonl(...events));
}

test('codebuddy: 真实形状解出会话，标题取 user_query 真话，项目取 cwd，时间按毫秒', async () => {
  const box = sandbox();
  try {
    const file = writeSession(box, {
      events: [
        { type: 'session-meta', id: 'm1', sessionId: ID, timestamp: 1787903311000, meta: {}, cwd: 'E:\\proj' },
        userMsg('u1', '微信消息可以同步到多维表吗', 1787903311471),
        assistantMsg('a1', '可以', 1787903312000),
      ],
    });
    await inBox(box, () => {
      const files = scanner.discover();
      assert.ok(files.includes(file), 'projects/<ws>/<id>.jsonl 要被发现');

      const s = scanner.parse(file);
      assert.ok(s);
      assert.equal(s.agent, 'codebuddy', '复用 workbuddy 解析后 agent 名要改成自己');
      assert.equal(s.title, '微信消息可以同步到多维表吗', '标题取 user_query，不是注入上下文');
      assert.equal(s.project, 'E:/proj');
      assert.equal(s.start.getUTCFullYear(), 2026, '毫秒时间戳不能被当秒（否则掉到 1970）');
      assert.equal(s.start.toISOString(), '2026-08-28T07:48:31.000Z');
      assert.equal(s.kind, 'main');
    });
  } finally {
    box.cleanup();
  }
});

test('codebuddy: 编辑重发只留最后一版，工具按 callId 配对，失败回复不冒充模型', async () => {
  const box = sandbox();
  try {
    const file = writeSession(box, {
      events: [
        userMsg('u1', '第一版问题', 1787903311471),
        { type: 'resend-fork-notice', id: 'n1', timestamp: 1787903312000, editedUserItemId: 'u1' },
        userMsg('u2', '第二版问题', 1787903312100),
        { type: 'reasoning', id: 'r1', timestamp: 1787903312200, rawContent: [{ type: 'reasoning_text', text: '想一想' }] },
        { type: 'function_call', id: 'call-msg-id-1', callId: 'call_abc', name: 'search', arguments: '{"q":"x"}', timestamp: 1787903312300 },
        {
          type: 'function_call_result',
          id: 'res-1',
          callId: 'call_abc',
          name: 'search',
          status: 'completed',
          output: { type: 'text', text: '搜索结果' },
          timestamp: 1787903312400,
        },
        assistantMsg('a1', '这是回答', 1787903312500),
        assistantMsg('a2', '429 queue.full.title', 1787903312600, {
          status: 'incomplete',
          providerData: { error: { code: 6021, message: '429 queue.full.title' } },
        }),
      ],
    });
    await inBox(box, () => {
      const s = scanner.parse(file);
      const msgs = scanner.readMessages(s);
      const users = msgs.filter((m) => m.role === 'user').map((m) => m.parts[0].text);
      assert.deepEqual(users, ['第二版问题'], '被改掉的版本不该出现，也不能两版都留');
      assert.equal(msgs.some((m) => JSON.stringify(m).includes('429 queue.full')), false, '失败回复不是模型说的话');
      const tools = msgs.flatMap((m) => m.parts).filter((p) => p.kind === 'tool');
      assert.equal(tools.length, 1, '一次工具调用只成一条');
      assert.equal(tools[0].output, '搜索结果', '工具输出按 callId 配对（id 是消息 id，用错配不上）');
      assert.ok(msgs.some((m) => m.parts.some((p) => p.kind === 'reasoning')), 'reasoning 要保留');
    });
  } finally {
    box.cleanup();
  }
});

test('codebuddy: CODEBUDDY_CONFIG_DIR 覆盖根也能发现', async () => {
  const box = sandbox();
  try {
    const custom = box.path('custom-codebuddy');
    const file = box.write(
      'custom-codebuddy/projects/e-proj/c1.jsonl',
      jsonl(userMsg('u1', '自定义根里的第一句', 1787903311471), assistantMsg('a1', '回答', 1787903312000))
    );
    await withEnv({ CODEBUDDY_CONFIG_DIR: custom }, () =>
      box.run(() => {
        assert.ok(scanner.discover().includes(file), '环境变量指向的根要参与发现');
        assert.equal(scanner.parse(file).title, '自定义根里的第一句');
      })
    );
  } finally {
    box.cleanup();
  }
});

test('codebuddy: 子代理转录标 kind/parent，回滚记录不是会话', async () => {
  const box = sandbox();
  try {
    const sub = box.write(
      `.codebuddy/projects/e-proj/${PARENT}/subagents/agent-77.jsonl`,
      jsonl(userMsg('su1', '子任务', 1787903313000))
    );
    box.write(`.codebuddy/projects/e-proj/${PARENT}.file-rollback.ndjson`, '{}\n');
    await inBox(box, () => {
      const files = scanner.discover();
      assert.ok(files.includes(sub));
      assert.equal(files.some((f) => f.includes('file-rollback')), false, '回滚记录不是会话');
      const s = scanner.parse(sub);
      assert.equal(s.agent, 'codebuddy');
      assert.equal(s.kind, 'subagent');
      assert.equal(s.parent, PARENT);
    });
  } finally {
    box.cleanup();
  }
});

test('codebuddy: structureSpec 用 .codebuddy 消歧，discoverWithin 纯函数，ctx.roots 不被误杀', async () => {
  const t = tempDir();
  try {
    const root = t.path('.codebuddy');
    t.write(
      '.codebuddy/projects/e-proj/c2.jsonl',
      jsonl(userMsg('u1', '显式源里的第一句', 1787903311471), assistantMsg('a1', '回答', 1787903312000))
    );
    t.write('decoy/random.jsonl', line({ hello: 'world' }));

    const spec = scanner.structureSpec;
    assert.equal(spec.agent, 'codebuddy');
    assert.deepEqual(spec.rootAnchor, { from: 'projects', up: 1, allowSelf: true });
    assert.deepEqual(spec.dataPaths, ['projects']);
    assert.deepEqual(spec.dirHints, ['.codebuddy'], '与 claude/workbuddy/qoder 同构，靠 dirHints 消歧');
    assert.equal(spec.minScore, 3);
    assert.ok(spec.probes.some((p) => p.weight >= 4 && String(p.glob).includes('projects/')));

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('c2.jsonl'));
    assert.deepEqual(scanner.discoverWithin([t.path('decoy')], {}), [], '无关 .jsonl 的 decoy 不被当会话');

    const s = scanner.parse(files[0]);
    assert.equal(s.title, '显式源里的第一句');
    assert.ok(scanner.readMessages(s, { roots: [root] }).length >= 1, 'ctx.roots 让外部根不被误杀');
  } finally {
    t.cleanup();
  }
});

test('codebuddy: 文件读不到时报错，不假装成空会话', async () => {
  const t = tempDir();
  try {
    const root = t.path('.codebuddy');
    t.mkdir('.codebuddy/projects/e-proj');
    assert.throws(() =>
      scanner.readMessages({ source: t.path('.codebuddy/projects/e-proj/missing.jsonl') }, { roots: [root] })
    );
  } finally {
    t.cleanup();
  }
});
