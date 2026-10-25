// 被写体ブレの補正（deblur.js）の仕組みのテスト。AI の代わりに、決まった直し方をする関数を使う。
// 仕上がりの良し悪しは、ここでは決めない（実際の写真を 100% で見て確かめる。docs/deblur-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deblurSize, deblurResidual, deblurResidual2, applyResidual, gateMap, strongMask, strongResidual, mergeStrong, TILE, STRONG_TILE } from '../../deblur.js';
import { addGrain } from '../../restoration-lowlight.js';

/** 縮めた絵（RGB を並べたもの）。fn(x, y) は 0〜1 の明るさ */
function small(w, h, fn) {
  const d = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); d[(y * w + x) * 3] = v; d[(y * w + x) * 3 + 1] = v * 0.8; d[(y * w + x) * 3 + 2] = v * 0.6; }
  return { width: w, height: h, data: d };
}
// 縦縞（輪郭のある所）と、平らな所
const stripes = (x) => (Math.floor(x / 8) % 2 ? 0.7 : 0.3);
const P = TILE * TILE;

test('deblur: AI に通す大きさは、元の写真の大きさで決まる（長い辺 1600 まで元のまま、3200 以上は半分）', () => {
  assert.deepEqual(deblurSize(1200, 800), { width: 1200, height: 800 });
  assert.deepEqual(deblurSize(5184, 3456), { width: 2592, height: 1728 });
  const m = deblurSize(2400, 1600); assert.equal(m.width, 1600); assert.equal(m.height, 1067);
  const big = deblurSize(8000, 6000); assert.ok(big.width * big.height <= 4_500_000);
});

test('deblur: AI が全体の明るさ・色を少し変えても、それは足さない（輪郭の直しだけ）', async () => {
  const img = small(300, 300, (x, y) => stripes(x + y));
  const res = await deblurResidual(img, async (input) => Float32Array.from(input, (v) => v * 0.97));
  let sum = 0; for (const v of res.data) sum += v;
  assert.ok(Math.abs(sum / res.data.length) < 0.0005, `平均 ${sum / res.data.length}`);
});

test('deblur: AI が何も変えなければ、差分は 0', async () => {
  const img = small(300, 280, stripes);
  const res = await deblurResidual(img, async (input) => Float32Array.from(input));
  assert.equal(res.width, 300); assert.equal(res.height, 280);
  assert.ok(res.data.every((v) => v === 0));
});

test('deblur: 反転した方と向きが合わない直し方（AI の癖の筋）は捨てる', async () => {
  const img = small(260, 260, stripes);
  // 1 枚目は +0.05、反転した 2 枚目は -0.05（向きが合わない）
  const res = await deblurResidual(img, async (input, n) => {
    const out = Float32Array.from(input);
    for (let i = 0; i < 3 * P; i++) out[i] += 0.05;
    for (let i = 3 * P; i < 2 * 3 * P; i++) out[i] -= 0.05;
    return out;
  });
  assert.ok(res.data.every((v) => v === 0));
});

test('deblur: 平らな所には効かせず、輪郭のある所だけ直す', async () => {
  const w = 512; const h = 256;
  // 左半分は縞、右半分は平ら
  const img = small(w, h, (x) => (x < 256 ? stripes(x) : 0.5));
  // 輪郭を強める（左右の隣との差を足す）AI の代わり
  const res = await deblurResidual(img, async (input) => {
    const out = Float32Array.from(input);
    for (let i = 0; i < out.length; i++) { const x = i % TILE; if (x > 0 && x < TILE - 1) out[i] += 0.3 * (2 * input[i] - input[i - 1] - input[i + 1]); }
    return out;
  });
  const at = (x, y) => res.data[(y * w + x) * 3];
  let edge = 0; for (let x = 20; x < 230; x++) edge = Math.max(edge, Math.abs(at(x, 128)));
  assert.ok(edge > 0.02, `縞の所: ${edge}`);
  assert.equal(at(450, 128), 0, '平らな所は直さない');
  // 直す量は、まわりのばらつきに見合う大きさまで
  const A = gateMap(img.data, w, h);
  for (let i = 0; i < w * h; i++) assert.ok(Math.abs(res.data[i * 3]) <= A[i] + 1e-6);
});

test('deblur: 差分を元の大きさに引き伸ばして足す（帯に分けても同じ）', () => {
  const res = { width: 4, height: 3, data: new Float32Array(4 * 3 * 3).fill(10 / 255) };
  const W = 16; const H = 12; const base = new Uint8ClampedArray(W * H * 4).fill(100);
  const whole = applyResidual(base.slice(), H, { y0: 0, fullW: W, fullH: H }, res, 1);
  assert.ok(whole.every((v, i) => (i % 4 === 3 ? v === 100 : v === 110)), '一様な差分は、そのまま足される');
  // 場所によって違う差分でも、帯に分けた結果は写真全体と同じ
  const r2 = { width: 4, height: 3, data: Float32Array.from({ length: 36 }, (_, i) => ((i * 7) % 11 - 5) / 255) };
  const all = applyResidual(base.slice(), H, { y0: 0, fullW: W, fullH: H }, r2, 1.5);
  const top = applyResidual(base.slice(0, W * 5 * 4), 5, { y0: 0, fullW: W, fullH: H }, r2, 1.5);
  const bottom = applyResidual(base.slice(W * 5 * 4), H - 5, { y0: 5, fullW: W, fullH: H }, r2, 1.5);
  assert.deepEqual([...top, ...bottom], [...all]);
  // 強さ 0 なら変えない
  assert.deepEqual(applyResidual(base.slice(), H, { y0: 0, fullW: W, fullH: H }, r2, 0), base);
});

test('deblur: 粒は位置で決まる（帯に分けても同じ）。真っ黒・真っ白には足さない', () => {
  const W = 32; const H = 8; const img = new Uint8ClampedArray(W * H * 4).fill(128);
  const all = addGrain(img.slice(), W, H, { y0: 0, fullW: W }, 1.5);
  const a = addGrain(img.slice(0, W * 3 * 4), W, 3, { y0: 0, fullW: W }, 1.5);
  const b = addGrain(img.slice(W * 3 * 4), W, 5, { y0: 3, fullW: W }, 1.5);
  assert.deepEqual([...a, ...b], [...all]);
  assert.ok(all.some((v, i) => i % 4 !== 3 && v !== 128));
  const black = new Uint8ClampedArray(W * 4).fill(0); for (let i = 3; i < black.length; i += 4) black[i] = 255;
  assert.deepEqual(addGrain(black.slice(), W, 1, { y0: 0, fullW: W }, 1.5), black);
});

test('deblur: 2 段（半分の大きさ → 元の大きさ）でも、AI が何も変えなければ差分は 0。大きさは入力と同じ', async () => {
  const img = small(600, 540, stripes); let calls = 0;
  const res = await deblurResidual2(img, async (input) => { calls++; return Float32Array.from(input); });
  assert.equal(res.width, 600); assert.equal(res.height, 540);
  assert.ok(res.data.every((v) => Math.abs(v) < 1e-7));
  assert.ok(calls > 9, '半分の大きさの段と、元の大きさの段の両方で AI に通す');
});

test('deblur: 2 段の和も、元の絵の直してよい量までに抑える', async () => {
  const img = small(600, 540, (x) => (x < 300 ? stripes(x) : 0.5 + x / 6000));
  const res = await deblurResidual2(img, async (input) => {
    const out = Float32Array.from(input);
    for (let i = 0; i < out.length; i++) { const x = i % TILE; if (x > 0 && x < TILE - 1) out[i] += 0.5 * (2 * input[i] - input[i - 1] - input[i + 1]); }
    return out;
  });
  const A = gateMap(img.data, 600, 540); let mx = 0;
  for (let i = 0; i < 600 * 540; i++) { assert.ok(Math.abs(res.data[i * 3]) <= A[i] + 1e-6); mx = Math.max(mx, Math.abs(res.data[i * 3])); }
  assert.ok(mx > 0.02, `縞の所は直す: ${mx}`);
});

/** 部位分けの結果の代わり（w×h）。fn(x, y) → [体の肌, 顔の肌, 服] */
function parts(w, h, fn) {
  const body = new Float32Array(w * h); const face = new Float32Array(w * h); const cloth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [b, f, c] = fn(x, y); body[y * w + x] = b; face[y * w + x] = f; cloth[y * w + x] = c; }
  return { w, h, body, face, cloth };
}

test('deblur（大きなブレ）: 強い AI は手・腕・服に当て、顔とそのまわり・背景には当てない', () => {
  // 上の段: 顔、真ん中: 手（体の肌）、下: 服、右の列: 背景
  const sm = strongMask(parts(60, 90, (x, y) => (x >= 45 ? [0, 0, 0] : y < 30 ? [0, 1, 0] : y < 60 ? [1, 0, 0] : [0, 0, 1])));
  const at = (x, y) => sm.mask[y * 60 + x];
  assert.equal(at(20, 10), 0, '顔');
  assert.ok(at(20, 32) < 0.1, `顔のすぐ下（広げた分）: ${at(20, 32)}`); assert.ok(at(20, 40) > 0.95, '顔から離れた手');
  assert.ok(at(20, 50) > 0.95, `手: ${at(20, 50)}`); assert.ok(at(20, 80) > 0.95, `服: ${at(20, 80)}`);
  assert.ok(at(55, 50) < 0.01, '背景');
  assert.ok(sm.skin[50 * 60 + 20] > 0.99 && sm.skin[80 * 60 + 20] < 0.01, '肌と服を分ける');
});

test('deblur（大きなブレ）: 当てる所のない区画は AI に通さない。AI が何も変えなければ差分は 0', async () => {
  const img = small(1000, 600, stripes); // 半分の大きさで 500×300
  // 左の 1/4 だけ手
  const sm = strongMask(parts(100, 60, (x) => (x < 25 ? [1, 0, 0] : [0, 0, 0])));
  let calls = 0;
  const st = await strongResidual(img, async (input, n) => { calls++; assert.equal(n, 1); assert.equal(input.length, 3 * STRONG_TILE * STRONG_TILE); return Float32Array.from(input); }, sm);
  assert.equal(st.width, 500); assert.equal(st.height, 300);
  assert.ok(st.data.every((v) => v === 0));
  // 半分の大きさで、左から 128 画素くらいまでの区画だけ（そのままと左右反転で 2 回ずつ）
  assert.ok(calls > 0 && calls <= 2 * 2 * 3, `AI に通した回数 ${calls}`);
  assert.equal(await strongResidual(img, async (x) => x, strongMask(parts(100, 60, () => [0, 0, 0]))), null, '人物がいなければ何もしない');
});

test('deblur（大きなブレ）: 強い AI の差分は、当てた所だけ今までの差分と混ぜる', async () => {
  const img = small(1000, 600, stripes);
  const sm = strongMask(parts(100, 60, (x) => (x < 50 ? [1, 0, 0] : [0, 0, 0])));
  // 輪郭を強める AI の代わり
  const st = await strongResidual(img, async (input) => {
    const out = Float32Array.from(input); const T = STRONG_TILE;
    for (let i = 0; i < out.length; i++) { const x = i % T; if (x > 0 && x < T - 1) out[i] += 0.3 * (2 * input[i] - input[i - 1] - input[i + 1]); }
    return out;
  }, sm);
  let mx = 0; for (let y = 50; y < 250; y++) for (let x = 20; x < 200; x++) mx = Math.max(mx, Math.abs(st.data[(y * 500 + x) * 3]));
  assert.ok(mx > 0.02, `手の所は直す: ${mx}`);
  const res = { width: 1000, height: 600, data: new Float32Array(1000 * 600 * 3).fill(0.01) };
  mergeStrong(res, st);
  assert.ok(Math.abs(res.data[(300 * 1000 + 950) * 3] - 0.01) < 1e-6, '当てていない所は今までの差分のまま');
});

test('deblur（大きなブレ）: 服は、今の差分と向きが同じで強い所だけ、今の 1.5 倍までにして替える。肌は替える', () => {
  const one = (v) => new Float32Array([v, v, v]);
  const run = (now, strong, skin) => {
    const res = { width: 1, height: 1, data: one(now) };
    return mergeStrong(res, { width: 1, height: 1, data: one(strong), mask: new Float32Array([1]), skin: new Float32Array([skin]) }).data[0];
  };
  assert.ok(Math.abs(run(0.01, 0.05, 0) - 0.015) < 1e-6, '服: 強すぎる分は 1.5 倍まで');
  assert.ok(Math.abs(run(0.01, -0.05, 0) - 0.01) < 1e-6, '服: 向きが逆なら今のまま');
  assert.ok(Math.abs(run(0.02, 0.01, 0) - 0.02) < 1e-6, '服: 弱ければ今のまま');
  assert.ok(Math.abs(run(0.01, 0.05, 1) - 0.05) < 1e-6, '肌: 強い AI に替える');
});
