import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import { scanAll, clearScanCache } from '../src/registry.js';

/**
 * 扫描快照（stats.snapshot / manifest）的契约。
 *
 * 为什么值得锁：README 卖的是"确定性的、可复现的"，但一份三个月前的
 * doctor 报告没法复现——不知道当时扫的是哪些文件、哪一版工具、哪一版 Node。
 * 快照挂在 stats 上流经 doctor / CLI / MCP 三个出口，不另写文件、不加 IO。
 *
 * 这里锁四件事：
 *   1. 快照字段齐全（时间 / 工具版本 / Node 版本 / 平台 / 每家输入清单）
 *   2. 同一批输入，扫两次 manifestHash 相同——包括一次走缓存、一次全量重扫
 *   3. 文件内容变了，manifestHash 必变
 *   4. byAgent 里的 files/sessions/cacheHits 能对上扫描结果
 */

/** 造一场 DSH 会话（同 search.test.js 的 fixture 形状）。 */
function writeSession(box, { id = 's1', text = '一段对话', cwd = 'E:/p' } = {}) {
  const file = box.path('.dsh', 'sessions', 'E--p', id, 'session.jsonl');
  fs.mkdirSync(box.path('.dsh', 'sessions', 'E--p', id), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session', id, createdAt: '2026-01-01T00:00:00Z', cwd }) +
      '\n' +
      JSON.stringify({ type: 'user/message', time: '2026-01-01T00:01:00Z', data: { content: text } }) +
      '\n'
  );
  return { file };
}

test('manifest: 快照字段齐全，byAgent 记录每家的输入清单', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      const { sessions, stats } = scanAll({});

      const snap = stats.snapshot;
      assert.ok(snap, 'stats.snapshot 必须存在');
      assert.match(snap.scannedAt, /^\d{4}-\d{2}-\d{2}T/, 'scannedAt 是 ISO 时间');
      assert.ok(snap.toolVersion && snap.toolVersion !== 'unknown', 'toolVersion 要读到 package.json');
      assert.match(snap.nodeVersion, /^v\d+\./, 'nodeVersion 是 process.version');
      assert.ok(snap.platform, 'platform 形如 win32-x64');
      assert.match(snap.manifestHash, /^[0-9a-f]{16}$/, 'manifestHash 是 16 位十六进制');

      const dsh = snap.byAgent.dsh;
      assert.ok(dsh, 'dsh 家要在 byAgent 里');
      assert.equal(dsh.files, 1, '一个输入文件');
      assert.equal(dsh.sessions, sessions.filter((s) => s.agent === 'dsh').length, '会话数对得上');
    });
  } finally {
    box.cleanup();
  }
});

test('manifest: 同一批输入扫两次哈希相同——缓存命中与全量重扫结果一致', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      const first = scanAll({}).stats.snapshot;
      assert.ok(first.byAgent.dsh.cacheHits === 0, '第一次应该是全量解析');

      // 第二次：文件没变，全部走缓存
      const second = scanAll({}).stats.snapshot;
      assert.ok(second.byAgent.dsh.cacheHits >= 1, '第二次应该命中缓存');
      assert.equal(
        first.manifestHash,
        second.manifestHash,
        '输入相同，缓存命中与否不影响 manifestHash——它描述输入，不描述过程'
      );

      // 第三次：绕过缓存全量重扫，哈希仍要相同
      const third = scanAll({ noCache: true }).stats.snapshot;
      assert.equal(
        first.manifestHash,
        third.manifestHash,
        'noCache 重扫的是同一批输入，哈希不该变'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('manifest: 文件变了哈希必变', async () => {
  const box = sandbox();
  try {
    const { file } = writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      const before = scanAll({}).stats.snapshot.manifestHash;

      // 会话文件是追加式：往里加一轮对话，size 变
      fs.appendFileSync(
        file,
        JSON.stringify({ type: 'assistant/message', time: '2026-01-01T00:02:00Z', data: { content: '追加了一轮' } }) + '\n'
      );
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);

      const after = scanAll({}).stats.snapshot.manifestHash;
      assert.notEqual(before, after, '输入变了 manifestHash 必须变，否则"可复现"是假的');
    });
  } finally {
    box.cleanup();
  }
});