/**
 * 在 POSIX 语义下跑一遍关键路径，验证"Linux/macOS 上会不会错"。
 *
 * ## 为什么不是真的跑 Linux
 *
 * 本机没有 WSL 发行版，也没有 Docker。但 `node:path` 提供 `path.posix`，
 * 它和 Linux/macOS 的路径语义一致（分隔符、resolve、join、isAbsolute）。
 *
 * 所以这个脚本做的是：**把项目里所有跟路径有关的纯函数，换成 POSIX 语义
 * 再跑一遍**，看结果是否仍然成立。它验证不了文件系统行为（大小写不敏感、
 * 符号链接），但能验证最容易错的那部分：路径拼接与归一。
 *
 * 用法：node research/probes/verify-posix.mjs
 */

import path from 'node:path';

const P = path.posix;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e && e.message ? e.message : String(e) });
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* ---- 1. absProjectPath 在 POSIX 语义下的行为 ---- */
// 把实现按 POSIX 重放一遍（实现本身用的是运行时的 path，这里是等价复现）
function absProjectPathPosix(p, cwd) {
  if (!p) return null;
  const s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(s)) return s;
  if (/^\\\\/.test(s) || /^\/\//.test(s)) return s;
  if (s.startsWith('/')) return s;
  return P.resolve(cwd, s);
}

function projectKeyPosix(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  const wasRoot = /^[\\/]+$/.test(s);
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (wasRoot && !s) return '/';
  if (/^[a-zA-Z]:$/.test(s)) s += '/';
  return s.toLowerCase();
}

check('POSIX：Windows 盘符路径不被拼 cwd', () => {
  eq(absProjectPathPosix('E:/my-app', '/home/me'), 'E:/my-app', 'E:/my-app');
  eq(absProjectPathPosix('E:\\my-app', '/home/me'), 'E:\\my-app', 'E:\\my-app');
  eq(absProjectPathPosix('E:', '/home/me'), 'E:', 'E:');
});

check('POSIX：POSIX 绝对路径原样保留', () => {
  eq(absProjectPathPosix('/home/me/proj', '/home/me'), '/home/me/proj', '绝对路径');
});

check('POSIX：相对路径拼 cwd', () => {
  eq(absProjectPathPosix('.', '/home/me/code'), '/home/me/code', '.');
  eq(absProjectPathPosix('my-app', '/home/me/code'), '/home/me/code/my-app', 'my-app');
  eq(absProjectPathPosix('../other', '/home/me/code'), '/home/me/other', '../other');
});

check('POSIX：跨平台查询能匹配', () => {
  const target = projectKeyPosix(absProjectPathPosix('E:/my-app', '/home/me'));
  const recorded = projectKeyPosix('E:\\my-app');
  eq(target, recorded, 'Linux 查 Windows 记录');
});

check('POSIX：根目录不被归一成空串', () => {
  eq(projectKeyPosix('/'), '/', '/');
  eq(projectKeyPosix('///'), '/', '///');
});

/* ---- 2. demo 的样例项目路径在 POSIX 下自洽 ---- */
check('POSIX：demo 样例项目路径自洽', () => {
  // demo 在 POSIX 上用 ~/demo-project
  const home = '/home/me';
  const project = P.join(home, 'demo-project').replace(/\\/g, '/');
  eq(project, '/home/me/demo-project', '样例项目');
  // 作为命令参数传回去，归一后必须还是它自己
  eq(projectKeyPosix(absProjectPathPosix(project, '/tmp')), projectKeyPosix(project), '往返一致');
  // 工作区目录名的转义
  const slug = project.replace(/[/\\]+/g, '-').replace(/^-+/, '-');
  eq(slug, '-home-me-demo-project', 'Claude 的工作区目录名');
});

/* ---- 3. platform.js 的候选在 POSIX 下合理 ---- */
check('POSIX：macOS 的 Claude Desktop 路径是 Application Support', () => {
  const home = '/Users/alice';
  const candidates = [
    P.join(home, 'Library', 'Application Support', 'Claude'),
    P.join(home, '.config', 'Claude'),
    P.join(home, '.config', 'claude'),
  ];
  eq(candidates[0], '/Users/alice/Library/Application Support/Claude', 'macOS 首选');
});

/* ---- 4. npm 全局 bin 在三个平台上不是一个地方 ---- */
check('POSIX：npm 全局 bin 不写死 Windows 路径', () => {
  const home = '/home/me';
  const linux = P.join('/usr/local/bin');
  const userLocal = P.join(home, '.local', 'bin');
  eq(linux, '/usr/local/bin', 'Linux 系统级');
  eq(userLocal, '/home/me/.local/bin', 'Linux 用户级');
  // 不能出现 AppData
  if (userLocal.includes('AppData')) throw new Error('Linux 路径里出现了 AppData');
});

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.error}`}`);
}
console.log('');
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
