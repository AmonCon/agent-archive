/** 诊断：collectCandidates / scoreStructure 对多源假备份里 .gemini 与 .claude 的处理。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const structure = await import(pathToFileURL(path.join(REPO, 'src', 'structure.js')).href);
const source = await import(pathToFileURL(path.join(REPO, 'src', 'source.js')).href);
const registry = await import(pathToFileURL(path.join(REPO, 'src', 'registry.js')).href);
const SAMPLES = path.join(REPO, 'test', 'fixtures', 'samples');
const read = (n) => fs.readFileSync(path.join(SAMPLES, n));

const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-diag-'));
function put(rel, data) {
  const full = path.join(backup, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}
put('oldmachine/.claude/projects/E--proj/aaaa.jsonl', read('claude-fork-origin.jsonl'));
put('oldmachine/.codex/sessions/2026/01/01/rollout-x-11111111.jsonl', read('codex-main.jsonl'));
put('oldmachine/.gemini/tmp/h1/chats/session-replay.jsonl', read('gemini-replay.jsonl'));
for (let i = 0; i < 8; i++) put(`decoys/pnpm-cache/f${i}.jsonl`, '{"x":1}\n');
put('decoys/pgAdmin/sessions/state.db', 'x');

const specs = registry.scanners.filter((s) => s.structureSpec).map((s) => s.structureSpec);
const anchorNames = specs.map((s) => String(s.rootAnchor.from || '').split('/')[0]).filter(Boolean);
console.log('anchorNames =', JSON.stringify([...new Set(anchorNames)]));
console.log('有 spec 的家 =', specs.map((s) => s.agent).join(', '));

const cands = structure.collectCandidates([backup], { anchorNames });
console.log('\ncollectCandidates 返回:');
for (const c of cands) console.log(`  ${c.path.replace(backup, '<backup>')}  files=${c.files} sessionDirs=${c.sessionDirs} name=${c.name}`);

const geminiDir = path.join(backup, 'oldmachine', '.gemini');
const claudeDir = path.join(backup, 'oldmachine', '.claude');
for (const [label, dir, agent] of [['gemini', geminiDir, 'gemini'], ['codebuddy@.claude', claudeDir, 'codebuddy'], ['claude-code@.claude', claudeDir, 'claude-code']]) {
  const spec = specs.find((s) => s.agent === agent);
  if (!spec) { console.log(`\n${label}: 没有 spec（这就是它被漏掉的原因）`); continue; }
  const r = structure.scoreStructure(spec, dir);
  console.log(`\n${label}: score=${r.score}/${spec.minScore} anchor=${r.anchor ? path.basename(r.anchor) : 'null'} dirHintMatch=${r.dirHintMatch}`);
  console.log('  evidence=', JSON.stringify(r.evidence));
  console.log('  anchorOf=', structure.anchorOf(dir, spec));
}

console.log('\nidentify() 结果:', JSON.stringify(source.identify([backup], { anchorNames }), (k, v) => k === 'path' ? String(v).replace(backup, '<backup>') : v, 2));
fs.rmSync(backup, { recursive: true, force: true });
