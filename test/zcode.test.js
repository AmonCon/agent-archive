import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, makeSqlite } from './helpers.js';
import * as zcode from '../src/scanners/zcode.js';

/**
 * ZCode 扫描器的格式契约。
 *
 * 与 OpenCode 同源（session/message/part 三表），但有两个自己的坑，
 * 全部来自实测：
 *
 *   1. **title_source='default' 的标题是自动生成的默认值**，不是用户起的。
 *      直接用会让时间线里出现一堆"新会话"式的噪声；要回退到第一条真人消息。
 *   2. **message.data.semantics.origin 是这里独有的**：
 *      real_user=真人敲的，agent_runtime=注入的上下文。
 *      用它区分注入比猜文本前缀可靠得多——注入内容归 system，不冒充用户发言。
 *
 * 另外锁两件容易悄悄坏的事：
 *   - time_deleted 非空的会话不出现（软删除不是不存在，但也不该进时间线）
 *   - 子代理（parent_id 非空）照常采集并标 kind/parent
 *
 * fixture 里 sessions.title_source 与 messages.sequence 是硬契约：
 * 前者缺列会让 parseAll 的 SELECT 整条抛错、静默返回空数组；
 * 后者决定正文顺序，错了对话会乱序。
 */

/** 造一个最小的 db.sqlite：默认标题、手写标题、子代理、软删除各一场。 */
function buildDb(box) {
  const file = box.path('.zcode', 'cli', 'db', 'db.sqlite');
  makeSqlite(file, (db) => {
    db.exec(`create table session (
      id text primary key, directory text, title text, title_source text,
      time_created integer, time_updated integer,
      parent_id text, time_deleted integer)`);
    db.exec(`create table message (
      id integer primary key autoincrement, session_id text,
      sequence integer, data text)`);
    db.exec(`create table part (
      message_id integer, sequence integer, data text)`);

    const insS = db.prepare('insert into session values (?,?,?,?,?,?,?,?)');
    const insM = db.prepare('insert into message values (?,?,?,?)');
    const insP = db.prepare('insert into part values (?,?,?)');

    const t0 = 1700000000000;
    // s1：默认标题——要回退到第一条真人消息
    insS.run('s1', 'e:/my-app', 'ZCode 新会话', 'default', t0, t0 + 60000, null, 0);
    // s1 的消息：注入的上下文（agent_runtime）在前，真人那句话在后
    insM.run(1, 's1', 1, JSON.stringify({ role: 'user', semantics: { origin: 'agent_runtime', kind: 'system_reminder' }, time: { created: t0 + 500 } }));
    insP.run(1, 1, JSON.stringify({ type: 'text', text: '<system-reminder>这是注入的环境说明</system-reminder>' }));
    insM.run(2, 's1', 2, JSON.stringify({ role: 'user', semantics: { origin: 'real_user' }, time: { created: t0 + 1000 } }));
    insP.run(2, 1, JSON.stringify({ type: 'text', text: '真实的第一句：刷新就掉登录态' }));
    // assistant：reasoning + tool + 流控标记
    insM.run(3, 's1', 3, JSON.stringify({ role: 'assistant', time: { created: t0 + 5000 } }));
    insP.run(3, 1, JSON.stringify({ type: 'reasoning', text: '先看 auth 配置' }));
    insP.run(3, 2, JSON.stringify({ type: 'tool', tool: 'read_file', callID: 'c1', state: { input: { path: 'src/auth.js' }, output: 'ok', status: 'done' } }));
    insP.run(3, 3, JSON.stringify({ type: 'step-start' }));
    insP.run(3, 4, JSON.stringify({ type: 'text', text: '是 token 过期时间设短了' }));

    // s2：手写标题——必须原样保留
    insS.run('s2', 'e:/other', '手写的标题', 'user', t0 + 100000, t0 + 160000, null, 0);
    insM.run(4, 's2', 1, JSON.stringify({ role: 'user', semantics: { origin: 'real_user' }, time: { created: t0 + 101000 } }));
    insP.run(4, 1, JSON.stringify({ type: 'text', text: '另一场对话' }));

    // s3：子代理
    insS.run('s3', 'e:/my-app', '子任务', 'default', t0 + 200000, t0 + 260000, 's1', 0);

    // s4：软删除——不该出现
    insS.run('s4', 'e:/gone', '已删除', 'user', t0, t0 + 1, null, t0 + 900000);
  });
  return file;
}

async function withDb(box, fn) {
  return box.run(async () => {
    try {
      return await fn();
    } finally {
      zcode.closeStore();
    }
  });
}

test('zcode: 默认标题回退到第一条真人消息，手写标题原样保留', async () => {
  const box = sandbox();
  try {
    const file = buildDb(box);
    await withDb(box, async () => {
      const files = zcode.discover();
      assert.deepEqual(files, [file], '默认位置 ~/.zcode/cli/db/db.sqlite 要被找到（家目录已隔离）');

      const sessions = zcode.parseAll(file);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      assert.equal(sessions.length, 3, '软删除的 s4 不出现：s1/s2/s3 三场');

      const s1 = byId.get('s1');
      assert.equal(
        s1.title,
        '真实的第一句：刷新就掉登录态',
        'title_source=default 的标题是噪声，要回退到第一条真人消息'
      );

      const s2 = byId.get('s2');
      assert.equal(s2.title, '手写的标题', 'title_source=user 的标题不能被覆盖');
    });
  } finally {
    box.cleanup();
  }
});

test('zcode: semantics.origin 区分注入与真人——注入归 system，不冒充用户', async () => {
  const box = sandbox();
  try {
    const file = buildDb(box);
    await withDb(box, async () => {
      const s1 = zcode.parseAll(file).find((s) => s.id === 's1');
      const msgs = zcode.readMessages(s1);

      const injected = msgs.find((m) => m.meta && m.meta.origin === 'agent_runtime');
      assert.ok(injected, '注入的消息要被识别出来');
      assert.equal(injected.role, 'system', '注入内容归 system——让它冒充用户发言比丢数据更糟');
      assert.ok(
        injected.parts.some((p) => p.kind === 'text' && p.text.includes('注入的环境说明')),
        '注入的内容仍在（是事实），只是换了身份'
      );

      const real = msgs.find((m) => m.meta && m.meta.origin === 'real_user');
      assert.ok(real, '真人消息要单独存在');
      assert.equal(real.role, 'user');
      assert.equal(real.parts[0].text, '真实的第一句：刷新就掉登录态');

      const assistant = msgs.find((m) => m.role === 'assistant');
      const kinds = assistant.parts.map((p) => p.kind);
      assert.deepEqual(
        kinds.filter((k) => k === 'reasoning' || k === 'tool' || k === 'text'),
        ['reasoning', 'tool', 'text'],
        'reasoning/tool/text 各归其类，且顺序由 sequence 决定'
      );
      const tool = assistant.parts.find((p) => p.kind === 'tool');
      assert.equal(tool.name, 'read_file');
      assert.deepEqual(tool.input, { path: 'src/auth.js' });
      assert.ok(!assistant.parts.some((p) => p.text && /step-start/.test(p.text)), '流控标记不是内容');
    });
  } finally {
    box.cleanup();
  }
});

test('zcode: 子代理照常采集标归属；-wal 参与缓存指纹', async () => {
  const box = sandbox();
  try {
    const file = buildDb(box);
    await withDb(box, async () => {
      const sessions = zcode.parseAll(file);
      const s3 = sessions.find((s) => s.id === 's3');
      assert.ok(s3, '子代理要照常采集——它记着实际干的活');
      assert.equal(s3.kind, 'subagent');
      assert.equal(s3.parent, 's1');

      assert.deepEqual(zcode.extraFiles('x.db'), ['x.db-wal'], '新消息先落 wal，主库 mtime 可以长时间不动');
    });
  } finally {
    box.cleanup();
  }
});