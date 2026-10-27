// 背景のぼかし（bokeh.js）を、編集用の大きさの写真（Canvas）と書き出しに当てる（DOM・Worker を使う側）
import { SCALE, applyBokeh } from './bokeh.js';
import { smallPixels } from './restoration-photo.js';
import { personSeg, faceSeg } from './skinseg.js';
import { COLOR_SPACE, ctx2d } from './color.js';

const later = () => new Promise((r) => setTimeout(r, 0));
const abortError = () => new DOMException('処理を中止しました', 'AbortError');

/**
 * 編集用の大きさの写真から、ぼかした背景と人物の割合（4 分の 1 の大きさ）を求める。
 * 人物は AI（personSeg）で見分ける。AI が使えない端末では、背景が分からないので何もぼかさない（null）。
 * ぼかしの強さは写真ごとに自動（bokeh.js の autoRadius。いちばん大きい顔の大きさから）
 * @returns {Promise<{width:number,height:number,bg:Uint8ClampedArray,alpha:Uint8ClampedArray,auto:object}|null>}
 */
export async function bokehFor(image, W, H, { signal, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw abortError();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const small = smallPixels(c, W, H); const person = await personSeg(small);
  const face = person && await faceSeg(small); onProgress(0.3);
  if (signal?.aborted) throw abortError();
  if (!person) { c.width = 0; c.height = 0; return null; }
  // 4 分の 1 に縮める（なめらかに）
  const w = Math.max(1, Math.round(W / SCALE)); const h = Math.max(1, Math.round(H / SCALE));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const sx = ctx2d(s, { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(c, 0, 0, w, h);
  c.width = 0; c.height = 0;
  const img = sx.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }); s.width = 0; s.height = 0;
  const worker = new Worker(new URL('./restoration-worker.js', import.meta.url), { type: 'module' });
  try {
    const r = await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'progress') onProgress(0.3 + 0.7 * m.t);
        else if (m.type === 'result') { signal?.removeEventListener('abort', onAbort); resolve(m.bokeh); } else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker'));
      worker.postMessage({ type: 'bokeh', rgba: img.data, w, h, person: { m: person.m, w: person.w, h: person.h }, face: face && { m: face.m, w: face.w, h: face.h } }, [img.data.buffer]);
    });
    onProgress(1);
    return r;
  } finally { worker.terminate(); }
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
