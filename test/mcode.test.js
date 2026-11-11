import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, tempDir, makeSqlite, withEnv } from './helpers.js';
import * as mcode from '../src/scanners/mcode.js';

/**
 * MCode 扫描器的格式契约（形状来自 CC Switch mcode.rs / MAGPIE calls_minimax.go）。
 *
 * 锁三件会静默出错的事：
 *   1. **SQLite 两代消息表判定**：local_runtime_message_row_migrations 里有该 session
 *      → 读新表 local_runtime_message_rows；否则读旧表 display_messages_json。
 *      已迁移会话必须忽略残留的 legacy blob；过滤 hidden/archived/子会话/peek。
 *   2. **JSONL 形态也认**：v2/sessions/<日期>/<时间>-session_<b64(id)>/messages.jsonl，
 *      session id 按 4 种 base64 编码轮流解、解不出用目录名（别编）；多代 messages*.jsonl
 *      按 message_id 去重，不当成两场会话；上游没给 cwd，project 留 null。
 *   3. **两种形态同根并存**：按「目录里有什么」分派 parseAll/readMessages，
 *      绝不因为认了一种就漏掉另一种。
 *
 * 另外锁：显式数据源 discoverWithin / ctx.roots 越界校验不被本机根误杀。
 */

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

function cleanEnv() {
  return { KIMI_CODE_HOME: null, GROK_HOME: null, MINIMAX_DATA_DIR: null, MAVIS_DATA_DIR: null };
}

const T0 = 1700000000000; // 2023-11-14T22:13:20Z，毫秒

/** 造 CC Switch 的 runtime-state.sqlite：两代消息表 + 各种该被过滤的会话。 */
function buildDb(file) {
  return makeSqlite(file, (db) => {
    db.exec(`CREATE TABLE local_runtime_sessions (
      session_id TEXT, title TEXT, workspace_dir TEXT, created_at_ms INTEGER,
      updated_at_ms INTEGER, visibility TEXT, parent_session_id TEXT,
      session_kind TEXT, archived INTEGER)`);
    const insS = db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?,?,?,?,?)');
    insS.run('mvs_public', 'SQLite 应用标题', '/work', T0, T0 + 60000, 'visible', null, 'conversation', 0);
    insS.run('mvs_child', '子会话', '/work', T0, T0 + 60000, 'visible', 'mvs_public', 'task', 0);
    insS.run('mvs_hidden', '隐藏', '/work', T0, T0 + 60000, 'hidden', null, 'conversation', 0);
    insS.run('mvs_archived', '归档', '/work', T0, T0 + 60000, 'visible', null, 'conversation', 1);
    insS.run('mvs_peek', 'peek', '/work', T0, T0 + 60000, 'visible', null, 'peek', 0);
    // 未迁移会话：正文在旧表 display_messages_json
    insS.run('mvs_legacy', 'Legacy 应用标题', '/work', T0 + 100000, T0 + 160000, 'visible', null, 'conversation', 0);

    db.exec('CREATE TABLE local_runtime_message_row_migrations (session_id TEXT)');
    db.prepare('INSERT INTO local_runtime_message_row_migrations VALUES (?)').run('mvs_public');

    db.exec(`CREATE TABLE local_runtime_message_rows (
      id INTEGER, session_id TEXT, role TEXT, data_json TEXT, created_at_ms INTEGER)`);
    const insR = db.prepare('INSERT INTO local_runtime_message_rows VALUES (?,?,?,?,?)');
    insR.run(1, 'mvs_public', 'user', JSON.stringify({ msg_content: 'Fix this project' }), T0 + 1000);
    insR.run(2, 'mvs_public', 'assistant', JSON.stringify({ msg_content: 'Tests passed' }), T0 + 2000);

    db.exec('CREATE TABLE local_runtime_messages (session_id TEXT, display_messages_json TEXT)');
    const insL = db.prepare('INSERT INTO local_runtime_messages VALUES (?,?)');
    // 已迁移会话里残留的 legacy blob：必须被忽略
    insL.run('mvs_public', JSON.stringify([{ role: 'user', msg_content: '过时的旧数据' }]));
    insL.run('mvs_legacy', JSON.stringify([
      { role: 'user', msg_content: 'Legacy question', timestamp: '1700000101000' },
      { role: 'assistant', msg_content: 'Legacy answer', created_at: T0 + 101000 },
      { role: 'tool', msg_content: 'Hidden tool output' },
    ]));
  });
}

/** 4 种 base64 编码（MAGPIE: RawURL / URL / RawStd / Std）。 */
function encodings(id) {
  const std = Buffer.from(id, 'utf8').toString('base64');
  return {
    rawUrl: Buffer.from(id, 'utf8').toString('base64url'),
    url: std.replace(/\+/g, '-').replace(/\//g, '_'), // 带 padding
    rawStd: std.replace(/=+$/, ''),
    std,
  };
}

function jsonlSession(box, relDir, { content = '第一句真人输入', extra } = {}) {
  box.write(`${relDir}/messages.jsonl`, jsonl(
    { message_id: 'm1', turn_id: 't1', message: { role: 'user', content, timestamp: T0 } },
    { message_id: 'm2', turn_id: 't1', message: { role: 'assistant', provider: 'custom_provider:relay', model: 'm2', usage: { input: 1, output: 2 }, timestamp: T0 + 1000 } }
  ));
  if (extra) box.write(`${relDir}/messages.2.jsonl`, extra);
  return box.path(relDir);
}

test('mcode: SQLite 两代消息表判定 + 过滤；标题取真人首句', async () => {
  const box = sandbox();
  try {
    const db = buildDb(box.path('.minimax', 'v2', 'sqlite', 'runtime-state.sqlite'));
    await box.run(() => withEnv(cleanEnv(), () => {
      assert.deepEqual(mcode.discover(), [db], '发现 runtime-state.sqlite');
      const sessions = mcode.parseAll(db);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      assert.equal(sessions.length, 2, '只留 mvs_public / mvs_legacy：子会话、hidden、archived、peek 都过滤');
      assert.ok(!byId.has('mvs_child') && !byId.has('mvs_hidden') && !byId.has('mvs_archived') && !byId.has('mvs_peek'));

      const pub = byId.get('mvs_public');
      assert.equal(pub.title, 'Fix this project', '标题取第一句真人输入，不是 SQLite 的 title');
      assert.equal(pub.project, '/work');
      assert.equal(pub.start.getUTCFullYear(), 2023, 'created_at_ms 是毫秒，不能被当秒');
      assert.ok(pub.source.endsWith('#mvs_public'), 'SQLite 会话 source 带 #id');

      // 已迁移 → 读新表，忽略残留的 legacy blob
      const pubMsgs = mcode.readMessages(pub);
      assert.deepEqual(pubMsgs.map((m) => m.parts[0].text), ['Fix this project', 'Tests passed']);
      assert.ok(!JSON.stringify(pubMsgs).includes('过时的旧数据'), '已迁移会话必须忽略旧 blob');

      // 未迁移 → 读旧表 display_messages_json，tool 行不暴露
      const leg = byId.get('mvs_legacy');
      assert.equal(leg.title, 'Legacy question');
      const legMsgs = mcode.readMessages(leg);
      assert.deepEqual(legMsgs.map((m) => m.parts[0].text), ['Legacy question', 'Legacy answer']);
      assert.ok(!JSON.stringify(legMsgs).includes('Hidden tool output'), '只暴露展示行（user/assistant）');
    }));
  } finally {
    box.cleanup();
  }
});

test('mcode: JSONL 形态也认；4 种 base64 解 id、解不出用目录名；多代去重', async () => {
  const box = sandbox();
  try {
    const base = '.minimax/v2/sessions/2026/07/16';
    const ids = ['mvs_a', 'mvs_b', 'mvs_c', 'mvs_d'];
    // 每个会话用一种编码命名（时间戳前缀只是形状）
    const variants = [
      encodings(ids[0]).rawUrl,
      encodings(ids[1]).url,
      encodings(ids[2]).rawStd,
      encodings(ids[3]).std,
    ];
    const dirs = [];
    for (let i = 0; i < 4; i++) {
      const name = `12-00-00-00${i}-session_${variants[i]}`;
      const rel = `${base}/${name}`;
      dirs.push(name);
      jsonlSession(box, rel, { content: `${ids[i]} 的真人首句` });
    }
    // 多代：mvs_a 目录里再来一份 messages.2.jsonl，含一条复制的 m1 与一条新 m3
    const first = `${base}/${dirs[0]}`;
    box.write(`${first}/messages.2.jsonl`, jsonl(
      { message_id: 'm1', turn_id: 't1', message: { role: 'user', content: 'mvs_a 的真人首句', timestamp: T0 } },
      { message_id: 'm3', turn_id: 't2', message: { role: 'user', content: '多代里的新一句', timestamp: T0 + 2000 } }
    ));
    // 解不出的编码：目录名当 id，别编
    const brokenName = '12-00-00-099-session_@@@not-base64@@@';
    jsonlSession(box, `${base}/${brokenName}`, { content: '解不出编码的会话' });

    await box.run(() => withEnv(cleanEnv(), () => {
      const files = mcode.discover();
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
      assert.equal(jsonlFiles.length, 5, '4 种编码 + 1 个解不出的，每个会话目录只出一个代表文件');
      // 多代同目录不额外出文件
      assert.equal(jsonlFiles.filter((f) => f.includes(dirs[0])).length, 1, '多代 messages*.jsonl 同属一场会话');

      const sessions = jsonlFiles.flatMap((f) => mcode.parseAll(f));
      const byId = new Map(sessions.map((s) => [s.id, s]));
      for (const id of ids) {
        assert.ok(byId.has(id), `4 种 base64 编码都要解出 ${id}`);
        assert.equal(byId.get(id).project, null, 'JSONL 形态上游没给 cwd：留 null，不猜');
        assert.equal(byId.get(id).start.getUTCFullYear(), 2023, 'timestamp 是毫秒，不掉到 1970');
      }
      assert.ok(byId.has(brokenName), '解不出 base64 就用目录名，别编一个 id');
      assert.equal(byId.get('mvs_a').title, 'mvs_a 的真人首句');

      const aMsgs = mcode.readMessages(byId.get('mvs_a'));
      const userTexts = aMsgs.filter((m) => m.role === 'user').map((m) => m.parts[0].text);
      assert.equal(userTexts.filter((t) => t === 'mvs_a 的真人首句').length, 1, '多代里复制的 message_id 只算一次');
      assert.ok(userTexts.includes('多代里的新一句'), '另一代的新消息也要读得到');
    }));
  } finally {
    box.cleanup();
  }
});

test('mcode: 两种形态同根并存时按「目录下有什么」分派', async () => {
  const root = tempDir();
  try {
    const db = root.path('.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
    makeSqlite(db, (d) => {
      d.exec(`CREATE TABLE local_runtime_sessions (
        session_id TEXT, title TEXT, workspace_dir TEXT, created_at_ms INTEGER,
        updated_at_ms INTEGER, visibility TEXT, parent_session_id TEXT,
        session_kind TEXT, archived INTEGER)`);
      d.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?,?,?,?,?)')
        .run('sql-1', '标题', '/sql', T0, T0 + 1000, 'visible', null, 'conversation', 0);
      d.exec('CREATE TABLE local_runtime_message_row_migrations (session_id TEXT)');
      d.prepare('INSERT INTO local_runtime_message_row_migrations VALUES (?)').run('sql-1');
      d.exec('CREATE TABLE local_runtime_message_rows (id INTEGER, session_id TEXT, role TEXT, data_json TEXT, created_at_ms INTEGER)');
      d.prepare('INSERT INTO local_runtime_message_rows VALUES (?,?,?,?,?)')
        .run(1, 'sql-1', 'user', JSON.stringify({ msg_content: 'SQLite 形态的话' }), T0);
    });
    const jsonlDir = '.minimax/v2/sessions/2026/07/16/12-00-00-000-session_' +
      Buffer.from('jsonl-1', 'utf8').toString('base64url');
    root.write(`${jsonlDir}/messages.jsonl`, jsonl(
      { message_id: 'j1', message: { role: 'user', content: 'JSONL 形态的话', timestamp: T0 } }
    ));

    const appRoot = root.path('.minimax');
    const files = mcode.discoverWithin([appRoot], {});
    assert.equal(files.length, 2, '同一个应用根下两种形态的文件都发现');
    assert.ok(files.some((f) => f.endsWith('.sqlite')), 'SQLite 形态');
    assert.ok(files.some((f) => f.endsWith('.jsonl')), 'JSONL 形态');

    const sessions = files.flatMap((f) => mcode.parseAll(f));
    const byId = new Map(sessions.map((s) => [s.id, s]));
    assert.ok(byId.has('sql-1') && byId.has('jsonl-1'), '两场会话都解出来，不因为认了一种就漏另一种');
    assert.ok(mcode.readMessages(byId.get('sql-1'), { roots: [appRoot] })
      .some((m) => m.parts[0].text === 'SQLite 形态的话'), 'SQLite 会话走 SQLite 分支');
    assert.ok(mcode.readMessages(byId.get('jsonl-1'), { roots: [appRoot] })
      .some((m) => m.parts[0].text === 'JSONL 形态的话'), 'JSONL 会话走 JSONL 分支');
  } finally {
    root.cleanup();
  }
});

test('mcode: structureSpec 确定 + decoy 不误判 + 显式根下 ctx.roots 不误杀', async () => {
  const spec = mcode.structureSpec;
  assert.equal(spec.agent, 'mcode');
  assert.equal(spec.minScore, 4);
  assert.deepEqual(spec.rootAnchor, { from: 'v2', up: 1 });
  assert.deepEqual(spec.dirHints, ['.minimax']);
  assert.ok(spec.probes.some((p) => p.path === 'v2/sqlite/runtime-state.sqlite' && p.weight === 5));
  assert.ok(spec.probes.some((p) => p.glob === 'v2/sessions/**/messages.jsonl' && p.weight === 4));
  assert.ok(spec.probes.some((p) => p.path === 'v2/sessions' && p.kind === 'dir' && p.weight === 1));
  assert.equal(typeof mcode.discoverWithin, 'function', 'structureSpec 与 discoverWithin 必须成对加');

  const decoy = tempDir();
  try {
    decoy.write('v2/sessions/foo/random.jsonl', '{}\n'.repeat(5));
    assert.deepEqual(mcode.discoverWithin([decoy.dir], {}), [], '无关 .jsonl 不构成 mcode 会话');

    const root = tempDir();
    try {
      const rel = '.minimax/v2/sessions/2026/07/16/12-00-00-000-session_' +
        Buffer.from('ext-1', 'utf8').toString('base64url');
      root.write(`${rel}/messages.jsonl`, jsonl(
        { message_id: 'e1', message: { role: 'user', content: '外部源的会话', timestamp: T0 } }
      ));
      const appRoot = root.path('.minimax');
      const files = mcode.discoverWithin([appRoot], {});
      assert.equal(files.length, 1, '显式应用根下能发现 JSONL 会话');
      const s = mcode.parseAll(files[0])[0];
      const msgs = mcode.readMessages(s, { roots: [appRoot] });
      assert.ok(msgs.some((m) => m.parts.some((p) => p.text === '外部源的会话')),
        'ctx.roots 优先，外部文件不被本机根误杀');
      assert.ok(path.isAbsolute(s.source), 'source 是绝对路径');
    } finally {
      root.cleanup();
    }
  } finally {
    decoy.cleanup();
  }
});
