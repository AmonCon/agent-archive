import { cursorProjectDir } from '../../src/scanners/cursor.js';
import { decodeWorkspaceDir } from '../../src/scanners/kiro.js';

/**
 * macOS 路径解码的验证。
 *
 * 核心关注点不是"能不能解出来"，而是**解不出来时会不会瞎猜**。
 * Cursor 的目录名编码有损（连字符既可能是分隔符也可能是项目名的一部分），
 * 编一个看起来合理的错路径会静默污染项目归集——那比留空难发现得多。
 */

const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

const realPlatform = process.platform;
function as(p, fn) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

/* ------------------------------ Cursor ------------------------------ */

// Windows 形态
const winCases = [
  ['c:\\Users\\X\\.cursor\\projects\\e-my-app', 'e:/my-app'],
  ['C:\\Users\\X\\.cursor\\projects\\d-work', 'd:/work'],
];
for (const [input, want] of winCases) {
  const got = as('win32', () => cursorProjectDir(input));
  push(`win: ${input.slice(-16)} → ${want}`, got === want, got || 'null');
}

// macOS 形态：Users-<name>-<rest>
const macCases = [
  ['/Users/alice/.cursor/projects/Users-alice-myapp', '/Users/alice/myapp'],
  ['/Users/alice/.cursor/projects/Users-alice-code-proj', '/Users/alice/code-proj'],
];
for (const [input, want] of macCases) {
  const got = as('darwin', () => cursorProjectDir(input));
  push(`mac: ${want}`, got === want, got || 'null');
}

// Linux 形态
const gotLinux = as('linux', () => cursorProjectDir('/home/bob/.cursor/projects/home-bob-proj'));
push('linux: /home/bob/proj', gotLinux === '/home/bob/proj', gotLinux || 'null');

// 认不出来的形态必须返回 null，而不是猜
const unknown = as('linux', () => cursorProjectDir('/srv/other/.cursor/projects/opt-something-app'));
push('未知形态返回 null（不瞎猜）', unknown === null, unknown || 'null');

// macOS 上不该把 Users 解成盘符 u:
const noDrive = as('darwin', () => cursorProjectDir('/Users/a/.cursor/projects/Users-a-p'));
push('macOS 上不误判盘符', noDrive !== null && !String(noDrive).startsWith('u:'), noDrive || 'null');

/* ------------------------------ Kiro ------------------------------ */

// Kiro 的目录名是 base64url(路径)，无损，跨平台都应该解得对
function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const kiroCases = [
  'e:\\my-app',
  '/Users/alice/my-project',
  '/home/bob/code/app',
];
for (const p of kiroCases) {
  const enc = b64url(p);
  const got = decodeWorkspaceDir(enc);
  push(`kiro: ${p}`, got === p.replace(/\\/g, '/'), got || 'null');
}

// 不是路径的 base64 应当拒绝
const notPath = decodeWorkspaceDir(b64url('hello world'));
push('kiro: 非路径返回 null', notPath === null, notPath || 'null');

/* ------------------------------ 结果 ------------------------------ */

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
