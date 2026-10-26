// 顔専用 AI（編集画面の「おまかせ → 顔 AI」）を、写真（Canvas）に当てる。計算は faceai.js、AI は face-worker.js で。
// 暗い写真・ブレの大きい写真で、選んだ顔だけに当てる（明るい写真は、今までの歯・目元の道具で十分なので、自動では使わない）。
// 順番は「ノイズ除去 → 明るさ → ブレ補正 → 細かい粒 →（全体 AI）→ 顔 AI」。全体 AI（wholeai.js）は髪・服・背景の細かい所を整え、顔だけ浮かないようにする。顔 AI は大まかな形と色を変えず、いちばん細かい粒も残すので、粒の後でよい。
// AI は編集用の大きさの写真で 1 回だけ動かし、書き出しでは、その結果を元の大きさの写真に当て直す（mergeFace は大きさによらない）
import { SIZE, alignMatrix, applyMatrix, cropFace, faceMask, faceRegion, hairMask, mergeFace } from './faceai.js';
import { addDetail, applyDetail } from './wholeai.js';
import { faceMeshes, findAllFaces, fingerprint, releaseSkinSeg, segParts } from './skinseg.js';
import { releaseDeblur } from './deblur-photo.js';
import { getPeople, putPeople } from './db.js';
import { COLOR_SPACE, ctx2d, imageData } from './color.js';

/** この編集で、顔 AI を使うか */
export const faceaiActive = (st) => !!st.faceai?.faces?.some((f) => f.on);
/** 強さ（0〜1） */
export const faceaiAmount = (st) => (st.faceai?.amount ?? 100) / 100;
/** 顔 AI と一緒に、髪・服・背景も全体 AI で整えるか（顔だけくっきりして、まわりとの差が目立たないように。はじめは使う） */
export const faceaiWhole = (st) => faceaiActive(st) && st.faceai.whole !== false;

const abortError = () => new DOMException('処理を中止しました', 'AbortError');
const later = () => new Promise((r) => setTimeout(r, 0));

// ───── 本人の写真（人ごと。IndexedDB に保存して、ほかの写真でも使う） ─────
let people = null; let peopleRev = 0;
/** 人の一覧（読み込んで覚えておく） */
export async function loadPeople() { if (!people) people = await getPeople().catch(() => []); return people; }
/** 人の一覧を保存する（本人の写真が変わると、顔 AI を計算し直す） */
export async function savePeople(list) { people = list; peopleRev++; await putPeople(list); }
/** 顔 AI の結果を決めるもの（編集内容と、使う人の本人の写真）。これが変わったら計算し直す */
export function faceaiKey(st) {
  if (!faceaiActive(st)) return null;
  const used = st.faceai.faces.filter((f) => f.on);
  return JSON.stringify([used.map((f) => [f.x, f.y, f.person || '', (people || []).find((p) => p.id === f.person)?.refs.map((r) => r.id) || []]), peopleRev]);
}

/** Blob・File の写真 → ImageData（向きは写真のとおり。長い辺 maxSide まで） */
async function decode(blob, maxSide = 4096) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)); const h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = ctx2d(c, { willReadFrequently: true }); x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  const d = x.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }); c.width = 0; c.height = 0;
  return d;
}
/** 512 の RGB（Float32）→ ImageData */
function toImageData(rgb) {
  const n = SIZE * SIZE; const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { d[i * 4] = rgb[i * 3]; d[i * 4 + 1] = rgb[i * 3 + 1]; d[i * 4 + 2] = rgb[i * 3 + 2]; d[i * 4 + 3] = 255; }
  return imageData(d, SIZE, SIZE);
}
function toRGB(img) {
  const n = img.width * img.height; const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = img.data[i * 4]; out[i * 3 + 1] = img.data[i * 4 + 1]; out[i * 3 + 2] = img.data[i * 4 + 2]; }
  return out;
}

/**
 * 顔を 512 に切り出し、切り出した顔の上で顔の点を測り直す（写真全体で測った点より正確。本人の写真と重ねるのに使う）
 * @returns {Promise<{M:number[],crop:Float32Array,pts:number[][]}>}
 */
async function prepare(img, pts) {
  const M = alignMatrix(pts); const crop = cropFace(img, M);
  let p512 = null;
  try {
    const found = await faceMeshes(toImageData(crop));
    let best = Infinity;
    for (const f of found) { const d = Math.hypot(f[4][0] - SIZE / 2, f[4][1] - SIZE * 0.6); if (d < best) { best = d; p512 = f; } }
  } catch (e) { console.warn('切り出した顔の点を測れませんでした', e); }
  if (!p512) p512 = pts.map(([x, y]) => applyMatrix(M, x, y));
  return { M, crop, pts: p512 };
}

const faceStore = new Map(); // 写真の指紋 → 見つけた顔
/**
 * 写真（ImageData）の中の顔を見つける。[{ pts（写真の画素の座標）, x, y（鼻先。0〜1）, w（顔の幅。写真の幅に対する割合） }]
 */
export async function detectFaces(img, { onProgress } = {}) {
  const key = fingerprint(img); if (faceStore.has(key)) return faceStore.get(key);
  const faces = (await findAllFaces(img, { onProgress })).map((pts) => ({ pts, x: pts[4][0] / img.width, y: pts[4][1] / img.height, w: Math.hypot(pts[454][0] - pts[234][0], pts[454][1] - pts[234][1]) / img.width }));
  faceStore.set(key, faces); if (faceStore.size > 6) faceStore.delete(faceStore.keys().next().value);
  return faces;
}
/** 見つけた顔のうち、編集内容の顔（鼻先の位置）に当たるもの */
export function matchFace(faces, f) {
  let best = null; let bd = Infinity;
  for (const g of faces) { const d = Math.hypot(g.x - f.x, g.y - f.y); if (d < Math.max(g.w * 0.4, 0.01) && d < bd) { bd = d; best = g; } }
  return best;
}
/** 顔の小さな絵（パネルに並べる）。写真（Canvas など）から切り出す */
export function faceThumb(src, W, H, face, size = 96) {
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const s = face.w * W * 1.5; const cx = face.x * W; const cy = face.y * H - s * 0.1;
  const x = ctx2d(c); x.imageSmoothingQuality = 'high'; x.drawImage(src, cx - s / 2, cy - s / 2, s, s, 0, 0, size, size);
  return c;
}

/**
 * 本人の写真（ファイル）から、写っている顔を切り出す。顔が複数あれば全部（どれが本人かは画面で選んでもらう）
 * @returns {Promise<{crop:Blob,pts:number[],url:string}[]>} crop: 512 の PNG、pts: 顔の点（x, y の順）、url: 見せる用
 */
export async function facesFromPhoto(file) {
  const img = await decode(file);
  const found = await findAllFaces(img, { minFace: 120 });
  const out = [];
  for (const pts of found.slice(0, 8)) {
    const p = await prepare(img, pts);
    const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE; ctx2d(c).putImageData(toImageData(p.crop), 0, 0);
    const crop = await new Promise((r) => c.toBlob(r, 'image/png'));
    out.push({ crop, pts: p.pts.flat(), url: URL.createObjectURL(crop) });
  }
  return out;
}
const refCache = new WeakMap(); // 本人の写真の Blob → { img, pts }
async function loadRef(r) {
  if (!refCache.has(r.crop)) {
    const d = await decode(r.crop, SIZE);
    const pts = []; for (let i = 0; i + 1 < r.pts.length; i += 2) pts.push([r.pts[i], r.pts[i + 1]]);
    refCache.set(r.crop, { img: toRGB(d), pts });
  }
  return refCache.get(r.crop);
}

/** Worker からの失敗を、使う人に分かる言葉にする（err.friendly: そのまま見せてよい文） */
function friendly(code) {
  const text = {
    DOWNLOAD: '顔 AI のダウンロード（はじめてだけ約 90MB）が途中で切れました。電波のよい所か Wi-Fi で、もう一度試してください。ダウンロードできた所は、次は続きから読み込みます',
    MEMORY: '端末のメモリが足りず、顔 AI を動かせませんでした。ほかのアプリやタブを閉じてから、もう一度試してください',
  }[code];
  return Object.assign(new Error(text || code), { friendly: !!text });
}

let worker = null; // AI を読み込んだ Worker（使い終わったら片付ける。2 回目からは端末に保存したものを読むので、数秒で読み込める）
function runWorker(faces, { onProgress, signal }) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!worker) worker = new Worker(new URL('./face-worker.js', import.meta.url), { type: 'module' });
  const wk = worker;
  return new Promise((resolve, reject) => {
    const done = (err, res) => {
      wk.onmessage = null; wk.onerror = null; signal?.removeEventListener('abort', onAbort);
      if (err) { wk.terminate(); if (worker === wk) worker = null; reject(err); } else resolve(res);
    };
    const onAbort = () => done(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    wk.onmessage = ({ data: m }) => {
      if (m.type === 'progress') onProgress(m.phase === 'load' ? 0.3 * m.t : 0.3 + 0.7 * m.t);
      else if (m.type === 'result') done(null, m.outs);
      else if (m.type === 'error') done(friendly(m.message));
    };
    wk.onerror = () => done(friendly('MEMORY'));
    wk.postMessage({ type: 'run', faces }, faces.flatMap((f) => [f.crop.buffer]));
  });
}

/**
 * 写真（Canvas、編集用の大きさ）の、選んだ顔に AI を当てる
 * @param {object} faceai 編集内容の faceai（{ faces: [{ x, y, on, person }], amount }）
 * @returns {Promise<{canvas:HTMLCanvasElement, faces:{M:number[],out:Float32Array,mask:Float32Array}[]}>} faces: 書き出しでも使う結果
 */
export async function applyFaceAI(image, W, H, faceai, { signal, onProgress = () => {} } = {}) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const img = x.getImageData(0, 0, W, H, { colorSpace: COLOR_SPACE });
  const dets = await detectFaces(img, { onProgress: (t) => onProgress(0.1 * t) });
  if (signal?.aborted) throw abortError();
  const list = await loadPeople();
  const jobs = []; const prepared = [];
  for (const f of faceai.faces) {
    if (!f.on) continue;
    const g = matchFace(dets, f); if (!g) continue;
    const p = await prepare(img, g.pts);
    p.seg = await segParts(toImageData(p.crop)); // 切り出した顔の髪（AI の髪も当てる。hairMask）
    const refs = [];
    for (const r of list.find((q) => q.id === f.person)?.refs || []) refs.push(await loadRef(r));
    prepared.push(p); jobs.push({ crop: Float32Array.from(p.crop), pts: p.pts, refs });
  }
  if (!jobs.length) { onProgress(1); return { canvas: c, faces: [] }; }
  onProgress(0.12);
  // 顔専用 AI は大きい（読み込むと数百 MB）。スマホでページごと落とされないよう、ほかの AI を片付けてから動かし、終わったら AI も片付ける
  releaseDeblur(); releaseSkinSeg();
  let outs;
  try { outs = await runWorker(jobs, { signal, onProgress: (t) => onProgress(0.12 + 0.83 * t) }); } finally { worker?.terminate(); worker = null; }
  const faces = prepared.map((p, k) => ({ M: p.M, out: outs[k], mask: hairMask(faceMask(p.pts), p.seg) }));
  mergeFacesCanvas(x, W, H, faces, faceaiAmount({ faceai }));
  onProgress(1);
  return { canvas: c, faces };
}
let wholeWorker = null;
/**
 * 写真（Canvas、編集用の大きさ）の全体を全体 AI に通して、足す差分を求める（顔 AI の前に。顔は、そのあと顔 AI で置き換わる）
 * @returns {Promise<{width:number,height:number,data:Int8Array}>} 足す差分（wholeCanvas で当てる。書き出しでも使う）
 */
export async function wholeResidual(image, W, H, { signal, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw abortError();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const img = x.getImageData(0, 0, W, H, { colorSpace: COLOR_SPACE }); c.width = 0; c.height = 0;
  // 大きな AI を同時に抱えないよう、ブレ補正の AI は片付けておく（全体 AI は 5MB と小さく、終わったら片付ける）
  releaseDeblur();
  wholeWorker = new Worker(new URL('./whole-worker.js', import.meta.url), { type: 'module' });
  const wk = wholeWorker;
  try {
    const r = await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      wk.onmessage = ({ data: m }) => {
        if (m.type === 'progress') onProgress(m.phase === 'load' ? 0.05 * m.t : 0.05 + 0.95 * m.t);
        else if (m.type === 'result') { signal?.removeEventListener('abort', onAbort); resolve(m); } else if (m.type === 'error') reject(new Error(m.message));
      };
      wk.onerror = () => reject(friendly('MEMORY'));
      wk.postMessage({ type: 'run', img: img.data, W, H }, [img.data.buffer]);
    });
    onProgress(1);
    return { width: W, height: H, data: r.res };
  } finally { wk.terminate(); if (wholeWorker === wk) wholeWorker = null; }
}
/** 写真（編集用の大きさ）に全体 AI の差分を足して、新しい Canvas を返す（帯ごとに。差分だけを取っておき、Canvas は取っておかない） */
export async function wholeCanvas(image, W, H, res) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y); const d = x.getImageData(0, y, W, n, { colorSpace: COLOR_SPACE });
    addDetail(d.data, res.data.subarray(y * W * 3, (y + n) * W * 3));
    x.putImageData(d, 0, y);
    await later();
  }
  return c;
}
/**
 * 書き出し（元の大きさ）: 編集用の大きさで求めた全体 AI の差分を、引き伸ばして写真全体に足す（帯ごとに読み書き）
 * read(x, y, w, h) → RGBA、write(x, y, w, h, RGBA)
 */
export async function mergeWholeFull(read, write, res, W, H) {
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y); const data = read(0, y, W, n);
    applyDetail(data, n, { y0: y, fullW: W, fullH: H }, res);
    write(0, y, W, n, data);
    await later();
  }
}
/** Canvas（2D）の、顔のまわりだけを読み出して結果を当てる */
function mergeFacesCanvas(x, W, H, faces, amount) {
  for (const f of faces) {
    const r = faceRegion(f.M, W, H); if (!r) continue;
    const d = x.getImageData(r[0], r[1], r[2], r[3], { colorSpace: COLOR_SPACE });
    mergeFace(d, r[0], r[1], f, amount);
    x.putImageData(d, r[0], r[1]);
  }
}
/**
 * 書き出し（元の大きさ）: 編集用の大きさで求めた結果を、k 倍の大きさの写真に当てる。
 * read(x, y, w, h) → RGBA、write(x, y, w, h, RGBA)（GPU に送った写真の一部の読み書き）
 */
export async function mergeFacesFull(read, write, faces, W, H, k, amount) {
  for (const f of faces) {
    const g = { ...f, M: [f.M[0] / k, f.M[1] / k, f.M[2], f.M[3]] };
    const r = faceRegion(g.M, W, H); if (!r) continue;
    const data = read(r[0], r[1], r[2], r[3]);
    mergeFace({ data, width: r[2], height: r[3] }, r[0], r[1], g, amount);
    write(r[0], r[1], r[2], r[3], data);
    await later();
  }
}
