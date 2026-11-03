import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { FIXTURES, fixtureKeys, materialize } from './fixtures/index.js';
import { renderTextBlocks } from '../src/web/format.js';
import { dispatch } from '../src/mcp.js';
import { clearTranscriptCache } from '../src/transcript-cache.js';

/**
 * 跨入口契约：**同一份字节，扫描 / Web / MCP 三个入口读出来的内容必须一致**。
 *
 * ## 为什么这条比"每个入口各测各的"重要
 *
 * 三个入口是三条独立代码路径：扫描器把文件变成统一消息模型，Web 把模型渲染
 * 成 HTML，MCP 把模型渲染成给模型看的文本。任何一层把内容丢了（比如正文里
 * 的 `<` 没转义、工具输出没配对、消息被过滤），另外两层可能完全正常——
 * 用户会看到「时间线里有这场会话，点进去是空的」，而测试全绿。
 *
 * 所以这里不重复每个扫描器自己的格式用例（那些在各自的 test 里），只锁
 * 一件事：**样本里的关键内容，从扫描结果到两个渲染出口都不能丢**。
 */

const registry = await import('../src/registry.js');

/** 按名字找扫描器（注册表是唯一入口，不在用例里另建映射）。 */
function scannerOf(name) {
  const s = registry.scanners.find((x) => x.name === name);
  assert.ok(s, `注册表里应该有扫描器 ${name}`);
  return s;
}

/** 在一场会话的消息里找所有纯文本。 */
function textsOf(messages) {
  return messages
    .flatMap((m) => m.parts)
    .filter((p) => p.kind === 'text')
    .map((p) => p.text);
}

/** 走一遍 Web 的渲染出口（会话页用的就是它）。 */
function webText(messages) {
  return renderTextBlocks(textsOf(messages).join('\n\n'));
}

for (const key of fixtureKeys()) {
  test(`fixture/${key}: 扫描 → 正文 → Web → MCP 四个环节都不丢内容`, async () => {
    const box = sandbox();
    try {
      const spec = await box.run(() => materialize(box, key));
      assert.equal(spec.scanner, FIXTURES[key].scanner);

      await box.run(async () => {
        registry.clearScanCache();
        clearTranscriptCache();

        const scanner = scannerOf(spec.scanner);
        const discovered = scanner.discover();
        assert.ok(discovered.length > 0, '样本要能被这个扫描器发现');

        const stats = registry.scanAll({ noCache: true });
        const mine = stats.sessions.filter((s) => s.agent === spec.scanner);
        const expect = spec.expect;
        assert.equal(mine.length, expect.sessions, '会话数要与样本登记的一致');

        // 主会话（没有主会话的样本取第一场）
        const main = mine.find((s) => s.kind === 'main') || mine[0];

        // ---- 入口 1：扫描器读正文 ----
        const messages = scanner.readMessages(main);
        const texts = textsOf(messages);
        for (const want of expect.userTexts || []) {
          assert.ok(
            texts.some((t) => t.includes(want)),
            `正文里应当有「${want}」，实得：${JSON.stringify(texts.slice(0, 5))}`
          );
        }
        if (expect.toolOutput) {
          const tools = messages.flatMap((m) => m.parts).filter((p) => p.kind === 'tool');
          assert.ok(
            tools.some((p) => String(p.output || '').includes(expect.toolOutput)),
            '工具输出要按 callId 配对回来'
          );
        }

        // ---- 入口 2：Web 渲染 ----
        const html = webText(messages);
        for (const want of expect.userTexts || []) {
          assert.ok(html.includes(want), `Web 渲染后仍要有「${want}」`);
        }
        // 用户内容里的 HTML 必须被转义，不能原样变成标签
        if (expect.userTexts && expect.userTexts.length) {
          assert.equal(/<script/i.test(html), false, '渲染结果不该出现可执行的标签');
        }

        // ---- 入口 3：MCP read_session ----
        if (main && main.id) {
          const res = await dispatch({
            method: 'tools/call',
            params: { name: 'read_session', arguments: { id: main.id, agent: spec.scanner, maxChars: 40000 } },
          });
          const payload = res && res.content ? res.content.map((c) => c.text || '').join('\n') : '';
          assert.ok(payload, 'MCP 要能读出这场会话');
          for (const want of expect.userTexts || []) {
            assert.ok(payload.includes(want), `MCP read_session 里仍要有「${want}」`);
          }
        }

        // ---- 样本自己的语义断言（复制/分叉、父会话归属等） ----
        if (expect.copyOf) {
          const copy = mine.find((s) => s.copyOf === expect.copyOf);
          assert.ok(copy, '完全复制的会话要标 copyOf');
        }
        if (expect.branchOf) {
          const branch = mine.find((s) => s.branchOf === expect.branchOf);
          assert.ok(branch, '分叉会话要标 branchOf');
        }
        if (expect.subagentParents) {
          const subs = mine.filter((s) => s.kind === 'subagent');
          assert.equal(subs.length, expect.subagentParents, '两代父 id 写法都要认出是子代理');
          for (const s of subs) assert.ok(s.parent, '子代理必须有父会话 id');
          assert.equal(
            new Set(subs.map((s) => s.parent)).size,
            1,
            '两代写法要归到同一个父会话'
          );
        }
        if (expect.title) {
          assert.equal(main.title, expect.title);
        }
        if (expect.project) {
          assert.equal(main.project, expect.project);
        }
      });
    } finally {
      box.cleanup();
    }
  });
}

test('fixture: 每个样本都被登记，登记的样本文件都真实存在', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const samplesDir = path.join(process.cwd(), 'test', 'fixtures', 'samples');
  const onDisk = new Set(fs.readdirSync(samplesDir));
  const registered = new Set();
  for (const spec of Object.values(FIXTURES)) {
    for (const sample of Object.values(spec.files)) registered.add(sample);
  }
  for (const name of registered) {
    assert.ok(onDisk.has(name), `登记了但文件不存在：${name}`);
  }
  for (const name of onDisk) {
    assert.ok(registered.has(name), `样本没被任何 fixture 登记：${name}`);
  }
});