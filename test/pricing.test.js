import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import {
  normalizeId,
  stripDateSuffix,
  buildCatalog,
  priceFor,
  estimateCost,
  loadCatalog,
  syncCatalog,
} from '../src/pricing.js';
import { summarizeUsage } from '../src/usage.js';

/**
 * 价目表的契约。
 *
 * 这一层只回答"按公开价大概多少钱"，所以每个用例都在钉同一件事：
 * **估算不能被当成账单，也不知道的价格不能被当成免费**。
 */

test('pricing: 模型名归一化只去掉包装，不去掉语义后缀', () => {
  assert.equal(normalizeId('anthropic/claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(normalizeId('~anthropic/claude-latest'), 'claude-latest');
  assert.equal(normalizeId('GLM-5.3-Flash'), 'glm-5.3-flash');
  // :free 是真免费，去掉它就会按付费价算——宁可查不到
  assert.equal(normalizeId('minimax-m2.5:free'), 'minimax-m2.5:free');
  assert.equal(stripDateSuffix('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(stripDateSuffix('claude-opus-5@default'), 'claude-opus-5@default');
});

/** buildCatalog 的输出是紧凑数组，这里还原成查询用的 Map。 */
function toMap(cat) {
  return new Map(
    cat.models.map(([k, input, output, cacheRead, cacheWrite, provider, id]) => [
      k,
      { input, output, cacheRead, cacheWrite, provider, id },
    ])
  );
}

test('pricing: 同一模型多家报价时，厂商目录优先于中转站', () => {
  const raw = {
    'relay-co': {
      models: { 'anthropic/claude-x': { cost: { input: 9, output: 90 } } },
    },
    anthropic: {
      models: { 'claude-x': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } },
    },
  };
  const cat = buildCatalog(raw, { fetchedAt: '2026-01-01T00:00:00Z' });
  const hit = priceFor('anthropic/claude-x', { models: toMap(cat) });
  assert.equal(hit.provider, 'anthropic', '中转站的加价不该成为估算基准');
  assert.equal(hit.input, 3);
});

test('pricing: 带日期后缀的模型能退回无日期的那条', () => {
  const cat = buildCatalog(
    { anthropic: { models: { 'claude-sonnet-4-5': { cost: { input: 3, output: 15 } } } } },
    { fetchedAt: '2026-01-01T00:00:00Z' }
  );
  const models = toMap(cat);
  const hit = priceFor('claude-sonnet-4-5-20250929', { models });
  assert.equal(hit.input, 3);
  assert.equal(priceFor('未收录的模型', { models }), null, '查不到就是 null，不猜');
});

test('pricing: 四段分别计价，单位是百万 token', () => {
  const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const r = estimateCost(
    { fresh: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 },
    price
  );
  assert.equal(Number(r.usd.toFixed(6)), 22.05);
  assert.equal(r.approximated, false);
});

test('pricing: 缺缓存价时退回输入价，并标记为近似', () => {
  const price = { input: 3, output: 15, cacheRead: null, cacheWrite: null };
  const r = estimateCost({ fresh: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, price);
  assert.equal(r.usd, 3, '缺价时按输入价算，不是 0');
  assert.equal(r.approximated, true, '必须能被上层标出来');

  // 没有缓存用量时，缺缓存价不影响结果，也不该标近似
  const clean = estimateCost({ fresh: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, price);
  assert.equal(clean.approximated, false);
});

test('pricing: 没有缓存文件时返回原因，不抛错', () => {
  const box = sandbox();
  try {
    const r = loadCatalog({ file: box.path('nope.json') });
    assert.equal(r.ready, false);
    assert.match(r.reason, /没有同步过|ENOENT/);
  } finally {
    box.cleanup();
  }
});

test('pricing: 自报成本与估算成本分开累计', () => {
  const catalog = {
    models: new Map([['m1', { input: 100, output: 0, cacheRead: null, cacheWrite: null, provider: 'p' }]]),
  };
  const rows = [
    // 有自报：不能被估算覆盖
    { agent: 'a', model: 'm1', at: 1000, session: 's1', calls: 1, fresh: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, semantic: 'fresh', cost: 0.5, costStatus: 'actual' },
    // 没自报、有价：计入估算
    { agent: 'a', model: 'm1', at: 1001, session: 's1', calls: 1, fresh: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, semantic: 'fresh', cost: null, costStatus: null },
    // 没自报、没价：未定价，不能算成 0
    { agent: 'a', model: 'nope', at: 1002, session: 's1', calls: 1, fresh: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, semantic: 'fresh', cost: null, costStatus: null },
  ];
  const [g] = summarizeUsage({ rows, groupBy: 'agent', catalog });
  assert.equal(g.cost, 0.5, '自报成本原样保留');
  assert.equal(g.costKnown, 1);
  assert.equal(Number(g.costEst.toFixed(6)), 100, '只有 m1 那条能估：1e6 × 100 / 1e6');
  assert.equal(g.costEstRecords, 1);
  assert.equal(g.unpricedRecords, 1, '查不到价的要单独计数');
});

/**
 * 取数的三段式上限。
 *
 * 这是全仓唯一的外部 HTTP 取数点。不设限的后果不是"慢"，是上游返回一个
 * 畸形大包时把进程内存打满。三段式分别是：content-length 预检、流式累计、
 * 拿到完整内容后再查一次（Node 的 fetch 会自动解压，所以要按解压后的字节算）。
 */

function headers(obj) {
  return { get: (k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null) };
}

/** 造一个可控的假 Response。只统计 reader 被取用了几次，不预读。 */
function fakeResponse({ chunks = [], contentLength = null, contentEncoding = null, ok = true, status = 200 } = {}) {
  let readerCalls = 0;
  let index = 0;
  const body = {
    getReader() {
      readerCalls++;
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = Buffer.from(chunks[index++]);
          return { done: false, value };
        },
        async cancel() {},
      };
    },
  };
  return {
    ok,
    status,
    headers: headers({
      ...(contentLength != null ? { 'content-length': String(contentLength) } : {}),
      ...(contentEncoding ? { 'content-encoding': contentEncoding } : {}),
    }),
    body,
    get readerCalls() {
      return readerCalls;
    },
    get pulled() {
      return index;
    },
    async arrayBuffer() {
      return Buffer.concat(chunks.map((c) => Buffer.from(c))).buffer;
    },
  };
}

test('pricing: content-length 超限时直接失败，一个字节都不读', async () => {
  const box = sandbox();
  try {
    const res = fakeResponse({ chunks: ['{}'], contentLength: 40 * 1024 * 1024 });
    let called = 0;
    const fetchImpl = async () => {
      called++;
      return res;
    };
    await assert.rejects(
      () => syncCatalog({ fetchImpl }),
      /content-length .*超过上限/
    );
    assert.equal(res.readerCalls, 0, '预检命中就不该开始读 body');
    assert.equal(called, 1);
  } finally {
    box.cleanup();
  }
});

test('pricing: 流式读到一半超限就中止，并报出已读字节', async () => {
  const box = sandbox();
  try {
    // 每块 8 MiB，共 8 块 = 64 MiB，远超 32 MiB 上限
    const chunks = Array.from({ length: 8 }, () => Buffer.alloc(8 * 1024 * 1024, 0x20));
    const res = fakeResponse({ chunks });
    await assert.rejects(
      () => syncCatalog({ fetchImpl: async () => res }),
      /响应过大：已读 .* 字节/
    );
    assert.ok(res.pulled < chunks.length, '超限后不应把整个流读完');
  } finally {
    box.cleanup();
  }
});

test('pricing: 不认识的 content-encoding 明确报错，不当成 JSON 乱解析', async () => {
  const box = sandbox();
  try {
    const res = fakeResponse({ chunks: ['{}'], contentEncoding: 'br, magic' });
    await assert.rejects(
      () => syncCatalog({ fetchImpl: async () => res }),
      /响应编码不认识/
    );
  } finally {
    box.cleanup();
  }
});

test('pricing: 正常响应仍然能同步出目录（回归）', async () => {
  const box = sandbox();
  try {
    const payload = JSON.stringify({
      anthropic: { models: { 'claude-x': { cost: { input: 3, output: 15 } } } },
    });
    const res = fakeResponse({ chunks: [payload] });
    const out = await box.run(() => syncCatalog({ fetchImpl: async () => res }));
    assert.equal(out.count, 1);
    const loaded = await box.run(() => loadCatalog());
    assert.equal(loaded.ready, true);
    assert.equal(loaded.models.get('claude-x').input, 3);
  } finally {
    box.cleanup();
  }
});

test('pricing: 超时给出能看懂的原因', async () => {
  const box = sandbox();
  try {
    const never = new Promise(() => {});
    await assert.rejects(
      () => syncCatalog({ fetchImpl: () => never, timeoutMs: 30 }),
      /超时|timeout/
    );
  } finally {
    box.cleanup();
  }
});
