import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dispatch } from '../src/mcp.js';
import { clearScanCache } from '../src/registry.js';
import { clearTranscriptCache } from '../src/transcript-cache.js';
import { sandbox } from './helpers.js';

/**
 * `read_session` 的 `find`：搜索结果拿到 snippet 后，直接从命中处附近
 * 打开会话，而不是让调用方从第 0 个字符开始数。这是 MAGPIE
 * `sessions_mcp.go` 的 `find` 语义（命中前 3 条消息开始）。
 */

function call(name, args) {
  return dispatch({ method: 'tools/call', params: { name, arguments: args } });
}

function writeDshSession(box, id, texts) {
  const dir = box.path('.dsh', 'sessions', 'E--p', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const lines = [JSON.stringify({ type: 'session', id, createdAt: '2026-01-01T00:00:00Z', cwd: 'E:/p' })];
  texts.forEach((text, i) => {
    lines.push(
      JSON.stringify({
        type: 'user/message',
        time: `2026-01-01T00:0${i + 1}:00Z`,
        data: { content: text },
      })
    );
  });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('mcp: read_session 的 find 从命中前 3 条消息开始读', async () => {
  const box = sandbox();
  try {
    writeDshSession(box, 'find-1', [
      '第零条：开场白',
      '第一条：先看缓存',
      '第二条：再看部署',
      '第三条：这里讨论数据库',
      '第四条：中间过程',
      '第五条：最终发现密钥在环境变量里',
      '第六条：收尾',
    ]);

    await box.run(async () => {
      clearScanCache();
      clearTranscriptCache();
      const r = await call('read_session', { id: 'find-1', agent: 'dsh', find: '密钥', maxChars: 40000 });

      assert.equal(r.isError, false);
      assert.equal(r.structuredContent.find.query, '密钥');
      assert.equal(r.structuredContent.find.matchedMessage, 5);
      assert.equal(r.structuredContent.find.startMessage, 2, '命中前保留 3 条，从第 2 条开始');
      assert.ok(r.structuredContent.text.includes('第三条：这里讨论数据库'), '命中前的上下文要在');
      assert.ok(!r.structuredContent.text.includes('第零条'), '更早的消息不该出现在窗口里');
      assert.ok(!r.structuredContent.text.includes('第一条'), '更早的消息不该出现在窗口里');
      assert.ok(r.structuredContent.text.includes('密钥在环境变量里'));
    });
  } finally {
    box.cleanup();
  }
});

test('mcp: read_session 的 find 找不到时说清楚，不冒充读到', async () => {
  const box = sandbox();
  try {
    writeDshSession(box, 'find-2', ['只有这一条普通消息']);
    await box.run(async () => {
      clearScanCache();
      clearTranscriptCache();
      const r = await call('read_session', { id: 'find-2', agent: 'dsh', find: '不存在的词' });
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent.code, 'find_not_found');
      assert.ok(r.structuredContent.error.includes('不存在的词'));
    });
  } finally {
    box.cleanup();
  }
});
