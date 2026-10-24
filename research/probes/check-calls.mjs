/**
 * 调用层回归。
 *
 * 这一层最容易错的地方不是解析，而是**口径**：
 *
 *   1. 缓存命中率的分母。写成"缓存读 / 总输入"会把缓存写也算进去，
 *      数字看似合理但偏小；只算未缓存输入才对。
 *   2. 失败调用。429/499/5xx 也占时间、也可能计费，混进平均速度会失真。
 *   3. 覆盖率。调用日志只覆盖"经过网关的调用"，必须同时给出
 *      匹配上的和总数，不能只报前者。
 *
 * 断言针对结构，不针对本机具体数字——换台机器数字会变。
 *
 * 用法：
 *   node research/probes/check-calls.mjs
 */

import { readCalls, summarizeCalls, attachToSessions, canonicalAgent } from '../../src/calls.js';

let failed = 0;
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

console.log('\n调用层');

const r = readCalls();

// 没装网关时必须优雅降级，而不是抛错——这是可选层
if (!r.ready) {
  console.log('  · 本机没有调用日志，只验证降级路径');
  check('未就绪时给出原因而不是抛错', typeof r.message === 'string' && r.message.length > 0, r.message.slice(0, 60));
  check('未就绪时 calls 是空数组', Array.isArray(r.calls) && r.calls.length === 0);
  console.log(`\n全部通过（${passed} 项）`);
  process.exit(0);
}

check('读到了调用记录', r.calls.length > 0, `${r.calls.length} 次`);
check('给出了时间范围', Boolean(r.range && r.range.start && r.range.end));

// 逐字段检查：这些字段一旦解析错，成本视图就全是错的
const c = r.calls.find((x) => x.cacheRead > 0) || r.calls[0];
check('输入 token 是非负数字', Number.isFinite(c.in) && c.in >= 0);
check('输出 token 是非负数字', Number.isFinite(c.out) && c.out >= 0);
check('缓存读是非负数字', Number.isFinite(c.cacheRead) && c.cacheRead >= 0);
check(
  '时间解析成了 Date 而不是字符串',
  c.time instanceof Date && !Number.isNaN(c.time.getTime())
);

// 会话 id：优先 native_session（和归档一致），没有才退到网关请求头
const withSession = r.calls.filter((x) => x.session);
check('有调用能拿到会话 id', withSession.length > 0, `${withSession.length}/${r.calls.length}`);
if (withSession.length) {
  const native = withSession.filter((x) => x.sessionFrom === 'native');
  check(
    '会话 id 优先来自 native_session',
    native.length > 0,
    `${native.length} 条来自 native，${withSession.length - native.length} 条退到 header`
  );
}

console.log('\n口径');
const rows = summarizeCalls({ calls: r.calls, groupBy: 'agent' });
check('按 Agent 汇总出了分组', rows.length > 0, `${rows.length} 组`);

const g = rows.find((x) => x.cacheRead > 0) || rows[0];
if (g) {
  // 关键：分母只含未缓存输入，不含缓存写
  const expected = g.cacheRead + g.in > 0 ? g.cacheRead / (g.cacheRead + g.in) : null;
  check(
    '缓存命中率分母只含未缓存输入',
    expected === null || Math.abs(g.cacheHit - expected) < 1e-9,
    g.cacheHit == null ? '(无缓存数据)' : `${(g.cacheHit * 100).toFixed(1)}%`
  );

  // 若把缓存写也算进分母，命中率必然更小。这里确认我们没有那样做。
  const wrong = g.cacheRead + g.in + g.cacheWrite > 0 ? g.cacheRead / (g.cacheRead + g.in + g.cacheWrite) : null;
  if (wrong !== null && g.cacheWrite > 0) {
    check('没有把缓存写算进命中率分母', g.cacheHit > wrong, `${(g.cacheHit * 100).toFixed(1)}% vs 错误口径 ${(wrong * 100).toFixed(1)}%`);
  }

  check('总输入 = 未缓存 + 缓存读 + 缓存写', g.input === g.in + g.cacheRead + g.cacheWrite);
}

// 失败调用不该计入耗时/速度统计
const withFail = rows.find((x) => x.failed > 0);
if (withFail) {
  check(
    '失败调用被单独计数（没混进 ok）',
    withFail.failed > 0 && withFail.ok + withFail.failed === withFail.calls,
    `${withFail.ok} 成功 + ${withFail.failed} 失败 = ${withFail.calls}`
  );
}

console.log('\n覆盖率诚实性');
const fakeIndex = r.calls
  .filter((x) => x.session)
  .slice(0, 3)
  .map((x) => ({ id: x.session, agent: x.agent }));
const link = attachToSessions(r.calls, fakeIndex);
check('匹配上时报告 matched 数', link.matched.length > 0, `${link.matched.length} 次`);
check('同时报告总数', link.totalCalls === r.calls.length);
check(
  '同时报告"没有 session id"的条数',
  Number.isFinite(link.withoutSession),
  `${link.withoutSession} 次`
);
check(
  'matched + unmatched 等于总数',
  link.matched.length + link.unmatched.length === r.calls.length
);

// agent 名对齐：网关叫 qoder-cn，归档叫 qoder。对不上就永远匹配不到。
check('agent 别名归一（qoder-cn → qoder）', canonicalAgent('qoder-cn') === 'qoder');
check('agent 别名归一（claude → claude-code）', canonicalAgent('claude') === 'claude-code');

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（${passed} 项通过）`);
process.exit(failed ? 1 : 0);
