import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import {
  configPath,
  loadUserConfig,
  extraRoots,
  disabledAgents,
  clearConfigCache,
} from '../src/config.js';
import { scanAll } from '../src/registry.js';

/**
 * 用户配置的契约。
 *
 * 这一层要解决的是"路径在别人机器上不一样"，所以测试重点：
 *   1. 配置里的根**真的**被扫描器用上了（不只是解析出来）
 *   2. disabled 真的让一家消失
 *   3. 配置写坏了只影响它自己，不能让整个工具起不来
 */

/** 在隔离状态目录里写配置。 */
function writeConfig(box, cfg) {
  const file = path.join(box.state, 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof cfg === 'string' ? cfg : JSON.stringify(cfg), 'utf8');
  clearConfigCache();
  return file;
}

test('config: 没有配置文件时是空配置（不是错误）', async () => {
  const box = sandbox();
  try {
    clearConfigCache();
    await box.run(() => {
      const cfg = loadUserConfig();
      assert.deepEqual(cfg.roots, {});
      assert.deepEqual(cfg.disabled, []);
      assert.equal(cfg.error, null);
    });
  } finally {
    clearConfigCache();
    box.cleanup();
  }
});

test('config: 解析 roots 与 disabled', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      writeConfig(box, { roots: { codex: ['D:/a', 'D:/b'], hermes: ['/mnt/h'] }, disabled: ['kiro'] });
      assert.deepEqual(extraRoots('codex'), ['D:/a', 'D:/b']);
      assert.deepEqual(extraRoots('hermes'), ['/mnt/h']);
      assert.deepEqual(extraRoots('nope'), []);
      assert.deepEqual([...disabledAgents()], ['kiro']);
    });
  } finally {
    clearConfigCache();
    box.cleanup();
  }
});

test('config: 坏 JSON 只让配置层失效，并带上原因', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      writeConfig(box, '{ this is not json');
      const cfg = loadUserConfig();
      assert.deepEqual(cfg.roots, {}, '当作空配置');
      assert.ok(cfg.error, '要把原因记下来给 doctor 显示');
    });
  } finally {
    clearConfigCache();
    box.cleanup();
  }
});

test('config: 改文件后重新读取（长驻进程也要能感知）', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      writeConfig(box, { roots: { codex: ['D:/one'] } });
      assert.deepEqual(extraRoots('codex'), ['D:/one']);

      // 推进 mtime，模拟用户在另一个窗口改配置
      const file = writeConfig(box, { roots: { codex: ['D:/two'] } });
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      clearConfigCache(); // 缓存键含 mtime，这里显式清掉更贴近真实读盘
      assert.deepEqual(extraRoots('codex'), ['D:/two']);
    });
  } finally {
    clearConfigCache();
    box.cleanup();
  }
});

test('config: 配置的根真的被扫描器用上（codex 外置数据）', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      // 外置盘上的 Codex 数据，不在家目录
      const ext = box.path('ext');
      const sid = '11111111-2222-3333-4444-555555555555';
      box.write(
        `ext/sessions/2026/01/01/rollout-x-${sid}.jsonl`,
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00Z',
          type: 'session_meta',
          payload: { id: sid, cwd: 'E:/external-proj' },
        }) +
          '\n' +
          JSON.stringify({
            timestamp: '2026-01-01T00:01:00Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '外置会话' }] },
          }) +
          '\n'
      );

      writeConfig(box, { roots: { codex: [ext] } });

      const r = scanAll({ noCache: true, only: ['codex'] });
      const found = r.sessions.find((s) => s.project === 'E:/external-proj');
      assert.ok(found, '配置里的根必须被扫到');
      assert.equal(found.agent, 'codex');
    });
  } finally {
    clearConfigCache();
    box.cleanup();
  }
});

test('config: disabled 让一家真的消失', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      const sid = '22222222-2222-3333-4444-555555555555';
      box.write(
        `.codex/sessions/2026/01/01/rollout-x-${sid}.jsonl`,
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00Z',
          type: 'session_meta',
          payload: { id: sid, cwd: 'E:/p' },
        }) +
          '\n' +
          JSON.stringify({
            timestamp: '2026-01-01T00:01:00Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          }) +
          '\n'
      );

      writeConfig(box, { disabled: [] });
      const on = scanAll({ noCache: true });
      assert.ok(on.sessions.some((s) => s.agent === 'codex'), '没禁用时应该有');

      writeConfig(box, { disabled: ['codex'] });
      const off = scanAll({ noCache: true });
      assert.equal(off.sessions.filter((s) => s.agent === 'codex').length, 0, '禁用后不该有');
    });
  } finally {
    clearConfigCache();
    box.cleanup();
  }
});

test('config: configPath 落在状态目录下（不进项目、不进家目录）', async () => {
  const box = sandbox();
  try {
    await box.run(() => {
      assert.ok(configPath().startsWith(box.state), `实际 ${configPath()}`);
      assert.ok(configPath().endsWith('config.json'));
    });
  } finally {
    box.cleanup();
  }
});
