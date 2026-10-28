import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import { readCalls, summarizeCalls, attachToSessions, canonicalAgent } from '../src/calls.js';

/**
 * 调用层的口径契约。
 *
 * 这一层最容易被误读：它只看得见**经过网关**的调用，而且网关日志里有几类行
 * 根本不该参与"花了多少 / 多快 / 多爱失败"的计算。口径写错不会报错，
 * 只会让结论错——比如把网关本地拒绝算成"这个模型很爱失败"。
 */

/** 造一份 fixture 日志，返回 readCalls 能用的 sources。 */
function fixture(box, records) {
  const file = box.path('usage.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return [{ id: 'magpie', display: '测试网关', paths: [file] }];
}

test('calls: 网关本地拒绝单独计数，不进成功/失败与耗时统计', () => {
  const box = sandbox();
  try {
    const sources = fixture(box, [
      { t: '2026-01-01T00:00:00Z', agent: 'qoder-cn', model: 'm', status: 200, ms: 1000, in: 10, out: 5, credits: 1 },
      { t: '2026-01-01T00:01:00Z', agent: 'qoder-cn', model: 'm', status: 200, ms: 2000, in: 10, out: 5, credits: 1 },
      // 本地拒绝：没往上打、credits 0、ms 极小
      { t: '2026-01-01T00:02:00Z', agent: 'qoder-cn', model: 'm', status: 404, ms: 1, rejected: true, err: 'provider switched off' },
    ]);
    const { calls } = readCalls({ sources });
    const [g] = summarizeCalls({ calls, groupBy: 'agent' });

    assert.equal(g.calls, 3, '总行数如实报');
    assert.equal(g.rejected, 1, '拒绝要单列');
    assert.equal(g.upstreamCalls, 2, '真正打到上游的只有 2 次');
    assert.equal(g.ok, 2);
    assert.equal(g.failed, 0, '拒绝不能算失败——它不是上游返回的错');
    assert.equal(g.msKnown, 2, '平均耗时只算真正的上游调用');
    assert.equal(g.credits, 2, '拒绝的 credits 是 0，不该影响合计');
  } finally {
    box.cleanup();
  }
});

test('calls: 会话匹配必须带 agent，不能跨家错挂', () => {
  const box = sandbox();
  try {
    const sources = fixture(box, [
      { t: '2026-01-01T00:00:00Z', agent: 'qoder-cn', model: 'm', status: 200, session: 'session_abc', native_session: 'session_abc' },
      { t: '2026-01-01T00:01:00Z', agent: 'opencode', model: 'm', status: 200, session: 'session_abc', native_session: 'session_abc' },
    ]);
    const { calls } = readCalls({ sources });

    // 归档里只有 opencode 的一场 session_abc
    const index = [{ agent: 'opencode', id: 'session_abc' }];
    const r = attachToSessions(calls, index);

    assert.equal(r.matched.length, 1, '只有同 agent 的那次能挂上');
    assert.equal(r.matched[0].agent, 'opencode');
    assert.equal(r.unmatched.length, 1);
  } finally {
    box.cleanup();
  }
});

test('calls: agent 别名归一后才匹配（qoder-cn → qoder）', () => {
  const box = sandbox();
  try {
    const sources = fixture(box, [
      { t: '2026-01-01T00:00:00Z', agent: 'qoder-cn', model: 'm', status: 200, native_session: 'x1' },
    ]);
    const { calls } = readCalls({ sources });
    assert.equal(calls[0].agent, 'qoder', '别名要归一');
    const r = attachToSessions(calls, [{ agent: 'qoder', id: 'x1' }]);
    assert.equal(r.matched.length, 1);
  } finally {
    box.cleanup();
  }
});

test('calls: 缺网关时优雅降级，不报错', () => {
  const box = sandbox();
  try {
    const r = readCalls({ sources: [{ id: 'magpie', display: 'x', paths: [box.path('nope.jsonl')] }] });
    assert.equal(r.ready, false);
    assert.match(String(r.message), /网关/);
    assert.deepEqual(r.calls, []);
  } finally {
    box.cleanup();
  }
});

test('calls: 最后一行写了一半也能读，坏行只跳过不整体失败', () => {
  const box = sandbox();
  try {
    const file = box.path('usage.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const good = JSON.stringify({ t: '2026-01-01T00:00:00Z', agent: 'qoder', model: 'm', status: 200 });
    fs.writeFileSync(file, `${good}\n{"t":"2026-01-01T00:01`, 'utf8');

    const { calls, skipped } = readCalls({
      sources: [{ id: 'magpie', display: 'x', paths: [file] }],
    });
    assert.equal(calls.length, 1, '好行要读到');
    assert.ok(skipped.malformed >= 1, '坏行要在 skipped 里如实计数');
  } finally {
    box.cleanup();
  }
});

test('calls: credits 缺失时不估算（缺价就留空，不猜）', () => {
  const box = sandbox();
  try {
    const sources = fixture(box, [
      { t: '2026-01-01T00:00:00Z', agent: 'qoder', model: 'm', status: 200, in: 100, out: 50 },
    ]);
    const { calls } = readCalls({ sources });
    const [g] = summarizeCalls({ calls, groupBy: 'model' });
    assert.equal(g.creditsKnown, 0, '没有 credits 就不算已知');
    assert.equal(g.credits, 0);
  } finally {
    box.cleanup();
  }
});

test('calls: canonicalAgent 覆盖常见别名', () => {
  assert.equal(canonicalAgent('claude'), 'claude-code');
  assert.equal(canonicalAgent('qoder-cn'), 'qoder');
  assert.equal(canonicalAgent('ZCode'), 'zcode');
  assert.equal(canonicalAgent(null), null);
});
