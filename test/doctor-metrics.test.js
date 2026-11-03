import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import { clearScanCache } from '../src/registry.js';
import { auditCollection } from '../src/doctor.js';

/**
 * doctor 比率口径的契约：每个比率都和它的分母、Wilson 下界、朴素基线待在一起。
 *
 * 为什么值得锁：单独一个百分比读不出信号。"归属率 99.8%" 在 n=3 和 n=1543
 * 时是两回事；而"归属率比朴素基线低"才说明链上溯逻辑真的在丢东西。
 *
 * 这里锁四件事：
 *   1. metrics 表存在，每个比率旁都有 n、ok、Wilson 下界，且下界 <= 比率
 *   2. 有子代理时，attach 行必须带朴素基线
 *   3. 朴素基线的数学不变量：baseline.rate >= attachRate（朴素是最宽松判据）
 *   4. snapshot 透传：doctor 报告自带"这批数据是哪一版工具扫的"
 */

/** 造一场 DSH 会话；parent 非空即是子代理（header 带 parentSession）。 */
function writeSession(box, { id, text, parent = null, cwd = 'E:/p' } = {}) {
  const file = box.path('.dsh', 'sessions', 'E--p', id, 'session.jsonl');
  fs.mkdirSync(box.path('.dsh', 'sessions', 'E--p', id), { recursive: true });
  const header = { type: 'session', id, createdAt: '2026-01-01T00:00:00Z', cwd };
  if (parent) header.parentSession = parent;
  fs.writeFileSync(
    file,
    JSON.stringify(header) +
      '\n' +
      JSON.stringify({ type: 'user/message', time: '2026-01-01T00:01:00Z', data: { content: text } }) +
      '\n'
  );
  return { file };
}

test('doctor: metrics 表每个比率都带分母、下界，且下界不超过比率', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 'm1', text: '主会话聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      const r = await auditCollection({ samplePerAgent: 1 });

      assert.ok(Array.isArray(r.metrics) && r.metrics.length >= 4, '至少四行口径');
      for (const m of r.metrics) {
        assert.ok(m.name, '每行要有名字');
        assert.equal(typeof m.rate, 'number');
        assert.equal(typeof m.n, 'number');
        assert.ok(m.n >= 0);
        assert.ok(m.ok <= m.n, '分子不能超过分母');
        assert.ok(
          m.wilsonLower <= m.rate + 1e-9,
          `${m.name} 的 Wilson 下界 (${m.wilsonLower}) 不能超过比率 (${m.rate})`
        );
      }
      // 有数据时 n 不能是 0——0 个样本的比率没有资格出现在报告里
      const time = r.metrics.find((m) => m.key === 'time');
      assert.ok(time.n > 0, '有会话时时间覆盖率的分母必须是会话数');
      assert.equal(time.n, r.total, '时间覆盖率的分母就是总会话数');
    });
  } finally {
    box.cleanup();
  }
});

test('doctor: 子代理归属率带朴素基线，且基线 >= 实际归属率', async () => {
  const box = sandbox();
  try {
    // 一场 main + 一场子代理（parent 指向 main，链能走到根）
    writeSession(box, { id: 'm1', text: '主会话' });
    writeSession(box, { id: 'sub1', text: '子代理查的细节', parent: 'm1' });
    await box.run(async () => {
      clearScanCache();
      const r = await auditCollection({ samplePerAgent: 1 });

      const attach = r.metrics.find((m) => m.key === 'attach');
      assert.ok(attach, '有子代理时必须有 attach 行');
      assert.equal(attach.n, 1, '分母 = attached + orphan = 1');
      assert.equal(attach.rate, 1, '链能走到 main，归属率是 1');
      assert.ok(attach.baseline, '必须带朴素基线');
      assert.equal(attach.baseline.n, 1);
      assert.ok(
        attach.baseline.rate >= attach.rate - 1e-9,
        '朴素基线是最宽松判据，不可能低于真实归属率'
      );
      assert.equal(r.subagent.baseline.why.length > 10, true, '基线要写明它是什么策略');
    });
  } finally {
    box.cleanup();
  }
});

test('doctor: snapshot 透传——报告自带"这批数据是哪一版工具扫的"', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 'm1', text: '主会话' });
    await box.run(async () => {
      clearScanCache();
      const r = await auditCollection({ samplePerAgent: 1 });
      assert.ok(r.snapshot, 'snapshot 必须透传到 doctor 报告');
      assert.match(r.snapshot.manifestHash, /^[0-9a-f]{16}$/);
      assert.ok(r.snapshot.toolVersion, '工具版本要在快照里');
    });
  } finally {
    box.cleanup();
  }
});

test('doctor: 同一批数据两次体检，metrics 完全一致（确定性）', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 'm1', text: '主会话' });
    writeSession(box, { id: 'sub1', text: '子代理', parent: 'm1' });
    await box.run(async () => {
      clearScanCache();
      const a = await auditCollection({ samplePerAgent: 2 });
      const b = await auditCollection({ samplePerAgent: 2 });
      const strip = (m) => m.metrics.map((x) => ({ ...x, note: undefined }));
      assert.deepEqual(strip(a), strip(b), '同一批输入，口径必须完全一致');
    });
  } finally {
    box.cleanup();
  }
});