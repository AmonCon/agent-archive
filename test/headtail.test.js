import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import { readHeadTail, headLines, tailLines, jsonLines } from '../src/scanners/headtail.js';

/**
 * 「扫描期只读头尾」这个优化的契约。
 *
 * 这一层不是性能工具，是**正确性工具**：它把「读多少」变成一个可以单测的
 * 决定。搞错了会出两类静默错误：
 *
 *   1. 头尾的接缝没处理 → 半行被当成完整事件（或少读一行边界）；
 *   2. 只读了头尾却当成读了全文 → 中段才出现的真人消息被漏掉，整场会话
 *      被误判成工具会话而从档案里消失。
 *
 * 所以这里既测「读得少」，也测「读少了会如实报告自己没读全」（incomplete
 * 由调用方判断，本模块只保证边界正确）。
 */

function bigText(bytes, fill = 'x') {
  return fill.repeat(bytes);
}

test('headtail: 小文件整读，头尾不重叠', async () => {
  const box = sandbox();
  try {
    const file = box.write('.x/small.jsonl', '{"a":1}\n{"a":2}\n');
    const ht = readHeadTail(file);
    assert.equal(ht.whole, true, '小于头+尾上限的文件应当整读');
    assert.equal(ht.tail, '');
    assert.equal(headLines(ht).filter(Boolean).length, 2);
    assert.deepEqual(tailLines(ht), []);
  } finally {
    box.cleanup();
  }
});

test('headtail: 大文件只取头尾的完整行，中间不出现、半行被丢掉', async () => {
  const box = sandbox();
  try {
    const headLine = '{"head":1}';
    const middleLine = '{"middle":1}';
    const tailLine = '{"tail":1}';
    // 构造：头一行 + 中间大量填充（把 middleLine 埋在正中）+ 尾一行
    const filler = bigText(400 * 1024, 'a');
    const content =
      headLine + '\n' + filler + '\n' + middleLine + '\n' + filler + '\n' + tailLine + '\n';
    const file = box.write('.x/big.jsonl', content);

    const ht = readHeadTail(file);
    assert.equal(ht.whole, false);

    const all = [...jsonLines(headLines(ht).concat(tailLines(ht)))];
    const keys = all.map((o) => Object.keys(o)[0]);

    assert.ok(keys.includes('head'), '头段第一行必须读到');
    assert.ok(keys.includes('tail'), '尾段最后一行必须读到');
    assert.equal(keys.includes('middle'), false, '中间内容不该被读出来');

    // 接缝：头段最后一行是半截填充行、尾段第一行也是半截，都必须被丢掉，
    // 不能出现半行被解析成对象或把两条 JSON 粘在一起。
    for (const o of all) {
      assert.equal(typeof o, 'object');
      assert.ok(o !== null);
      const k = Object.keys(o)[0];
      assert.ok(['head', 'tail', 'a'].includes(k), `只应出现完整行，实得 key=${k}`);
    }
    assert.equal(all.length, 2, '只有两条完整行');
  } finally {
    box.cleanup();
  }
});

test('headtail: 头尾可分别取用，且合并时不重复', async () => {
  const box = sandbox();
  try {
    const filler = bigText(400 * 1024, 'b');
    const content = '{"h":1}\n' + filler + '\n{"t":1}\n';
    const file = box.write('.x/big2.jsonl', content);
    const ht = readHeadTail(file);

    const head = [...jsonLines(headLines(ht))].map((o) => Object.keys(o)[0]);
    const tail = [...jsonLines(tailLines(ht))].map((o) => Object.keys(o)[0]);
    assert.ok(head.includes('h'));
    assert.equal(head.includes('t'), false, '尾段内容不该出现在头段');
    assert.ok(tail.includes('t'));
    assert.equal(tail.includes('h'), false, '头段内容不该出现在尾段');

    const merged = [...jsonLines(headLines(ht).concat(tailLines(ht)))];
    assert.equal(merged.length, new Set(merged.map((o) => JSON.stringify(o))).size, '合并后不应有重复行');
  } finally {
    box.cleanup();
  }
});

test('headtail: 文件读不到时抛错，由调用方决定怎么退化', async () => {
  const box = sandbox();
  try {
    assert.throws(() => readHeadTail(box.path('.x', 'nope.jsonl')));
  } finally {
    box.cleanup();
  }
});