// 背景のぼかし（bokeh.js）を、編集用の大きさの写真（Canvas）と書き出しに当てる（DOM・Worker を使う側）
import { SCALE, applyBokeh } from './bokeh.js';
import { smallPixels } from './restoration-photo.js';
import { personSeg, faceSeg } from './skinseg.js';
import { COLOR_SPACE, ctx2d } from './color.js';

const later = () => new Promise((r) => setTimeout(r, 0));
const abortError = () => new DOMException('処理を中止しました', 'AbortError');

// 奥行きの AI がこれより長く何も返さなければ、あきらめる（奥行きなしでぼかす。端末のメモリが足りず Worker が止まったときなど）
const DEPTH_TIMEOUT = 60000;

/**
 * 写真の奥行き（depth-worker.js の AI。0〜1、大きいほど手前）。使えない端末・失敗したときは null（人物の地図だけでぼかす）
 * @param {{width:number,height:number,data:Uint8ClampedArray}} small 縮めた写真（長い辺 512）
 */
export async function depthMap(small, { signal, onProgress = () => {} } = {}) {
  const worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' });
  let timer = 0;
  try {
    return await new Promise((resolve, reject) => {
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error('奥行きの AI の返事がありません')), DEPTH_TIMEOUT); };
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
      worker.onmessage = ({ data: m }) => {
        arm();
        if (m.type === 'progress') onProgress(m.t);
        else if (m.type === 'result') { signal?.removeEventListener('abort', onAbort); resolve(m.depth); } else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker'));
      const rgba = small.data.slice();
      worker.postMessage({ rgba, w: small.width, h: small.height }, [rgba.buffer]);
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    console.warn('奥行きの AI を使えませんでした（人物の地図だけでぼかします）', e); return null;
  } finally { clearTimeout(timer); worker.terminate(); }
}

/**
 * ぼかしの元: 編集用の大きさの写真を 4 分の 1 に縮めたものと、人物・顔・奥行きの地図（AI の personSeg・faceSeg・depthMap）。
 * 顔 AI などを変えたときは、これを使い回す（写真全体を読み直さない）。AI が使えない端末では null（何もぼかさない）
 * @returns {Promise<{w:number,h:number,rgba:Uint8ClampedArray,person:{m,w,h},face:{m,w,h}|null,depth:{m,w,h}|null}|null>}
 */
export async function bokehSource(image, W, H, { signal, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw abortError();
  // 元の大きさの写しは作らない（iPhone では Canvas 1 枚で 70MB ほど。この後に奥行きの AI が動くので、メモリを空けておく）。
  // 縮めるのは AI を待つ前に（待つ間に元の写真が片付けられても困らないように）
  const small = smallPixels(image, W, H);
  // 4 分の 1 に縮める（なめらかに）
  const w = Math.max(1, Math.round(W / SCALE)); const h = Math.max(1, Math.round(H / SCALE));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const sx = ctx2d(s, { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(image, 0, 0, w, h);
  const img = sx.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }); s.width = 0; s.height = 0;
  const person = await personSeg(small);
  const face = person && await faceSeg(small); onProgress(0.3);
  const depth = person && await depthMap(small, { signal, onProgress: (t) => onProgress(0.3 + 0.7 * t) }); onProgress(1);
  if (signal?.aborted) throw abortError();
  if (!person) return null;
  return { w, h, rgba: img.data, person: { m: person.m, w: person.w, h: person.h }, face: face && { m: face.m, w: face.w, h: face.h }, depth };
}

/**
 * ぼかしの元（bokehSource）から、ぼかした背景と人物の割合（4 分の 1 の大きさ）を求める（Worker で）。
 * ぼかしの強さは写真ごとに自動（bokeh.js の autoRadius。いちばん大きい顔の大きさから）
 * @returns {Promise<{width:number,height:number,bg:Uint8ClampedArray,alpha:Uint8ClampedArray,auto:object}|null>}
 */
export async function bokehFromSource(src, { signal, onProgress = () => {} } = {}) {
  if (!src) return null;
  if (signal?.aborted) throw abortError();
  const worker = new Worker(new URL('./restoration-worker.js', import.meta.url), { type: 'module' });
  try {
    const r = await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'progress') onProgress(m.t);
        else if (m.type === 'result') { signal?.removeEventListener('abort', onAbort); resolve(m.bokeh); } else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker'));
      const rgba = src.rgba.slice(); // 元は使い回すので、写しを渡す
      worker.postMessage({ type: 'bokeh', rgba, w: src.w, h: src.h, person: src.person, face: src.face, depth: src.depth || null }, [rgba.buffer]);
    });
    onProgress(1);
    return r;
  } finally { worker.terminate(); }
}

/**
 * 編集用の大きさの写真から、ぼかした背景と人物の割合（4 分の 1 の大きさ）を求める（bokehSource → bokehFromSource）
 * @returns {Promise<{width:number,height:number,bg:Uint8ClampedArray,alpha:Uint8ClampedArray,auto:object}|null>}
 */
export async function bokehFor(image, W, H, { signal, onProgress = () => {} } = {}) {
  const src = await bokehSource(image, W, H, { signal, onProgress: (t) => onProgress(0.3 * t) });
  return bokehFromSource(src, { signal, onProgress: (t) => onProgress(0.3 + 0.7 * t) });
}

/** 編集用の大きさの写真に、背景のぼかしを合成した新しい Canvas */
export async function bokehCanvas(image, W, H, bk) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  if (!bk) return c;
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y); const d = x.getImageData(0, y, W, n, { colorSpace: COLOR_SPACE });
    applyBokeh(d.data, n, { y0: y, fullW: W, fullH: H }, bk);
    x.putImageData(d, 0, y);
    await later();
  }
  return c;
}

/**
 * 書き出し（元の大きさ）: 編集用の大きさで求めたぼかしを、引き伸ばして写真全体に合成する（帯ごとに読み書き）
 * read(x, y, w, h) → RGBA、write(x, y, w, h, RGBA)
 */
export async function mergeBokehFull(read, write, bk, W, H) {
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y); const data = read(0, y, W, n);
    applyBokeh(data, n, { y0: y, fullW: W, fullH: H }, bk);
    write(0, y, W, n, data);
    await later();
  }
}
