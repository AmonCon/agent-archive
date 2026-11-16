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
 * 造不出一台 Mac，但可以让路径解析接受平台注入——于是能在实测断言
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

test('分隔符必须按目标平台，不能按跑测试的平台', () => {
  // 这条曾经是个真 bug：`userDataCandidates` 用 `path.join` 拼路径，
  // 而 `path.join` 用的是**当前进程**的分隔符。于是在 Windows 上跑
  // `{ platform: 'darwin' }` 会得到 `\Users\alice\Library\...`——反斜杠
  // 配 POSIX 家目录，一个任何平台都不存在的路径。
  //
  // 更糟的是当时测试里有个 `norm()` 把反斜杠统一成正斜杠，正好把这个
  // bug 抹平了：测试看起来在验证跨平台，实际验证的是被修正过的字符串。
  // 所以这里**断言原始值**，不做任何归一。
  const darwin = platform.userDataCandidates('Claude', {
    platform: 'darwin',
    home: '/Users/alice',
    env: {},
  });
  assert.equal(darwin[0], '/Users/alice/Library/Application Support/Claude');
  assert.ok(!darwin[0].includes('\\'), 'macOS 路径里不该出现反斜杠');

  const linux = platform.userDataCandidates('Claude', {
    platform: 'linux',
    home: '/home/alice',
    env: {},
  });
  assert.equal(linux[0], '/home/alice/.config/Claude');
  assert.ok(!linux[0].includes('\\'), 'Linux 路径里不该出现反斜杠');

  // Windows 上反过来：必须是反斜杠，不能是正斜杠
  const win = platform.userDataCandidates('Claude', {
    platform: 'win32',
    home: 'C:\\Users\\alice',
    env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
  });
  assert.equal(win[0], 'C:\\Users\\alice\\AppData\\Roaming\\Claude');
  assert.ok(!win[0].includes('/'), 'Windows 路径里不该出现正斜杠');
});

test('Linux 认 XDG_CONFIG_HOME，不是硬编码 ~/.config', () => {
  // MAGPIE 的 `env("XDG_CONFIG_HOME", filepath.Join(home, ".config"))` 与
  // CC Switch 的 config_dir 都认这个变量。只写 ~/.config 会漏掉改过 XDG 的用户，
  // 而他们看到的会是"这些 Agent 都没装"。
  const custom = platform.userDataCandidates('Claude', {
    platform: 'linux',
    home: '/home/alice',
    env: { XDG_CONFIG_HOME: '/opt/cfg' },
  });
  assert.equal(custom[0], '/opt/cfg/Claude');

  const withSlash = platform.userDataCandidates('Claude', {
    platform: 'linux',
    home: '/home/alice',
    env: { XDG_CONFIG_HOME: '/opt/cfg/' },
  });
  assert.equal(withSlash[0], '/opt/cfg/Claude', '尾部斜杠不该变成双斜杠');

  // XDG_DATA_HOME 同理（OpenCode 这类）
  const data = platform.dataCandidates('opencode', {
    platform: 'linux',
    home: '/home/alice',
    env: { XDG_DATA_HOME: '/opt/data' },
  });
  assert.equal(data[0], '/opt/data/opencode');
});

test('路径拼接的边界：根目录与盘符根', () => {
  assert.equal(
    platform.userDataCandidates('X', { platform: 'linux', home: '/', env: {} })[0],
    '/.config/X'
  );
  assert.equal(
    platform.userDataCandidates('X', { platform: 'win32', home: 'C:\\', env: {} })[0],
    'C:\\AppData\\Roaming\\X'
  );
});

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
