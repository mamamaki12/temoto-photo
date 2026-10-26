// 顔の見分けの AI を動かす Worker（SFace。重みを 8bit にしたもの 10MB。scripts/face-proto/quantize_sface.py。ONNX Runtime Web の CPU で。端末の中だけで動く）
// 受け取る: { type: 'embed', inputs: [Float32Array（facerec.js の recInput）] }
// 返す: { type: 'result', embs: [Float32Array（128、長さ 1）] } / { type: 'error', message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { REC, normalize } from './facerec.js';
import { limitOrtMemory } from './cores.js';

limitOrtMemory(128); // 動かすと約 62MB

let session = null;
async function init() {
  if (session) return session;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  const res = await fetch(new URL('./vendor/facerec/sface-int8.onnx', import.meta.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
  return session;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'embed') return;
  try {
    const s = await init();
    const embs = [];
    for (const x of data.inputs) embs.push(normalize((await s.run({ data: new ort.Tensor('float32', x, [1, 3, REC, REC]) })).fc1.data));
    self.postMessage({ type: 'result', embs }, embs.map((e) => e.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
