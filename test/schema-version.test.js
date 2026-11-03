import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sandbox } from './helpers.js';

const { buildIndex, indexPath } = await import('../src/search.js');
const { clearScanCache } = await import('../src/registry.js');
const { clearTranscriptCache } = await import('../src/transcript-cache.js');

/**
 * 索引库的 schema 版本契约。
 *
 * 为什么值得锁：索引库是同一个文件名沿用到底，靠 `create if not exists` +
 * 每次打开跑幂等 ALTER 往前挪。这只能**往前补**，回答不了两个问题——
 * 这库是哪版建的；旧代码打开新库（用户把工具降级了）会不会读出错数据。
 * 后者最危险：列在但语义变了，查询不报错，只是结果悄悄不对。
 *
 * 这里锁三个行为：
 *   1. 新库建好时写入当前版本号
 *   2. 没有 meta 的 v1 老库重建后升到当前版本（幂等 ALTER 补列、条目还在）
 *   3. 版本号高于当前的库（未来库开旧代码）必须抛错说人话，不许静默猜
 */

/** 造一场 DSH 会话，返回源文件路径。照抄 search.test.js 的 fixture。 */
function writeSession(box, { id = 's1', text = '一段对话' } = {}) {
  const file = box.path('.dsh', 'sessions', 'E--p', id, 'session.jsonl');
  fs.mkdirSync(box.path('.dsh', 'sessions', 'E--p', id), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session', id, createdAt: '2026-01-01T00:00:00Z', cwd: 'E:/p' }) +
      '\n' +
      JSON.stringify({ type: 'user/message', time: '2026-01-01T00:01:00Z', data: { content: text } }) +
      '\n'
  );
  return { file };
}

/** 读库里的 schema_version；库不存在返回 undefined，库存在但没版本号返回 null。 */
function readSchemaVersion() {
  if (!fs.existsSync(indexPath())) return undefined;
  const db = new DatabaseSync(indexPath(), { readOnly: true });
  try {
    const row = db.prepare("select v from meta where k = 'schema_version'").get();
    return row ? Number(row.v) : null;
  } finally {
    db.close();
  }
}

test('schema: 新库建好时盖当前版本号', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      await buildIndex();
      assert.equal(readSchemaVersion(), 3, '新库必须写入当前 schema 版本');
    });
  } finally {
    box.cleanup();
  }
});

test('schema: 没有版本号的 v1 老库，重建后升到当前版本且条目还在', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      await buildIndex();
      assert.equal(readSchemaVersion(), 3);

      // 人为降回 v1：去掉版本号、去掉 kind/body_z 两列（最老库的形状）
      const db = new DatabaseSync(indexPath());
      try {
        db.prepare("delete from meta where k = 'schema_version'").run();
        db.prepare('alter table doc drop column kind').run();
        db.prepare('alter table doc drop column body_z').run();
      } finally {
        db.close();
      }
      assert.equal(readSchemaVersion(), null, '降级后版本号应该没有了');

      // 重新建索引：openIndex 建表 + 幂等 ALTER 补列 + 盖版本号
      clearScanCache();
      clearTranscriptCache();
      const r = await buildIndex({ force: true });
      assert.ok(r.rebuilt >= 1, '重建至少要处理那一场会话');
      assert.equal(readSchemaVersion(), 3, '老库迁移后必须升到当前版本');
    });
  } finally {
    box.cleanup();
  }
});

test('schema: 版本号高于当前的库必须拒绝，不许静默读', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      await buildIndex();

      // 把版本号抬到未来：模拟「用户降级工具后，旧代码开新库」
      const db = new DatabaseSync(indexPath());
      try {
        db.prepare("update meta set v = '99' where k = 'schema_version'").run();
      } finally {
        db.close();
      }

      await assert.rejects(
        () => buildIndex({ force: true }),
        (e) => {
          assert.match(e.message, /schema 版本 99/);
          assert.match(e.message, /只认到版本 3/);
          assert.match(e.message, /升级/, '错误信息要告诉用户怎么办');
          return true;
        },
        '未来库必须抛错说人话——静默读一个语义未知的库，错误没有声音'
      );
    });
  } finally {
    box.cleanup();
  }
});