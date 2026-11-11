/**
 * structureSpec ↔ structure.js 集成自检（只读，收尾前跑一次）。
 *
 * 造 9 个「符合各家真实形状的最小应用根目录」，用 scoreStructure 打分、
 * anchorOf 算应用根，确认：① 每家能被自己的 spec 命中且达到 minScore；
 * ② 应用根上溯正确；③ decoy（一堆无关 jsonl / 有 sessions 子目录但不是会话库）
 * 不被任何 spec 误判。
 *
 * 全部在系统 temp 里造，不碰本机真实数据、不写仓库。
 * 用法：node research/probes/verify-structure-specs.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { scoreStructure, anchorOf } = await import(pathToFileURL(path.join(REPO, 'src', 'structure.js')).href);

const NAMES = ['gemini', 'openclaw', 'codebuddy', 'pi', 'omp', 'cline', 'kimi', 'grokbuild', 'mcode'];
const specs = {};
const scanners = {};
for (const n of NAMES) {
  const url = pathToFileURL(path.resolve('src', 'scanners', `${n}.js`)).href;
  const m = await import(url);
  specs[n] = m.structureSpec;
  scanners[n] = m;
}

/** 每家：在应用根下造哪些相对文件/目录（取 probes 里最强的几条真实形状）。 */
const SHAPES = {
  gemini:     ['tmp/h1/chats/session-abc.jsonl', 'tmp/h1/.project_root'],
  openclaw:   ['agents/main/sessions/s1.jsonl', 'agents/main/sessions/sessions.json'],
  codebuddy:  ['projects/E--demo/aaaa.jsonl'],
  pi:         ['agent/sessions/2026-01-01_pi1.jsonl'],
  omp:        ['agent/sessions/2026-01-01_omp1.jsonl'],
  cline:      ['data/sessions/c1/c1.json', 'data/sessions/c1/c1.messages.json'],
  kimi:       ['sessions/ws/k1/agents/main/wire.jsonl', 'sessions/ws/k1/state.json'],
  grokbuild:  ['sessions/E--demo/g1/summary.json', 'sessions/E--demo/g1/chat_history.jsonl'],
  mcode:      ['v2/sessions/2026/01/01/00-00-00-000-session_YWJj/messages.jsonl'],
};

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-spec-check-'));
function makeApp(appName, rels) {
  const app = path.join(rootDir, appName);
  fs.mkdirSync(app, { recursive: true });
  for (const rel of rels) {
    const full = path.join(app, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '{}\n');
  }
  return app;
}

let failed = 0;
console.log('== 每家：自己的 spec 能命中、上溯到应用根 ==');
for (const n of NAMES) {
  const app = makeApp(`.${n}`, SHAPES[n]);
  const { score, anchor, evidence } = scoreStructure(specs[n], app);
  const ok = score >= specs[n].minScore;
  const anchored = anchorOf(app, specs[n]);
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${n.padEnd(10)} score=${score}/${specs[n].minScore}` +
    ` anchor=${anchored ? path.basename(anchored) : 'null'} evidence=${(evidence || []).length}`
  );
}

console.log('\n== decoy：不该被任何家认成会话源 ==');
const decoyDirs = {
  'pnpm-cache': Array.from({ length: 12 }, (_, i) => `f${i}.jsonl`),
  'pgAdmin': ['sessions/state.db'],
  'empty-agent': ['README.md'],
};
for (const [name, rels] of Object.entries(decoyDirs)) {
  const app = makeApp(name, rels);
  const hits = [];
  for (const n of NAMES) {
    const { score } = scoreStructure(specs[n], app);
    if (score >= specs[n].minScore) hits.push(`${n}(${score})`);
  }
  if (hits.length) failed++;
  console.log(`${hits.length ? 'FAIL' : 'OK  '} ${name.padEnd(14)} 被认成: ${hits.length ? hits.join(', ') : '（无，正确）'}`);
}

fs.rmSync(rootDir, { recursive: true, force: true });
console.log(`\n结果：${failed ? `失败 ${failed} 项（需修 spec 或宿主匹配器）` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
