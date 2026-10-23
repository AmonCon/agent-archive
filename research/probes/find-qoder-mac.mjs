#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 在 macOS 上找出 Qoder 的会话数据到底存在哪。
 *
 * 已知（Windows 上实测）：
 *   ~/.qoder/cache/projects/<项目>-<hash>/conversation-history/<id>/<id>.jsonl
 *
 * 但 macOS 上 Qoder 可能：
 *   - 仍用 ~/.qoder（多数跨平台应用如此）
 *   - 改用 ~/Library/Application Support/Qoder（VS Code 系常见）
 *   - 用变体名（QoderCN / com.qoder.app.stable / QoderWork）
 *
 * 这个脚本把这些地方都翻一遍，报告哪个是真的、里面有什么。
 */

const home = os.homedir();

const roots = [
  path.join(home, '.qoder'),
  path.join(home, '.qoder-cn'),
  path.join(home, '.qoder-cn'),
  path.join(home, 'Library', 'Application Support', 'Qoder'),
  path.join(home, 'Library', 'Application Support', 'QoderCN'),
  path.join(home, 'Library', 'Application Support', 'Qoder CN'),
  path.join(home, 'Library', 'Application Support', 'QoderWork'),
  path.join(home, 'Library', 'Application Support', 'QoderWork CN'),
  path.join(home, 'Library', 'Application Support', 'com.qoder.app.stable'),
  path.join(home, 'Library', 'Application Support', 'com.qodercn.app.stable'),
  path.join(home, 'Library', 'Preferences', 'com.qoder.app.stable'),
  path.join(home, '.config', 'Qoder'),
];

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? null : st.size;
  } catch {
    return null;
  }
}

const existing = [];
console.log('='.repeat(56));
console.log('找 Qoder 的数据目录');
console.log('='.repeat(56));
console.log();

for (const r of roots) {
  const st = sizeOf(r);
  if (st === null && !fs.existsSync(r)) continue;
  existing.push(r);
  console.log(`✓ ${r.replace(home, '~')}`);
}

if (!existing.length) {
  console.log('✗ 一个都没找到。');
  console.log();
  console.log('可能 Qoder 用的目录名不在上面的名单里。');
  console.log('试试手动看一下：');
  console.log('  ls ~/Library/Application\\ Support | grep -i qoder');
  console.log('  ls -a ~ | grep -i qoder');
  process.exit(0);
}

/* ---- 每个存在的目录往里看两层 ---- */

for (const root of existing) {
  console.log();
  console.log('='.repeat(56));
  console.log(root.replace(home, '~'));
  console.log('='.repeat(56));

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    console.log('  读不了:', e.code);
    continue;
  }

  console.log(`  ${entries.length} 个条目：`);
  for (const e of entries.slice(0, 25)) {
    const full = path.join(root, e.name);
    let note = '';
    if (e.isDirectory()) {
      try {
        const n = fs.readdirSync(full).length;
        note = `(${n} 项)`;
      } catch {
        note = '(无权限)';
      }
    } else {
      const s = sizeOf(full);
      note = s != null ? `(${(s / 1024).toFixed(0)} KB)` : '';
    }
    console.log(`    ${e.name} ${note}`);
  }
}

/* ---- 重点：找 conversation-history 或任何 jsonl ---- */

console.log();
console.log('='.repeat(56));
console.log('找会话文件（jsonl / conversation-history / *.db）');
console.log('='.repeat(56));

const hits = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(Cache|GPUCache|Code Cache|node_modules|logs?|CachedData)$/i.test(e.name)) continue;
      if (/conversation-history/i.test(e.name)) {
        let n = 0;
        try {
          n = fs.readdirSync(full).length;
        } catch {
          /* 忽略 */
        }
        hits.push({ kind: 'conversation-history', path: full, count: n });
      }
      walk(full, depth + 1);
    } else if (e.isFile()) {
      if (/\.jsonl$/i.test(e.name)) hits.push({ kind: 'jsonl', path: full, size: sizeOf(full) });
      else if (/\.(db|sqlite)$/i.test(e.name)) hits.push({ kind: 'sqlite', path: full, size: sizeOf(full) });
    }
  }
}

for (const root of existing) walk(root, 0);

if (!hits.length) {
  console.log('  ✗ 没找到任何会话文件。');
  console.log('  可能 Qoder 在这台机器上还没产生过对话，或数据在别的地方。');
} else {
  const byKind = { 'conversation-history': [], jsonl: [], sqlite: [] };
  for (const h of hits) byKind[h.kind].push(h);

  for (const [kind, list] of Object.entries(byKind)) {
    if (!list.length) continue;
    console.log();
    console.log(`  ${kind}: ${list.length} 项`);
    for (const h of list.slice(0, 10)) {
      const size = h.count != null ? `${h.count} 个子目录` : `${((h.size || 0) / 1024).toFixed(0)} KB`;
      console.log(`    ${h.path.replace(home, '~')}  ${size}`);
    }
    if (list.length > 10) console.log(`    …还有 ${list.length - 10} 项`);
  }
}

console.log();
console.log('='.repeat(56));
console.log('把整段输出发回来，我据此改扫描器。');
