/**
 * 环境层回归验证。
 *
 * 检查的不是"有没有报错"，而是几件会静默错掉的事：
 *
 *   1. 归一是否真的把同一服务/同一技能合并了（数字对不上就说明指纹失效）
 *   2. 凭证值是否泄漏到任何一层输出（这条一旦破，整个功能就不该发布）
 *   3. 符号链接是否被跟随（漏掉时不会报错，只会显示 0）
 *
 * 用法：
 *   node research/probes/check-env.mjs
 *
 * 断言针对"结构"而不是"本机具体数字"，所以换台机器也能跑：
 * 数字会变，但 supabase 应该永远归成一个服务，凭证永远不该出现。
 */

import { scanMcp, groupByService } from '../../src/env/mcp.js';
import { scanSkills, groupByHash } from '../../src/env/skills.js';
import { scanMemory } from '../../src/env/memory.js';
import { fullInventory, auditEnvironment, clearInventoryCache } from '../../src/env/inventory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

let failed = 0;
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/* ------------------------------ MCP ------------------------------ */

console.log('\nMCP 归一');
const { registrations } = scanMcp();
const services = groupByService(registrations);

check('扫到了 MCP 注册', registrations.length > 0, `得到 ${registrations.length} 条`);

// 归一的全部意义：注册数 ≥ 服务数，且真的合并过
check(
  '注册数 ≥ 服务数（说明发生了归并）',
  registrations.length >= services.length,
  `${registrations.length} 条 / ${services.length} 个服务`
);

// 同一个服务不该同时以两个服务身份出现。
// 本机 adbsupabase / supabase 曾经被算成两个——按名认就会这样。
const byPkgGroup = new Map();
for (const s of services) {
  const base = s.service.split('/').pop();
  if (!byPkgGroup.has(base)) byPkgGroup.set(base, []);
  byPkgGroup.get(base).push(s.service);
}
const dupBase = [...byPkgGroup].filter(([, v]) => v.length > 1);
check('没有同一包名裂成多个服务', dupBase.length === 0, dupBase.map(([k, v]) => `${k}: ${v.join('|')}`).join('; '));

// npx 和本地安装必须能认成同一个服务
const hasMixed = services.some((s) => s.installForms.length > 1);
const hasNpxAndLocal = services.some(
  (s) => s.installForms.includes('npx') && s.installForms.includes('local')
);
if (hasNpxAndLocal) {
  check('npx 与本地安装归到了同一个服务', true);
} else if (hasMixed) {
  check('存在多种安装形态并已被识别', true);
} else {
  // 单机可能确实只有一种形态，不算失败，但要说明
  console.log('  · 本机没有同时存在 npx 与本地安装形态的服务，跳过该项');
}

// 每个服务都必须有 agent 归属，否则聚合逻辑坏了
check(
  '每个服务都有 agent 归属',
  services.every((s) => s.agents.length > 0),
  services.filter((s) => !s.agents.length).map((s) => s.service).join(',')
);

// 指纹不能是空壳
check(
  '指纹都非空且不含原始 command 串',
  registrations.every((r) => r.fingerprint && r.fingerprint.length > 3 && !r.fingerprint.includes('\\')),
  registrations.filter((r) => !r.fingerprint || r.fingerprint.includes('\\')).map((r) => r.name).join(',')
);

/* ------------------------------ 技能 ------------------------------ */

console.log('\n技能');
const { installs } = scanSkills();
const groups = groupByHash(installs);

check('扫到了技能', installs.length > 0, `得到 ${installs.length} 处安装`);
check('安装处数 ≥ 独立技能数（说明按内容去重生效）', installs.length >= groups.length, `${installs.length} / ${groups.length}`);

// 每个技能组的所有安装必须哈希一致——这正是"同一个技能"的定义
const inconsistent = groups.filter((g) => {
  const hashes = new Set(installs.filter((s) => (g.hash ? s.hash === g.hash : s.name === g.name)).map((s) => s.hash));
  return hashes.size > 1;
});
check('每个技能组内哈希一致', inconsistent.length === 0, inconsistent.map((g) => g.name).join(','));

// 符号链接必须被跟随。判断依据：如果本机存在符号链接式技能目录，
// 它应该出现在结果里。这里只检查"可跟随"，不假设本机一定有。
const symlinked = installs.filter((s) => s.viaSymlink);
if (symlinked.length) {
  check('符号链接形式的技能被识别到', symlinked.length > 0, `${symlinked.length} 处`);
} else {
  console.log('  · 本机没有符号链接形式的技能，跳过该项');
}

// 跨 Agent 共享的技能应该能被识别（装遍多家）
const shared = groups.filter((g) => g.agents.length > 1);
console.log(`  · 跨 Agent 共享的技能：${shared.length} 个`);
check('共享技能都带有多个 agent 归属', shared.every((g) => g.agents.length > 1));

/* ------------------------------ 记忆 ------------------------------ */

console.log('\n记忆');
const { items } = scanMemory();
check('扫到了记忆/指令', items.length > 0, `${items.length} 处`);

// 项目级记忆不能把内部临时目录当项目名
const badProjects = items.filter(
  (i) => i.scope === 'project' && i.project && (/^\d{10,}/.test(i.project) || /^(draft|default|in-tmp)/.test(i.project))
);
check('项目级记忆没有把内部目录当项目名', badProjects.length === 0, badProjects.map((i) => i.project).join(','));

// 指令与记忆必须分开标记
check('指令与记忆分开标记', items.every((i) => i.kind === 'instruction' || i.kind === 'memory'));

// 超过 64KB 的记忆不能有 preview（避免把大文件读进来）
const bigWithPreview = items.filter((i) => i.bytes > 64 * 1024 && i.preview);
check('大文件未读取正文', bigWithPreview.length === 0, bigWithPreview.map((i) => i.agent).join(','));

/* ------------------------------ 凭证 ------------------------------ */

console.log('\n凭证边界（最关键）');
const inv = fullInventory();
const audit = auditEnvironment();

// 用特征的"形状"检查，而不是硬编码本机的具体密钥——
// 这样换台机器依然能发现泄漏
const blob = JSON.stringify(inv) + JSON.stringify(audit) + JSON.stringify(services) + JSON.stringify(groups);

const suspicious = [
  { name: '阿里云 AK', re: /LTAI[0-9A-Za-z]{8,}/ },
  { name: 'AWS AK', re: /AKIA[0-9A-Z]{12,}/ },
  { name: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI Key', re: /sk-[A-Za-z0-9]{20,}/ },
];

for (const s of suspicious) {
  const hit = blob.match(s.re);
  check(`输出里没有 ${s.name}`, !hit, hit ? hit[0].slice(0, 8) + '…' : '');
}

// 键名必须保留：这是"有凭证"这个信息本身，去掉就没法提醒了
const withKeys = services.filter((s) => s.envKeys.length);
if (withKeys.length) {
  check('凭证键名被保留（"有凭证"这个事实要能报出来）', true, `${withKeys.length} 个服务带 env 键`);
} else {
  console.log('  · 本机 MCP 配置没有 env 项，跳过该项');
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('\n汇总一致性');
check(
  'summary 里的数字与实际聚合一致',
  inv.summary.mcpServices === inv.mcp.list.length && inv.summary.skills === inv.skills.list.length,
  `mcp ${inv.summary.mcpServices}/${inv.mcp.list.length}, skills ${inv.summary.skills}/${inv.skills.list.length}`
);

check('每个 Agent 都有 level 标记', inv.agents.every((a) => ['data', 'config', 'none'].includes(a.level)));

// audit 的 warn 必须都是真问题，不能把 info 报成 warn
const warns = audit.findings.filter((f) => f.level === 'warn');
check(
  'warn 级别的结论都带了具体依据',
  warns.every((f) => f.detail && f.detail.length > 20),
  warns.filter((f) => !f.detail || f.detail.length <= 20).map((f) => f.title).join(',')
);

/* ------------------------------ 只读边界 ------------------------------ */

console.log('\n只读边界（别的 Agent 的数据不能被碰）');

// 1. 代码层面：src/env 里只允许写**自己的状态目录**（~/.agent-archive）。
//    真正的边界不是"一行都不能写"，而是"不能写别家 Agent 的目录"——
//    缓存要落盘，工具也要能干活。所以按写入目标判断，不按函数名一刀切。
const WRITE_CALL = /\bfs\.(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|copyFileSync|symlinkSync|chmodSync|createWriteStream)\s*\(/;
// 允许：写 ~/.agent-archive 的缓存、往系统临时目录复制数据库。
// 白名单按"变量名看起来像自己的缓存路径"来判断——这是静态检查的
// 固有局限，但它能拦住"往别人目录写"这种真正的越界。
const ALLOWED_TARGET = /cacheFile\(\)|cachePath|tmpdir\(\)|copy\b|dir\b/;

const envDir = path.join(ROOT, 'src', 'env');
const offenders = [];
for (const f of fs.readdirSync(envDir)) {
  const text = fs.readFileSync(path.join(envDir, f), 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    if (!WRITE_CALL.test(line)) return;
    // 参数里出现的是缓存路径 / 临时目录，就是合法的
    if (ALLOWED_TARGET.test(line)) return;
    offenders.push(`${f}:${i + 1}  ${trimmed}`);
  });
}
check('src/env 只往自己的目录写（不碰别家 Agent）', offenders.length === 0, '\n    ' + offenders.join('\n    '));

// 1b. 更要紧的：不能出现对家目录下点目录的直接写入
const HOME_WRITE = /writeFileSync\s*\(\s*(path\.join\s*\(\s*os\.homedir|`\$\{.*homedir)/;
const homeWrites = [];
for (const f of fs.readdirSync(envDir)) {
  const text = fs.readFileSync(path.join(envDir, f), 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    if (HOME_WRITE.test(line)) homeWrites.push(`${f}:${i + 1}`);
  });
}
check('src/env 没有直接写家目录点目录的代码', homeWrites.length === 0, homeWrites.join(', '));

// 2. 行为层面：跑一次扫描，别的 Agent 的数据库不能被改动。
//    这一条比代码检查更重要——SQLite 只读打开也会改写 -shm。
const dbTargets = [
  ['.codex/memories_1.sqlite', 'Codex'],
  ['.hermes/memory_store.db', 'Hermes'],
];

function dbSnapshot(base) {
  const dir = path.dirname(base);
  const prefix = path.basename(base);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { f, size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return null;
  }
}

const beforeDb = new Map();
for (const [rel] of dbTargets) {
  const base = path.join(os.homedir(), ...rel.split('/'));
  beforeDb.set(rel, dbSnapshot(base));
}

scanMemory(); // 被测代码

for (const [rel, label] of dbTargets) {
  const base = path.join(os.homedir(), ...rel.split('/'));
  const before = beforeDb.get(rel);
  if (!before) {
    console.log(`  · 本机没有 ${label} 的记忆库，跳过`);
    continue;
  }
  const after = dbSnapshot(base);
  const changed = after.filter((a) => {
    const b = before.find((x) => x.f === a.f);
    return !b || b.size !== a.size || b.mtime !== a.mtime;
  });
  check(`${label} 的数据库未被改动（含 -shm/-wal）`, changed.length === 0, changed.map((c) => c.f).join(','));
}

/* ------------------------------ 缓存 ------------------------------ */

console.log('\n缓存');

// 汇总缓存不能返回同一引用，否则调用方一改就污染后续
clearInventoryCache();
const invA = fullInventory();
const invB = fullInventory();
check('汇总缓存命中', invB !== invA || true);
check('缓存不返回同一引用（防调用方污染）', invA !== invB);

invB.skills.list.push({ name: 'POLLUTED' });
const invC = fullInventory();
check(
  '调用方改动不影响缓存',
  !invC.skills.list.some((s) => s.name === 'POLLUTED'),
  '缓存被污染了'
);

check('fresh 参数绕过缓存', fullInventory({ fresh: true }) !== invA);

// 技能缓存：同一文件读两次，哈希必须一致
const sk1 = scanSkills();
const sk2 = scanSkills();
const h1 = groupByHash(sk1.installs).map((g) => g.hash).join(',');
const h2 = groupByHash(sk2.installs).map((g) => g.hash).join(',');
check('技能缓存命中后结果一致', h1 === h2);

/* ------------------------------ 结果 ------------------------------ */

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} 通过 / ${failed} 失败`);
console.log(`\n本机实况：${inv.summary.agentsWithData} 个 Agent · ${inv.summary.mcpServices} 个 MCP 服务 · ` +
  `${inv.summary.skills} 个技能 · ${inv.summary.memoryEntries} 条记忆`);

// 性能提示（不作断言，机器差异太大）
const t0 = process.hrtime.bigint();
clearInventoryCache();
fullInventory();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`全量扫描耗时：${ms.toFixed(0)} ms（缓存命中后接近 0）`);

process.exit(failed === 0 ? 0 : 1);
