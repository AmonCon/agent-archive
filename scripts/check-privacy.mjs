#!/usr/bin/env node
/**
 * 隐私检查：仓库是公开的，所以「本机标识」和「密钥」一旦进了提交就等于公开。
 *
 * 为什么需要它：写代码的人很容易把真实环境顺手写进注释和测试数据——
 * 真实项目名、真实局域网地址、真实用户名。这些东西不会让任何测试失败，
 * 只会安静地留在 git 历史里。
 *
 * 查两个地方，缺一不可：
 *   1. 被跟踪文件的内容（只查 git 跟踪的，没跟踪的不会公开）
 *   2. 提交的作者与提交者身份——这是最容易漏的一处，文件改得再干净也碰不到它
 *
 * 输出**不打印命中的原文**：CI 日志在公开仓库里也是公开的，
 * 把密钥打进日志等于换个地方泄露。
 *
 * 可选文件：
 *   .privacy-skip   一行一个路径前缀，声明「这些是第三方代码，不查」
 *   .privacy-deny   一行一个词，本机私有词表（应加入 .gitignore）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 文档和测试里必然有示例，这些是公认的占位符
const PLACEHOLDER_USERS = new Set([
  'x', 'X', 'me', 'you', 'user', 'yourname', 'demo', 'a', 'b', 'bob', 'alice',
  'foo', 'bar', 'test', 'someone', 'username', 'name', 'xxx', '...',
]);

// 局域网地址本身不敏感，容易写进文档的是「某一台具体的机器」
const PLACEHOLDER_IPS = new Set([
  '192.168.1.9', '192.168.1.10', '10.0.0.1',
  '192.0.2.1', '198.51.100.1', '203.0.113.1',
]);

// 依赖与产物目录：不是我们的代码
const DEFAULT_SKIP = [
  'node_modules/', 'vendor/', 'third_party/', 'dist/', 'build/',
  '.next/', 'target/', 'coverage/', 'public/vendor/',
];

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
    ok: (m) => PLACEHOLDER_USERS.has(m[1] || m[2]),
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
  // 刻意**不查文件里的邮箱**。
  //
  // 试过，噪声会淹没信号：真实项目里到处是测试夹具——`@example.invalid`、
  // `@evilgmail.com`、`@gmail.com.attacker.test`——它们恰恰是在测邮箱校验逻辑。
  // 而真正会漏的那种（作者的真实邮箱）不在文件里，在**提交元数据**里，
  // 一个提交只有一个身份，信号极高。所以邮箱只在下面查提交身份。
  //
  // 如果某个文件确实写了真实地址，把它加进 .privacy-deny。
];

const mask = (s) => (s.length <= 8 ? s[0] + '***' : s.slice(0, 3) + '***' + s.slice(-2) + ` (${s.length} 字符)`);

const readList = (name) => {
  const p = path.join(repoRoot, name);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
};

const skip = [...DEFAULT_SKIP, ...readList('.privacy-skip')];
const deny = readList('.privacy-deny');

const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });

function trackedFiles() {
  try {
    return git(['ls-files', '-z']).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 词表里可能夹着中文。纯 ASCII 词按词边界匹配，否则带空格的短词会把
 * `plugin id` 这类正常文本也算命中；中文没有词边界，退回子串匹配。
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
const findings = [];

const files = trackedFiles();
for (const rel of files) {
  if (skip.some((p) => rel.startsWith(p))) continue;
  let text;
  try {
    text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('privacy-ok')) continue; // 行内豁免：识别密钥的代码本身含密钥形状
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line))) {
        if (rule.ok && rule.ok(m)) continue;
        findings.push({ why: rule.why, where: `${rel}:${i + 1}`, sample: mask(m[0]) });
      }
    }
    for (const d of denyRules) {
      if (d.test(line)) findings.push({ why: '本机词表', where: `${rel}:${i + 1}`, sample: d.word[0] + '***' });
    }
  }
}

// 提交身份：只放行 GitHub 的 noreply 地址和公认占位符
try {
  const out = git(['log', '--all', '--format=%ae%n%ce']);
  const seen = new Map();
  for (const e of out.split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (/@users\.noreply\.github\.com$/.test(e)) continue;
    if (/@(?:example\.(?:com|org)|localhost|test\.)/.test(e)) continue;
    seen.set(e, (seen.get(e) || 0) + 1);
  }
  for (const [e, n] of seen) {
    findings.push({
      why: '提交作者邮箱',
      where: `（提交元数据）${n} 个提交`,
      sample: e.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
    });
  }
} catch {
  /* 不是 git 仓库就只能查文件 */
}

/**
 * 提交信息也要查。
 *
 * 这一段是补出来的：文件内容和作者身份都挡住了，但**消息正文没人看**——
 * 而它是公开的，还会被 GitHub 显示在提交列表里。真出过一次：写提交信息时
 * 打了 `%APPDATA%`，被 cmd 展开成了本机的完整路径，那条消息带着用户名
 * 被推到了公开仓库上。
 *
 * 规则与文件内容一致（含占位符放行），所以 `/Users/alice` 这类示意值不会误报。
 */
try {
  const out = git(['log', '--all', '--format=%h%x01%B%x02']);
  for (const chunk of out.split('\x02')) {
    if (!chunk.trim()) continue;
    const sep = chunk.indexOf('\x01');
    const short = sep < 0 ? '?' : chunk.slice(0, sep);
    const msg = sep < 0 ? chunk : chunk.slice(sep + 1);
    for (const line of msg.split('\n')) {
      if (line.includes('privacy-ok')) continue;
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line))) {
          if (rule.ok && rule.ok(m)) continue;
          findings.push({ why: '提交信息里的' + rule.why, where: short, sample: mask(m[0]) });
        }
      }
      for (const d of denyRules) {
        if (d.test(line)) findings.push({ why: '提交信息里的本机词表', where: short, sample: d.word[0] + '***' });
      }
    }
  }
} catch {
  /* 同上 */
}

if (!findings.length) {
  console.log(`隐私检查通过：${files.length} 个被跟踪文件、全部提交的作者身份里没有本机标识或密钥`);
  process.exit(0);
}

console.error('隐私检查失败：以下内容会被公开');
console.error('');
for (const f of findings) console.error(`  ${f.where}  [${f.why}]  ${f.sample}`);
console.error('');
console.error('修法：文件里的真实值换成占位符（my-app / 192.168.1.10 / C:\\Users\\me）；');
console.error('提交邮箱用 GitHub 的 noreply 地址——`git config user.email "<id>+<login>@users.noreply.github.com"`。');
process.exit(1);
