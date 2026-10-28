#!/usr/bin/env node
/**
 * 隐私检查：这个仓库是公开的，所以「本机标识」和「密钥」一旦进了提交就等于公开。
 *
 * 为什么需要这个脚本：扫会话的工具本身很容易把开发者的真实环境写进注释和
 * 测试数据——真实项目名、真实局域网地址、真实用户名，都是顺手写下来的。
 * 这些东西不会让任何测试失败，只会安静地留在 git 历史里。
 *
 * 检查范围只有 `git ls-files`：没被跟踪的文件不会公开，不用管。
 *
 * 输出**不能打印命中的原文**。CI 日志在公开仓库里也是公开的，
 * 把密钥打进日志等于换个地方泄露。所以只给文件、行号、规则名和掩码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

// 文档和测试里必然要有示例，这些是公认的占位符
const PLACEHOLDER_USERS = new Set([
  'x', 'X', 'me', 'you', 'user', 'yourname', 'demo', 'a', 'b', 'bob', 'alice',
  'foo', 'bar', 'test', 'someone', 'username', 'name', 'xxx', '...',
]);

// 第三方源码副本（research/reference-src）不检查：那是别人上游的代码，
// 我们既不改也不署名，里面的示例路径属于上游作者，不是本机标识。
const SKIP_PREFIXES = ['research/reference-src/'];

// 局域网地址本身不算敏感，容易被写进文档的是「某一台具体的机器」
const PLACEHOLDER_IPS = new Set([
  '192.168.1.9', '192.168.1.10', '10.0.0.1',
  '192.0.2.1', '198.51.100.1', '203.0.113.1',
]);

const RULES = [
  {
    id: 'token',
    why: '密钥形状',
    re: /\b(?:sk-(?!ant-)[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|LTAI[0-9A-Za-z]{10,24}|sbp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|[rs]k_live_[A-Za-z0-9]{20,})\b/g,
  },
  {
    id: 'private-key',
    why: '私钥内容',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'home-path',
    why: '本机用户目录',
    re: /(?:[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)|\/(?:Users|home)\/([A-Za-z0-9._-]+))/g,
    ok: (m) => {
      const name = m[1] || m[2];
      return PLACEHOLDER_USERS.has(name);
    },
  },
  {
    id: 'lan-ip',
    why: '内网地址',
    re: /\b(?:(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/g,
    ok: (m) => PLACEHOLDER_IPS.has(m[0]),
  },
  {
    id: 'hostname',
    why: '机器名',
    re: /\bDESKTOP-[A-Z0-9]{7,}\b/g,
  },
  {
    id: 'email',
    why: '真实邮箱',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|cn|net|org|io|dev|me)\b/g,
    ok: (m) => /@(?:example\.(?:com|org)|test\.|localhost)/.test(m[0]) || /^(?:noreply|no-reply)@/.test(m[0]),
  },
];

// 维护者自己的词表：一行一个，`#` 注释。放在 .privacy-deny 里（已 gitignore），
// 这样「某个项目名不能公开」这件事本身也不必公开。
function loadDenyList() {
  const p = path.join(repoRoot, '.privacy-deny');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

const mask = (s) => (s.length <= 8 ? s[0] + '***' : s.slice(0, 3) + '***' + s.slice(-2) + ` (${s.length} 字符)`);

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

const findings = [];
const deny = loadDenyList();

/**
 * 词表里的词有带连字符的，也有带空格的，还可能夹着中文。
 * 纯 ASCII 词按词边界匹配，否则带空格的短词会把 `plugin id` 这类
 * 正常文本也算命中；含中文的词没法用 `\b`（中文没有词边界），退回子串匹配。
 */
function denyMatcher(word) {
  if (!/^[\x20-\x7e]+$/.test(word)) {
    const low = word.toLowerCase();
    return (line) => line.toLowerCase().includes(low);
  }
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i');
  return (line) => re.test(line);
}

const denyRules = deny.map((w) => ({ word: w, test: denyMatcher(w) }));

for (const rel of trackedFiles()) {
  if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
  const abs = path.join(repoRoot, rel);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // 二进制

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 行内豁免：识别密钥的代码本身必然包含密钥形状
    if (line.includes('privacy-ok')) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line))) {
        if (rule.ok && rule.ok(m)) continue;
        findings.push({ rule: rule.id, why: rule.why, file: rel, line: i + 1, sample: mask(m[0]) });
      }
    }
    for (const d of denyRules) {
      if (d.test(line)) {
        findings.push({ rule: 'deny', why: '本机词表', file: rel, line: i + 1, sample: d.word[0] + '***' });
      }
    }
  }
}

if (!findings.length) {
  console.log('隐私检查通过：' + trackedFiles().length + ' 个被跟踪文件里没有本机标识或密钥');
  process.exit(0);
}

console.error('隐私检查失败：以下内容会被公开');
console.error('');
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.why}]  ${f.sample}`);
}
console.error('');
console.error('修法：把真实值换成占位符（my-app / 192.168.1.10 / C:\\Users\\me），不要删掉整段说明。');
process.exit(1);
