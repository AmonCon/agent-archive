/**
 * 收尾集成验证：给一个含「多家 Agent 数据」的假备份目录，用 --source 跑通
 * 「自动识别 → 解出多家会话 → 本机真数据不混进来」。
 *
 * P0 的 e2e 只验了单家 codex；这里补多家 + 一个 decoy（pnpm-cache/pgAdmin 形状）
 * 确认不误绑。全部在系统 temp + 隔离 AGENT_ARCHIVE_HOME，不碰本机真实会话。
 * 用法：node research/probes/verify-multi-source.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sandbox } from '../../test/helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = await import(pathToFileURL(path.join(REPO, 'src', 'registry.js')).href);
const source = await import(pathToFileURL(path.join(REPO, 'src', 'source.js')).href);

// 用现成的静态样本字节（无 BOM），按各家真实形状物化到假备份目录。
const SAMPLES = path.join(REPO, 'test', 'fixtures', 'samples');
const read = (n) => fs.readFileSync(path.join(SAMPLES, n));

const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-multisrc-'));
function put(rel, data) {
  const full = path.join(backup, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return full;
}

// 三家：claude-code / codex / gemini，外加两个 decoy
put('oldmachine/.claude/projects/E--proj/aaaa.jsonl', read('claude-fork-origin.jsonl'));
put('oldmachine/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-11111111.jsonl', read('codex-main.jsonl'));
put('oldmachine/.gemini/tmp/h1/chats/session-replay.jsonl', read('gemini-replay.jsonl'));
for (let i = 0; i < 8; i++) put(`decoys/pnpm-cache/f${i}.jsonl`, '{"x":1}\n');
// pgAdmin 的 sessions/ 里有 .db，但别叫 state.db —— 那恰好会命中 hermes 的
// 「state.db」单文件探针（identify() 单一命中时不校验 dirHints，见 LESSONS 第四轮）。
// 用 neutral.db 让 decoy 只测「有 sessions 子目录但无强特征」这一条，不引入额外变量。
put('decoys/pgAdmin/sessions/neutral.db', 'not a real db');

// 毒丸：本机（sandbox home）里放一个不该被显式 source 扫到的文件
const box = sandbox('aa-multisrc-state-');

let failed = 0;
function check(cond, label) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failed++;
}

try {
  await box.run(async () => {
    box.write('.claude/projects/E--poison/poison.jsonl', read('claude-fork-origin.jsonl'));
    const src = source.createSource({ paths: [backup], label: '多家假备份' });
    const p = source.plan(src);

    console.log('== plan(): 自动识别 ==');
    console.log(`  bindings: ${p.bindings.map((b) => `${b.agent}@${path.basename(b.root)}(${b.score})`).join(', ') || '（无）'}`);
    console.log(`  unmatched: ${p.unmatched.map((u) => u.name || path.basename(u.path)).join(', ') || '（无）'}`);
    console.log(`  ambiguous: ${p.ambiguous.length}`);

    check(p.bindings.some((b) => b.agent === 'claude-code'), 'claude-code 被识别');
    check(p.bindings.some((b) => b.agent === 'codex'), 'codex 被识别');
    check(p.bindings.some((b) => b.agent === 'gemini'), 'gemini 被识别');
    check(!p.bindings.some((b) => /pnpm|pgadmin/i.test(b.agent)), 'decoy 没被绑给任何家');
    check(p.ambiguous.length === 0, '无同构歧义');

    console.log('\n== scanAll({source}): 三家会话都解出、本机毒丸不混入 ==');
    registry.clearScanCache();
    const { sessions, stats } = registry.scanAll({ noCache: true, source: src });
    const byAgent = {};
    for (const s of sessions) byAgent[s.agent] = (byAgent[s.agent] || 0) + 1;
    console.log(`  会话 ${sessions.length} 场，按家: ${JSON.stringify(byAgent)}`);
    console.log(`  snapshot.source: ${JSON.stringify(stats.snapshot && stats.snapshot.source)}`);
    check((byAgent['claude-code'] || 0) >= 1, 'claude-code 有会话');
    check((byAgent['codex'] || 0) >= 1, 'codex 有会话');
    check((byAgent['gemini'] || 0) >= 1, 'gemini 有会话');
    check(!sessions.some((s) => String(s.project || '').includes('poison')), '本机毒丸没混进结果');
    check(!sessions.some((s) => String(s.source || '').includes('sandbox') || String(s.source || '').includes('aa-multisrc-state')), '没有会话来自本机 sandbox home');

    console.log('\n== 正文读取（外部根不被 assertUnderAny 误杀）==');
    for (const agent of ['claude-code', 'codex', 'gemini']) {
      const one = sessions.find((s) => s.agent === agent);
      if (!one) { check(false, `${agent} 找不到会话`); continue; }
      const scanner = registry.scanners.find((s) => s.name === agent);
      try {
        const msgs = scanner.readMessages(one, { roots: p.bindings.filter((b) => b.agent === agent).map((b) => b.root) });
        check(msgs && msgs.length > 0, `${agent} 正文读得出（${msgs ? msgs.length : 0} 条）`);
      } catch (e) {
        check(false, `${agent} 正文抛错: ${e.message}`);
      }
    }

    console.log('\n== 缓存隔离：两个不同 label 的同路径 source → manifestHash 不同 ==');
    const src2 = source.createSource({ paths: [backup], label: '另一份标记' });
    const s1 = registry.scanAll({ noCache: true, source: src });
    const s2 = registry.scanAll({ noCache: true, source: src2 });
    check(s1.stats.snapshot.manifestHash !== s2.stats.snapshot.manifestHash, '不同 source 的 manifestHash 不同');
    check(s1.sessions.length === s2.sessions.length, '但内容一致（同路径同数据）');
  });
} finally {
  box.cleanup();
  fs.rmSync(backup, { recursive: true, force: true });
}
console.log(`\n结果：${failed ? `失败 ${failed} 项` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
