// ブレ補正の AI を CPU で動かす Worker（deblur-worker.js が、端末の CPU の数だけ作って区画を分けて渡す）
// 受け取る: { type: 'init', model: Uint8Array } / { type: 'run', id, input: Float32Array, n }
// 返す: { type: 'ready' } / { type: 'out', id, out: Float32Array } / { type: 'error', id?, message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { limitOrtMemory, lowMemory } from './cores.js';

limitOrtMemory(512); // 2 区画ずつ動かすと約 270MB（iPhone・iPad は下の設定で 1 区画ずつ、約 130MB）

let session = null;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      // iPhone・iPad: モデルの組み替え（最適化）をしない。読み込みに使うメモリが 157MB → 91MB、1 区画動かして 188MB → 130MB。
      // 速さは同じで、結果の違いは計算の丸めの分だけ（1/100 万ほど）
      const opts = lowMemory(self.navigator) ? { graphOptimizationLevel: 'disabled' } : {};
      session = await ort.InferenceSession.create(data.model, { executionProviders: ['wasm'], ...opts });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'run') {
      const r = await session.run({ input: new ort.Tensor('float32', data.input, [data.n, 3, data.size, data.size]) });
      const out = r.output.data;
      self.postMessage({ type: 'out', id: data.id, out }, [out.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error?.message || String(error) });
  }
};
