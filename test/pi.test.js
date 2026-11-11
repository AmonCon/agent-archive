import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, tempDir, withEnv } from './helpers.js';

/**
 * Pi 扫描器的格式契约（合成样本，完全不碰本机真实 ~/.pi/agent）。
 *
 * 锁的是上游源码里验证过的**事实形状**（CC Switch providers_pi.rs 的
 * read_tree / entry_identity / 三个上限 + MAGPIE pi.go 的字段），不是当前实现：
 *
 *   1. 会话树 + 活动分支投影：latest_id 沿 parentId 回溯，被撤销/分叉的轮次
 *      必须隐藏；投影按文件顺序。
 *   2. 环检测：成环不死循环，停在能确定的主干。
 *   3. 重复 id 用最后一个；坏 JSONL 行跳过但后续内容不丢；version<2 legacy 链。
 *   4. header.timestamp 是 ISO、message.timestamp 可能是毫秒，别当秒（否则 1970）。
 *   5. 网关 provider（magpie/dial）当普通消息，但不作为成本来源。
 *   6. structureSpec 相对应用根 .pi、discoverWithin 纯函数、ctx.roots 不被误杀；
 *      pi/omp 同构靠 dirHints 消歧。
 *   7. 相对 sessionDir 不可全局枚举；绝对 sessionDir 覆盖可收。
 */

const scanner = await import('../src/scanners/pi.js');

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');
const T = (sec) => `2026-11-05T00:00:${String(sec).padStart(2, '0')}.000Z`;

const header = (extra = {}) => ({
  type: 'session',
  version: 3,
  id: 'pi-sess',
  cwd: '/work/pi-demo',
  timestamp: '2026-11-05T00:00:00.000Z',
  ...extra,
});

const msg = (id, parentId, role, text, sec = 1, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: T(sec),
  message: { role, content: [{ type: 'text', text }], ...extra },
});

/** 把消息里的文本片段拼出来，便于断言顺序。 */
const textsOf = (msgs) =>
  msgs.map((m) => m.parts.map((p) => p.text || '').join('')).filter(Boolean);

/** 隔离 pi/omp 相关环境变量，避免真实机器的设置漏进本机根断言。 */
const CLEAN_ENV = {
  PI_CODING_AGENT_DIR: null,
  PI_CODING_AGENT_SESSION_DIR: null,
  PI_CONFIG_DIR: null,
  pi_config_dir: null,
};

test('pi: 会话树活动分支投影——撤销分支不进正文、活动分支顺序对', () => {
  const t = tempDir();
  try {
    const root = t.path('.pi');
    const file = t.write(
      '.pi/agent/sessions/proj/20261105_pi-tree.jsonl',
      jsonl(
        header({ id: 'pi-tree' }),
        msg('u1', null, 'user', '第一句提问', 1),
        msg('dead', 'u1', 'assistant', '被撤销的回答', 2), // 分叉后被撤销的轮次
        msg('u2', 'u1', 'user', '换个问法', 3), // 从 u1 重新分叉
        msg('live', 'u2', 'assistant', '在用的回答', 4) // latest_id
      )
    );

    const s = scanner.parse(file);
    assert.ok(s);
    assert.equal(s.id, 'pi-tree');
    assert.equal(s.title, '第一句提问', '标题取第一句真人输入');
    assert.equal(s.project, '/work/pi-demo', 'cwd 取 header');

    const texts = textsOf(scanner.readMessages(s, { roots: [root] }));
    assert.deepEqual(texts, ['第一句提问', '换个问法', '在用的回答'], '活动分支按文件顺序投影');
    assert.equal(texts.includes('被撤销的回答'), false, '被撤销/分叉轮次必须隐藏');
  } finally {
    t.cleanup();
  }
});

test('pi: 正常单链会话能解出（id/cwd/起止/标题/全部消息）', () => {
  const t = tempDir();
  try {
    const root = t.path('.pi');
    const file = t.write(
      '.pi/agent/sessions/proj/20261105_linear.jsonl',
      jsonl(
        header({ id: 'linear', cwd: '/work/linear' }),
        msg('a1', null, 'user', '把 README 补一下', 1),
        msg('a2', 'a1', 'assistant', '好的', 2),
        msg('a3', 'a2', 'user', '再补一节', 3),
        msg('a4', 'a3', 'assistant', '完成', 4)
      )
    );

    const s = scanner.parse(file);
    assert.ok(s);
    assert.equal(s.id, 'linear');
    assert.equal(s.project, '/work/linear');
    assert.equal(s.title, '把 README 补一下');
    assert.equal(s.start.getUTCFullYear(), 2026);
    assert.equal(s.end.getUTCFullYear(), 2026);
    assert.ok(s.end >= s.start);

    const msgs = scanner.readMessages(s, { roots: [root] });
    assert.deepEqual(textsOf(msgs), ['把 README 补一下', '好的', '再补一节', '完成']);
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  } finally {
    t.cleanup();
  }
});

test('pi: 会话树成环不死循环，停在可读主干', () => {
  const t = tempDir();
  try {
    const root = t.path('.pi');
    const file = t.write(
      '.pi/agent/sessions/cycle.jsonl',
      jsonl(
        header({ id: 'cycle' }),
        msg('a', 'b', 'user', 'a', 1),
        msg('b', 'a', 'assistant', 'b', 2) // a <-> b 成环
      )
    );

    const s = scanner.parse(file);
    assert.ok(s);
    const texts = textsOf(scanner.readMessages(s, { roots: [root] }));
    assert.deepEqual(texts, ['a', 'b'], '遇环停止遍历，仍输出能确定的主干、不挂死');
  } finally {
    t.cleanup();
  }
});

test('pi: 重复 id 用最新、坏行跳过、version<2 走 legacy 线性链', () => {
  const t = tempDir();
  try {
    const root = t.path('.pi');
    const dup = t.write(
      '.pi/agent/sessions/dup.jsonl',
      jsonl(
        header({ id: 'dup' }),
        msg('u1', null, 'user', 'root', 1),
        msg('dup', 'u1', 'assistant', 'stale', 2),
        msg('dup', 'u1', 'assistant', 'latest', 3) // 同 id，最后一个胜出
      ) +
        '{not valid json\n' + // 坏行：跳过，不放弃整场会话
        line(msg('u2', 'dup', 'user', '坏行之后还在', 4))
    );
    const s1 = scanner.parse(dup);
    assert.ok(s1);
    assert.deepEqual(
      textsOf(scanner.readMessages(s1, { roots: [root] })),
      ['root', 'latest', '坏行之后还在'],
      '重复 id 取最新、坏 JSON 行跳过且后续内容不丢'
    );

    // version < 2：没有 id/parentId，entry_identity 用 legacy-N 串成线性链
    const legacy = t.write(
      '.pi/agent/sessions/legacy.jsonl',
      jsonl(
        { type: 'session', version: 1, id: 'legacy', cwd: '/work/legacy', timestamp: '2026-11-05T00:00:00.000Z' },
        { type: 'message', timestamp: T(1), message: { role: 'user', content: '老格式提问' } },
        { type: 'message', timestamp: T(2), message: { role: 'assistant', content: '老格式回答' } }
      )
    );
    const s2 = scanner.parse(legacy);
    assert.ok(s2, 'version 1 也要能解出');
    assert.deepEqual(textsOf(scanner.readMessages(s2, { roots: [root] })), [
      '老格式提问',
      '老格式回答',
    ]);
  } finally {
    t.cleanup();
  }
});

test('pi: message.timestamp 毫秒不当成秒、网关 provider 当普通消息但不当成本来源', () => {
  const t = tempDir();
  try {
    const root = t.path('.pi');
    const file = t.write(
      '.pi/agent/sessions/gw.jsonl',
      jsonl(
        header({ id: 'gw' }),
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          message: { role: 'user', content: [{ type: 'text', text: '网关问题' }], timestamp: 1793836801000 },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '网关回答' }],
            provider: 'magpie',
            model: 'demo-model',
            usage: { input: 1, output: 2 },
            responseId: 'r1',
            durationMs: 12,
          },
        }
      )
    );

    const s = scanner.parse(file);
    assert.ok(s);
    assert.equal(s.start.getUTCFullYear(), 2026, '毫秒时间戳不能被当秒（否则掉到 1970）');
    const msgs = scanner.readMessages(s, { roots: [root] });
    assert.deepEqual(textsOf(msgs), ['网关问题', '网关回答'], '网关 provider 的消息照常进正文');
    const raw = JSON.stringify(msgs);
    assert.equal(raw.includes('magpie'), false, 'provider/usage 不写进消息模型');
    assert.equal(raw.includes('usage'), false, '档案馆只读，不计成本');
    assert.equal(raw.includes('responseId'), false);
  } finally {
    t.cleanup();
  }
});

test('pi: structureSpec 描述应用根下的形状，discoverWithin 纯函数，ctx.roots 不被误杀', () => {
  const t = tempDir();
  try {
    const root = t.path('.pi');
    t.write(
      '.pi/agent/sessions/proj/20261105_explicit.jsonl',
      jsonl(header({ id: 'explicit' }), msg('u1', null, 'user', '显式数据源里的第一句', 1))
    );
    t.write('decoy/random.jsonl', line({ hello: 'world' })); // 一堆无关 .jsonl 的 decoy

    const spec = scanner.structureSpec;
    assert.equal(spec.agent, 'pi');
    assert.deepEqual(spec.rootAnchor, { from: 'agent', up: 1, allowSelf: true }, '上溯到 .pi 应用根');
    assert.deepEqual(spec.dataPaths, ['agent/sessions']);
    assert.deepEqual(spec.dirHints, ['.pi'], 'pi/omp 同构，dirHints 是消歧唯一依据');
    assert.equal(spec.minScore, 4);
    assert.ok(
      spec.probes.some((p) => p.weight >= 4 && String(p.glob).includes('agent/sessions')),
      '强特征是真实会话文件'
    );
    assert.ok(
      spec.probes.every((p) => !('path' in p) || !String(p.path).startsWith('/')),
      'probes 都是相对应用根'
    );
    assert.equal(typeof scanner.discoverWithin, 'function', 'structureSpec 与 discoverWithin 必须成对加');

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1, '符合形状的目录只解出会话文件');
    assert.ok(files[0].endsWith('.jsonl'));
    assert.deepEqual(
      scanner.discoverWithin([t.path('decoy')], {}),
      [],
      '无关 .jsonl 的 decoy 不被当会话根'
    );

    const s = scanner.parse(files[0]);
    assert.equal(s.title, '显式数据源里的第一句');
    assert.ok(scanner.readMessages(s, { roots: [root] }).length >= 1, 'ctx.roots 下外部根不被 assertUnderAny 误杀');
  } finally {
    t.cleanup();
  }
});

test('pi: 本机 discover() 默认根 + 绝对 sessionDir 覆盖，相对 sessionDir 不全局枚举', async () => {
  const box = sandbox();
  try {
    const def = box.write(
      '.pi/agent/sessions/proj/20261105_def.jsonl',
      jsonl(header({ id: 'def' }), msg('u1', null, 'user', '默认根', 1))
    );
    const absDir = box.path('custom-sessions');
    const abs = box.write(
      'custom-sessions/20261105_abs.jsonl',
      jsonl(header({ id: 'abs' }), msg('u1', null, 'user', '绝对覆盖', 1))
    );

    await box.run(() =>
      withEnv(CLEAN_ENV, () => {
        const files = scanner.discover();
        assert.ok(files.includes(def), '默认 ~/.pi/agent/sessions 要被发现');
        assert.ok(files.every((f) => f.startsWith(box.home)), '不能漏进真实机器的路径');
      })
    );

    await box.run(() =>
      withEnv({ ...CLEAN_ENV, PI_CODING_AGENT_SESSION_DIR: absDir }, () => {
        const files = scanner.discover();
        assert.ok(files.includes(abs), '绝对路径的 PI_CODING_AGENT_SESSION_DIR 要被收');
      })
    );

    // 相对 sessionDir 明确不可全局枚举：不能把它 resolve 到 cwd 后当根
    await box.run(() =>
      withEnv({ ...CLEAN_ENV, PI_CODING_AGENT_SESSION_DIR: 'relative/sessions' }, () => {
        const resolved = path.resolve('relative/sessions');
        assert.equal(
          scanner.candidateRoots().some((r) => r.toLowerCase() === resolved.toLowerCase()),
          false,
          '相对 sessionDir 不能被全局枚举'
        );
      })
    );
  } finally {
    box.cleanup();
  }
});
