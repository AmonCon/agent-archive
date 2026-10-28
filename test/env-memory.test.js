import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import { scanMemory, readMemory, projectFromDirName, titleOf } from '../src/env/memory.js';

/**
 * 环境层（记忆与指令）的契约。
 *
 * 这一层最容易做错的是**合并**：不同 Agent 的记忆可能互相矛盾，合并成
 * "你的记忆"是在说谎。所以产出只有"在哪、什么格式、多大"，正文不在这里返回。
 *
 * 第二个坑是 ZCode 的项目级记忆目录名：既有 `my-app-<16位hash>`，
 * 也有 `1792567885219-...` / `default-...` / `draft-...` 这类内部临时目录。
 * 后者如果当成项目名，"这个项目有哪些记忆"里就全是噪音。
 */

test('memory: 指令与记忆分开归类', async () => {
  const box = sandbox();
  try {
    box.write('.codex/AGENTS.md', '# 通用协作约定\n\n中文回答。');
    box.write('.codex/memories/MEMORY.md', '# 记忆\n\n- 用户偏好深色主题');

    await box.run(() => {
      const { items, totals } = scanMemory();
      const instr = items.find((i) => i.path.endsWith('AGENTS.md'));
      const mem = items.find((i) => i.path.endsWith(path.join('memories', 'MEMORY.md')));
      assert.equal(instr.kind, 'instruction');
      assert.equal(mem.kind, 'memory');
      assert.ok(totals.instructions >= 1 && totals.memories >= 1);
    });
  } finally {
    box.cleanup();
  }
});

test('memory: 这一层不返回正文（只给路径、类型、大小）', async () => {
  const box = sandbox();
  try {
    const body = '很大的一份记忆\n'.repeat(5000);
    box.write('.codex/memories/MEMORY.md', body);

    await box.run(() => {
      const { items } = scanMemory();
      const mem = items.find((i) => i.path.endsWith(path.join('memories', 'MEMORY.md')));
      assert.ok(mem, '要识别到这份记忆');
      assert.ok(mem.bytes > 1000, '要报大小');
      const flat = JSON.stringify(mem);
      assert.ok(!flat.includes('很大的一份记忆'), '扫描结果里不能夹带正文');
    });
  } finally {
    box.cleanup();
  }
});

test('memory: ZCode 项目级记忆按项目归集，内部临时目录不算项目', async () => {
  const box = sandbox();
  try {
    const base = '.zcode/cli/memories/projects';
    box.write(`${base}/my-app-0123456789abcdef/memory/note.md`, '# 项目记忆');
    box.write(`${base}/1792567885219-aaaaaaaaaaaaaaaa/memory/note.md`, '# 临时工作区');
    box.write(`${base}/default-bbbbbbbbbbbbbbbb/memory/note.md`, '# 默认');
    box.write(`${base}/draft-cccccccccccccccc/memory/note.md`, '# 草稿');

    await box.run(() => {
      const { items } = scanMemory();
      const projectScoped = items.filter((i) => i.scope === 'project');
      const named = projectScoped.filter((i) => i.project);
      assert.ok(
        named.some((i) => i.project === 'my-app'),
        '带哈希后缀的项目目录要剥出项目名'
      );
      assert.equal(
        named.filter((i) => /^(1792567885219|default|draft)/.test(String(i.project))).length,
        0,
        '内部临时目录不能冒充项目'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('memory: projectFromDirName 的解析规则', () => {
  // 正常的项目目录：剥掉 16 位哈希
  assert.equal(projectFromDirName('my-app-0123456789abcdef'), 'my-app');
  // 没有哈希：原样
  assert.equal(projectFromDirName('my-project'), 'my-project');
  // 内部临时目录 → null（不猜）
  assert.equal(projectFromDirName('1792567885219-abcdef1234567890'), null);
  assert.equal(projectFromDirName('default-abcdef1234567890'), null);
  assert.equal(projectFromDirName('draft-abc'), null);
  assert.equal(projectFromDirName('tmp-abc'), null);
  assert.equal(projectFromDirName('workspace-abc'), null);
  // 剥完还是 UUID 形状 → null
  assert.equal(projectFromDirName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), null);
});

test('memory: readMemory 只读开头，且拒绝越权路径', async () => {
  const box = sandbox();
  try {
    const body = 'A'.repeat(9000);
    box.write('.codex/memories/MEMORY.md', body);
    const secret = box.write('outside-secret.txt', '不该被读到');

    await box.run(() => {
      const target = path.join(box.home, '.codex', 'memories', 'MEMORY.md');
      const got = readMemory(target, { maxChars: 100 });
      assert.equal(got.totalChars, 9000);
      assert.equal(got.truncated, true);
      assert.equal(got.content.length, 100, '只返回开头这么多');

      // 不在已识别范围内的路径必须拒绝——防止用这个函数读任意文件
      assert.throws(() => readMemory(secret), /不在已识别的记忆范围内/);
    });
  } finally {
    box.cleanup();
  }
});

test('memory: titleOf 取第一行可读标题', () => {
  assert.equal(titleOf('# 我的记忆\n\n正文'), '我的记忆');
  assert.equal(titleOf('\n\n# 二级标题'), '二级标题');
  assert.ok(titleOf('') === '' || titleOf('') === null);
});
