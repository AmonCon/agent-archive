import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';
import {
  localSource,
  createSource,
  sourceFromConfig,
  resolveSource,
  sourceId,
  identify,
  plan,
} from '../src/source.js';
import { structureSpec as codexSpec } from '../src/scanners/codex.js';

/**
 * src/source.js 的七函数 + identify/plan 的契约。
 *
 * 纪律（方案 2.2 / 2.5）：身份只由 structureSpec 强匹配决定；同构歧义进
 * ambiguous 绝不猜；localSource 代表「扫本机」，缓存/manifest 都保持老行为。
 */

/** 造一棵含真 codex 块 + 三个 decoy 的混合包；返回源根。 */
function mixedBundle(box) {
  const id = 'aaaa1111-2222-3333-4444-555555555555';
  const meta =
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id, session_id: id, cwd: '/Users/alice/old-proj' } }) + '\n';
  const user =
    JSON.stringify({ timestamp: '2026-01-01T00:01:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成会话' }] } }) + '\n';
  box.write('bundle/codex-backup/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-aaaa1111.jsonl', meta + user);
  for (let i = 0; i < 10; i++) box.write(`bundle/decoys/pnpm-cache/f${i}.jsonl`, '{}');
  box.write('bundle/decoys/pgAdmin/sessions/state.db', 'x');
  box.write('bundle/decoys/empty-agent/.keep', '');
  return path.join(box.dir, 'bundle');
}

test('source: localSource 固定 local，不给 source 的行为由它代表', () => {
  const s = localSource();
  assert.equal(s.kind, 'local');
  assert.equal(s.id, 'local');
  assert.deepEqual(s.roots, []);
  assert.equal(s.autoDetect, false);
  assert.equal(sourceId(s), 'local');
  assert.equal(plan(s).sourceId, 'local', 'localSource 的 plan 命名空间是 local');
  assert.equal(plan(s).bindings.length, 0);
});

test('source: createSource 收 paths/roots、逗号分隔、label、origin，id 稳定', () => {
  const a = createSource({ paths: ['/x/a', '/x/b'], label: '旧机 2026-10', origin: { home: '/Users/alice', platform: 'darwin' } });
  assert.equal(a.kind, 'explicit');
  assert.deepEqual(a.roots, [path.resolve('/x/a'), path.resolve('/x/b')]);
  assert.equal(a.label, '旧机 2026-10');
  assert.deepEqual(a.origin, { home: '/Users/alice', platform: 'darwin' });
  assert.match(a.id, /^[0-9a-f]{12}$/);
  // 同样输入 → 同样 id；顺序无关（roots 排序后哈希）
  assert.equal(sourceId(createSource({ paths: ['/x/b', '/x/a'], label: '旧机 2026-10' })), a.id);
  // 字符串入参、逗号分隔
  assert.deepEqual(createSource('/x/a').roots, [path.resolve('/x/a')]);
  assert.deepEqual(createSource({ paths: ['/x/a,/x/b'] }).roots, [path.resolve('/x/a'), path.resolve('/x/b')]);
});

test('source: sourceId 对 label / roots 敏感，local 恒为 local', () => {
  const s1 = createSource({ paths: ['/x/a'] });
  const s2 = createSource({ paths: ['/x/a'], label: 'A' });
  const s3 = createSource({ paths: ['/x/a'], label: 'B' });
  assert.notEqual(s1.id, s2.id, 'label 参与哈希');
  assert.notEqual(s2.id, s3.id, '不同 label 是不同命名空间');
  assert.equal(sourceId(null), 'local');
  assert.equal(sourceId(localSource()), 'local');
});

test('source: createSource 的 agent / bindings 生成显式绑定', () => {
  const s = createSource({ paths: ['/x/.claude'], agent: 'claude-code' });
  assert.equal(s.agent, 'claude-code');
  assert.deepEqual(s.bindings, [{ agent: 'claude-code', root: path.resolve('/x/.claude') }]);
  const p = plan(s, { specs: [] }); // 不让自动识别掺和，只看显式绑定
  assert.equal(p.bindings.length, 1);
  assert.equal(p.bindings[0].agent, 'claude-code');
  assert.equal(p.bindings[0].evidence[0], '显式指定');
});

test('source: sourceFromConfig 老两键语义不变、只读叠加 sources/defaultSource', () => {
  // 无 config、无 cli → local
  assert.equal(sourceFromConfig(null, {}).kind, 'local');
  // 老 config（只有 roots/disabled）→ 仍是 local，不擅自改默认
  assert.equal(sourceFromConfig({ roots: { codex: ['/x'] }, disabled: ['kiro'] }, {}).kind, 'local');
  // cli 覆盖优先
  const cli = sourceFromConfig({}, { sources: ['/x/backup'] });
  assert.equal(cli.kind, 'explicit');
  assert.deepEqual(cli.roots, [path.resolve('/x/backup')]);
  // 新 config：按 label 选 source
  const cfg = {
    sources: [{ path: '/x/export', label: 'claude 导出', agent: 'claude-code' }],
    defaultSource: 'claude 导出',
  };
  const byName = sourceFromConfig(cfg, {});
  assert.equal(byName.kind, 'explicit');
  assert.equal(byName.agent, 'claude-code');
  assert.deepEqual(byName.roots, [path.resolve('/x/export')]);
});

test('source: resolveSource 没给显式来源时退回 local，给了就显式', () => {
  assert.equal(resolveSource({}).kind, 'local');
  assert.equal(resolveSource({ cliSources: [] }).kind, 'local');
  const multi = resolveSource({ cliSources: ['/a', '/b,/c'], cliBindings: ['codex:/d'] });
  assert.equal(multi.kind, 'explicit');
  assert.deepEqual(multi.roots, [path.resolve('/a'), path.resolve('/b'), path.resolve('/c'), path.resolve('/d')]);
  assert.ok(multi.bindings.some((b) => b.agent === 'codex' && b.root === path.resolve('/d')));
  const wl = resolveSource({ cliSources: ['/a'], withLocal: true });
  assert.equal(wl.withLocal, true, 'withLocal 仅保留标记，P0 不在 scanAll 里叠加本机');
});

test('source: identify 混合包——1 个 codex binding，decoy 只进 unmatched 且是「看到什么」', () => {
  const box = tempDir();
  try {
    const root = mixedBundle(box);
    const r = identify([root], { specs: [codexSpec] });
    assert.equal(r.bindings.length, 1);
    assert.equal(r.bindings[0].agent, 'codex');
    assert.equal(r.bindings[0].root, path.join(root, 'codex-backup', '.codex'));
    assert.equal(r.ambiguous.length, 0);

    const names = r.unmatched.map((u) => path.basename(u.path).toLowerCase());
    assert.ok(names.includes('pnpm-cache'), 'pnpm-cache 出现在未识别候选');
    assert.ok(names.includes('pgadmin'), 'pgAdmin 出现在未识别候选');
    assert.equal(names.includes('empty-agent'), false, '空壳不报');
    for (const u of r.unmatched) {
      assert.ok(u.hint.startsWith('看到'), '只陈述看到什么，不下结论');
      assert.equal(/某家|codex|agent 会话库/i.test(u.hint), false, 'hint 绝不下「这是某家」的结论');
    }
  } finally {
    box.cleanup();
  }
});

test('source: identify 同构歧义进 ambiguous，绝不按最高分猜', () => {
  const box = tempDir();
  try {
    // 一个含 sessions/ 的目录，两家 spec 都命中且分数相同
    box.mkdir('iso/.codex/sessions');
    box.write('iso/.codex/sessions/a.jsonl', '{}');
    const root = path.join(box.dir, 'iso');
    const specA = {
      agent: 'A', minScore: 1,
      probes: [{ path: 'sessions', kind: 'dir', weight: 3 }],
      rootAnchor: { from: 'sessions', up: 1 },
    };
    const specB = { ...specA, agent: 'B' };
    const r = identify([root], { specs: [specA, specB] });
    assert.equal(r.bindings.length, 0, '同构歧义绝不产生 binding');
    assert.equal(r.unmatched.length, 0);
    assert.equal(r.ambiguous.length, 1);
    assert.deepEqual(r.ambiguous[0].agents.slice().sort(), ['A', 'B']);
  } finally {
    box.cleanup();
  }
});

test('source: identify 用 dirHints 唯一消歧（唯一命中才采信）', () => {
  const box = tempDir();
  try {
    box.mkdir('iso/.codex/sessions');
    box.write('iso/.codex/sessions/a.jsonl', '{}');
    const root = path.join(box.dir, 'iso');
    const specA = {
      agent: 'A', minScore: 1,
      probes: [{ path: 'sessions', kind: 'dir', weight: 3 }],
      rootAnchor: { from: 'sessions', up: 1 },
    };
    const specB = { ...specA, agent: 'B', dirHints: ['.codex'] };
    const r = identify([root], { specs: [specA, specB] });
    assert.equal(r.ambiguous.length, 0);
    assert.equal(r.bindings.length, 1);
    assert.equal(r.bindings[0].agent, 'B', '唯一 dirHint 命中的那家胜出');
  } finally {
    box.cleanup();
  }
});

test('source: identify 混合包多 binding 互不串（用 mock 三家 spec 覆盖 ②）', () => {
  const box = tempDir();
  try {
    // 三块各自像一家、形状互不相同
    box.write('bundle/a/.fa/projects/p/a.jsonl', '{}');
    box.write('bundle/b/.fb/sessions/2026/01/01/rollout-x.jsonl', '{}');
    box.write('bundle/c/.fc/cli/db/db.sqlite', 'x');
    const mk = (agent, from, up, glob) => ({
      agent, minScore: 3,
      probes: [{ glob, kind: 'file', weight: 4 }, { path: from, kind: 'dir', weight: 1 }],
      rootAnchor: { from, up },
    });
    const specs = [
      mk('fa', 'projects', 1, 'projects/*/*.jsonl'),
      mk('fb', 'sessions', 1, 'sessions/**/rollout-*.jsonl'),
      mk('fc', 'cli', 1, 'cli/db/db.sqlite'),
    ];
    const r = identify([path.join(box.dir, 'bundle')], { specs });
    const agents = r.bindings.map((b) => b.agent).sort();
    assert.deepEqual(agents, ['fa', 'fb', 'fc']);
    // 每个 binding 的 root 落在自己那块下，不串到别家
    for (const b of r.bindings) {
      const marker = { fa: '.fa', fb: '.fb', fc: '.fc' }[b.agent];
      assert.ok(b.root.includes(marker), `${b.agent} 的 root 应落在 ${marker}`);
    }
  } finally {
    box.cleanup();
  }
});

test('source: plan 把 sourceId 带上，显式 binding 与自动绑定按 (agent,root) 去重', () => {
  const box = tempDir();
  try {
    const root = mixedBundle(box);
    const s = createSource({ paths: [root], label: '混合包' });
    const p = plan(s, { specs: [codexSpec] });
    assert.match(p.sourceId, /^[0-9a-f]{12}$/);
    assert.equal(p.sourceId, sourceId(s));
    assert.equal(p.bindings.length, 1);
    // 显式再绑同一个 (agent, root)，不该出现第二条
    const s2 = createSource({
      paths: [root],
      bindings: [{ agent: 'codex', root: p.bindings[0].root }],
    });
    const p2 = plan(s2, { specs: [codexSpec] });
    assert.equal(p2.bindings.length, 1, '同一家同一应用根去重');
  } finally {
    box.cleanup();
  }
});
