import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

/**
 * WorkBuddy 扫描器的格式契约。
 *
 * 这里锁的是**在真实存储上验证过的形状**（本机 24 个 session、含 4 个子代理），
 * 不是"代码当前怎么写"。每条对应一种会静默出错的情况：
 *
 *   1. 用户消息里裹着几 KB 的注入上下文，真话在 `<user_query>` 里——直接取
 *      全文会让标题变成一坨 OS/shell/技能模板。
 *   2. 时间戳是**毫秒**，当秒处理会得到 1970 年。
 *   3. `function_call` 的 `id` 是消息 id，**`callId` 才是工具 id**；拿错就配不上
 *      结果，正文里工具调用全是"有调用无输出"。
 *   4. 编辑重发会留下旧的 user message + 一条 `resend-fork-notice` 指回它；
 *      不处理的话同一句话在正文里连说三遍。
 *   5. 限流/网络失败也写成 assistant message（带 providerData.error），
 *      那不是模型说的话。
 *   6. `~/WorkBuddy/<时间戳>` 是它自己的临时工作区，不是用户的项目。
 *   7. 子代理在 `<id>/subagents/agent-*.jsonl`，要标 kind/parent。
 *   8. `*.file-rollback.ndjson`、`subagents/<id>/tool-results/*.txt` 不是会话。
 */

const scanner = await import('../src/scanners/workbuddy.js');

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

const ID = '11111111-2222-4333-8444-555555555555';
const PARENT = '99999999-8888-4777-8666-555555555555';

/** 一条真实形状的用户消息：system-reminder 包住注入上下文，真话在 user_query。 */
function userMsg(id, query, ts, { injected = 'OS Version: win32\nShell: bash', cwd = 'E:\\proj' } = {}) {
  return {
    id,
    timestamp: ts,
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: `<system-reminder data-role="user-context">\n<user_info>\n${injected}\n</user_info>\n</system-reminder>\n<user_query>${query}</user_query>`,
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

function writeSession(box, { id = ID, cwd = 'E:\\proj', events }) {
  return box.write(`.workbuddy/projects/e-proj/${id}.jsonl`, jsonl(...events));
}

test('workbuddy: 发现会话与子代理，排除回滚记录与工具产物', async () => {
  const box = sandbox();
  try {
    const main = writeSession(box, {
      events: [
        { type: 'session-meta', id: 'm1', sessionId: ID, timestamp: 1787903311000, meta: {} },
        userMsg('u1', '你好', 1787903311471),
        assistantMsg('a1', '你好，有什么可以帮你', 1787903312000),
      ],
    });
    const sub = box.write(
      `.workbuddy/projects/e-proj/${ID}/subagents/agent-abc123.jsonl`,
      jsonl(userMsg('su1', '子任务：调研', 1787903313000), assistantMsg('sa1', '调研结果', 1787903314000))
    );
    // 不是会话的文件
    box.write(`.workbuddy/projects/e-proj/${ID}.file-rollback.ndjson`, '{}\n');
    box.write(`.workbuddy/projects/e-proj/${ID}/subagents/agent-abc123/tool-results/t.txt`, 'x');

    await box.run(() => {
      const files = scanner.discover();
      assert.ok(files.includes(main), '主会话要被发现');
      assert.ok(files.includes(sub), '子代理转录要被发现');
      assert.equal(files.some((f) => f.includes('file-rollback')), false, '回滚记录不是会话');
      assert.equal(files.some((f) => f.includes('tool-results')), false, '工具产物不是会话');
    });
  } finally {
    box.cleanup();
  }
});

test('workbuddy: 标题取 user_query 里的真话，时间按毫秒算，项目取 cwd', async () => {
  const box = sandbox();
  try {
    const file = writeSession(box, {
      events: [
        { type: 'session-meta', id: 'm1', sessionId: ID, timestamp: 1787903311000, meta: {} },
        userMsg('u1', '微信消息可以同步到多维表吗', 1787903311471),
        assistantMsg('a1', '可以', 1787903312000),
      ],
    });
    await box.run(() => {
      const s = scanner.parse(file);
      assert.ok(s);
      assert.equal(s.title, '微信消息可以同步到多维表吗', '标题必须是 user_query，不是注入上下文');
      assert.equal(s.project, 'E:/proj', '项目取 cwd');
      assert.equal(s.start.toISOString(), '2026-08-28T07:48:31.000Z', '毫秒时间戳（最早的是 session-meta）');
      assert.equal(s.kind, 'main');
    });
  } finally {
    box.cleanup();
  }
});

test('workbuddy: ai-title 优先于首句用户消息', async () => {
  const box = sandbox();
  try {
    const file = writeSession(box, {
      events: [
        userMsg('u1', '这是一句很长很长的用户提问', 1787903311471),
        { type: 'ai-title', aiTitle: '应用生成的标题', sessionId: ID, timestamp: 1787903315000, cwd: 'E:\\proj' },
      ],
    });
    await box.run(() => {
      assert.equal(scanner.parse(file).title, '应用生成的标题');
    });
  } finally {
    box.cleanup();
  }
});

test('workbuddy: 临时工作区 ~/WorkBuddy/<时间戳> 不算项目', async () => {
  const box = sandbox();
  try {
    const scratch = box.path('WorkBuddy', '2026-08-28-15-48-29');
    const file = writeSession(box, {
      cwd: scratch,
      events: [userMsg('u1', '随便聊聊', 1787903311471, { cwd: scratch })],
    });
    await box.run(() => {
      assert.equal(scanner.parse(file).project, null, '它自己的工作区不是用户项目');
    });
  } finally {
    box.cleanup();
  }
});

test('workbuddy: 子代理标 kind/parent，id 不与别家撞', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      `.workbuddy/projects/e-proj/${PARENT}/subagents/agent-77.jsonl`,
      jsonl(userMsg('su1', '子任务', 1787903313000))
    );
    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent');
      assert.equal(s.parent, PARENT);
      assert.ok(s.id.includes('agent-77'), 'id 要能认出是哪个子代理');
    });
  } finally {
    box.cleanup();
  }
});

test('workbuddy: 正文——编辑重发只留最后一版，工具调用配上输出，失败回复不冒充模型', async () => {
  const box = sandbox();
  try {
    const file = writeSession(box, {
      events: [
        userMsg('u1', '第一版问题', 1787903311471),
        // 用户改了第一版并重发
        { type: 'resend-fork-notice', id: 'n1', timestamp: 1787903312000, editedUserItemId: 'u1' },
        userMsg('u2', '第二版问题', 1787903312100),
        { type: 'reasoning', id: 'r1', timestamp: 1787903312200, rawContent: [{ type: 'reasoning_text', text: '想一想' }] },
        {
          type: 'function_call',
          id: 'call-msg-id-1',
          callId: 'call_abc',
          name: 'search',
          arguments: '{"q":"x"}',
          timestamp: 1787903312300,
        },
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
        // 限流失败也写成 assistant message
        assistantMsg('a2', '429 queue.full.title', 1787903312600, {
          status: 'incomplete',
          providerData: { error: { code: 6021, message: '429 queue.full.title' } },
        }),
      ],
    });

    await box.run(() => {
      const s = scanner.parse(file);
      const msgs = scanner.readMessages(s);
      const users = msgs.filter((m) => m.role === 'user').map((m) => m.parts[0].text);
      assert.deepEqual(users, ['第二版问题'], '被改掉的版本不该出现，也不能两版都留');
      assert.equal(
        msgs.some((m) => JSON.stringify(m).includes('429 queue.full')),
        false,
        '失败回复不是模型说的话'
      );
      const tools = msgs.flatMap((m) => m.parts).filter((p) => p.kind === 'tool' || p.type === 'tool');
      assert.equal(tools.length, 1, '一次工具调用只成一条');
      assert.equal(tools[0].output, '搜索结果', '工具输出要按 callId 配对回来');
      assert.ok(
        msgs.some((m) => m.parts.some((p) => (p.kind || p.type) === 'reasoning')),
        'reasoning 要保留'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('workbuddy: 文件读不到时报错，不假装成空会话', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      assert.throws(() => scanner.readMessages({ id: 'x', source: box.path('.workbuddy', 'nope.jsonl') }));
    });
  } finally {
    box.cleanup();
  }
});