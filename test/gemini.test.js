import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tempDir, withEnv } from './helpers.js';

/**
 * Gemini CLI 扫描器的格式契约。
 *
 * 锁的是上游规格里的形状（不是当前实现）：
 *  1. `.jsonl` 是回放日志，不是普通 JSONL：带 id 原位 upsert、`$set` 合并/
 *     整体替换 messages、`$rewindTo` 删该条及之后；
 *  2. 同名 `.json`（旧快照）与 `.jsonl` 共存时**只认 .jsonl**；
 *  3. 旧 `.json` 单对象（MAGPIE 的 `chats/*.json` 写法）也要能解；
 *  4. 标题跳过 `/`、`?` 命令与 `<session_context>`/`<hook_context>` 注入，
 *     取第一句真人输入；项目只从 `.project_root` 读，读不到不猜；
 *  5. `structureSpec` 相对应用根 `.gemini`，`discoverWithin(roots)` 是纯函数，
 *     `ctx.roots` 让外部备份的文件不被 assertUnderAny 误杀。
 *
 * 所有数据都是 sandbox/tempDir 里的最小合成样本，不碰本机真实目录。
 */

const scanner = await import('../src/scanners/gemini.js');

const line = (o) => JSON.stringify(o) + '\n';
const jsonl = (...objs) => objs.map(line).join('');

// 测试机可能残留这些覆盖变量，会绕过 sandbox 的假家目录，显式清掉
const CLEAN_ENV = {
  GEMINI_CONFIG_DIR: null,
  gemini_config_dir: null,
  GEMINI_CLI_HOME: null,
};
async function inBox(box, fn) {
  return withEnv(CLEAN_ENV, () => box.run(fn));
}

const START = '2026-11-05T02:00:00.000Z';
const END = '2026-11-05T02:05:00.000Z';
function header(extra = {}) {
  return { sessionId: 'ses-gemini-1', startTime: START, lastUpdated: END, messages: [], ...extra };
}
function textsOf(messages) {
  return messages.flatMap((m) => m.parts).filter((p) => p.kind === 'text').map((p) => p.text);
}

test('gemini: 回放日志解出会话，标题跳过注入/斜杠命令取第一句真人输入，项目取 .project_root', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.gemini/tmp/abc123/chats/session-one.jsonl',
      jsonl(
        header(),
        { id: 'm1', type: 'user', content: '/help' },
        { id: 'm2', type: 'user', content: '<session_context>\nOS: win32\nShell: bash\n</session_context>\n' },
        { id: 'm3', type: 'user', content: '帮我把这个仓库的测试跑起来', timestamp: '2026-11-05T02:01:00.000Z' },
        { id: 'm4', type: 'gemini', content: '好的，先看 package.json', timestamp: '2026-11-05T02:02:00.000Z' }
      )
    );
    box.write('.gemini/tmp/abc123/.project_root', 'E:\\demo-project');

    await inBox(box, () => {
      const files = scanner.discover();
      assert.ok(files.includes(file), 'chats 下的 session-*.jsonl 要被发现');

      const s = scanner.parse(file);
      assert.ok(s);
      assert.equal(s.agent, 'gemini');
      assert.equal(s.title, '帮我把这个仓库的测试跑起来', '标题不能是 /help 或 session_context 注入');
      assert.equal(s.project, 'E:/demo-project', '项目只从 .project_root 读');
      assert.equal(s.start.toISOString(), START);
      assert.equal(s.end.toISOString(), END);

      const texts = textsOf(scanner.readMessages(s));
      assert.ok(texts.includes('帮我把这个仓库的测试跑起来'));
      assert.ok(!texts.some((t) => t.includes('OS: win32')), '注入上下文不进正文');
      assert.ok(!texts.some((t) => t.trim() === '/help'), '斜杠命令不进正文');
    });
  } finally {
    box.cleanup();
  }
});

test('gemini: $rewindTo 删该条及之后（回放日志不是普通 JSONL）', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.gemini/tmp/h1/chats/session-rewind.jsonl',
      jsonl(
        header({ sessionId: 'ses-2' }),
        { id: 'a1', type: 'user', content: '第一句真话' },
        { id: 'a2', type: 'gemini', content: '回答一' },
        { id: 'a3', type: 'user', content: '被撤销的追问' },
        { id: 'a4', type: 'gemini', content: '被撤销的回答' },
        { $rewindTo: 'a3' }
      )
    );
    await inBox(box, () => {
      const s = scanner.parse(file);
      assert.equal(s.title, '第一句真话');
      const texts = textsOf(scanner.readMessages(s));
      assert.deepEqual(texts, ['第一句真话', '回答一'], '$rewindTo 指向的那条及之后整段不该出现');
    });
  } finally {
    box.cleanup();
  }
});

test('gemini: 带 id 行原位覆盖，$set 合并顶层并整体替换 messages', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.gemini/tmp/h2/chats/session-set.jsonl',
      jsonl(
        header({ sessionId: 'ses-3' }),
        { id: 'b1', type: 'user', content: '旧版本提问' },
        { id: 'b2', type: 'gemini', content: '旧回答' },
        { id: 'b1', type: 'user', content: '覆盖后的提问' }, // 同 id 原位覆盖，不新增
        {
          $set: {
            lastUpdated: '2026-11-05T03:00:00.000Z',
            messages: [
              { id: 'c1', type: 'user', content: '整体替换后的第一句' },
              { id: 'c2', type: 'gemini', content: '新回答' },
            ],
          },
        }
      )
    );
    await inBox(box, () => {
      const s = scanner.parse(file);
      assert.equal(s.title, '整体替换后的第一句', '$set.messages 整体替换');
      assert.equal(s.end.toISOString(), '2026-11-05T03:00:00.000Z', '$set 其它字段合并进顶层');
      const texts = textsOf(scanner.readMessages(s));
      assert.deepEqual(texts, ['整体替换后的第一句', '新回答']);
    });
  } finally {
    box.cleanup();
  }
});

test('gemini: 同名 .json 与 .jsonl 共存只认 .jsonl', async () => {
  const box = sandbox();
  try {
    const jsonlFile = box.write(
      '.gemini/tmp/h3/chats/session-dup.jsonl',
      jsonl(header({ sessionId: 'new' }), { id: 'n1', type: 'user', content: '新日志里的第一句' })
    );
    box.write(
      '.gemini/tmp/h3/chats/session-dup.json',
      JSON.stringify({
        sessionId: 'old',
        startTime: START,
        lastUpdated: END,
        messages: [{ id: 'o1', type: 'user', content: '旧快照里已经撤销的话' }],
      })
    );
    await inBox(box, () => {
      const files = scanner.discover();
      const dup = files.filter((f) => f.includes('session-dup'));
      assert.equal(dup.length, 1, '同名只留一个文件');
      assert.ok(dup[0].endsWith('.jsonl'), '留下的是 .jsonl');
      const s = scanner.parse(jsonlFile);
      assert.equal(s.title, '新日志里的第一句');
      assert.ok(!JSON.stringify(scanner.readMessages(s)).includes('已经撤销'), '旧快照内容不能混进来');
    });
  } finally {
    box.cleanup();
  }
});

test('gemini: 旧 .json 单对象（MAGPIE 的 chats/*.json 写法）也能解', async () => {
  const box = sandbox();
  try {
    const file = box.write(
      '.gemini/tmp/h4/chats/legacy-chat.json',
      JSON.stringify({
        sessionId: 'legacy-1',
        startTime: START,
        lastUpdated: END,
        messages: [
          { id: 'l1', type: 'user', content: '旧格式里的问题' },
          { id: 'l2', type: 'gemini', content: '旧格式的回答' },
        ],
      })
    );
    box.write('.gemini/tmp/h4/.project_root', 'E:\\demo-project');
    await inBox(box, () => {
      const files = scanner.discover();
      assert.ok(files.includes(file), '不带 session- 前缀的 chats/*.json 也要认');
      const s = scanner.parse(file);
      assert.equal(s.title, '旧格式里的问题');
      assert.equal(s.project, 'E:/demo-project');
    });
  } finally {
    box.cleanup();
  }
});

test('gemini: structureSpec 描述应用根下的形状，discoverWithin 纯函数，ctx.roots 不被误杀', async () => {
  const t = tempDir();
  try {
    const root = t.path('.gemini');
    t.write(
      '.gemini/tmp/hashX/chats/session-a.jsonl',
      jsonl(header({ sessionId: 'a' }), { id: 'x1', type: 'user', content: '显式数据源里的第一句' })
    );
    t.write('.gemini/tmp/hashX/.project_root', 'E:\\demo');
    t.write('decoy/random.jsonl', line({ hello: 'world' }));

    const spec = scanner.structureSpec;
    assert.equal(spec.agent, 'gemini');
    assert.deepEqual(spec.rootAnchor, { from: 'tmp', up: 1 }, '上溯到 .gemini 应用根');
    assert.deepEqual(spec.dataPaths, ['tmp']);
    assert.ok(spec.dirHints.includes('.gemini'));
    assert.equal(spec.minScore, 3);
    assert.ok(
      spec.probes.some((p) => p.weight >= 4 && String(p.glob).includes('chats/session-')),
      '强特征是真实会话文件'
    );
    assert.ok(spec.probes.every((p) => !('path' in p) || !String(p.path).startsWith('/')), 'probes 都是相对应用根');

    const files = scanner.discoverWithin([root], {});
    assert.equal(files.length, 1, '符合形状的目录只解出会话文件');
    assert.ok(files[0].endsWith('session-a.jsonl'));
    assert.deepEqual(scanner.discoverWithin([t.path('decoy')], {}), [], '无关 .jsonl 的 decoy 不被当会话');

    // ctx.roots 优先：外部根的文件不被 assertUnderAny 误杀
    const s = scanner.parse(files[0]);
    assert.equal(s.title, '显式数据源里的第一句');
    assert.ok(scanner.readMessages(s, { roots: [root] }).length >= 1);
  } finally {
    t.cleanup();
  }
});

test('gemini: 文件读不到时报错，不假装成空会话', async () => {
  const t = tempDir();
  try {
    const root = t.path('.gemini');
    t.mkdir('.gemini/tmp/hashY/chats');
    assert.throws(() =>
      scanner.readMessages({ source: t.path('.gemini/tmp/hashY/chats/missing.jsonl') }, { roots: [root] })
    );
  } finally {
    t.cleanup();
  }
});
