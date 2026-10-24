#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 跨平台路径审计：不动磁盘、不扫会话，只回答一个问题——
 * **在这台机器上，我们对每个 Agent 的路径假设对不对？**
 *
 * 为什么需要它：`verify-mac.mjs` 会真的扫一遍会话（慢，且要数据在），
 * 这个脚本只做路径层面的自检，秒级完成。两个配合用：
 *
 *   1. 先跑这个 → 看"假设"哪里不对（比如候选目录全都不存在）
 *   2. 再跑 verify-mac.mjs → 看"实际"读到多少
 *
 * 它检查四件事：
 *   A. 平台与家目录认得对不对
 *   B. 每个 Agent 的候选路径，哪些真实存在（这是断言的核心）
 *   C. 环境变量覆盖有没有被读进来
 *   D. 路径比较的大小写语义是否跟随文件系统
 *
 * 用法：
 *   node research/probes/audit-paths.mjs
 *   node research/probes/audit-paths.mjs --json
 *
 * 在 macOS 上跑它，输出的"存在/不存在"就是最直接的答案。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const mod = (rel) => pathToFileURL(path.join(root, rel)).href;

const json = process.argv.includes('--json');
const lines = [];
const say = (s = '') => {
  if (!json) console.log(s);
  lines.push(s);
};

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/* ------------------------------ A. 平台 ------------------------------ */

const platform = process.platform;
const home = os.homedir();

const PLATFORM_EXPECT = {
  darwin: 'macOS：应用数据在 ~/Library/Application Support，点目录在家目录',
  win32: 'Windows：应用数据在 %APPDATA%，部分在 %LOCALAPPDATA%',
  linux: 'Linux：XDG，~/.config 与 ~/.local/share',
};

say('='.repeat(66));
say('路径审计');
say('='.repeat(66));
say('');
say(`平台        ${platform}`);
say(`说明        ${PLATFORM_EXPECT[platform] || '未知平台'}`);
say(`家目录      ${home}`);
say(`Node        ${process.version}`);
say();

// macOS 上一个很容易踩的坑：家目录可能是 /var/... 的软链形式
if (platform === 'darwin') {
  try {
    const real = fs.realpathSync(home);
    if (real !== home) {
      say(`⚠️ 家目录是符号链接：${home} → ${real}`);
      say('   路径比较时必须 realpath，否则同一条路径会判不相等。');
      say();
    }
  } catch {
    /* 无所谓 */
  }
}

/* ------------------------------ B. 各 Agent 候选 ------------------------------ */

const { userDataCandidates, dataCandidates, envOverrides } = await import(mod('src/platform.js'));

const results = [];

/**
 * 每项：名字、环境变量、候选路径生成器、判定"这个位置有效"的方法。
 *
 * check 返回 true 表示"这里确实有数据"。不是"目录存在"——
 * 目录存在但空的情况太多了（装了个扩展就建目录）。
 */
const TARGETS = [
  {
    agent: 'claude-code',
    env: ['CLAUDE_CONFIG_DIR'],
    paths: () => {
      const dirs = [
        ...envOverrides(['CLAUDE_CONFIG_DIR']).map((p) =>
          path.basename(p) === 'projects' ? p : path.join(p, 'projects')
        ),
        path.join(home, '.claude', 'projects'),
        path.join(home, '.config', 'claude', 'projects'),
      ];
      return dirs;
    },
    check: (p) => isDir(p) && fs.readdirSync(p).some((d) => isDir(path.join(p, d))),
    note: '三平台都是 ~/.claude。~/Library/Application Support/Claude 是桌面应用，不是 CLI',
  },
  {
    agent: 'codex',
    env: ['CODEX_HOME'],
    paths: () => [
      ...envOverrides(['CODEX_HOME']),
      path.join(home, '.codex', 'sessions'),
      path.join(home, '.codex', 'archived_sessions'),
    ],
    check: (p) => isDir(p),
    note: '三平台都是 ~/.codex。桌面版的状态在 Application Support，但会话仍在这',
  },
  {
    agent: 'zcode',
    env: [],
    paths: () => [path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')],
    check: (p) => exists(p),
    note: '点目录，三平台一致',
  },
  {
    agent: 'opencode',
    env: ['OPENCODE_DATA_DIR', 'OPENCODE_DB', 'XDG_DATA_HOME'],
    paths: () => {
      const out = [];
      const db = process.env.OPENCODE_DB;
      if (db) out.push(db);
      const dd = process.env.OPENCODE_DATA_DIR;
      if (dd) out.push(path.join(dd, 'opencode.db'));
      const xdg = process.env.XDG_DATA_HOME;
      if (xdg) out.push(path.join(xdg, 'opencode', 'opencode.db'));
      out.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
      for (const r of dataCandidates('opencode')) out.push(path.join(r, 'opencode.db'));
      return out;
    },
    check: (p) => exists(p),
    note: '⚠️ macOS 也用 ~/.local/share，不是 Application Support（官方源码无 darwin 分支）',
  },
  {
    agent: 'qoder',
    env: ['QODER_CONFIG_DIR'],
    paths: () => {
      const out = [];
      const q = process.env.QODER_CONFIG_DIR;
      if (q) out.push(path.join(q, 'cache', 'projects'), q);
      out.push(
        path.join(home, '.qoder', 'cache', 'projects'),
        path.join(home, '.qoder-cn', 'cache', 'projects'),
        path.join(home, 'Library', 'Application Support', 'Qoder', 'cache', 'projects'),
        path.join(home, 'Library', 'Application Support', 'QoderCN', 'cache', 'projects')
      );
      return out;
    },
    check: (p) => isDir(p),
    note: '国际版/中国版是两套安装；macOS 上也可能在 Application Support',
  },
  {
    agent: 'hermes',
    env: ['HERMES_HOME'],
    paths: () => {
      const out = [];
      const h = process.env.HERMES_HOME;
      if (h) out.push(path.join(h, 'state.db'), path.join(h, 'sessions'));
      out.push(path.join(home, '.hermes', 'state.db'), path.join(home, '.hermes', 'sessions'));
      if (platform === 'win32' && process.env.LOCALAPPDATA) {
        out.push(path.join(process.env.LOCALAPPDATA, 'hermes', 'state.db'));
      }
      return out;
    },
    check: (p) => exists(p),
    note: '主存储是 state.db（SQLite），不是 sessions/*.jsonl；Windows 官方在 %LOCALAPPDATA%',
  },
  {
    agent: 'cursor',
    env: ['CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'],
    paths: () =>
      userDataCandidates('Cursor').map((r) => path.join(r, 'User', 'globalStorage', 'state.vscdb')),
    check: (p) => exists(p),
    note: 'VS Code 系：macOS 在 Application Support/Cursor',
  },
  {
    agent: 'kiro',
    env: ['KIRO_HOME'],
    paths: () =>
      userDataCandidates('Kiro').map((r) => path.join(r, 'User', 'globalStorage', 'kiro.kiroagent')),
    check: (p) => isDir(p),
    note: 'VS Code 系；正文在执行包里',
  },
  {
    agent: 'copilot',
    env: [],
    paths: () => userDataCandidates('Code').map((r) => path.join(r, 'User', 'workspaceStorage')),
    check: (p) => isDir(p),
    note: 'VS Code 系',
  },
  {
    agent: 'antigravity',
    env: ['ANTIGRAVITY_DATA_DIR'],
    paths: () => {
      const out = [];
      const a = process.env.ANTIGRAVITY_DATA_DIR;
      if (a) out.push(path.join(a, 'conversation_summaries.db'));
      out.push(path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db'));
      return out;
    },
    check: (p) => exists(p),
    note: '~/.gemini/antigravity；conversations/ 里的 .pb 是加密的',
  },
  {
    agent: 'gemini',
    env: ['GEMINI_CLI_HOME'],
    paths: () => {
      const out = [];
      const g = process.env.GEMINI_CLI_HOME;
      if (g) out.push(g);
      out.push(path.join(home, '.gemini'));
      // macOS 沙盒下会改道
      if (process.env.SANDBOX === 'sandbox-exec') out.push(path.join(home, '.cache', '.gemini'));
      return out;
    },
    check: (p) => isDir(p),
    note: 'macOS 在 sandbox-exec 下会改到 ~/.cache/.gemini',
  },
];

say('--- 各 Agent 的路径假设 ---');
say();

let missingAll = 0;

for (const t of TARGETS) {
  let paths;
  try {
    paths = t.paths();
  } catch (e) {
    paths = [];
  }

  // 去重再判断：同一路径可能被覆盖变量和默认值各生成一次
  //（opencode 的 ~/.local/share 就是这样出现两遍的）
  const uniqPaths = [];
  const seenPath = new Set();
  for (const p of paths) {
    if (!p) continue;
    const key = platform === 'linux' ? p : p.toLowerCase();
    if (seenPath.has(key)) continue;
    seenPath.add(key);
    uniqPaths.push(p);
  }

  const hits = uniqPaths.filter((p) => t.check(p));
  const row = {
    agent: t.agent,
    envVars: t.env,
    envSet: t.env.filter((n) => process.env[n]),
    candidates: uniqPaths.length,
    found: hits.length,
    foundPaths: hits,
    note: t.note,
  };
  results.push(row);

  const mark = hits.length ? '✓' : '✗';
  if (!hits.length) missingAll++;
  say(`${mark} ${t.agent.padEnd(13)} ${hits.length}/${uniqPaths.length} 个候选存在`);
  for (const p of hits) say(`     ${p.replace(home, '~')}`);
  const away = uniqPaths.filter((p) => !hits.includes(p));
  if (hits.length && away.length) {
    // 只显示前两个不存在的，免得刷屏
    for (const p of away.slice(0, 2)) say(`     · ${p.replace(home, '~')}（不存在）`);
  }
  say(`     ${t.note}`);
  say();
}

/* ------------------------------ C. 环境变量 ------------------------------ */

say('--- 环境变量覆盖 ---');
say('');
const ALL_ENV = [...new Set(TARGETS.flatMap((t) => t.env))];
const set = ALL_ENV.filter((n) => process.env[n]);
if (!set.length) {
  say('（本机没有设置任何 Agent 相关的环境变量）');
} else {
  for (const n of set) {
    const v = process.env[n];
    // 有些工具会自己导出默认值（Hermes 会把 HERMES_HOME 设成 ~/.hermes），
    // 那不是用户改的，标一下免得误以为有人动过配置
    const isDefaultish = v && path.resolve(v) === path.resolve(path.join(home, '.' + n.toLowerCase().replace(/_home$|_dir$/, '')));
    say(`${n} = ${v}${isDefaultish ? '  （看起来是工具自己导出的默认值，不是用户改的）' : ''}`);
  }
}
say('');
say(`支持的覆盖变量：${ALL_ENV.join(', ')}`);
say('');

/* ------------------------------ D. 大小写语义 ------------------------------ */

say('--- 路径比较语义 ---');
say();
const ci = platform === 'win32' || platform === 'darwin';
say(`平台默认${ci ? '大小写不敏感' : '大小写敏感'} → assertUnder / sameProject 跟随此语义`);
if (platform === 'darwin') {
  say('注意：macOS 可以挂载 case-sensitive 的 APFS 卷，那时上述假设不成立。');
  say('      这不是常见配置，但如果你把家目录放在这类卷上，请反馈。');
}
say();

/* ------------------------------ 结论 ------------------------------ */

say('='.repeat(66));
if (missingAll === 0) {
  say('所有 Agent 都至少有一个候选路径存在。');
} else {
  say(`${missingAll} 个 Agent 的候选路径全都不存在。`);
  say('如果其中某个你确定用过，说明路径假设在这台机器上不成立——');
  say(`请把 ${path.basename(process.argv[1] || 'audit-paths.mjs')} 的完整输出发回来。`);
}
say('='.repeat(66));

if (json) {
  console.log(
    JSON.stringify(
      {
        platform,
        home,
        results,
        envSet: Object.fromEntries(set.map((n) => [n, process.env[n]])),
        caseInsensitive: ci,
      },
      null,
      2
    )
  );
}

// 写一份报告
const report = path.join(os.tmpdir(), `agent-archive-paths-${platform}.txt`);
try {
  fs.writeFileSync(report, lines.join('\n'), 'utf8');
  if (!json) console.log(`\n报告已写入：${report}`);
} catch {
  /* 无所谓 */
}

process.exit(missingAll === 0 ? 0 : 1);
