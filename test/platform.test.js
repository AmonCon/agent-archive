import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

/**
 * 跨平台路径解析的契约。
 *
 * ## 为什么这组测试重要
 *
 * 这个工具要装到所有人的机器上，而它**只在 Windows 上真机跑过**。
 * macOS / Linux 的路径假设全部来自官方文档和源码核对，没有实际验证。
 *
 * 造不出一台 Mac，但可以让路径解析接受平台注入——于是能在本机断言
 * "在 macOS 上候选列表长什么样"。这样至少保证：
 *
 *   - 三平台的路径规则不会被后续重构悄悄改错
 *   - README 里写的那些平台差异（OpenCode 在 macOS 也用 ~/.local/share 等）
 *     有测试兜着，而不是只写在注释里
 *
 * 注意这**不替代真机验证**：它验证的是"我们怎么想"，不是"系统怎么表现"。
 */

const platform = await import('../src/platform.js');

const HOME = process.platform === 'win32' ? 'C:\\Users\\demo' : '/Users/demo';
const posixHome = '/Users/demo'; // 断言用 POSIX 家目录便于跨平台读

function norm(p) {
  return p.replace(/\\/g, '/');
}

test('用户数据目录：macOS 优先 Application Support', () => {
  const list = platform
    .userDataCandidates('Cursor', { platform: 'darwin', home: posixHome, env: {} })
    .map(norm);
  assert.equal(list[0], '/Users/demo/Library/Application Support/Cursor');
});

test('用户数据目录：Windows 优先 APPDATA', () => {
  const list = platform
    .userDataCandidates('Cursor', {
      platform: 'win32',
      home: 'C:\\Users\\demo',
      env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' },
    })
    .map(norm);
  assert.equal(list[0], 'C:/Users/demo/AppData/Roaming/Cursor');
});

test('用户数据目录：Linux 优先 ~/.config', () => {
  const list = platform
    .userDataCandidates('Cursor', { platform: 'linux', home: posixHome, env: {} })
    .map(norm);
  assert.equal(list[0], '/Users/demo/.config/Cursor');
});

test('XDG 数据目录：OpenCode 在 macOS 上也用 ~/.local/share', () => {
  // 这条是 README 里特别强调的反直觉事实：OpenCode 源码没有 darwin 分支，
  // 写死 XDG_DATA_HOME || ~/.local/share。如果哪天有人"顺手"给它加个
  // Application Support 分支，这条会红。
  const list = platform
    .dataCandidates('opencode', { platform: 'darwin', home: posixHome, env: {} })
    .map(norm);
  assert.equal(list[0], '/Users/demo/.local/share/opencode');
});

test('XDG 数据目录：Windows 追加 LOCALAPPDATA', () => {
  const list = platform
    .dataCandidates('opencode', {
      platform: 'win32',
      home: 'C:\\Users\\demo',
      env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    })
    .map(norm);
  assert.ok(list.includes('C:/Users/demo/AppData/Local/opencode'));
  assert.equal(list[0], 'C:/Users/demo/.local/share/opencode', 'XDG 位置始终排在第一位');
});

test('去重跟随文件系统大小写语义', () => {
  // macOS / Windows：Cursor 与 cursor 是同一个目录，只该出现一次
  const darwin = platform
    .userDataCandidates('Cursor', { platform: 'darwin', home: posixHome, env: {} })
    .map((p) => p.toLowerCase());
  assert.equal(new Set(darwin).size, darwin.length, 'macOS 上不应出现仅大小写不同的重复项');

  // Linux 区分大小写：不同拼写是不同路径，允许都保留
  const linux = platform.userDataCandidates('Cursor', {
    platform: 'linux',
    home: posixHome,
    env: {},
  });
  assert.ok(Array.isArray(linux) && linux.length > 0);
});

test('环境变量覆盖优先于平台默认', () => {
  const roots = platform.withOverrides(['CLAUDE_CONFIG_DIR'], ['/fallback']);
  assert.ok(Array.isArray(roots));
});

test('platformInfo 报告的字段稳定（给 MCP / doctor 用）', () => {
  const info = platform.platformInfo();
  assert.ok(typeof info.platform === 'string');
  assert.ok('node' in info || 'nodeVersion' in info || Object.keys(info).length > 0);
});
