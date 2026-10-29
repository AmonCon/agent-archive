import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sandbox } from './helpers.js';

/**
 * CLI 层的用例。数量刻意很少：这一层只锁**入口不会崩**，
 * 逻辑本身在各自模块里测。
 */

/** 在隔离环境里跑一个子命令，返回 {code, out}。 */
function runCli(box, args) {
  const env = {
    ...process.env,
    USERPROFILE: box.home,
    HOME: box.home,
    AGENT_ARCHIVE_HOME: box.state,
    CODEX_HOME: '',
    CLAUDE_CONFIG_DIR: '',
  };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;

  try {
    const out = execFileSync(process.execPath, ['--no-warnings', 'src/cli.js', ...args], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('cli: timeline 在项目没有会话时给出提示，而不是崩掉', async () => {
  // 这个 bug 真出现过：空结果分支里引用了未定义的变量，于是「路径输错」
  // 和「项目确实没会话」这两种最常见的情况都变成一个 ReferenceError。
  // 越是出错的分支越没人走，越容易烂在那里。
  const box = sandbox();
  try {
    const empty = box.mkdir('work/nothing-here');
    const { code, out } = runCli(box, ['timeline', empty]);

    assert.equal(code, 0, `应该正常退出，实际输出：${out}`);
    assert.match(out, /下没有找到会话/);
    assert.doesNotMatch(out, /ReferenceError|is not defined/);
  } finally {
    box.cleanup();
  }
});

test('cli: timeline 能按项目归集跨 Agent 的会话', async () => {
  const box = sandbox();
  try {
    const project = path.join(box.dir, 'work', 'my-app');
    box.mkdir('work/my-app');

    // 两家、同一天、同一个项目
    box.write(
      '.codex/sessions/2026/03/02/rollout-a.jsonl',
      [
        JSON.stringify({
          timestamp: '2026-03-02T09:00:00Z',
          type: 'session_meta',
          payload: { id: 'a', session_id: 'a', cwd: project, timestamp: '2026-03-02T09:00:00Z' },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T09:10:00Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '来自 codex 的一句话' }] },
        }),
      ].join('\n') + '\n'
    );

    box.write(
      '.claude/projects/-my-app/c.jsonl',
      JSON.stringify({
        type: 'user',
        sessionId: 'c',
        cwd: project,
        timestamp: '2026-03-02T15:00:00Z',
        message: { role: 'user', content: '来自 claude 的一句话' },
      }) + '\n'
    );

    const { code, out } = runCli(box, ['timeline', project]);
    assert.equal(code, 0, out);
    assert.match(out, /codex/);
    assert.match(out, /claude-code/);
    assert.match(out, /2 个会话/);
  } finally {
    box.cleanup();
  }
});

test('cli: timeline 在会话很多时只给最近一段，并说明怎么看全部', async () => {
  // 真实项目上时间线能到一千多行（本机 924 场），第一屏会被淹没。
  // 这是显示窗口，不是裁剪数据：--all 必须仍然给全部。
  const box = sandbox();
  try {
    const project = path.join(box.dir, 'work', 'big');
    box.mkdir('work/big');

    const N = 130;
    const lines = [];
    for (let i = 0; i < N; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1 + (i % 20), 9, i % 60, 0)).toISOString();
      const id = 'big' + String(i).padStart(3, '0');
      lines.push(
        JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, session_id: id, cwd: project, timestamp: ts } }),
        JSON.stringify({
          timestamp: ts,
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第 ' + i + ' 场' }] },
        })
      );
    }
    // 每个 session_meta 开启一场会话，所以要写成多个文件
    for (let i = 0; i < N; i++) {
      const pair = lines.slice(i * 2, i * 2 + 2).join('\n') + '\n';
      box.write('.codex/sessions/2026/01/01/rollout-' + String(i).padStart(3, '0') + '.jsonl', pair);
    }

    const plain = runCli(box, ['timeline', project]);
    assert.equal(plain.code, 0, plain.out);
    assert.match(plain.out, new RegExp('共 ' + N + ' 场'));
    assert.match(plain.out, /看全部：--all/);

    const all = runCli(box, ['timeline', project, '--all']);
    assert.equal(all.code, 0, all.out);
    assert.doesNotMatch(all.out, /看全部：--all/);
    assert.ok(all.out.split('\n').length > plain.out.split('\n').length, '--all 应该比默认更长');
  } finally {
    box.cleanup();
  }
});
