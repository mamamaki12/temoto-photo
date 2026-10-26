// 全体 AI（wholeai.js）と、顔 AI の髪の範囲（faceai.js の hairMask）の計算のテスト。AI の代わりに、決まった絵を使う。
// 仕上がりの良し悪しは、ここでは決めない（実際の写真を 100% で見て確かめる。docs/faceai-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCALE, TILE, TILE_IN, PAD, smallFrom, tiles, tileInput, tileRect, regionOf, tileResidual, putResidual, addDetail, applyDetail } from '../../wholeai.js';
import { SIZE, hairMask, widenMatrix, applyMatrix, invertMatrix } from '../../faceai.js';
import { validateState } from '../../state.js';

/** W×H の RGBA。fn(x, y) → 0〜255（灰色） */
function gray(W, H, fn) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = fn(x, y); d.set([v, v, v, 255], (y * W + x) * 4); }
  return d;
}
/** 写真全体を、区画ごとに「AI」（fake: 縮めた絵の区画 → 4 倍の絵）に通して差分を求める */
function runAll(img, W, H, fake) {
  const small = smallFrom(img, W, H); const res = new Int8Array(W * H * 3); const S = TILE_IN * SCALE;
  for (const [x, y] of tiles(small.width, small.height)) {
    const input = tileInput(small, x, y); const out = new Float32Array(3 * S * S);
    for (let c = 0; c < 3; c++) for (let v = 0; v < S; v++) for (let u = 0; u < S; u++) out[c * S * S + v * S + u] = fake(input, c, u, v, x, y);
    const r = tileRect(W, H, x, y); putResidual(res, W, r, tileResidual(out, 0, regionOf(img, W, r), r));
  }
  return res;
}

test('縮める: 4×4 の平均（端の半端な所は、ある画素だけ）', () => {
  const W = 10; const H = 6; const img = gray(W, H, (x) => x * 20);
  const s = smallFrom(img, W, H);
  assert.equal(s.width, 3); assert.equal(s.height, 2);
  assert.ok(Math.abs(s.data[0] - (0 + 20 + 40 + 60) / 4 / 255) < 1e-6);
  assert.ok(Math.abs(s.data[2 * 3] - (160 + 180) / 2 / 255) < 1e-6); // 右端は 2 列だけ
});

test('区画: 縮めた絵の全部を、重ならずに覆う', () => {
  const w = 300; const h = 140; const seen = new Uint8Array(w * h);
  for (const [x, y] of tiles(w, h)) for (let v = y; v < Math.min(h, y + TILE); v++) for (let u = x; u < Math.min(w, x + TILE); u++) seen[v * w + u]++;
  assert.ok(seen.every((c) => c === 1));
});

test('AI が写真と同じ絵を返したら、差分は小さい（大まかな形・色は写真のまま。なめらかな絵なので、いちばん細かい所もわずか）', () => {
  const W = 700; const H = 300;
  const img = gray(W, H, (x, y) => 128 + 60 * Math.sin(x / 9) * Math.cos(y / 13));
  // 「AI」= 写真そのもの（4 倍の座標で、元の写真の画素を読む）
  const res = runAll(img, W, H, (_in, c, u, v, tx, ty) => {
    const X = Math.min(W - 1, Math.max(0, (tx - PAD) * SCALE + u)); const Y = Math.min(H - 1, Math.max(0, (ty - PAD) * SCALE + v));
    return img[(Y * W + X) * 4 + c] / 255;
  });
  let mx = 0; for (const v of res) mx = Math.max(mx, Math.abs(v));
  assert.ok(mx <= 4, `差分 ${mx}`);
});

test('AI がくっきりさせた所は足すが、まわりの明るさの幅を超える縁取りは作らない', () => {
  const W = 600; const H = 200; const edge = 300;
  // ぼけた境目（暗い 40 → 明るい 200）
  const img = gray(W, H, (x) => 40 + 160 / (1 + Math.exp(-(x - edge) / 6)));
  // 「AI」= 境目をくっきり、しかも外に 40 はみ出す（明るい側の手前に黒い縁、暗い側の手前に白い縁）
  const res = runAll(img, W, H, (_in, c, u, _v, tx) => {
    const X = (tx - PAD) * SCALE + u; const d = X - edge;
    const v = 40 + 160 / (1 + Math.exp(-d / 1.5)) + (Math.abs(d) < 6 ? -Math.sign(d) * 40 * (1 - Math.abs(d) / 6) : 0);
    return Math.min(1, Math.max(0, v / 255));
  });
  const out = addDetail(Uint8ClampedArray.from(img), res);
  const row = (x) => out[(100 * W + x) * 4];
  // くっきりした（境目のすぐ両側の差が広がった）
  assert.ok(row(edge + 4) - row(edge - 4) > img[(100 * W + edge + 4) * 4] - img[(100 * W + edge - 4) * 4] + 10);
  // 縁取りは、写真の暗い〜明るいの幅からほとんどはみ出さない
  for (let x = 0; x < W; x++) { assert.ok(row(x) >= 40 - 4 && row(x) <= 200 + 4, `x=${x} ${row(x)}`); }
});

test('書き出し: 差分を引き伸ばして足す（同じ大きさなら、そのまま足すのと同じ）', () => {
  const W = 40; const H = 30; const res = { width: W, height: H, data: new Int8Array(W * H * 3).map((_, i) => (i % 7) - 3) };
  const a = gray(W, H, () => 100); const b = Uint8ClampedArray.from(a);
  addDetail(a, res.data); applyDetail(b, H, { y0: 0, fullW: W, fullH: H }, res);
  assert.deepEqual(b, a);
  // 2 倍の写真: 一様な差分なら、どこも同じだけ足す
  const u = { width: W, height: H, data: new Int8Array(W * H * 3).fill(5) };
  const big = gray(W * 2, 10, () => 100); applyDetail(big, 10, { y0: 20, fullW: W * 2, fullH: H * 2 }, u);
  assert.ok(big.every((v, i) => (i % 4 === 3 ? v === 255 : v === 105)));
});

test('髪の範囲: 髪は顔の輪郭に足し、飾り（ティアラ）のまわりと切り出しの縁は外す', () => {
  const w = 128; const h = 128; const n = w * h; const parts = new Float32Array(n * 6);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (y < 48) parts[n + i] = 1; // 上の方は髪
    if (y < 48 && x >= 56 && x < 72) { parts[n + i] = 0; parts[5 * n + i] = 1; } // その真ん中に飾り
  }
  const face = new Float32Array(SIZE * SIZE); face[300 * SIZE + 256] = 1;
  const m = hairMask(face, { w, h, parts });
  const at = (u, v) => m[v * SIZE + u];
  assert.ok(at(120, 120) > 0.95, `髪 ${at(120, 120)}`);
  assert.ok(at(256, 100) < 0.05, `飾り ${at(256, 100)}`);
  assert.ok(at(256, 300) === 1, '顔はそのまま');
  assert.ok(at(2, 100) === 0 && at(120, 1) === 0, '切り出しの縁');
  assert.ok(at(120, 400) < 0.01, '髪でない所');
  // 部位分けを使えないときは、顔の輪郭のまま
  assert.equal(hairMask(face, null), face);
});

test('編集内容: 髪・服・背景の全体 AI は、はじめは使う（切ったら切ったまま）', () => {
  assert.equal(validateState({}).faceai.whole, true);
  assert.equal(validateState({ faceai: { whole: false } }).faceai.whole, false);
});

test('髪の広い切り出し: 真ん中はそのまま、顔は 1/k の大きさに写る', () => {
  const M = [0.8, 0.3, -120, -60]; const Mw = widenMatrix(M, 1.5);
  const c = applyMatrix(invertMatrix(M), SIZE / 2, SIZE / 2); const cw = applyMatrix(Mw, ...c);
  assert.ok(Math.hypot(cw[0] - SIZE / 2, cw[1] - SIZE / 2) < 1e-9);
  const p = applyMatrix(invertMatrix(M), 400, 100); const pw = applyMatrix(Mw, ...p);
  assert.ok(Math.abs(pw[0] - (SIZE / 2 + (400 - SIZE / 2) / 1.5)) < 1e-9 && Math.abs(pw[1] - (SIZE / 2 + (100 - SIZE / 2) / 1.5)) < 1e-9);
});
