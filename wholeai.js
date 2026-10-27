// 全体 AI（顔 AI と一緒に使う。髪・服・背景の細かい所を AI で整え、AI で整えた顔とまわりの差をなくす）の計算。DOM なし。
// AI は Real-ESRGAN の小さいもの（realesr-general-x4v3、約 5MB。4 倍に大きくしながら、ぼけ・ノイズを直す）。
// 流れ:
//   ① 写真（編集用の大きさ）を 4 分の 1 に縮めて（smallFrom）、区画（tiles）ごとに AI に通す → 元の大きさの、くっきりした絵
//   ② 写真に戻すときは、顔 AI と同じく、大まかな形と色（ぼかし SPLIT より大きいもの）といちばん細かい粒は写真のまま、
//      その間の細かさだけ AI のものに入れ替える（tileResidual）。AI がまるごと描き直すと、肌がつるつるになり、絵のように見えるため
//   ③ 入れ替える差分は 8bit で取っておき（Int8Array、1 = 1/255）、書き出しでは元の大きさの写真に引き伸ばして足す（applyDetail）
import { gauss } from './faceai.js';

/** AI に渡す前に縮める割合（AI が 4 倍にして返す） */
export const SCALE = 4;
/** 区画の大きさ（縮めた絵の画素）と、まわりののりしろ（区画の境目が見えないように。4 倍で 32 画素 = 下のぼかしより広い） */
export const TILE = 128;
export const PAD = 8;
/** AI に渡す 1 つの区画の一辺 */
export const TILE_IN = TILE + PAD * 2;
/** 大まかな形と細かい所を分けるぼかし（写真の画素）。顔 AI（512 で 3、写真では 4〜5 画素くらい）とそろえる */
export const SPLIT = 4;

/**
 * 写真（RGBA）を 4 分の 1 に縮める（4×4 の平均。端は、ある画素だけで）。返すのは RGB の Float32Array（0〜1）
 * @returns {{width:number,height:number,data:Float32Array}}
 */
export function smallFrom(data, W, H) {
  const w = Math.ceil(W / SCALE); const h = Math.ceil(H / SCALE); const out = new Float32Array(w * h * 3); const cnt = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    const o = Math.floor(y / SCALE) * w;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4; const j = o + Math.floor(x / SCALE);
      out[j * 3] += data[i]; out[j * 3 + 1] += data[i + 1]; out[j * 3 + 2] += data[i + 2]; cnt[j]++;
    }
  }
  for (let j = 0; j < w * h; j++) { const k = 1 / (255 * cnt[j]); out[j * 3] *= k; out[j * 3 + 1] *= k; out[j * 3 + 2] *= k; }
  return { width: w, height: h, data: out };
}

/** 区画の左上（縮めた絵の画素）の一覧 */
export function tiles(w, h) {
  const out = [];
  for (let y = 0; y < h; y += TILE) for (let x = 0; x < w; x += TILE) out.push([x, y]);
  return out;
}

/** 区画（のりしろ込み）を、AI の入力（RGB の面ごと、0〜1）にして out に書く。外は端の色 */
export function tileInput(small, tx, ty, out = new Float32Array(3 * TILE_IN * TILE_IN), o = 0) {
  const { width: w, height: h, data } = small; const n = TILE_IN * TILE_IN;
  for (let v = 0; v < TILE_IN; v++) {
    const y = Math.min(h - 1, Math.max(0, ty - PAD + v));
    for (let u = 0; u < TILE_IN; u++) {
      const x = Math.min(w - 1, Math.max(0, tx - PAD + u)); const s = (y * w + x) * 3; const d = o + v * TILE_IN + u;
      out[d] = data[s]; out[n + d] = data[s + 1]; out[2 * n + d] = data[s + 2];
    }
  }
  return out;
}

/**
 * 区画（のりしろ込み）の、写真の中の範囲（写真の外は使わない）。x0, y0, w, h: のりしろ込み、ix0〜ix1, iy0〜iy1: のりしろを除いた所
 */
export function tileRect(W, H, tx, ty) {
  const S = TILE_IN * SCALE; const X0 = (tx - PAD) * SCALE; const Y0 = (ty - PAD) * SCALE;
  const x0 = Math.max(0, X0); const y0 = Math.max(0, Y0); const x1 = Math.min(W, X0 + S); const y1 = Math.min(H, Y0 + S);
  return { X0, Y0, x0, y0, w: x1 - x0, h: y1 - y0, ix0: Math.max(x0, tx * SCALE), iy0: Math.max(y0, ty * SCALE), ix1: Math.min(x1, (tx + TILE) * SCALE), iy1: Math.min(y1, (ty + TILE) * SCALE) };
}
/** 写真（RGBA、横幅 W）の、区画の範囲の写し（RGBA） */
export function regionOf(img, W, r) {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.subarray(((r.y0 + y) * W + r.x0) * 4, ((r.y0 + y) * W + r.x0 + r.w) * 4), y * r.w * 4);
  return out;
}

/**
 * AI の結果（1 つの区画。RGB の面ごと、0〜1、一辺 TILE_IN × 4）から、写真に足す差分を求める。
 * 結果 = 写真 +（AI の絵 − そのぼかし SPLIT）−（写真のぼかし 1 − 写真のぼかし SPLIT）
 *      = 写真 + AI の絵 − 写真のぼかし 1 − ぼかし SPLIT（AI の絵 − 写真）。写真の大まかな形・色といちばん細かい粒は残る
 * @param {Float32Array} out AI の結果（o: この区画の始まり）
 * @param {Uint8ClampedArray} reg 写真の、区画の範囲（regionOf）
 * @param {ReturnType<typeof tileRect>} r
 * @returns {Int8Array} のりしろを除いた所の差分（(ix1−ix0)×(iy1−iy0)×3、1 = 1/255）
 */
export function tileResidual(out, o, reg, r) {
  const S = TILE_IN * SCALE; const n = S * S; const { w, h } = r;
  const iw = Math.max(0, r.ix1 - r.ix0); const ih = Math.max(0, r.iy1 - r.iy0); const part = new Int8Array(iw * ih * 3);
  if (!iw || !ih) return part;
  const D = new Float32Array(w * h * 3); const I = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = o + (y + r.y0 - r.Y0) * S + (x + r.x0 - r.X0); const d = (y * w + x) * 3; const i = (y * w + x) * 4;
      I[d] = reg[i]; I[d + 1] = reg[i + 1]; I[d + 2] = reg[i + 2];
      D[d] = out[s] * 255 - I[d]; D[d + 1] = out[n + s] * 255 - I[d + 1]; D[d + 2] = out[2 * n + s] * 255 - I[d + 2];
    }
  }
  const dL = gauss(D, w, h, 3, SPLIT); const iF = gauss(I, w, h, 3, 1);
  // AI がくっきりさせた輪郭の外側に出る縁取り（白い服と黒い髪の境目の黒い線など）を防ぐため、
  // 結果は、写真のまわり（CLAMP 画素の四角）の明るさの幅に収める（顔 AI の逆畳み込みと同じ考え方）
  const [lo, hi] = rangeMaps(I, w, h, CLAMP);
  const keep = edgeProtect(I, w, h);
  for (let Y = r.iy0; Y < r.iy1; Y++) {
    for (let X = r.ix0; X < r.ix1; X++) {
      const p = (Y - r.y0) * w + X - r.x0; const d = p * 3; const q = ((Y - r.iy0) * iw + X - r.ix0) * 3;
      for (let c = 0; c < 3; c++) {
        const k = d + c; const v = I[k] + D[k] + I[k] - iF[k] - dL[k];
        part[q + c] = Math.max(-127, Math.min(127, Math.round((Math.min(hi[k] + MARGIN, Math.max(lo[k] - MARGIN, v)) - I[k]) * keep[p])));
      }
    }
  }
  return part;
}

/**
 * 縁の保護: 写真にもともと強い縁がある所（サテンの光沢の縁、服のひだ、腕の輪郭など）は、AI の差分を弱める（0〜1 の倍率）。
 * AI は、なだらかな光沢の縁を硬い線に描き直す（絵・イラストのように見える。2026-10-27、光沢のある服で確認）。
 * 髪の毛・レース・織りのような細かい所は、縁の強さが小さいので、そのまま（髪は変わらない）。
 * 縁の強さ = 明るさの 1.5〜5 画素の帯の絶対値を 11×11 で平均したもの。倍率 = 1 / (1 + (強さ / EDGE_T)²)
 * @param {Float32Array} I 写真（RGB、0〜255）
 * @returns {Float32Array} w×h の倍率
 */
export function edgeProtect(I, w, h) {
  const n = w * h; const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = I[i * 3] * 0.299 + I[i * 3 + 1] * 0.587 + I[i * 3 + 2] * 0.114;
  const a = gauss(L, w, h, 1, EDGE_FINE); const b = gauss(L, w, h, 1, EDGE_COARSE);
  for (let i = 0; i < n; i++) a[i] = Math.abs(a[i] - b[i]);
  const c = boxMean(a, w, h, EDGE_R);
  for (let i = 0; i < n; i++) { const t = c[i] / EDGE_T; c[i] = 1 / (1 + t * t); }
  return c;
}
/** 縁の保護の帯（ぼかしの σ、写真の画素）と、強さを平均する半径、半分に弱める強さ（1 = 1/255） */
const EDGE_FINE = 1.5; const EDGE_COARSE = 5; const EDGE_R = 5; const EDGE_T = 4;
/** 1 チャンネルを、(2r+1)² の四角で平均する（端は、ある画素だけで） */
function boxMean(a, w, h, r) {
  const t = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0; let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) { s += a[o + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      t[o + x] = s / cnt;
      if (x + r + 1 < w) { s += a[o + x + r + 1]; cnt++; }
      if (x - r >= 0) { s -= a[o + x - r]; cnt--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0; let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) { s += t[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / cnt;
      if (y + r + 1 < h) { s += t[(y + r + 1) * w + x]; cnt++; }
      if (y - r >= 0) { s -= t[(y - r) * w + x]; cnt--; }
    }
  }
  return out;
}
/** tileResidual の結果を、写真全体の差分（W×H×3）に書く */
export function putResidual(res, W, r, part) {
  const iw = r.ix1 - r.ix0;
  for (let Y = r.iy0; Y < r.iy1; Y++) res.set(part.subarray((Y - r.iy0) * iw * 3, (Y - r.iy0 + 1) * iw * 3), (Y * W + r.ix0) * 3);
}

/** 縁取りを防ぐ幅（CLAMP 画素の四角の中の、いちばん暗い〜明るい値から、MARGIN までははみ出してよい） */
const CLAMP = 3; const MARGIN = 3;
/** 色ごとに、まわり（半径 r の四角）のいちばん小さい値・大きい値 */
function rangeMaps(img, w, h, r) {
  const tl = new Float32Array(img.length); const th = new Float32Array(img.length); const lo = new Float32Array(img.length); const hi = new Float32Array(img.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r); const b = Math.min(w - 1, x + r);
      for (let c = 0; c < 3; c++) {
        let mn = 255; let mx = 0;
        for (let k = a; k <= b; k++) { const v = img[(y * w + k) * 3 + c]; if (v < mn) mn = v; if (v > mx) mx = v; }
        tl[(y * w + x) * 3 + c] = mn; th[(y * w + x) * 3 + c] = mx;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r); const b = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let mn = 255; let mx = 0;
        for (let k = a; k <= b; k++) { const i = (k * w + x) * 3 + c; if (tl[i] < mn) mn = tl[i]; if (th[i] > mx) mx = th[i]; }
        lo[(y * w + x) * 3 + c] = mn; hi[(y * w + x) * 3 + c] = mx;
      }
    }
  }
  return [lo, hi];
}

/** 写真（RGBA、W×H 全体）に差分を足す（編集用の大きさ。res と同じ大きさ） */
export function addDetail(data, res, amount = 1) {
  const n = res.length / 3;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.min(255, Math.max(0, Math.round(data[i * 4 + c] + res[i * 3 + c] * amount)));
  return data;
}

/**
 * 書き出し（元の大きさ）: 編集用の大きさで求めた差分を引き伸ばして（双一次）、写真の何行か（RGBA、横幅いっぱい）に足す
 * @param {{y0:number,fullW:number,fullH:number}} at この行の、写真の中の位置と、写真の大きさ
 * @param {{width:number,height:number,data:Int8Array}} res
 */
export function applyDetail(data, rows, at, res, amount = 1) {
  const { fullW: FW, fullH: FH } = at; const { width: w, height: h, data: R } = res;
  const sx = w / FW; const sy = h / FH;
  for (let y = 0; y < rows; y++) {
    const fy = Math.min(h - 1, Math.max(0, (at.y0 + y + 0.5) * sy - 0.5)); const ya = Math.floor(fy); const yb = Math.min(h - 1, ya + 1); const ty = fy - ya;
    for (let x = 0; x < FW; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5)); const xa = Math.floor(fx); const xb = Math.min(w - 1, xa + 1); const tx = fx - xa;
      const a = (ya * w + xa) * 3; const b = (ya * w + xb) * 3; const c = (yb * w + xa) * 3; const d = (yb * w + xb) * 3; const i = (y * FW + x) * 4;
      for (let k = 0; k < 3; k++) {
        const t = R[a + k] + (R[b + k] - R[a + k]) * tx; const v = t + (R[c + k] + (R[d + k] - R[c + k]) * tx - t) * ty;
        data[i + k] = Math.min(255, Math.max(0, Math.round(data[i + k] + v * amount)));
      }
    }
  }
  return data;
}
