import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreLinear } from '../../restoration.js';

function image(W, H, fn) {
  const data = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(fn(x, y), (y * W + x) * 3);
  return { width: W, height: H, data };
}
const run = (im, opts = {}, hooks = {}) => restoreLinear(im, opts, { yieldTask: () => Promise.resolve(), ...hooks });
function randomNormal() {
  let seed = 521;
  const uniform = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

test('restoration: 暗い写真のノイズを下げ、色の境界を保ってから明るくする', async () => {
  const rand = randomNormal();
  const clean = image(48, 32, (x) => x < 24 ? [0.025, 0.04, 0.06] : [0.15, 0.08, 0.025]);
  const noisy = { ...clean, data: clean.data.map((v) => v + 0.004 * rand()) };
  const original = noisy.data.slice();
  const result = await run(noisy, { noiseSigma: 0.004, exposureEV: 2 });
  let before = 0; let after = 0; let boundary = 0;
  for (let y = 3; y < 29; y++) for (let x = 3; x < 45; x++) for (let c = 0; c < 3; c++) {
    const i = (y * 48 + x) * 3 + c; const err = (result.data[i] / 4 - clean.data[i]) ** 2;
    before += (noisy.data[i] - clean.data[i]) ** 2; after += err;
    if (x === 23 || x === 24) boundary = Math.max(boundary, Math.sqrt(err));
  }
  assert.ok(after < before * 0.4, `誤差比 ${after / before}`);
  assert.ok(boundary < 0.015, `境界の誤差 ${boundary}`);
  assert.deepEqual(noisy.data, original, '元画像を変えない');
});

test('restoration: HDR値と細かい階調を保ち、ノイズ除去なしは露出だけ変える', async () => {
  const input = image(32, 16, (x) => [0.4 + x / 65535, 0.2, 0.1]);
  const out = await run(input, { strength: 0, exposureEV: 3 });
  assert.ok(out.data[0] > 1, '途中で白飛びさせない');
  assert.equal(out.data[3] - out.data[0], (input.data[3] - input.data[0]) * 8);
  assert.deepEqual((await run(input, { noiseSigma: 0 })).data, input.data);
  const flat = image(17, 19, () => [0.1, 0.2, 0.3]);
  assert.deepEqual((await run(flat)).data, flat.data, '一定色を維持する');
});

test('restoration: タイルの切り方で結果が変わらず、進捗が実際の処理数に対応する', async () => {
  const rand = randomNormal(); const im = image(35, 33, (x, y) => [0.2 + 0.005 * rand(), x / 70, y / 66]);
  const progress = [];
  const a = await run(im, { tileSize: 16 }, { onProgress: (p) => progress.push(p) });
  const b = await run(im, { tileSize: 32 });
  for (let i = 0; i < a.data.length; i++) assert.ok(Math.abs(a.data[i] - b.data[i]) < 1e-6);
  assert.equal(progress.length, 10);
  assert.deepEqual(progress[0], { completed: 0, total: 9, percent: 0 });
  assert.deepEqual(progress.at(-1), { completed: 9, total: 9, percent: 100 });
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].percent > progress[i - 1].percent);
});

test('restoration: 中止・不正入力・極小設定・1画素を扱える', async () => {
  const im = image(32, 32, () => [0.1, 0.2, 0.3]); const controller = new AbortController();
  await assert.rejects(run(im, { tileSize: 16 }, { signal: controller.signal, onProgress: (p) => { if (p.completed === 1) controller.abort(); } }), { name: 'AbortError' });
  await assert.rejects(run(im, { searchRadius: 100 }));
  await assert.rejects(run({ ...im, data: new Float32Array([NaN]) }));
  const bad = image(1, 1, () => [NaN, 0, 0]); await assert.rejects(run(bad));
  const single = image(1, 1, () => [0.1, 0.2, 0.3]);
  assert.deepEqual((await run(single, { strength: 1e-200 })).data, single.data);
});
