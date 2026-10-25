// ブレ補正を Node で試す（アプリと同じ計算。AI は onnxruntime-node で動かす）
// 使い方: node scripts/deblur-eval.mjs model.onnx in.rgb 幅 高さ out.rgb [強さ 0〜100]
// onnxruntime-node は、このリポジトリの外に入れて NODE_PATH で渡す（例: NODE_PATH=/tmp/ortw/node_modules）
// 大きなブレの補正も試すとき: STRONG=部位分け.bin STRONG_MODEL=vendor/deblur/fftformer-gopro.onnx
//   部位分け.bin は Float32 で [幅, 高さ, 体の肌（幅×高さ）, 顔の肌, 服]（MediaPipe の Selfie Multiclass の結果。アプリでは skinseg.js の partsSeg）
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deblurSize, deblurResidual2, applyResidual, denoiseSmall, strongMask, strongResidual, mergeStrong, TILE, STRONG_TILE } from '../deblur.js';
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const [model, inPath, W0, H0, outPath, amt = '50', dn = '0'] = process.argv.slice(2); // dn=1: AI に渡す前に縮めた絵のノイズを取る
const W = +W0; const H = +H0; const rgb = readFileSync(inPath);
const { width: w, height: h } = deblurSize(W, H);
// 面積平均で縮める
const small = new Float32Array(w * h * 3); const cnt = new Float32Array(w * h);
for (let Y = 0; Y < H; Y++) {
  const y = Math.min(h - 1, Math.floor(Y * h / H));
  for (let X = 0; X < W; X++) {
    const x = Math.min(w - 1, Math.floor(X * w / W)); const i = y * w + x; const j = (Y * W + X) * 3;
    small[i * 3] += rgb[j] / 255; small[i * 3 + 1] += rgb[j + 1] / 255; small[i * 3 + 2] += rgb[j + 2] / 255; cnt[i]++;
  }
}
for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) small[i * 3 + c] /= cnt[i];
const session = await ort.InferenceSession.create(model);
const t0 = Date.now(); let last = 0;
const input = +dn ? denoiseSmall({ width: w, height: h, data: small }) : { width: w, height: h, data: small };
const res = await deblurResidual2(input, async (input, n) => {
  const r = await session.run({ input: new ort.Tensor('float32', input, [n, 3, TILE, TILE]) });
  return r.output.data;
}, { onProgress: (t) => { if (t - last > 0.1 || t === 1) { last = t; process.stderr.write(`${Math.round(t * 100)}% `); } }, levels: +(process.env.LEVELS || 3), cap: +(process.env.CAP || 1) });
console.error(`\n${w}x${h} AI ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (process.env.STRONG) {
  const b = readFileSync(process.env.STRONG); const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); const pw = f[0]; const ph = f[1]; const n = pw * ph;
  const sm = strongMask({ w: pw, h: ph, body: f.subarray(2, 2 + n), face: f.subarray(2 + n, 2 + 2 * n), cloth: f.subarray(2 + 2 * n, 2 + 3 * n) });
  const s2 = await ort.InferenceSession.create(process.env.STRONG_MODEL || 'vendor/deblur/fftformer-gopro.onnx'); const t1 = Date.now();
  const st = await strongResidual(input, async (x, n) => (await s2.run({ input: new ort.Tensor('float32', x, [n, 3, STRONG_TILE, STRONG_TILE]) })).output.data, sm,
    { onProgress: (t) => process.stderr.write(`\r強い AI ${Math.round(t * 100)}% `) });
  mergeStrong(res, st);
  console.error(`\n強い AI ${((Date.now() - t1) / 1000).toFixed(1)}s`);
}
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
applyResidual(rgba, H, { y0: 0, fullW: W, fullH: H }, res, +amt / 50);
const out = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) { out[i * 3] = rgba[i * 4]; out[i * 3 + 1] = rgba[i * 4 + 1]; out[i * 3 + 2] = rgba[i * 4 + 2]; }
writeFileSync(outPath, out);
