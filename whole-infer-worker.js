// 全体 AI を CPU で動かす Worker（whole-worker.js が、端末の CPU の数だけ作って区画を分けて渡す）。
// AI に通したあと、写真に足す差分（wholeai.js の tileResidual）もここで求める（区画ごとに並べて計算できる）。
// GPU で AI を動かすときは、モデルなしで作り、差分だけを求める
// 受け取る: { type: 'init', model?: Uint8Array } / { type: 'run', id, input?: Float32Array（AI の入力）, out?: Float32Array（GPU で求めた AI の結果）, reg, rect }
// 返す: { type: 'ready' } / { type: 'out', id, out: Int8Array（差分） } / { type: 'error', id?, message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { TILE_IN, tileResidual } from './wholeai.js';
import { limitOrtMemory } from './cores.js';

limitOrtMemory(128); // 動かすと約 35MB

let session = null;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      if (data.model) {
        ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
        ort.env.wasm.numThreads = 1;
        session = await ort.InferenceSession.create(data.model, { executionProviders: ['wasm'] });
      }
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'run') {
      const out = data.out || (await session.run({ input: new ort.Tensor('float32', data.input, [1, 3, TILE_IN, TILE_IN]) })).output.data;
      const part = tileResidual(out, 0, data.reg, data.rect);
      self.postMessage({ type: 'out', id: data.id, out: part }, [part.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error?.message || String(error) });
  }
};
