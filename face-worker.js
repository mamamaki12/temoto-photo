// 顔専用 AI を動かす Worker（GFPGAN v1.4 を ONNX にしたもの。ONNX Runtime Web で、WebGPU があれば GPU、なければ CPU。端末の中だけで動く）
// 受け取る: { type: 'run', faces: [{ crop: Float32Array（512×512 の RGB、0〜255）, pts: 顔の点（512 の座標）, refs: [{ img, pts }]（本人の写真） }] }
// 返す: { type: 'progress', phase: 'load' | 'run', t } … { type: 'result', outs: [Float32Array（512×512 の RGB、0〜255）] } / { type: 'error', message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { SIZE, transferDetail } from './faceai.js';

// モデルは 170MB（重みは半精度）。GitHub の 1 ファイルの上限より小さくするため、2 つに分けて置いている
const PARTS = ['./vendor/faceai/gfpgan-v1.4.onnx.1', './vendor/faceai/gfpgan-v1.4.onnx.2'].map((p) => new URL(p, import.meta.url));

/** モデルを読み込む（はじめての 1 回は 170MB をダウンロード。以後はキャッシュ） */
async function download(onProgress) {
  const heads = await Promise.all(PARTS.map((u) => fetch(u)));
  if (heads.some((r) => !r.ok || !r.body)) throw new Error('顔専用 AI を読み込めませんでした');
  const total = heads.reduce((s, r) => s + (+r.headers.get('Content-Length') || 0), 0);
  const parts = []; let got = 0;
  for (const res of heads) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total));
    }
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

let session = null;
async function init(onProgress) {
  if (session) return session;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  const model = await download(onProgress);
  let gpu = false;
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    const info = a?.info || {};
    gpu = !!a && !(info.isFallbackAdapter || a.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`));
  } catch { gpu = false; }
  if (gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] });
      // GPU の計算が正しく動くか、灰色の顔で確かめる（おかしければ CPU で）
      const y = (await s.run({ input: new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) })).output.data;
      let bad = false; for (let i = 0; i < y.length; i += 997) if (!Number.isFinite(y[i])) { bad = true; break; }
      if (!bad) { session = s; return session; }
      await s.release();
    } catch (e) { console.warn('WebGPU で顔専用 AI を動かせないので CPU で動かします', e); }
  }
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  return session;
}

/** 512×512 の RGB（0〜255、並んだ形）→ AI の入力（RGB の面ごと、−1〜1）→ 結果を戻す */
async function restore(s, img) {
  const n = SIZE * SIZE; const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = img[i * 3 + c] / 127.5 - 1;
  const y = (await s.run({ input: new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]) })).output.data;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, Math.max(0, (y[c * n + i] + 1) * 127.5));
  return out;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  try {
    const s = await init((t) => self.postMessage({ type: 'progress', phase: 'load', t }));
    const outs = [];
    for (let k = 0; k < data.faces.length; k++) {
      const f = data.faces[k];
      // 本人の写真があれば、その細かい模様を先に移してから AI に通す（AI が本人らしい形を保つ）
      const src = f.refs?.length ? transferDetail(f.crop, f.pts, f.refs) : f.crop;
      self.postMessage({ type: 'progress', phase: 'run', t: (k + 0.3) / data.faces.length });
      outs.push(await restore(s, src));
      self.postMessage({ type: 'progress', phase: 'run', t: (k + 1) / data.faces.length });
    }
    self.postMessage({ type: 'result', outs }, outs.map((o) => o.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
