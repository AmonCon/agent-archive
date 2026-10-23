#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * macOS / Linux 真机验证。
 *
 * 在有 Mac 或 Linux 机器上跑一次，回答一个问题：
 * **这台机器上的会话，我们真的读到了吗？**
 *
 * 静态检查（lint-portability）只能保证"没有 Windows 写死的东西"，
 * 证明不了"路径约定在这个系统上是对的"。这个脚本做实际验证。
 *
 * 用法：node research/probes/verify-mac.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cli = path.join(root, 'src', 'cli.js');

/** 把本地路径转成 import() 能吃的 URL。Windows 上尤其必须这么做。 */
const mod = (rel) => pathToFileURL(path.join(root, rel)).href;

const lines = [];
const say = (s = '') => {
  console.log(s);
  lines.push(s);
};

say('='.repeat(60));
say('agent-archive 跨平台验证');
say('='.repeat(60));
say();
say(`平台      ${process.platform}`);
say(`Node      ${process.version}`);
say(`家目录    ${os.homedir()}`);
say();

/* ------------------------------ 1. 路径约定 ------------------------------ */

const { userDataCandidates, dataCandidates } = await import(
  mod('src/platform.js')
);

say('--- 应用数据目录候选 ---');
for (const app of ['Cursor', 'Kiro', 'Code', 'Trae']) {
  const list = userDataCandidates(app);
  const exists = list.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  say(`${app}: ${exists.length ? '存在 → ' + exists[0].replace(os.homedir(), '~') : '都不存在'}`);
}

say();
say('--- 数据目录候选（OpenCode 用）---');
for (const app of ['opencode']) {
  const list = dataCandidates(app);
  const exists = list.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  say(`${app}: ${exists.length ? '存在 → ' + exists[0].replace(os.homedir(), '~') : '都不存在'}`);
}

/* ------------------------------ 2. 实际扫描 ------------------------------ */

say();
say('--- 实际采集 ---');

function run(args) {
  const r = spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    encoding: 'utf8',
    timeout: 300000,
    cwd: root,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const stats = run(['stats']);
say(stats.out.trim() || stats.err.trim());

/* ------------------------------ 3. 各 Agent 细查 ------------------------------ */

say();
say('--- 各 Agent 明细 ---');

const { scanAll, scanners } = await import(mod('src/registry.js'));
const { sessions } = scanAll({});
const byAgent = new Map();
for (const s of sessions) {
  if (!byAgent.has(s.agent)) byAgent.set(s.agent, []);
  byAgent.get(s.agent).push(s);
}

for (const sc of scanners) {
  const list = byAgent.get(sc.name) || [];
  let files = 0;
  try {
    files = sc.discover().length;
  } catch {
    files = -1;
  }
  if (!list.length) {
    say(`${sc.name.padEnd(13)} 0 场  ${files === 0 ? '（本机没有这个 Agent 的数据）' : `（${files} 个文件但解析出 0 场 → 需检查）`}`);
    continue;
  }
  const noProject = list.filter((s) => !s.project).length;
  say(`${sc.name.padEnd(13)} ${String(list.length).padStart(4)} 场  ${files} 个文件  无项目 ${noProject}`);
}

/* ------------------------------ 4. 正文可读性 ------------------------------ */

say();
say('--- 正文抽样（每家用均匀取样） ---');

const { readSessionContent } = await import(mod('src/query.js'));

for (const [agent, list] of byAgent) {
  const n = Math.min(3, list.length);
  const step = list.length > n ? (list.length - 1) / (n - 1) : 0;
  const sample = [];
  for (let i = 0; i < n; i++) sample.push(list[Math.round(i * step)]);

  let ok = 0;
  const errs = [];
  for (const s of sample) {
    try {
      const m = await readSessionContent(s);
      if (m.length) ok++;
      else errs.push('空正文');
    } catch (e) {
      errs.push(e && e.message ? e.message.slice(0, 60) : String(e));
    }
  }
  const mark = ok === n ? '✓' : ok === 0 ? '✗' : '!';
  say(`${mark} ${agent.padEnd(13)} ${ok}/${n}${errs.length ? '  ' + errs[0] : ''}`);
}

/* ------------------------------ 5. 项目归集 ------------------------------ */

say();
say('--- 项目归集（前 8 个）---');

const projects = run(['projects']);
say(
  projects.out
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 12)
    .join('\n')
);

/* ------------------------------ 6. 结论 ------------------------------ */

say();
say('='.repeat(60));
say('怎么判断结果');
say('='.repeat(60));
say();
say('1. 你在这台机器上用过的每个 Agent，都应该有 > 0 场会话。');
say('   某个 Agent 显示 "0 场" 但你知道用过它 → 路径没找对，请把该行发回来。');
say('2. 「无项目」的数字应该只有 Hermes（它本来就不绑定目录）。');
say('   其他 Agent 出现大量「无项目」→ 项目路径解码有问题。');
say('3. 正文抽样应当是 ✓。出现 ✗ 说明这个系统上的文件格式不同。');
say('4. 项目归集里应当看到你的真实项目路径，且形状符合本系统');
say('   （macOS/Linux 以 / 开头，Windows 是 X:/）。');
say();

// 写一份报告，方便贴回来
const reportPath = path.join(os.tmpdir(), 'agent-archive-platform-check.txt');
try {
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`完整报告已写入：${reportPath}`);
} catch {
  /* 无所谓 */
}
