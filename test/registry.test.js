import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, codexMeta } from './helpers.js';

/**
 * 注册表（registry.js）的行为契约。
 *
 * 这里锁的是"扫描出错时档案不能凭空少一场对话"这一类保证。它们最容易在
 * 重构里被无意破坏，而破坏后的症状是静默的：会话数少了几场，没有任何报错。
 */

const registry = await import('../src/registry.js');

/** 造一个只有一场会话的 DSH 存储。 */
function writeDshSession(box, { id = 's1', content = '第一版' } = {}) {
  const dir = box.path('.dsh', 'sessions', 'E--p', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const good =
    JSON.stringify({ type: 'session', id, createdAt: '2026-01-01T00:00:00Z', cwd: 'E:/p' }) +
    '\n' +
    JSON.stringify({ type: 'user/message', time: '2026-01-01T00:01:00Z', data: { content } }) +
    '\n';
  fs.writeFileSync(file, good);
  return { file, good };
}

test('registry: 解析失败时保留上一次的好结果，并沿用旧指纹以便重试', async () => {
  const box = sandbox();
  try {
    const { file, good } = writeDshSession(box);
    const find = (r) => r.sessions.find((s) => s.agent === 'dsh' && s.id === 's1');

    await box.run(() => {
      const first = registry.scanAll({ noCache: true });
      assert.ok(find(first), '基线：应该有这场会话');

      // 写坏并推进 mtime，保证指纹变了
      fs.writeFileSync(file, 'not json at all');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);

      const second = registry.scanAll({});
      const kept = find(second);
      assert.ok(kept, '会话不能因为解析失败而消失');
      assert.equal(kept.title, '第一版', '保留的是上一次读到的内容');
      assert.equal(second.stats.emptied, 1, '要如实记账：有一个文件这次解析为空');
      assert.equal(second.stats.keptStale, 1, '要如实记账：保留了 1 场');

      // 再跑一次：仍然保留（不能把失败钉死成"已命中"，那样永远不会重试）
      assert.ok(find(registry.scanAll({})), '仍应保留');

      // 修好之后自动恢复
      fs.writeFileSync(file, good);
      const fixedAt = new Date(Date.now() + 10000);
      fs.utimesSync(file, fixedAt, fixedAt);
      const fourth = registry.scanAll({});
      assert.equal(fourth.stats.emptied || 0, 0, '恢复后不该再记为空');
      assert.ok(find(fourth));
    });
  } finally {
    box.cleanup();
  }
});

test('registry: 等长改写并回填 mtime 时，靠 ctime 判定失效', async () => {
  const box = sandbox();
  try {
    const { file } = writeDshSession(box, { content: 'AAAA' });
    const find = (r) => r.sessions.find((s) => s.agent === 'dsh' && s.id === 's1');
    const titleOf = (r) => (find(r) ? find(r).title : null);

    await box.run(() => {
      const first = registry.scanAll({ noCache: true });
      assert.equal(titleOf(first), 'AAAA', '基线');

      const before = fs.statSync(file);
      // 等长改写，然后把 mtime 改回去——这是 (mtime, size) 判据的盲区
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('AAAA', 'BBBB'));
      fs.utimesSync(file, before.atime, before.mtime);
      const after = fs.statSync(file);

      assert.equal(after.size, before.size, '长度必须相同');
      assert.notEqual(after.ctimeMs, before.ctimeMs, 'ctime 应该变了');

      const second = registry.scanAll({});
      assert.equal(titleOf(second), 'BBBB', '内容变了就必须重解析');
    });
  } finally {
    box.cleanup();
  }
});

test('registry: 缓存是原子写的，不留下临时文件', async () => {
  const box = sandbox();
  try {
    writeDshSession(box);
    await box.run(() => {
      registry.scanAll({ noCache: true });
      const cacheDir = path.join(box.state, 'cache');
      const files = fs.readdirSync(cacheDir);
      assert.ok(files.some((f) => f.endsWith('.json')), '应该写出了缓存');
      assert.deepEqual(
        files.filter((f) => f.includes('.tmp-')),
        [],
        '不能留下临时文件'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('registry: 缓存损坏不会崩，只是重扫', async () => {
  const box = sandbox();
  try {
    writeDshSession(box);
    await box.run(() => {
      registry.scanAll({ noCache: true });
      const cacheDir = path.join(box.state, 'cache');
      const f = path.join(cacheDir, fs.readdirSync(cacheDir).find((x) => x.endsWith('.json')));
      fs.writeFileSync(f, '{"broken":', 'utf8');

      // 不抛异常；也不能因为读不到缓存就少给结果
      const r = registry.scanAll({});
      assert.equal(r.sessions.filter((s) => s.agent === 'dsh').length, 1);
    });
  } finally {
    box.cleanup();
  }
});

test('registry: 空结果不算解析失败（Copilot 的空会话不发假警报）', async () => {
  const box = sandbox();
  try {
    // 只有 session_meta、没有任何对话的 Codex 文件：合法地"没有会话"
    box.write(
      '.codex/sessions/2026/01/01/rollout-x-11111111-2222-3333-4444-555555555555.jsonl',
      codexMeta({ id: '11111111-2222-3333-4444-555555555555', cwd: 'E:/p' })
    );

    await box.run(() => {
      const r = registry.scanAll({ noCache: true });
      assert.equal(r.stats.failures, 0, '没有对话的文件不是"解析失败"');
      assert.equal(r.sessions.filter((s) => s.agent === 'codex').length, 0);
    });
  } finally {
    box.cleanup();
  }
});

test('registry: 解析代码指纹变了就全量重扫，没变才命中缓存', async () => {
  const box = sandbox();
  try {
    writeDshSession(box);
    const find = (r) => r.sessions.find((s) => s.agent === 'dsh' && s.id === 's1');

    await box.run(() => {
      // 先造一份"旧版本扫描器"留下的缓存，源文件指纹本身是好的
      registry.scanAll({ noCache: true });
      const file = registry.cacheLocation();
      const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache.__fingerprint = 'deadbeef0000';
      fs.writeFileSync(file, JSON.stringify(cache), 'utf8');

      // 指纹不一致：即使每个文件的 (mtime, ctime, size) 都没变，也必须重解析
      const r1 = registry.scanAll({});
      assert.ok(r1.stats.parsed > 0, '解析代码变了就不再信任旧结果');
      const s1 = find(r1);
      assert.ok(s1, '重扫后仍应有这场会话');
      assert.equal(s1.title, '第一版');
      assert.equal(registry.loadCache().__fingerprint, registry.scannerFingerprint(), '保存时要写入当前指纹');

      // 指纹一致：回到缓存命中
      const r2 = registry.scanAll({});
      assert.ok(r2.stats.cached > 0, '指纹一致时应命中缓存');
      assert.equal(r2.stats.parsed, 0, '命中缓存就不该再解析');
      assert.equal((find(r2) || {}).title, '第一版');
    });
  } finally {
    box.cleanup();
  }
});

test('registry: only 选项只扫指定 Agent，且不覆盖其他 Agent 的缓存', async () => {
  const box = sandbox();
  try {
    writeDshSession(box);
    box.write(
      '.codex/sessions/2026/01/01/rollout-x-11111111-2222-3333-4444-555555555555.jsonl',
      codexMeta({ id: '11111111-2222-3333-4444-555555555555', cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        JSON.stringify({
          timestamp: '2026-01-01T00:01:00Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
        }) +
        '\n'
    );

    await box.run(() => {
      const full = registry.scanAll({ noCache: true });
      assert.equal(full.sessions.filter((s) => s.agent === 'codex').length, 1);

      // 只扫 dsh：结果里不该有 codex，但缓存里 codex 那条必须还在
      const partial = registry.scanAll({ only: ['dsh'] });
      assert.equal(partial.sessions.filter((s) => s.agent === 'codex').length, 0);
      assert.ok(partial.sessions.find((s) => s.agent === 'dsh'));

      const cache = registry.loadCache();
      const codexKeys = Object.keys(cache).filter((k) => k.includes('.jsonl'));
      assert.ok(codexKeys.length >= 1, '部分扫描不能把其他 Agent 的缓存条目抹掉');
    });
  } finally {
    box.cleanup();
  }
});
