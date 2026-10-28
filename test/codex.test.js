import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sandbox,
  makeSqlite,
  codexMeta,
  codexUser,
  codexAssistant,
  codexLine,
} from './helpers.js';

/**
 * Codex 扫描器的格式契约。
 *
 * 这里锁的是**我们踩过的坑**，不是"代码当前怎么写"。每条断言对应一个真实缺陷：
 *
 *   1. 父会话 id 有三代写法（旧 session_id / 新 parent_thread_id / guardian 没有）
 *   2. 导入会话的顶层 timestamp 全是导入时刻，真实时间在 payload 里
 *   3. 只读头部会让长文件缺结束时间，明文靠尾部补、压缩靠旁路表补
 *   4. 旁路表文件名带版本号，写死会在上游升版后静默失效
 *
 * 上游哪天改了这些形状，这里会先红——总比用户机器上静默少数据好。
 * 全部跑在假家目录里，不依赖、也不触碰本机真实数据。
 */

const scanner = await import('../src/scanners/codex.js');

test('codex: 旧版子代理用 session_id 指向父会话', async () => {
  const box = sandbox();
  try {
    const parentId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const childId = 'bbbbbbbb-1111-2222-3333-444444444444';
    // 旧版：session_id 指向父、id 指向自己
    const meta =
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id: childId, session_id: parentId, cwd: 'E:/p', source: { subagent: {} } },
      }) + '\n';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${childId}.jsonl`,
      meta + codexUser('hi', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent');
      assert.equal(s.parent, parentId);
      assert.equal(s.id, childId, 'id 必须是自己，不能是父会话');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 新版子代理的父 id 在 parent_thread_id', async () => {
  const box = sandbox();
  try {
    const parentId = 'cccccccc-1111-2222-3333-444444444444';
    const childId = 'dddddddd-1111-2222-3333-444444444444';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${childId}.jsonl`,
      codexMeta({
        id: childId,
        cwd: 'E:/p',
        parent: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
        timestamp: '2026-01-01T00:00:00Z',
      }) + codexUser('hi', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent');
      assert.equal(s.parent, parentId);
    });
  } finally {
    box.cleanup();
  }
});

test('codex: guardian 类型没有父 id 时如实留空，不编造', async () => {
  const box = sandbox();
  try {
    const id = 'eeeeeeee-1111-2222-3333-444444444444';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', source: { subagent: { other: 'guardian' } }, timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('hi', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent', '仍然要标成子代理');
      assert.equal(s.parent, null, '拿不到就是 null，不要推测');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 导入会话用 payload 的真实时间，不用导入时刻', async () => {
  const box = sandbox();
  try {
    const id = 'ffffffff-1111-2222-3333-444444444444';
    const importAt = '2026-09-05T17:00:01.000Z';
    const realStart = Date.UTC(2026, 7, 29, 7, 30, 56) / 1000; // 2026-08-29T07:30:56Z
    const realEnd = Date.UTC(2026, 7, 29, 7, 31, 58) / 1000;
    const body =
      codexMeta({ id, cwd: 'E:/p', timestamp: importAt }) +
      codexLine(
        'event_msg',
        { type: 'task_started', turn_id: 'external-import-turn-1', started_at: realStart },
        importAt
      ) +
      codexLine(
        'event_msg',
        {
          type: 'task_complete',
          turn_id: 'external-import-turn-1',
          started_at: realStart,
          completed_at: realEnd,
          // 这个字段名字有误导性：装的是导入时刻
          completed_at_ms: Date.parse(importAt),
        },
        importAt
      ) +
      codexUser('导入的对话', importAt);

    const file = box.write(`.codex/sessions/2026/09/06/rollout-x-${id}.jsonl`, body);

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.start.toISOString(), new Date(realStart * 1000).toISOString(), 'start 用真实开始');
      assert.equal(s.end.toISOString(), new Date(realEnd * 1000).toISOString(), 'end 用真实完成');
      assert.notEqual(s.end.toISOString(), importAt, '不能等于导入时刻');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 明文长文件读尾部拿到真实结束时间', async () => {
  const box = sandbox();
  try {
    const id = '11111111-aaaa-bbbb-cccc-dddddddddddd';
    const filler =
      JSON.stringify({
        timestamp: '2026-01-01T01:00:00Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(8000) }] },
      }) + '\n';
    let body = codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' });
    body += codexUser('开头', '2026-01-01T00:01:00Z');
    for (let i = 0; i < 40; i++) body += filler;
    body += codexAssistant('结尾', '2026-01-05T12:00:00Z');

    const file = box.write(`.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`, body);
    assert.ok(Buffer.byteLength(body) > 256 * 1024, '用例前提：文件必须超过头部读取上限');

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(
        s.end.toISOString(),
        '2026-01-05T12:00:00.000Z',
        '头部只读到 1 月 1 日，尾部读取才能拿到 1 月 5 日'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 旁路表修正结束时间与占位标题，且跟随版本号的库名', async () => {
  const box = sandbox();
  try {
    const id = '22222222-aaaa-bbbb-cccc-dddddddddddd';
    // 刻意用 state_9.sqlite：验证不是写死 state_5
    makeSqlite(box.path('.codex', 'state_9.sqlite'), (db) => {
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(
        id,
        '应用给的标题',
        Date.UTC(2026, 0, 9, 0, 0, 0) / 1000, // Unix 秒
        'E:/p',
        123
      );
    });

    // 不放用户消息：这样我们只能给出占位标题，才该被应用标题覆盖
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' })
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.title, '(untitled)', 'parse 阶段不读旁路表');

      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '应用给的标题', '占位标题要让位给应用标题');
      assert.equal(e.end.toISOString(), '2026-01-09T00:00:00.000Z', '结束时间用 threads.updated_at');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 真实用户第一句不会被应用标题覆盖', async () => {
  const box = sandbox();
  try {
    const id = '44444444-aaaa-bbbb-cccc-dddddddddddd';
    makeSqlite(box.path('.codex', 'state_1.sqlite'), (db) => {
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(
        id,
        '应用给的标题',
        Date.UTC(2026, 0, 9) / 1000,
        'E:/p',
        1
      );
    });

    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('用户自己说的第一句', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.title, '用户自己说的第一句');
      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '用户自己说的第一句', '用户真实说过的话优先，不被应用标题盖掉');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 没有旁路表时不报错、不改变任何字段', async () => {
  const box = sandbox();
  try {
    const id = '33333333-aaaa-bbbb-cccc-dddddddddddd';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('真实用户第一句', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '真实用户第一句');
      assert.deepEqual(e.end, s.end);
    });
  } finally {
    box.cleanup();
  }
});
