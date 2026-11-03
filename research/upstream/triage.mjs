#!/usr/bin/env node
/**
 * 上游 diff 的阅读排序器。
 *
 * ## 它解决什么
 *
 * `refresh.mjs` 回答「变了没有、变了哪些文件」。但 MAGPIE 三天 300 文件、
 * +2 万行——把列表原样打出来，人还是不知道该先读哪里，最后要么全读（成本
 * 随项目增长失控），要么凭印象挑（漏掉真正重要的）。
 *
 * 这个脚本把 diff 变成一份**按阅读价值排序的清单**：
 *   - 按目录聚合（不是按文件），一个目录一次判断；
 *   - 新增/删除文件单独提出来（新子系统往往藏在这里）；
 *   - 每个目录给出改动量、涉及提交数、提交标题，以及一档优先级。
 *
 * 优先级是**启发式**，不是结论：它只负责把「值得看」排在前面，读完之后
 * 的判断仍然要人（或研究子代理）来做，结论写进 LESSONS.md。
 *
 * ## 用法
 *
 *   node research/upstream/triage.mjs                 # 全部来源
 *   node research/upstream/triage.mjs magpie          # 只看一个
 *   node research/upstream/triage.mjs magpie --md out.md
 *   node research/upstream/triage.mjs --top 15        # 每组最多列几个提交
 *
 * 前提：本地镜像已由 refresh.mjs 建好（~/.agent-archive/upstream-cache/<id>），
 * 且新提交在 FETCH_HEAD 里。没有镜像时只输出提示，不自动 clone。
 *
 * 零依赖：git + node 标准库。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = path.join(HERE, 'sources.json');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const TOP = Number(flag('--top', '6')) || 6;
const MD = flag('--md');
// 位置参数只认「来源 id」，跳过 --md/--top 的值
const consumed = new Set([flag('--top'), MD].filter(Boolean));
const only = argv.find((a) => !a.startsWith('--') && !consumed.has(a)) || null;

function cacheDir(id) {
  return path.join(os.homedir(), '.agent-archive', 'upstream-cache', id);
}

function git(cwd, args, timeout = 120000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * 目录分组：取前 N 段路径。Rust/Go 项目按「模块目录」聚合才有意义，
 * 按文件聚合会得到几百行没人看的列表。
 */
function groupOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return '(root)';
  // src-tauri/src/services/... 这类长前缀，取到有信息量的那一段
  if (parts[0] === 'src-tauri' && parts.length > 2) {
    const i = parts.indexOf('src');
    if (i !== -1 && parts.length > i + 2) return parts.slice(0, i + 2).join('/');
  }
  if (parts.length <= 2) return parts.slice(0, -1).join('/') || '(root)';
  return parts.slice(0, 2).join('/');
}

/**
 * 优先级：命中「核心逻辑」模式加分，命中「产品外壳」模式减分。
 * 依据是 LESSONS.md 的判断标准：我们抄方法论，不抄 UI/计费/网关/预设表。
 *
 * 三层而不是两层，是因为「会话解析」和「测试夹具」价值不同：
 * 前者直接改正确性，后者只是验证手段；而 UI/网关/预设表再大也不该排前面。
 */
const VERY_CORE = [
  /sessions?\//i, /pars(e|ing)/i, /transcript/i, /scanner/i, /sqlite/i,
  /discovery/i, /turn/i, /content/i, /carry/i, /calls?\//i, /trace/i,
];
const CORE = [
  /cache/i, /index/i, /model/i, /migrat/i, /schema/i, /subagent/i,
  /usage/i, /redact/i, /pii/i, /stats/i,
];
const SHELL = [
  /(^|\/)(gui|ui|web|site|i18n|locales?|assets|fonts|icons)\//i,
  /(^|\/)(presets?|providers?|pricing|plans?|billing|gateway|proxy|router|plugins?)\//i,
  /\.(css|scss|less|svg|png|jpg|ico|woff2?)$/i,
  /(^|\/)(changelog|release|version)\./i,
  /(^|\/)\.github\//, /(^|\/)(ci|build|packaging|scripts)\//,
];

function scoreOf(group, files, ins, del) {
  let score = 0;
  const sample = `${group} ${files.join(' ')}`;
  for (const re of VERY_CORE) if (re.test(sample)) score += 4;
  for (const re of CORE) if (re.test(sample)) score += 2;
  for (const re of SHELL) if (re.test(sample)) score -= 4;
  // 改动量：每 500 行一分，封顶 6 分（大改动值得看，但不该压过语义）
  score += Math.min(6, Math.floor((ins + del) / 500));
  // 外壳目录里的"文件多"通常是同一套模板复制 N 份（每家供应商一份），
  // 阅读成本不随文件数线性增长，所以按文件数减分，避免大而重复的目录霸榜。
  if (SHELL.some((re) => re.test(sample))) score -= Math.min(4, Math.floor(files.length / 8));
  return score;
}

function tierOf(score) {
  if (score >= 6) return 'HIGH';
  if (score >= 2) return 'MID';
  return 'LOW';
}

function analyze(src) {
  const dir = cacheDir(src.id);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { id: src.id, error: `没有本地镜像（先跑 refresh.mjs --diff）：${dir}` };
  }
  const head = git(dir, ['rev-parse', 'FETCH_HEAD']);
  if (!head.ok) return { id: src.id, error: '镜像里没有 FETCH_HEAD，先跑 refresh.mjs --diff' };

  const from = src.commit;
  const to = head.out;
  if (from === to) return { id: src.id, from, to, groups: [], unchanged: true };

  const ns = git(dir, ['diff', '--name-status', `${from}..${to}`]);
  if (!ns.ok) return { id: src.id, error: `diff 失败：${ns.err.slice(0, 200)}` };

  const numstat = git(dir, ['diff', '--numstat', `${from}..${to}`]);
  const stat = new Map();
  for (const line of (numstat.out || '').split('\n').filter(Boolean)) {
    const [a, d, f] = line.split('\t');
    stat.set(f, { ins: Number(a) || 0, del: Number(d) || 0 });
  }

  const groups = new Map();
  const born = [];
  const died = [];
  for (const line of ns.out.split('\n').filter(Boolean)) {
    const [code, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    const s = stat.get(file) || { ins: 0, del: 0 };
    if (code === 'A') born.push({ file, ...s });
    if (code === 'D') died.push({ file, ...s });
    const g = groupOf(file);
    const cur = groups.get(g) || { group: g, files: 0, ins: 0, del: 0, added: 0, deleted: 0, names: [] };
    cur.files += 1;
    cur.ins += s.ins;
    cur.del += s.del;
    if (code === 'A') cur.added += 1;
    if (code === 'D') cur.deleted += 1;
    if (cur.names.length < 40) cur.names.push(file);
    groups.set(g, cur);
  }

  // 每个目录被哪些提交碰过：用 git log --name-only 一次取回，再归并。
  const log = git(dir, ['log', '--name-only', '--pretty=format:@@%h%x09%s', `${from}..${to}`], 300000);
  const commits = [];
  if (log.ok) {
    let cur = null;
    for (const line of log.out.split('\n')) {
      if (line.startsWith('@@')) {
        const [h, ...rest] = line.slice(2).split('\t');
        cur = { hash: h, subject: rest.join('\t'), files: [] };
        commits.push(cur);
      } else if (line.trim() && cur) {
        cur.files.push(line.trim());
      }
    }
  }
  for (const c of commits) {
    const touched = new Set(c.files.map(groupOf));
    for (const g of touched) {
      const rec = groups.get(g);
      if (rec) (rec.commits ||= []).push(c);
    }
  }

  const out = [...groups.values()]
    .map((g) => ({ ...g, score: scoreOf(g.group, g.names, g.ins, g.del) }))
    .map((g) => ({ ...g, tier: tierOf(g.score) }))
    .sort((a, b) => b.score - a.score || b.ins + b.del - (a.ins + a.del));

  return { id: src.id, from, to, groups: out, born, died, commits: commits.length };
}

function render(r, lines) {
  const say = (s = '') => lines.push(s);
  if (r.error) {
    say(`## ${r.id}\n\n${r.error}\n`);
    return;
  }
  if (r.unchanged) {
    say(`## ${r.id}\n\n与 pin 一致（${r.to.slice(0, 8)}），没有要读的。\n`);
    return;
  }
  say(`## ${r.id}  ${r.from.slice(0, 8)} → ${r.to.slice(0, 8)}（${r.commits} 个提交）\n`);
  say('| 档 | 目录 | 文件 | + | − | 新增 | 删除 |');
  say('|---|---|---|---|---|---|---|');
  for (const g of r.groups) {
    say(`| ${g.tier} | \`${g.group}\` | ${g.files} | ${g.ins} | ${g.del} | ${g.added || ''} | ${g.deleted || ''} |`);
  }
  say();
  const interesting = r.groups.filter((g) => g.tier !== 'LOW').slice(0, TOP);
  for (const g of interesting) {
    say(`### \`${g.group}\`（${g.tier}）`);
    const cs = (g.commits || []).slice(0, TOP);
    for (const c of cs) say(`- ${c.hash} ${c.subject}`);
    if ((g.commits || []).length > TOP) say(`- …还有 ${g.commits.length - TOP} 个提交`);
    const sample = g.names.slice(0, 6);
    if (sample.length) say(`  文件示例：${sample.map((f) => '`' + f.split('/').pop() + '`').join('、')}`);
    say();
  }
  if (r.born.length) {
    say(`### 新增文件（新子系统通常藏在这里，${r.born.length} 个）`);
    for (const f of r.born.slice(0, 30)) say(`- \`${f.file}\` +${f.ins}`);
    if (r.born.length > 30) say(`- …还有 ${r.born.length - 30} 个`);
    say();
  }
  if (r.died.length) {
    say(`### 删除文件（${r.died.length} 个；被替换的旧子系统）`);
    for (const f of r.died.slice(0, 20)) say(`- \`${f.file}\` −${f.del}`);
    say();
  }
  say('> 优先级是启发式（核心逻辑加分、UI/计费/网关减分）。读完把判断写进 LESSONS.md。\n');
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const picked = cfg.sources.filter((s) => !only || s.id === only);
  if (!picked.length) {
    console.error(`没有匹配的来源：${only}`);
    process.exitCode = 2;
    return;
  }
  const lines = [`# 上游 diff 阅读清单（${new Date().toISOString().slice(0, 10)}）`, ''];
  for (const src of picked) render(analyze(src), lines);
  const text = lines.join('\n');
  if (MD) {
    fs.writeFileSync(path.resolve(MD), text + '\n', 'utf8');
    console.log(`已写入 ${path.resolve(MD)}`);
  } else {
    console.log(text);
  }
}

main();
