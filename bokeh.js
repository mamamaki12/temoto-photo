// 背景をぼかす（プロの舞台写真のような、人物だけくっきりで背景がやわらかいボケ）。
// 仕組み（docs/bokeh-handoff.md）:
//   ① 人物の地図（skinseg.js の personSeg。長い辺 512）を 4 分の 1 の大きさの写真に合わせ、ガイデッドフィルターで髪・輪郭に沿わせる
//   ② 少し広げて（髪の縁が背景のぼかしに混ざらないよう）、人物の割合 a（0〜1）にする。
//      奥行きの AI（depth-worker.js）が使えれば、人物と同じくらい近い所も人物として扱う（人物の AI は、透けたフリル・写真の端で切れた脚・足元を見落とす）
//   ③ 背景だけを円形にぼかす（人物の画素を重みから外す「正規化ぼかし」なので、人物の色が背景ににじまない）。
//      明るい照明が丸く光るよう、ガンマを外した（リニアに近い）値でぼかす
//   ④ 元の写真 × a ＋ ぼかした背景 × (1 − a)。編集用の大きさでも、書き出し（元の大きさ）でも同じ ②③ を引き伸ばして合成する
// DOM を使わない（Worker と Node のテストで動く）。
import { boxBlur, guided } from './restoration-lowlight.js';

/** 縮めて計算する倍率（4 分の 1） */
export const SCALE = 4;
const GUIDE_R = 8; // 地図を輪郭に沿わせる範囲（縮めた画素）
const GUIDE_EPS = 1e-3;
const FEATHER = 2; // 縁をなだらかにする範囲（縮めた画素。boxBlur 2 回 ≈ ガウス 1.5）
const GROW = 1.15; // 人物を少し広げる
const GAMMA = 2.2;
/** 奥行きの AI の大きさ（正方形。depth-worker.js） */
export const DEPTH_SIDE = 518;
// 奥行きで人物として扱う近さ: 背景（人物の AI が背景とした所の真ん中の近さ）から、人物の奥の方（人物の近さの 1 割点）までの間の、
// NEAR_LO 〜 NEAR_HI の所でなだらかに 0 → 1（背景の下の方・床は奥の幕より近いので、人物の近さの手前ぎりぎりから。0.4 からにすると、脚の横の幕までぼけずに残った）。人物と背景の近さの差が DEPTH_MIN より小さい（壁の前など）写真では使わない
const NEAR_LO = 0.85; const NEAR_HI = 1; const DEPTH_MIN = 0.08;
const DEPTH_GROW = 2; // 縁で切れないよう、少し広げる（縮めた画素）

/** この編集で、背景のぼかしを使うか（オン／オフだけ。強さは写真ごとに autoRadius で決める） */
export const bokehActive = (adj) => (adj.bokeh || 0) > 0;

/**
 * 顔の大きさ（いちばん大きい顔の肌のかたまりの √面積 ÷ 写真の長い辺）。顔が見つからなければ 0
 * @param {{m:Float32Array,w:number,h:number}|null} face 顔の肌の地図（skinseg.js の faceSeg）
 */
export function faceScale(face) {
  if (!face) return 0;
  const { m, w, h } = face; const seen = new Uint8Array(w * h); const stack = new Int32Array(w * h); let best = 0;
  for (let i0 = 0; i0 < w * h; i0++) {
    if (seen[i0] || m[i0] < 0.5) continue;
    let n = 0; let sp = 0; stack[sp++] = i0; seen[i0] = 1;
    while (sp) {
      const i = stack[--sp]; n++; const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < w * h && !seen[j] && m[j] >= 0.5) { seen[j] = 1; stack[sp++] = j; }
    }
    best = Math.max(best, n);
  }
  return Math.sqrt(best) / Math.max(w, h);
}

/** 自動の強さ: 顔の大きさに比べて、ぼかしの半径をどのくらいにするか（望遠・明るいレンズで撮ったプロの写真に合わせた） */
const FACE_K = 0.25;
const MIN_R = 0.006; const MAX_R = 0.035; // 長い辺に対する割合

/**
 * 写真ごとのぼかしの半径（縮めた画素。長い辺 L に対して）。大きく写った人（近い・望遠）ほど背景のボケは大きく、集合写真のように小さく写った人では控えめ
 * （レンズのボケは、背景が遠ければ、写った顔の大きさに比例する）。顔が見つからなければ人物の大きさから（顔 ≈ 人物の 2 割）。
 * 舞台の写真（顔 0.06〜0.09）で 1.30 のスライダー 50 と同じくらい、顔アップ（0.13〜0.17）で上限、集合写真（0.05）で 7 割くらいになる
 * @param {{m:Float32Array,w:number,h:number}|null} face 顔の肌の地図（skinseg.js の faceSeg）
 * @param {{m:Float32Array,w:number,h:number}|null} person 人物の地図（personSeg）
 */
export function autoRadius(L, face, person = null) {
  let fs = faceScale(face);
  if (!fs && person) { let a = 0; for (let i = 0; i < person.m.length; i++) a += person.m[i] > 0.5 ? 1 : 0; fs = 0.2 * Math.sqrt(a) / Math.max(person.w, person.h); }
  const r = L * Math.min(MAX_R, Math.max(MIN_R, FACE_K * fs));
  return { r: Math.max(1, Math.round(r)), face: fs };
}

/** 小さな地図（w0×h0、0〜1）を w×h に引き伸ばす（双一次） */
export function resizeMap(m, w0, h0, w, h) {
  const out = new Float32Array(w * h); const sx = w0 / w; const sy = h0 / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(h0 - 1, Math.max(0, (y + 0.5) * sy - 0.5)); const ya = Math.floor(fy); const yb = Math.min(h0 - 1, ya + 1); const ty = fy - ya;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(w0 - 1, Math.max(0, (x + 0.5) * sx - 0.5)); const xa = Math.floor(fx); const xb = Math.min(w0 - 1, xa + 1); const tx = fx - xa;
      const t = m[ya * w0 + xa] + (m[ya * w0 + xb] - m[ya * w0 + xa]) * tx;
      out[y * w + x] = t + (m[yb * w0 + xa] + (m[yb * w0 + xb] - m[yb * w0 + xa]) * tx - t) * ty;
    }
  }
  return out;
}

/**
 * 人物の割合の地図を、縮めた写真に合わせて細かくする（①②）
 * @param {Uint8ClampedArray} rgba 縮めた写真（w×h）
 * @param {{m:Float32Array,w:number,h:number}|null} person 人物の地図（なければ null → 全部背景）
 * @param {{m:Float32Array,w:number,h:number}|null} depth 奥行きの地図（なければ null → 人物の地図だけ）
 * @returns {Float32Array} w×h、0〜1（1 = 人物）
 */
export function personAlpha(rgba, w, h, person, depth = null) {
  if (!person) return new Float32Array(w * h);
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) / 255;
  const m = resizeMap(person.m, person.w, person.h, w, h);
  const g = guided(luma, m, w, h, GUIDE_R, GUIDE_EPS);
  const tmp = new Float32Array(w * h); const a = boxBlur(g, w, h, FEATHER, new Float32Array(w * h), tmp);
  boxBlur(a, w, h, FEATHER, g, tmp);
  for (let i = 0; i < w * h; i++) g[i] = Math.min(1, Math.max(0, g[i] * GROW));
  const near = depth && nearAlpha(luma, w, h, m, depth);
  if (near) for (let i = 0; i < w * h; i++) g[i] = Math.max(g[i], near[i]);
  return g;
}

/** 並べた値の p の点（0〜1） */
function quantile(v, p) { const s = Float32Array.from(v).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; }

/** 横・縦に r ずつ広げる（その範囲の最大） */
function grow(src, w, h, r) {
  const t = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = Math.max(v, src[y * w + k]); t[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = Math.max(v, t[k * w + x]); out[y * w + x] = v; }
  return out;
}

/**
 * 奥行きの地図から、人物と同じくらい近い所の割合（0〜1。縮めた写真の大きさ）。人物・背景の近さが分からない写真では null
 * @param {Float32Array} luma 縮めた写真の明るさ（輪郭に沿わせる）
 * @param {Float32Array} m 人物の AI の地図（縮めた写真の大きさ）
 * @param {{m:Float32Array,w:number,h:number}} depth 奥行き（0〜1、大きいほど手前）
 */
export function nearAlpha(luma, w, h, m, depth) {
  const d = resizeMap(depth.m, depth.w, depth.h, w, h);
  const fg = []; const bg = [];
  for (let i = 0; i < w * h; i++) { if (m[i] > 0.8) fg.push(d[i]); else if (m[i] < 0.2) bg.push(d[i]); }
  if (fg.length < 0.005 * w * h || bg.length < 0.1 * w * h) return null;
  const lo = quantile(fg, 0.1); const far = quantile(bg, 0.5); const gap = lo - far;
  if (gap < DEPTH_MIN) return null;
  const t0 = far + NEAR_LO * gap; const t1 = far + NEAR_HI * gap; const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const t = Math.min(1, Math.max(0, (d[i] - t0) / (t1 - t0))); a[i] = t * t * (3 - 2 * t); }
  const g = guided(luma, grow(a, w, h, DEPTH_GROW), w, h, 4, GUIDE_EPS);
  for (let i = 0; i < w * h; i++) g[i] = Math.min(1, Math.max(0, g[i]));
  return g;
}

/**
 * 円形のぼかし（半径 r）。各行の累積和を使い、円の 1 行ごとに横の区間の和を足す（画素あたり 2r+1 回。端は、範囲に入る所だけで）。
 * 割る数は呼び出し側で（重みの地図も同じ関数でぼかして割る）
 */
export function discSum(src, w, h, r, out = new Float32Array(w * h)) {
  const pre = new Float64Array((w + 1) * h);
  for (let y = 0; y < h; y++) { let s = 0; const o = y * (w + 1); pre[o] = 0; for (let x = 0; x < w; x++) { s += src[y * w + x]; pre[o + x + 1] = s; } }
  const half = new Int32Array(2 * r + 1);
  for (let dy = -r; dy <= r; dy++) half[dy + r] = Math.floor(Math.sqrt(r * r - dy * dy));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r); const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const hx = half[yy - y + r]; const o = yy * (w + 1);
        s += pre[o + Math.min(w, x + hx + 1)] - pre[o + Math.max(0, x - hx)];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

/**
 * 背景のぼかし（③）。縮めた写真（4 分の 1）で計算する
 * @param {Uint8ClampedArray} rgba 縮めた写真（w×h）
 * @param {Float32Array} alpha 人物の割合（w×h）
 * @param {number} r ぼかしの半径（縮めた画素）
 * @returns {{width:number,height:number,bg:Uint8ClampedArray,alpha:Uint8ClampedArray}} bg: ぼかした背景（RGB）、alpha: 人物の割合（0〜255）
 */
export function computeBokeh(rgba, w, h, alpha, r, onProgress = () => {}) {
  const n = w * h; const lin = new Float32Array(256);
  for (let v = 0; v < 256; v++) lin[v] = (v / 255) ** GAMMA;
  const wgt = new Float32Array(n); for (let i = 0; i < n; i++) wgt[i] = 1 - alpha[i];
  const den = discSum(wgt, w, h, r); onProgress(0.25);
  const bg = new Uint8ClampedArray(n * 3); const ch = new Float32Array(n); const blurred = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) ch[i] = lin[rgba[i * 4 + c]] * wgt[i];
    discSum(ch, w, h, r, blurred);
    // 人物の内側の奥（重みがほぼ 0 の所）は、元の色のまま（合成では使わない）
    for (let i = 0; i < n; i++) bg[i * 3 + c] = den[i] > 1e-3 ? Math.round(255 * Math.min(1, Math.max(0, blurred[i] / den[i])) ** (1 / GAMMA)) : rgba[i * 4 + c];
    onProgress(0.25 + 0.25 * (c + 1));
  }
  const a8 = new Uint8ClampedArray(n); for (let i = 0; i < n; i++) a8[i] = Math.round(alpha[i] * 255);
  return { width: w, height: h, bg, alpha: a8 };
}

/**
 * 合成（④）: 写真の何行か（RGBA、横幅いっぱい）に、引き伸ばした（双一次）背景を人物の割合で混ぜる。
 * 編集用の大きさ（wholeai.js の applyDetail と同じ形）でも、書き出しの元の大きさでも使う
 * @param {{y0:number,fullW:number,fullH:number}} at この行の、写真の中の位置と、写真の大きさ
 */
export function applyBokeh(data, rows, at, bk) {
  const { fullW: FW, fullH: FH } = at; const { width: w, height: h, bg, alpha } = bk;
  const sx = w / FW; const sy = h / FH;
  for (let y = 0; y < rows; y++) {
    const fy = Math.min(h - 1, Math.max(0, (at.y0 + y + 0.5) * sy - 0.5)); const ya = Math.floor(fy); const yb = Math.min(h - 1, ya + 1); const ty = fy - ya;
    for (let x = 0; x < FW; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5)); const xa = Math.floor(fx); const xb = Math.min(w - 1, xa + 1); const tx = fx - xa;
      const a = ya * w + xa; const b = ya * w + xb; const c = yb * w + xa; const d = yb * w + xb;
      const ta = alpha[a] + (alpha[b] - alpha[a]) * tx; const al = (ta + (alpha[c] + (alpha[d] - alpha[c]) * tx - ta) * ty) / 255;
      if (al >= 0.999) continue;
      const i = (y * FW + x) * 4;
      for (let k = 0; k < 3; k++) {
        const t = bg[a * 3 + k] + (bg[b * 3 + k] - bg[a * 3 + k]) * tx; const v = t + (bg[c * 3 + k] + (bg[d * 3 + k] - bg[c * 3 + k]) * tx - t) * ty;
        data[i + k] = Math.round(data[i + k] * al + v * (1 - al));
      }
    }
  }
  return data;
}
