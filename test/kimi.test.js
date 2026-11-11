import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, tempDir, withEnv } from './helpers.js';
import * as kimi from '../src/scanners/kimi.js';

/**
 * Kimi 扫描器的格式契约（形状来自 MAGPIE kimi.go / CC Switch kimi.rs 上游源码）。
 *
 * 锁三件会静默出错的事：
 *   1. **两种目录形态都要认**：state.json 在 <id>/（MAGPIE）与
 *      <id>/session-meta/state.json（CC Switch）；agents 下 main 与任意 agent 的 wire。
 *   2. **协议 1.0/1.4/1.5 不与 step.end 配对**：usage.record 只用自身的 time/model/usage，
 *      1.4（step.end 在前）、1.5（usage 在前）、裸 usage（无 step.end）都得计入。
 *   3. **fork 复制父 wire 后去重**：forked marker 之前的复制段不算 fork 自己的，
 *      重复 kimiCallKey 的 usage.record 只算一次。
 *
 * 另外锁：cwd 缺失时查根 session_index.jsonl（tombstone 行跳过）、拿不到不猜；
 * 显式数据源 discoverWithin / ctx.roots 越界校验不被本机根误杀。
 */

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

/** 清掉本家环境变量，避免跑测试那台机器的真实设置漏进沙盒。 */
function cleanEnv() {
  return { KIMI_CODE_HOME: null, GROK_HOME: null, MINIMAX_DATA_DIR: null, MAVIS_DATA_DIR: null };
}

const T0 = 1700000000000; // 2023-11-14T22:13:20Z，毫秒

/** MAGPIE 形态：<id>/state.json + agents/main|worker/wire.jsonl。 */
function magpieShape(box) {
  const dir = '.kimi-code/sessions/wd_proj_123/sess-a';
  box.write(`${dir}/state.json`, JSON.stringify({
    title: 'Kimi 生成的标题',
    cwd: 'E:/proj',
    createdAt: T0,
    updatedAt: T0 + 60000,
  }));
  const wire = [
    { type: 'metadata', protocol_version: '1.5' },
    { type: 'agent.message.appended', time: T0 + 1000, message: { message: { role: 'user', content: [{ type: 'text', text: 'Fix this project' }] } } },
    { type: 'agent.message.appended', time: T0 + 2000, message: { message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed' }] } } },
    { type: 'usage.record', agentId: 'main', model: 'k2', usage: { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 0 }, time: T0 + 3000 },
    { type: 'context.append_loop_event', event: { type: 'step.end' }, time: T0 + 4000 },
  ];
  box.write(`${dir}/agents/main/wire.jsonl`, jsonl(...wire));
  box.write(`${dir}/agents/worker/wire.jsonl`, jsonl(
    { type: 'context.append_message', time: T0 + 2500, message: { role: 'assistant', content: [{ type: 'text', text: '子代理在干活' }] } }
  ));
  return box.path(dir);
}

/** CC Switch 形态：state.json 在 session-meta/、只 agents/main/wire.jsonl、含 agent.switched。 */
function ccSwitchShape(box) {
  const dir = '.kimi-code/sessions/workspace-b/sess-b';
  box.write(`${dir}/session-meta/state.json`, JSON.stringify({
    title: 'B 的应用标题',
    workDir: '/work/b', // 1.5 之前的旧字段名
    createdAt: '2023-11-14T22:13:20.000Z', // 1.5 之前是 RFC3339 字符串
    updatedAt: '2023-11-14T22:14:20.000Z',
  }));
  box.write(`${dir}/agents/main/wire.jsonl`, jsonl(
    { type: 'turn.prompt', origin: { kind: 'user' }, input: [{ type: 'text', text: 'B 的真人首句' }], time: T0 + 1000 },
    { type: 'agent.switched', branch: 'fork', base: { branch: 'main', line: 1 } },
    { type: 'turn.prompt', origin: { kind: 'user' }, input: [{ type: 'text', text: '第二句' }], time: T0 + 2000 }
  ));
  return box.path(dir);
}

test('kimi: 两种目录形态都认，真实形状解出会话（标题取真人首句、cwd/时间对）', async () => {
  const box = sandbox();
  try {
    magpieShape(box);
    ccSwitchShape(box);
    await box.run(() => withEnv(cleanEnv(), () => {
      const files = kimi.discover();
      assert.equal(files.length, 2, '一个会话目录只出一个代表文件，两种形态各一场');

      const sessions = files.map((f) => kimi.parse(f));
      const byId = new Map(sessions.map((s) => [s.id, s]));
      assert.ok(byId.has('sess-a'), 'MAGPIE 形态（<id>/state.json + 多 agent wire）');
      assert.ok(byId.has('sess-b'), 'CC Switch 形态（session-meta/state.json + main wire）');

      const a = byId.get('sess-a');
      assert.equal(a.title, 'Fix this project', '标题取第一句真人输入，不是应用标题');
      assert.equal(a.project, 'E:/proj', 'cwd 取 state.json');
      assert.equal(a.start.getUTCFullYear(), 2023, 'createdAt 毫秒不能被当秒/字符串');
      assert.match(a.source, /agents[\\/]main[\\/]wire\.jsonl$/, '代表文件优先 main 的 wire');

      const b = byId.get('sess-b');
      assert.equal(b.title, 'B 的真人首句', '老版 wire 只有 turn.prompt 时也要取到真人首句');
      assert.equal(b.project, '/work/b', 'cwd 取旧字段 workDir');
      assert.equal(b.start.getUTCFullYear(), 2023, 'RFC3339 字符串时间不能被当 1970');
      assert.equal(b.end.getUTCFullYear(), 2023);
    }));
  } finally {
    box.cleanup();
  }
});

test('kimi: 协议差异不与 step.end 配对；fork 复制段/marker/重复 key 去重', async () => {
  const box = sandbox();
  try {
    const u = (time, n) => ({ type: 'usage.record', agentId: 'main', model: 'k2', usage: { inputOther: n, output: n, inputCacheRead: 0, inputCacheCreation: 0 }, time });
    // 会话 P：1.4（step.end 在前）、1.5（usage 在前）、裸 usage、重复 key 各一条
    box.write('.kimi-code/sessions/wd/sess-p/state.json', JSON.stringify({ cwd: 'E:/p', createdAt: T0, updatedAt: T0 + 9000 }));
    box.write('.kimi-code/sessions/wd/sess-p/agents/main/wire.jsonl', jsonl(
      { type: 'context.append_loop_event', event: { type: 'step.end' }, time: T0 + 1000 },
      u(T0 + 2000, 10), // 1.4：step.end 先出现，usage 仍要用自身的 time
      u(T0 + 3000, 20), // 1.5：usage 先出现
      { type: 'context.append_loop_event', event: { type: 'step.end' }, time: T0 + 4000 },
      u(T0 + 5000, 30), // 裸 usage：完全没有 step.end 也要计入
      u(T0 + 5000, 30) // 与上一条 key 完全相同：fork 复制/重复写入，只算一次
    ));
    // 会话 F：fork 复制父 wire（同 key 的 usage），marker 之后才是自己的
    box.write('.kimi-code/sessions/wd/sess-f/state.json', JSON.stringify({ cwd: 'E:/f', createdAt: T0 + 6000, forkedFrom: 'sess-p' }));
    box.write('.kimi-code/sessions/wd/sess-f/agents/main/wire.jsonl', jsonl(
      u(T0 + 2000, 10), // 复制段：父的，时间都不变
      { type: 'forked', agentId: 'main', time: T0 + 6000 },
      u(T0 + 7000, 70) // fork 自己的
    ));

    await box.run(() => withEnv(cleanEnv(), () => {
      const files = kimi.discover();
      const sessions = files.map((f) => kimi.parse(f));
      const p = sessions.find((s) => s.id === 'sess-p');
      const f = sessions.find((s) => s.id === 'sess-f');
      assert.equal(f.branchOf, 'sess-p', 'forkedFrom 如实记成分叉来源');

      const usageOf = (s) => kimi.readMessages(s).filter((m) => m.meta && m.meta.kind === 'usage.record');
      const pUsage = usageOf(p);
      assert.equal(pUsage.length, 3, '1.4/1.5/裸 usage 三条都计入，重复 key 只算一次——不与 step.end 配对');
      assert.deepEqual(
        pUsage.map((m) => m.ts.toISOString()),
        ['2023-11-14T22:13:22.000Z', '2023-11-14T22:13:23.000Z', '2023-11-14T22:13:25.000Z'],
        '每条 usage 用自己的 time，绝不拿 step.end 的时间去配'
      );

      const fUsage = usageOf(f);
      assert.equal(fUsage.length, 1, 'forked marker 之前的父复制段不算 fork 自己的');
      assert.equal(fUsage[0].ts.toISOString(), '2023-11-14T22:13:27.000Z', '只留 marker 之后 fork 自己的那条');
    }));
  } finally {
    box.cleanup();
  }
});

test('kimi: cwd 缺失查根 session_index.jsonl，tombstone 行跳过，拿不到留 null', async () => {
  const box = sandbox();
  try {
    box.write('.kimi-code/sessions/wd/sess-c/state.json', JSON.stringify({ title: 'C', createdAt: T0 }));
    box.write('.kimi-code/sessions/wd/sess-c/agents/main/wire.jsonl', jsonl(
      { type: 'agent.message.appended', time: T0, message: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } }
    ));
    box.write('.kimi-code/sessions/wd/sess-d/state.json', JSON.stringify({ title: 'D', createdAt: T0 }));
    box.write('.kimi-code/sessions/wd/sess-d/agents/main/wire.jsonl', jsonl(
      { type: 'agent.message.appended', time: T0, message: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } }
    ));
    box.write('.kimi-code/session_index.jsonl', jsonl(
      { sessionId: 'sess-c', sessionDir: 'x', workDir: '/indexed/c' },
      { sessionId: 'sess-c', deleted: true } // 删除墓碑不能覆盖真索引
    ));

    await box.run(() => withEnv(cleanEnv(), () => {
      const byId = new Map(kimi.discover().map((f) => kimi.parse(f)).map((s) => [s.id, s]));
      assert.equal(byId.get('sess-c').project, '/indexed/c', 'state 没 cwd 时查根 session_index.jsonl');
      assert.equal(byId.get('sess-d').project, null, '索引里也没有就留 null，不猜 cwd');
    }));
  } finally {
    box.cleanup();
  }
});

test('kimi: structureSpec 确定 + decoy 不误判 + 显式根下 ctx.roots 不误杀', async () => {
  const spec = kimi.structureSpec;
  assert.equal(spec.agent, 'kimi');
  assert.equal(spec.minScore, 4);
  assert.deepEqual(spec.rootAnchor, { from: 'sessions', up: 1, allowSelf: true });
  assert.ok(spec.dirHints.includes('.kimi-code') && spec.dirHints.includes('.kimi'));
  const wireProbe = spec.probes.find((p) => p.glob === 'sessions/*/*/agents/*/wire.jsonl');
  const stateProbe = spec.probes.find((p) => p.glob === 'sessions/*/*/state.json');
  const sessionsDir = spec.probes.find((p) => p.path === 'sessions');
  assert.equal(wireProbe.weight, 4, '真实 wire 文件是强特征');
  assert.equal(stateProbe.weight, 2);
  assert.equal(stateProbe.optional, true, 'state.json 是可选旁路文件');
  assert.equal(sessionsDir.weight, 1);
  assert.equal(typeof kimi.discoverWithin, 'function', 'structureSpec 与 discoverWithin 必须成对加');

  const decoy = tempDir();
  try {
    decoy.write('sessions/foo/random.jsonl', '{}\n'.repeat(5));
    assert.deepEqual(kimi.discoverWithin([decoy.dir], {}), [], '光有一堆无关 .jsonl 不构成 kimi 会话');

    // 显式根：discoverWithin 与 readMessages(ctx.roots) 都不依赖本机 HOME
    const root = tempDir();
    try {
      const appRoot = path.join(root.dir, '.kimi-code');
      root.write('.kimi-code/sessions/wd/sess-x/state.json', JSON.stringify({ cwd: 'E:/x', createdAt: T0 }));
      root.write('.kimi-code/sessions/wd/sess-x/agents/main/wire.jsonl', jsonl(
        { type: 'agent.message.appended', time: T0, message: { message: { role: 'user', content: [{ type: 'text', text: '外部源的会话' }] } } }
      ));
      const files = kimi.discoverWithin([appRoot], {});
      assert.equal(files.length, 1, '显式应用根下能发现会话');
      const s = kimi.parse(files[0]);
      assert.equal(s.title, '外部源的会话');
      const msgs = kimi.readMessages(s, { roots: [appRoot] });
      assert.ok(msgs.some((m) => m.parts.some((p) => p.text === '外部源的会话')), 'ctx.roots 优先，外部文件不被本机根误杀');
    } finally {
      root.cleanup();
    }
  } finally {
    decoy.cleanup();
  }
});
