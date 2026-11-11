import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tempDir, withEnv } from './helpers.js';

/**
 * Oh My Pi（omp）扫描器的格式契约（合成样本，不碰本机真实数据）。
 *
 * omp 与 Pi 同构、复用同一份会话树解析器，差异用 Dialect 行为位表达。
 * 这里锁的是**会静默出错的几家差异**：
 *
 *   1. 首行 `{"type":"title"}` 标题槽 / `title_change` 逐次覆盖 → 标题取槽里的值
 *      （Pi 取第一句真人输入，omp 优先显式标题槽）。
 *   2. `model_change` 单串 `provider/id`、额外的 `model_usage` entries 都是
 *      运行时记录，不冒充对话消息。
 *   3. 会话树活动分支投影与 Pi 一致：撤销分支不进正文。
 *   4. structureSpec 的 dirHints 必须写 `.omp`、不能与 pi 的 `.pi` 相交——
 *      probes 同形，宿主 identify() 靠唯一 dirHintMatch 消歧，绝不由分数猜。
 */

const scanner = await import('../src/scanners/omp.js');
const piSpec = (await import('../src/scanners/pi.js')).structureSpec;

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');
const T = (sec) => `2026-11-05T00:00:${String(sec).padStart(2, '0')}.000Z`;

const header = (extra = {}) => ({
  type: 'session',
  version: 3,
  id: 'omp-sess',
  cwd: '/work/omp-demo',
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

const textsOf = (msgs) =>
  msgs.map((m) => m.parts.map((p) => p.text || '').join('')).filter(Boolean);

const CLEAN_ENV = {
  PI_CODING_AGENT_SESSION_DIR: null,
  PI_CONFIG_DIR: null,
  PI_CODING_AGENT_DIR: null,
  OMP_DATA_DIR: null,
  OMP_PROFILE: null,
  PI_PROFILE: null,
};

test('omp: 标题取 {"type":"title"} 槽（Dialect 差异），运行时记录不冒充对话', () => {
  const t = tempDir();
  try {
    const root = t.path('.omp');
    const file = t.write(
      '.omp/agent/sessions/20261105_omp-title.jsonl',
      jsonl(
        { type: 'title', title: 'Oh My Pi 演示会话' }, // 首行标题槽（header 之前）
        header({ id: 'omp-title' }),
        msg('u1', null, 'user', 'omp 的第一句话', 1),
        { type: 'model_change', id: 'm1', parentId: 'u1', timestamp: T(2), model: 'anthropic/demo-model' },
        msg('a1', 'm1', 'assistant', 'omp 的回答', 3, { provider: 'anthropic', model: 'demo-model' })
      )
    );

    const s = scanner.parse(file);
    assert.ok(s);
    assert.equal(s.agent, 'omp');
    assert.equal(s.title, 'Oh My Pi 演示会话', '标题与设计一致：取自 type:title 标题槽');
    assert.equal(s.project, '/work/omp-demo');

    const msgs = scanner.readMessages(s, { roots: [root] });
    assert.deepEqual(textsOf(msgs), ['omp 的第一句话', 'omp 的回答'], 'model_change 不进正文');
  } finally {
    t.cleanup();
  }
});

test('omp: 复用 pi 的会话树投影——撤销分支同样隐藏', () => {
  const t = tempDir();
  try {
    const root = t.path('.omp');
    const file = t.write(
      '.omp/agent/sessions/20261105_omp-tree.jsonl',
      jsonl(
        header({ id: 'omp-tree' }),
        msg('u1', null, 'user', '第一句提问', 1),
        msg('dead', 'u1', 'assistant', '被撤销的回答', 2),
        msg('u2', 'u1', 'user', '换个问法', 3),
        msg('live', 'u2', 'assistant', '在用的回答', 4)
      )
    );
    const s = scanner.parse(file);
    const texts = textsOf(scanner.readMessages(s, { roots: [root] }));
    assert.deepEqual(texts, ['第一句提问', '换个问法', '在用的回答']);
    assert.equal(texts.includes('被撤销的回答'), false, '复用 pi 解析器后，撤销轮次照样隐藏');
  } finally {
    t.cleanup();
  }
});

test('omp: title_change 覆盖、单串 model_change 与 model_usage 都不当对话', () => {
  const t = tempDir();
  try {
    const root = t.path('.omp');
    const file = t.write(
      '.omp/agent/sessions/20261105_omp-runtime.jsonl',
      jsonl(
        header({ id: 'omp-runtime', title: 'header 里的旧标题' }),
        msg('u1', null, 'user', '提问', 1),
        { type: 'model_change', id: 'm1', parentId: 'u1', timestamp: T(2), model: 'provider/model-x' },
        { type: 'title_change', id: 't1', parentId: 'm1', timestamp: T(2), title: '改过的标题' },
        { type: 'model_usage', id: 'mu1', parentId: 't1', timestamp: T(2), usage: { input: 1, output: 2 } },
        msg('a1', 'mu1', 'assistant', '回答', 3)
      )
    );
    const s = scanner.parse(file);
    assert.equal(s.title, '改过的标题', 'title_change 取最后一个标题槽，覆盖 header.title');
    const msgs = scanner.readMessages(s, { roots: [root] });
    assert.deepEqual(textsOf(msgs), ['提问', '回答'], '运行时记录参与树连通但不产出对话消息');
  } finally {
    t.cleanup();
  }
});

test('omp: structureSpec 靠 dirHints 与 pi 消歧，discoverWithin 纯函数，ctx.roots 不被误杀', () => {
  const t = tempDir();
  try {
    const root = t.path('.omp');
    t.write(
      '.omp/agent/sessions/20261105_explicit.jsonl',
      jsonl(header({ id: 'explicit' }), msg('u1', null, 'user', '显式数据源里的第一句', 1))
    );
    t.write('decoy/random.jsonl', line({ hello: 'world' }));

    const spec = scanner.structureSpec;
    assert.equal(spec.agent, 'omp');
    assert.deepEqual(spec.rootAnchor, { from: 'agent', up: 1, allowSelf: true }, '上溯到 .omp 应用根');
    assert.deepEqual(spec.dataPaths, ['agent/sessions']);
    assert.deepEqual(spec.dirHints, ['.omp'], 'dirHints 必须写对');
    assert.ok(!spec.dirHints.includes('.pi'), '不能写 .pi，否则同构消歧失效');
    assert.ok(
      !spec.dirHints.some((h) => piSpec.dirHints.includes(h)),
      '与 pi 的 dirHints 不相交，宿主靠唯一 dirHintMatch 消歧'
    );
    const strong = (s) => s.probes.find((p) => p.weight >= 4);
    assert.equal(strong(spec).glob, strong(piSpec).glob, 'probes 与 pi 同形（同构）');
    assert.equal(typeof scanner.discoverWithin, 'function', 'structureSpec 与 discoverWithin 必须成对加');

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.jsonl'));
    assert.deepEqual(scanner.discoverWithin([t.path('decoy')], {}), [], '无关 .jsonl 的 decoy 不被当会话');

    const s = scanner.parse(files[0]);
    assert.ok(scanner.readMessages(s, { roots: [root] }).length >= 1);
  } finally {
    t.cleanup();
  }
});

test('omp: 本机 discover() 默认根 ~/.omp/agent 能发现会话', async () => {
  const box = sandbox();
  try {
    const def = box.write(
      '.omp/agent/sessions/20261105_def.jsonl',
      jsonl(header({ id: 'def' }), msg('u1', null, 'user', '默认根', 1))
    );
    await box.run(() =>
      withEnv(CLEAN_ENV, () => {
        const files = scanner.discover();
        assert.ok(files.includes(def), '默认 ~/.omp/agent/sessions 要被发现');
        assert.ok(files.every((f) => f.startsWith(box.home)), '不能漏进真实机器的路径');
      })
    );
  } finally {
    box.cleanup();
  }
});
