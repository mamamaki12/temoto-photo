import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerCount, lowMemory, limitOrtMemory, outOfMemory } from '../../cores.js';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

test('Worker の数: パソコンは CPU の数 − 1 まで使い、スマホ・メモリの少ない端末は控えめ', () => {
  assert.equal(workerCount({ userAgent: WIN, hardwareConcurrency: 16, deviceMemory: 8 }), 12);
  assert.equal(workerCount({ userAgent: WIN, hardwareConcurrency: 8, deviceMemory: 8 }), 7);
  assert.equal(workerCount({ userAgent: WIN, hardwareConcurrency: 16 }), 12); // deviceMemory がないブラウザ
  assert.equal(workerCount({ userAgent: WIN, hardwareConcurrency: 16, deviceMemory: 4 }), 4);
  assert.equal(workerCount({ userAgent: WIN, hardwareConcurrency: 16, deviceMemory: 8 }, { max: 6 }), 6);
  assert.equal(workerCount({ userAgent: IPHONE, hardwareConcurrency: 6, maxTouchPoints: 5 }), 2);
  assert.equal(workerCount({ userAgent: ANDROID, hardwareConcurrency: 8, deviceMemory: 8 }), 4);
  assert.equal(workerCount({ userAgent: WIN, hardwareConcurrency: 2 }), 1);
  assert.equal(workerCount({}), 1);
});

test('メモリの少ない端末（iPhone・iPad）だけ lowMemory（WebAssembly のノイズ除去・書き出しの先読み・AI と同時の逆畳み込みをしない）', () => {
  assert.equal(lowMemory({ userAgent: IPHONE, maxTouchPoints: 5 }), true);
  assert.equal(lowMemory({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', maxTouchPoints: 5 }), true); // iPad
  assert.equal(lowMemory({ userAgent: WIN }), false);
  assert.equal(lowMemory({ userAgent: ANDROID, maxTouchPoints: 5 }), false);
});

test('AI（ONNX Runtime）が予約するメモリ: iPhone・iPad だけ、その AI が使う量に抑える（4GB ずつ予約すると Out of memory）', () => {
  const ios = { navigator: { userAgent: IPHONE, maxTouchPoints: 5 } }; limitOrtMemory(768, ios);
  assert.equal(ios.ORT_WASM_MAX_PAGES, 768 * 16);
  const pc = { navigator: { userAgent: WIN } }; limitOrtMemory(768, pc);
  assert.equal(pc.ORT_WASM_MAX_PAGES, undefined);
  // ORT を入れ替えても、上限を読む所が残っているか
  const glue = readFileSync(new URL('../../vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url), 'utf8');
  assert.match(glue, /new WebAssembly\.Memory\(\{initial:256,maximum:globalThis\.ORT_WASM_MAX_PAGES\|\|65536,shared:!0\}\)/);
  assert.equal(outOfMemory(new Error('no available backend found. ERR: [wasm] RangeError: Out of memory')), true);
  assert.equal(outOfMemory(new Error('failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc')), true);
  assert.equal(outOfMemory(new Error('HTTP 404')), false);
});
