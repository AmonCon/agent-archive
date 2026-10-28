import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, makeSqlite, withEnv } from './helpers.js';

/**
 * Cursor 扫描器的格式契约。
 *
 * 这里锁的是**实测踩过的坑**，每条都对应一个会让数据静默错掉的形状：
 *
 *   1. 消息顺序不在 cursorDiskKV 里，而在 composerData.fullConversationHeadersOnly。
 *      bubble 在 KV 表里是无序的，按 key 排序会得到一段乱序的对话。
 *   2. 项目路径优先用 workspaceStorage/<hash>/workspace.json 的权威值；
 *      拿不到才从 bubble.workspaceProjectDir 的目录名反解。反解是**有损**的，
 *      解不出时必须返回 null，编一个看起来合理的错路径会静默污染项目归集。
 *   3. 新建但没聊过的 composer 也会写一行，headers 为空就不是会话，
 *      列进时间线纯属噪声（empty-state-draft 同理）。
 *   4. 标题优先用 Cursor 自己起的名字，没有才用首句。
 *   5. bubble 字段名很杂，正文/推理/工具分别叫 text / thinking / toolFormerData。
 *   6. 时间都是毫秒时间戳。
 *
 * 全部跑在假家目录里。注意：helpers 只清了 CURSOR_CONFIG_DIR，而 cursor.js
 * 并不读它——真正的根目录是 %APPDATA%/Cursor，所以这里还要把 APPDATA
 * 指进沙箱，否则在装了 Cursor 的机器上会扫到真实数据。
 */

const scanner = await import('../src/scanners/cursor.js');

/** 在假家目录里跑，并把 VS Code 系的 APPDATA 一并隔离。 */
function runInBox(box, fn) {
  return box.run(() =>
    withEnv(
      {
        APPDATA: box.path('AppData', 'Roaming'),
        LOCALAPPDATA: box.path('AppData', 'Local'),
      },
      fn
    )
  );
}

/**
 * Cursor 的库固定放在 ~/.config/Cursor/...：
 * 三个平台的候选列表里都有 .config，放在这里用例跨平台都找得到，
 * 不会因为平台不同而落到别的空候选上。
 */
function cursorDbPath(box) {
  return box.path('.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * 造一个最小的 state.vscdb。
 *
 * composers 每项：{ id, createdAt, isArchived, isSubagent, workspaceId, data, bubbles }
 *   data     → cursorDiskKV 的 composerData:<id>
 *   bubbles  → [{ bubbleId, value }] → bubbleId:<id>:<bubbleId>
 */
function buildDb(box, composers) {
  const file = cursorDbPath(box);
  makeSqlite(file, (db) => {
    db.exec(`create table composerHeaders (
      composerId text primary key, createdAt integer, isArchived integer,
      isSubagent integer, workspaceId text)`);
    db.exec('create table cursorDiskKV (key text primary key, value text)');

    const insHeader = db.prepare('insert into composerHeaders values (?,?,?,?,?)');
    const insKv = db.prepare('insert into cursorDiskKV values (?,?)');

    for (const c of composers) {
      insHeader.run(
        c.id,
        c.createdAt ?? null,
        c.isArchived ?? 0,
        c.isSubagent ?? 0,
        c.workspaceId ?? null
      );
      if (c.data !== undefined) {
        insKv.run(`composerData:${c.id}`, JSON.stringify(c.data));
      }
      for (const b of c.bubbles || []) {
        insKv.run(`bubbleId:${c.id}:${b.bubbleId}`, JSON.stringify(b.value));
      }
    }
  });
  return file;
}

test('cursor: 消息顺序走 fullConversationHeadersOnly，不按 KV 键排序', async () => {
  const box = sandbox();
  try {
    const t = (s) => Date.UTC(2026, 0, 1, 0, 0, s);
    // 故意让 bubbleId 的字典序和对话顺序完全相反：
    // 按 key 排序会先读到 aaa（第三句），对话就乱了。
    const file = buildDb(box, [
      {
        id: 'c-order',
        createdAt: t(0),
        data: {
          name: '顺序测试',
          fullConversationHeadersOnly: [
            { bubbleId: 'zzz-first', type: 1, createdAt: t(1) },
            { bubbleId: 'mmm-second', type: 2, createdAt: t(2) },
            { bubbleId: 'aaa-third', type: 1, createdAt: t(3) },
          ],
        },
        // KV 里的插入顺序也是乱的，锁住"不能依赖 SQL 返回顺序"
        bubbles: [
          { bubbleId: 'aaa-third', value: { text: '第三句' } },
          { bubbleId: 'mmm-second', value: { text: '第二句' } },
          { bubbleId: 'zzz-first', value: { text: '第一句' } },
        ],
      },
    ]);

    await runInBox(box, () => {
      const [s] = scanner.parseAll(file);
      assert.ok(s, '应该扫到这场会话');

      const msgs = scanner.readMessages(s);
      assert.deepEqual(
        msgs.map((m) => m.role),
        ['user', 'assistant', 'user'],
        'type 1 是用户、type 2 是助手，顺序按 headers'
      );
      assert.deepEqual(
        msgs.map((m) => m.parts.find((p) => p.kind === 'text').text),
        ['第一句', '第二句', '第三句'],
        '按 key 排序会得到第三句在前——headers 才是对话顺序'
      );
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('cursor: 标题优先用 composerData.name，时间取毫秒时间戳与 headers 的极值', async () => {
  const box = sandbox();
  try {
    const t = (s) => Date.UTC(2026, 0, 1, 0, 0, s);
    const file = buildDb(box, [
      {
        id: 'c-named',
        createdAt: t(0),
        data: {
          name: '应用给的名字',
          fullConversationHeadersOnly: [
            { bubbleId: 'n1', type: 1, createdAt: t(1) },
            { bubbleId: 'n2', type: 2, createdAt: t(2) },
            { bubbleId: 'n3', type: 1, createdAt: t(5) },
          ],
        },
        bubbles: [
          { bubbleId: 'n1', value: { text: '用户说的第一句' } },
          { bubbleId: 'n2', value: { text: '回答' } },
          { bubbleId: 'n3', value: { text: '追问' } },
        ],
      },
      {
        id: 'c-unnamed',
        createdAt: t(0),
        data: {
          fullConversationHeadersOnly: [{ bubbleId: 'u1', type: 1, createdAt: t(1) }],
        },
        bubbles: [{ bubbleId: 'u1', value: { text: '没有名字时的首句' } }],
      },
    ]);

    await runInBox(box, () => {
      const list = scanner.parseAll(file);
      const named = list.find((s) => s.id === 'c-named');
      const unnamed = list.find((s) => s.id === 'c-unnamed');

      assert.ok(named && unnamed);
      assert.equal(named.title, '应用给的名字', 'Cursor 自己起的名字优先于首句');
      assert.equal(unnamed.title, '没有名字时的首句', '没有 name 才退回首条用户消息');

      // createdAt 是毫秒。若当秒用会落到 1970；结束时间取 headers 的最晚一条，
      // 不是 composer 的 createdAt。
      assert.equal(named.start.toISOString(), new Date(t(0)).toISOString());
      assert.equal(named.end.toISOString(), new Date(t(5)).toISOString());
      assert.equal(named.start.getUTCFullYear(), 2026, '毫秒时间戳不能被当成秒');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('cursor: 没聊过的 composer 不产生会话（空 headers / empty-state-draft）', async () => {
  const box = sandbox();
  try {
    const t = (s) => Date.UTC(2026, 0, 1, 0, 0, s);
    const file = buildDb(box, [
      // 新建但没聊：headers 为空
      {
        id: 'c-empty',
        createdAt: t(0),
        data: { name: '空会话', fullConversationHeadersOnly: [] },
      },
      // Cursor 的草稿占位 id
      {
        id: 'empty-state-draft',
        createdAt: t(0),
        data: {
          name: '草稿',
          fullConversationHeadersOnly: [{ bubbleId: 'd1', type: 1, createdAt: t(1) }],
        },
        bubbles: [{ bubbleId: 'd1', value: { text: '草稿内容' } }],
      },
      // 有 header 行但 composerData 被清掉了
      { id: 'c-no-data', createdAt: t(0) },
      // 唯一一场真会话
      {
        id: 'c-real',
        createdAt: t(0),
        data: {
          fullConversationHeadersOnly: [{ bubbleId: 'r1', type: 1, createdAt: t(1) }],
        },
        bubbles: [{ bubbleId: 'r1', value: { text: '真的聊过' } }],
      },
    ]);

    await runInBox(box, () => {
      const list = scanner.parseAll(file);
      assert.deepEqual(
        list.map((s) => s.id),
        ['c-real'],
        '空会话/草稿/无 composerData 都不能混进时间线'
      );
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('cursor: 从 workspaceProjectDir 反解项目；解不出就留空，不猜', async () => {
  const box = sandbox();
  try {
    const t = (s) => Date.UTC(2026, 0, 1, 0, 0, s);
    // 目录名是「绝对路径把分隔符换成 -」得到的，有损。这里用两个形态：
    // 一个能确定盘符/家目录，一个完全无法可靠反解（必须 null）。
    const resolvableDir =
      process.platform === 'win32'
        ? 'c:\\Users\\X\\.cursor\\projects\\e-my-app'
        : '/Users/x/.cursor/projects/Users-x-my-app';
    const expectedProject = process.platform === 'win32' ? 'e:/my-app' : '/Users/x/my-app';

    const file = buildDb(box, [
      {
        id: 'c-proj',
        createdAt: t(0),
        data: {
          fullConversationHeadersOnly: [{ bubbleId: 'p1', type: 1, createdAt: t(1) }],
        },
        bubbles: [
          {
            bubbleId: 'p1',
            value: { text: '项目会话', workspaceProjectDir: resolvableDir },
          },
        ],
      },
      {
        id: 'c-unresolvable',
        createdAt: t(0),
        data: {
          fullConversationHeadersOnly: [{ bubbleId: 'q1', type: 1, createdAt: t(1) }],
        },
        bubbles: [
          {
            bubbleId: 'q1',
            value: {
              text: '反解不出来的会话',
              // 这类 slug 无法区分 /opt/myapp 与 /opt/my/app，必须放弃
              workspaceProjectDir: '/opt/x/.cursor/projects/opt-myapp',
            },
          },
        ],
      },
    ]);

    await runInBox(box, () => {
      const list = scanner.parseAll(file);
      const proj = list.find((s) => s.id === 'c-proj');
      const unresolvable = list.find((s) => s.id === 'c-unresolvable');

      assert.equal(proj.project, expectedProject, '目录名要还原成真实项目路径');
      assert.equal(
        unresolvable.project,
        null,
        '反解不出就是 null；编一个看起来像路径的错误值会静默污染项目归集'
      );
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('cursor: bubble 的 text / thinking / toolFormerData 三类字段都要保留', async () => {
  const box = sandbox();
  try {
    const t = (s) => Date.UTC(2026, 0, 1, 0, 0, s);
    // 字段名很杂：正文 text、推理 thinking.text、工具 toolFormerData。
    // 少认一个，那部分内容就会在会话页上凭空消失。
    const file = buildDb(box, [
      {
        id: 'c-fields',
        createdAt: t(0),
        data: {
          fullConversationHeadersOnly: [
            { bubbleId: 'f1', type: 1, createdAt: t(1) },
            { bubbleId: 'f2', type: 2, createdAt: t(2) },
          ],
        },
        bubbles: [
          { bubbleId: 'f1', value: { text: '问题' } },
          {
            bubbleId: 'f2',
            value: {
              thinking: { text: '先想一想' },
              toolFormerData: {
                name: 'read_file',
                params: { path: 'a.txt' },
                result: 'ok',
                status: 'completed',
              },
              text: '这是回答',
            },
          },
        ],
      },
    ]);

    await runInBox(box, () => {
      const [s] = scanner.parseAll(file);
      const [user, assistant] = scanner.readMessages(s);

      assert.equal(user.role, 'user');
      assert.equal(user.parts[0].text, '问题');

      assert.equal(assistant.role, 'assistant');
      const reasoning = assistant.parts.find((p) => p.kind === 'reasoning');
      const tool = assistant.parts.find((p) => p.kind === 'tool');
      const text = assistant.parts.find((p) => p.kind === 'text');

      assert.ok(reasoning, 'thinking.text 要变成推理片段');
      assert.equal(reasoning.text, '先想一想');
      assert.ok(tool, 'toolFormerData 要变成工具片段');
      assert.equal(tool.name, 'read_file');
      assert.deepEqual(tool.input, { path: 'a.txt' });
      assert.equal(tool.output, 'ok');
      assert.equal(tool.status, 'completed');
      assert.ok(text, '正文不能被推理/工具挤掉');
      assert.equal(text.text, '这是回答');
      assert.equal(assistant.ts.toISOString(), new Date(t(2)).toISOString());
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

/**
 * 这条曾经是 skip：src 的 SELECT 没取 workspaceId，导致
 * `projectFromWorkspaceJson(undefined)` 永远拿不到权威路径，项目只能靠
 * 目录名反解（有损）。2026-10-28 修好后转绿——保留注释说明它验的是
 * 哪条真实规则，而不只是复述实现。
 */
test(
  'cursor: workspaceStorage/<hash>/workspace.json 是项目路径的权威来源',
  async () => {
    const box = sandbox();
    try {
      const t = (s) => Date.UTC(2026, 0, 1, 0, 0, s);
      // 这个 slug 是能反解的（会得到另一个项目），这样一旦断言失败就能区分
      // "权威来源没生效"和"fixture 根本没找到 workspace.json"（后者是 null）。
      const wrongDir =
        process.platform === 'win32'
          ? 'c:\\Users\\X\\.cursor\\projects\\d-different-proj'
          : '/Users/x/.cursor/projects/Users-x-different-proj';

      const file = buildDb(box, [
        {
          id: 'c-ws',
          createdAt: t(0),
          workspaceId: 'ws-1',
          data: {
            fullConversationHeadersOnly: [{ bubbleId: 'w1', type: 1, createdAt: t(1) }],
          },
          bubbles: [
            {
              bubbleId: 'w1',
              value: { text: '有工作区的会话', workspaceProjectDir: wrongDir },
            },
          ],
        },
      ]);

      box.write(
        '.config/Cursor/User/workspaceStorage/ws-1/workspace.json',
        JSON.stringify({ folder: 'file:///e%3A/authoritative-proj' })
      );

      await runInBox(box, () => {
        const [s] = scanner.parseAll(file);
        assert.equal(
          s.project,
          'e:/authoritative-proj',
          'workspace.json 的 folder 是权威值，应优先于目录名反解'
        );
      });
    } finally {
      scanner.closeStore();
      box.cleanup();
    }
  }
);
