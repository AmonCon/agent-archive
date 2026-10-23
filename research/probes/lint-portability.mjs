/**
 * macOS / Linux 兼容性静态检查。
 *
 * 扫全部源码，找出"只在 Windows 上成立"的写法。这是**静态**检查，
 * 不能替代真机运行，但能在没有 Mac 的时候把明显的问题先找出来。
 *
 * 检查项：
 *   1. 硬编码的 Windows 环境变量（APPDATA / USERPROFILE）
 *   2. 硬编码的反斜杠路径拼接
 *   3. 只在 Windows 成立的路径正则（盘符）
 *   4. 大小写敏感相关的假设
 *   5. 依赖 process.platform 的硬分支（应优先用候选列表）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(srcRoot);

// 规则：正则、说明、允许的文件（用 platform.js 封装的不算问题）
const rules = [
  {
    id: 'win-env',
    re: /process\.env\.(APPDATA|LOCALAPPDATA|USERPROFILE)/g,
    desc: '直接读 Windows 环境变量',
    allow: ['src/platform.js'],
  },
  {
    id: 'backslash-join',
    re: /`[^`]*\\\\[A-Za-z][^`]*`/g,
    desc: '字符串里硬编码反斜杠路径',
    allow: [],
    // 注释里的路径说明不算
    skipIfLineMatch: /^\s*(\*|\/\/)/,
  },
  {
    id: 'drive-letter',
    re: /\^\[a-zA-Z\]:/g,
    desc: '盘符正则（macOS/Linux 没有盘符，需同时接受 / 开头）',
    allow: ['src/model.js', 'src/scanners/copilot.js', 'src/scanners/kiro.js'],
  },
  {
    id: 'platform-branch',
    re: /process\.platform\s*===\s*'(win32|darwin|linux)'/g,
    desc: 'process.platform 硬分支',
    // cursor.js：判断"是不是盘符"必须知道平台——Windows 有盘符，
    // macOS/Linux 没有，这个判断本身就是平台相关的，无法用候选列表绕开。
    allow: ['src/platform.js', 'src/messages.js', 'src/cli.js', 'src/scanners/cursor.js'],
  },
];

const findings = [];

for (const file of files) {
  const rel = path.relative(path.join(here, '..', '..'), file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  for (const rule of rules) {
    if (rule.allow.includes(rel)) continue;

    lines.forEach((line, i) => {
      if (rule.skipIfLineMatch && rule.skipIfLineMatch.test(line)) return;
      const re = new RegExp(rule.re.source, rule.re.flags);
      if (re.test(line)) {
        findings.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          desc: rule.desc,
          text: line.trim().slice(0, 110),
        });
      }
    });
  }
}

// 额外检查：路径拼接里用了硬编码分隔符
const sepFindings = [];
for (const file of files) {
  const rel = path.relative(path.join(here, '..', '..'), file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // 排除：正则、注释、字符串里的说明文字
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    // "...\\..." 形式的路径拼接（在模板串里）
    if (/[a-zA-Z]\\\\[a-zA-Z+]/.test(line) && !/replace|split|RegExp|\.test\(/.test(line)) {
      sepFindings.push({ file: rel, line: i + 1, text: trimmed.slice(0, 110) });
    }
  });
}

console.log('=== 平台相关写法检查 ===\n');
if (!findings.length) {
  console.log('  没有发现需要处理的硬编码。');
} else {
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.rule}]`);
    console.log(`     ${f.desc}`);
    console.log(`     ${f.text}`);
    console.log('');
  }
}

console.log(`\n=== 硬编码路径分隔符（${sepFindings.length} 处）===\n`);
if (!sepFindings.length) {
  console.log('  没有发现。');
} else {
  for (const f of sepFindings) {
    console.log(`  ${f.file}:${f.line}  ${f.text}`);
  }
}

console.log(`\n扫描 ${files.length} 个源文件，发现问题 ${findings.length + sepFindings.length} 处。`);
