#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 这台机器上到底装了什么 AI 编程工具？
 *
 * verify-mac 只检查我们已知的路径。如果全都不存在，需要先确认
 * 是"路径找错了"还是"确实没装"。这个脚本做穷举式排查：
 * 列家目录下所有点目录，并按名字匹配已知的 Agent。
 */

const home = os.homedir();

const known = {
  'Claude Code': ['.claude', '.claude.json'],
  Codex: ['.codex'],
  ZCode: ['.zcode'],
  Cursor: ['.cursor', 'Library/Application Support/Cursor'],
  'VS Code': ['Library/Application Support/Code'],
  Kiro: ['.kiro', 'Library/Application Support/Kiro'],
  Trae: ['.trae', '.trae-cn', 'Library/Application Support/Trae'],
  Qoder: ['.qoder', '.qoder-cn'],
  Hermes: ['.hermes'],
  OpenCode: ['.local/share/opencode', '.opencode'],
  Antigravity: ['.gemini/antigravity', '.gemini'],
  Cline: ['.cline'],
  Windsurf: ['.codeium', '.windsurf'],
  Copilot: ['Library/Application Support/Code/User/workspaceStorage'],
};

console.log('='.repeat(56));
console.log(`这台机器：${process.platform} / ${os.homedir()}`);
console.log('='.repeat(56));
console.log();

console.log('--- 已知 AI 编程工具 ---');
const found = [];
for (const [name, rels] of Object.entries(known)) {
  const hits = [];
  for (const rel of rels) {
    const p = path.join(home, rel);
    try {
      const st = fs.statSync(p);
      hits.push({ rel, isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size });
    } catch {
      /* 不存在 */
    }
  }
  if (hits.length) {
    found.push(name);
    for (const h of hits) {
      const size = h.size != null ? ` (${(h.size / 1024).toFixed(0)} KB)` : '';
      console.log(`  ✓ ${name.padEnd(13)} ~/${h.rel}${size}`);
    }
  } else {
    console.log(`  ✗ ${name.padEnd(13)} 没有`);
  }
}

console.log();
console.log(`找到了 ${found.length} 个：${found.join('、') || '（一个都没有）'}`);
console.log();

/* ---- 家目录下所有点目录，看有没有我们没列到的 ---- */
console.log('--- 家目录下的点目录（前 40 个）---');
try {
  const entries = fs
    .readdirSync(home, { withFileTypes: true })
    .filter((e) => e.name.startsWith('.') && e.isDirectory())
    .map((e) => e.name)
    .sort();
  console.log(`  共 ${entries.length} 个`);
  for (const e of entries.slice(0, 40)) {
    // 标出可能是 AI 工具的
    const maybe = /claude|codex|cursor|zcode|trae|qoder|hermes|opencode|gemini|cline|windsurf|kiro|codeium|copilot|ai|gpt|llm|agent/i.test(e);
    console.log(`  ${maybe ? '→' : ' '} ${e}`);
  }
} catch (e) {
  console.log('  读不了:', e.message);
}

/* ---- Application Support ---- */
console.log();
console.log('--- ~/Library/Application Support（前 30 个）---');
try {
  const asDir = path.join(home, 'Library', 'Application Support');
  const entries = fs
    .readdirSync(asDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  console.log(`  共 ${entries.length} 个`);
  for (const e of entries.slice(0, 30)) {
    const maybe = /code|cursor|trae|qoder|kiro|claude|gemini|copilot|windsurf|cline|zed/i.test(e);
    console.log(`  ${maybe ? '→' : ' '} ${e}`);
  }
} catch (e) {
  console.log('  读不了:', e.message);
}

console.log();
console.log('='.repeat(56));
console.log('怎么看');
console.log('='.repeat(56));
console.log();
console.log('如果「已知 AI 编程工具」里大部分是 ✗，说明这台 Mac 上确实没装。');
console.log('如果某个工具是 ✓ 但 verify-mac 报 0 场，那是我的路径写错了——');
console.log('把上面那一段发回来，我按实际路径改。');
console.log();
console.log('注意：标 → 的行只是"名字看起来像"，不代表就是 AI 工具。');
