import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanners } from '../src/registry.js';
import { detectGaps, auditCollection } from '../src/doctor.js';
import { sandbox } from './helpers.js';

/**
 * "谁能看哪里"只有一份事实源。
 *
 * 这条约束是血换来的：真 Mac 上 doctor 同一屏里写着「已接入：Qoder」，
 * 又把 `~/Library/Application Support/com.qodercn.app.stable` 列成
 * 「未适配」——因为扫描器会看那个目录，而 doctor 的清单是另一个人手写的，
 * 漏了。
 *
 * 现在扫描器用 `candidateRoots()` 声明自己会看哪些目录，doctor 与反向发现
 * 都消费它。下面两个用例锁的就是这个约定。
 */

test('契约：candidateRoots() 返回非空字符串数组', () => {
  let declared = 0;
  for (const s of scanners) {
    if (typeof s.candidateRoots !== 'function') continue;
    declared++;
    const roots = s.candidateRoots();
    assert.ok(Array.isArray(roots), `${s.name}.candidateRoots() 必须返回数组`);
    for (const r of roots) {
      assert.equal(typeof r, 'string', `${s.name} 的根必须是字符串`);
      assert.ok(r.length > 0, `${s.name} 的根不能是空串`);
    }
  }
  // 全部内置扫描器都该声明（用户扫描器可以没有，走兜底）
  const builtins = scanners.filter((s) => !s.__user);
  assert.equal(declared, builtins.length, '每个内置扫描器都要声明 candidateRoots');
});

test('契约：doctor 报的存储路径必须来自扫描器声明', () => {
  const gaps = detectGaps();
  for (const g of gaps) {
    const s = scanners.find((x) => x.name === g.agent);
    // 没接入的（Trae / Windsurf / Cline）没有扫描器，用清单兜底，跳过
    if (!s || typeof s.candidateRoots !== 'function') continue;
    const declared = new Set(s.candidateRoots());
    for (const h of g.hits || []) {
      assert.ok(
        declared.has(h.path),
        `${g.agent} 报了扫描器没声明的路径：${h.path}——两份清单又漂了`
      );
    }
  }
});

test('契约：反向发现不把扫描器自己声明的目录报成"未适配"', async () => {
  const { discoverUnknownStores } = await import('../src/doctor.js');
  const os = await import('node:os');
  const path = await import('node:path');

  const declared = new Set();
  for (const s of scanners) {
    if (typeof s.candidateRoots !== 'function') continue;
    for (const r of s.candidateRoots()) declared.add(path.resolve(r).toLowerCase());
  }

  const unknown = discoverUnknownStores();
  for (const u of unknown) {
    const abs = path.resolve(String(u.path).replace(/^~/, os.homedir())).toLowerCase();
    assert.ok(
      !declared.has(abs),
      `反向发现把扫描器声明的目录报成未适配了：${u.path}——"已知范围"没接上`
    );
  }
});

/**
 * 造一个 parse 必抛的扫描器，直接推进注册表。
 *
 * 不走 scanner-loader：这一层要验的是**诊断链路**（异常 → stats.problems →
 * doctor 输出），不是用户扫描器的加载过程；多绕一层只会让失败原因变模糊。
 *
 * 用完必须从 scanners 里摘掉：这个数组是模块级的，留着会让同文件后面的
 * 用例（以及"candidateRoots 契约"那种数条数的用例）看到一家不存在的 Agent。
 */
function withThrowingScanner(box, { files }) {
  const paths = files.map((rel, i) => box.write(rel, `{"broken":${i}}`));
  const fake = {
    name: 'aa-throwing',
    discover: () => paths.slice(),
    parse() {
      throw new Error('模拟解析失败：文件被截断');
    },
    candidateRoots: () => [box.path('.aa-throwing')],
  };
  scanners.push(fake);
  return () => {
    const i = scanners.indexOf(fake);
    if (i >= 0) scanners.splice(i, 1);
  };
}

test('doctor: 解析失败要说清哪一家、哪个文件、为什么', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const undo = withThrowingScanner(box, { files: ['.aa-throwing/session-1.json'] });
      try {
        const r = await auditCollection({ noCache: true });

        assert.equal(r.problems.total, 1, '要报出有一个采集问题');
        assert.equal(r.problems.byKind.parse, 1, '解析抛错要单独归为一类');
        assert.equal(r.problems.byKind.emptied, 0, '这次没有"解析为空"，不能凭空报');

        const p = r.problems.top[0];
        assert.ok(p, '要列出具体条目');
        assert.equal(p.agent, 'aa-throwing', '要说是哪一家');
        assert.match(p.file, /session-1\.json$/, '要说是哪个文件');
        assert.ok(p.file.startsWith('~'), '路径要缩写成 ~，否则一屏放不下三条');
        assert.match(p.reason, /文件被截断/, '要带出解析器给的原因，而不是只说"失败"');

        // 渲染成终端行时也要能看出身份，不能只有个总数
        const text = r.problems.lines.join('\n');
        assert.match(text, /aa-throwing/, '渲染结果里要出现 Agent 名');
        assert.match(text, /session-1\.json/, '渲染结果里要出现文件名');
      } finally {
        undo();
      }
    });
  } finally {
    box.cleanup();
  }
});

test('doctor: 明细有上限，但总数仍如实（超过 50 条不能报成 50）', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const files = Array.from({ length: 60 }, (_, i) => `.aa-throwing/s-${i}.json`);
      const undo = withThrowingScanner(box, { files });
      try {
        const r = await auditCollection({ noCache: true });

        // 60 个文件全失败：明细封顶 50 条（缓存不能被诊断撑大），
        // 但 doctor 报的总数必须还是 60——否则坏得越多，报告看起来反而越正常
        assert.equal(r.problems.top.length, 5, '只列前 5 条');
        assert.equal(r.problems.byKind.parse, 60, '计数按每家失败数如实累加');
        assert.equal(r.problems.total, 60, '总数不能被明细上限截断');
        assert.equal(r.problems.dropped, 10, '被省略的条数要如实记下来');
        assert.match(r.problems.lines.join('\n'), /另有 10 个/);
      } finally {
        undo();
      }
    });
  } finally {
    box.cleanup();
  }
});
