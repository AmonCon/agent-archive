import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, tempDir, withEnv } from './helpers.js';
import * as grok from '../src/scanners/grokbuild.js';

/**
 * Grok Build 扫描器的格式契约（形状来自 MAGPIE grok.go / CC Switch grokbuild.rs）。
 *
 * 锁三件会静默出错的事：
 *   1. **元数据/正文分离**：source 是 summary.json，正文在同目录；title 优先正文里的
 *      第一句真人输入，generated_title 只是兜底；时间戳有 RFC3339 字符串与秒两种。
 *   2. **两种正文文件都在时行为确定**：chat_history.jsonl 与 updates.jsonl 都在时
 *      只读 chat_history.jsonl，绝不把两股消息混进同一场会话；archived_sessions 也扫。
 *   3. **reasoning 记录不当对话消息**（含加密/内部态），以及活跃文件逐行读时
 *      单行超长只丢那一行、后面的话还在（上限加在记录粒度）。
 *
 * 另外锁：updates.jsonl 的 ACP 形状（user_message_chunk 累积 / turn_completed /
 * hook_execution 跳过）、显式数据源 discoverWithin / ctx.roots 越界校验。
 */

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

function cleanEnv() {
  return { KIMI_CODE_HOME: null, GROK_HOME: null, MINIMAX_DATA_DIR: null, MAVIS_DATA_DIR: null };
}

const SEC = 1774599070; // 2026 年，秒级

function summary(o) {
  return JSON.stringify(o);
}

test('grokbuild: summary.json 元数据 + chat_history.jsonl 正文；reasoning 不当对话', async () => {
  const box = sandbox();
  try {
    const dir = '.grok/sessions/encoded-project/grok-1';
    box.write(`${dir}/summary.json`, summary({
      info: { id: 'grok-1', cwd: 'C:/work' },
      generated_title: 'Grok session',
      session_summary: 'hello grok',
      created_at: '2026-07-16T12:00:00Z',
      last_active_at: '2026-07-16T12:00:01Z',
    }));
    box.write(`${dir}/chat_history.jsonl`, jsonl(
      { type: 'system', content: 'You are Grok.' },
      { type: 'user', content: [{ type: 'text', text: 'clean journal' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private encrypted state' }] },
      { type: 'assistant', content: 'Hi there' },
      { type: 'tool', tool_call_id: 'c1', content: 'Vacuuming done' }
    ));

    await box.run(() => withEnv(cleanEnv(), () => {
      const files = grok.discover();
      assert.equal(files.length, 1, '递归找到两层目录下的 summary.json');
      const s = grok.parse(files[0]);
      assert.equal(s.id, 'grok-1');
      assert.equal(s.project, 'C:/work', 'cwd 取 info.cwd');
      assert.equal(s.title, 'clean journal', '标题取第一句真人输入，不是 generated_title');
      assert.equal(s.start.getUTCFullYear(), 2026, 'RFC3339 字符串不能被当 1970');
      assert.equal(s.end.getUTCFullYear(), 2026);
      assert.equal(s.source.endsWith('summary.json'), true, 'source 是元数据文件，正文分离');
      assert.equal(s.resume, 'grok --resume grok-1');

      const msgs = grok.readMessages(s);
      assert.equal(msgs.length, 4, 'system/user/assistant/tool 四条；reasoning 被跳过');
      assert.ok(!JSON.stringify(msgs).includes('private encrypted state'), 'reasoning 的加密/内部态不当对话消息');
      assert.equal(msgs[0].role, 'system', 'system prompt 归系统内容，不冒充用户');
      assert.equal(msgs[1].parts[0].text, 'clean journal');
      assert.equal(msgs[2].parts[0].text, 'Hi there');
      assert.equal(msgs[3].role, 'tool');
      assert.equal(msgs[3].parts[0].output, 'Vacuuming done');
    }));
  } finally {
    box.cleanup();
  }
});

test('grokbuild: 两种正文都在时行为确定；archived_sessions 与 updates.jsonl 也认', async () => {
  const box = sandbox();
  try {
    // 两个正文文件都在：只读 chat_history.jsonl
    const both = '.grok/sessions/two/id-both';
    box.write(`${both}/summary.json`, summary({
      info: { id: 'id-both', cwd: 'C:/two' },
      generated_title: '应用标题',
      created_at: SEC,
      updated_at: SEC + 10,
    }));
    box.write(`${both}/chat_history.jsonl`, jsonl(
      { type: 'user', content: 'FROM CHAT', timestamp: SEC },
      { type: 'assistant', content: 'FROM CHAT REPLY', timestamp: SEC + 1 }
    ));
    box.write(`${both}/updates.jsonl`, jsonl(
      { params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'FROM UPDATES' } } }, timestamp: SEC },
      { params: { update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-3': { inputTokens: 1 } } } } }, timestamp: SEC + 2 }
    ));

    // archived_sessions 里只有 updates.jsonl（MAGPIE 形状）
    const upd = '.grok/archived_sessions/arch/id-upd';
    box.write(`${upd}/summary.json`, summary({
      info: { id: 'id-upd' },
      session_summary: '归档会话',
      created_at: SEC,
      last_active_at: SEC + 20,
    }));
    box.write(`${upd}/updates.jsonl`, jsonl(
      { params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '合并' } } }, timestamp: SEC },
      { params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '成一整句' } } }, timestamp: SEC + 1 },
      { params: { update: { sessionUpdate: 'hook_execution' } }, timestamp: SEC + 2 },
      { params: { update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { 'grok-3': { inputTokens: 5 } } } } }, timestamp: SEC + 3 }
    ));

    await box.run(() => withEnv(cleanEnv(), () => {
      const files = grok.discover();
      assert.equal(files.length, 2, 'sessions/ 与 archived_sessions/ 都扫');
      const byId = new Map(files.map((f) => grok.parse(f)).map((s) => [s.id, s]));

      const b = byId.get('id-both');
      assert.equal(b.start.getUTCFullYear(), 2026, '秒级时间戳不能被当毫秒（否则掉到 1970）');
      const bMsgs = grok.readMessages(b);
      const bText = JSON.stringify(bMsgs);
      assert.ok(bText.includes('FROM CHAT'), 'chat_history.jsonl 优先');
      assert.ok(!bText.includes('FROM UPDATES'), '两个正文都在时只读一个，行为确定、不混读');
      assert.ok(!bText.includes('grok-3'), 'updates.jsonl 的 turn_completed 不混进来');

      const u = byId.get('id-upd');
      assert.equal(u.project, null, 'info 里没有 cwd 就留 null，不猜');
      const uMsgs = grok.readMessages(u);
      assert.ok(uMsgs.some((m) => m.role === 'user' && m.parts[0].text === '合并成一整句'),
        'user_message_chunk 连续片段累积成一句，不碎成两条');
      assert.ok(uMsgs.some((m) => m.meta && m.meta.kind === 'turn_completed'), 'turn_completed 的 usage 如实留一条记录');
      assert.ok(!JSON.stringify(uMsgs).includes('hook_execution'), 'hook_execution 不当对话消息');
    }));
  } finally {
    box.cleanup();
  }
});

test('grokbuild: 逐行读——单行超长只丢那一行，后面的话还在', async () => {
  const box = sandbox();
  try {
    const dir = '.grok/sessions/big/id-big';
    box.write(`${dir}/summary.json`, summary({
      info: { id: 'id-big', cwd: 'C:/big' },
      created_at: SEC,
      last_active_at: SEC + 30,
    }));
    // 一条超过 lineIterator 单行上限（8 MiB）的巨大 tool 记录，后面跟正常 user 消息
    const huge = 'x'.repeat(9 * 1024 * 1024);
    box.write(`${dir}/chat_history.jsonl`,
      line({ type: 'tool', tool_call_id: 'huge', content: huge }) +
      line({ type: 'user', content: '超长行之后的话', timestamp: SEC }));

    await box.run(() => withEnv(cleanEnv(), () => {
      const s = grok.parse(grok.discover()[0]);
      const msgs = grok.readMessages(s);
      const text = JSON.stringify(msgs);
      assert.ok(!text.includes(huge.slice(0, 1000)), '超长行的内容被丢掉（记录粒度上限）');
      assert.ok(text.includes('超长行之后的话'), '不因一行超长就放弃整个文件——后面的话还在');
    }));
  } finally {
    box.cleanup();
  }
});

test('grokbuild: structureSpec 确定 + decoy 不误判 + 显式根下 ctx.roots 不误杀', async () => {
  const spec = grok.structureSpec;
  assert.equal(spec.agent, 'grokbuild');
  assert.equal(spec.minScore, 4);
  assert.deepEqual(spec.rootAnchor, { from: 'sessions', up: 1, allowSelf: true });
  assert.deepEqual(spec.dirHints, ['.grok']);
  assert.ok(spec.probes.some((p) => p.glob === 'sessions/*/summary.json' && p.weight === 4));
  assert.ok(spec.probes.some((p) => p.glob === 'sessions/**/summary.json' && p.weight === 4),
    '真实布局是两层目录，补 ** 版强特征才认得出来');
  assert.ok(spec.probes.some((p) => p.glob === 'sessions/*/chat_history.jsonl' && p.optional));
  assert.ok(spec.probes.some((p) => p.glob === 'sessions/*/updates.jsonl' && p.optional));
  assert.ok(spec.probes.some((p) => p.path === 'archived_sessions' && p.optional));
  assert.equal(typeof grok.discoverWithin, 'function', 'structureSpec 与 discoverWithin 必须成对加');

  const decoy = tempDir();
  try {
    decoy.write('sessions/foo/random.jsonl', '{}\n'.repeat(5));
    assert.deepEqual(grok.discoverWithin([decoy.dir], {}), [], '光有 .jsonl 没有 summary.json 不构成 grok 会话');

    const root = tempDir();
    try {
      const rel = '.grok/sessions/encoded/id-ext';
      root.write(`${rel}/summary.json`, summary({ info: { id: 'id-ext', cwd: 'C:/ext' }, created_at: SEC }));
      root.write(`${rel}/chat_history.jsonl`, jsonl({ type: 'user', content: '外部源的会话', timestamp: SEC }));
      const appRoot = path.join(root.dir, '.grok');
      const files = grok.discoverWithin([appRoot], {});
      assert.equal(files.length, 1, '显式应用根下能发现会话');
      const s = grok.parse(files[0]);
      const msgs = grok.readMessages(s, { roots: [appRoot] });
      assert.ok(msgs.some((m) => m.parts.some((p) => p.text === '外部源的会话')),
        'ctx.roots 优先，外部文件不被本机根误杀');
      assert.ok(path.isAbsolute(s.source), 'source 是绝对路径');
    } finally {
      root.cleanup();
    }
  } finally {
    decoy.cleanup();
  }
});
