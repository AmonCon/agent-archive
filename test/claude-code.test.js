import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { mainOnly } from '../src/model.js';
import { scanAll } from '../src/registry.js';
import { auditCollection } from '../src/doctor.js';

/**
 * Claude Code 的复制 / 分叉会话识别。
 *
 * `--fork-session` 与 `/branch` 会把整段历史复制进新的 .jsonl，于是同一段
 * 对话在磁盘上有多个文件。识别规则：
 *   - 首条消息 uuid 相同 → 同一条历史（另加 compaction summary uuid 兜底）
 *   - 组内 start 最早的是原会话；start 相同按文件路径字典序
 *   - leafUuid 也相同 → 完全复制（copyOf）；不同 → 分叉（branchOf）
 *
 * 复制品不进入默认视图（mainOnly），分叉保留。
 * 全部跑在假家目录里，不依赖、也不触碰本机真实数据。
 */

const PROJECT = 'E:/demo';
const PROJECT_DIR = '.claude/projects/E--demo';

/** 一行真实形状的消息：uuid / sessionId / cwd / timestamp / message 齐备。 */
function msg({ sessionId, uuid, ts, role = 'user', text }) {
  return (
    JSON.stringify({
      type: role,
      uuid,
      sessionId,
      cwd: PROJECT,
      timestamp: ts,
      message: { role, content: text },
    }) + '\n'
  );
}

/** 三个会话共享的历史：u1（首条）→ u2 → u3（原件的末条）。 */
function sharedHistory(sessionId) {
  return (
    msg({ sessionId, uuid: 'u1', ts: '2026-01-01T10:00:00Z', text: 'hello' }) +
    msg({ sessionId, uuid: 'u2', ts: '2026-01-01T10:01:00Z', role: 'assistant', text: 'hi' }) +
    msg({ sessionId, uuid: 'u3', ts: '2026-01-01T10:02:00Z', role: 'assistant', text: 'done' })
  );
}

test('claude-code: 复制品记 copyOf，分叉记 branchOf，默认视图只去重复制品', async () => {
  const box = sandbox();
  try {
    // 文件名决定 start 相同时谁是原件：a < b < c
    box.write(`${PROJECT_DIR}/a-original.jsonl`, sharedHistory('session-original'));
    box.write(`${PROJECT_DIR}/b-copy.jsonl`, sharedHistory('session-copy'));
    box.write(
      `${PROJECT_DIR}/c-branch.jsonl`,
      sharedHistory('session-branch') +
        msg({ sessionId: 'session-branch', uuid: 'u4', ts: '2026-01-02T10:00:00Z', text: '另一条路' }) +
        msg({
          sessionId: 'session-branch',
          uuid: 'u5',
          ts: '2026-01-02T10:01:00Z',
          role: 'assistant',
          text: '分叉后的新回复',
        })
    );

    await box.run(async () => {
      const r = scanAll({ noCache: true, only: ['claude-code'] });
      const byId = new Map(r.sessions.map((s) => [s.id, s]));
      assert.equal(byId.size, 3, '三个文件都该被采集');

      const orig = byId.get('session-original');
      const copy = byId.get('session-copy');
      const branch = byId.get('session-branch');
      assert.ok(orig && copy && branch);

      assert.equal(orig.copyOf, null, '原件不该被标记');
      assert.equal(orig.branchOf, null, '原件不该被标记');
      assert.equal(copy.copyOf, 'session-original', '完全复制品要指向原件');
      assert.equal(copy.branchOf, null);
      assert.equal(branch.branchOf, 'session-original', '分叉要指向原件');
      assert.equal(branch.copyOf, null, '分叉不是复制品');
      assert.equal(copy.tmp, undefined, 'tmp 只是扫描器内部字段，不能留在模型里');
      assert.equal(branch.tmp, undefined);

      const visible = mainOnly(r.sessions).map((s) => s.id);
      assert.ok(!visible.includes('session-copy'), '复制品不冒充独立对话');
      assert.ok(visible.includes('session-original'));
      assert.ok(visible.includes('session-branch'), '分叉有自己的新内容，要留在时间线上');

      // 缓存命中时也要能重新聚组：tmp 跟着缓存走，postProcess 每次重算
      const cached = scanAll({ only: ['claude-code'] });
      const cachedById = new Map(cached.sessions.map((s) => [s.id, s]));
      assert.equal(cachedById.get('session-copy').copyOf, 'session-original');
      assert.equal(cachedById.get('session-branch').branchOf, 'session-original');

      // 体检计数：复制 1 场、分叉 1 场（没有也一样报，不省略这一项）
      const audit = await auditCollection({ noCache: true });
      assert.equal(audit.copies.copy, 1);
      assert.equal(audit.copies.branch, 1);
      assert.equal(audit.copies.total, 2);
    });
  } finally {
    box.cleanup();
  }
});
