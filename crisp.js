// 髪・服をくっきり（プロの写真のように、髪の 1 本 1 本・服の織りが見える）。
// 全体 AI（wholeai.js の Real-ESRGAN の差分。1〜4 画素くらいの細かさだけ）を、場所ごとの重みで足す:
//   髪・服・飾り 1.0、肌 0.35（それ以上だと「塗った」顔になる。2026-10-26 の直接編集で確かめた）、背景 0（ぼかした背景に粒を足さない）
// 重みの地図は、bokeh.js の人物の割合（AI の人物の地図を輪郭に沿わせたもの。4 分の 1 の大きさ）と、部位分け（skinseg.js の segParts）から作る。
// DOM を使わない（Worker と Node のテストで動く）。
import { resizeMap } from './bokeh.js';

/** この編集で、髪・服をくっきりを使うか */
export const crispActive = (adj) => (adj.crisp || 0) > 0;
/** スライダーの値 → 差分の倍率（50 で、直接編集と同じ 1.0） */
export const crispAmount = (adj) => (adj.crisp || 0) / 50;
/** 肌に足す割合（髪・服を 1 として） */
export const SKIN = 0.35;

/**
 * 重みの地図（w×h、0〜255）
 * @param {Float32Array} alpha 人物の割合（w×h、0〜1。bokeh.js の personAlpha）
 * @param {{w:number,h:number,parts:Float32Array}|null} parts 部位分け（0 背景・1 髪・2 体の肌・3 顔の肌・4 服・5 そのほか）。なければ肌も髪と同じ重み
 */
export function crispWeights(alpha, w, h, parts) {
  const out = new Uint8ClampedArray(w * h);
  let skin = null;
  if (parts) {
    const n = parts.w * parts.h; const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.min(1, parts.parts[2 * n + i] + parts.parts[3 * n + i]);
    skin = resizeMap(s, parts.w, parts.h, w, h);
  }
  for (let i = 0; i < w * h; i++) out[i] = Math.round(255 * alpha[i] * (1 - (skin ? skin[i] : 0) * (1 - SKIN)));
  return out;
}

/**
 * 写真の何行か（RGBA、横幅いっぱい）に、差分（編集用の大きさ。wholeai.js の差分）を重みの地図で足す。
 * 差分も地図も双一次で引き伸ばすので、編集用の大きさでも、書き出しの元の大きさでも使える（wholeai.js の applyDetail と同じ形）
 * @param {{y0:number,fullW:number,fullH:number}} at
 * @param {{width:number,height:number,data:Int8Array}} res
 * @param {{width:number,height:number,data:Uint8ClampedArray}} map 重み（0〜255）
 */
export function applyDetailMap(data, rows, at, res, map, amount = 1) {
  const { fullW: FW, fullH: FH } = at; const { width: w, height: h, data: R } = res; const { width: mw, height: mh, data: M } = map;
  const sx = w / FW; const sy = h / FH; const mx = mw / FW; const my = mh / FH;
  for (let y = 0; y < rows; y++) {
    const Y = at.y0 + y;
    const fy = Math.min(h - 1, Math.max(0, (Y + 0.5) * sy - 0.5)); const ya = Math.floor(fy); const yb = Math.min(h - 1, ya + 1); const ty = fy - ya;
    const gy = Math.min(mh - 1, Math.max(0, (Y + 0.5) * my - 0.5)); const ma = Math.floor(gy); const mb = Math.min(mh - 1, ma + 1); const tym = gy - ma;
    for (let x = 0; x < FW; x++) {
      const gx = Math.min(mw - 1, Math.max(0, (x + 0.5) * mx - 0.5)); const na = Math.floor(gx); const nb = Math.min(mw - 1, na + 1); const txm = gx - na;
      const u = M[ma * mw + na] + (M[ma * mw + nb] - M[ma * mw + na]) * txm; const wt = (u + (M[mb * mw + na] + (M[mb * mw + nb] - M[mb * mw + na]) * txm - u) * tym) / 255 * amount;
      if (wt < 0.002) continue;
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5)); const xa = Math.floor(fx); const xb = Math.min(w - 1, xa + 1); const tx = fx - xa;
      const a = (ya * w + xa) * 3; const b = (ya * w + xb) * 3; const c = (yb * w + xa) * 3; const d = (yb * w + xb) * 3; const i = (y * FW + x) * 4;
      for (let k = 0; k < 3; k++) {
        const t = R[a + k] + (R[b + k] - R[a + k]) * tx; const v = t + (R[c + k] + (R[d + k] - R[c + k]) * tx - t) * ty;
        data[i + k] = Math.min(255, Math.max(0, Math.round(data[i + k] + v * wt)));
      }
    }
  }
  return data;
}
