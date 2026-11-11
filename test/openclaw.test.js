import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tempDir, withEnv } from './helpers.js';

/**
 * OpenClaw 扫描器的格式契约。
 *
 * 锁的是上游规格里的形状（不是当前实现）：
 *  1. `type=session` 给 id/cwd/timestamp，`type=message` 给 role/content，
 *     一行一事件、按文件顺序全取、**没有树形分支/活动分支投影**；
 *  2. 标题 `sessions.json:displayName` 优先于首条 user；
 *  3. 网关在文本尾部追加的 `\n[message_id: …]` 注入，标题和正文都要剥掉；
 *  4. `.openclaw` 与变体 `.openclaw-autoclaw` 两个候选根都认；
 *  5. `structureSpec` 相对应用根，`discoverWithin(roots)` 纯函数，
 *     `ctx.roots` 让外部备份的文件不被 assertUnderAny 误杀。
 *
 * 全部用 sandbox/tempDir 自造合成样本，不碰本机真实目录。
 */

const scanner = await import('../src/scanners/openclaw.js');

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

const CLEAN_ENV = {
  OPENCLAW_CONFIG_DIR: null,
  openclaw_config_dir: null,
};
async function inBox(box, fn) {
  return withEnv(CLEAN_ENV, () => box.run(fn));
}

const TS0 = '2026-11-05T06:00:00.000Z';
function sessionHeader(id, cwd) {
  return { type: 'session', id, cwd, timestamp: TS0 };
}
function userMsg(text, ts, extra = {}) {
  return { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts, ...extra };
}
function assistantMsg(text, ts, extra = {}) {
  return { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts, ...extra };
}
function textsOf(messages) {
  return messages.flatMap((m) => m.parts).filter((p) => p.kind === 'text').map((p) => p.text);
}

test('openclaw: 真实形状解出会话，标题取真人第一句，项目取 cwd，剥 message_id 尾部', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.openclaw/agents/main/sessions/oc-1.jsonl',
      jsonl(
        sessionHeader('oc-1', 'E:\\demo-project'),
        userMsg('第一句真人输入\n[message_id: m-123]', '2026-11-05T06:00:01.000Z'),
        assistantMsg('好的，我来跑\n[message_id: m-124]', '2026-11-05T06:00:02.000Z')
      )
    );
    await inBox(box, () => {
      const files = scanner.discover();
      assert.ok(files.includes(file), 'agents/*/sessions/*.jsonl 要被发现');

      const s = scanner.parse(file);
      assert.ok(s);
      assert.equal(s.agent, 'openclaw');
      assert.equal(s.title, '第一句真人输入', '标题是剥掉网关注入后的第一句真人输入');
      assert.equal(s.project, 'E:/demo-project', '项目取 type=session 的 cwd');
      assert.equal(s.start.toISOString(), TS0);

      const texts = textsOf(scanner.readMessages(s));
      assert.deepEqual(texts, ['第一句真人输入', '好的，我来跑'], '正文里的 [message_id: …] 都要剥掉');
      assert.ok(!texts.some((t) => t.includes('message_id')), '网关注入不能留在正文里');
    });
  } finally {
    box.cleanup();
  }
});

test('openclaw: sessions.json 的 displayName 优先于首条 user', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.openclaw/agents/main/sessions/oc-2.jsonl',
      jsonl(
        sessionHeader('oc-2', 'E:\\demo-project'),
        userMsg('这是一句很长很长的用户提问', '2026-11-05T06:00:01.000Z'),
        assistantMsg('回答', '2026-11-05T06:00:02.000Z')
      )
    );
    box.write('.openclaw/agents/main/sessions.json', JSON.stringify({ 'oc-2': { displayName: '网关里起的标题' } }));
    await inBox(box, () => {
      assert.equal(scanner.parse(file).title, '网关里起的标题', 'displayName 优先于首条 user');
    });
  } finally {
    box.cleanup();
  }
});

test('openclaw: .openclaw-autoclaw 变体根也纳入候选', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.openclaw-autoclaw/agents/alpha/sessions/a1.jsonl',
      jsonl(sessionHeader('a1', 'E:\\p'), userMsg('变体里的第一句', '2026-11-05T06:00:01.000Z'))
    );
    await inBox(box, () => {
      assert.ok(
        scanner.candidateRoots().some((r) => r.includes('.openclaw-autoclaw')),
        'candidateRoots 要声明变体根，否则 doctor 会自相矛盾'
      );
      assert.ok(scanner.discover().includes(file), '变体根里的会话要被发现');
      assert.equal(scanner.parse(file).title, '变体里的第一句');
    });
  } finally {
    box.cleanup();
  }
});

test('openclaw: 无树形分支，带 parentId 的消息按文件顺序全取', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.openclaw/agents/main/sessions/oc-3.jsonl',
      jsonl(
        sessionHeader('oc-3', 'E:\\demo-project'),
        { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: '第一句' }, timestamp: '2026-11-05T06:00:01.000Z' },
        { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: '回答一' }, timestamp: '2026-11-05T06:00:02.000Z' },
        { type: 'message', id: 'e3', parentId: 'e1', message: { role: 'assistant', content: '另一分支的回答' }, timestamp: '2026-11-05T06:00:03.000Z' }
      )
    );
    await inBox(box, () => {
      const texts = textsOf(scanner.readMessages(scanner.parse(file)));
      assert.deepEqual(texts, ['第一句', '回答一', '另一分支的回答'], '不做活动分支投影，按文件顺序全取');
    });
  } finally {
    box.cleanup();
  }
});

test('openclaw: structureSpec 描述应用根下的形状，discoverWithin 纯函数，ctx.roots 不被误杀', async () => {
  const t = tempDir();
  try {
    const root = t.path('.openclaw');
    t.write(
      '.openclaw/agents/main/sessions/oc-a.jsonl',
      jsonl(sessionHeader('oc-a', 'E:\\demo'), userMsg('显式源里的第一句', '2026-11-05T06:00:01.000Z'))
    );
    t.write('decoy/random.jsonl', line({ hello: 'world' }));

    const spec = scanner.structureSpec;
    assert.equal(spec.agent, 'openclaw');
    assert.deepEqual(spec.rootAnchor, { from: 'agents', up: 1, allowSelf: true }, '上溯到应用根');
    assert.deepEqual(spec.dataPaths, ['agents']);
    assert.ok(spec.dirHints.includes('.openclaw'));
    assert.ok(spec.dirHints.includes('.openclaw-autoclaw'));
    assert.equal(spec.minScore, 3);
    assert.ok(spec.probes.some((p) => p.weight >= 4 && String(p.glob).includes('sessions/*.jsonl')));

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('oc-a.jsonl'));
    assert.deepEqual(scanner.discoverWithin([t.path('decoy')], {}), [], '无关 .jsonl 的 decoy 不被当会话');

    const s = scanner.parse(files[0]);
    assert.equal(s.title, '显式源里的第一句');
    assert.ok(scanner.readMessages(s, { roots: [root] }).length >= 1, 'ctx.roots 让外部根不被误杀');
  } finally {
    t.cleanup();
  }
});

test('openclaw: 文件读不到时报错，不假装成空会话', async () => {
  const t = tempDir();
  try {
    const root = t.path('.openclaw');
    t.mkdir('.openclaw/agents/main/sessions');
    assert.throws(() =>
      scanner.readMessages({ source: t.path('.openclaw/agents/main/sessions/missing.jsonl') }, { roots: [root] })
    );
  } finally {
    t.cleanup();
  }
});
