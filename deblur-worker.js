// 被写体ブレの補正の AI を動かす Worker（ONNX Runtime Web。WebGPU があれば GPU で、なければ CPU で。端末の中だけで動く）
// 受け取る: { type: 'run', small: { width, height, data: Float32Array（RGB、0〜1） }, denoise: AI に渡す前にノイズを取るか,
//   person, parts: 人物の地図・部位の地図（skinseg.js。ブレ補正を人物だけに効かせる。なければ全体） }
// 返す: { type: 'progress', phase: 'load' | 'denoise' | 'run', t } … { type: 'result', res: { width, height, data } } / { type: 'error', message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { addDeconv, deblurResidual2, deconvResidual, denoiseSmall, subjectWeight, weightResidual, TILE } from './deblur.js';
import { workerCount, lowMemory, limitOrtMemory } from './cores.js';

limitOrtMemory(512); // GPU で動かすときだけ使う（CPU では deblur-infer-worker.js）

const MODEL = new URL('./vendor/deblur/nafnet-gopro-w32.onnx', import.meta.url);

/** モデルを読み込む（はじめての 1 回は 36MB をダウンロード。以後はキャッシュ） */
async function download(onProgress) {
  const res = await fetch(MODEL);
  if (!res.ok || !res.body) throw new Error('ブレ補正の AI を読み込めませんでした');
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

/** CPU の Worker をいくつか作り、区画を分けて渡す（1 つの Worker の中の計算は 1 本なので、Worker の数だけ速くなる） */
function cpuPool(model) {
  const n = workerCount(self.navigator, { max: 6 }); // iPhone・iPad はメモリが少ないので 2 つまで、パソコンは CPU の数に合わせる
  const idle = []; const waiting = []; const jobs = new Map(); let seq = 0; let failed = null;
  const ready = [];
  for (let i = 0; i < n; i++) {
    const wk = new Worker(new URL('./deblur-infer-worker.js', import.meta.url), { type: 'module' });
    ready.push(new Promise((resolve, reject) => {
      wk.onmessage = ({ data: m }) => {
        if (m.type === 'ready') { idle.push(wk); resolve(); pump(); }
        else if (m.type === 'out') { const j = jobs.get(m.id); jobs.delete(m.id); idle.push(wk); j.resolve(m.out); pump(); }
        else if (m.type === 'error') {
          const e = new Error(m.message);
          if (m.id != null && jobs.has(m.id)) { const j = jobs.get(m.id); jobs.delete(m.id); j.reject(e); } else reject(e);
        }
      };
      wk.onerror = () => { failed = new Error('ブレ補正の AI を開始・実行できませんでした（端末のメモリが足りない可能性があります）'); reject(failed); for (const j of jobs.values()) j.reject(failed); };
    }));
    wk.postMessage({ type: 'init', model: model.slice() });
  }
  function pump() {
    while (idle.length && waiting.length) {
      const wk = idle.pop(); const job = waiting.shift(); const id = ++seq;
      jobs.set(id, job); wk.postMessage({ type: 'run', id, input: job.input, n: job.n, size: TILE }, [job.input.buffer]);
    }
  }
  return {
    size: n,
    ready: Promise.all(ready),
    run: (input, n) => (failed ? Promise.reject(failed) : new Promise((resolve, reject) => { waiting.push({ input: input.slice(), n, resolve, reject }); pump(); })),
  };
}

/** 逆畳み込み（deconvResidual）を別の Worker で */
function deconvInWorker(small) {
  return new Promise((resolve, reject) => {
    const wk = new Worker(new URL('./restoration-worker.js', import.meta.url), { type: 'module' });
    const end = (f, v) => { wk.terminate(); f(v); };
    wk.onmessage = ({ data: m }) => (m.type === 'result' ? end(resolve, m.res) : end(reject, new Error(m.message)));
    wk.onerror = () => end(reject, new Error('ブレ補正を開始・実行できませんでした（端末のメモリが足りない可能性があります）'));
    const copy = { width: small.width, height: small.height, data: small.data.slice() };
    wk.postMessage({ type: 'deconv', small: copy }, [copy.data.buffer]);
  });
}

let backend = null; // { run(input, n), size }
async function init(onProgress) {
  if (backend) return backend;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  const model = await download(onProgress);
  let gpu = false;
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    // ソフトウェアで GPU のふりをするもの（SwiftShader など）は、CPU で動かすより遅い
    const info = a?.info || {};
    gpu = !!a && !(info.isFallbackAdapter || a.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`));
  } catch { gpu = false; }
  if (gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] });
      // GPU の計算が正しく動くか、小さな絵で確かめる（おかしければ CPU で）
      const x = new Float32Array(3 * TILE * TILE).map((_, i) => 0.3 + 0.4 * ((i * 7919) % 97) / 97);
      const y = (await s.run({ input: new ort.Tensor('float32', x, [1, 3, TILE, TILE]) })).output.data;
      let bad = false; for (let i = 0; i < y.length; i += 101) if (!Number.isFinite(y[i]) || Math.abs(y[i] - x[i]) > 0.6) { bad = true; break; }
      if (!bad) {
        backend = { size: 1, run: async (input, n) => (await s.run({ input: new ort.Tensor('float32', input, [n, 3, TILE, TILE]) })).output.data };
        return backend;
      }
      await s.release();
    } catch (e) { console.warn('WebGPU でブレ補正を動かせないので CPU で動かします', e); }
  }
  const pool = cpuPool(model);
  await pool.ready;
  backend = pool;
  return backend;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  try {
    const be = await init((t) => self.postMessage({ type: 'progress', phase: 'load', t }));
    const input = data.denoise ? denoiseSmall(data.small, (t) => self.postMessage({ type: 'progress', phase: 'denoise', t })) : data.small;
    // 逆畳み込み（下）は AI の結果を使わないので、パソコン・Android では別の Worker で AI と同時に計算する（iPhone・iPad はメモリが少ないので後で）
    const dc = lowMemory(self.navigator) ? null : deconvInWorker(input);
    dc?.catch(() => {});
    // 人物だけに（背景はピントの外れたぼけ。直すとガサガサになる）。肌のなめらかな所は弱く
    const wt = subjectWeight(input, data.person || null, data.parts || null);
    const res = await deblurResidual2(input, be.run, { concurrency: be.size, wt, onProgress: (t) => self.postMessage({ type: 'progress', phase: 'run', t: 0.95 * t }) });
    // AI が直せない、なだらかなにじみ（ぼけ・小さなブレ）は、ぼけの形を仮定して戻す。AI がもう直した所には足さない
    addDeconv(res, dc ? await dc : deconvResidual(input), input);
    weightResidual(res, wt);
    self.postMessage({ type: 'progress', phase: 'run', t: 1 });
    self.postMessage({ type: 'result', res }, [res.data.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
