import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanners } from '../src/registry.js';
import { detectGaps } from '../src/doctor.js';

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
