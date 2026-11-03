import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { lineIterator, forEachLine } from '../src/scanners/lines.js';

/**
 * 逐行读的契约。
 *
 * 这一层不是"快"，是**在大文件上不炸**。两条纪律：
 *   1. 一行超长时丢掉这一行，但**后续行必须照常读**（整文件封顶会漏数据）；
 *   2. 文件末尾没有换行符时，最后一行也要产出。
 */

test('lines: 普通多行文件逐行产出，CRLF 的 \\r 被去掉', async () => {
  const box = sandbox();
  try {
    const f = box.write('.x/a.jsonl', 'a\nb\nc\n');
    assert.deepEqual([...lineIterator(f)], ['a', 'b', 'c']);

    const crlf = box.write('.x/b.jsonl', 'a\r\nb\r\n');
    assert.deepEqual([...lineIterator(crlf)], ['a', 'b']);
  } finally {
    box.cleanup();
  }
});

test('lines: 末尾没有换行符时最后一行也要产出', async () => {
  const box = sandbox();
  try {
    const f = box.write('.x/a.jsonl', 'a\nb');
    assert.deepEqual([...lineIterator(f)], ['a', 'b']);
  } finally {
    box.cleanup();
  }
});

test('lines: 超长行被跳过，但同一文件后面的行照常产出', async () => {
  const box = sandbox();
  try {
    // 一行 9 MB，超过默认 8 MB 上限
    const big = 'x'.repeat(9 * 1024 * 1024);
    const f = box.write('.x/big.jsonl', `{"a":1}\n${big}\n{"b":2}\n`);
    const got = [...lineIterator(f)];
    assert.deepEqual(got, ['{"a":1}', '{"b":2}'], '超长行丢掉，前后的行都在');

    let oversize = 0;
    const stats = forEachLine(f, () => {}, { onOversize: () => {} });
    assert.equal(stats.oversize, 1, '要如实报出跳过了几行');
    assert.equal(stats.lines, 2);
  } finally {
    box.cleanup();
  }
});

test('lines: 超长行横跨多个读块也能被正确跳过', async () => {
  const box = sandbox();
  try {
    const big = 'y'.repeat(300 * 1024);
    // 用很小的 chunk 模拟跨块
    const f = box.write('.x/cross.jsonl', `${big}\nkeep\n`);
    const got = [...lineIterator(f, { maxLineBytes: 100 * 1024, chunkBytes: 16 * 1024 })];
    assert.deepEqual(got, ['keep']);
  } finally {
    box.cleanup();
  }
});

test('lines: 坏 JSON 行照样作为字符串产出（解析是调用方的事）', async () => {
  const box = sandbox();
  try {
    const f = box.write('.x/bad.jsonl', '{"a":1}\n{broken\n{"b":2}\n');
    assert.deepEqual([...lineIterator(f)], ['{"a":1}', '{broken', '{"b":2}']);
  } finally {
    box.cleanup();
  }
});

test('lines: 空文件产出零行', async () => {
  const box = sandbox();
  try {
    const f = box.write('.x/empty.jsonl', '');
    assert.deepEqual([...lineIterator(f)], []);
  } finally {
    box.cleanup();
  }
});