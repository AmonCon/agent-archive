import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMessagesHtml, sessionChunkRange, SESSION_CHUNK } from '../src/web/pages.js';

/** 一条有正文的最小消息，保证 renderMessageHtml 不会返回空串。 */
function msg(role, text) {
  return { role, ts: new Date(2026, 9, 30, 12, 0), parts: [{ kind: 'text', text }] };
}

test('renderMessagesHtml: id 从 startIndex 开始递增', () => {
  const messages = [msg('user', '一'), msg('assistant', '二'), msg('user', '三')];
  const html = renderMessagesHtml(messages, 7);
  const ids = [...html.matchAll(/id="m(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [7, 8, 9]);
});

test('renderMessagesHtml: 默认从 m0 开始，分块时保持整场会话的绝对序号', () => {
  assert.match(renderMessagesHtml([msg('user', 'hi')]), /id="m0"/);

  const messages = Array.from({ length: 5 }, (_, i) => msg('user', `第 ${i} 条`));
  const html = renderMessagesHtml(messages.slice(2, 4), 2);
  const ids = [...html.matchAll(/id="m(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [2, 3]);
});

test('sessionChunkRange: 第一页', () => {
  assert.deepEqual(sessionChunkRange(1914, 0, SESSION_CHUNK), {
    total: 1914,
    offset: 0,
    end: 200,
    hasMore: true,
    nextOffset: 200,
  });
});

test('sessionChunkRange: 正好整除时最后一页 hasMore=false', () => {
  assert.deepEqual(sessionChunkRange(400, 200, 200), {
    total: 400,
    offset: 200,
    end: 400,
    hasMore: false,
    nextOffset: null,
  });
  assert.equal(sessionChunkRange(400, 0, 200).hasMore, true);
});

test('sessionChunkRange: 最后一页不满时截到总数', () => {
  assert.deepEqual(sessionChunkRange(450, 400, 200), {
    total: 450,
    offset: 400,
    end: 450,
    hasMore: false,
    nextOffset: null,
  });
});

test('sessionChunkRange: offset 越界收敛到末尾，空会话返回空块', () => {
  assert.deepEqual(sessionChunkRange(300, 999, 200), {
    total: 300,
    offset: 300,
    end: 300,
    hasMore: false,
    nextOffset: null,
  });
  assert.deepEqual(sessionChunkRange(0, 0, 200), {
    total: 0,
    offset: 0,
    end: 0,
    hasMore: false,
    nextOffset: null,
  });
});
