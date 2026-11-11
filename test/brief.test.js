import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { collectBriefFacts, projectBrief, briefMarkdown } from '../src/brief.js';

/**
 * 交接单的核心契约：
 *   1. 只取「最后一段连续工作」，不把整个项目的所有会话混进来；
 *   2. 文件和任务只从这一段里抽，项目内文件排在前面；
 *   3. 全程不调模型，产物里必须带 deterministic 标记；
 *   4. 网页/MCP/CLI 共用同一个 projectBrief()，所以只测这一层。
 */

const PROJECT = 'E:/demo';

function session(id, agent, title, start, end) {
  return {
    id,
    agent,
    title,
    project: PROJECT,
    start: new Date(start),
    end: new Date(end),
  };
}

function msg(role, parts) {
  return { role, parts, ts: null, meta: null };
}
const text = (t) => ({ kind: 'text', text: t });
const tool = (name, input) => ({ kind: 'tool', name, input });

test('brief: 只取最后一段连续工作，抽文件与任务', () => {
  const s1 = session('s1', 'codex', '登录问题', '2026-01-01T10:00:00Z', '2026-01-01T10:30:00Z');
  const s2 = session('s2', 'claude-code', '接手登录', '2026-01-02T10:00:00Z', '2026-01-02T10:20:00Z');
  const s3 = session('s3', 'claude-code', '补回归', '2026-01-02T11:00:00Z', '2026-01-02T11:30:00Z');

  const h = {
    project: PROJECT,
    sessions: 3,
    runList: [
      { agent: 'codex', count: 1, start: s1.start, end: s1.end, lastSession: s1, sessions: [s1] },
      {
        agent: 'claude-code',
        count: 2,
        start: s2.start,
        end: s3.end,
        lastSession: s3,
        sessions: [s2, s3],
      },
    ],
    handoffs: [
      {
        from: 'codex',
        to: 'claude-code',
        kind: 'sequential',
        gapMinutes: 1410,
        stale: false,
        fromLastSession: s1,
        toFirstSession: s2,
      },
    ],
  };

  const messages = new Map([
    [
      's1',
      [msg('user', [text('上一段不该出现在交接单里')]), msg('assistant', [text('收到')])],
    ],
    [
      's2',
      [
        msg('user', [text('登录问题昨天在 Codex 那边修了，但测试环境还是复现。')]),
        msg('assistant', [text('我看看。')]),
        msg('assistant', [
          tool('Write', { file_path: 'E:/demo/src/auth.js', content: '...' }),
          tool('TodoWrite', {
            todos: [
              { content: '复现问题', status: 'completed' },
              { content: '补回归用例', status: 'in_progress' },
            ],
          }),
        ]),
      ],
    ],
    [
      's3',
      [
        msg('user', [text('顺手把 README 也补一下。')]),
        msg('assistant', [
          text('好，README 已补。'),
          tool('Edit', { file_path: 'E:/demo/README.md', old_string: 'a', new_string: 'b' }),
          tool('Edit', { file_path: 'C:/tmp/scratch.mjs', old_string: 'a', new_string: 'b' }),
        ]),
      ],
    ],
  ]);

  const facts = collectBriefFacts(h, messages);

  assert.equal(facts.lastRun.agent, 'claude-code', '最后一段是 claude-code');
  assert.equal(facts.lastRun.count, 2);
  assert.equal(facts.lastRun.lastSession.id, 's3', '最后停在 s3');
  assert.equal(facts.lastRun.lastUserText, '顺手把 README 也补一下。');
  assert.equal(facts.lastRun.lastAssistantText, '好，README 已补。');

  assert.deepEqual(
    facts.files.map((f) => f.path),
    ['E:/demo/README.md', 'E:/demo/src/auth.js', 'C:/tmp/scratch.mjs'],
    '项目内文件排前面；项目外也保留，供调用方判断'
  );
  assert.deepEqual(
    facts.tasks.map((t) => `${t.subject}:${t.status}`),
    ['复现问题:done', '补回归用例:doing'],
    'TodoWrite 的状态要原样保留，不猜'
  );

  assert.equal(facts.previous.from, 'codex');
  assert.equal(facts.previous.gapMinutes, 1410);
  assert.equal(facts.recentSessions[0].id, 's3', '最近会话按时间倒序');
});

test('brief: 读不了正文的会话不拖垮整张单，readErrors 如实报出', async () => {
  const box = sandbox();
  try {
    // 造两场 Claude Code 会话：同一 cwd，第二场更晚，带一次 Write。
    const dir = '.claude/projects/E--demo';
    const line = (o) => JSON.stringify(o) + '\n';
    const m = (sessionId, uuid, ts, role, content) =>
      line({
        type: role,
        uuid,
        sessionId,
        cwd: PROJECT,
        timestamp: ts,
        message: { role, content },
      });

    box.write(
      `${dir}/a.jsonl`,
      m('session-a', 'u1', '2026-01-01T10:00:00Z', 'user', '第一场') +
        m('session-a', 'u2', '2026-01-01T10:01:00Z', 'assistant', '好的')
    );
    box.write(
      `${dir}/b.jsonl`,
      m('session-b', 'u3', '2026-01-02T10:00:00Z', 'user', '第二场：把 README 补一下') +
        m('session-b', 'u4', '2026-01-02T10:01:00Z', 'assistant', [
          { type: 'text', text: '已补。' },
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${PROJECT}/README.md`, content: 'x' } },
        ])
    );

    await box.run(async () => {
      const b = await projectBrief(PROJECT, { readSessions: 2 });
      assert.equal(b.sessions, 2);
      assert.equal(b.deterministic, true);
      assert.equal(b.lastRun.agent, 'claude-code');
      assert.equal(b.lastRun.count, 2, '同一 Agent 的两场算一段');
      assert.ok(
        b.files.some((f) => f.path.endsWith('README.md') && f.inProject),
        'Write 的文件要抽出来并标记为项目内'
      );
      assert.equal(b.readErrors.length, 0);

      const md = briefMarkdown(b);
      assert.match(md, /^# 交接单 · E:\/demo/m);
      assert.match(md, /## 二、这一段动过的文件/);
      assert.match(md, /README\.md/);
    });
  } finally {
    box.cleanup();
  }
});
