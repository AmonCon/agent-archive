import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import {
  getOrLoad,
  stampOf,
  clearTranscriptCache,
  cacheStats,
} from '../src/transcript-cache.js';

/**
 * 正文缓存的契约。
 *
 * 这一层的风险不是"慢"，而是**返回过期内容**：缓存命中判据一旦写松，
 * 用户刷新页面看到的是旧对话，而且没有任何报错。所以测试重点在失效，
 * 不在命中率。
 */

test('cache: 同一文件未变时命中，返回同一个数组（不深拷贝）', async () => {
  const box = sandbox();
  try {
    clearTranscriptCache();
    const f = box.write('.x/a.jsonl', 'hello\n');
    const session = { agent: 'x', id: '1', source: f };
    let calls = 0;
    const loader = () => {
      calls++;
      return [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }], ts: null, meta: null }];
    };

    const a = await getOrLoad('x|1', session, loader);
    const b = await getOrLoad('x|1', session, loader);
    assert.equal(calls, 1, '第二次不该重新加载');
    assert.equal(a, b, '返回同一个引用——深拷贝会抵消缓存的意义');
  } finally {
    clearTranscriptCache();
    box.cleanup();
  }
});

test('cache: 文件一变就失效（size 变）', async () => {
  const box = sandbox();
  try {
    clearTranscriptCache();
    const f = box.write('.x/a.jsonl', 'a\n');
    const session = { agent: 'x', id: '1', source: f };
    let calls = 0;
    const loader = () => {
      calls++;
      return [];
    };

    await getOrLoad('x|1', session, loader);
    fs.writeFileSync(f, 'a much longer content\n');
    await getOrLoad('x|1', session, loader);
    assert.equal(calls, 2, 'size 变了必须重读');
  } finally {
    clearTranscriptCache();
    box.cleanup();
  }
});

test('cache: 等长但内容被改写、mtime 也变了，同样失效', async () => {
  const box = sandbox();
  try {
    clearTranscriptCache();
    const f = box.write('.x/a.jsonl', 'aaaa\n');
    const session = { agent: 'x', id: '1', source: f };
    let calls = 0;
    const loader = () => {
      calls++;
      return [];
    };

    await getOrLoad('x|1', session, loader);
    // 等长改写 + 推进 mtime（真实场景：Agent 原地重写一行）
    fs.writeFileSync(f, 'bbbb\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    await getOrLoad('x|1', session, loader);
    assert.equal(calls, 2, '等长改写也必须重读');
  } finally {
    clearTranscriptCache();
    box.cleanup();
  }
});

test('cache: 多段 source（Codex 续接）取所有段的指纹', async () => {
  const box = sandbox();
  try {
    clearTranscriptCache();
    const a = box.write('.x/a.jsonl', 'a\n');
    const b = box.write('.x/b.jsonl', 'b\n');
    const session = { agent: 'codex', id: '1', source: `${a}|${b}` };

    let calls = 0;
    const loader = () => {
      calls++;
      return [];
    };
    await getOrLoad('codex|1', session, loader);
    // 只改第二段
    fs.writeFileSync(b, 'b plus more\n');
    await getOrLoad('codex|1', session, loader);
    assert.equal(calls, 2, '任一段变了都要重读');
  } finally {
    clearTranscriptCache();
    box.cleanup();
  }
});

test('cache: 路径读不到时不算指纹、不缓存（宁可重读）', async () => {
  const box = sandbox();
  try {
    clearTranscriptCache();
    const session = { agent: 'x', id: 'ghost', source: box.path('.x', 'missing.jsonl') };
    assert.equal(stampOf(session.source), null, '读不到就返回 null');

    let calls = 0;
    const loader = () => {
      calls++;
      return [];
    };
    await getOrLoad('x|ghost', session, loader);
    await getOrLoad('x|ghost', session, loader);
    assert.equal(calls, 2, '没有指纹就不缓存，每次都真的读');
  } finally {
    clearTranscriptCache();
    box.cleanup();
  }
});

test('cache: 超出条数上限时淘汰最久未用的', async () => {
  const box = sandbox();
  try {
    clearTranscriptCache();
    const sessions = [];
    for (let i = 0; i < 10; i++) {
      const f = box.write(`.x/${i}.jsonl`, `content ${i}\n`);
      sessions.push({ agent: 'x', id: String(i), source: f });
    }
    const loaders = sessions.map(() => {
      let n = 0;
      return () => {
        n++;
        return [{ role: 'user', parts: [{ kind: 'text', text: 'x' }], ts: null, meta: null }];
      };
    });

    for (let i = 0; i < 10; i++) {
      await getOrLoad(`x|${i}`, sessions[i], loaders[i]);
    }
    const st = cacheStats();
    assert.ok(st.entries <= 8, `最多 8 条，实际 ${st.entries}`);

    // 第 0 条已被淘汰：再取一次会重新加载
    let reloaded = 0;
    await getOrLoad('x|0', sessions[0], () => {
      reloaded++;
      return [];
    });
    assert.equal(reloaded, 1, '最久未用的应被淘汰');
  } finally {
    clearTranscriptCache();
    box.cleanup();
  }
});
