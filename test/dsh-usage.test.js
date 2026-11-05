import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sandbox } from './helpers.js';
import { readUsage, summarizeUsage, SOURCES } from '../src/usage.js';

/**
 * DSH 用量源的口径契约。
 *
 * 这一源和别家最大的不同：token 不在单独的账本表里，而是散在会话事件的
 * `assistant/message.data.usage` 上。所以这里锁三件事：
 *
 *   1. 多帧 zstd 里第二帧之后的 usage 必须读出来（整段 zstdDecompressSync 只解第一帧）；
 *   2. `inputTokens` 的语义要**从 totalTokens 反推**，不能写死——
 *      上游哪天把缓存并进 input，这里应该变成 semantic='total' 把缓存减掉，
 *      而不是静默按全价算；
 *   3. 没有 `totalTokens` 时按实测形态当成 fresh，且不能因此丢记录。
 *
 * DSH 不报成本，所以 cost 必须是 null（不是 0）。
 */

const only = (...ids) => SOURCES.filter((s) => ids.includes(s.id));

function jsonl(...objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

/** 一个事件一帧——和 DSH 真实的 append 写法一致。 */
function frame(...objs) {
  return zlib.zstdCompressSync(Buffer.from(jsonl(...objs), 'utf8'));
}

function header(id, createdAt, cwd = 'E:/p') {
  return { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 };
}

function ev(type, time, data) {
  return { type, seq: 0, time, data };
}

function writeSession(box, { dir = 'session-x', ws = '--E-p--', content }) {
  const full = box.path('DeepSeekHarness', 'sessions', ws, dir, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const T0 = 1767225600000;

test('usage: DSH 从 assistant/message.data.usage 读 token，多帧文件不能只读第一帧', async () => {
  const box = sandbox();
  try {
    const raw = Buffer.concat([
      frame(header('s-1', T0)),
      frame(
        ev('assistant/message', T0 + 1000, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', source: { model: 'dsh-model' }, content: [] },
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 },
        })
      ),
      frame(ev('tool/result', T0 + 2000, { content: 'x'.repeat(2000) })),
      frame(
        ev('assistant/message', T0 + 3000, {
          turn: 1,
          step: 2,
          message: { role: 'assistant', source: { model: 'dsh-model' }, content: [] },
          usage: { inputTokens: 5, outputTokens: 1, reasoningTokens: 5 },
        })
      ),
    ]);
    writeSession(box, { content: raw });

    await box.run(async () => {
      const r = await readUsage({ sources: only('dsh') });
      assert.equal(r.ready, true);
      assert.equal(r.rows.length, 2, '第二帧之后的 usage 也要读出来');

      const [first, second] = r.rows;
      assert.equal(first.semantic, 'fresh', 'total = input+output+cacheRead → input 不含缓存');
      assert.equal(first.fresh, 100, 'fresh 就是 input 原值，不能再减缓存');
      assert.equal(first.cacheRead, 900);
      assert.equal(first.output, 10);
      assert.equal(first.calls, 1, 'DSH 是按请求记的');
      assert.equal(first.model, 'dsh-model');
      assert.equal(first.session, 's-1');
      assert.equal(first.cost, null, 'DSH 不报钱：null 不是 0');

      assert.equal(second.semantic, 'fresh', '没有 totalTokens 时按实测形态当 fresh');
      assert.equal(second.fresh, 5, '不能因为缺 totalTokens 就丢记录');

      const [g] = summarizeUsage({ rows: r.rows, groupBy: 'agent' });
      assert.equal(g.key, 'dsh');
      assert.equal(g.calls, 2);
      assert.equal(g.cacheHit, 900 / (900 + 100 + 5), '缓存读 ÷（缓存读 + 未缓存输入）');
      assert.deepEqual(g.semantics, ['fresh']);
    });
  } finally {
    box.cleanup();
  }
});

test('usage: DSH 如果 input 含缓存，靠 totalTokens 反推成 total 并减掉', async () => {
  const box = sandbox();
  try {
    // 模拟上游换口径：total = input + output（input 里已含 cacheRead）。
    // 这里 1010 = 1000 + 10，而 cacheRead 900 是 input 的子集。
    const raw = Buffer.concat([
      frame(header('s-total', T0)),
      frame(
        ev('assistant/message', T0 + 1000, {
          message: { role: 'assistant', source: { model: 'm' }, content: [] },
          usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 },
        })
      ),
    ]);
    writeSession(box, { dir: 'session-total', content: raw });

    await box.run(async () => {
      const r = await readUsage({ sources: only('dsh') });
      const [row] = r.rows;
      assert.equal(row.semantic, 'total');
      assert.equal(row.input, 1000, '原始 input 照原样留着，便于对账');
      assert.equal(row.fresh, 100, '1000 - 缓存读 900 = 100');
      assert.equal(row.cacheRead, 900);
    });
  } finally {
    box.cleanup();
  }
});

test('usage: DSH 的读法会落盘缓存，第二次不再重解压', async () => {
  const box = sandbox();
  try {
    const raw = Buffer.concat([
      frame(header('s-cache', T0)),
      frame(
        ev('assistant/message', T0 + 1000, {
          message: { role: 'assistant', source: { model: 'm' }, content: [] },
          usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, totalTokens: 10 },
        })
      ),
    ]);
    writeSession(box, { dir: 'session-cache', content: raw });

    await box.run(async () => {
      const once = await readUsage({ sources: only('dsh') });
      assert.equal(once.rows.length, 1);
      const cacheFile = path.join(box.state, 'cache', 'dsh-usage-v1.json');
      assert.equal(fs.existsSync(cacheFile), true, '缓存文件应写进 state 目录');
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.equal(cached.version, 1);
      assert.equal(Object.keys(cached.entries).length, 1);

      const twice = await readUsage({ sources: only('dsh') });
      assert.equal(twice.rows.length, 1, '命中缓存也必须给同样的行');
    });
  } finally {
    box.cleanup();
  }
});

test('usage: DSH 会话文件删掉后缓存条目也会被清掉', async () => {
  const box = sandbox();
  try {
    const make = (id) =>
      Buffer.concat([
        frame(header(id, T0)),
        frame(
          ev('assistant/message', T0 + 1000, {
            message: { role: 'assistant', source: { model: 'm' }, content: [] },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, totalTokens: 2 },
          })
        ),
      ]);
    writeSession(box, { dir: 'session-a', content: make('a') });
    const b = writeSession(box, { dir: 'session-b', content: make('b') });

    await box.run(async () => {
      const first = await readUsage({ sources: only('dsh') });
      assert.equal(first.rows.length, 2);
      const cacheFile = path.join(box.state, 'cache', 'dsh-usage-v1.json');
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries).length, 2);

      fs.rmSync(path.dirname(b), { recursive: true, force: true });
      const second = await readUsage({ sources: only('dsh') });
      assert.equal(second.rows.length, 1);
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries).length, 1);
    });
  } finally {
    box.cleanup();
  }
});

test('usage: 没有 DSH 目录时优雅降级，不抛错', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const r = await readUsage({ sources: only('dsh') });
      assert.equal(r.ready, false);
      assert.match(r.reports[0].reason, /DSH/);
    });
  } finally {
    box.cleanup();
  }
});

test('usage: DSH 尾部残缺帧保留已解出的记录', async () => {
  const box = sandbox();
  try {
    const complete = Buffer.concat([
      frame(header('s-torn', T0)),
      frame(
        ev('assistant/message', T0 + 1000, {
          message: { role: 'assistant', source: { model: 'm' }, content: [] },
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, totalTokens: 6 },
        })
      ),
    ]);
    // 追加半帧：模拟正在写入的会话文件
    const half = zlib.zstdCompressSync(Buffer.from(jsonl(ev('assistant/message', T0 + 2000, {
      message: { role: 'assistant', source: { model: 'm' }, content: [] },
      usage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, totalTokens: 27 },
    })), 'utf8')).subarray(0, 10);
    writeSession(box, { dir: 'session-torn', content: Buffer.concat([complete, half]) });

    await box.run(async () => {
      const r = await readUsage({ sources: only('dsh') });
      assert.equal(r.ready, true);
      assert.equal(r.rows.length, 1, '残缺尾帧不该让整场会话消失');
      assert.equal(r.rows[0].fresh, 1);
    });
  } finally {
    box.cleanup();
  }
});
