import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, makeSqlite, withEnv } from './helpers.js';
import * as opencode from '../src/scanners/opencode.js';

/**
 * OpenCode 扫描器的格式契约。
 *
 * 与 ZCode 同源（session/message/part 三表），但有两个自己的特点，
 * 全部来自实测：
 *
 *   1. session 表自带 directory/title/time_*，元数据一条 SQL 就够
 *      ——fixture 里这些列就是硬契约，缺列会让 parseAll 静默返回空数组。
 *   2. message.data 里**没有** semantics.origin，区分不了真人和注入，
 *      只能靠 part 类型过滤：step-start/step-finish 是流控标记，
 *      text/reasoning/tool 才是内容。
 *
 * 另外锁三件容易悄悄坏的事：
 *   - time_archived 非空的会话不出现（归档不是删除，但也不该进时间线）
 *   - 子代理（parent_id 非空）照常采集并标 kind/parent
 *   - OPENCODE_DB 精确覆盖生效（三个官方覆盖变量之一）
 */

/** 造一个最小的 opencode.db：一场 main、一场子代理、一场已归档。 */
function buildDb(box) {
  const file = box.path('opencode.db');
  makeSqlite(file, (db) => {
    db.exec(`create table session (
      id text primary key, directory text, title text,
      time_created integer, time_updated integer,
      parent_id text, time_archived integer)`);
    db.exec(`create table message (
      id text primary key, session_id text, data text, time_created integer)`);
    db.exec(`create table part (
      message_id text, data text, time_created integer)`);

    const insS = db.prepare('insert into session values (?,?,?,?,?,?,?)');
    const insM = db.prepare('insert into message values (?,?,?,?)');
    const insP = db.prepare('insert into part values (?,?,?)');

    const t0 = 1700000000000;
    // main
    insS.run('s1', 'e:/my-app', '登录问题', t0, t0 + 60000, null, null);
    // user：先流控标记，再真话（顺序故意倒着放，验证按 time_created 排序）
    insM.run('m1', 's1', JSON.stringify({ role: 'user', time: { created: t0 + 1000 } }), t0 + 1000);
    insP.run('m1', JSON.stringify({ type: 'step-start' }), t0 + 1001);
    insP.run('m1', JSON.stringify({ type: 'text', text: '刷新就掉登录态' }), t0 + 1002);
    // assistant：reasoning + tool + text
    insM.run('m2', 's1', JSON.stringify({ role: 'assistant', time: { created: t0 + 5000 } }), t0 + 5000);
    insP.run('m2', JSON.stringify({ type: 'reasoning', text: '先看 auth 配置' }), t0 + 5001);
    insP.run(
      'm2',
      JSON.stringify({
        type: 'tool',
        tool: 'read_file',
        callID: 'c1',
        state: { input: { path: 'src/auth.js' }, output: 'export const t=1', status: 'done' },
      }),
      t0 + 5002
    );
    insP.run('m2', JSON.stringify({ type: 'text', text: '是 token 过期时间设短了' }), t0 + 5003);
    insP.run('m2', JSON.stringify({ type: 'step-finish' }), t0 + 5004);

    // 子代理：parent_id 指向 s1
    insS.run('sub1', 'e:/my-app', '子任务', t0 + 10000, t0 + 20000, 's1', null);

    // 已归档：不该出现在清单里
    insS.run('arch', 'e:/other', '已归档', t0, t0 + 1, null, t0 + 900000);
  });
  return file;
}

async function withDb(box, file, fn) {
  return box.run(async () => {
    try {
      return await withEnv({ OPENCODE_DB: file }, async () => {
        try {
          return await fn(file);
        } finally {
          opencode.closeStore();
        }
      });
    } finally {
      /* 沙箱由外层清理 */
    }
  });
}

test('opencode: 元数据一条 SQL 直出，归档的不出现，子代理照常采集', async () => {
  const box = sandbox();
  try {
    const file = buildDb(box);
    await withDb(box, file, async () => {
      const files = opencode.discover();
      assert.deepEqual(files, [file], 'OPENCODE_DB 精确覆盖必须生效（三个官方覆盖变量之一）');

      const sessions = opencode.parseAll(file);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      assert.equal(sessions.length, 2, '归档的会话不出现：2 main/子代理，1 归档');

      const s1 = byId.get('s1');
      assert.equal(s1.project, 'e:/my-app', 'directory 就是项目路径');
      assert.equal(s1.title, '登录问题', 'title 直出，不需要翻 message');
      assert.equal(s1.kind, 'main');
      assert.ok(s1.start && s1.end, 'time_created/updated 就是起止时间');

      const sub = byId.get('sub1');
      assert.ok(sub, '子代理要照常采集——它记着实际干的活');
      assert.equal(sub.kind, 'subagent');
      assert.equal(sub.parent, 's1');
    });
  } finally {
    box.cleanup();
  }
});

test('opencode: part 类型过滤——流控标记丢弃，text/reasoning/tool 各归其类', async () => {
  const box = sandbox();
  try {
    const file = buildDb(box);
    await withDb(box, file, async () => {
      const s1 = opencode.parseAll(file).find((s) => s.id === 's1');
      const msgs = opencode.readMessages(s1);

      assert.equal(msgs.length, 2, 'user + assistant');
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[1].role, 'assistant');

      const all = msgs.flatMap((m) => m.parts);
      const texts = all.filter((p) => p.kind === 'text').map((p) => p.text);
      assert.ok(texts.includes('刷新就掉登录态'), '真人那句话要完整保留');
      assert.ok(!texts.some((t) => /step-(start|finish)/.test(t)), '流控标记不是内容');

      const reasoning = all.find((p) => p.kind === 'reasoning');
      assert.ok(reasoning && reasoning.text === '先看 auth 配置', 'reasoning 单独归类');

      const tool = all.find((p) => p.kind === 'tool');
      assert.ok(tool, 'tool 单独归类');
      assert.equal(tool.name, 'read_file');
      assert.equal(tool.callId, 'c1');
      assert.deepEqual(tool.input, { path: 'src/auth.js' });
      assert.equal(tool.output, 'export const t=1');
    });
  } finally {
    box.cleanup();
  }
});

test('opencode: -wal 参与缓存指纹（新消息先落 wal，主库 mtime 可以不动）', () => {
  assert.deepEqual(opencode.extraFiles('x.db'), ['x.db-wal']);
});