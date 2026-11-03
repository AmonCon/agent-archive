import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, makeSqlite } from './helpers.js';
import * as antigravity from '../src/scanners/antigravity.js';

/**
 * Antigravity 的契约。
 *
 * 这家的问题不是「读不到」，而是**读不到却不能装作读到了**：三套数据并存，
 * 索引库覆盖全部会话，但只有少数几场有明文转录；其余是解不开的 .pb。
 * 于是元数据能搜到、正文读不到。README 里那句「doctor 会如实报 1/3
 * 而不是假装能读」说的就是这里。
 *
 * 所以锁四件事：
 *   1. 索引里的空标题要退到 FTS 的 user_body，而不是显示 "(untitled)"
 *   2. 有 conversation db 但不在索引里的，要补进清单，标 "(未索引)"
 *   3. workspace_uris 要解成真路径（file:///e%3A/my-app → e:/my-app）
 *   4. 没有明文转录时抛错并说清原因，不硬抠加密 .pb
 */

/** 在假机器上造一份最小的 Antigravity 存储，返回 {ag, dbPath}。 */
function seedAntigravity() {
  // 用扫描器自己声明的根定位，避免写死各平台路径
  const gemini = antigravity.candidateRoots()[0];
  const ag = path.join(gemini, 'antigravity');
  const dbPath = path.join(ag, 'conversation_summaries.db');

  makeSqlite(dbPath, (db) => {
    db.exec(`create table conversation_summaries (
      conversation_id text, title text, step_count integer,
      last_modified_time text, workspace_uris text, status text, source text)`);
    db.exec(`create table conversations_fts (
      conversation_id text, chunk_index integer, user_body text)`);

    const ins = db.prepare('insert into conversation_summaries values (?,?,?,?,?,?,?)');
    // c1：索引里标题是空的，标题只能从 FTS 取
    ins.run('c1', '', 3, '2026-05-01T10:00:00Z', '["file:///e%3A/my-app"]', 'done', 'ide');
    // c2：索引里有标题，但没有明文转录
    ins.run('c2', '购物车数字不更新', 2, '2026-05-02T11:00:00Z', '[]', 'done', 'ide');

    const fts = db.prepare('insert into conversations_fts values (?,?,?)');
    fts.run('c1', 0, '刷新页面就掉登录态，帮我看看');
  });

  // 有 conversation db、但索引里没有它
  makeSqlite(path.join(ag, 'conversations', 'c3.db'), () => {});

  // c1 有明文转录；c2 没有（模拟那 18 场解不开的 .pb）
  const logs = path.join(ag, 'brain', 'c1', '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, 'transcript_full.jsonl'),
    [
      JSON.stringify({
        source: 'USER_EXPLICIT',
        type: 'user',
        created_at: '2026-05-01T10:00:00Z',
        content: '<USER_REQUEST>刷新页面就掉登录态</USER_REQUEST>',
      }),
      JSON.stringify({
        source: 'MODEL',
        type: 'model',
        created_at: '2026-05-01T10:00:05Z',
        content: '是 token 过期时间设短了',
        thinking: '先看 auth 配置',
        tool_calls: JSON.stringify([{ name: 'read_file', args: { path: 'src/auth.js' }, id: 't1' }]),
      }),
    ].join('\n')
  );

  return { ag, dbPath };
}

test('契约：空标题退到 FTS，未索引的会话也要进清单', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const { dbPath } = seedAntigravity();

      const files = antigravity.discover();
      assert.ok(files.length >= 1, 'discover 应该找到 conversation_summaries.db');

      const sessions = antigravity.parseAll(files[0]);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      assert.equal(sessions.length, 3, '索引里 2 场 + 未索引的 1 场');

      const c1 = byId.get('c1');
      assert.equal(
        c1.title,
        '刷新页面就掉登录态，帮我看看',
        '索引标题为空时应退到 FTS 的 user_body——显示 "(untitled)" 等于丢信息'
      );
      assert.equal(c1.project, 'e:/my-app', 'workspace_uris 里的 file:// URI 应解成真路径');

      const c2 = byId.get('c2');
      assert.equal(c2.title, '购物车数字不更新', '索引里有标题就不该覆盖它');

      const c3 = byId.get('c3');
      assert.ok(c3, '有 conversation db 但索引没覆盖的会话必须补进清单，否则静默丢数据');
      assert.equal(c3.title, '(未索引)', '补进来的会话要标成未索引，不能编一个标题');

      assert.equal(path.dirname(dbPath), path.dirname(files[0]));
    });
  } finally {
    antigravity.closeStore();
    box.cleanup();
  }
});

test('契约：有明文转录时按 source 分角色，并解出思考与工具调用', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      seedAntigravity();
      const files = antigravity.discover();
      const c1 = antigravity.parseAll(files[0]).find((s) => s.id === 'c1');

      const msgs = antigravity.readMessages(c1);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].role, 'user', 'USER_EXPLICIT 是用户');
      assert.equal(msgs[1].role, 'assistant', 'MODEL 是助手');

      const userText = msgs[0].parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
      assert.ok(
        !userText.includes('<USER_REQUEST>'),
        '注入型包装标签要剥掉，否则导出的正文里全是标签'
      );
      assert.ok(userText.includes('刷新页面就掉登录态'));

      const parts = msgs[1].parts;
      assert.ok(
        parts.some((p) => p.kind === 'reasoning' && p.text.includes('先看 auth 配置')),
        'thinking 应变成 reasoning part'
      );
      assert.ok(
        parts.some((p) => p.kind === 'text' && p.text.includes('token 过期时间设短了')),
        'content 应变成 text part'
      );
      const tool = parts.find((p) => p.kind === 'tool');
      assert.ok(tool, 'tool_calls 是 JSON 字符串，应解析成 tool part');
      assert.equal(tool.name, 'read_file');
      assert.deepEqual(tool.input, { path: 'src/auth.js' });
    });
  } finally {
    antigravity.closeStore();
    box.cleanup();
  }
});

test('契约：没有明文转录就抛错，不从加密 .pb 硬抠', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      seedAntigravity();
      const files = antigravity.discover();
      const c2 = antigravity.parseAll(files[0]).find((s) => s.id === 'c2');

      assert.throws(
        () => antigravity.readMessages(c2),
        /没有明文转录/,
        '读不到正文时必须抛错并说清原因——返回空数组会让调用方以为这场会话没内容'
      );
    });
  } finally {
    antigravity.closeStore();
    box.cleanup();
  }
});