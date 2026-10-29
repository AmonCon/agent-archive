import test from 'node:test';
import assert from 'node:assert/strict';
import { pickHandoffs, DISPLAY_LIMIT } from '../src/handoff.js';

/**
 * 抛给终端前的那一步挑选。
 *
 * 这一层坏掉不会报错——只会把用户淹没在几百行里，或者把最该看的几次
 * 换手排到看不见的地方。所以单独锁住。
 */

const h = (gapMinutes, extra = {}) => ({ gapMinutes, gapMs: (gapMinutes ?? 0) * 60000, ...extra });

test('handoff: 按间隔从大到小排，最重要的排最前', () => {
  const { shown } = pickHandoffs([h(10), h(3000), h(60)]);
  assert.deepEqual(
    shown.map((x) => x.gapMinutes),
    [3000, 60, 10]
  );
});

test('handoff: 间隔未知的排最后，不占前几名', () => {
  const { shown } = pickHandoffs([h(null), h(5), h(null), h(100)]);
  assert.deepEqual(
    shown.map((x) => x.gapMinutes),
    [100, 5, null, null]
  );
});

test('handoff: 默认只给前 12 条，并报出被截掉的条数', () => {
  const many = Array.from({ length: 30 }, (_, i) => h(i + 1));
  const r = pickHandoffs(many);
  assert.equal(r.shown.length, DISPLAY_LIMIT);
  assert.equal(r.total, 30);
  assert.equal(r.rest, 30 - DISPLAY_LIMIT);
  // 保留的是最大的那 12 个
  assert.equal(r.shown[0].gapMinutes, 30);
  assert.equal(r.shown[r.shown.length - 1].gapMinutes, 30 - DISPLAY_LIMIT + 1);
});

test('handoff: --all 时一条不少', () => {
  const many = Array.from({ length: 30 }, (_, i) => h(i + 1));
  const r = pickHandoffs(many, { all: true });
  assert.equal(r.shown.length, 30);
  assert.equal(r.rest, 0);
});

test('handoff: 不足上限时不提示截断', () => {
  const r = pickHandoffs([h(1), h(2)]);
  assert.equal(r.rest, 0);
  assert.equal(r.total, 2);
});

test('handoff: 不修改传入的数组', () => {
  const input = [h(1), h(9), h(5)];
  const before = input.map((x) => x.gapMinutes);
  pickHandoffs(input);
  assert.deepEqual(
    input.map((x) => x.gapMinutes),
    before
  );
});