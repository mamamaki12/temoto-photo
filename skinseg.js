// 人物の肌（顔・首・腕・手）を、AI（MediaPipe の人物の部位分け）で見分ける。端末の中だけで動く（vendor/mediapipe/）。
// 美肌は、色で決めた肌らしさにこの結果を掛けて、髪・服・背景（肌に似た色の壁・カーディガンなど）を外す。
// 結果は、写真（編集用の大きさの画素）の指紋ごとに覚えておき、美肌の計算（同期）から取り出す。
const MAX_SIDE = 768; // AI に渡す大きさ（モデルの中は 256×256。輪郭は渡した大きさで返る）
let worker = null; let seq = 0; const waiting = new Map();
const store = new Map(); // 指紋 → { m, w, h }

/** 画像の指紋（大きさと、まばらに選んだ画素） */
export function fingerprint(img) {
  const { width: W, height: H, data: d } = img; let h = (W * 73856093) ^ (H * 19349663);
  for (let i = 0; i < 97; i++) { const x = Math.floor(((i * 37) % 97) / 97 * W); const y = Math.floor(i / 97 * H); const k = (y * W + x) * 4; h = Math.imul(h ^ (d[k] | (d[k + 1] << 8) | (d[k + 2] << 16)), 16777619); }
  return `${W}x${H}:${h >>> 0}`;
}
/** 覚えている肌の地図（なければ null） */
export const skinSegFor = (img) => store.get(fingerprint(img)) || null;

const TIMEOUT = 90000; // これより長く返事がなければ、AI をあきらめる（端末のメモリが足りず Worker が止まったときなど。色で判定する）
function stopWorker(why) {
  worker?.terminate(); worker = null;
  for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error(why)); }
  waiting.clear();
}
function call(msg, transfer) {
  if (!worker) {
    worker = new Worker(new URL('vendor/mediapipe/seg-worker.js', import.meta.url));
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); clearTimeout(w.timer); if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data); };
    worker.onerror = (e) => stopWorker(e.message || 'worker error');
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, timer: setTimeout(() => stopWorker('AI の返事がありません'), TIMEOUT) });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

/**
 * 写真の肌の地図を作って覚える（すでにあれば何もしない）。img: 編集用の大きさの画素（ImageData など）
 * @returns {Promise<boolean>} 使えるようになったか（読み込めない端末では false。そのときは色だけで判定する）
 */
export async function ensureSkinSeg(img) {
  const key = fingerprint(img); if (store.has(key)) return true;
  try {
    const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
    const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, w, h);
    const small = x2.getImageData(0, 0, w, h);
    const r = await call({ kind: 'skin', w, h, data: small.data }, [small.data.buffer]);
    store.set(key, { m: r.skin, w: r.w, h: r.h });
    if (store.size > 8) store.delete(store.keys().next().value);
    return true;
  } catch (e) { console.warn('人物の肌を見分ける AI を使えませんでした（色だけで判定します）', e); return false; }
}

/** 地図の値（双一次補間）。u, v は写真全体に対する 0〜1 */
export function segAt(seg, u, v) {
  const fx = Math.min(seg.w - 1, Math.max(0, u * seg.w - 0.5)); const fy = Math.min(seg.h - 1, Math.max(0, v * seg.h - 0.5));
  const x0 = fx | 0; const y0 = fy | 0; const x1 = Math.min(seg.w - 1, x0 + 1); const y1 = Math.min(seg.h - 1, y0 + 1); const tx = fx - x0; const ty = fy - y0; const m = seg.m;
  const a = m[y0 * seg.w + x0] + (m[y0 * seg.w + x1] - m[y0 * seg.w + x0]) * tx; const b = m[y1 * seg.w + x0] + (m[y1 * seg.w + x1] - m[y1 * seg.w + x0]) * tx;
  return a + (b - a) * ty;
}

const lipStore = new Map(); // 指紋 → 唇の輪郭の一覧
/**
 * 写真の中の顔ごとの唇の輪郭（外側・内側。写真全体に対する 0〜1 の座標）を AI で見つける。見つからなければ []、使えなければ null
 */
export async function findLips(img) {
  const key = fingerprint(img); if (lipStore.has(key)) return lipStore.get(key);
  try {
    const s = Math.min(1, 1280 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
    const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, w, h);
    const small = x2.getImageData(0, 0, w, h);
    const r = await call({ kind: 'lips', w, h, data: small.data }, [small.data.buffer]);
    lipStore.set(key, r.lips); if (lipStore.size > 8) lipStore.delete(lipStore.keys().next().value);
    return r.lips;
  } catch (e) { console.warn('唇を見つける AI を使えませんでした（色で判定します）', e); return null; }
}
