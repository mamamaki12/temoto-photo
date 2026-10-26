// 全体 AI（Real-ESRGAN realesr-general-x4v3）を動かす Worker（ONNX Runtime Web。WebGPU があれば GPU で、なければ CPU で。端末の中だけで動く）
// 受け取る: { type: 'run', img: Uint8ClampedArray（RGBA、W×H。編集用の大きさの写真）, W, H }
// 返す: { type: 'progress', phase: 'load' | 'run', t } … { type: 'result', res: Int8Array（W×H×3。写真に足す差分、1 = 1/255）, img（受け取った写真を返す） } / { type: 'error', message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { SCALE, TILE_IN, putResidual, regionOf, smallFrom, tileInput, tileRect, tiles } from './wholeai.js';
import { workerCount } from './cores.js';

const MODEL = new URL('./vendor/wholeai/realesr-general-x4v3.onnx', import.meta.url);
/** スマホ（iPhone・iPad・Android）。メモリを抱えないよう、GPU は試さず CPU だけで動かす（顔 AI と同じ） */
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function download(onProgress) {
  const res = await fetch(MODEL);
  if (!res.ok || !res.body) throw new Error('全体 AI を読み込めませんでした');
  const total = +res.headers.get('Content-Length') || 0; const parts = []; let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total));
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

/**
 * CPU の Worker をいくつか作り、区画を分けて渡す（whole-infer-worker.js。AI と差分の計算を、区画ごとに並べて）。
 * model がなければ（GPU で AI を動かすとき）、差分の計算だけ
 */
function pool(model) {
  const n = workerCount(self.navigator, { max: 8 }); // AI を読み込んだ Worker は 1 つ 30MB くらい
  const idle = []; const waiting = []; const jobs = new Map(); let seq = 0; let failed = null; const all = [];
  const ready = [];
  for (let i = 0; i < n; i++) {
    const wk = new Worker(new URL('./whole-infer-worker.js', import.meta.url), { type: 'module' }); all.push(wk);
    ready.push(new Promise((resolve, reject) => {
      wk.onmessage = ({ data: m }) => {
        if (m.type === 'ready') { idle.push(wk); resolve(); pump(); }
        else if (m.type === 'out') { const j = jobs.get(m.id); jobs.delete(m.id); idle.push(wk); j.resolve(m.out); pump(); }
        else if (m.type === 'error') {
          const e = new Error(m.message);
          if (m.id != null && jobs.has(m.id)) { const j = jobs.get(m.id); jobs.delete(m.id); j.reject(e); } else reject(e);
        }
      };
      wk.onerror = () => { failed = new Error('全体 AI を開始・実行できませんでした（端末のメモリが足りない可能性があります）'); reject(failed); for (const j of jobs.values()) j.reject(failed); };
    }));
    wk.postMessage({ type: 'init', model: model?.slice() });
  }
  function pump() {
    while (idle.length && waiting.length) {
      const wk = idle.pop(); const { msg, resolve, reject } = waiting.shift(); const id = ++seq;
      jobs.set(id, { resolve, reject }); wk.postMessage({ type: 'run', id, ...msg }, [msg.reg.buffer, (msg.input || msg.out).buffer]);
    }
  }
  return {
    size: n,
    ready: Promise.all(ready),
    /** msg: { input（AI の入力）か out（AI の結果）, reg, rect } → 差分 */
    run: (msg) => (failed ? Promise.reject(failed) : new Promise((resolve, reject) => { waiting.push({ msg, resolve, reject }); pump(); })),
    close: () => { for (const w of all) w.terminate(); },
  };
}

/** AI の動かし方。gpu: GPU の AI（なければ null。区画をまとめて渡す）、cpu: 区画ごとの差分（と CPU の AI）の Worker */
async function init(onProgress) {
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  const model = await download(onProgress);
  let gpu = false;
  if (!MOBILE) try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    // ソフトウェアで GPU のふりをするもの（SwiftShader など）は、CPU で動かすより遅い
    const info = a?.info || {};
    gpu = !!a && !(info.isFallbackAdapter || a.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`));
  } catch { gpu = false; }
  let session = null;
  if (gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] });
      // GPU の計算が正しく動くか、小さな絵で確かめる（おかしければ CPU で）
      const x = new Float32Array(3 * TILE_IN * TILE_IN).map((_, i) => 0.3 + 0.4 * ((i * 7919) % 97) / 97);
      const y = (await s.run({ input: new ort.Tensor('float32', x, [1, 3, TILE_IN, TILE_IN]) })).output.data;
      let bad = false; for (let i = 0; i < y.length; i += 101) if (!Number.isFinite(y[i]) || y[i] < -0.5 || y[i] > 1.5) { bad = true; break; }
      if (bad) await s.release(); else session = s;
    } catch (e) { console.warn('WebGPU で全体 AI を動かせないので CPU で動かします', e); }
  }
  const cpu = pool(session ? null : model);
  try { await cpu.ready; } catch (e) { cpu.close(); await session?.release(); throw e; }
  return {
    cpu, gpu: session && (async (input, k) => (await session.run({ input: new ort.Tensor('float32', input, [k, 3, TILE_IN, TILE_IN]) })).output.data),
    close: () => { cpu.close(); session?.release(); },
  };
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  let be = null;
  try {
    const { img, W, H } = data;
    be = await init((t) => self.postMessage({ type: 'progress', phase: 'load', t }));
    const small = smallFrom(img, W, H);
    const list = tiles(small.width, small.height); const res = new Int8Array(W * H * 3);
    const per = 3 * TILE_IN * TILE_IN; const outPer = per * SCALE * SCALE;
    let done = 0; const step = () => { done++; self.postMessage({ type: 'progress', phase: 'run', t: done / list.length }); };
    const job = async ([x, y], src) => {
      const rect = tileRect(W, H, x, y);
      putResidual(res, W, rect, await be.cpu.run({ ...src, reg: regionOf(img, W, rect), rect })); step();
    };
    if (be.gpu) {
      // GPU: 区画を何枚かまとめて AI に通し、差分は CPU の Worker で（GPU は次の区画に進む）
      const pending = []; const B = 4;
      for (let k = 0; k < list.length; k += B) {
        const group = list.slice(k, k + B); const input = new Float32Array(per * group.length);
        group.forEach(([x, y], j) => tileInput(small, x, y, input, j * per));
        const out = await be.gpu(input, group.length);
        group.forEach((t, j) => pending.push(job(t, { out: out.slice(j * outPer, (j + 1) * outPer) })));
        while (pending.length > be.cpu.size * 2) await pending.shift();
      }
      await Promise.all(pending);
    } else {
      // CPU: Worker の数だけ同時に（区画ごとに、AI と差分の計算をまとめて）
      let next = 0;
      const lane = async () => { while (next < list.length) { const t = list[next++]; await job(t, { input: tileInput(small, t[0], t[1]) }); } };
      await Promise.all(Array.from({ length: be.cpu.size }, lane));
    }
    self.postMessage({ type: 'result', res, img }, [res.buffer, img.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  } finally { be?.close?.(); }
};
