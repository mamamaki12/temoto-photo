// 背景のぼかし（bokeh.js）の仕組みのテスト。
// 仕上がりの良し悪しは、ここでは決めない（実際の写真を 100% で見て確かめる。docs/bokeh-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bokehActive, bokehRadius, resizeMap, personAlpha, discSum, computeBokeh, applyBokeh } from '../../bokeh.js';
import { validateState } from '../../state.js';

/** w×h の RGBA。fn(x, y) → [r, g, b] */
function rgba(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); d.set([v[0], v[1], v[2], 255], (y * w + x) * 4); }
  return d;
}

test('bokeh: 編集の値の形（0 で使わない。半径は横幅に比例し、50 で横幅の 2%）', () => {
  const st = validateState({ adj: { bokeh: 50 } });
  assert.equal(st.adj.bokeh, 50); assert.equal(validateState({ adj: { bokeh: 500 } }).adj.bokeh, 100);
  assert.equal(bokehActive({ bokeh: 0 }), false); assert.equal(bokehActive({ bokeh: 30 }), true);
  assert.ok(Math.abs(bokehRadius(3456, 50) - 69.12) < 1e-6);
  assert.equal(bokehRadius(1000, 100), 40);
});

test('bokeh: 円形のぼかしは、円の中の画素の和（端は、範囲に入る所だけ）', () => {
  const w = 9; const h = 9; const src = new Float32Array(w * h); src[4 * w + 4] = 1; // 真ん中に 1 つ
  const out = discSum(src, w, h, 2);
  let cnt = 0; for (let i = 0; i < w * h; i++) cnt += out[i];
  assert.equal(cnt, 13); // 半径 2 の円（x²+y²≤4）は 13 画素
  assert.equal(out[4 * w + 4], 1); assert.equal(out[2 * w + 4], 1); assert.equal(out[2 * w + 5], 0); assert.equal(out[1 * w + 4], 0);
  const one = new Float32Array(w * h).fill(1); const o2 = discSum(one, w, h, 2);
  assert.equal(o2[4 * w + 4], 13); assert.equal(o2[0], 6); // 角は、円のうち写真の中にある 6 画素
});

test('bokeh: 人物の色が背景ににじまず、人物はそのまま。背景の明るい点は丸く広がる', () => {
  const w = 64; const h = 48; const r = 6;
  // 左半分が白い人物、右半分が黒い背景。背景に明るい点を 1 つ
  const img = rgba(w, h, (x, y) => (x < 32 ? [255, 255, 255] : x === 50 && y === 24 ? [255, 255, 255] : [0, 0, 0]));
  const alpha = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < 32; x++) alpha[y * w + x] = 1;
  const bk = computeBokeh(img, w, h, alpha, r);
  assert.equal(bk.width, w); assert.equal(bk.height, h);
  // 背景の、人物のすぐ隣: 白がにじんでいない（人物の画素は重みから外れている）
  assert.equal(bk.bg[(24 * w + 33) * 3], 0);
  // 明るい点は、半径 r の円の中に均等に広がる（リニアでぼかすので、ガンマの分だけ 8bit では明るめ）
  const center = bk.bg[(24 * w + 50) * 3]; const edge = bk.bg[(24 * w + 50 + r) * 3]; const outside = bk.bg[(24 * w + 50 + r + 2) * 3];
  assert.ok(center > 0 && Math.abs(center - edge) <= 1, `円の中は同じ明るさ ${center} ${edge}`); assert.equal(outside, 0);
  // 合成: 人物はそのまま、背景は点が広がった絵になる
  const out = applyBokeh(img.slice(), h, { y0: 0, fullW: w, fullH: h }, bk);
  assert.equal(out[(24 * w + 10) * 4], 255); assert.equal(out[(24 * w + 50 + 3) * 4], center);
  // 元の大きさ（2 倍）に引き伸ばして合成しても、人物はそのまま
  const big = rgba(w * 2, h * 2, (x) => (x < 64 ? [255, 255, 255] : [0, 0, 0]));
  applyBokeh(big, h * 2, { y0: 0, fullW: w * 2, fullH: h * 2 }, bk);
  assert.equal(big[(48 * w * 2 + 20) * 4], 255); assert.equal(big[(48 * w * 2 + 100 + 6) * 4], center);
});

test('bokeh: 人物の地図を写真の輪郭に沿わせ、少し広げる。地図がなければ全部背景', () => {
  const w = 64; const h = 32;
  // 左 30 列が明るい人物、右が暗い背景。粗い地図（4×2）は境目を 32 列目としている
  const img = rgba(w, h, (x) => (x < 30 ? [200, 200, 200] : [20, 20, 20]));
  const a = personAlpha(img, w, h, { m: new Float32Array([1, 1, 0, 0, 1, 1, 0, 0]), w: 4, h: 2 });
  assert.ok(a[16 * w + 5] > 0.95, '人物の内側'); assert.ok(a[16 * w + 58] < 0.05, '背景の奥');
  assert.ok(a[16 * w + 27] > a[16 * w + 34], '境目は、明るさの切り替わり（30 列目）に寄る');
  assert.ok(personAlpha(img, w, h, null).every((v) => v === 0));
  const m = resizeMap(new Float32Array([0, 1]), 2, 1, 4, 1);
  assert.ok(m[0] === 0 && m[3] === 1 && m[1] < m[2]);
});
