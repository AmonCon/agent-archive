import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sandbox } from './helpers.js';

/**
 * 页面层落盘缓存的行为契约。
 *
 * 这两份缓存是"重启后第一次点能力面/侧栏不再等两秒"的关键，但它们的
 * 失效语义必须和原来的内存缓存一致：TTL 内命中，TTL 外重算。这里不测
 * TTL 本身（那要控制时钟），只锁"确实落盘了、清掉内存后还能命中"。
 */

const data = await import('../src/web/data.js');
const inventory = await import('../src/env/inventory.js');

function writeDshSession(box) {
  const dir = box.path('.dsh', 'sessions', 'E--p', 's1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session', id: 's1', createdAt: '2026-01-01T00:00:00Z', cwd: 'E:/p' }) +
      '\n' +
      JSON.stringify({ type: 'user/message', time: '2026-01-01T00:01:00Z', data: { content: 'hi' } }) +
      '\n'
  );
  return file;
}

test('web-cache: 最近项目落盘，清内存后仍能命中', async () => {
  const box = sandbox();
  try {
    const file = writeDshSession(box);
    await box.run(async () => {
      data.clearRecentProjectsCache();
      const first = await data.recentProjects();
      assert.equal(first.length, 1, '基线：应该看到 1 个项目');

      const cacheFile = path.join(box.state, 'cache', 'recent-projects-v1.json');
      assert.ok(fs.existsSync(cacheFile), '应该写出磁盘缓存');

      // 源会话删掉、内存缓存也清掉：TTL 内仍应从磁盘读出同一份列表
      fs.rmSync(file);
      data.clearRecentProjectsCache();
      const second = await data.recentProjects();
      assert.deepEqual(
        second.map((p) => p.key),
        first.map((p) => p.key),
        'TTL 内应命中磁盘缓存'
      );

      // 只读磁盘的模式不会为了侧栏去扫盘：缓存文件删掉后返回空
      fs.rmSync(cacheFile);
      data.clearRecentProjectsCache();
      assert.deepEqual(await data.recentProjects({ diskOnly: true }), [], 'diskOnly 不应触发扫描');
    });
  } finally {
    box.cleanup();
  }
});

test('web-cache: 能力面清单落盘，清内存后不再重扫技能目录', async () => {
  const box = sandbox();
  try {
    const skillDir = box.path('.claude', 'skills', 'demo-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 用来测缓存\n---\n\n正文\n'
    );

    await box.run(async () => {
      inventory.clearInventoryCache();
      const first = inventory.fullInventory();
      assert.ok(first.summary.skills >= 1, '基线：应该看到至少 1 个技能');

      const cacheFile = path.join(box.state, 'cache', 'inventory-v1.json');
      assert.ok(fs.existsSync(cacheFile), '应该写出能力面缓存');

      // 技能目录删掉、内存缓存清掉：TTL 内仍应返回同一份清单
      fs.rmSync(skillDir, { recursive: true, force: true });
      inventory.clearInventoryCache();
      const second = inventory.fullInventory();
      assert.equal(second.summary.skills, first.summary.skills, 'TTL 内应命中磁盘缓存');
    });
  } finally {
    box.cleanup();
  }
});
