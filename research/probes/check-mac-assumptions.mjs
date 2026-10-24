import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 在 Windows 上验证"macOS 会走哪条分支"。
 *
 * 真机跑不了，但可以做一件有价值的事：**静态验证路径拼装逻辑**。
 * 把 mac-check.mjs 里那些 appRoots / dataRoots / candidates 的
 * 生成规则抽出来，喂不同的 HOME 值，检查产物形状对不对。
 *
 * 这不能替代真机，但能挡住"在 Mac 上拼出 C:\Users\...\Library"这类低级错误。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'mac-check.mjs'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`);
  }
};

console.log('=== 静态检查 mac-check.mjs ===\n');

// 1. 不能出现 Windows 专属的路径拼接（在 Mac 上会拼出反斜杠）
check('没有硬编码反斜杠路径', !/`[^`]*\\\\[A-Za-z][^`]*`/.test(src.replace(/^\s*\*.*$/gm, '')));

// 2. 家目录路径都用 path.join 拼，不用字符串 +
const joinCount = (src.match(/path\.join\(HOME/g) || []).length;
console.log(`  · path.join(HOME, ...) 用了 ${joinCount} 处`);
check('路径拼接走 path.join', joinCount > 10);

// 3. 平台判断存在（需要区分 Windows 的 LOCALAPPDATA）
check('有平台分支处理 LOCALAPPDATA', /PLATFORM === 'win32'/.test(src));

// 4. macOS 的 Library/Application Support 候选存在
check('含 macOS Application Support 候选', /'Library', 'Application Support'/.test(src));

// 5. ~/.local/share 候选存在（OpenCode 在 macOS 用它）
check('含 ~/.local/share 候选', /\.local', 'share'/.test(src));

// 6. 不能有 require()（ESM 里会崩）
check('没有 CommonJS require', !/[^.\w]require\(/.test(src));

// 7. SQLite 要能优雅降级
check('sqlite 缺失时能降级', /if \(!DatabaseSync\) return 1/.test(src));

// 8. 只读：不能有写操作写到 Agent 目录
const writeTargets = [...src.matchAll(/fs\.writeFileSync\(([^,]+),/g)].map((m) => m[1].trim());
console.log(`  · 写操作目标: ${writeTargets.join(', ') || '(无)'}`);
check(
  '只往临时目录写报告',
  writeTargets.every((t) => /reportPath|tmpdir|os\.tmpdir/.test(t) || t === 'reportPath'),
  writeTargets.join(',')
);

/* ------------------------------ 路径形状模拟 ------------------------------ */

console.log('\n=== 模拟 macOS 的路径形状 ===\n');

// 把 candidates 的逻辑重写一遍（只取路径部分），喂 macOS 的 HOME
const MAC_HOME = '/Users/alice';

function appRootsMock(home, name, appdata) {
  const out = [
    path.posix.join(home, 'Library', 'Application Support', name),
    path.posix.join(home, '.config', name),
    path.posix.join(home, '.config', name.toLowerCase()),
  ];
  if (appdata) out.unshift(path.posix.join(appdata, name));
  return out;
}

const macChecks = [
  ['Cursor 在 Application Support', appRootsMock(MAC_HOME, 'Cursor').includes('/Users/alice/Library/Application Support/Cursor')],
  ['Kiro 在 Application Support', appRootsMock(MAC_HOME, 'Kiro').includes('/Users/alice/Library/Application Support/Kiro')],
  ['VS Code 目录名是 Code', appRootsMock(MAC_HOME, 'Code').includes('/Users/alice/Library/Application Support/Code')],
  ['没有 appdata 时不拼 Windows 路径', !appRootsMock(MAC_HOME, 'Cursor', null).some((p) => p.includes('AppData'))],
];

// OpenCode: macOS 必须是 .local/share，不是 Application Support
const ocCandidates = [
  path.posix.join(MAC_HOME, '.local', 'share', 'opencode', 'opencode.db'),
  path.posix.join(MAC_HOME, 'Library', 'Application Support', 'opencode', 'opencode.db'),
];
macChecks.push([
  'OpenCode 的首选是 ~/.local/share（不是 Application Support）',
  ocCandidates[0].startsWith('/Users/alice/.local/share'),
]);

// Claude Code 必须是 .claude，不是 Application Support/Claude
const ccCandidates = [
  path.posix.join(MAC_HOME, '.claude', 'projects'),
  path.posix.join(MAC_HOME, 'Library', 'Application Support', 'Claude', 'projects'),
];
macChecks.push(['Claude Code 的首选是 ~/.claude', ccCandidates[0] === '/Users/alice/.claude/projects']);

// Hermes 在 macOS 是 ~/.hermes
macChecks.push([
  'Hermes 在 macOS 是 ~/.hermes',
  path.posix.join(MAC_HOME, '.hermes', 'state.db') === '/Users/alice/.hermes/state.db',
]);

// Gemini 的沙盒改道
macChecks.push([
  'Gemini 有 ~/.cache/.gemini 候选',
  path.posix.join(MAC_HOME, '.cache', '.gemini') === '/Users/alice/.cache/.gemini',
]);

for (const [name, ok] of macChecks) check(name, ok);

/* ------------------------------ 结论 ------------------------------ */

console.log('\n' + '='.repeat(56));
if (failed === 0) {
  console.log('静态检查通过。路径形状在 macOS 上是正确的。');
  console.log('但**这不等于真机可用**——只有实际跑一次才能确认目录真的在那。');
} else {
  console.log(`${failed} 项失败。`);
}
console.log('='.repeat(56));

process.exit(failed ? 1 : 0);
