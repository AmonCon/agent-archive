import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, tempDir, sourceBox, withEnv, codexMeta, codexUser } from './helpers.js';
import { createSource, localSource, plan, sourceId } from '../src/source.js';
import { scanAll, scanCached, clearScanCache, cacheLocation } from '../src/registry.js';
import { listProjects } from '../src/query.js';
import * as codexScanner from '../src/scanners/codex.js';

/**
 * 数据源解耦的端到端链路（方案第 4 节 ①③④⑤⑥⑧⑨）。
 *
 * 铁律：**不靠改 HOME 伪装本机就能解出别处的数据**（sourceBox 只重定向
 * AGENT_ARCHIVE_HOME）；本机真数据/毒丸一条都不能混进显式 source 的结果。
 */

/** 在 root 下写一份最小 Codex rollout，返回文件路径。 */
function writeRollout(root, { id = 'abcdef01-1111-2222-3333-444444444444', cwd = '/Users/alice/old-proj', text = '合成会话' } = {}) {
  const file = path.join(root, '.codex', 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${id.slice(0, 8)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    codexMeta({ id, cwd, timestamp: '2026-01-01T00:00:00Z' }) + codexUser(text, '2026-01-01T00:01:00Z')
  );
  return file;
}

/** 把仓库里固化的合成样本整份拷进临时目录（不进 samples/，不触发元测试）。 */
function copyMixedBundle(box, destRel = 'backup') {
  const src = path.join(process.cwd(), 'test', 'fixtures', 'sources', 'mixed-bundle');
  const dest = path.join(box.dir, destRel);
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

/** 跑一个 CLI 子命令，返回 stdout（沿用 test/cli.test.js 的隔离写法）。 */
function runCli(env, args) {
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', 'src/cli.js', ...args], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('source-e2e: scanAll({source}) 全链路 + 本机真数据一条都没进结果（毒丸）', async () => {
  const box = sourceBox();
  try {
    const bundle = copyMixedBundle(box);
    await box.run(async () => {
      clearScanCache();
      const S = createSource({ paths: [bundle] });

      // 毒丸：放在 source 根之外、形状完全是 codex，并通过官方覆盖变量 CODEX_HOME
      // 让它成为「本机默认根」的一员。显式 source 绝不许把它读进来。
      const poisonRoot = path.join(box.dir, 'poison');
      writeRollout(poisonRoot, { id: 'poison-deadbeef', cwd: 'D:/poison', text: '毒丸：本机真数据' });

      await withEnv({ CODEX_HOME: path.join(poisonRoot, '.codex') }, () => {
        const p = plan(S);
        assert.equal(p.bindings.length, 1, '混合包里只应识别出一个 codex 块');
        assert.equal(p.bindings[0].agent, 'codex');

        const r = scanAll({ noCache: true, source: S });
        assert.equal(r.sessions.length, 1, '只解析出备份里的那一场会话');
        const s = r.sessions[0];
        assert.equal(s.agent, 'codex');
        assert.notEqual(s.id, 'poison-deadbeef', '毒丸绝不能出现');
        assert.ok(s.source.startsWith(bundle), '每条结果都来自 source 根，本机真数据零混入');
        assert.ok(!s.source.includes('decoys'), 'decoy 文件绝不被解析');
        assert.equal(r.stats.snapshot.source.kind, 'explicit', '显式 source 要记进 manifest');

        // decoy 只进未识别候选，且输出是「看到什么」句式
        const names = p.unmatched.map((u) => path.basename(u.path).toLowerCase());
        assert.ok(names.includes('pnpm-cache'), 'pnpm-cache 出现在未识别候选');
        assert.ok(names.includes('pgadmin'), 'pgAdmin 出现在未识别候选');
        assert.equal(names.includes('empty-agent'), false, '空壳不报');
        for (const u of p.unmatched) assert.ok(u.hint.startsWith('看到'));

        // 正文读取：ctx.roots 让外部根不被 assertUnderAny 误杀
        const appRoot = p.bindings[0].root;
        const msgs = codexScanner.readMessages(s, { roots: [appRoot] });
        assert.ok(
          msgs.some((m) => m.parts.some((x) => x.kind === 'text' && x.text.includes('合成样本'))),
          '外部根的正文要能读出来'
        );
        assert.throws(() => codexScanner.readMessages(s), /拒绝读取根目录之外的路径/, '不带 ctx.roots 时外部根应被越界校验挡住');

        // 查询层透传
        const lp = listProjects({ noCache: true, source: S });
        assert.equal(lp.totalSessions, 1);
        assert.equal(lp.projects.length, 1);
        assert.equal(lp.projects[0].display, '/Users/alice/old-proj', '别机的 cwd 原样保留，不重写成本机路径');
      });
    });
  } finally {
    box.cleanup();
  }
});

test('source-e2e: 不给 source 与 source=localSource() 完全等价（manifestHash 不变、无 source 字段）', async () => {
  const box = sandbox();
  try {
    writeRollout(box.home, { id: 'local-0001', cwd: 'C:/work/local', text: '本机会话' });
    await box.run(async () => {
      clearScanCache();
      const a = scanAll({ noCache: true, only: ['codex'] });
      const b = scanAll({ noCache: true, only: ['codex'], source: localSource() });
      assert.equal(a.stats.snapshot.manifestHash, b.stats.snapshot.manifestHash, 'localSource 不得改变 manifestHash');
      assert.equal(a.sessions.length, b.sessions.length);
      assert.equal(a.stats.snapshot.source, undefined, '不给 source 时 snapshot 一个字段都不加');
      assert.equal(b.stats.snapshot.source, undefined, 'localSource 也不加');
      assert.ok(cacheLocation().endsWith('scan-v5.json'), 'local 缓存文件名保持 scan-v5.json（老缓存继续命中）');
      // scanCached 的 local 命名空间也走老路径
      const c = scanCached({ noCache: true });
      assert.equal(c.stats.snapshot.manifestHash.length, 16);
      assert.equal(c.stats.snapshot.source, undefined);
    });
  } finally {
    box.cleanup();
  }
});

test('source-e2e: 缓存按 sourceId 分命名空间，两份数据 manifestHash 不同、TTL 不串', async () => {
  const box = sourceBox();
  try {
    const rootA = path.join(box.dir, 'a');
    const rootB = path.join(box.dir, 'b');
    writeRollout(rootA, { id: '11111111-1111-1111-1111-111111111111', cwd: '/old/a', text: 'A 会话' });
    writeRollout(rootB, { id: '22222222-2222-2222-2222-222222222222', cwd: '/old/b', text: 'B 会话' });

    await box.run(async () => {
      clearScanCache();
      const S1 = createSource({ paths: [rootA] });
      const S2 = createSource({ paths: [rootB] });
      const r1 = scanAll({ noCache: true, source: S1 });
      const r2 = scanAll({ noCache: true, source: S2 });
      assert.notEqual(r1.stats.snapshot.manifestHash, r2.stats.snapshot.manifestHash, '两份数据 manifestHash 必须不同');
      assert.equal(r1.sessions[0].id, '11111111-1111-1111-1111-111111111111');
      assert.equal(r2.sessions[0].id, '22222222-2222-2222-2222-222222222222');

      // 各自的磁盘缓存文件都存在，且显式 source 不写 local 的 scan-v5.json
      const files = fs.readdirSync(path.join(box.state, 'cache'));
      assert.ok(files.includes(`scan-v5-${sourceId(S1)}.json`));
      assert.ok(files.includes(`scan-v5-${sourceId(S2)}.json`));
      assert.equal(files.includes('scan-v5.json'), false);

      // 进程内 TTL 也按 sourceId 隔离，互不串数据
      const c1 = scanCached({ source: S1 });
      const c2 = scanCached({ source: S2 });
      assert.notEqual(c1.stats.snapshot.manifestHash, c2.stats.snapshot.manifestHash);
      assert.equal(c1.sessions[0].id, '11111111-1111-1111-1111-111111111111');
      assert.equal(c2.sessions[0].id, '22222222-2222-2222-2222-222222222222');

      // 同一路径、不同 label 也是不同命名空间（⑥「同路径不同内容」）
      const SA = createSource({ paths: [rootA], label: 'A' });
      const SB = createSource({ paths: [rootA], label: 'B' });
      assert.notEqual(sourceId(SA), sourceId(SB));
      assert.notEqual(
        scanAll({ noCache: true, source: SA }).stats.snapshot.manifestHash,
        scanAll({ noCache: true, source: SB }).stats.snapshot.manifestHash
      );
    });
  } finally {
    box.cleanup();
  }
});

test('source-e2e: CLI projects --source 解出备份会话，本机毒丸不混入；不带 --source 行为不变', () => {
  const box = sandbox();
  const src = tempDir();
  try {
    // 假家目录里放一条「本机真数据」毒丸；源数据放在假家目录之外、用 --source 显式给。
    writeRollout(box.home, { id: 'local-poison', cwd: 'C:/work/local', text: '本机真数据' });
    const backup = path.join(src.dir, 'backup');
    writeRollout(backup, { id: 'backup-session-0001', cwd: '/Users/alice/old-proj', text: '来自备份' });

    // 与 sandbox().run() 同款隔离：平台默认根（APPDATA/XDG_*）必须一起改掉，
    // 否则不带 --source 时会读到跑测试那台机器的真实会话（实测 193 条）。
    const env = {
      ...process.env,
      USERPROFILE: box.home,
      HOME: box.home,
      AGENT_ARCHIVE_HOME: box.state,
      APPDATA: path.join(box.dir, 'appdata'),
      LOCALAPPDATA: path.join(box.dir, 'localappdata'),
      XDG_DATA_HOME: path.join(box.dir, 'xdg-data'),
      XDG_CONFIG_HOME: path.join(box.dir, 'xdg-config'),
      XDG_CACHE_HOME: path.join(box.dir, 'xdg-cache'),
    };
    for (const k of [
      'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'DSH_HOME', 'QODER_CONFIG_DIR',
      'OPENCODE_DATA_DIR', 'OPENCODE_DB', 'CURSOR_CONFIG_DIR', 'KIRO_HOME',
    ]) delete env[k];

    const withSource = runCli(env, ['projects', '--source', backup, '--json']);
    const j1 = JSON.parse(withSource.out);
    assert.equal(j1.totalSessions, 1, '显式 source 下只有备份那一场，本机毒丸零混入');
    assert.equal(j1.projects.length, 1);
    assert.equal(j1.projects[0].sessions[0].id, 'backup-session-0001');
    assert.equal(j1.stats.snapshot.source.kind, 'explicit');

    const noSource = runCli(env, ['projects', '--json']);
    const j2 = JSON.parse(noSource.out);
    assert.equal(j2.totalSessions, 1, '不带 --source 时仍是本机那一条（与改造前一致）');
    assert.equal(j2.projects[0].sessions[0].id, 'local-poison');
    assert.equal(j2.stats.snapshot.source, undefined, '不带 --source 时 snapshot 不加 source 字段');
  } finally {
    box.cleanup();
    src.cleanup();
  }
});

test('source-e2e: 有绑定但缺 discoverWithin 的扫描器记 source-unsupported 并跳过，绝不退回本机', async () => {
  const box = sourceBox();
  try {
    const root = path.join(box.dir, 'fake');
    fs.mkdirSync(path.join(root, 'fakeapp', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fakeapp', 'sessions', 'marker.jsonl'), '{}');

    // 临时往注册表塞一个「有 structureSpec、无 discoverWithin」的扫描器
    const registry = await import('../src/registry.js');
    const fake = {
      name: 'fake-no-dw',
      structureSpec: {
        agent: 'fake-no-dw',
        probes: [{ glob: 'sessions/**/marker.jsonl', kind: 'file', weight: 5 }],
        rootAnchor: { from: 'sessions', up: 1 },
        dataPaths: ['sessions'],
        format: 'x',
        minScore: 5,
      },
      discover() {
        return [];
      },
      parse() {
        return null;
      },
    };
    registry.scanners.push(fake);
    try {
      await box.run(async () => {
        clearScanCache();
        const S = createSource({ paths: [root] });
        const r = registry.scanAll({ noCache: true, source: S });
        const prob = r.stats.problems.find((p) => p.kind === 'source-unsupported' && p.agent === 'fake-no-dw');
        assert.ok(prob, '必须记一条 source-unsupported problem');
        assert.equal(r.sessions.length, 0, '绝不静默退回扫本机');
      });
    } finally {
      registry.scanners.pop();
    }
  } finally {
    box.cleanup();
  }
});
