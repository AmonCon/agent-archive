import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sandbox } from './helpers.js';
import { readUsage, summarizeUsage, normalizeFresh, SOURCES } from '../src/usage.js';

/**
 * 用量层的口径契约。
 *
 * 这一层最危险的错误不是读不出来，而是**读出来但算错了**：
 * 各家 input_tokens 的含义不一样，混着加会得出一个看起来很合理、
 * 实际错几倍的数字。这些用例把四种口径钉死，上游改了格式会先红。
 */

const only = (...ids) => SOURCES.filter((s) => ids.includes(s.id));

/** 建一个最小 SQLite：只带用例需要的列。 */
function sqlite(file, ddl, inserts = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const s of ddl) db.exec(s);
  for (const [sql, params] of inserts) db.prepare(sql).run(...params);
  db.close();
}

test('usage: ZCode 的 input 含缓存读，换算成不含缓存才算对', async () => {
  const box = sandbox();
  try {
    const file = box.path('zcode.sqlite');
    sqlite(
      file,
      [
        `create table model_usage (
           session_id text, model_id text, provider_id text, status text, started_at integer,
           input_tokens integer, output_tokens integer, reasoning_tokens integer,
           cache_creation_input_tokens integer, cache_read_input_tokens integer,
           duration_ms integer, time_to_first_token_ms integer)`,
      ],
      [
        [
          `insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['s1', 'glm', 'p1', 'completed', 1767225600000, 100, 5, 0, 10, 80, null, null],
        ],
      ]
    );

    const r = await readUsage({ sources: only('zcode'), paths: { zcode: file } });
    const [row] = r.rows;
    assert.equal(row.semantic, 'total');
    assert.equal(row.input, 100, '原始 input 照原样留着，便于对账');
    assert.equal(row.fresh, 10, '100 - 缓存读 80 - 缓存写 10 = 10');
    assert.equal(row.cacheRead, 80);
    assert.equal(row.calls, 1, 'ZCode 是按请求记的，一条就是一次调用');
  } finally {
    box.cleanup();
  }
});

test('usage: OpenCode 的 input 不含缓存，不能再减一次', async () => {
  const box = sandbox();
  try {
    const file = box.path('opencode.sqlite');
    sqlite(
      file,
      [
        `create table session_v2 (
           id text, model text, cost real, tokens_input integer, tokens_output integer,
           tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer,
           time_created integer)`,
      ],
      [
        [
          `insert into session_v2 values (?,?,?,?,?,?,?,?,?)`,
          ['ses_1', '{"id":"kimi-k2","providerID":"opencode"}', 0.0, 10, 2, 0, 80, 0, 1767225600000],
        ],
      ]
    );

    const r = await readUsage({ sources: only('opencode'), paths: { opencode: file } });
    const [row] = r.rows;
    assert.equal(row.semantic, 'fresh');
    assert.equal(row.fresh, 10, 'input 本来就是未缓存部分，减了就成了负数');
    assert.equal(row.cacheRead, 80);
    assert.equal(row.model, 'kimi-k2', '模型存的是 JSON，要拆出 id');
    assert.equal(row.provider, 'opencode');
    assert.equal(row.cost, null, 'cost=0 视为没报，不能当免费');
  } finally {
    box.cleanup();
  }
});

test('usage: 减成负数时归零，不让负数污染求和', () => {
  // 源的数据自相矛盾（缓存读比总输入还大）时，宁可归零也不报负数
  assert.equal(normalizeFresh({ input: 5, cacheRead: 80, cacheWrite: 0, semantic: 'total' }), 0);
  assert.equal(normalizeFresh({ input: 5, cacheRead: 80, cacheWrite: 0, semantic: 'fresh' }), 5);
});

test('usage: 口径未知的来源不进缓存命中率', async () => {
  const box = sandbox();
  try {
    const zcode = box.path('z.sqlite');
    sqlite(
      zcode,
      [
        `create table model_usage (
           session_id text, model_id text, provider_id text, status text, started_at integer,
           input_tokens integer, output_tokens integer, reasoning_tokens integer,
           cache_creation_input_tokens integer, cache_read_input_tokens integer,
           duration_ms integer, time_to_first_token_ms integer)`,
      ],
      [[`insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?)`, ['s1', 'm', 'p', 'ok', 1767225600000, 100, 5, 0, 0, 80, null, null]]]
    );
    const codex = box.path('codex.sqlite');
    sqlite(
      codex,
      [`create table threads (id text, cwd text, updated_at integer, tokens_used integer)`],
      [[`insert into threads values (?,?,?,?)`, ['t1', null, 1767225600000, 12345]]]
    );

    const r = await readUsage({
      sources: only('zcode', 'codex'),
      paths: { zcode, codex },
    });
    assert.equal(r.rows.length, 2);

    const groups = summarizeUsage({ rows: r.rows, groupBy: 'agent' });
    const g = groups.find((x) => x.key === 'zcode');
    assert.equal(g.cacheHit, 0.8, '只按 ZCode 那一条算：80 / (80 + 20)');
    assert.equal(g.cacheHitExcluded, 0);

    const codexGroup = groups.find((x) => x.key === 'codex');
    assert.equal(codexGroup.cacheHit, null, '口径未知时不给命中率，而不是给 0');
    assert.equal(codexGroup.cacheHitExcluded, 1);
    assert.deepEqual(codexGroup.semantics, ['unknown']);
  } finally {
    box.cleanup();
  }
});

test('usage: 没报成本不等于 0 元', async () => {
  const box = sandbox();
  try {
    const file = box.path('hermes.sqlite');
    sqlite(
      file,
      [
        `create table session_model_usage (
           session_id text, model text, billing_provider text, api_call_count integer,
           input_tokens integer, output_tokens integer, cache_read_tokens integer,
           cache_write_tokens integer, reasoning_tokens integer,
           estimated_cost_usd real, actual_cost_usd real, cost_status text,
           first_seen real, last_seen real)`,
      ],
      [
        [`insert into session_model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['s1', 'm1', 'openrouter', 3, 100, 10, 0, 0, 0, 0, 0, 'unknown', 1767225600, 1767225700]],
        [`insert into session_model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['s2', 'm2', 'openrouter', 0, 100, 10, 0, 0, 0, 1.5, 0, 'estimated', 1767225600, 1767225700]],
      ]
    );

    const r = await readUsage({ sources: only('hermes'), paths: { hermes: file } });
    const [noCost, withCost] = r.rows;
    assert.equal(noCost.cost, null, '0 元不是价格，是"没算"');
    assert.equal(noCost.costStatus, 'unknown');
    assert.equal(withCost.cost, 1.5);
    assert.equal(withCost.costStatus, 'estimated');

    const [g] = summarizeUsage({ rows: r.rows, groupBy: 'agent' });
    assert.equal(g.cost, 1.5, '成本只加真正报了钱的');
    assert.equal(g.costKnown, 1);
    assert.equal(g.costUnknown, 1, '有多少条没价必须一起报出来');
  } finally {
    box.cleanup();
  }
});

test('usage: Hermes 老库只有 sessions 表、缺列也能读', async () => {
  const box = sandbox();
  try {
    const file = box.path('hermes-old.sqlite');
    // 缺 billing_provider / api_call_count：SELECT 里补 null，不能因为缺列整条失败
    sqlite(
      file,
      [
        `create table sessions (
           session_id text, model text, input_tokens integer, output_tokens integer,
           cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer,
           estimated_cost_usd real, actual_cost_usd real, cost_status text,
           first_seen real, last_seen real)`,
      ],
      [[`insert into sessions values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['s1', 'm', 100, 10, 50, 0, 0, 0, 0, 'unknown', 1767225600, 1767225700]]]
    );

    const r = await readUsage({ sources: only('hermes'), paths: { hermes: file } });
    assert.equal(r.ready, true);
    assert.equal(r.rows[0].provider, null, '缺列就留空，不编一个值');
    assert.equal(r.rows[0].fresh, 100);
  } finally {
    box.cleanup();
  }
});

test('usage: 按扫描器默认位置也能发现（不靠显式路径）', async () => {
  const box = sandbox();
  try {
    sqlite(
      box.path('.zcode', 'cli', 'db', 'db.sqlite'),
      [
        `create table model_usage (
           session_id text, model_id text, provider_id text, status text, started_at integer,
           input_tokens integer, output_tokens integer, reasoning_tokens integer,
           cache_creation_input_tokens integer, cache_read_input_tokens integer,
           duration_ms integer, time_to_first_token_ms integer)`,
      ],
      [[`insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?)`, ['s1', 'm', 'p', 'ok', 1767225600000, 100, 5, 0, 0, 80, null, null]]]
    );

    await box.run(async () => {
      const r = await readUsage({ sources: only('zcode') });
      assert.equal(r.ready, true, '应该从 ~/.zcode 发现库');
      assert.equal(r.rows.length, 1);
    });
  } finally {
    box.cleanup();
  }
});
