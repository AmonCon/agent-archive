import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMarkdownLite,
  renderTextBlocks,
  looksLikeMarkdown,
  highlight,
  fmtTok,
  fmtDay,
} from '../src/web/format.js';
import { dayKey } from '../src/model.js';

test('markdown: HTML 先转义再排版，脚本不会变成标签', () => {
  const html = renderMarkdownLite('<script>alert(1)</script>\n\n**hi**');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>hi</strong>'));
});

test('markdown: 只把 http(s) 链接变成 <a>，javascript: 留在文本里', () => {
  const ok = renderMarkdownLite('[文档](https://example.com/a?b=1&c=2)');
  assert.ok(ok.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(ok.includes('rel="noopener noreferrer"'));

  const bad = renderMarkdownLite('[x](javascript:alert(1))');
  assert.ok(!bad.includes('href='));
  assert.ok(bad.includes('javascript:alert(1)'));
});

test('markdown: 空行分隔的列表项仍属于同一个列表', () => {
  const html = renderMarkdownLite('1. 第一\n\n2. 第二\n\n3. 第三');
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
});

test('markdown: 紧跟在列表项后的普通行算续行', () => {
  const html = renderMarkdownLite('1. 第一行\n第二行\n2. 第二');
  assert.match(html, /第一行<br>第二行/);
});

test('markdown: 围栏代码块保留原文并转义', () => {
  const html = renderMarkdownLite('```bash\necho "<hi>"\n```');
  assert.ok(html.includes('<pre><code>'));
  assert.ok(html.includes('&quot;&lt;hi&gt;&quot;') || html.includes('&lt;hi&gt;'));
  assert.ok(!html.includes('<hi>'));
});

test('markdown: 标题降一级，引用与分隔线可用', () => {
  const html = renderMarkdownLite('# 标题\n\n> 引用\n\n---');
  assert.ok(html.includes('<h2>标题</h2>'));
  assert.ok(html.includes('<blockquote>引用</blockquote>'));
  assert.ok(html.includes('<hr>'));
});

test('用户消息的 Markdown 识别保持保守', () => {
  assert.equal(looksLikeMarkdown('帮我看一下这个问题'), false);
  assert.equal(looksLikeMarkdown('第一行\n第二行'), false);
  assert.equal(looksLikeMarkdown('## 结论\n- 一条'), true);
  assert.equal(looksLikeMarkdown('用 `npm test` 跑一下'), true);
  assert.equal(looksLikeMarkdown('```\ncode\n```'), true);
});

test('text: 围栏代码块单独排，普通文字转义', () => {
  const html = renderTextBlocks('看这个：\n```js\nconst a = "<b>";\n```\n结束');
  assert.ok(html.includes('class="prose"'));
  assert.ok(html.includes('class="prose code"'));
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
});

test('highlight: 关键词包 mark，其余转义', () => {
  const html = highlight('a < b and agent here', 'agent');
  assert.ok(html.includes('&lt; b'));
  assert.ok(html.includes('<mark>agent</mark>'));
});

test('fmtTok: 万/亿单位可读且四舍五入', () => {
  assert.equal(fmtTok(9999), '9999');
  assert.equal(fmtTok(10000), '1.0万');
  assert.equal(fmtTok(123456789), '1.23亿');
});

test('日期按本地时区分组，不随 UTC 漂移到前一天', () => {
  // 本地时间 00:30 的会话，UTC 还在前一天。按 toISOString 取日会分错组。
  const lateNight = new Date(2026, 9, 30, 0, 30);
  assert.equal(dayKey(lateNight), '2026-10-30');
  assert.equal(fmtDay(lateNight), '2026-10-30');
});
