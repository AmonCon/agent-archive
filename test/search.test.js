import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sandbox } from './helpers.js';

const { buildIndex, search, indexPath } = await import('../src/search.js');
const { clearScanCache } = await import('../src/registry.js');
const { clearTranscriptCache } = await import('../src/transcript-cache.js');
const { scanSecrets } = await import('../src/secrets.js');

/**
 * 全文索引的增量维护契约。
 *
 * 这里锁的是"改一场只付一场的代价，但**结果必须和不增量时一样**"。
 * 用 SQLite 触发器同步 doc_fts 是性能改造的核心，一旦某条触发器写错，
 * 症状是搜索静默缺结果——比慢更难发现，所以每条路径都要有用例压着。
 *
 * 只碰临时目录：真实索引有 200 MB 量级，测试绝不能去动它。
 */

/** 造一场 DSH 会话，返回源文件路径。 */
function writeSession(box, { id = 's1', text = '一段对话', createdAt = '2026-01-01T00:00:00Z' } = {}) {
  const file = box.path('.dsh', 'sessions', 'E--p', id, 'session.jsonl');
  fs.mkdirSync(box.path('.dsh', 'sessions', 'E--p', id), { recursive: true });
  fs.writeFileSync(file, lines(id, text, createdAt));
  return { file };
}

function lines(id, text, createdAt) {
  return (
    JSON.stringify({ type: 'session', id, createdAt, cwd: 'E:/p' }) +
    '\n' +
    JSON.stringify({ type: 'user/message', time: '2026-01-01T00:01:00Z', data: { content: text } }) +
    '\n'
  );
}

/** 改写同一场会话，并把 mtime 推到未来，保证指纹一定变。 */
function rewrite(file, { id, text }) {
  fs.writeFileSync(file, lines(id, text, '2026-01-01T00:00:00Z'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

/** 索引库里现存的触发器名字。 */
function triggerNames(db) {
  const own = !db;
  if (own) db = new DatabaseSync(indexPath(), { readOnly: true });
  try {
    return db
      .prepare("select name from sqlite_master where type = 'trigger' and name like 'doc_fts_%'")
      .all()
      .map((r) => r.name)
      .sort();
  } finally {
    if (own) db.close();
  }
}

/** 模拟改造前建的库：doc 和 doc_fts 都在，但没有同步触发器。 */
function dropAllTriggers() {
  const db = new DatabaseSync(indexPath());
  try {
    for (const t of triggerNames(db)) db.prepare(`drop trigger if exists ${t}`).run();
  } finally {
    db.close();
  }
}

test('search: 首次建库走 rebuild，建完能搜到', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '第一次建库聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      const r = await buildIndex();

      assert.equal(r.fts, 'rebuild', '首次建库必须走全量 rebuild');
      assert.equal(r.rebuilt, 1);
      assert.equal(search('缓存').total, 1, '建完就应该能搜到');
      assert.equal(triggerNames().length, 3, '建库后三条同步触发器要在');

      const forced = await buildIndex({ force: true });
      assert.equal(forced.fts, 'rebuild', '--force 也是全量');
      assert.equal(search('缓存').total, 1, 'rebuild 之后不能出现重复命中');
    });
  } finally {
    box.cleanup();
  }
});

test('search: 改一场会话只做增量更新，旧内容搜不到、新内容搜得到', async () => {
  const box = sandbox();
  try {
    const { file } = writeSession(box, { id: 's1', text: '旧版本讲的是缓存策略' });
    writeSession(box, { id: 's2', text: '另一场讲的是部署流程' });

    await box.run(async () => {
      clearScanCache();
      assert.equal((await buildIndex()).fts, 'rebuild');
      assert.equal(search('缓存').total, 1);

      rewrite(file, { id: 's1', text: '新版本改成了迁移方案' });
      clearScanCache();
      clearTranscriptCache();

      const r = await buildIndex();
      assert.equal(r.fts, 'incremental', '改一场不该再全量 rebuild');
      assert.equal(r.rebuilt, 1);
      assert.equal(r.reused, 1);

      assert.equal(search('缓存').total, 0, '旧正文必须从倒排里删掉');
      assert.equal(search('迁移').total, 1, '新正文必须进倒排');
      assert.equal(search('部署').total, 1, '没变的会话不能受影响');
    });
  } finally {
    box.cleanup();
  }
});

test('search: 会话从存储里消失后，正文也从倒排里消失', async () => {
  const box = sandbox();
  try {
    const { file } = writeSession(box, { id: 'gone', text: '这场会被删掉，关键词是归档' });
    writeSession(box, { id: 'keep', text: '这场留着不动' });

    await box.run(async () => {
      clearScanCache();
      assert.equal((await buildIndex()).fts, 'rebuild');
      assert.equal(search('归档').total, 1);

      fs.rmSync(file);
      clearScanCache();

      const r = await buildIndex();
      assert.equal(r.removed, 1);
      assert.equal(r.fts, 'incremental');
      assert.equal(search('归档').total, 0, '删除也必须同步到倒排');
      assert.equal(search('留着').total, 1);
    });
  } finally {
    box.cleanup();
  }
});

test('search: 老索引库没有触发器，打开后自动补上并继续增量', async () => {
  const box = sandbox();
  try {
    const { file } = writeSession(box, { id: 'old', text: '老库里的原文是缓存' });

    await box.run(async () => {
      clearScanCache();
      await buildIndex();

      dropAllTriggers();
      assert.equal(triggerNames().length, 0, '基线：老库确实没有触发器');

      rewrite(file, { id: 'old', text: '升级之后改写成了迁移' });
      clearScanCache();
      clearTranscriptCache();

      const r = await buildIndex();
      assert.equal(r.fts, 'incremental', '老库升级后也应走增量');
      assert.equal(triggerNames().length, 3, '打开老库时要自动补触发器');
      assert.equal(search('缓存').total, 0);
      assert.equal(search('迁移').total, 1);
    });
  } finally {
    box.cleanup();
  }
});

/** 直接读索引库里的一场，用来断言存储形态。 */
function readDoc() {
  const db = new DatabaseSync(indexPath(), { readOnly: true });
  try {
    return db.prepare('select key, body, body_z from doc limit 1').get();
  } finally {
    db.close();
  }
}

test('search: 正文压缩存储，body 为空、body_z 非空，摘录仍取自原文', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '这场聊的是缓存策略与迁移方案' });

    await box.run(async () => {
      clearScanCache();
      await buildIndex();

      const row = readDoc();
      assert.equal(row.body, null, '新写入的正文不该再存明文');
      assert.ok(row.body_z && row.body_z.length > 0, 'body_z 必须有压缩后的正文');

      const r = search('缓存');
      assert.equal(r.total, 1);
      assert.ok(r.hits[0].snippet.includes('缓存策略'), '摘录必须是解压后的原文，不能是乱码');
    });
  } finally {
    box.cleanup();
  }
});

test('search: 老库带明文 body 的记录，重开后被迁移并且仍能搜到', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 'legacy', text: '老库里的正文讲的是缓存策略' });

    await box.run(async () => {
      clearScanCache();
      await buildIndex();

      // 模拟升级前的库：没有 body_z 列和迁移标记，正文是明文 body
      const db = new DatabaseSync(indexPath());
      try {
        db.prepare('alter table doc drop column body_z').run();
        db.prepare("delete from meta where k = 'body_z_done'").run();
        db.prepare('update doc set body = ?').run('老库里的正文讲的是缓存策略');
      } finally {
        db.close();
      }

      // 迁移前的新代码读老库：不能因为缺 body_z 列就整条查询失败
      assert.equal(search('缓存策略').total, 1, '老库还没迁移时也要能读明文正文');
      assert.ok(search('缓存策略').hits[0].snippet.includes('缓存策略'));

      // 重开（buildIndex 内部走 openIndex）触发列迁移和正文压缩
      clearScanCache();
      await buildIndex();

      const reopened = new DatabaseSync(indexPath(), { readOnly: true });
      let row;
      let marker;
      try {
        row = reopened.prepare('select body, body_z from doc limit 1').get();
        marker = reopened.prepare("select v from meta where k = 'body_z_done'").get();
      } finally {
        reopened.close();
      }
      assert.equal(row.body, null, '迁移后明文正文应被清空');
      assert.ok(row.body_z && row.body_z.length > 0, '迁移后应留下压缩正文');
      assert.ok(marker, '一次性迁移要留下 body_z_done 标记');

      assert.equal(search('缓存策略').total, 1, '迁移不能影响倒排');
      assert.ok(search('缓存策略').hits[0].snippet.includes('缓存策略'));
    });
  } finally {
    box.cleanup();
  }
});

test('secrets: 压缩正文里的凭证仍然能被扫出来', async () => {
  const box = sandbox();
  try {
    // AWS 文档里的示例 AccessKey，拆开写以免仓库的凭证检查把它当真实泄漏
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    writeSession(box, {
      id: 's1',
      text: `部署脚本里硬编码了 ${awsKey} 这个 key`,
    });

    await box.run(async () => {
      clearScanCache();
      await buildIndex();
      assert.equal(readDoc().body, null, '前提：正文确实已经压缩');

      const r = scanSecrets();
      assert.equal(r.ready, true);
      const hit = r.findings.find((f) => f.type === 'aws-ak');
      assert.ok(hit, '压缩正文被正确解压后应报出 AWS AccessKey');
      assert.ok(hit.samples[0].masked.startsWith('AKIA'), '样本仍要按原规则掩码');
      assert.ok(!hit.samples[0].masked.includes(awsKey), '样本不能是完整凭证');
      assert.ok(!hit.context.includes(awsKey), '上下文不能是完整凭证');
    });
  } finally {
    box.cleanup();
  }
});
