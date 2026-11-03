import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, withEnv } from './helpers.js';
import { materialize } from './fixtures/index.js';

/**
 * 环境夹具：**同一份数据，不同的环境输入**。
 *
 * 数据夹具（`fixtures-contract.test.js`）证明"同样的字节，三个入口都读得对"；
 * 但上一轮修掉的那个真 bug 证明这不够——DSH 整家正文读不出来时，样本数据
 * 完全正常，坏的是环境变量（`DSH_HOME` 写成同一目录的小写变体）。
 *
 * 所以这一类用例的形状是：
 *   同一份样本 + 不同的 DSH_HOME / CODEX_HOME / WORKBUDDY_CONFIG_DIR
 *   → 结果必须一致（不多一场、不少一场、source 不被拼成多段、正文读得出）。
 *
 * 它们替代不了数据夹具，也**不能**被数据夹具替代：一个管"内容对不对"，
 * 一个管"输入变了还对不对"。
 */

const registry = await import('../src/registry.js');

/** 扫描并把该家的会话取出来（每个用例里环境已经设好）。 */
function scanFor(agent) {
  registry.clearScanCache();
  const r = registry.scanAll({ noCache: true });
  return { stats: r.stats, sessions: r.sessions.filter((s) => s.agent === agent) };
}

test('env fixture: DSH_HOME 写成同一目录的小写变体，仍是同一场会话', async () => {
  const box = sandbox();
  try {
    await box.run(() => materialize(box, 'dsh-multiframe'));

    await box.run(() => {
      const lower = box.path('.dsh').toLowerCase();
      return withEnv({ DSH_HOME: lower }, () => {
        const dsh = registry.scanners.find((s) => s.name === 'dsh');
        const files = dsh.discover();
        assert.equal(files.length, 1, '同一个目录经两种拼写只该发现一个文件');

        const { sessions } = scanFor('dsh');
        assert.equal(sessions.length, 1, '会话数不能因为环境变量多一份');
        assert.equal(
          String(sessions[0].source).includes('|'),
          false,
          'source 被拼成多段会让正文读取失败（ENOENT）'
        );
        const msgs = dsh.readMessages(sessions[0]);
        assert.ok(msgs.length > 0, '正文必须读得出来');
      });
    });
  } finally {
    box.cleanup();
  }
});

test('env fixture: CODEX_HOME 指向空目录时，默认根里的会话仍要被读到', async () => {
  const box = sandbox();
  try {
    await box.run(() => materialize(box, 'codex-3gen'));
    await box.run(() => {
      const emptyHome = box.path('empty-codex-home');
      box.mkdir('empty-codex-home');
      return withEnv({ CODEX_HOME: emptyHome }, () => {
        const { sessions } = scanFor('codex');
        assert.equal(sessions.length, 3, '默认根里的 3 场都要读到，不能只认 CODEX_HOME');
        const subs = sessions.filter((s) => s.kind === 'subagent');
        assert.equal(subs.length, 2, '两代子代理写法都要认出来');
      });
    });
  } finally {
    box.cleanup();
  }
});

test('env fixture: WORKBUDDY_CONFIG_DIR 指向别处时，默认根里的会话仍在', async () => {
  const box = sandbox();
  try {
    await box.run(() => materialize(box, 'workbuddy'));
    await box.run(() => {
      box.mkdir('other-workbuddy');
      return withEnv({ WORKBUDDY_CONFIG_DIR: box.path('other-workbuddy') }, () => {
        const { sessions } = scanFor('workbuddy');
        assert.equal(sessions.length, 1, '默认根 ~/.workbuddy 里的会话不能被环境变量顶掉');
      });
    });
  } finally {
    box.cleanup();
  }
});

test('env fixture: 用户配置里的 roots 覆盖优先于默认根', async () => {
  const box = sandbox();
  try {
    const { sampleBytes } = await import('./fixtures/index.js');
    const { clearConfigCache } = await import('../src/config.js');
    const fs = await import('node:fs');

    // 把 DSH 样本放到自定义根下，默认根里什么都不放：
    // 只有真的走了配置覆盖，才会扫描到这一场。
    const custom = box.path('custom-dsh');
    const target = path.join(custom, 'sessions', 'E--demo-project', 'dsh-multiframe-01', 'session.jsonl.zstd');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sampleBytes('dsh-multiframe.zstd'));

    await box.run(() => {
      fs.mkdirSync(box.state, { recursive: true });
      fs.writeFileSync(
        path.join(box.state, 'config.json'),
        JSON.stringify({ roots: { dsh: [custom] }, disabled: [] })
      );
      clearConfigCache();
      try {
        const { sessions } = scanFor('dsh');
        assert.equal(sessions.length, 1, '配置里的根要被扫描器采用');
      } finally {
        clearConfigCache();
      }
    });
  } finally {
    box.cleanup();
  }
});