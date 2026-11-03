import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import { clearScanCache } from '../src/registry.js';
import { dispatch, TOOLS } from '../src/mcp.js';

/**
 * session_stats 的快照出口契约。
 *
 * MCP 是别的 Agent 读档案馆的入口——doctor 在 CLI 里能看到的"可复现凭据"
 * （哪一版工具、哪个 Node、manifestHash），Agent 走 session_stats 也要拿得到。
 * 字段直接透传 scanAll 的 stats.snapshot，这里锁的是"透传没有断"。
 */

/** 造一场 DSH 会话（同 search.test.js 的 fixture）。 */
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
}

test('mcp: session_stats 带 snapshot，manifestHash 与工具版本齐全', async () => {
  const box = sandbox();
  try {
    writeSession(box, { id: 's1', text: '聊的是缓存策略' });
    await box.run(async () => {
      clearScanCache();
      const res = await dispatch({ method: 'tools/call', params: { name: 'session_stats', arguments: {} } });

      assert.equal(res.isError, undefined || false, '调用不该报错');
      const data = res.structuredContent;
      assert.ok(data, 'session_stats 必须返回 structuredContent');
      assert.ok(data.snapshot, 'snapshot 必须透传——Agent 靠它判断数据是哪一版扫的');
      assert.match(data.snapshot.manifestHash, /^[0-9a-f]{16}$/);
      assert.ok(data.snapshot.toolVersion, '工具版本要在');
      assert.match(data.snapshot.nodeVersion, /^v\d+\./);
      assert.ok(data.snapshot.byAgent.dsh, '每家的输入清单要在');
      assert.equal(data.snapshot.byAgent.dsh.files, 1);
    });
  } finally {
    box.cleanup();
  }
});

test('mcp: session_stats 在工具清单里，注解仍是只读', async () => {
  const res = await dispatch({ method: 'tools/list', params: {} });
  const t = res.tools.find((x) => x.name === 'session_stats');
  assert.ok(t, 'session_stats 要在工具清单里');
  assert.equal(t.annotations.readOnlyHint, true);
  assert.match(t.description, /snapshot/, '描述里要告诉调用方有快照可用');
  assert.ok(TOOLS.find((x) => x.name === 'session_stats'));
});