import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { absProjectPath, projectKey, normalizeProject, sameProject, belongsTo } from '../src/model.js';

/**
 * 跨平台项目路径的契约。
 *
 * ## 这组测试为什么存在
 *
 * 这个工具要给所有人用，而归档里的路径**天生是跨平台的**：一个 Linux 用户
 * 可能读着 Windows 上备份出来的 `.claude/projects`，一台 Mac 可能装着从
 * 同事 Windows 机器拷来的 `.codex`。所以"项目路径怎么归一"不能假设当前平台。
 *
 * 曾经的写法是 `path.resolve(process.cwd(), p)`，它有两个真实的坑：
 *
 *   1. Linux 上查 `E:/my-app`（备份里记的）→ `/home/me/E:/my-app`，
 *      和记录永远匹配不上，用户看到的是"这个项目一场会话都没有"。
 *   2. `agent-archive demo` 在 macOS/Linux 上跑 `timeline E:/demo-project`
 *      同样落空——样例直接报"没有会话"。
 *
 * 这两条都在实测里复现过。下面把它们钉死。
 */

test('跨平台路径：别家的绝对路径要原样保留，不能被拼到 cwd 上', () => {
  const cwdLinux = '/home/me/code';

  // Windows 盘符路径（/ 与 \ 两种写法都要认）
  assert.equal(absProjectPath('E:/my-app', { cwd: cwdLinux }), 'E:/my-app');
  assert.equal(absProjectPath('E:\\my-app', { cwd: cwdLinux }), 'E:\\my-app');
  assert.equal(absProjectPath('c:/x', { cwd: cwdLinux }), 'c:/x');
  // 光杆盘符：`E:` 在 Windows 上表示"E 盘的当前目录"
  assert.equal(absProjectPath('E:', { cwd: cwdLinux }), 'E:');

  // UNC 路径
  assert.equal(absProjectPath('\\\\server\\share\\x', { cwd: cwdLinux }), '\\\\server\\share\\x');
  assert.equal(absProjectPath('//server/share/x', { cwd: cwdLinux }), '//server/share/x');

  // POSIX 绝对路径在 Windows 上也不该被拼盘符
  assert.equal(absProjectPath('/home/me/proj', { cwd: 'C:\\Users\\me' }), '/home/me/proj');
});

test('跨平台路径：真正的相对路径仍然拼 cwd', () => {
  const cwd = path.resolve('/home/me/code');
  assert.equal(absProjectPath('.', { cwd }), cwd);
  assert.equal(absProjectPath('my-app', { cwd }), path.resolve(cwd, 'my-app'));
  assert.equal(absProjectPath('../other', { cwd }), path.resolve(cwd, '../other'));
});

test('跨平台路径：空值与引号要处理掉，不能返回 "null" 这种字符串', () => {
  assert.equal(absProjectPath(null), null);
  assert.equal(absProjectPath(''), null);
  assert.equal(absProjectPath('   '), null);
  assert.equal(absProjectPath('"E:/my-app"', { cwd: '/x' }), 'E:/my-app');
  assert.equal(absProjectPath("'/home/me/x'", { cwd: '/x' }), '/home/me/x');
});

test('跨平台查询：Linux 上查 Windows 备份里记的项目能匹配上', () => {
  // 归档里记录的形态（Windows 写出来是反斜杠）
  const recorded = 'E:\\my-app';
  // 用户在 Linux 上照着备份里的路径敲
  const target = absProjectPath('E:/my-app', { cwd: '/home/me' });

  assert.equal(projectKey(target), projectKey(recorded), '两边归一成同一个项目键');
  assert.ok(sameProject(target, recorded), 'sameProject 也要认成同一个');
  assert.ok(belongsTo(recorded, projectKey(target)), '项目归属判断同样要成立');
});

test('跨平台查询：Windows 上查 macOS 备份里记的项目能匹配上', () => {
  const recorded = '/Users/alice/proj';
  const target = absProjectPath('/Users/alice/proj', { cwd: 'C:\\Users\\me' });
  assert.equal(projectKey(target), projectKey(recorded));
  assert.ok(belongsTo(recorded, projectKey(target)));
});

test('demo 的样例项目在三个平台上都能被自己的查询认出来', () => {
  // demo 用当前平台生成样例项目路径；这里模拟三种"跑 demo 的机器"，
  // 断言"命令参数"和"会话里记录的 cwd"归一后一致。
  const cases = [
    { project: 'E:/demo-project', cwd: 'C:\\Users\\me' },
    { project: '/home/me/demo-project', cwd: '/home/me' },
    { project: '/Users/me/demo-project', cwd: '/Users/me' },
  ];
  for (const { project, cwd } of cases) {
    const asArg = absProjectPath(project, { cwd });
    assert.equal(
      projectKey(asArg),
      projectKey(project),
      `${project} 作为命令参数时不该被改成别的路径`
    );
  }
});

test('项目键：大小写不敏感，分隔符统一成 /', () => {
  assert.equal(projectKey('E:\\My-App'), projectKey('e:/my-app'));
  assert.equal(normalizeProject('E:\\My-App\\'), 'E:/My-App');
  // 根目录保留尾部斜杠，否则 "/" 会被吃成空串
  assert.equal(normalizeProject('/'), '/');
});
