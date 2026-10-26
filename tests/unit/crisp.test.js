// 髪・服をくっきり（crisp.js）の仕組みのテスト。
// 仕上がりの良し悪しは、ここでは決めない（実際の写真を 100% で見て確かめる。docs/bokeh-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crispActive, crispAmount, crispWeights, applyDetailMap, SKIN } from '../../crisp.js';
import { validateState } from '../../state.js';

test('crisp: 編集の値の形（0 で使わない。50 で倍率 1）', () => {
  assert.equal(validateState({ adj: { crisp: 70 } }).adj.crisp, 70);
  assert.equal(crispActive({ crisp: 0 }), false); assert.equal(crispActive({ crisp: 1 }), true);
  assert.equal(crispAmount({ crisp: 50 }), 1); assert.equal(crispAmount({ crisp: 100 }), 2);
});

test('crisp: 重みは、髪・服 1、肌 0.35、背景 0。部位分けがなければ人物は全部 1', () => {
  const w = 8; const h = 2; const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < 4; x++) alpha[y * w + x] = 1; // 左半分が人物
  // 部位分け（同じ 8×2）: 左 2 列が髪、次の 2 列が顔の肌、右は背景
  const n = w * h; const parts = new Float32Array(6 * n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) parts[(x < 2 ? 1 : x < 4 ? 3 : 0) * n + y * w + x] = 1;
  const m = crispWeights(alpha, w, h, { w, h, parts });
  assert.equal(m[0], 255, '髪'); assert.equal(m[3], Math.round(255 * SKIN), '肌'); assert.equal(m[6], 0, '背景');
  const m2 = crispWeights(alpha, w, h, null);
  assert.equal(m2[3], 255); assert.equal(m2[6], 0);
});

test('crisp: 差分を重みで足す。重み 0 の所は変わらず、引き伸ばしても同じ', () => {
  const W = 8; const H = 4; const data = new Uint8ClampedArray(W * H * 4).fill(100);
  const res = { width: W, height: H, data: new Int8Array(W * H * 3).fill(20) };
  const map = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0]) }; // 左半分 1、右半分 0（間はなだらか）
  applyDetailMap(data, H, { y0: 0, fullW: W, fullH: H }, res, map, 1);
  assert.equal(data[(2 * W + 0) * 4], 120); assert.equal(data[(2 * W + 7) * 4], 100); assert.ok(data[(2 * W + 3) * 4] > 100 && data[(2 * W + 3) * 4] < 120);
  const half = new Uint8ClampedArray(W * H * 4).fill(100);
  applyDetailMap(half, H, { y0: 0, fullW: W, fullH: H }, res, map, 0.5);
  assert.equal(half[(2 * W + 0) * 4], 110);
  // 元の大きさ（2 倍）に帯ごとに当てても、左は +20・右は 0
  const big = new Uint8ClampedArray(W * 2 * 4 * 4).fill(100);
  applyDetailMap(big, 4, { y0: 4, fullW: W * 2, fullH: H * 2 }, res, map, 1);
  assert.equal(big[(1 * W * 2 + 0) * 4], 120); assert.equal(big[(1 * W * 2 + 15) * 4], 100);
});
