// 写真の奥行き（どこが手前で、どこが奥か）を推定する Worker（Depth Anything V2 Small。ONNX Runtime Web の CPU。端末の中だけで動く）。
// 背景をぼかす（bokeh.js）で、人物を見分ける AI が見落とす所（透けたフリル・写真の端で切れた脚・足元の床）を、
// 「人物と同じくらい近い所はぼかさない」ようにするのに使う
// 受け取る: { rgba: Uint8ClampedArray（RGBA、w×h。長い辺 512 くらいに縮めた写真）, w, h }
// 返す: { type: 'progress', t } … { type: 'result', depth: { m: Float32Array（SIDE×SIDE。0〜1、大きいほど手前）, w, h } } / { type: 'error', message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { limitOrtMemory, outOfMemory } from './cores.js';
import { DEPTH_SIDE as SIDE } from './bokeh.js';

limitOrtMemory(512); // 動かすと約 300MB

const MODEL = new URL('./vendor/depth/depth-anything-v2-small.onnx', import.meta.url);
// 通信が途中で止まったとき（電波の悪い所など）、fetch は失敗もせずにずっと待つことがある。この間 1 バイトも届かなければあきらめる
const STALL = 15000;

async function download(onProgress) {
  const ctrl = new AbortController(); let timer = 0;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL); };
  kick();
  try {
    const res = await fetch(MODEL, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = +res.headers.get('Content-Length') || 0; const parts = []; let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      kick(); const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total));
    }
    const buf = new Uint8Array(got); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  } catch (e) { throw new Error(`奥行きの AI を読み込めませんでした（${ctrl.signal.aborted ? '通信が止まっています' : e?.message || e}）`); } finally { clearTimeout(timer); }
}

/** 写真を SIDE×SIDE に引き伸ばし（双一次）、AI の入力（ImageNet の平均と幅で正規化した RGB の面）にする */
function toInput(rgba, w, h) {
  const n = SIDE * SIDE; const x = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406]; const std = [0.229, 0.224, 0.225];
  for (let y = 0; y < SIDE; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / SIDE - 0.5)); const ya = Math.floor(fy); const yb = Math.min(h - 1, ya + 1); const ty = fy - ya;
    for (let xx = 0; xx < SIDE; xx++) {
      const fx = Math.min(w - 1, Math.max(0, (xx + 0.5) * w / SIDE - 0.5)); const xa = Math.floor(fx); const xb = Math.min(w - 1, xa + 1); const tx = fx - xa;
      for (let c = 0; c < 3; c++) {
        const a = rgba[(ya * w + xa) * 4 + c]; const b = rgba[(ya * w + xb) * 4 + c]; const d = rgba[(yb * w + xa) * 4 + c]; const e = rgba[(yb * w + xb) * 4 + c];
        const t = a + (b - a) * tx; const v = (t + (d + (e - d) * tx - t) * ty) / 255;
        x[c * n + y * SIDE + xx] = (v - mean[c]) / std[c];
      }
    }
  }
  return x;
}

self.onmessage = async ({ data }) => {
  let session = null;
  try {
    ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    const model = await download((t) => self.postMessage({ type: 'progress', t: 0.6 * t }));
    session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    self.postMessage({ type: 'progress', t: 0.7 });
    const input = toInput(data.rgba, data.w, data.h);
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]) });
    const d = out[session.outputNames[0]].data;
    // 大きさは写真ごとにまちまち（近さの比だけが分かる）なので、0〜1 にそろえる
    let lo = Infinity; let hi = -Infinity; for (let i = 0; i < d.length; i++) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
    const m = new Float32Array(SIDE * SIDE); const k = hi > lo ? 1 / (hi - lo) : 0;
    for (let i = 0; i < m.length; i++) m[i] = (d[i] - lo) * k;
    self.postMessage({ type: 'result', depth: { m, w: SIDE, h: SIDE } }, [m.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: outOfMemory(error) ? 'MEMORY' : error?.message || String(error) });
  } finally { session?.release?.(); }
};
