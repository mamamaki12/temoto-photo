// 髪・服をくっきり（crisp.js）を、編集用の大きさの写真（Canvas）と書き出しに当てる（DOM・Worker を使う側）
import { SCALE } from './bokeh.js';
import { crispWeights, applyDetailMap } from './crisp.js';
import { smallPixels } from './restoration-photo.js';
import { personSeg, segParts } from './skinseg.js';
import { COLOR_SPACE, ctx2d } from './color.js';

const later = () => new Promise((r) => setTimeout(r, 0));
const abortError = () => new DOMException('処理を中止しました', 'AbortError');

/**
 * 重みの地図（4 分の 1 の大きさ）。人物は AI（personSeg）で見分け、Worker で輪郭に沿わせる。肌は部位分け（segParts）で弱める。
 * AI が使えない端末では、人物が分からないので null（全体に同じ重みで足す）
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}|null>}
 */
export async function crispMapFor(image, W, H, { signal } = {}) {
  if (signal?.aborted) throw abortError();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const small = smallPixels(c, W, H);
  const person = await personSeg(small);
  if (signal?.aborted) throw abortError();
  if (!person) { c.width = 0; c.height = 0; return null; }
  const parts = await segParts({ width: small.width, height: small.height, data: small.data });
  if (signal?.aborted) throw abortError();
  const w = Math.max(1, Math.round(W / SCALE)); const h = Math.max(1, Math.round(H / SCALE));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const sx = ctx2d(s, { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(c, 0, 0, w, h);
  c.width = 0; c.height = 0;
  const img = sx.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }); s.width = 0; s.height = 0;
  const worker = new Worker(new URL('./restoration-worker.js', import.meta.url), { type: 'module' });
  try {
    const alpha = await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'result') { signal?.removeEventListener('abort', onAbort); resolve(m.alpha); } else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker'));
      worker.postMessage({ type: 'alpha', rgba: img.data, w, h, person: { m: person.m, w: person.w, h: person.h } }, [img.data.buffer]);
    });
    return { width: w, height: h, data: crispWeights(alpha, w, h, parts) };
  } finally { worker.terminate(); }
}

/** 編集用の大きさの写真に、全体 AI の差分を重みの地図で足した新しい Canvas */
export async function crispCanvas(image, W, H, res, map, amount) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y); const d = x.getImageData(0, y, W, n, { colorSpace: COLOR_SPACE });
    applyDetailMap(d.data, n, { y0: y, fullW: W, fullH: H }, res, map, amount);
    x.putImageData(d, 0, y);
    await later();
  }
  return c;
}

/**
 * 書き出し（元の大きさ）: 編集用の大きさで求めた差分と重みの地図を、引き伸ばして写真全体に足す（帯ごとに読み書き）
 * read(x, y, w, h) → RGBA、write(x, y, w, h, RGBA)
 */
export async function mergeCrispFull(read, write, res, map, amount, W, H) {
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y); const data = read(0, y, W, n);
    applyDetailMap(data, n, { y0: y, fullW: W, fullH: H }, res, map, amount);
    write(0, y, W, n, data);
    await later();
  }
}
