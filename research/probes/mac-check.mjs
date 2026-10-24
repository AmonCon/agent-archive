#!/usr/bin/env node
/**
 * macOS 体检 —— 单文件版，不需要仓库其它文件。
 *
 * 为什么单独做一个：在 Mac 上验证时，"先把仓库 clone 下来"本身就是一道门槛
 * （Node 版本、git、网络）。这个文件复制过去、`node mac-check.mjs` 就能跑完，
 * 输出一份可以直接贴回来的报告。
 *
 * 它做四件事：
 *   1. 环境自检（平台、Node 版本、家目录、是不是软链）
 *   2. 逐个 Agent 探路径：候选都在哪、哪个真实存在、有没有环境变量覆盖
 *   3. 探到的位置上，到底有多少会话文件
 *   4. 对 SQLite 类数据，只读打开看表结构（不改任何字节）
 *
 * 只读。不写任何 Agent 的目录，不在别人的数据里留文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const PLATFORM = process.platform;
const lines = [];
const say = (s = '') => {
  console.log(s);
  lines.push(s);
};

/**
 * SQLite 按需加载。
 *
 * 单文件脚本用 top-level await 直接 import 最稳；node:sqlite 在 Node 22+
 * 内置，但旧版本没有，所以要能优雅降级（那些 Agent 只报"文件存在"）。
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const tildify = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

/* ------------------------------ 1. 环境 ------------------------------ */

say('='.repeat(64));
say('agent-archive · macOS 体检');
say('='.repeat(64));
say();
say(`平台        ${PLATFORM}${PLATFORM === 'darwin' ? ' (macOS)' : ''}`);
say(`Node        ${process.version}`);
say(`家目录      ${HOME}`);
try {
  const real = fs.realpathSync(HOME);
  if (real !== HOME) say(`⚠️ 家目录是软链: ${HOME} → ${real}`);
} catch {
  /* 忽略 */
}
say(`CPU         ${os.arch()}`);
say(`macOS 版本  ${os.release()}`);
say();
say(`时间        ${new Date().toISOString()}`);
say();

/* ------------------------------ 2. 路径探测 ------------------------------ */

function env(n) {
  const v = process.env[n];
  return v && String(v).trim() ? String(v).trim() : null;
}

/**
 * 某个应用的用户数据根（把三个平台的约定都列出来）。
 *
 * 不按 platform 只挑一个：这个脚本的主要用途就是在 Mac 上跑，
 * 但如果用户先在自己的 Windows/Linux 上试跑，也应该能给出正确结果。
 * 候选全部列出、只认存在的那些——和主项目的策略一致。
 */
function appRoots(name) {
  const out = [
    path.join(HOME, 'Library', 'Application Support', name),
    path.join(HOME, '.config', name),
    path.join(HOME, '.config', name.toLowerCase()),
  ];
  if (env('APPDATA')) out.unshift(path.join(env('APPDATA'), name));
  return out;
}

function dataRoots(name) {
  const out = [
    path.join(HOME, '.local', 'share', name),
    path.join(HOME, 'Library', 'Application Support', name),
    path.join(HOME, '.config', name),
  ];
  if (env('LOCALAPPDATA')) out.unshift(path.join(env('LOCALAPPDATA'), name));
  return out;
}

const TARGETS = [
  {
    agent: 'claude-code',
    label: 'Claude Code',
    vars: ['CLAUDE_CONFIG_DIR'],
    candidates: () => [
      ...(env('CLAUDE_CONFIG_DIR')
        ? String(env('CLAUDE_CONFIG_DIR'))
            .split(',')
            .map((s) => {
              const p = s.trim();
              return p.endsWith('projects') ? p : path.join(p, 'projects');
            })
        : []),
      path.join(HOME, '.claude', 'projects'),
      path.join(HOME, '.config', 'claude', 'projects'),
    ],
    count: (p) => {
      let n = 0;
      try {
        for (const d of fs.readdirSync(p, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          try {
            n += fs.readdirSync(path.join(p, d.name)).filter((f) => f.endsWith('.jsonl')).length;
          } catch {}
        }
      } catch {}
      return n;
    },
    unit: '个 .jsonl 会话文件',
    note: '三平台都是 ~/.claude（官方文档）。Application Support/Claude 是桌面应用',
  },
  {
    agent: 'codex',
    label: 'Codex',
    vars: ['CODEX_HOME'],
    candidates: () => [
      ...(env('CODEX_HOME') ? String(env('CODEX_HOME')).split(',').map((s) => s.trim()) : []),
      path.join(HOME, '.codex'),
    ],
    count: (p) => {
      let n = 0;
      const walk = (d, lvl) => {
        if (lvl > 6) return;
        let ents;
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (e.isDirectory()) walk(path.join(d, e.name), lvl + 1);
          else if (/\.(jsonl|jsonl\.zst)$/.test(e.name)) n++;
        }
      };
      walk(path.join(p, 'sessions'), 0);
      walk(path.join(p, 'archived_sessions'), 0);
      return n;
    },
    unit: '个 rollout 文件',
    note: '三平台都是 ~/.codex',
  },
  {
    agent: 'zcode',
    label: 'ZCode',
    vars: [],
    candidates: () => [path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite')],
    count: (p) => (isFile(p) ? 1 : 0),
    unit: '个 db',
    note: '点目录，三平台一致',
  },
  {
    agent: 'opencode',
    label: 'OpenCode',
    vars: ['OPENCODE_DATA_DIR', 'OPENCODE_DB', 'XDG_DATA_HOME'],
    candidates: () => [
      ...(env('OPENCODE_DB') ? [env('OPENCODE_DB')] : []),
      ...(env('OPENCODE_DATA_DIR') ? [path.join(env('OPENCODE_DATA_DIR'), 'opencode.db')] : []),
      ...(env('XDG_DATA_HOME') ? [path.join(env('XDG_DATA_HOME'), 'opencode', 'opencode.db')] : []),
      ...dataRoots('opencode').map((r) => path.join(r, 'opencode.db')),
    ],
    count: (p) => (isFile(p) ? 1 : 0),
    unit: '个 db',
    note: '⚠️ macOS 也用 ~/.local/share（官方 global-roots.ts 无 darwin 分支）',
  },
  {
    agent: 'qoder',
    label: 'Qoder',
    vars: ['QODER_CONFIG_DIR'],
    candidates: () => [
      ...(env('QODER_CONFIG_DIR')
        ? [
            path.join(env('QODER_CONFIG_DIR'), 'cache', 'projects'),
            path.join(env('QODER_CONFIG_DIR'), 'projects'),
          ]
        : []),
      path.join(HOME, '.qoder', 'cache', 'projects'),
      path.join(HOME, '.qoder-cn', 'cache', 'projects'),
      ...appRoots('Qoder').map((r) => path.join(r, 'cache', 'projects')),
      ...appRoots('QoderCN').map((r) => path.join(r, 'cache', 'projects')),
    ],
    count: (p) => {
      let n = 0;
      try {
        for (const d of fs.readdirSync(p, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const h = path.join(p, d.name, 'conversation-history');
          try {
            n += fs.readdirSync(h).filter((x) => !x.startsWith('.')).length;
          } catch {}
        }
      } catch {}
      return n;
    },
    unit: '个会话目录',
    note: '国际版/中国版两套安装',
  },
  {
    agent: 'hermes',
    label: 'Hermes',
    vars: ['HERMES_HOME'],
    candidates: () => [
      ...(env('HERMES_HOME') ? [env('HERMES_HOME')] : []),
      path.join(HOME, '.hermes'),
      ...(PLATFORM === 'win32' && env('LOCALAPPDATA') ? [path.join(env('LOCALAPPDATA'), 'hermes')] : []),
    ],
    count: (p) => {
      const db = path.join(p, 'state.db');
      if (!isFile(db)) return 0;
      if (!DatabaseSync) return 1; // 没有 sqlite 就只报"库在"
      try {
        const d = new DatabaseSync(db, { readOnly: true });
        const n = d.prepare('select count(*) n from sessions').get().n;
        d.close();
        return n;
      } catch {
        return 1;
      }
    },
    unit: '场会话（state.db）',
    note: '主存储是 state.db，不是 sessions/*.jsonl；Windows 官方在 %LOCALAPPDATA%',
  },
  {
    agent: 'cursor',
    label: 'Cursor',
    vars: ['CURSOR_CONFIG_DIR'],
    candidates: () =>
      appRoots('Cursor').map((r) => path.join(r, 'User', 'globalStorage', 'state.vscdb')),
    count: (p) => (isFile(p) ? 1 : 0),
    unit: '个 state.vscdb',
    note: 'VS Code 系；macOS 在 Application Support',
  },
  {
    agent: 'kiro',
    label: 'Kiro',
    vars: ['KIRO_HOME'],
    candidates: () =>
      appRoots('Kiro').map((r) => path.join(r, 'User', 'globalStorage', 'kiro.kiroagent')),
    count: (p) => {
      let n = 0;
      try {
        n += fs.readdirSync(path.join(p, 'sessions')).filter((f) => f.endsWith('.json')).length;
      } catch {}
      try {
        for (const d of fs.readdirSync(path.join(p, 'workspace-sessions'), { withFileTypes: true })) {
          if (d.isDirectory()) n += 1;
        }
      } catch {}
      return n;
    },
    unit: '个会话文件/工作区',
    note: 'VS Code 系',
  },
  {
    agent: 'copilot',
    label: 'Copilot Chat',
    vars: [],
    candidates: () => appRoots('Code').map((r) => path.join(r, 'User', 'workspaceStorage')),
    count: (p) => {
      let n = 0;
      try {
        for (const d of fs.readdirSync(p, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const cs = path.join(p, d.name, 'chatSessions');
          try {
            n += fs.readdirSync(cs).length;
          } catch {}
        }
      } catch {}
      return n;
    },
    unit: '个 chatSessions 文件',
    note: 'VS Code 系',
  },
  {
    agent: 'antigravity',
    label: 'Antigravity',
    vars: ['ANTIGRAVITY_DATA_DIR'],
    candidates: () => [
      ...(env('ANTIGRAVITY_DATA_DIR')
        ? [path.join(env('ANTIGRAVITY_DATA_DIR'), 'conversation_summaries.db')]
        : []),
      path.join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db'),
    ],
    count: (p) => {
      if (!isFile(p)) return 0;
      if (!DatabaseSync) return 1;
      try {
        const d = new DatabaseSync(p, { readOnly: true });
        const n = d.prepare('select count(*) n from conversation_summaries').get().n;
        d.close();
        return n;
      } catch {
        return 1;
      }
    },
    unit: '条索引',
    note: '正文多在加密 .pb 里',
  },
  {
    agent: 'gemini',
    label: 'Gemini CLI',
    vars: ['GEMINI_CLI_HOME'],
    candidates: () => [
      ...(env('GEMINI_CLI_HOME') ? [env('GEMINI_CLI_HOME')] : []),
      path.join(HOME, '.gemini'),
      path.join(HOME, '.cache', '.gemini'),
    ],
    count: (p) => {
      let n = 0;
      const walk = (d, lvl) => {
        if (lvl > 3) return;
        let ents;
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (e.isDirectory()) walk(path.join(d, e.name), lvl + 1);
          else if (/^session-.*\.json$/.test(e.name)) n++;
        }
      };
      walk(path.join(p, 'tmp'), 0);
      return n;
    },
    unit: '个 session json',
    note: 'sanbox-exec 下会改到 ~/.cache/.gemini',
  },
];

say('--- 各 Agent 的路径 ---');
say();

const results = [];

for (const t of TARGETS) {
  let cands = [];
  try {
    cands = t.candidates().filter(Boolean);
  } catch {}

  // 去重（不区分大小写：macOS 默认不敏感）
  const uniq = [];
  const seen = new Set();
  for (const p of cands) {
    const k = p.toLowerCase().replace(/\/+$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }

  const hits = [];
  for (const p of uniq) {
    if (!isDir(p) && !isFile(p)) continue;
    let n = 0;
    try {
      n = t.count(p);
    } catch (e) {
      n = -1;
    }
    hits.push({ path: p, count: n });
  }

  const total = hits.reduce((s, h) => s + Math.max(0, h.count), 0);
  results.push({ agent: t.agent, hits, total, vars: t.vars.filter((v) => env(v)) });

  const mark = hits.length ? (total > 0 ? '✓' : '!') : '✗';
  say(`${mark} ${t.label.padEnd(14)} ${hits.length}/${uniq.length} 个候选存在，共 ${total} ${t.unit}`);
  for (const h of hits) {
    say(`     ${tildify(h.path)}  → ${h.count >= 0 ? h.count : '读不了'}`);
  }
  for (const p of uniq.filter((x) => !hits.some((h) => h.path === x)).slice(0, 3)) {
    say(`     · ${tildify(p)}（不存在）`);
  }
  const setVars = t.vars.filter((v) => env(v));
  if (setVars.length) say(`     环境变量: ${setVars.map((v) => `${v}=${env(v)}`).join(', ')}`);
  say(`     ${t.note}`);
  say();
}

/* ------------------------------ 3. 汇总 ------------------------------ */

say('='.repeat(64));
say('汇总');
say('='.repeat(64));
say();

const found = results.filter((r) => r.total > 0);
const present = results.filter((r) => r.hits.length > 0);
const none = results.filter((r) => !r.hits.length);

say(`路径存在的 Agent：${present.length}/${results.length}`);
say(`有数据可读的：    ${found.length}/${results.length}`);
say();
if (found.length) {
  say('有数据：');
  for (const r of found.sort((a, b) => b.total - a.total)) {
    say(`  ${r.agent.padEnd(14)} ${r.total}`);
  }
}
if (none.length) {
  say();
  say('路径全都不存在的（如果你用过它，说明路径假设错了）：');
  say('  ' + none.map((r) => r.agent).join(', '));
}

/* ------------------------------ 4. 报告 ------------------------------ */

say();
say('='.repeat(64));
const reportPath = path.join(os.tmpdir(), 'agent-archive-mac-check.txt');
try {
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\n报告已写入：${reportPath}`);
  console.log('把这个文件的内容发回来即可。');
} catch {
  console.log('\n（报告写入失败，直接复制上面的输出）');
}
