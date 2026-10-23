import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  userDataCandidates,
  dataCandidates,
  findUnder,
  candidatesWith,
  findExistingDir,
} from '../../src/platform.js';

/**
 * 跨平台路径解析的验证。
 *
 * 本机只有 Windows，所以用改写 process.platform 的方式检查各平台的
 * 首选路径是否符合约定。注意这不能替代真机验证——它只保证"给定平台
 * 值，选出的路径形状是对的"，不保证 macOS 上那些目录真的存在。
 */

const realPlatform = process.platform;
function withPlatform(p, fn) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

const home = os.homedir();
const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
const checks = [];
const push = (name, ok, detail = '') => checks.push([name, ok, detail]);

// 1. 各平台的首选路径
const winFirst = withPlatform('win32', () => userDataCandidates('Cursor')[0]);
const macFirst = withPlatform('darwin', () => userDataCandidates('Cursor')[0]);
const linuxFirst = withPlatform('linux', () => userDataCandidates('Cursor')[0]);

push(
  'Windows 首选 %APPDATA%',
  norm(winFirst).includes('/appdata/roaming/cursor') || norm(winFirst).endsWith('/cursor'),
  norm(winFirst).replace(norm(home), '~')
);
push(
  'macOS 首选 Library/Application Support',
  norm(macFirst).includes('/library/application support/cursor'),
  norm(macFirst).replace(norm(home), '~')
);
push(
  'Linux 首选 ~/.config',
  norm(linuxFirst).includes('/.config/cursor'),
  norm(linuxFirst).replace(norm(home), '~')
);

// 2. 候选列表要覆盖所有平台（换机/跨平台拷贝也能命中）
const all = withPlatform('win32', () => userDataCandidates('Cursor'));
push('候选含 macOS 位置', all.some((p) => norm(p).includes('/library/application support/cursor')));
push('候选含 Linux 位置', all.some((p) => norm(p).includes('/.config/cursor')));
push('候选去重', new Set(all.map(norm)).size === all.length, `${all.length} 个`);

// 3. 数据目录（XDG 风格）
const winData = withPlatform('win32', () => dataCandidates('opencode')[0]);
const linuxData = withPlatform('linux', () => dataCandidates('opencode')[0]);
push('Linux 数据目录 ~/.local/share', norm(linuxData).includes('/.local/share/opencode'), norm(linuxData).replace(norm(home), '~'));
push('Windows 数据目录 LOCALAPPDATA', norm(winData).includes('/appdata/local/opencode') || norm(winData).includes('/opencode'), norm(winData).replace(norm(home), '~'));

// 4. findUnder 真实生效：造一个临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-plat-'));
const appDir = path.join(tmp, 'Cursor');
fs.mkdirSync(path.join(appDir, 'User', 'globalStorage'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'User', 'globalStorage', 'state.vscdb'), 'x');

const found = findUnder([path.join(tmp, 'Nonexistent'), appDir], 'User/globalStorage/state.vscdb');
push('findUnder 跳过不存在的候选', !!found && norm(found).includes('/cursor/user/globalstorage/state.vscdb'));
push('findUnder 全不存在时返回 null', findUnder([path.join(tmp, 'nope')], 'x/y') === null);

const dirFound = findExistingDir([path.join(tmp, 'nope'), appDir]);
push('findExistingDir 找到真实目录', dirFound === appDir);

const cands = candidatesWith([path.join(tmp, 'a'), path.join(tmp, 'b')], 'User/x.db');
push('candidatesWith 返回全部候选', cands.length === 2, `${cands.length} 个`);
push('candidatesWith 用平台分隔符', cands.every((p) => p.includes('User')));

fs.rmSync(tmp, { recursive: true, force: true });

// 5. 各扫描器在真实平台上仍然找得到数据（Windows 实测）
const { scanAll } = await import('../../src/registry.js');
const { sessions } = scanAll({});
const byAgent = {};
for (const s of sessions) byAgent[s.agent] = (byAgent[s.agent] || 0) + 1;

push('Cursor 仍能扫到', (byAgent.cursor || 0) > 0, `${byAgent.cursor || 0} 场`);
push('Kiro 仍能扫到', (byAgent.kiro || 0) > 0, `${byAgent.kiro || 0} 场`);
push('Copilot 仍能扫到', (byAgent.copilot || 0) > 0, `${byAgent.copilot || 0} 场`);
push('OpenCode 仍能扫到', (byAgent.opencode || 0) > 0, `${byAgent.opencode || 0} 场`);

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}${detail !== '' ? '  (' + detail + ')' : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
