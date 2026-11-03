import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import * as kiro from '../src/scanners/kiro.js';

/**
 * Kiro 的契约。
 *
 * 这一家最容易出错的地方不是解析失败，而是**解析成功但内容是错的**：
 * 会话文件里 assistant 的正文全是占位符 "On it."，真回复在相邻的执行包里，
 * 靠 `history[].executionId` 关联。只读会话文件的话，导出的对话看起来完整，
 * 实际每句助手回复都是 "On it."——不报错，只是没有信息量。
 *
 * 所以这里锁四件事：
 *   1. 占位符必须被丢弃，真回复必须从执行包里补回来
 *   2. executionId 找不到执行包时，退回占位符以外的正文，不崩
 *   3. 工作区目录名是 base64url(路径)，解得出来才用，解不出返回 null 而不是瞎猜
 *   4. `sessions.json` 是索引不是会话；非普通文件不读（防被指到根目录之外）
 */

/** 在假机器上造一份最小的 Kiro 存储，返回 agentRoot。 */
function seedKiro(box) {
  // 用扫描器自己声明的候选根来定位，避免测试写死各平台路径
  const base = kiro.candidateRoots()[0];
  const agentRoot = path.join(base, 'User', 'globalStorage', 'kiro.kiroagent');
  const sessions = path.join(agentRoot, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });

  // 一场会话：助手正文只有占位符，真回复在执行包里
  fs.writeFileSync(
    path.join(sessions, 's1.json'),
    JSON.stringify({
      sessionId: 's1',
      workspaceDirectory: 'e:/my-app',
      history: [
        { message: { role: 'user', content: [{ text: '刷新页面就掉登录态' }] } },
        {
          executionId: 'exec-1',
          message: { role: 'assistant', content: [{ text: 'On it.' }] },
        },
      ],
    })
  );

  // 索引文件：不是一场会话
  fs.writeFileSync(path.join(sessions, 'sessions.json'), JSON.stringify({ sessions: [{ id: 's1' }] }));

  // 执行包：布局 <agentRoot>/<hash>/<hash>/<file>，文件名不是 executionId，
  // 而且**不以 .json 结尾**（扫描器按扩展名跳过索引文件）
  const bundleDir = path.join(agentRoot, 'ab12', 'cd34');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'bundle'),
    JSON.stringify({
      executionId: 'exec-1',
      actions: [
        { actionType: 'say', output: JSON.stringify({ message: '真回复：token 过期时间设短了' }) },
        {
          actionType: 'tooluse_readFiles',
          input: JSON.stringify({ paths: ['src/auth.js'] }),
          actionState: 'success',
        },
      ],
    })
  );

  return agentRoot;
}

test('契约：占位符被丢弃，真回复从执行包补回来', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      seedKiro(box);
      const files = kiro.discover();
      const file = files.find((f) => f.endsWith('s1.json'));
      assert.ok(file, 'discover 应该找到 s1.json');

      const session = kiro.parse(file);
      assert.equal(session.id, 's1');
      assert.equal(session.project, 'e:/my-app', '会话里记的 workspaceDirectory 应优先');

      const msgs = kiro.readMessages(session);
      const parts = msgs.flatMap((m) => m.parts);
      const texts = parts.filter((p) => p.kind === 'text').map((p) => p.text);

      assert.ok(
        !texts.some((t) => /^on it\.?$/i.test(t.trim())),
        '占位符 "On it." 不该出现在正文里——那是 Kiro 的坑，不是助手说的话'
      );
      assert.ok(
        texts.some((t) => t.includes('token 过期时间设短了')),
        '真回复必须从 executionId 指向的执行包里补回来'
      );

      const tools = parts.filter((p) => p.kind === 'tool');
      assert.equal(tools.length, 1, '执行包里的 tooluse_ 动作应变成一个 tool part');
      assert.equal(tools[0].name, 'readFiles', 'tooluse_readFiles 的前缀应被剥掉');
      assert.deepEqual(tools[0].input, { paths: ['src/auth.js'] }, '工具入参应解析成对象');
    });
  } finally {
    box.cleanup();
  }
});

test('契约：执行包缺失时只丢占位符，不崩也不编', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const base = kiro.candidateRoots()[0];
      const sessions = path.join(base, 'User', 'globalStorage', 'kiro.kiroagent', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(
        path.join(sessions, 'orphan.json'),
        JSON.stringify({
          sessionId: 'orphan',
          history: [
            { message: { role: 'user', content: [{ text: '问一句' }] } },
            {
              executionId: 'nowhere',
              message: { role: 'assistant', content: [{ text: 'On it.' }] },
            },
          ],
        })
      );

      const session = kiro.parse(path.join(sessions, 'orphan.json'));
      const msgs = kiro.readMessages(session);
      const texts = msgs.flatMap((m) => m.parts).filter((p) => p.kind === 'text').map((p) => p.text);

      assert.ok(!texts.some((t) => /^on it\.?$/i.test(t.trim())), '找不到执行包时也要丢掉占位符');
      assert.equal(msgs.length, 1, '只剩用户那一句——不假装助手说过话');
    });
  } finally {
    box.cleanup();
  }
});

test('契约：工作区目录名按 base64url 解路径，解不出返回 null', () => {
  // 现算而非硬编码：这条契约是「目录名就是 base64url(真实路径)」，算一遍才说明它
  // 路径用占位项目名：测试是公开代码，不能带真实项目名
  const dir = Buffer.from('e:\\my-app', 'utf8').toString('base64url');
  assert.equal(kiro.decodeWorkspaceDir(dir), 'e:/my-app');

  // 解出来不是绝对路径就返回 null——不能拿一段普通文本当项目名
  const notAPath = Buffer.from('hello', 'utf8').toString('base64url');
  assert.equal(kiro.decodeWorkspaceDir(notAPath), null);

  // POSIX 绝对路径也认
  const posix = Buffer.from('/work/my-app', 'utf8').toString('base64url');
  assert.equal(kiro.decodeWorkspaceDir(posix), '/work/my-app');

  assert.equal(kiro.decodeWorkspaceDir(''), null);
  assert.equal(kiro.decodeWorkspaceDir(null), null);
});

test('契约：sessions.json 是索引不是会话，非普通文件不读', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      seedKiro(box);
      const files = kiro.discover();
      assert.ok(
        !files.some((f) => path.basename(f) === 'sessions.json'),
        'sessions.json 是全局索引，当成会话会让时间线里多出一条空记录'
      );
      for (const f of files) {
        assert.ok(fs.statSync(f).isFile(), 'discover 只该返回普通文件');
      }
    });
  } finally {
    box.cleanup();
  }
});