#!/usr/bin/env node
/**
 * 能力门禁：README 里每一句「我们支持 X」，都必须有一条代码/测试能证明它。
 *
 * 为什么需要它：README 是陌生人了解这个项目的唯一入口，而它会静默过期。
 * 典型的过期不是写错，是**写对了然后我们做了改动却没回头改它**——
 * 于是 README 说「这四家还没有契约测试」，而 test/ 里那四个文件已经写了三个月。
 * 这种漂移不会让任何测试失败，只会让读者低估我们、让我们自己忘记已经补过。
 *
 * 查四类，全是确定性的静态检查（不跑扫描、不碰本机、不联网）：
 *   1. scanner-contract  每个 src/scanners/*.js 都被 registry 注册，且有 test/<slug>.test.js
 *   2. readme-commands   README 里出现的 CLI 命令，都必须是 src/cli.js 真实注册过的
 *   3. readme-agents     「当前支持」表里每一家，都能解析到一个真实 scanner
 *   4. stale-gap         「还缺的」段落点名的 Agent，不能再有契约测试（有就是 README 没更新）
 *
 * 给所有人用的前提，也决定了写法：只读 git 仓库里的文件，不读 $HOME，
 * 不看本机装了什么。所以在别人的机器上、在 CI 里、在任何系统上结论都一样。
 *
 * 门禁本身也要可被证明有效：
 *   node scripts/check-claims.mjs               # 查本仓库
 *   node scripts/check-claims.mjs --self-test   # 证明每条规则抓得住注入的漂移
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * README 用的是展示名，代码用的是 slug。只登记**确实不同**的那几处，
 * 其余靠归一化（小写、去掉空格与标点）自然对上——多登记一条就多一处会过期的地方。
 */
const ALIASES = {
  deepseekharness: 'dsh',
  copilotchat: 'copilot',
};

const README = path.join(repoRoot, 'README.md');
const CLI = path.join(repoRoot, 'src', 'cli.js');
const REGISTRY = path.join(repoRoot, 'src', 'registry.js');
const SCANNERS = path.join(repoRoot, 'src', 'scanners');
const TESTS = path.join(repoRoot, 'test');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 展示名 → 用于比对的键：小写、去掉所有非字母数字。 */
export function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 一个展示名可能对应的 slug 候选，按优先级排列。 */
export function slugCandidates(display) {
  const n = normalizeName(display);
  const out = [];
  if (ALIASES[n]) out.push(ALIASES[n]);
  out.push(n);
  return out;
}

/** 把展示名解析到真实存在的 scanner slug；解析不到返回 null。 */
export function resolveScanner(display, slugs) {
  const n = normalizeName(display);
  if (ALIASES[n] && slugs.includes(ALIASES[n])) return ALIASES[n];
  const byNorm = new Map(slugs.map((s) => [normalizeName(s), s]));
  if (byNorm.has(n)) return byNorm.get(n);
  // 兜底：展示名以某个 slug 开头（`Copilot Chat` → `copilot`）
  for (const s of slugs) if (n.startsWith(normalizeName(s))) return s;
  return null;
}

/** 「当前支持」表的第一列。锚在节标题上，避免误读后面几十张同名列的表。 */
export function parseSupportTable(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^##\s+当前支持\s*$/.test(l.trim()));
  if (start < 0) return { found: false, agents: [] };
  const agents = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (agents.length) break;
      continue;
    }
    if (!line.startsWith('|')) {
      if (agents.length) break;
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] 是行首空串，cells[1] 是第一列
    const first = cells[1];
    if (!first || /^-+$/.test(first) || /^Agent$/i.test(first)) continue;
    agents.push(first);
  }
  return { found: true, agents };
}

/** README 里被当作命令用到的 CLI 子命令。只认「命令位置」，不认正文里的词。 */
export function parseReadmeCommands(readme) {
  const found = new Set();
  // 只认同一行内紧跟的空格：`\s` 会吃掉换行，把下一行的 `node`/`npm` 当成命令。
  const patterns = [
    /\bnode\s+src\/cli\.js[ \t]+([a-z][a-z0-9-]*)/g,
    /\bagent-archive[ \t]+([a-z][a-z0-9-]*)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(readme))) found.add(m[1]);
  }
  return [...found];
}

/** cli.js 真正注册过的子命令：只看主 dispatch 那个 switch。 */
export function parseCliCommands(cliSource) {
  const at = cliSource.lastIndexOf('switch (cmd)');
  if (at < 0) return [];
  const tail = cliSource.slice(at);
  const out = new Set();
  for (const line of tail.split('\n')) {
    const m = /^\s*case\s+'([^']+)'\s*:/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** registry.js 里 import 进来的 scanner slug。 */
export function parseRegisteredScanners(registrySource) {
  const out = [];
  const re = /from '\.\/scanners\/([^']+)\.js'/g;
  let m;
  while ((m = re.exec(registrySource))) out.push(m[1]);
  return out;
}

/** 「还缺的」那一段的原文（到空行或下一个标题为止）。 */
export function parseGapParagraph(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => l.includes('还缺的'));
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && (!line.trim() || line.startsWith('#'))) break;
    out.push(line);
  }
  return out.join('\n');
}

/** .claims-skip：一行一个 slug，# 开头与行尾注释忽略。与 .privacy-skip 同一套约定。 */
export function parseSkipList(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 规则

export function ruleScannerContract({ slugs, scannerSlugs, hasTest }) {
  const v = [];
  for (const slug of slugs) {
    if (!scannerSlugs.includes(slug)) {
      v.push(`src/scanners/${slug}.js 没有被 registry.js 注册，扫描器加了但没人调它`);
    }
    if (!hasTest(slug)) {
      v.push(`src/scanners/${slug}.js 没有 test/${slug}.test.js，契约没人锁`);
    }
  }
  return v;
}

export function ruleReadmeCommands({ readmeCommands, cliCommands }) {
  const known = new Set(cliCommands);
  const v = [];
  for (const cmd of readmeCommands) {
    if (!known.has(cmd)) v.push(`README 写了 \`${cmd}\`，但 src/cli.js 没有注册这个子命令`);
  }
  return v;
}

export function ruleReadmeAgents({ table, slugs }) {
  const v = [];
  if (!table.found) return ['README.md 里找不到「当前支持」表'];
  for (const display of table.agents) {
    if (!resolveScanner(display, slugs)) {
      v.push(`README「当前支持」里的 \`${display}\` 解析不到任何 src/scanners/*.js`);
    }
  }
  return v;
}

export function ruleStaleGap({ gapText, table, hasTest, slugs }) {
  if (!gapText) return ['README.md 里找不到「还缺的」段落'];
  const absence = /还没有契约测试|没有契约测试|缺契约测试/;
  const v = [];
  // 按句判，不按段落判：同一段里既有「还缺的」也有「已有」，段落级判断会把后者误杀。
  for (const sentence of gapText.split('。')) {
    if (!absence.test(sentence)) continue;
    for (const display of table.agents) {
      if (!sentence.includes(display)) continue;
      const slug = resolveScanner(display, slugs);
      if (slug && hasTest(slug)) {
        v.push(`README「还缺的」说 \`${display}\` 还没有契约测试，但 test/${slug}.test.js 存在——README 过期了`);
      }
    }
  }
  return v;
}

/**
 * 已知缺口清单（.claims-skip，一行一个 slug）。
 *
 * 为什么要有它：五家确实还没有契约测试，但门禁不该因此常年变红——红久了就没人看了。
 * 所以缺口要**显式声明**，而不是让规则悄悄放过。
 * 又因为「显式声明」很容易变成藏东西的地方，下面同时反过来约束它：
 * 清单里的每一家，README 的「还缺的」必须公开点名；补上测试之后必须从清单里删掉。
 */
export function ruleSkipList({ skipped, slugs, table, gapText, hasTest }) {
  const v = [];
  for (const slug of skipped) {
    if (!slugs.includes(slug)) {
      v.push(`.claims-skip 里的 \`${slug}\` 不是真实存在的 scanner`);
      continue;
    }
    const display = table.agents.find((d) => resolveScanner(d, slugs) === slug);
    if (!display) {
      v.push(`.claims-skip 里的 \`${slug}\` 没出现在 README「当前支持」表里，算不上已声明的能力`);
      continue;
    }
    if (hasTest(slug)) {
      v.push(`.claims-skip 里还写着 \`${slug}\` 没有契约测试，但 test/${slug}.test.js 已存在——把清单行删掉`);
    } else if (gapText && !gapText.includes(display)) {
      v.push(`.claims-skip 把 \`${slug}\` 列为已知缺口，但 README「还缺的」没点它的名——缺口不能只藏在机器里`);
    }
  }
  return v;
}

// ---------------------------------------------------------------- 主流程

function main({ selfTest = false } = {}) {
  const readme = read(README);
  const cliSource = read(CLI);
  const registrySource = read(REGISTRY);
  const scannerSlugs = fs
    .readdirSync(SCANNERS)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''));
  const hasTest = (slug) => {
    const p = path.join(TESTS, `${slug}.test.js`);
    if (!fs.existsSync(p)) return false;
    return /(^|\s)(await\s+)?(test|it)\(/.test(read(p));
  };

  const skipFile = path.join(repoRoot, '.claims-skip');
  const skipped = fs.existsSync(skipFile) ? parseSkipList(read(skipFile)) : [];

  const table = parseSupportTable(readme);
  const gapText = parseGapParagraph(readme);
  const violations = [
    ...ruleScannerContract({
      slugs: scannerSlugs.filter((s) => !skipped.includes(s)),
      scannerSlugs: parseRegisteredScanners(registrySource),
      hasTest,
    }),
    ...ruleReadmeCommands({
      readmeCommands: parseReadmeCommands(readme),
      cliCommands: parseCliCommands(cliSource),
    }),
    ...ruleReadmeAgents({ table, slugs: scannerSlugs }),
    ...ruleStaleGap({ gapText, table, hasTest, slugs: scannerSlugs }),
    ...ruleSkipList({ skipped, slugs: scannerSlugs, table, gapText, hasTest }),
  ];

  if (selfTest) {
    /**
     * 一条规则抓不住注入的漂移，就不算规则——照抄的是 Elysian bench/audit.py 的自测思路。
     * 三种注入对应三条最容易被「改代码不改 README」破坏的规则。
     */
    const cases = [
      {
        name: '注入一个没有 scanner 的 Agent',
        got: ruleReadmeAgents({
          table: { found: true, agents: ['Claude Code', 'Ghost Agent'] },
          slugs: scannerSlugs,
        }),
      },
      {
        name: '注入一个不存在的 CLI 命令',
        got: ruleReadmeCommands({
          readmeCommands: ['timeline', 'frobnicate'],
          cliCommands: parseCliCommands(cliSource),
        }),
      },
      {
        name: '注入一句过期的「还缺的」',
        got: ruleStaleGap({
          gapText: '**还缺的**：Hermes 都还没有契约测试。',
          table: { found: true, agents: ['Hermes'] },
          hasTest,
          slugs: scannerSlugs,
        }),
      },
      {
        name: '把已有测试的 scanner 藏进 .claims-skip',
        got: ruleSkipList({
          skipped: ['codex'],
          slugs: scannerSlugs,
          table,
          gapText: '**还缺的**：Codex 还没有契约测试。',
          hasTest,
        }),
      },
    ];
    let failed = 0;
    for (const c of cases) {
      if (!c.got.length) {
        console.error(`自测失败：规则没抓住「${c.name}」`);
        failed++;
      } else {
        console.log(`自测通过：抓住「${c.name}」→ ${c.got[0]}`);
      }
    }
    if (failed) return 1;
    if (!violations.length) {
      console.log('自测与实查都通过');
      return 0;
    }
  }

  if (!violations.length) {
    const locked = scannerSlugs.length - skipped.length;
    const gap = skipped.length
      ? `、${skipped.length} 家已在 .claims-skip 显式登记为缺口（README 同步点名）`
      : '';
    console.log(
      `能力门禁通过：${scannerSlugs.length} 个 scanner 全部注册，其中 ${locked} 家有契约测试${gap}；` +
        `${table.agents.length} 家支持声明可解析、README 命令全部真实存在`,
    );
    return 0;
  }

  console.error('能力门禁失败：README 声称的事，代码或测试没跟上');
  console.error('');
  for (const v of violations) console.error(`  - ${v}`);
  console.error('');
  console.error('修法：要么把代码/测试补上，要么把 README 改成现在真实的样子。');
  console.error('这个门禁只读仓库文件，所以在任何机器、任何系统上结论都一样。');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main({ selfTest: process.argv.includes('--self-test') }));
}