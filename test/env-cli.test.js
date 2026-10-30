import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, withEnv } from './helpers.js';
import {
  commandProduct,
  detectCliInstalls,
  cliSummary,
  clearCliCaches,
  CLI_CATALOG,
} from '../src/env/cli.js';

/**
 * CLI 产品层的契约。
 *
 * 这一层有两个容易出错的地方：
 *   1. shell 命令的形态千奇百怪，识别规则不能把 `cd && 命令` 漏掉，
 *      也不能把管道后面的 `head` 当成产品。
 *   2. 可见范围是"按安装位置推断"的，系统目录和 Agent 私有目录必须分开。
 */

const EXE = process.platform === 'win32' ? '.exe' : '';

test('cli: 从 shell 命令里认出产品，不被 cd / 管道干扰', () => {
  assert.equal(commandProduct('aliyun ecs DescribeInstances --Region cn-hangzhou'), 'aliyun');
  assert.equal(commandProduct('C:\\tools\\supabase.exe db push'), 'supabase');
  assert.equal(commandProduct('npx -y @supabase/cli db push'), 'supabase');
  assert.equal(commandProduct('cd E:/app && npm run build'), 'npm');
  assert.equal(commandProduct('git log | head -20'), 'git');
  assert.equal(commandProduct('sudo -E aliyun oss ls'), 'aliyun');
  assert.equal(commandProduct('echo hi'), null);
  assert.equal(commandProduct('cd /tmp'), null);
});

test('cli: 目录里的二进制名不能重复映射到两个产品', () => {
  const seen = new Map();
  for (const p of CLI_CATALOG) {
    for (const b of p.binaries) {
      assert.ok(!seen.has(b), `${b} 同时属于 ${seen.get(b)} 和 ${p.id}`);
      seen.set(b, p.id);
    }
  }
});

test('cli: 系统 PATH 与 Agent 私有目录分开归因', async () => {
  const box = sandbox();
  try {
    const sys = box.mkdir('system-bin');
    box.write(`system-bin/aliyun${EXE}`, '');
    box.write(`.hermes/bin/uv${EXE}`, '');

    await box.run(async () => {
      clearCliCaches();
      await withEnv({ PATH: sys, PATHEXT: '.EXE;.CMD;.BAT' }, async () => {
        const installs = detectCliInstalls({ fresh: true });
        const aliyun = installs.get('aliyun');
        const uv = installs.get('uv');

        assert.ok(aliyun && aliyun.length, 'PATH 里的 aliyun 要被找到');
        assert.equal(aliyun[0].scope, 'system');

        assert.ok(uv && uv.length, '私有目录里的 uv 要被找到');
        assert.equal(uv[0].scope, 'agent');
        assert.deepEqual(uv[0].owners, ['hermes']);
      });
    });
  } finally {
    clearCliCaches();
    box.cleanup();
  }
});

test('cli: 私有安装只对那一家可见，系统安装对全部可见', async () => {
  const box = sandbox();
  try {
    const sys = box.mkdir('system-bin');
    box.write(`system-bin/gh${EXE}`, '');
    box.write(`.hermes/bin/uv${EXE}`, '');

    await box.run(async () => {
      clearCliCaches();
      await withEnv({ PATH: sys, PATHEXT: '.EXE;.CMD;.BAT' }, async () => {
        const r = cliSummary({ fresh: true, presentAgents: ['hermes', 'codex'] });
        const gh = r.products.find((p) => p.id === 'gh');
        const uv = r.products.find((p) => p.id === 'uv');

        assert.ok(gh, 'gh 应该出现在结果里');
        assert.equal(gh.scope, 'system');
        assert.deepEqual(gh.agents, ['codex', 'hermes']);

        assert.ok(uv, 'uv 应该出现在结果里');
        assert.equal(uv.scope, 'agent');
        assert.deepEqual(uv.privateOwners, ['hermes']);
        assert.ok(r.privateOnly.some((p) => p.id === 'uv'));

        // 隔离环境里没有全文索引，调用次数应该优雅降级
        assert.equal(r.usageReady, false);
      });
    });
  } finally {
    clearCliCaches();
    box.cleanup();
  }
});
