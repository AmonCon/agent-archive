import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, makeSqlite, withEnv } from './helpers.js';

/**
 * Hermes 扫描器的格式契约。
 *
 * 这里锁的是**实测踩过的坑**，不是"代码当前怎么写"。每条断言对应一个
 * 曾经导致静默少数据的形状：
 *
 *   1. 主存储是 state.db；旧的 sessions/*.jsonl 已不再写入/读取。
 *      早期只扫 jsonl，本机读到 34 场，而 state.db 里有 219 场——漏了 6/7，
 *      而且不报错，只是安静地少算。
 *   2. parent_session_id 非空的是子代理：要照常采集并标 kind/parent，
 *      整条跳过等于只存一半事实。
 *   3. message_count=0 的空会话不是会话，列进时间线纯属噪声。
 *   4. started_at/ended_at 是 epoch 秒（REAL，带小数），当毫秒用会落到 1970。
 *   5. 多数会话没有 cwd（接飞书等渠道的聊天），这是常态不是缺陷；
 *      但不能一刀切，有 cwd 的必须归到项目。
 *   6. hidden=1 是用户主动隐藏，事实仍然存在，必须采集。
 *   7. 消息 active=0 是被压缩掉的旧消息，不该再当正常对话显示；
 *      工具调用与工具结果要单独成条，否则"它干了什么"在会话页上看不见。
 *   8. -wal 必须参与缓存判据，否则刚聊完的会话会漏；-shm 不参与。
 *
 * 上游哪天改了这些形状，这里会先红。全部跑在假家目录里，
 * 不依赖、也不触碰本机真实数据。
 */

const scanner = await import('../src/scanners/hermes.js');

/**
 * 在假家目录里跑，并把 Windows 的 LOCALAPPDATA 也指进沙箱。
 *
 * hermesDir() 的候选里有 %LOCALAPPDATA%/hermes；不隔离它的话，
 * 一旦某个用例没建出 ~/.hermes，就可能落到跑测试这台机器的真实目录。
 */
function runInBox(box, fn) {
  return box.run(() => withEnv({ LOCALAPPDATA: box.path('AppData', 'Local') }, fn));
}

/**
 * 造一个最小的 state.db。
 *
 * 两处字段名是硬契约，缺了会**静默**少数据，值得在 fixture 里写明：
 *   - sessions.profile_name：parseAll 的 SELECT 里有这一列，缺列会让整条
 *     查询抛错，于是 parseAll 返回空数组——没有报错，只是所有会话消失。
 *   - messages.id：readFromDb 的 `order by timestamp asc, id asc` 用了它。
 */
function buildDb(box, { sessions = [], messages = [] } = {}) {
  const file = box.path('.hermes', 'state.db');
  makeSqlite(file, (db) => {
    db.exec(`create table sessions (
      id text primary key, source text, model text,
      started_at real, ended_at real, title text, cwd text,
      parent_session_id text, message_count integer,
      hidden integer, archived integer, profile_name text)`);
    db.exec(`create table messages (
      id integer primary key autoincrement, session_id text, role text,
      content text, reasoning text, tool_name text, tool_calls text,
      timestamp real, active integer, compacted integer)`);

    const insSession = db.prepare('insert into sessions values (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const s of sessions) {
      insSession.run(
        s.id,
        s.source ?? null,
        s.model ?? null,
        s.started_at ?? null,
        s.ended_at ?? null,
        s.title ?? null,
        s.cwd ?? null,
        s.parent_session_id ?? null,
        s.message_count ?? 0,
        s.hidden ?? 0,
        s.archived ?? 0,
        s.profile_name ?? null
      );
    }

    const insMessage = db.prepare(
      `insert into messages
       (session_id, role, content, reasoning, tool_name, tool_calls, timestamp, active, compacted)
       values (?,?,?,?,?,?,?,?,?)`
    );
    for (const m of messages) {
      insMessage.run(
        m.session_id,
        m.role,
        m.content ?? null,
        m.reasoning ?? null,
        m.tool_name ?? null,
        m.tool_calls ?? null,
        m.timestamp ?? null,
        m.active ?? 1,
        m.compacted ?? 0
      );
    }
  });
  return file;
}

test('hermes: 只有旧的 sessions/*.jsonl 时不再扫出会话', async () => {
  const box = sandbox();
  try {
    // 旧文档已写明 *.jsonl transcript 不再写入或读取。如果扫描器又回头
    // 兼容它，会把导出/旧档重复算进来，或者让用户看到早已不更新的副本。
    box.write(
      '.hermes/sessions/legacy.jsonl',
      JSON.stringify({ role: 'user', content: '旧格式里的话' }) + '\n'
    );

    await runInBox(box, () => {
      assert.deepEqual(scanner.discover(), [], '没有 state.db 就没有会话，不能退回旧 jsonl');
      assert.equal(scanner.parse(box.path('.hermes', 'sessions', 'legacy.jsonl')), null, '旧的单文件入口不产出会话');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: started_at 是 epoch 秒（REAL，带小数），不能当毫秒', async () => {
  const box = sandbox();
  try {
    const startSec = 1776274941.9466; // 本机实测值：2026-04-15 附近
    const endSec = 1776275000.25;
    const db = buildDb(box, {
      sessions: [
        {
          id: 't2-main',
          source: 'cli',
          started_at: startSec,
          ended_at: endSec,
          message_count: 1,
        },
      ],
      messages: [
        { session_id: 't2-main', role: 'user', content: '你好', timestamp: startSec },
      ],
    });

    await runInBox(box, () => {
      assert.deepEqual(scanner.discover(), [db], 'state.db 就是扫描入口');

      const [s] = scanner.parseAll(db);
      assert.ok(s, '会话应该被读到');

      // 用与源码相同的换算方式断言；再单独断言年份，锁住"秒不是毫秒"。
      // 按毫秒解释的话 1.7e9 只有 1970-01-21，这里会立刻红。
      assert.equal(s.start.toISOString(), new Date(startSec * 1000).toISOString());
      assert.equal(s.end.toISOString(), new Date(endSec * 1000).toISOString());
      assert.equal(s.start.getUTCFullYear(), 2026, '当毫秒用会落到 1970 年');
      assert.equal(s.start.getUTCMonth(), 3, '4 月（0 基），不是 1 月');
      assert.ok(
        Math.abs(s.start.getTime() - startSec * 1000) < 1,
        '秒级小数应保留到毫秒级，不能被取整成整秒'
      );
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: cwd 为空的渠道会话不能丢，有 cwd 的必须归到项目', async () => {
  const box = sandbox();
  try {
    // Hermes 是接飞书等渠道的助手：多数会话不绑定工作目录。
    // 早期把 project 硬编码成 null + 整条丢掉的思路都错——前者让有 cwd
    // 的 46 场永远进不了项目时间线，后者直接少会话。
    const db = buildDb(box, {
      sessions: [
        {
          id: 't3-feishu',
          source: 'feishu',
          started_at: 1776274941.1,
          message_count: 1,
          cwd: null,
        },
        {
          id: 't3-proj',
          source: 'cli',
          started_at: 1776274942.1,
          message_count: 1,
          cwd: 'E:\\work\\proj',
        },
      ],
      messages: [
        { session_id: 't3-feishu', role: 'user', content: '飞书里的一句话', timestamp: 1776274941.5 },
        { session_id: 't3-proj', role: 'user', content: '项目里的一句话', timestamp: 1776274942.5 },
      ],
    });

    await runInBox(box, () => {
      const list = scanner.parseAll(db);
      const feishu = list.find((s) => s.id === 't3-feishu');
      const proj = list.find((s) => s.id === 't3-proj');

      assert.ok(feishu, '没有 cwd 不等于不是会话');
      assert.equal(feishu.project, null, '项目为空是如实记录，不是丢会话的理由');
      assert.ok(proj, '有 cwd 的会话同样要留下');
      assert.equal(proj.project, 'E:/work/proj', '有 cwd 就必须归到项目，不能一刀切成 null');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: parent_session_id 非空的是子代理，照常采集并标 kind/parent', async () => {
  const box = sandbox();
  try {
    // 子代理会话里才记着实际干的活。整条跳过 = 档案馆只存一半事实；
    // 时间线默认只显示 main，所以留下它们不会让列表翻倍。
    const db = buildDb(box, {
      sessions: [
        { id: 't4-main', source: 'cli', started_at: 1776274941.1, message_count: 1, title: '主会话' },
        {
          id: 't4-child',
          source: 'cli',
          started_at: 1776274942.1,
          message_count: 1,
          title: '子代理',
          parent_session_id: 't4-main',
        },
      ],
      messages: [
        { session_id: 't4-main', role: 'user', content: '去查一下', timestamp: 1776274941.5 },
        { session_id: 't4-child', role: 'user', content: '实际去查', timestamp: 1776274942.5 },
      ],
    });

    await runInBox(box, () => {
      const list = scanner.parseAll(db);
      assert.equal(list.length, 2, '子代理不能被跳过');

      const main = list.find((s) => s.id === 't4-main');
      const child = list.find((s) => s.id === 't4-child');
      assert.equal(main.kind, 'main');
      assert.equal(main.parent, null);
      assert.equal(child.kind, 'subagent');
      assert.equal(child.parent, 't4-main');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: message_count=0 的会话要跳过', async () => {
  const box = sandbox();
  try {
    // 没聊起来的会话（建了就退、渠道发了个空会话）不该进时间线。
    const db = buildDb(box, {
      sessions: [
        { id: 't5-zero', source: 'cli', started_at: 1776274941.1, message_count: 0 },
        { id: 't5-live', source: 'cli', started_at: 1776274942.1, message_count: 1 },
      ],
      messages: [
        { session_id: 't5-live', role: 'user', content: '真的聊过', timestamp: 1776274942.5 },
      ],
    });

    await runInBox(box, () => {
      const list = scanner.parseAll(db);
      assert.equal(list.find((s) => s.id === 't5-zero'), undefined, 'message_count=0 不是会话');
      assert.ok(list.find((s) => s.id === 't5-live'), '有消息的会话不受影响');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: hidden=1 仍然采集，标题缺失时用首句或 source 兜底', async () => {
  const box = sandbox();
  try {
    // 用户主动隐藏的会话事实仍然存在，不能因为 hidden 就少数据。
    // 标题缺失时按 Hermes title → 首条用户消息 → source 占位 的顺序兜底。
    const db = buildDb(box, {
      sessions: [
        {
          id: 't6-hidden-msg',
          source: 'feishu',
          started_at: 1776274941.1,
          message_count: 1,
          hidden: 1,
          title: null,
        },
        {
          id: 't6-hidden-empty',
          source: 'feishu',
          started_at: 1776274942.1,
          message_count: 1,
          hidden: 1,
          title: null,
        },
      ],
      messages: [
        {
          session_id: 't6-hidden-msg',
          role: 'user',
          content: '隐藏会话里的话',
          timestamp: 1776274941.5,
        },
      ],
    });

    await runInBox(box, () => {
      const list = scanner.parseAll(db);
      const withMsg = list.find((s) => s.id === 't6-hidden-msg');
      const empty = list.find((s) => s.id === 't6-hidden-empty');

      assert.ok(withMsg, 'hidden=1 的会话仍然要采集');
      assert.equal(withMsg.title, '隐藏会话里的话', '没有标题就用首条用户消息');
      assert.ok(empty, 'hidden 且没有消息内容的会话也要留下');
      assert.equal(empty.title, '(feishu)', '标题和首句都没有时用 source 占位');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: 消息按 timestamp 排序、active=0 跳过、工具调用与结果分别成条', async () => {
  const box = sandbox();
  try {
    const base = 1776274940;
    // 刻意打乱插入顺序：mounted 顺序 ≠ 对话顺序，必须按 timestamp 排。
    // 也刻意放一条 active=0 的更早消息：它是被压缩掉的旧话，不该显示。
    const db = buildDb(box, {
      sessions: [
        { id: 't7-main', source: 'cli', started_at: base + 1.1, message_count: 5 },
      ],
      messages: [
        {
          session_id: 't7-main',
          role: 'tool',
          content: '文件内容',
          tool_name: 'read_file',
          timestamp: base + 5.5,
        },
        {
          session_id: 't7-main',
          role: 'assistant',
          content: null,
          tool_calls: JSON.stringify([
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
          ]),
          timestamp: base + 4.5,
        },
        {
          session_id: 't7-main',
          role: 'user',
          content: '被压缩的旧话',
          timestamp: base + 1.5,
          active: 0,
        },
        {
          session_id: 't7-main',
          role: 'user',
          content: '第一句',
          timestamp: base + 2.5,
        },
        {
          session_id: 't7-main',
          role: 'assistant',
          content: '好的',
          reasoning: '想一想',
          timestamp: base + 3.5,
        },
      ],
    });

    await runInBox(box, () => {
      const [s] = scanner.parseAll(db);
      const msgs = scanner.readMessages(s);

      assert.deepEqual(
        msgs.map((m) => m.role),
        ['user', 'assistant', 'assistant', 'tool'],
        '必须按 timestamp 排序，且 active=0 的旧消息不出现'
      );
      assert.equal(msgs.length, 4, '3 条正常对话 + 1 条工具结果；压缩掉的旧话不算');

      assert.equal(msgs[0].parts[0].text, '第一句');
      assert.equal(msgs[0].ts.toISOString(), new Date((base + 2.5) * 1000).toISOString());

      assert.deepEqual(
        msgs[1].parts.map((p) => p.kind),
        ['reasoning', 'text'],
        '推理和正文都要保留'
      );
      assert.equal(msgs[1].parts[0].text, '想一想');

      // 只有 tool_calls、没有正文的 assistant 消息：调用本身要单独成条，
      // 否则会话页上完全看不到"它调了什么工具"。
      const call = msgs[2].parts[0];
      assert.equal(call.kind, 'tool');
      assert.equal(call.name, 'read_file');
      assert.deepEqual(call.input, { path: 'a.txt' }, 'arguments 里的 JSON 字符串要解析成对象');

      // 工具结果单独一条 tool 消息。
      assert.equal(msgs[3].parts[0].kind, 'tool');
      assert.equal(msgs[3].parts[0].output, '文件内容');
    });
  } finally {
    scanner.closeStore();
    box.cleanup();
  }
});

test('hermes: WAL 参与缓存判据、SHM 不参与', async () => {
  const box = sandbox();
  try {
    const db = box.path('.hermes', 'state.db');
    // WAL 模式下新消息先写 -wal，主库的 mtime/size 可以长时间不动。
    // 只按主库判缓存会漏掉刚聊完的会话；-shm 是索引页，算进来只会误判重扫。
    assert.deepEqual(scanner.extraFiles(db), [`${db}-wal`]);
  } finally {
    box.cleanup();
  }
});
