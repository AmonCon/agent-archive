import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTurns } from '../src/turns.js';

const at = (h, m) => new Date(2026, 9, 30, h, m);

const text = (t) => ({ kind: 'text', text: t });
const tool = (status) => ({ kind: 'tool', name: 'bash', input: {}, status });

test('turns: 两轮对话，分别统计步数、错误与最终回复', () => {
  const messages = [
    { role: 'system', parts: [text('你是助手，请遵守约定')], ts: at(9, 0) },
    { role: 'user', parts: [text('先看一下项目结构')], ts: at(9, 1) },
    { role: 'assistant', parts: [text('好的，目录如下…')], ts: at(9, 2) },
    { role: 'user', parts: [text('第二轮：帮我跑一下测试\n并给出结论')], ts: at(10, 0) },
    { role: 'tool', parts: [tool('error')], ts: at(10, 1) },
    { role: 'tool', parts: [tool('completed')], ts: at(10, 2) },
    { role: 'assistant', parts: [text('测试全绿。')], ts: at(10, 3) },
  ];

  const turns = buildTurns(messages);
  assert.equal(turns.length, 2);

  assert.equal(turns[0].index, 1);
  assert.equal(turns[0].start.getTime(), at(9, 1).getTime());
  assert.equal(turns[0].end.getTime(), at(9, 2).getTime());
  assert.equal(turns[0].question, '先看一下项目结构');
  assert.equal(turns[0].steps, 0);
  assert.equal(turns[0].errors, 0);
  assert.equal(turns[0].hasFinalReply, true);

  assert.equal(turns[1].index, 3);
  assert.equal(turns[1].start.getTime(), at(10, 0).getTime());
  assert.equal(turns[1].end.getTime(), at(10, 3).getTime());
  // 多行提问压成一行
  assert.equal(turns[1].question, '第二轮：帮我跑一下测试 并给出结论');
  assert.equal(turns[1].steps, 2);
  assert.equal(turns[1].errors, 1);
  assert.equal(turns[1].hasFinalReply, true);
});

test('turns: 第一条 user 之前的 system 前言不进目录', () => {
  const turns = buildTurns([
    { role: 'system', parts: [text('前言一')], ts: at(9, 0) },
    { role: 'system', parts: [text('前言二')], ts: at(9, 0) },
    { role: 'user', parts: [text('开始')], ts: at(9, 1) },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].index, 2);
  assert.equal(turns[0].question, '开始');
  assert.equal(turns[0].start.getTime(), at(9, 1).getTime());
});

test('turns: 最后一轮停在工具调用上不算有最终回复', () => {
  const turns = buildTurns([
    { role: 'user', parts: [text('跑一下')], ts: at(9, 0) },
    { role: 'tool', parts: [tool('completed')], ts: at(9, 1) },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps, 1);
  assert.equal(turns[0].hasFinalReply, false);
});

test('turns: 提问摘要最多 80 字', () => {
  const turns = buildTurns([{ role: 'user', parts: [text('问'.repeat(200))], ts: at(9, 0) }]);
  assert.equal(turns[0].question.length, 80);
  assert.ok(turns[0].question.endsWith('…'));
});

test('turns: 空数组返回空目录', () => {
  assert.deepEqual(buildTurns([]), []);
  assert.deepEqual(buildTurns(null), []);
});
