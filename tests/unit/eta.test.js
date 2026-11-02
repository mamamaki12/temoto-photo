import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEta, fmtEta } from '../../eta.js';

test('進む速さから残り時間を見積もる（始めは出さない）', () => {
  let t = 0; const eta = makeEta({ now: () => t });
  assert.equal(eta.update(0), null);
  t = 2000; assert.equal(eta.update(0.02), null); // 5 秒たつまでは出さない
  t = 10_000; const e = eta.update(0.1); // 10 秒で 10% → 残り 90 秒
  assert.ok(Math.abs(e - 90) < 1, String(e));
  t = 20_000; const e2 = eta.update(0.2); assert.ok(e2 > 70 && e2 < 90, String(e2));
});

test('遅い段に入ったら、最近の進みで見積もり直す', () => {
  let t = 0; const eta = makeEta({ now: () => t, window: 30_000 });
  for (let s = 0; s <= 10; s++) { t = s * 1000; eta.update(s * 0.03); } // 速い: 1 秒 3%
  const fast = eta.value; assert.ok(fast < 40, String(fast));
  for (let s = 11; s <= 70; s++) { t = s * 1000; eta.update(0.3 + (s - 10) * 0.001); } // 遅い: 1 秒 0.1% → 残り約 700 秒
  assert.ok(eta.value > 500, String(eta.value));
});

test('進みが戻ったら（別の計算）見積もりをやり直す', () => {
  let t = 0; const eta = makeEta({ now: () => t });
  eta.update(0); t = 10_000; eta.update(0.5); assert.ok(eta.value != null);
  t = 11_000; assert.equal(eta.update(0.1), null);
});

test('表示の形', () => {
  assert.equal(fmtEta(null), ''); assert.equal(fmtEta(3), 'まもなく'); assert.equal(fmtEta(25), 'あと約30秒');
  assert.equal(fmtEta(61), 'あと約2分'); assert.equal(fmtEta(600), 'あと約10分'); assert.equal(fmtEta(4000), 'あと 1 時間以上');
});
