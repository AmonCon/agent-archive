import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tempDir, withEnv } from './helpers.js';

/**
 * Cline 扫描器的格式契约（合成样本，不碰本机真实 ~/.cline）。
 *
 * 锁的是 MAGPIE cline.go 里验证过的**会静默出错的事实形状**：
 *
 *   1. `<id>.json` manifest + `<id>.messages.json` 正文，整份读（含第一条）。
 *   2. `.messages.json` 是**整体重写、非追加** → 不能 tail 续读：整份重写后
 *      必须读到新内容，不能残留旧内容。
 *   3. `metadata.fork.forkedAt` → fork 只算 forkedAt 之后的消息，父会话副本
 *      不能被重复记。
 *   4. 子代理 `<agent id>.messages.json` 标 kind=subagent + parent。
 *   5. `ts` 是毫秒（当秒会全掉到 1970）。
 *   6. structureSpec 相对应用根 .cline、discoverWithin 纯函数、ctx.roots 不误杀；
 *      四段路径链按优先级。
 */

const scanner = await import('../src/scanners/cline.js');

const BASE = 1793836800000; // 2026-11-05T00:00:00Z

const manifest = (extra = {}) =>
  JSON.stringify({
    session_id: 'demo-session',
    started_at: '2026-11-05T00:00:00.000Z',
    cwd: '/work/cline-demo',
    prompt: '<user_input mode="act">演示：帮我重构这个函数</user_input>',
    metadata: { title: 'Cline 演示会话' },
    ...extra,
  });

const doc = (...msgs) => JSON.stringify({ messages: msgs });
const userMsg = (text, ts) => ({ role: 'user', ts, content: [{ type: 'text', text }] });
const asstMsg = (text, ts) => ({
  role: 'assistant',
  ts,
  content: [{ type: 'text', text }],
  modelInfo: { id: 'demo-model' },
  metrics: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const textsOf = (msgs) =>
  msgs.map((m) => m.parts.map((p) => p.text || '').join('')).filter(Boolean);

const CLEAN_ENV = {
  CLINE_SESSION_DATA_DIR: null,
  CLINE_DATA_DIR: null,
  CLINE_DIR: null,
  CLINE_HOME: null,
};

test('cline: 整份读 manifest + messages，会话元数据与全部消息（含第一条）', () => {
  const t = tempDir();
  try {
    const root = t.path('.cline');
    const dir = '.cline/data/sessions/demo-session';
    t.write(`${dir}/demo-session.json`, manifest());
    t.write(
      `${dir}/demo-session.messages.json`,
      doc(
        userMsg('演示：帮我重构这个函数', BASE + 1000),
        asstMsg('好的，我看一下', BASE + 2000),
        userMsg('再改一版', BASE + 3000),
        asstMsg('改好了', BASE + 4000)
      )
    );

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1);
    const s = scanner.parse(files[0]);
    assert.ok(s);
    assert.equal(s.agent, 'cline');
    assert.equal(s.id, 'demo-session');
    assert.equal(s.project, '/work/cline-demo');
    assert.equal(s.title, '演示：帮我重构这个函数', '首 prompt 按标签形状剥包装');
    assert.equal(s.start.getUTCFullYear(), 2026);
    assert.equal(s.end.getUTCFullYear(), 2026);
    assert.ok(s.end >= s.start);
    assert.equal(s.kind, 'main');
    assert.equal(s.parent, null);

    const msgs = scanner.readMessages(s, { roots: [root] });
    assert.equal(msgs.length, 4, '整份读：所有消息都在（含第一条，不能只读尾窗）');
    assert.deepEqual(textsOf(msgs), ['演示：帮我重构这个函数', '好的，我看一下', '再改一版', '改好了']);
    assert.equal(msgs[0].ts.getUTCFullYear(), 2026, 'ts 是毫秒，当秒会掉到 1970');
  } finally {
    t.cleanup();
  }
});

test('cline: messages.json 整体重写——不能 tail 续读到旧内容', () => {
  const t = tempDir();
  try {
    const root = t.path('.cline');
    const mRel = '.cline/data/sessions/rewrite/rewrite.messages.json';
    t.write('.cline/data/sessions/rewrite/rewrite.json', manifest({ session_id: 'rewrite' }));

    // 第一次：3 条
    t.write(
      mRel,
      doc(userMsg('第一版', BASE + 1000), asstMsg('回答一', BASE + 2000), userMsg('第二版', BASE + 3000))
    );
    const s1 = scanner.parse(t.path(mRel));
    assert.equal(scanner.readMessages(s1, { roots: [root] }).length, 3);

    // 整体重写成 2 条（不是追加）。tail 续读会残留旧内容 / 漏掉新开头。
    t.write(mRel, doc(userMsg('重写后的唯一提问', BASE + 5000), asstMsg('重写后的回答', BASE + 6000)));
    const s2 = scanner.parse(t.path(mRel));
    const texts = textsOf(scanner.readMessages(s2, { roots: [root] }));
    assert.deepEqual(texts, ['重写后的唯一提问', '重写后的回答'], '必须整份读，不能按行增量');
  } finally {
    t.cleanup();
  }
});

test('cline: fork 只算 forkedAt 之后的消息，标题取 metadata.title', () => {
  const t = tempDir();
  try {
    const root = t.path('.cline');
    const dir = '.cline/data/sessions/fork';
    t.write(
      `${dir}/fork.json`,
      JSON.stringify({
        session_id: 'fork',
        started_at: '2026-11-05T00:00:00.000Z',
        cwd: '/work/fork',
        metadata: { title: '分叉会话', fork: { forkedAt: '2026-11-05T00:00:02.000Z' } },
      })
    );
    t.write(
      `${dir}/fork.messages.json`,
      doc(
        userMsg('父会话的旧消息', BASE), // < forkedAt，复制自父，要跳过
        asstMsg('父会话的旧回答', BASE + 1000),
        userMsg('分叉后的新提问', BASE + 2000), // >= forkedAt
        asstMsg('分叉后的新回答', BASE + 3000)
      )
    );

    const files = scanner.discoverWithin([root], {});
    const s = scanner.parse(files[0]);
    assert.equal(s.title, '分叉会话', '无 prompt 时取 metadata.title');
    const texts = textsOf(scanner.readMessages(s, { roots: [root] }));
    assert.deepEqual(texts, ['分叉后的新提问', '分叉后的新回答'], 'fork 只算 forkedAt 之后');
    assert.equal(s.start.getUTCFullYear(), 2026);
  } finally {
    t.cleanup();
  }
});

test('cline: 子代理 .messages.json 标 kind=subagent + parent', () => {
  const t = tempDir();
  try {
    const root = t.path('.cline');
    const dir = '.cline/data/sessions/sub';
    t.write(`${dir}/sub.json`, manifest({ session_id: 'sub' }));
    t.write(`${dir}/sub.messages.json`, doc(userMsg('主会话', BASE + 1000), asstMsg('主回答', BASE + 2000)));
    t.write(
      `${dir}/agent-77.messages.json`,
      doc(userMsg('子代理任务', BASE + 3000), asstMsg('子代理回答', BASE + 4000))
    );

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 2, '主会话与子代理转录都采集');
    const sessions = files.map((f) => scanner.parse(f));
    const main = sessions.find((s) => s.kind === 'main');
    const sub = sessions.find((s) => s.kind === 'subagent');
    assert.ok(main && sub);
    assert.equal(main.id, 'sub');
    assert.equal(sub.parent, 'sub');
    assert.ok(sub.id.includes('agent-77'), '子代理 id 要能认出是哪一支');
    assert.ok(scanner.readMessages(sub, { roots: [root] }).length >= 1, '子代理正文也读得出');
  } finally {
    t.cleanup();
  }
});

test('cline: structureSpec 描述应用根下的形状，discoverWithin 纯函数，ctx.roots 不被误杀', () => {
  const t = tempDir();
  try {
    const root = t.path('.cline');
    t.write('.cline/data/sessions/explicit/explicit.messages.json', doc(userMsg('显式源里的第一句', BASE + 1000)));
    t.write('decoy/random.json', JSON.stringify({ hello: 'world' }));

    const spec = scanner.structureSpec;
    assert.equal(spec.agent, 'cline');
    assert.deepEqual(spec.rootAnchor, { from: 'data/sessions', up: 2, allowSelf: true }, '上溯到 .cline 应用根');
    assert.deepEqual(spec.dataPaths, ['data/sessions']);
    assert.deepEqual(spec.dirHints, ['.cline']);
    assert.equal(spec.minScore, 5);
    assert.ok(
      spec.probes.some((p) => p.weight >= 5 && String(p.glob).includes('.messages.json')),
      '强特征是真实 .messages.json'
    );
    assert.ok(spec.probes.every((p) => !('path' in p) || !String(p.path).startsWith('/')), 'probes 都相对应用根');
    assert.equal(typeof scanner.discoverWithin, 'function', 'structureSpec 与 discoverWithin 必须成对加');

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.messages.json'));
    assert.deepEqual(scanner.discoverWithin([t.path('decoy')], {}), [], '无关 .json 的 decoy 不被当会话');

    const s = scanner.parse(files[0]);
    assert.ok(scanner.readMessages(s, { roots: [root] }).length >= 1, 'ctx.roots 下外部根不被误杀');
  } finally {
    t.cleanup();
  }
});

test('cline: 四段路径链按优先级生效（默认 / CLINE_SESSION_DATA_DIR / CLINE_DIR）', async () => {
  const box = sandbox();
  try {
    const def = box.write(
      '.cline/data/sessions/def/def.messages.json',
      doc(userMsg('默认根', BASE + 1000))
    );
    const custom = box.path('custom-sessions');
    const top = box.write('custom-sessions/a/a.messages.json', doc(userMsg('一级覆盖', BASE + 1000)));
    const alt = box.path('alt-cline');
    const third = box.write(
      'alt-cline/data/sessions/c/c.messages.json',
      doc(userMsg('三级覆盖', BASE + 1000))
    );

    await box.run(() =>
      withEnv(CLEAN_ENV, () => {
        const files = scanner.discover();
        assert.ok(files.includes(def), '默认 ~/.cline/data/sessions 要被发现');
        assert.ok(files.every((f) => f.startsWith(box.home)), '不能漏进真实机器的路径');
      })
    );

    await box.run(() =>
      withEnv({ ...CLEAN_ENV, CLINE_SESSION_DATA_DIR: custom }, () => {
        const roots = scanner.candidateRoots();
        assert.ok(roots.includes(custom), '最高优先级的 CLINE_SESSION_DATA_DIR 要进候选根');
        assert.equal(
          roots.includes(box.path('.cline', 'data', 'sessions')),
          false,
          '命中最高优先级后不再用默认 sessions 目录'
        );
        assert.ok(scanner.discover().includes(top), '一级覆盖里的会话要被发现');
      })
    );

    await box.run(() =>
      withEnv({ ...CLEAN_ENV, CLINE_DIR: alt }, () => {
        assert.ok(scanner.discover().includes(third), '$CLINE_DIR/data/sessions 要被发现');
      })
    );
  } finally {
    box.cleanup();
  }
});
