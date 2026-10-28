import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { platformInfo, userDataCandidates, dataCandidates } from '../src/platform.js';

/**
 * 锁住测试沙箱的隔离保证。
 *
 * 为什么值得单独一个文件：这个保证一旦破了，**测试会静默地读开发者的真实会话**——
 * 不报错、不变红，只是在开发者的机器上跑出一堆别人的数据，在 CI 上空空如也。
 * 本项目真踩过一次：装包自测的输出里冒出了开发者的真实项目名。
 *
 * 根因是平台默认根独立于家目录：`%APPDATA%` / `%LOCALAPPDATA%` / XDG 各自是
 * 独立的环境变量，Cursor、Kiro、Copilot、Hermes 走的是它们，不是 `~`。
 * 只换 `USERPROFILE` 挡不住。
 */

const under = (child, parent) =>
  String(child).replace(/\\/g, '/').toLowerCase().startsWith(String(parent).replace(/\\/g, '/').toLowerCase());

test('sandbox: 平台默认根也被隔离，不只家目录', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const info = platformInfo();
      for (const [k, v] of [
        ['appData', info.appData],
        ['localAppData', info.localAppData],
      ]) {
        if (!v) continue;
        assert.ok(under(v, box.dir), k + ' 应落在沙箱内，实际是 ' + v);
      }
    });
  } finally {
    box.cleanup();
  }
});

test('sandbox: 扫描器用的候选路径全部落在沙箱内', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const env = process.env;
      const home = env.USERPROFILE || env.HOME;
      // 这几家走的都是平台默认根，不是家目录下的点目录
      for (const app of ['Cursor', 'Kiro', 'Code']) {
        for (const p of userDataCandidates(app, { platform: process.platform, home, env })) {
          assert.ok(under(p, box.dir), app + ' 的候选路径跑出沙箱了: ' + p);
        }
      }
      for (const p of dataCandidates('opencode', { platform: process.platform, home, env })) {
        assert.ok(under(p, box.dir), 'opencode 的候选路径跑出沙箱了: ' + p);
      }
    });
  } finally {
    box.cleanup();
  }
});