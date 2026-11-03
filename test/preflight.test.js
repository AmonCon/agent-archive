import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnvironment } from '../src/preflight.js';

/**
 * 入口自检的契约。
 *
 * 这件事踩过一次：`engines` 与 README 都写着「Node 22.15 或更高」，
 * CI 也真的在 22.15 上跑——然后那台机器上 `search` 和 `secrets` 全崩，
 * 报 `no such module: fts5`。原因是 `node:sqlite` 22.5 就有了，
 * 但它带的 SQLite 到 22.16 才编译 FTS5 扩展，而 23.x 整条线都没有。
 *
 * 所以自检不能只问「有没有 node:sqlite」，必须真的建一张 fts5 虚拟表。
 * 下面把判据和文案都锁住：文案是给用户看的，读不懂就起不到作用。
 */

test('契约：三样能力都齐、版本也够时，自检通过', () => {
  const r = checkEnvironment({
    nodeVersion: 'v24.12.0',
    features: { zstd: true, sqlite: true, fts5: true },
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('契约：FTS5 缺失要单独报，并说清要升到哪个版本、23.x 不行', () => {
  const r = checkEnvironment({
    // 这正是 Node 22.15 的真实状态：zstd 有、node:sqlite 有、fts5 没有
    nodeVersion: 'v22.15.0',
    features: { zstd: true, sqlite: true, fts5: false },
  });
  assert.equal(r.ok, false);

  const text = r.problems.join('\n');
  assert.match(text, /FTS5/, '必须点名 FTS5，否则用户不知道是哪个能力缺了');
  assert.match(text, /22\.16/, '必须给出可用版本，不能只说「不支持」');
  assert.match(text, /23\.x/, '23.x 整条线都没有 FTS5，不写清楚会被反复踩');
});

test('契约：版本太低时的提示要给出最低版本与三条理由', () => {
  const r = checkEnvironment({
    nodeVersion: 'v20.11.0',
    features: { zstd: false, sqlite: false, fts5: false },
  });
  assert.equal(r.ok, false);

  const text = r.problems.join('\n');
  assert.match(text, /22\.16\.0/, '要说出最低版本，而不是让用户自己去查');
  assert.match(text, /zstd/, '要说清 zstd 是干什么用的');
  assert.match(text, /node:sqlite/, '要说清 node:sqlite 是干什么用的');
  assert.match(text, /FTS5/, '要说清 FTS5 是干什么用的');
});

test('契约：缺 zstd 或 node:sqlite 时各自单独报，不合并成一句', () => {
  const onlyZstd = checkEnvironment({
    nodeVersion: 'v24.12.0',
    features: { zstd: true, sqlite: false, fts5: false },
  });
  const onlySqlite = checkEnvironment({
    nodeVersion: 'v24.12.0',
    features: { zstd: false, sqlite: true, fts5: true },
  });
  assert.ok(onlyZstd.problems.some((p) => /node:sqlite/.test(p)));
  assert.ok(onlySqlite.problems.some((p) => /zstd/.test(p)));
  // 缺 node:sqlite 时不必再单独抱怨 fts5——它压根没法探测
  assert.ok(!onlyZstd.problems.some((p) => /FTS5/.test(p)));
});