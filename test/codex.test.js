import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  sandbox,
  withEnv,
  makeSqlite,
  codexMeta,
  codexUser,
  codexAssistant,
  codexLine,
} from './helpers.js';

const require = createRequire(import.meta.url);

/**
 * Codex 扫描器的格式契约。
 *
 * 这里锁的是**我们踩过的坑**，不是"代码当前怎么写"。每条断言对应一个真实缺陷：
 *
 *   1. 父会话 id 有三代写法（旧 session_id / 新 parent_thread_id / guardian 没有）
 *   2. 导入会话的顶层 timestamp 全是导入时刻，真实时间在 payload 里
 *   3. 只读头部会让长文件缺结束时间，明文靠尾部补、压缩靠旁路表补
 *   4. 旁路表文件名带版本号，写死会在上游升版后静默失效
 *
 * 上游哪天改了这些形状，这里会先红——总比用户机器上静默少数据好。
 * 全部跑在假家目录里，不依赖、也不触碰本机真实数据。
 */

const scanner = await import('../src/scanners/codex.js');

test('codex: 旧版子代理用 session_id 指向父会话', async () => {
  const box = sandbox();
  try {
    const parentId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const childId = 'bbbbbbbb-1111-2222-3333-444444444444';
    // 旧版：session_id 指向父、id 指向自己
    const meta =
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id: childId, session_id: parentId, cwd: 'E:/p', source: { subagent: {} } },
      }) + '\n';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${childId}.jsonl`,
      meta + codexUser('hi', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent');
      assert.equal(s.parent, parentId);
      assert.equal(s.id, childId, 'id 必须是自己，不能是父会话');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 新版子代理的父 id 在 parent_thread_id', async () => {
  const box = sandbox();
  try {
    const parentId = 'cccccccc-1111-2222-3333-444444444444';
    const childId = 'dddddddd-1111-2222-3333-444444444444';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${childId}.jsonl`,
      codexMeta({
        id: childId,
        cwd: 'E:/p',
        parent: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
        timestamp: '2026-01-01T00:00:00Z',
      }) + codexUser('hi', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent');
      assert.equal(s.parent, parentId);
    });
  } finally {
    box.cleanup();
  }
});

test('codex: guardian 类型没有父 id 时如实留空，不编造', async () => {
  const box = sandbox();
  try {
    const id = 'eeeeeeee-1111-2222-3333-444444444444';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', source: { subagent: { other: 'guardian' } }, timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('hi', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.kind, 'subagent', '仍然要标成子代理');
      assert.equal(s.parent, null, '拿不到就是 null，不要推测');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 导入会话用 payload 的真实时间，不用导入时刻', async () => {
  const box = sandbox();
  try {
    const id = 'ffffffff-1111-2222-3333-444444444444';
    const importAt = '2026-09-05T17:00:01.000Z';
    const realStart = Date.UTC(2026, 7, 29, 7, 30, 56) / 1000; // 2026-08-29T07:30:56Z
    const realEnd = Date.UTC(2026, 7, 29, 7, 31, 58) / 1000;
    const body =
      codexMeta({ id, cwd: 'E:/p', timestamp: importAt }) +
      codexLine(
        'event_msg',
        { type: 'task_started', turn_id: 'external-import-turn-1', started_at: realStart },
        importAt
      ) +
      codexLine(
        'event_msg',
        {
          type: 'task_complete',
          turn_id: 'external-import-turn-1',
          started_at: realStart,
          completed_at: realEnd,
          // 这个字段名字有误导性：装的是导入时刻
          completed_at_ms: Date.parse(importAt),
        },
        importAt
      ) +
      codexUser('导入的对话', importAt);

    const file = box.write(`.codex/sessions/2026/09/06/rollout-x-${id}.jsonl`, body);

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.start.toISOString(), new Date(realStart * 1000).toISOString(), 'start 用真实开始');
      assert.equal(s.end.toISOString(), new Date(realEnd * 1000).toISOString(), 'end 用真实完成');
      assert.notEqual(s.end.toISOString(), importAt, '不能等于导入时刻');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 明文长文件读尾部拿到真实结束时间', async () => {
  const box = sandbox();
  try {
    const id = '11111111-aaaa-bbbb-cccc-dddddddddddd';
    const filler =
      JSON.stringify({
        timestamp: '2026-01-01T01:00:00Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(8000) }] },
      }) + '\n';
    let body = codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' });
    body += codexUser('开头', '2026-01-01T00:01:00Z');
    for (let i = 0; i < 40; i++) body += filler;
    body += codexAssistant('结尾', '2026-01-05T12:00:00Z');

    const file = box.write(`.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`, body);
    assert.ok(Buffer.byteLength(body) > 256 * 1024, '用例前提：文件必须超过头部读取上限');

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(
        s.end.toISOString(),
        '2026-01-05T12:00:00.000Z',
        '头部只读到 1 月 1 日，尾部读取才能拿到 1 月 5 日'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 旁路表修正结束时间与占位标题，且跟随版本号的库名', async () => {
  const box = sandbox();
  try {
    const id = '22222222-aaaa-bbbb-cccc-dddddddddddd';
    // 刻意用 state_9.sqlite：验证不是写死 state_5
    makeSqlite(box.path('.codex', 'state_9.sqlite'), (db) => {
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(
        id,
        '应用给的标题',
        Date.UTC(2026, 0, 9, 0, 0, 0) / 1000, // Unix 秒
        'E:/p',
        123
      );
    });

    // 不放用户消息：这样我们只能给出占位标题，才该被应用标题覆盖
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' })
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.title, '(untitled)', 'parse 阶段不读旁路表');

      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '应用给的标题', '占位标题要让位给应用标题');
      assert.equal(e.end.toISOString(), '2026-01-09T00:00:00.000Z', '结束时间用 threads.updated_at');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 真实用户第一句不会被应用标题覆盖', async () => {
  const box = sandbox();
  try {
    const id = '44444444-aaaa-bbbb-cccc-dddddddddddd';
    makeSqlite(box.path('.codex', 'state_1.sqlite'), (db) => {
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(
        id,
        '应用给的标题',
        Date.UTC(2026, 0, 9) / 1000,
        'E:/p',
        1
      );
    });

    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('用户自己说的第一句', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.title, '用户自己说的第一句');
      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '用户自己说的第一句', '用户真实说过的话优先，不被应用标题盖掉');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 没有旁路表时不报错、不改变任何字段', async () => {
  const box = sandbox();
  try {
    const id = '33333333-aaaa-bbbb-cccc-dddddddddddd';
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('真实用户第一句', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '真实用户第一句');
      assert.deepEqual(e.end, s.end);
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 旁路库是 WAL 模式时，只写 -wal 的新标题也要读到', async () => {
  const box = sandbox();
  try {
    // 这条锁的是一个**静默失效**：Codex 的 state_5.sqlite 是 WAL 模式
    // （本机实测文件头第 18/19 字节都是 2）。WAL 模式下写入先落
    // state_5.sqlite-wal，**主库的 size/mtime 只在 checkpoint 时才变**。
    //
    // 旧判据只看主库 (size, mtime) → memo 命中 → 一直用旧标题，
    // 直到某次 checkpoint。长驻的 serve 进程里这个窗口可以很长，
    // 而用户看到的只是"标题怎么还是旧的"，没有任何报错。
    const id = '55555555-aaaa-bbbb-cccc-dddddddddddd';
    const dbPath = box.path('.codex', 'state_5.sqlite');
    makeSqlite(dbPath, (db) => {
      db.exec('pragma journal_mode = wal');
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(id, '第一版标题', Date.UTC(2026, 0, 9) / 1000, 'E:/p', 1);
    });

    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' })
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(scanner.enrich([s])[0].title, '第一版标题');

      // 写第二版，**不 checkpoint**：主库不动，只有 -wal 变
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare('update threads set title = ? where id = ?').run('第二版标题', id);
      } finally {
        db.close();
      }

      const again = scanner.enrich([s])[0];
      assert.equal(again.title, '第二版标题', 'WAL 里的新标题必须被读到（旧判据只看主库）');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 旁路库读失败时不当成"读到了空表"，下一轮会重试', async () => {
  const box = sandbox();
  try {
    // 这条锁的是「未知 ≠ 空」：表结构变了 / 打不开 / 查询抛错，都是
    // "这次不知道"，不能 memo 成"读到了 0 行"。否则进程生命周期内再也
    // 不重试，而用户看到的只是"标题一直是粗的"——与"Codex 确实没给标题"
    // 完全同形，查不出来。
    const id = '66666666-aaaa-bbbb-cccc-dddddddddddd';
    makeSqlite(box.path('.codex', 'state_5.sqlite'), (db) => {
      // 缺 title/updated_at 列：查询必抛错
      db.exec('create table threads (id text)');
      db.prepare('insert into threads values (?)').run(id);
    });

    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('真实用户第一句', '2026-01-01T00:01:00Z')
    );

    await box.run(() => {
      const s = scanner.parse(file);
      const [e] = scanner.enrich([s]);
      assert.equal(e.title, '真实用户第一句', '读不到就什么都不改，不能把标题写成空');
      assert.equal(scanner.enrichStats().read, false, '读失败要如实报成"没读到"，不是"读到 0 行"');

      // 第二次调用仍然会去读（没有被空 Map 污染成"已读到"）
      const [e2] = scanner.enrich([s]);
      assert.equal(e2.title, '真实用户第一句');
      assert.equal(scanner.enrichStats().read, false, 'memo 不能被失败结果污染');
    });
  } finally {
    box.cleanup();
  }
});

test('codex: 旁路库在第二个根时，enrich 照样拿得到应用标题', async () => {
  // 这条锁的是「只认 codexDirs()[0]」：CODEX_HOME 指到一个独立的、没有
  // state 库的目录（换机器、临时目录、外置盘都可能是这种形状），真正在用的
  // ~/.codex 才是旁路库所在的根。
  //
  // 旧代码只扫第一个根 → findVersionedDb 返回 null → enrich 退化成
  // "什么都不改"：标题停在我们生成的占位符、end 停在对齐到秒的粗值，
  // **全程不报错**。用户只会觉得"这工具标题怎么这么难看"，查不出原因。
  const box = sandbox();
  try {
    const id = '77777777-aaaa-bbbb-cccc-dddddddddddd';
    const altHome = box.mkdir('alt-codex');

    makeSqlite(box.path('.codex', 'state_13.sqlite'), (db) => {
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(
        id,
        '第二个根里的应用标题',
        Date.UTC(2026, 0, 10) / 1000,
        'E:/p',
        1
      );
    });

    // 会话本身也在 ~/.codex，第一根里什么都没有
    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' })
    );

    await box.run(() =>
      withEnv({ CODEX_HOME: altHome }, () => {
        const s = scanner.parse(file);
        assert.equal(s.title, '(untitled)', '用例前提：这个会话只有占位标题');

        const [e] = scanner.enrich([s]);
        assert.equal(e.title, '第二个根里的应用标题', '旁路库在第二个根也要读到，不能只看第一个根');
        assert.equal(e.end.toISOString(), '2026-01-10T00:00:00.000Z', '结束时间也要用第二个根的 threads.updated_at');
      })
    );
  } finally {
    box.cleanup();
  }
});

test('codex: rollout 只在第二个根时，readMessages 不抛错', async () => {
  // 与上一条同源：`cat` 走的是 readMessages → assertUnder(codexDir(), src)。
  // 根校验只认第一个根时，第二根里的会话**连正文都打不开**，直接抛
  // "拒绝读取根目录之外的路径"。这条比 enrich 那条更硬：它不是静默降级，
  // 而是把本来已经采集到的会话判成非法路径。
  const box = sandbox();
  try {
    const id = '88888888-aaaa-bbbb-cccc-dddddddddddd';
    const altHome = box.mkdir('alt-codex');

    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' }) +
        codexUser('第二个根里的会话正文', '2026-01-01T00:01:00Z')
    );

    await box.run(() =>
      withEnv({ CODEX_HOME: altHome }, () => {
        const s = scanner.parse(file);
        const msgs = scanner.readMessages(s);
        assert.ok(msgs.length > 0, '正文要能读出来');
        assert.match(JSON.stringify(msgs), /第二个根里的会话正文/, '读出来的是这条会话的内容');
      })
    );
  } finally {
    box.cleanup();
  }
});

test('codex: state 库在 CODEX_SQLITE_HOME 指定的目录时也要读到', async () => {
  // codex-rs 解析 state 库位置时，`CODEX_SQLITE_HOME` 与 config.toml 的
  // `sqlite_home` 都能把它挪到会话根之外（cc-switch 的 codex_state_db.rs
  // 也是这么解析的）。我们只认 CODEX_HOME 时，这种机器上 enrich 同样
  // 静默失效——数据都在，只是我们没去那个目录看。
  //
  // 这里只锁环境变量，不锁 config.toml：读 toml 要带解析器（本项目零依赖），
  // 收益只是"更全一点"，代价是引入一个解析层，暂时不做（理由写在
  // codexDbDirs 的注释里）。
  const box = sandbox();
  try {
    const id = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const dbDir = box.mkdir('sqlite-home');

    makeSqlite(box.path('sqlite-home', 'state_5.sqlite'), (db) => {
      db.exec('create table threads (id text, title text, updated_at integer, cwd text, tokens_used integer)');
      db.prepare('insert into threads values (?,?,?,?,?)').run(id, '挪走的库里的标题', Date.UTC(2026, 0, 11) / 1000, 'E:/p', 1);
    });

    const file = box.write(
      `.codex/sessions/2026/01/01/rollout-x-${id}.jsonl`,
      codexMeta({ id, cwd: 'E:/p', timestamp: '2026-01-01T00:00:00Z' })
    );

    await box.run(() =>
      withEnv({ CODEX_SQLITE_HOME: dbDir }, () => {
        const s = scanner.parse(file);
        const [e] = scanner.enrich([s]);
        assert.equal(e.title, '挪走的库里的标题', 'CODEX_SQLITE_HOME 指的目录也要当成旁路库的候选');
      })
    );
  } finally {
    box.cleanup();
  }
});
