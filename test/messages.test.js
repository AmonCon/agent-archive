import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeInput } from '../src/messages.js';

test('summarizeInput: 字符串压成一行并按 limit 截断', () => {
  assert.equal(summarizeInput('  多行\n文本  ', { limit: 20 }), '多行 文本');
  assert.equal(summarizeInput('a'.repeat(50), { limit: 10 }), 'a'.repeat(10) + '…');
});

test('summarizeInput: Codex command 数组取真正的命令，跳过启动参数', () => {
  const input = { command: ['powershell.exe', '-NoProfile', '-Command', 'Get-ChildItem -Recurse'] };
  assert.equal(summarizeInput(input, { limit: 100 }), 'Get-ChildItem -Recurse');

  // 找不到真正的命令时退回整串 join
  assert.equal(summarizeInput({ command: ['-NoProfile', '-c', 'x'] }, { limit: 100 }), '-NoProfile -c x');
});

test('summarizeInput: 普通对象按常见键取字符串', () => {
  assert.equal(summarizeInput({ command: 'npm test', extra: 1 }), 'npm test');
  assert.equal(summarizeInput({ file_path: 'src/a.js' }), 'src/a.js');
  assert.equal(summarizeInput({ skill: 'web-app-development' }), 'web-app-development');
});

test('summarizeInput: fallback none 对无可用字段的对象返回空', () => {
  assert.equal(summarizeInput({ foo: 'bar' }, { fallback: 'none' }), '');
  assert.equal(summarizeInput({ foo: 'bar' }, { limit: 70, fallback: 'none' }), '');
});

test('summarizeInput: JSON fallback 压成一行并按 jsonLimit 截断', () => {
  const out = summarizeInput({ a: 'x\ny', b: 2 }, { jsonLimit: 80 });
  assert.ok(!out.includes('\n'));
  assert.equal(out, '{"a":"x\\ny","b":2}');

  const cut = summarizeInput({ a: 'z'.repeat(100) }, { jsonLimit: 10 });
  assert.equal(cut, '{"a":"zzzz' + '…');
});
