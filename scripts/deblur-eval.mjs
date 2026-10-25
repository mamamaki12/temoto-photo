// ブレ補正を Node で試す（アプリと同じ計算。AI は onnxruntime-node で動かす）
// 使い方: node scripts/deblur-eval.mjs model.onnx in.rgb 幅 高さ out.rgb [強さ 0〜100]
// onnxruntime-node は、このリポジトリの外に入れて NODE_PATH で渡す（例: NODE_PATH=/tmp/ortw/node_modules）
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deblurSize, deblurResidual2, applyResidual, denoiseSmall, TILE } from '../deblur.js';
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
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
applyResidual(rgba, H, { y0: 0, fullW: W, fullH: H }, res, +amt / 50);
const out = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) { out[i * 3] = rgba[i * 4]; out[i * 3 + 1] = rgba[i * 4 + 1]; out[i * 3 + 2] = rgba[i * 4 + 2]; }
writeFileSync(outPath, out);
