import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import * as copilot from '../src/scanners/copilot.js';

/**
 * GitHub Copilot Chat 扫描器的格式契约。
 *
 * 这家的坑全是实测踩出来的：
 *
 *   1. **大量空会话**：文件存在不代表有对话，requests 为空的直接不列。
 *      实测 16 个文件里 14 个是空的——列出来就是把时间线塞满噪声。
 *   2. **.jsonl 是增量格式**：首行 {"kind":0,"v":"<完整JSON字符串>"}，
 *      后续行是补丁。补丁对读正文没帮助，只取首行快照。
 *   3. 项目路径不在会话文件里，在同级 workspace.json 的 folder 字段
 *      （file:///e%3A/my-app 这种 URI），要解码。
 *   4. 没有显式 role：用户正文 = requests[].message.text；
 *      助手正文 = response[] 里 kind 缺省或 text/plain 的 value；
 *      codeblockUri 是改动的文件引用，压成 edit 工具调用。
 */

/**
 * 在假机器上造 VS Code workspaceStorage 结构，返回 chatSessions 目录。
 *
 * **必须在 box.run() 里面调用**：candidateRoots() 是调用时读环境变量的
 * （%APPDATA% 要指进沙箱）。在 run 外面调它，拿到的是真实机器的路径，
 * 假数据会写进真实的 VS Code 数据目录——这是踩过的坑，不是理论风险。
 */
function buildCopilot(box) {
  const root = copilot.candidateRoots()[0];
  const ws = path.join(root, 'User', 'workspaceStorage', 'hash1');
  const cs = path.join(ws, 'chatSessions');
  fs.mkdirSync(cs, { recursive: true });

  // 有内容的 .json
  fs.writeFileSync(
    path.join(cs, 'abc.json'),
    JSON.stringify({
      sessionId: 'abc',
      creationDate: 1700000000000,
      lastMessageDate: 1700000600000,
      requests: [
        {
          timestamp: 1700000000000,
          message: { text: '帮我看看登录问题' },
          response: [
            { kind: 'text/plain', value: '是 token 过期时间设短了' },
            { kind: 'codeblockUri', uris: [{ uri: 'file:///e%3A/my-app/src/auth.js' }] },
          ],
        },
        {
          timestamp: 1700000300000,
          message: { text: '再看看购物车' },
          response: [{ value: '第二段回复，kind 缺省也该算正文' }],
        },
      ],
    })
  );

  // 空会话：文件存在，requests 是空的
  fs.writeFileSync(path.join(cs, 'empty.json'), JSON.stringify({ sessionId: 'empty', requests: [] }));

  // .jsonl 增量格式：首行是完整快照（v 字段包着），第二行是补丁
  const inner = JSON.stringify({
    sessionId: 'inc',
    creationDate: 1700005000000,
    requests: [{ timestamp: 1700005000000, message: { text: 'jsonl 增量格式的会话' } }],
  });
  fs.writeFileSync(
    path.join(cs, 'inc.jsonl'),
    JSON.stringify({ kind: 0, v: inner }) + '\n' + JSON.stringify({ kind: 1, patch: true }) + '\n'
  );

  // 工作区路径
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///e%3A/my-app' }));
  return root;
}

test('copilot: 空会话不列，.json 取结构，.jsonl 只取首行快照', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const root = buildCopilot(box);
      const files = copilot.discover();
      assert.equal(files.length, 3, '三个文件都被发现（包括空会话）');

      const parsed = files.map((f) => copilot.parse(f)).filter(Boolean);
      assert.equal(parsed.length, 2, 'requests 为空的会话不列——文件存在不代表有对话');

      const byId = new Map(parsed.map((s) => [s.id, s]));
      const abc = byId.get('abc');
      assert.ok(abc, '有内容的会话要采到');
      assert.equal(abc.project, 'e:/my-app', 'workspace.json 的 folder URI 要解码成真路径');
      assert.equal(abc.title, '帮我看看登录问题', '标题 = 第一句用户输入');
      assert.equal(Number(abc.start), 1700000000000, 'creationDate 是开始时间');
      assert.equal(Number(abc.end), 1700000600000, 'lastMessageDate 是结束时间');

      const inc = byId.get('inc');
      assert.ok(inc, '.jsonl 增量格式要能读');
      assert.equal(inc.title, 'jsonl 增量格式的会话', '只取首行快照——第二行的补丁被忽略');
    });
  } finally {
    box.cleanup();
  }
});

test('copilot: 正文按轮配对，codeblockUri 压成 edit 工具调用', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      buildCopilot(box);
      const files = copilot.discover();
      const abcFile = files.find((f) => f.endsWith('abc.json'));
      const s = copilot.parse(abcFile);
      const msgs = copilot.readMessages(s);

      // 一轮 = 一条用户 + 一条助手，两轮共四条
      assert.equal(msgs.length, 4);
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[0].parts[0].text, '帮我看看登录问题');
      assert.equal(msgs[1].role, 'assistant');

      const a1parts = msgs[1].parts;
      assert.ok(a1parts.some((p) => p.kind === 'text' && p.text === '是 token 过期时间设短了'), 'text/plain 的回复是正文');
      const edit = a1parts.find((p) => p.kind === 'tool');
      assert.ok(edit, 'codeblockUri 是改动的文件，要保留"动了哪个文件"这个信息');
      assert.equal(edit.name, 'edit');
      assert.deepEqual(edit.input, { file_path: 'e:/my-app/src/auth.js' });

      // 第二轮：response 里 kind 缺省的 value 也要算正文
      assert.equal(msgs[2].parts[0].text, '再看看购物车');
      assert.ok(
        msgs[3].parts.some((p) => p.kind === 'text' && p.text.includes('kind 缺省也该算正文')),
        'kind 缺省按 text/plain 处理——按字段存在与否猜会漏'
      );
    });
  } finally {
    box.cleanup();
  }
});