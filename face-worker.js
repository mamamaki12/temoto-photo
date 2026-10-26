// 顔専用 AI を動かす Worker（GFPGAN v1.4 を ONNX にしたもの。ONNX Runtime Web で、WebGPU があれば GPU、なければ CPU。端末の中だけで動く）
// 受け取る: { type: 'run', faces: [{ crop: Float32Array（512×512 の RGB、0〜255）, pts: 顔の点（512 の座標）, refs: [{ img, pts }]（本人の写真） }] }
// 返す: { type: 'progress', phase: 'load' | 'run', t } … { type: 'result', outs: [Float32Array（512×512 の RGB、0〜255）] } / { type: 'error', message }
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { SIZE, transferDetail } from './faceai.js';

// モデルは 87MB（重みを 8bit にしたもの。scripts/face-proto/quantize_int8.py）
const PARTS = ['./vendor/faceai/gfpgan-v1.4-int8.onnx'].map((p) => new URL(p, import.meta.url));
/**
 * ダウンロードした所を置くキャッシュ。4MB ずつ取って、取れた所から保存する（スマホの回線が途中で切れても、続きから読み込めるように）。
 * モデルを入れ替えるときは名前を変える（sw.js は temoto-faceai- で始まるキャッシュを消さない）
 */
const STORE = 'temoto-faceai-gfpgan-v1.4-int8';
const CHUNK = 4 * 1024 * 1024;
const TRIES = 6; // 1 つの区切りを取り直す回数（1・2・4・8・15 秒あけて）

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 区切りの置き場所の名前（本物の URL と分けて、Service Worker や普通の読み込みと混ざらないように） */
const chunkKey = (u, k) => new URL(`${u.pathname}.chunk-${k}`, u).href;

/** ファイルの大きさ（区切りの 1 つ目の Content-Range から。先に保存してあれば、それを使う） */
async function partSize(cache, u) {
  const key = new URL(`${u.pathname}.size`, u).href;
  const hit = await cache.match(key);
  if (hit) return +(await hit.text());
  const { size } = await getRange(u, 0, 0);
  await cache.put(key, new Response(String(size)));
  return size;
}
/**
 * ファイルの一部（a〜b バイト目）を取る。回線が切れたり、途中までしか届かなかったりしたら、少し待って取り直す
 * @returns {Promise<{data:Uint8Array,size:number}>} size: ファイル全体の大きさ
 */
async function getRange(u, a, b) {
  let last;
  for (let t = 0; t < TRIES; t++) {
    if (t) await wait(Math.min(15000, 1000 * 2 ** (t - 1)));
    try {
      const res = await fetch(u, { headers: { Range: `bytes=${a}-${b}` }, cache: 'no-store' });
      if (res.status === 200) { const data = new Uint8Array(await res.arrayBuffer()); full.set(u.href, data); return { data: data.subarray(a, b + 1), size: data.length }; } // 一部だけの読み込みに対応していないサーバー
      if (res.status !== 206) { last = new Error(`HTTP ${res.status}`); continue; }
      const m = /\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
      const data = new Uint8Array(await res.arrayBuffer());
      if (m && data.length === b - a + 1) return { data, size: +m[1] };
      last = new Error(`short ${data.length}`);
    } catch (e) { last = e; }
  }
  throw Object.assign(new Error(`download: ${last?.message || last}`), { network: true });
}
/** 一部だけの読み込みに対応していないサーバーから丸ごと取ったもの（URL → 中身） */
const full = new Map();
/** キャッシュが使えないとき（プライベートブラウズなど）の代わり（保存しない） */
const noStore = { match: async () => undefined, put: async () => {} };

/** モデルを読み込む（はじめては 87MB をダウンロード。保存した所は使い回し、足りない所だけダウンロードする） */
async function download(onProgress) {
  let cache = noStore;
  try { cache = await caches.open(STORE); } catch (e) { console.warn('顔専用 AI を保存できないので、毎回ダウンロードします', e); }
  // 前のモデル（1.26.0 の半精度 170MB など）を保存していたら消して、端末の空きを戻す
  try { for (const k of await caches.keys()) if (k.startsWith('temoto-faceai-') && k !== STORE) await caches.delete(k); } catch { /* 消せなくても続ける */ }
  const sizes = []; for (const u of PARTS) sizes.push(await partSize(cache, u));
  const total = sizes.reduce((s, n) => s + n, 0);
  // 端末に置ける量が少ないときは保存しない（編集中の写真の保存が「容量不足」で失敗しないよう、まだ保存していない分＋ 100MB の余裕を残す）
  const keys = await cache.keys?.().catch(() => []) || [];
  const saved = keys.filter((k) => /\.chunk-\d+$/.test(k.url)).length;
  try {
    const { quota = Infinity, usage = 0 } = await navigator.storage?.estimate?.() || {};
    if (quota - usage < total - saved * CHUNK + 100e6) {
      console.warn('端末の空きが少ないので、顔専用 AI は保存せずに使います');
      cache = { match: cache.match.bind(cache), put: noStore.put };
    }
  } catch { /* 量を調べられないときは、保存してみる（失敗したら保存をやめる） */ }
  const buf = new Uint8Array(total); let o = 0;
  for (let p = 0; p < PARTS.length; p++) {
    const u = PARTS[p];
    for (let a = 0, k = 0; a < sizes[p]; a += CHUNK, k++) {
      const b = Math.min(sizes[p], a + CHUNK) - 1; const key = chunkKey(u, k);
      let data = null;
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) { data = new Uint8Array(await hit.arrayBuffer()); if (data.length !== b - a + 1) data = null; }
      if (!data) {
        data = full.has(u.href) ? full.get(u.href).subarray(a, b + 1) : (await getRange(u, a, b)).data;
        // 端末の空きが少なくて保存できなくても、今回の読み込みは続ける
        await cache.put(key, new Response(data)).catch((e) => {
          console.warn('顔専用 AI の一部を保存できなかったので、ここからは保存しません', e);
          cache = { match: cache.match.bind(cache), put: noStore.put };
        });
      }
      buf.set(data, o); o += data.length; onProgress(o / total);
    }
  }
  full.clear();
  return buf;
}

/**
 * AI の設定。グラフの最適化を切ると、8bit の重みを前もって単精度に広げた写し（約 340MB）を作らない（使う直前に 1 つずつ広げる）ので、
 * 結果・速さは同じまま、メモリが約 330MB 減る（iPhone ではページごと落とされていた）
 */
const OPTS = { graphOptimizationLevel: 'disabled', enableCpuMemArena: false, enableMemPattern: false };
/** スマホ（iPhone・iPad・Android）。GPU と CPU の 2 つの読み込みを同時に抱えないよう、CPU だけで動かす */
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let session = null;
async function init(onProgress) {
  if (session) return session;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  let model;
  try { model = await download(onProgress); } catch (e) {
    console.warn(e);
    throw new Error(e.network ? 'DOWNLOAD' : 'MEMORY');
  }
  let gpu = false;
  if (!MOBILE) try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    const info = a?.info || {};
    gpu = !!a && !(info.isFallbackAdapter || a.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`));
  } catch { gpu = false; }
  if (gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], ...OPTS });
      // GPU の計算が正しく動くか、灰色の顔で確かめる（おかしければ CPU で）
      const y = (await s.run({ input: new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) })).output.data;
      let bad = false; for (let i = 0; i < y.length; i += 997) if (!Number.isFinite(y[i])) { bad = true; break; }
      if (!bad) { session = s; return session; }
      await s.release();
    } catch (e) { console.warn('WebGPU で顔専用 AI を動かせないので CPU で動かします', e); }
  }
  try { session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], ...OPTS }); } catch (e) {
    console.warn(e); throw new Error('MEMORY');
  }
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
