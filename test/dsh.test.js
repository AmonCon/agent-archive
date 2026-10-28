import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sandbox, withEnv } from './helpers.js';

/**
 * DeepSeek Harness（dsh）扫描器的格式契约。
 *
 * 这里锁的是**在真实存储上验证过的坑**，不是"代码当前怎么写"。每条对应
 * 一种会静默少数据/把时间线弄乱的形状：
 *
 *   1. `.zstd` 是**多帧追加**：每批事件一帧，不是一个大帧。直接整段读会漏内容
 *      ——Node 24.12 的 zstdDecompressSync 只解第一帧（实机 416KB 的文件只解出
 *      253 字节）；24.22 起它已经会解全部帧。所以扫描器不依赖某个版本的行为，
 *      一律按帧魔数切开逐帧解，两种运行时都正确。
 *   2. 数据根不一定是 `~/.dsh`：Windows 桌面版把 DSH_HOME 指到
 *      `~/DeepSeekHarness`。本机就**没有** `~/.dsh`，只写死默认位置会
 *      得到 0 场且不报错。
 *   3. 升级后同一 session 目录里会留下多代文件（`session.jsonl.zstd` +
 *      `session.v4.jsonl.zstd`，本机 3 个目录如此）。必须只取一个，否则
 *      同一场对话出现两次；多代之间版本号要压过 mtime，否则可能选中
 *      升级前的旧内容。
 *   4. 子代理也是独立 session 文件，header 带 `parentSession`（本机 40 个
 *      session 里 20 个是子代理）。早先整条丢弃，等于把"实际查了什么"
 *      扔了一半；现在要标记 kind=subagent 并带 parent。
 *   5. fork 会话以原会话事件开头，`header.createdAt` 只是 fork 时刻；
 *      start 要取事件时间包络，否则半年前的对话显示成刚开始。
 *   6. `user/message` 的 `data.source.kind` 有十几种（runtime-context /
 *      skill-catalog / time-context / agent-instructions…），只有 `user`
 *      是人打的；早期版本没有这个字段，按真人处理。
 *   7. 正文只读 user/assistant/tool 四类事件；`*-chunks` 是完整回复的
 *      增量，读进来会重复。tool/result 的 callId 在 `data.message.source.callId`
 *      （实机 3859 条都没有顶层 `data.toolCallId`）。
 *   8. 追加写入被打断会留下半个帧；不能因为尾部残缺就让整场会话消失。
 *
 * 全部跑在假家目录里，不依赖、也不触碰本机真实数据。
 */

const scanner = await import('../src/scanners/dsh.js');

/** 一行 JSON。 */
function line(obj) {
  return JSON.stringify(obj) + '\n';
}

/** 多行 JSONL。 */
function jsonl(...objs) {
  return objs.map(line).join('');
}

/** 造一个 session header。createdAt 是毫秒时间戳（实机如此）。 */
function header({ id, cwd = 'E:/p', createdAt, parentSession }) {
  const h = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: parentSession ? 1 : 0,
  };
  if (parentSession) h.parentSession = parentSession;
  return h;
}

/** 一条事件：每行 {type, seq, time, data}，time 是毫秒。 */
function ev(type, time, data) {
  return { type, seq: 0, time, data };
}

/**
 * 把一批事件压成一帧。
 *
 * 这就是 dsh 的真实写法：每批事件单独 append 一帧。用 Node 24 的
 * zstdCompressSync 逐批压缩再拼接，得到和实机同构的多帧文件。
 */
function frame(...objs) {
  return zlib.zstdCompressSync(Buffer.from(jsonl(...objs), 'utf8'));
}

/** 在假家目录里写一场 dsh 会话。 */
function writeSession(box, { root = '.dsh', ws = '--E-p--', dir, file = 'session.v4.jsonl.zstd', content }) {
  return box.write(`${root}/sessions/${ws}/${dir}/${file}`, content);
}

test('dsh: .zstd 是多帧追加，后续帧里的事件必须读出来', async () => {
  const box = sandbox();
  try {
    // 这条锁的是"单帧解压"这个坑：真实文件 266 帧、每帧一批事件，
    // zstdDecompressSync 只解第一帧，拿到的只有一行 header。
    // 不锁的后果：每场会话都缺标题、缺结束时间，而且没有任何报错。
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const t2 = t0 + 2 * 60 * 1000;
    const t3 = t0 + 3 * 60 * 1000;
    const raw = Buffer.concat([
      // 第一帧只有 header，和实机的第一批写入一致
      frame(header({ id: 'multi-frame', cwd: 'E:/proj', createdAt: t0 })),
      frame(
        ev('session/title', t2, { title: 'DSH 起的标题', messageSeqs: [], source: { kind: 'user' } }),
        ev('user/message', t2, {
          id: 'm1',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '多帧里的第一句' }],
        })
      ),
      frame(
        ev('assistant/message', t3, {
          message: { role: 'assistant', content: [{ type: 'text', text: '多帧里的回答' }] },
        })
      ),
    ]);

    const file = writeSession(box, { dir: 'session-multi-frame', content: raw });

    // fixture 真的有多帧。**不要断言"原生解压读不到后续帧"**——
    // 那是版本相关的运行时行为：Node 24.12 只解第一帧，24.22 已经会解全部帧
    // （CI 上一跑就红）。测试只锁**我们自己的行为**：不论原生怎么表现，
    // 扫描器都必须读到后续帧里的内容。
    const native = zlib.zstdDecompressSync(raw).toString('utf8');
    const multi = scanner.decompressFrames(raw).toString('utf8');
    assert.ok(multi.includes('DSH 起的标题'), '逐帧解必须读到第二帧里的标题');
    assert.ok(multi.includes('多帧里的回答'), '逐帧解必须读到第三帧里的回答');
    assert.ok(
      multi.length >= native.length,
      '逐帧解的结果不该比原生解更少（原生在旧版本只解第一帧，逐帧解必须补上其余）'
    );

    await box.run(() => {
      const s = scanner.parse(file);
      assert.ok(s, '多帧文件不能被当成空会话');
      assert.equal(s.title, 'DSH 起的标题', '标题在第二帧里');
      assert.equal(s.end.toISOString(), new Date(t3).toISOString(), '结束时间在第三帧里');
      assert.equal(s.start.toISOString(), new Date(t0).toISOString());
      assert.equal(s.project, 'E:/proj');
    });
  } finally {
    box.cleanup();
  }
});

test('dsh: 数据根不只有 ~/.dsh，桌面版 ~/DeepSeekHarness 与 DSH_HOME 都要覆盖', async () => {
  const box = sandbox();
  try {
    // 这条锁的是"数据根写死成 ~/.dsh"的坑。Windows 桌面版自己把 DSH_HOME
    // 指到 ~/DeepSeekHarness，本机确实只有后者、没有 ~/.dsh。
    // 不锁的后果：在桌面版用户机器上一场都扫不到，doctor 还报"没装"。
    const t0 = Date.UTC(2026, 0, 1);
    const desktop = writeSession(box, {
      root: 'DeepSeekHarness',
      dir: 'session-desktop',
      file: 'session.jsonl',
      content: jsonl(
        header({ id: 'desktop-root', createdAt: t0 }),
        ev('user/message', t0 + 1000, { source: { kind: 'user' }, content: [{ type: 'text', text: '桌面版里的对话' }] })
      ),
    });
    const custom = writeSession(box, {
      root: 'custom-dsh',
      dir: 'session-custom',
      file: 'session.jsonl',
      content: jsonl(
        header({ id: 'custom-root', createdAt: t0 }),
        ev('user/message', t0 + 1000, { source: { kind: 'user' }, content: [{ type: 'text', text: 'DSH_HOME 里的对话' }] })
      ),
    });

    await box.run(() =>
      withEnv({ DSH_HOME: box.path('custom-dsh') }, () => {
        const files = scanner.discover();
        assert.equal(files.length, 2, '两个根各一场，不能只看到一个');
        assert.ok(files.includes(desktop), '桌面版默认目录必须被发现');
        assert.ok(files.includes(custom), 'DSH_HOME 覆盖必须优先生效');
        assert.deepEqual(files.map((f) => scanner.parse(f).id).sort(), ['custom-root', 'desktop-root']);
      })
    );
  } finally {
    box.cleanup();
  }
});

test('dsh: 同一 session 目录只取一个文件，版本号压过 mtime', async () => {
  const box = sandbox();
  try {
    // 这条锁的是"升级后旧文件不删"的坑：实机 3 个目录同时有
    // session.jsonl.zstd 和 session.v4.jsonl.zstd。全读会让同一场对话
    // 出现两次；只看 mtime 则可能选中升级前的旧文件（旧文件不一定更旧，
    // 比如被迁移工具重新 touch 过）。版本号必须优先。
    const t0 = Date.UTC(2026, 0, 1);
    const dir = 'session-upgrade';
    const oldFile = writeSession(box, {
      dir,
      file: 'session.jsonl.zstd',
      content: Buffer.concat([
        frame(
          header({ id: 'before-upgrade', createdAt: t0 }),
          ev('session/title', t0 + 1000, { title: '升级前的旧文件' })
        ),
      ]),
    });
    const v4File = writeSession(box, {
      dir,
      file: 'session.v4.jsonl.zstd',
      content: Buffer.concat([
        frame(
          header({ id: 'after-upgrade', createdAt: t0 }),
          ev('session/title', t0 + 1000, { title: '升级后的新文件' })
        ),
      ]),
    });

    // 故意让旧文件 mtime 更新：版本号仍是唯一可靠判据
    fs.utimesSync(oldFile, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    fs.utimesSync(v4File, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

    await box.run(() => {
      const files = scanner.discover();
      assert.equal(files.length, 1, '一个 session 目录只能产出一场会话');
      assert.equal(files[0], v4File, '必须选版本号最大的文件');
      const s = scanner.parse(files[0]);
      assert.equal(s.id, 'after-upgrade');
      assert.equal(s.title, '升级后的新文件');
    });
  } finally {
    box.cleanup();
  }
});

test('dsh: 子代理会话要采集并标记 kind/parent，不能整条丢掉', async () => {
  const box = sandbox();
  try {
    // 这条锁的是"子代理整条 return null"的旧行为。子代理文件里记着实际
    // 干的活，丢掉等于档案馆只存一半事实（实机 40 个 session 里 20 个是
    // 子代理）。下游默认按 kind === 'main' 过滤，所以留下来不会让时间线翻倍。
    const t0 = Date.UTC(2026, 0, 1);
    const parentId = 'session-parent-uuid';
    const childId = 'child-uuid';
    const main = writeSession(box, {
      dir: parentId,
      content: jsonl(
        header({ id: parentId, createdAt: t0 }),
        ev('user/message', t0 + 1000, { source: { kind: 'user' }, content: [{ type: 'text', text: '去查一下 X' }] })
      ),
    });
    const child = writeSession(box, {
      dir: childId,
      content: jsonl(
        header({ id: childId, createdAt: t0 + 2000, parentSession: parentId }),
        ev('user/message', t0 + 3000, { source: { kind: 'user' }, content: [{ type: 'text', text: '实际去查 X' }] })
      ),
    });

    await box.run(() => {
      assert.equal(scanner.discover().length, 2, '子代理不能被跳过');

      const m = scanner.parse(main);
      assert.equal(m.kind, 'main');
      assert.equal(m.parent, null);

      const c = scanner.parse(child);
      assert.ok(c, '子代理必须产出会话');
      assert.equal(c.id, childId, 'id 是自己，不是父会话');
      assert.equal(c.kind, 'subagent');
      assert.equal(c.parent, parentId, 'parent 指向 header.parentSession');
      assert.equal(c.title, '实际去查 X');
    });
  } finally {
    box.cleanup();
  }
});

test('dsh: fork 会话的 start 取事件时间包络，不用 header.createdAt', async () => {
  const box = sandbox();
  try {
    // 这条锁的是 fork 语义：新会话以原会话的事件开头，header.createdAt
    // 只是 fork 那一刻。用 header 当 start，半年历史的对话会显示成"刚刚开始"，
    // 时间线和时长全错。
    const forkedAt = Date.UTC(2026, 2, 1, 0, 0, 0);
    const originalStart = Date.UTC(2025, 11, 1, 0, 0, 0);
    const lastEvent = forkedAt + 10 * 60 * 1000;
    const file = writeSession(box, {
      dir: 'session-fork',
      content: jsonl(
        header({ id: 'forked', createdAt: forkedAt }),
        ev('user/message', originalStart, {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '半年前的原始问题' }],
        }),
        ev('assistant/message', forkedAt, {
          message: { role: 'assistant', content: [{ type: 'text', text: '历史回答' }] },
        }),
        ev('assistant/message', lastEvent, {
          message: { role: 'assistant', content: [{ type: 'text', text: 'fork 之后的新回答' }] },
        })
      ),
    });

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.start.toISOString(), new Date(originalStart).toISOString(), 'start 要取最早事件');
      assert.ok(s.start < new Date(forkedAt), 'start 必须早于 fork 时刻');
      assert.equal(s.end.toISOString(), new Date(lastEvent).toISOString());
    });
  } finally {
    box.cleanup();
  }
});

test('dsh: 只有 source.kind=user 算人话，标题不被注入消息抢走', async () => {
  const box = sandbox();
  try {
    // 这条锁的是标题来源。实机 user/message 有 13 种 source.kind：
    // runtime-context / time-context / skill-catalog / agent-instructions…
    // 它们都是 Agent 自己塞进来的，不是人打的。不加判断标题会变成
    // "当前时间 2026-01-01T…" 或一整页技能清单。
    const t0 = Date.UTC(2026, 0, 1);

    const kindFile = writeSession(box, {
      ws: '--E-a--',
      dir: 'session-kind',
      content: jsonl(
        header({ id: 'kind-filter', createdAt: t0 }),
        ev('user/message', t0 + 1000, {
          source: { kind: 'skill-catalog' },
          content: [{ type: 'text', text: '技能清单：一页很长的东西' }],
        }),
        ev('user/message', t0 + 2000, {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '真正的问题' }],
        })
      ),
    });

    const titleFile = writeSession(box, {
      ws: '--E-b--',
      dir: 'session-title',
      content: jsonl(
        header({ id: 'title-wins', createdAt: t0 }),
        ev('user/message', t0 + 1000, {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '用户自己说的第一句' }],
        }),
        ev('session/title', t0 + 2000, { title: 'DSH 起的名字', source: { kind: 'user' } })
      ),
    });

    const earlyFile = writeSession(box, {
      ws: '--E-c--',
      dir: 'session-early',
      content: jsonl(
        header({ id: 'early-no-source', createdAt: t0 }),
        // 早期版本没有 source 字段：没有 kind 时按真人处理
        ev('user/message', t0 + 1000, { content: [{ type: 'text', text: '早期版本没有 source' }] })
      ),
    });

    await box.run(() => {
      assert.equal(scanner.parse(kindFile).title, '真正的问题', '注入消息不能当标题');
      assert.equal(scanner.parse(titleFile).title, 'DSH 起的名字', 'dsh 自己的标题优先');
      assert.equal(scanner.parse(earlyFile).title, '早期版本没有 source', '缺 kind 按真人处理');
    });
  } finally {
    box.cleanup();
  }
});

test('dsh: 正文只读对话事件，流式增量不重复，tool/result 按 callId 配对', async () => {
  const box = sandbox();
  try {
    // 这条锁两件事：
    //   1. *-chunks（text-chunks / reasoning-chunks / tool-call-chunks）是
    //      assistant/message 的增量。读进来正文会出现两遍同样的回答。
    //   2. tool/result 的 callId 在 data.message.source.callId——实机 3859
    //      条结果没有一条带顶层 data.toolCallId。只读顶层字段会让工具名
    //      全部变成 unknown，配对彻底失效。
    const t0 = Date.UTC(2026, 0, 1);
    const file = writeSession(box, {
      dir: 'session-body',
      content: jsonl(
        header({ id: 'body', createdAt: t0 }),
        ev('user/message', t0 + 1000, {
          source: { kind: 'runtime-context' },
          content: [{ type: 'text', text: '系统注入的时间上下文' }],
        }),
        ev('user/message', t0 + 2000, {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '看看目录' }],
        }),
        ev('text-chunks', t0 + 3000, { text: '增量文本，不该出现' }),
        ev('reasoning-chunks', t0 + 3000, { text: '增量推理，不该出现' }),
        ev('assistant/message', t0 + 4000, {
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '先列一下目录' },
              { type: 'text', text: '好的' },
            ],
          },
        }),
        ev('tool/call', t0 + 5000, {
          callId: 'call_1',
          name: 'Bash',
          // dsh 把参数存成 JSON 字符串
          arguments: '{"command":"ls"}',
        }),
        ev('tool-call-chunks', t0 + 5000, { callId: 'call_1', chunk: '不该出现' }),
        ev('tool/result', t0 + 6000, {
          // 实机形状：正文在 message.content，callId 在 message.source
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'call_1' },
            toolCallId: 'call_1',
            content: [{ type: 'text', text: 'a.txt' }],
          },
        })
      ),
    });

    await box.run(() => {
      const s = scanner.parse(file);
      const msgs = scanner.readMessages(s);

      assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool'], '只有三类对话消息');
      assert.equal(msgs.length, 3, '流式增量与注入消息不能多出条目');

      assert.equal(msgs[0].parts[0].text, '看看目录');
      assert.equal(msgs[0].ts.toISOString(), new Date(t0 + 2000).toISOString());

      assert.deepEqual(
        msgs[1].parts.map((p) => p.kind),
        ['reasoning', 'text'],
        '推理和正文都要保留'
      );

      const tool = msgs[2].parts[0];
      assert.equal(tool.kind, 'tool');
      assert.equal(tool.name, 'Bash', 'callId 必须能从 message.source.callId 找回名字');
      assert.equal(tool.callId, 'call_1');
      assert.deepEqual(tool.input, { command: 'ls' }, 'arguments 里的 JSON 字符串要解析成对象');
    });
  } finally {
    box.cleanup();
  }
});

test('dsh: 尾部写了一半的帧不该让整场会话消失', async () => {
  const box = sandbox();
  try {
    // 这条锁的是追加写入被打断（进程被杀/断电）后的残缺帧。严格解压会
    // 在最后一帧抛错；如果因此整场返回 null，新会话就从档案里消失了
    // （registry 只能保留旧缓存，没有旧缓存就什么都没有）。
    const t0 = Date.UTC(2026, 0, 1);
    const complete = Buffer.concat([
      frame(header({ id: 'truncated-tail', createdAt: t0 })),
      frame(
        ev('session/title', t0 + 1000, { title: '写了一半也要留下' }),
        ev('user/message', t0 + 2000, {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '完整的两帧' }],
        })
      ),
    ]);
    // 第三帧只写了帧头和几个字节就断了
    const half = zlib.zstdCompressSync(
      Buffer.from(
        jsonl(
          ev('assistant/message', t0 + 3000, {
            message: { role: 'assistant', content: [{ type: 'text', text: '永远写不完的回答' }] },
          })
        ),
        'utf8'
      )
    );
    const raw = Buffer.concat([complete, half.subarray(0, 8)]);

    const file = writeSession(box, { dir: 'session-truncated', content: raw });

    await box.run(() => {
      const text = scanner.decompressFrames(raw).toString('utf8');
      assert.ok(text.includes('写了一半也要留下'), '完整帧必须保留');

      const s = scanner.parse(file);
      assert.ok(s, '尾部残缺不能让会话整场消失');
      assert.equal(s.title, '写了一半也要留下');
      assert.equal(s.end.toISOString(), new Date(t0 + 2000).toISOString());
    });
  } finally {
    box.cleanup();
  }
});

/**
 * 这条曾经是 skip：`readMessages` 从 `data.content` 取工具结果正文，而实机
 * v4 的 `tool/result` 把正文放在 `data.message.content`——本机 3859 条
 * `tool/result` 里 0 条有 `data.content`，3859 条都有 `data.message.content`。
 * 结果每个 tool 片段的 output 都是 null，"它干了什么"只剩工具名。
 * 2026-10-28 修好后转绿（保留了 data.content 回退，兼容旧写法）。
 */
test(
  'dsh: 工具结果正文在 data.message.content 里，必须读出来',
  async () => {
    const box = sandbox();
    try {
      const t0 = Date.UTC(2026, 0, 1);
      const file = writeSession(box, {
        dir: 'session-tool-output',
        content: jsonl(
          header({ id: 'tool-output', createdAt: t0 }),
          ev('user/message', t0 + 1000, {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '列一下目录' }],
          }),
          ev('tool/call', t0 + 2000, {
            callId: 'call_1',
            name: 'Bash',
            arguments: '{"command":"ls"}',
          }),
          ev('tool/result', t0 + 3000, {
            message: {
              role: 'tool',
              source: { kind: 'tool', callId: 'call_1' },
              toolCallId: 'call_1',
              content: [{ type: 'text', text: 'a.txt' }],
            },
          })
        ),
      });

      await box.run(() => {
        const s = scanner.parse(file);
        const msgs = scanner.readMessages(s);
        const tool = msgs.find((m) => m.role === 'tool');
        assert.ok(tool, '工具结果要单独成条');
        assert.equal(tool.parts[0].output, 'a.txt', '工具输出不能丢');
      });
    } finally {
      box.cleanup();
    }
  }
);
