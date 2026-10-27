import { restoreInWorker } from './restoration-client.js';
import { measureNoise, planTone, grainFor, autoNr, BAND_MARGIN } from './restoration-lowlight.js';
import { COLOR_SPACE, ctx2d, imageData } from './color.js';
import { personSeg, faceSeg } from './skinseg.js';
import { workerCount } from './cores.js';

// 一度にWorkerへ送る範囲を限定する。3画素の探索+1画素のパッチ分を重ねて継ぎ目を防ぐ。
export async function restorePhotoBanded(input, options = {}, hooks = {}) {
  const { width, height, data } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 16384 || width * height > 16_000_000 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new Error('比較画面は1600万画素・幅16384pxまで対応しています。自動縮小はしません。');
  }
  const output = new Uint8ClampedArray(data.length);
  const rows = Math.min(256, Math.floor(4_000_000 / width) - 8);
  for (let y = 0; y < height; y += rows) {
    if (hooks.signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError');
    const end = Math.min(height, y + rows); const top = Math.max(0, y - 4); const bottom = Math.min(height, end + 4);
    const part = await restorePhoto({ width, height: bottom - top, colorSpace: input.colorSpace,
      data: data.slice(top * width * 4, bottom * width * 4) }, options, {
      signal: hooks.signal,
      onProgress: ({ percent }) => hooks.onProgress?.({ percent: Math.min(99, Math.floor(100 * (y + (end - y) * percent / 100) / height)) }),
    });
    output.set(part.data.subarray((y - top) * width * 4, (end - top) * width * 4), y * width * 4);
  }
  if (hooks.signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError');
  hooks.onProgress?.({ percent: 100 });
  return { width, height, data: output, colorSpace: input.colorSpace || 'srgb' };
}

// 評価用の写真アダプター。入力は同一色空間の8bit RGBA。
// 既存エンジンに合わせたgamma 2.2の近似。平方根領域でノイズを軽減してから明るくする。
// noise は平方根領域の標準偏差（255倍）。自動推定値ではない。
export async function restorePhoto(input, { amount = 60, noise = 3, strength = 1 } = {}, hooks = {}) {
  const { width, height, data } = input;
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4 ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 4_000_000) {
    throw new Error('評価用は400万画素までのRGBA画像に対応しています。画像は自動縮小しません。');
  }
  for (const [v, lo, hi] of [[amount, 0, 100], [noise, 0, 30], [strength, 0, 2]]) {
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error('補正の設定が範囲外です');
  }
  const check = () => { if (hooks.signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError'); };
  check();
  const rgb = new Float32Array(width * height * 3);
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    if (data[p + 3] !== 255) throw new Error('評価用は不透明な写真を使ってください');
    for (let c = 0; c < 3; c++) rgb[q + c] = (data[p + c] / 255) ** 1.1;
  }
  const result = await restoreInWorker({ width, height, data: rgb }, { noiseSigma: noise / 255, strength, exposureEV: 0 }, {
    signal: hooks.signal, onProgress: (p) => hooks.onProgress?.({ ...p, percent: Math.floor(p.percent * 0.95) }),
  });
  check();
  const output = new Uint8ClampedArray(data.length); const gain = 2 ** (amount / 25);
  for (let p = 0, q = 0; p < output.length; p += 4, q += 3) {
    const r = result.data[q] ** 2; const g = result.data[q + 1] ** 2; const b = result.data[q + 2] ** 2;
    const scale = gain / (1 + (gain - 1) * Math.max(r, g, b));
    output[p] = 255 * (r * scale) ** (1 / 2.2);
    output[p + 1] = 255 * (g * scale) ** (1 / 2.2);
    output[p + 2] = 255 * (b * scale) ** (1 / 2.2); output[p + 3] = 255;
  }
  check(); hooks.onProgress?.({ percent: 100 });
  return { width, height, data: output, colorSpace: input.colorSpace || 'srgb' };
}

// ───────── 暗い写真の補正（編集画面の「ノイズ軽減」「写真全体の明るさ補正」） ─────────
// ノイズを先に取ってから明るくする（restoration-lowlight.js）。写真を横長の帯に分け、いくつかの Worker で同時に処理する。
// ノイズの量と明るさの曲線は、写真全体で 1 つに決めてから全部の帯に渡す（帯の境目で明るさ・なめらかさが変わらない）。

/** この編集で、暗所補正を使うか */
export const lowlightActive = (adj) => adj.noise > 0 || adj.lowlight > 0;
/** 編集の値（0〜100）→ 補正の設定。ノイズ軽減 50・明るさ補正 50 で、写真ごとに自動で決めた強さ（enhancePhoto・planTone・autoNr） */
export const lowlightOptions = (adj) => ({ nr: adj.noise / 50, light: adj.lowlight });
/** 補正を当てたあとの描画では、GPU の簡易版（ノイズ軽減・明るさ）を二重にかけない */
export const withoutLowlight = (state) => ({ ...state, adj: { ...state.adj, noise: 0, lowlight: 0 } });

const NOISE_SAMPLE = 2048; // ノイズの量は、写真の中央のこの大きさの範囲で測る
const TONE_SIDE = 512; // 明るさの流れは、この長い辺に縮めた絵で決める
const abortError = () => new DOMException('処理を中止しました', 'AbortError');

/**
 * 写真全体を補正する
 * @param {object} src
 * @param {number} src.width
 * @param {number} src.height
 * @param {(y:number, rows:number)=>Uint8ClampedArray|Promise<Uint8ClampedArray>} src.read 横幅いっぱいの rows 行分の RGBA（新しい配列）
 * @param {{width:number,height:number,data:Uint8ClampedArray}} src.small 長い辺 512 くらいに縮めた写真（明るさの曲線を決める）
 * @param {{nr:number, light:number, grain?:boolean, fine?:boolean}} options grain: false で細かい粒を足さない（ブレ補正のあとに足すとき）。
 *   fine: false で、ノイズ除去で取った肌のきめ（ごく細かい粒）を戻さない（ブレ補正をするとき）
 * @param {object} hooks
 * @param {(y:number, rows:number, data:Uint8ClampedArray)=>void} hooks.onBand 補正できた帯（順番どおりとは限らない）
 * @param {(t:number)=>void} [hooks.onProgress] 0〜1（実際に処理した量）
 * @param {(grain:number, face:object|null)=>void} [hooks.onGrain] 足す粒の強さ（grainFor）と、粒を弱める顔の肌の地図。帯より先に 1 回。grain: false のときも、ブレ補正のあとに足す強さとして知らせる
 * @param {AbortSignal} [hooks.signal]
 * @param {object} [hooks.cache] 途中の結果を取っておく入れ物（編集画面で、同じ写真に対して使い回す。写真が変わったら新しくする）。
 *   ノイズ除去の重い部分（denoiseBand）の結果を帯ごとに取っておき（cache.keepBands が false なら取っておかない）、
 *   ノイズ軽減の強さが同じなら、明るさ補正を変えても仕上げ（finishBand）だけをやり直す。結果は 1 ビットも変わらない。
 *   cache.pv には、スライダーを動かしている間の見本にする、縮めた明るさの曲線の前の絵（tonePreview）、cache.small には明るさの曲線を決める絵が入る
 */
export async function enhancePhoto({ width, height, read, small }, { nr, light, grain = true, fine = true }, { onBand, onProgress = () => {}, onGrain = () => {}, signal, cache = null } = {}) {
  const check = () => { if (signal?.aborted) throw abortError(); };
  if (cache?.pending) await cache.pending; // 前に中止したときの、取っておいた帯が戻るのを待つ
  check();
  const ckey = JSON.stringify([width, height, nr]);
  if (cache && cache.key !== ckey) { cache.key = ckey; cache.profile = undefined; cache.bands = []; cache.pv = null; }
  if (cache && cache.keepBands === false) cache.bands = [];
  if (cache) cache.small = small;
  // 1. ノイズの量（写真の中央で）
  let profile = cache?.profile ?? null;
  if (nr > 0 && cache?.profile === undefined) {
    const rows = Math.min(height, NOISE_SAMPLE); const y0 = (height - rows) >> 1;
    const cw = Math.min(width, NOISE_SAMPLE); const x0 = (width - cw) >> 1;
    const all = await read(y0, rows); const crop = new Uint8ClampedArray(cw * rows * 4);
    for (let y = 0; y < rows; y++) crop.set(all.subarray((y * width + x0) * 4, (y * width + x0 + cw) * 4), y * cw * 4);
    profile = measureNoise(crop, cw, rows);
  }
  if (cache) cache.profile = profile;
  check(); onProgress(0.02);
  // 2. 明るさの曲線（写真全体で 1 つ）。人物と背景で照明の色の直し方を変えるので、人物の範囲を AI で見分ける
  // 顔が写っていれば、顔の肌の明るさで明るくする量を決める（planTone）
  const person = light > 0 ? await personSeg(small) : null;
  const face = light > 0 ? await faceSeg(small) : null;
  check();
  const tone = light > 0 ? planTone(small, light, { person, face }) : null;
  // ノイズ軽減の強さも、明るくする量に合わせる（スライダー 50 で自動の強さ）。
  // 明るくする量は、明るさ補正 50 のとき（写真ごとの自動の量）で決める。明るさのスライダーを動かしただけでノイズの取り方まで変わると、
  // 取っておいたノイズ除去の結果（cache.bands）が使えず、毎回最初からやり直しになる
  nr *= autoNr(tone && { gain: Math.min(16, tone.auto * (1 + 50 / 400)) });
  if (cache && cache.nr !== nr) { cache.nr = nr; cache.bands = []; cache.pv = null; }
  onGrain(grainFor(nr, profile, tone), (tone && tone.face) || null);
  // 3. 帯ごとに、いくつかの Worker で
  const ROWS = Math.max(64, Math.min(512, Math.floor(1_000_000 / width / 4) * 4));
  const bands = [];
  for (let y = 0; y < height; y += ROWS) bands.push({ y, rows: Math.min(ROWS, height - y) });
  const done = new Float64Array(bands.length);
  // 取っておいた帯は、仕上げだけなので軽い（進捗の重みを小さく）
  const keep = !!cache && cache.keepBands !== false && nr > 0 && !!profile;
  const weight = bands.map((b, i) => b.rows * (cache?.bands[i] ? 0.2 : 1)); const total = weight.reduce((a, b) => a + b, 0);
  const report = () => { let s = 0; for (let i = 0; i < bands.length; i++) s += done[i] * weight[i]; onProgress(0.02 + 0.98 * Math.min(1, s / total)); };
  // 見本: 長い辺が 1,600 くらいになるように、2 のべき乗で縮める（帯の行数は 4 の倍数なので、4 まで）
  const f = Math.max(1, Math.min(4, 2 ** Math.round(Math.log2(Math.max(width, height) / 1600))));
  const pv = cache ? { f, w: Math.ceil(width / f), h: Math.ceil(height / f) } : null;
  if (pv) for (const k of ['Y', 'Cb', 'Cr']) pv[k] = new Float32Array(pv.w * pv.h);
  const workers = []; let next = 0; let failed = null; let running = 0;
  // 中止したとき、取っておいた帯を仕上げている Worker は、終わるのを待って帯を返してもらってから止める（仕上げは短い。止めると、その帯のノイズ除去をやり直すことになる）
  const drains = [];
  const stop = () => {
    for (const w of workers) {
      if (w.holding == null || !cache) { w.terminate(); continue; }
      drains.push(new Promise((r) => { w.drained = () => { w.terminate(); r(); }; }));
    }
    if (drains.length) cache.pending = Promise.all(drains).then(() => { cache.pending = null; });
  };
  await new Promise((resolve, reject) => {
    const fail = (e) => { if (failed) return; failed = e; stop(); signal?.removeEventListener('abort', onAbort); reject(e); };
    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const feed = async (worker) => {
      if (failed) return;
      if (next >= bands.length) {
        if (--running === 0) { stop(); signal?.removeEventListener('abort', onAbort); resolve(); }
        return;
      }
      const id = next++; const { y, rows } = bands[id];
      const options = { nr, profile, tone, grain, fine };
      const cached = cache?.bands[id];
      if (cached) {
        cache.bands[id] = null; // Worker に渡している間
        worker.holding = id;
        worker.postMessage({ type: 'lowlight', id, cached, options, pv: pv && f }, [cached.Y.buffer, cached.Y0.buffer, cached.Cb.buffer, cached.Cr.buffer]);
        return;
      }
      const top = Math.max(0, y - BAND_MARGIN); const bottom = Math.min(height, y + rows + BAND_MARGIN);
      let data;
      try { data = await read(top, bottom - top); } catch (e) { fail(e); return; }
      if (failed) return;
      worker.postMessage({ type: 'lowlight', id, band: { width, height: bottom - top, data },
        at: { top: y - top, bottom: y - top + rows, y0: top, fullW: width, fullH: height }, options, keep, pv: pv && f }, [data.buffer]);
    };
    const n = Math.min(workerCount(), bands.length);
    for (let i = 0; i < n; i++) {
      const worker = new Worker(new URL('./restoration-worker.js', import.meta.url), { type: 'module' });
      workers.push(worker); running++;
      worker.onmessage = ({ data: m }) => {
        if (m.type !== 'progress' && m.id === worker.holding) {
          worker.holding = null;
          if (failed) { if (m.type === 'result' && cache.key === ckey && cache.keepBands !== false) cache.bands[m.id] = m.keep; worker.drained?.(); return; }
        }
        if (failed) return;
        if (m.type === 'progress') { done[m.id] = Math.min(0.99, m.t); report(); }
        else if (m.type === 'result') {
          done[m.id] = 1; report();
          if (keep && m.keep) cache.bands[m.id] = m.keep;
          if (m.pv) { const o = (bands[m.id].y / f) * pv.w; for (const k of ['Y', 'Cb', 'Cr']) pv[k].set(m.pv[k].subarray(0, Math.min(m.pv[k].length, pv[k].length - o)), o); }
          try { onBand(bands[m.id].y, bands[m.id].rows, m.data); } catch (e) { fail(e); return; }
          feed(worker);
        } else if (m.type === 'error') fail(new Error(m.message));
      };
      worker.onerror = () => { worker.holding = null; worker.drained?.(); fail(new Error('暗所補正の処理を開始・実行できませんでした（端末のメモリが足りない可能性があります）')); };
      feed(worker);
    }
  });
  if (pv) cache.pv = pv;
  onProgress(1);
}

/** 写真（Canvas・ImageBitmap など）を縮めて、明るさの曲線を決めるための小さな画素にする */
export function smallPixels(image, W, H) {
  const s = Math.min(1, TONE_SIDE / Math.max(W, H));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
  const x = ctx2d(c, { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(image, 0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: x.getImageData(0, 0, c.width, c.height, { colorSpace: COLOR_SPACE }).data };
}

/** 編集用の大きさの写真（Canvas・ImageBitmap）を補正して、新しい Canvas を返す */
export async function enhanceCanvas(image, W, H, options, hooks = {}) {
  const src = document.createElement('canvas'); src.width = W; src.height = H;
  const sx = ctx2d(src, { willReadFrequently: true }); sx.drawImage(image, 0, 0, W, H);
  const out = document.createElement('canvas'); out.width = W; out.height = H; const ox = ctx2d(out);
  try {
    await enhancePhoto({ width: W, height: H, small: smallPixels(src, W, H),
      read: (y, rows) => sx.getImageData(0, y, W, rows, { colorSpace: COLOR_SPACE }).data }, options, {
      ...hooks, onBand: (y, rows, data) => ox.putImageData(imageData(data, W, rows), 0, y),
    });
  } finally { src.width = 0; src.height = 0; }
  return out;
}
