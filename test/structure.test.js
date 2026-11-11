import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { pathKey } from '../src/platform.js';
import { matchRel, scoreStructure, collectCandidates, anchorOf } from '../src/structure.js';
import { structureSpec as codexSpec } from '../src/scanners/codex.js';

/**
 * src/structure.js 的单元契约。
 *
 * 重点锁两件事（方案 2.4 / 2.5）：
 *   1. matchRel 的段匹配规则（自己写的 glob，零依赖）；
 *   2. 身份只由 structureSpec 强匹配决定——pnpm-cache / pgAdmin 的形状
 *      「像会话」但没有任何 spec 命中，绝不能被 scoreStructure 认成某一家。
 */

test('structure: matchRel 按 / 分段、* 单段、** 多段', () => {
  assert.equal(matchRel('sessions/2026/01/01/rollout-x.jsonl', 'sessions/**/rollout-*.jsonl'), true);
  assert.equal(matchRel('projects/E--demo/a.jsonl', 'projects/*/*.jsonl'), true);
  assert.equal(matchRel('sessions/rollout-a.jsonl.zst', 'sessions/**/rollout-*.jsonl.zst'), true);
  assert.equal(matchRel('a/b/c.jsonl', 'a/*/c.jsonl'), true);
  // * 不能跨段
  assert.equal(matchRel('a/b/c/d.jsonl', 'a/*/d.jsonl'), false);
  // ** 可以跨多段，也可以吃 0 段
  assert.equal(matchRel('a/x/y/z.jsonl', 'a/**/z.jsonl'), true);
  assert.equal(matchRel('a/z.jsonl', 'a/**/z.jsonl'), true);
  // 路径不匹配的形状
  assert.equal(matchRel('archived_sessions/a.jsonl', 'sessions/**/rollout-*.jsonl'), false);
});

test('structure: matchRel 的 ** 深度上限为 8（对齐 codex walk）', () => {
  const eight = 'a/' + 'x/'.repeat(8) + 'z.jsonl';
  const nine = 'a/' + 'x/'.repeat(9) + 'z.jsonl';
  assert.equal(matchRel(eight, 'a/**/z.jsonl'), true, '恰好 8 段应当匹配');
  assert.equal(matchRel(nine, 'a/**/z.jsonl'), false, '超过 8 段必须拒绝，防止病态展开');
});

test('structure: matchRel 归一斜杠、忽略首尾斜杠、大小写跟随 pathKey', () => {
  assert.equal(matchRel('a\\b\\c', 'a/b/c'), true, '反斜杠归一成正斜杠');
  assert.equal(matchRel('/a/b/', '/a/b/'), true, '首尾斜杠忽略');
  // 大小写行为与 platform.pathKey 一致：win32/darwin 折叠、linux 区分
  const folded = pathKey('A') === 'a';
  assert.equal(matchRel('SESSIONS/A/Rollout-X.JSONL', 'sessions/*/rollout-*.jsonl'), folded);
});

/** 造一棵混合树：一个真 codex 备份 + 三个 decoy（对应方案第 4 节 ⑨）。 */
function buildMixed(box) {
  const id = 'aaaa1111-2222-3333-4444-555555555555';
  const meta =
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id, session_id: id, cwd: '/Users/alice/old-proj' } }) + '\n';
  const user =
    JSON.stringify({ timestamp: '2026-01-01T00:01:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成会话' }] } }) + '\n';
  box.write('bundle/codex-backup/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-aaaa1111.jsonl', meta + user);
  for (let i = 0; i < 8; i++) box.write(`bundle/decoys/pnpm-cache/f${i}.jsonl`, '{}');
  box.write('bundle/decoys/pgAdmin/sessions/state.db', 'x');
  box.write('bundle/decoys/empty-agent/.keep', '');
  return path.join(box.dir, 'bundle');
}

test('structure: collectCandidates 找出候选但把「空壳」排除，hint 是「看到什么」句式', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const cs = collectCandidates([root]);
    const byName = new Map(cs.map((c) => [c.name, c]));

    assert.ok(byName.has('.codex'), '真 codex 块要被收进候选');
    assert.ok(byName.has('pnpm-cache'), 'pnpm-cache 作为未识别候选保留');
    assert.ok(byName.has('pgAdmin'), 'pgAdmin 作为未识别候选保留');
    assert.equal(byName.has('empty-agent'), false, '空壳目录不报（对齐 unknown.js）');
    assert.equal(byName.has('sessions'), false, '候选项不再下钻产生嵌套候选');

    for (const c of cs) assert.ok(c.hint.startsWith('看到'), `hint 必须是「看到什么」句式：${c.hint}`);
    assert.ok(byName.get('pnpm-cache').files >= 8, 'pnpm-cache 的 .jsonl 数量要如实');
    assert.ok(byName.get('pgAdmin').sessionDirs >= 1, 'pgAdmin 的 sessions 子目录要如实');
  } finally {
    box.cleanup();
  }
});

test('structure: collectCandidates 的 excludeNames 生效', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const cs = collectCandidates([root], { excludeNames: ['pnpm-cache', 'pgadmin'] });
    const names = cs.map((c) => c.name.toLowerCase());
    assert.equal(names.includes('pnpm-cache'), false);
    assert.equal(names.includes('pgadmin'), false);
    assert.ok(names.includes('.codex'), '排除项不应误伤真正的数据块');
  } finally {
    box.cleanup();
  }
});

test('structure: scoreStructure 只认强匹配，decoy 够不到阈值绝不绑定', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const cs = collectCandidates([root]);
    const scored = cs.map((c) => ({ name: c.name, r: scoreStructure(codexSpec, c.path) }));
    const codex = scored.find((x) => x.name === '.codex');
    assert.ok(codex.r.score >= codexSpec.minScore, '真 codex 块必须够阈值');
    assert.equal(codex.r.anchor, path.join(root, 'codex-backup', '.codex'), 'anchor 是应用根 .codex');
    assert.equal(codex.r.dirHintMatch, true, '.codex 命中 dirHints');
    assert.ok(codex.r.evidence.some((e) => e.pattern.includes('rollout')));

    // decoy 的「不变量」是够不到阈值、绝不绑定，而不是「必须 0 分」：
    // pgAdmin 有 sessions/ 目录会拿到 1 分，但离 minScore 3 差得远。
    for (const x of scored.filter((s) => s.name !== '.codex')) {
      assert.ok(x.r.score < codexSpec.minScore, `${x.name} 够不到阈值，绝不绑定（身份只由强匹配决定）`);
    }
  } finally {
    box.cleanup();
  }
});

test('structure: pgAdmin 有 sessions/ 但够不到 codex 阈值（防误报固化）', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const pg = collectCandidates([root]).find((c) => c.name === 'pgAdmin');
    const r = scoreStructure(codexSpec, pg.path);
    // 只有 {path:'sessions', kind:'dir'} 命中，得 1 分，够不到 minScore 3
    assert.ok(r.score > 0, '确实看到了 sessions 目录');
    assert.ok(r.score < codexSpec.minScore, '但分数够不到阈值，绝不绑定');
  } finally {
    box.cleanup();
  }
});

test('structure: anchorOf 从命中项上溯 N 层算应用根，支持嵌套与 allowSelf', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const appRoot = path.join(root, 'codex-backup', '.codex');
    assert.equal(anchorOf(appRoot, codexSpec), appRoot, 'sessions 的上一层就是 .codex');

    // 把整个 bundle 当搜索根：从 bundle 里找到 sessions 后上溯，仍落回同一个应用根
    assert.equal(anchorOf(root, codexSpec), appRoot, '任意深度嵌套都能反推应用根');

    // 没有标志性结构的目录返回 null
    const pnpm = path.join(root, 'decoys', 'pnpm-cache');
    assert.equal(anchorOf(pnpm, codexSpec), null);

    // zcode 形态：from 是多段文件、up=3
    const zSpec = {
      agent: 'zcode',
      probes: [{ path: 'cli/db/db.sqlite', kind: 'file', weight: 5 }],
      rootAnchor: { from: 'cli/db/db.sqlite', up: 3 },
      minScore: 5,
    };
    const zroot = box.mkdir('zcode-export/.zcode');
    box.write('zcode-export/.zcode/cli/db/db.sqlite', 'SQLite format 3');
    assert.equal(anchorOf(zroot, zSpec), zroot, 'cli/db/db.sqlite 上溯 3 层 = .zcode');
  } finally {
    box.cleanup();
  }
});

test('structure: contentProbe 只在 spec 命中后用于消歧，探针失败退回 0 分', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const appRoot = path.join(root, 'codex-backup', '.codex');
    const withProbe = {
      ...codexSpec,
      agent: 'codex-probe',
      minScore: 3,
      contentProbe: { bytes: 16, test: (head) => head.startsWith('NEVER_MATCH') },
    };
    const ok = scoreStructure({ ...withProbe, contentProbe: { bytes: 16, test: () => true } }, appRoot);
    assert.ok(ok.score >= 3, '探针通过时照常命中');
    const bad = scoreStructure(withProbe, appRoot);
    assert.equal(bad.score, 0, '探针失败退回 0 分（歧义交给上层，绝不硬猜）');
  } finally {
    box.cleanup();
  }
});

test('structure: deny 命中直接判 0', () => {
  const box = tempDir();
  try {
    const root = buildMixed(box);
    const appRoot = path.join(root, 'codex-backup', '.codex');
    const denied = { ...codexSpec, agent: 'codex-deny', deny: ['sessions/**/rollout-*.jsonl'] };
    assert.equal(scoreStructure(denied, appRoot).score, 0);
  } finally {
    box.cleanup();
  }
});
