// 被写体ブレの補正（シャッター速度による、動いた手・髪などのブレ）の計算。DOM を使わない（Web Worker・Node のどちらでも動く）。
// AI（NAFNet、GoPro のブレで学習したもの。MIT ライセンス）を端末の中で動かす。写真は外に送らない。
//  1. 写真を縮める（ブレは 15〜30 画素あるので、半分くらいにすると AI が直せる大きさになる）
//  2. 256×256 の区画ごとに AI に通す。左右を反転したものも通し、2 つで向きが合う直し方だけを残す
//     （AI の癖でできる筋・格子は、反転すると向きが変わるので消える）
//  3. 平らな所（カーテン・肌）には効かせない。直した量を、まわりの明るさのばらつきに見合う大きさまでに抑える
//  4. 直した差分だけを元の大きさに引き伸ばして足す（元の写真の細かさはそのまま）
// AI の途中の値は、ある種の写真で暴走して色の砂嵐になる。モデルの中で、普通の写真で出る範囲に値を止めてある
// （scripts/deblur-proto/clampnet.py・export_onnx.py）。

import { boxBlur, measureNoise, enhanceBand } from './restoration-lowlight.js';

export const TILE = 256; // AI に通す区画の大きさ（モデルはこの大きさで作ってある）
const OVERLAP = 32; // 区画の重なり（つなぎ目をなめらかに混ぜる）
const GATE_R = 6; // まわりのばらつきを測る範囲（縮めた絵の画素。3 回の平均化で、ぼかしの幅 6.5 くらい）
const GATE_K = 2.5; // 直してよい量 = GATE_K ×（まわりのばらつき − GATE_FLOOR）
const GATE_FLOOR = 0.008; // これより小さなばらつきは、ノイズ・平らな所とみなす
const LOW_R = 20; // これより広い範囲（縮めた絵の画素）のゆるやかな変化は、AI の直しから除く
const MAX_SMALL = 4_500_000; // 縮めた絵の画素数の上限（メモリ）

/**
 * AI に通す大きさ（元の写真の大きさで決める。編集用の写真でも書き出しでも同じ大きさになる）。
 * 長い辺 1600 までは元の大きさ、3200 以上は半分（ブレの幅は写真の大きさに比例する）
 * @returns {{width:number,height:number}}
 */
export function deblurSize(W, H) {
  let s = Math.min(1, Math.max(0.5, 1600 / Math.max(W, H)));
  s = Math.min(s, Math.sqrt(MAX_SMALL / (W * H)));
  return { width: Math.max(1, Math.round(W * s)), height: Math.max(1, Math.round(H * s)) };
}

/**
 * AI に渡す前に、縮めた絵のノイズを取る（ノイズ軽減を使っていない写真用）。高感度のざらつきが残っていると、
 * AI がそれをブレの模様と見て格子・筋を作る。直した差分は、ノイズを取る前の写真に足す
 * @param {{width:number,height:number,data:Float32Array}} small RGB（0〜1）
 */
export function denoiseSmall(small, onProgress = () => {}) {
  const { width: w, height: h, data } = small; const n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = data[i * 3] * 255; rgba[i * 4 + 1] = data[i * 3 + 1] * 255; rgba[i * 4 + 2] = data[i * 3 + 2] * 255; rgba[i * 4 + 3] = 255; }
  // ノイズの量は、写真の中央で測る
  const cw = Math.min(w, 1024); const chh = Math.min(h, 1024); const x0 = (w - cw) >> 1; const y0 = (h - chh) >> 1;
  const crop = new Uint8ClampedArray(cw * chh * 4);
  for (let y = 0; y < chh; y++) crop.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
  const profile = measureNoise(crop, cw, chh);
  const out = enhanceBand({ width: w, height: h, data: rgba }, { top: 0, bottom: h, y0: 0, fullW: w, fullH: h }, { nr: 1, profile, tone: null, grain: false, fine: false }, onProgress);
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = out[i * 4] / 255; rgb[i * 3 + 1] = out[i * 4 + 1] / 255; rgb[i * 3 + 2] = out[i * 4 + 2] / 255; }
  return { width: w, height: h, data: rgb };
}

/** 平均化を 3 回（ガウスぼかしの近似） */
function blur3(src, w, h, r) {
  const t = new Float32Array(w * h); const tmp = new Float32Array(w * h);
  return boxBlur(boxBlur(boxBlur(src, w, h, r, t, tmp), w, h, r, new Float32Array(w * h), tmp), w, h, r, t, tmp);
}

/** 区画の左上の位置（端の区画は、写真の端にそろえる） */
function starts(n) {
  if (n <= TILE) return [0];
  const out = [];
  for (let v = 0; v < n - TILE; v += TILE - OVERLAP) out.push(v);
  out.push(n - TILE);
  return [...new Set(out)];
}

/** 区画を混ぜる重み（端の OVERLAP 画素で 0 から 1 へ） */
const RAMP = Float32Array.from({ length: TILE }, (_, i) => Math.min(1, (i + 0.5) / OVERLAP, (TILE - i - 0.5) / OVERLAP));

/**
 * 直してよい量の地図（縮めた絵の画素ごと）。まわりの明るさのばらつきが大きい所（輪郭・模様）ほど大きい
 * @param {Float32Array} rgb 縮めた絵（RGB を並べたもの、0〜1）
 */
export function gateMap(rgb, w, h) {
  const n = w * h; const Y = new Float32Array(n); const Y2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]; Y[i] = v; Y2[i] = v * v; }
  const m1 = blur3(Y, w, h, GATE_R); const m2 = blur3(Y2, w, h, GATE_R);
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = GATE_K * Math.max(0, Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i])) - GATE_FLOOR);
  return A;
}

/** 差分を、直してよい量 A までに抑える（境目でいきなり変わらないよう、抑える割合を少しぼかしてから小さい方を使う） */
function limitResidual(acc, A, w, h) {
  const s = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const mag = Math.max(Math.abs(acc[i * 3]), Math.abs(acc[i * 3 + 1]), Math.abs(acc[i * 3 + 2])) + 1e-6;
    s[i] = Math.min(1, A[i] / mag);
  }
  const sb = boxBlur(boxBlur(s, w, h, 1), w, h, 1);
  for (let i = 0; i < w * h; i++) { const k = Math.min(s[i], sb[i]); acc[i * 3] *= k; acc[i * 3 + 1] *= k; acc[i * 3 + 2] *= k; }
}

/**
 * 縮めた絵で、AI が直した差分を求める
 * @param {{width:number,height:number,data:Float32Array}} small RGB を並べたもの（0〜1）
 * @param {(input:Float32Array, n:number)=>Promise<Float32Array>} infer AI。n 枚の区画（NCHW、3×TILE×TILE）を直したもの
 * @param {{onProgress?:(t:number)=>void, signal?:AbortSignal, concurrency?:number}} hooks concurrency: 同時に AI に渡す区画の数
 * @returns {Promise<{width:number,height:number,data:Float32Array}>} 差分（RGB を並べたもの）
 */
export async function deblurResidual(small, infer, { onProgress = () => {}, signal, concurrency = 1 } = {}) {
  const { width: w, height: h, data: rgb } = small;
  const A = gateMap(rgb, w, h);
  const acc = new Float32Array(w * h * 3); const wsum = new Float32Array(w * h);
  const tiles = [];
  for (const y0 of starts(h)) for (const x0 of starts(w)) {
    // 直してよい量がほとんどない区画（平らな背景など）は AI に通さない
    let mx = 0;
    for (let y = y0; y < Math.min(h, y0 + TILE); y++) for (let x = x0; x < Math.min(w, x0 + TILE); x++) mx = Math.max(mx, A[y * w + x]);
    tiles.push({ y0, x0, skip: mx < 0.5 / 255 });
  }
  const P = TILE * TILE;
  // 区画の外（写真が TILE より小さいとき）は、端で折り返す
  const ref = (v, n) => { let i = v; if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; return Math.max(0, Math.min(n - 1, i)); };
  for (const t of tiles) {
    if (!t.skip) continue;
    const th = Math.min(TILE, h - t.y0); const tw = Math.min(TILE, w - t.x0);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) wsum[(t.y0 + y) * w + t.x0 + x] += RAMP[y] * RAMP[x];
  }
  const run = tiles.filter((t) => !t.skip); let done = 0; let next = 0;
  // 1 つの区画を AI に通して、差分を足し込む（2 枚目は左右を反転したもの）
  const one = async (t) => {
    const input = new Float32Array(2 * 3 * P);
    for (let y = 0; y < TILE; y++) {
      const sy = ref(t.y0 + y, h);
      for (let x = 0; x < TILE; x++) {
        const s = (sy * w + ref(t.x0 + x, w)) * 3; const o = y * TILE + x; const of = y * TILE + (TILE - 1 - x);
        for (let c = 0; c < 3; c++) { input[c * P + o] = rgb[s + c]; input[(3 + c) * P + of] = rgb[s + c]; }
      }
    }
    const out = await infer(input, 2);
    const th = Math.min(TILE, h - t.y0); const tw = Math.min(TILE, w - t.x0);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const o = y * TILE + x; const of = y * TILE + (TILE - 1 - x); const i = (t.y0 + y) * w + t.x0 + x;
        const wt = RAMP[y] * RAMP[x];
        for (let c = 0; c < 3; c++) {
          const a = out[c * P + o] - input[c * P + o]; const b = out[(3 + c) * P + of] - input[c * P + o];
          // 2 つの向きが合う分だけ（小さい方）
          const r = a > 0 && b > 0 ? Math.min(a, b) : a < 0 && b < 0 ? Math.max(a, b) : 0;
          acc[i * 3 + c] += r * wt;
        }
        wsum[i] += wt;
      }
    }
    onProgress(++done / Math.max(1, run.length));
  };
  const lane = async () => {
    while (next < run.length) {
      if (signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError');
      await one(run[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, run.length)) }, lane));
  for (let i = 0; i < w * h; i++) { const k = wsum[i] > 0 ? 1 / wsum[i] : 0; acc[i * 3] *= k; acc[i * 3 + 1] *= k; acc[i * 3 + 2] *= k; }
  // AI は全体を少し暗く・色を少し変える癖がある（GoPro の写真で学習したため）。ゆるやかな変化は取り除き、輪郭の直しだけを残す
  const ch = new Float32Array(w * h);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < w * h; i++) ch[i] = acc[i * 3 + c];
    const lo = blur3(ch, w, h, LOW_R);
    for (let i = 0; i < w * h; i++) acc[i * 3 + c] -= lo[i];
  }
  limitResidual(acc, A, w, h);
  onProgress(1);
  return { width: w, height: h, data: acc };
}

/** 3 次補間の重み（Catmull-Rom 系、a = -0.5。PIL の BICUBIC と同じ） */
function cubic(t) {
  const a = -0.5; const x = Math.abs(t);
  if (x <= 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}
/** 元の大きさの位置 → 縮めた絵の 4 画素と重み */
function taps(n, N) {
  const idx = new Int32Array(N * 4); const wt = new Float32Array(N * 4); const s = n / N;
  for (let X = 0; X < N; X++) {
    const f = (X + 0.5) * s - 0.5; const b = Math.floor(f);
    let sum = 0;
    for (let k = 0; k < 4; k++) { const v = b - 1 + k; idx[X * 4 + k] = Math.max(0, Math.min(n - 1, v)); wt[X * 4 + k] = cubic(f - v); sum += wt[X * 4 + k]; }
    for (let k = 0; k < 4; k++) wt[X * 4 + k] /= sum;
  }
  return { idx, wt };
}

/**
 * 何段かで直す。まず半分に縮めた絵で大きなブレを直し（その中でさらに半分に縮めた段も使う）、それを足した絵で、もう一度細かいブレを直す
 * （前に伸ばした手のような、縮めた絵で 15 画素を超えるブレは 1 段では直りきらない）
 * levels: 段の数（3 なら 1/4 → 1/2 → そのまま）。cap: 和を、元の絵の直してよい量の何倍までに抑えるか
 * @returns 差分（small と同じ大きさ。各段の和）
 */
export async function deblurResidual2(small, infer, { onProgress = () => {}, signal, concurrency = 1, levels = 3, cap = 1 } = {}) {
  const { width: w, height: h, data } = small;
  if (levels < 2 || Math.min(w, h) < 2 * TILE) return deblurResidual(small, infer, { onProgress, signal, concurrency });
  const w2 = Math.ceil(w / 2); const h2 = Math.ceil(h / 2); const half = new Float32Array(w2 * h2 * 3);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const xs = [2 * x, Math.min(w - 1, 2 * x + 1)]; const ys = [2 * y, Math.min(h - 1, 2 * y + 1)];
      for (let c = 0; c < 3; c++) { let v = 0; for (const yy of ys) for (const xx of xs) v += data[(yy * w + xx) * 3 + c]; half[(y * w2 + x) * 3 + c] = v / 4; }
    }
  }
  // 進捗: 半分の大きさの段は区画が 4 分の 1 なので 2 割
  const r1 = await deblurResidual2({ width: w2, height: h2, data: half }, infer, { signal, concurrency, levels: levels - 1, cap, onProgress: (t) => onProgress(0.2 * t) });
  const up = resizeRGB(r1, w, h).data;
  const pre = new Float32Array(data.length); for (let i = 0; i < data.length; i++) pre[i] = data[i] + up[i];
  const r2 = await deblurResidual({ width: w, height: h, data: pre }, infer, { signal, concurrency, onProgress: (t) => onProgress(0.2 + 0.8 * t) });
  for (let i = 0; i < data.length; i++) r2.data[i] += up[i];
  // 2 段の和も、元の絵の直してよい量までに抑える（頬のやわらかい光の境目が、角ばった形にならないように）
  if (cap > 0) limitResidual(r2.data, gateMap(data, w, h).map((a) => a * cap), w, h);
  return r2;
}

/** RGB を並べた絵（差分など）を、3 次補間で別の大きさにする */
export function resizeRGB(src, W, H) {
  const { width: w, height: h, data: R } = src;
  const tx = taps(w, W); const ty = taps(h, H); const out = new Float32Array(W * H * 3); const line = new Float32Array(w * 3);
  for (let Y = 0; Y < H; Y++) {
    line.fill(0);
    for (let k = 0; k < 4; k++) { const wy = ty.wt[Y * 4 + k]; const o = ty.idx[Y * 4 + k] * w * 3; for (let i = 0; i < w * 3; i++) line[i] += R[o + i] * wy; }
    for (let X = 0; X < W; X++) {
      const q = (Y * W + X) * 3;
      for (let k = 0; k < 4; k++) { const j = tx.idx[X * 4 + k] * 3; const wx = tx.wt[X * 4 + k]; out[q] += line[j] * wx; out[q + 1] += line[j + 1] * wx; out[q + 2] += line[j + 2] * wx; }
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * 差分を元の大きさに引き伸ばして、8bit の RGBA（横幅いっぱいの何行か）に足す
 * @param {Uint8ClampedArray} data 書き換える
 * @param {{y0:number,fullW:number,fullH:number}} at data の 1 行目が写真全体の何行目か
 * @param {{width:number,height:number,data:Float32Array}} res deblurResidual の結果
 * @param {number} amount 強さ（1 で標準）
 */
export function applyResidual(data, rows, at, res, amount) {
  const W = at.fullW; const { width: w, height: h, data: R } = res;
  if (!(amount > 0)) return data;
  const tx = taps(w, W); const ty = taps(h, at.fullH);
  const line = new Float32Array(w * 3);
  for (let y = 0; y < rows; y++) {
    const Y = at.y0 + y;
    line.fill(0);
    for (let k = 0; k < 4; k++) {
      const wy = ty.wt[Y * 4 + k] * amount * 255; if (wy === 0) continue;
      const o = ty.idx[Y * 4 + k] * w * 3;
      for (let i = 0; i < w * 3; i++) line[i] += R[o + i] * wy;
    }
    const row = y * W * 4;
    for (let X = 0; X < W; X++) {
      let r = 0; let g = 0; let b = 0;
      for (let k = 0; k < 4; k++) { const j = tx.idx[X * 4 + k] * 3; const wx = tx.wt[X * 4 + k]; r += line[j] * wx; g += line[j + 1] * wx; b += line[j + 2] * wx; }
      const i = row + X * 4;
      data[i] += r; data[i + 1] += g; data[i + 2] += b;
    }
  }
  return data;
}

/**
 * ピントのぼけ・小さな被写体ブレで、輪郭がにじんだ写真を、ぼけの形（ガウスぼかし）を仮定して戻す（Richardson–Lucy の逆畳み込み）。
 * AI は 10〜20 画素のなだらかなにじみ（暗い舞台で動く顔のあご・前髪・歯）をほとんど直せない（IMG_9313・9321）。
 * - 明るさ（輝度）だけを戻す（色はそのまま）。くり返しの回数を少なくして、ノイズのムラを育てない
 * - まわり（5×5）の最小〜最大から少ししかはみ出させない（輪郭の外の白い縁・黒い縁、波打つ線を作らない）
 * - はっきりした輪郭（ぼかした絵の明るさの差が大きい所）だけに効かせる。肌のなだらかな所・ノイズのムラはそのまま
 * @param {{width:number,height:number,data:Float32Array}} small RGB を並べたもの（0〜1）。deblurSize の大きさ
 * @returns {{width:number,height:number,data:Float32Array}} 差分（RGB を並べたもの。3 色とも同じ値）
 */
const DECONV_SIGMA = 2.5; // 仮定するぼけの大きさ（長い辺 2592 の絵での、ガウスぼかしの標準偏差）
const DECONV_ITERS = 12;
const DECONV_OVER = 0.3; // まわりの最小〜最大の幅の何割まではみ出してよいか
const DECONV_EDGE = 0.03; // これより明るさの差が小さい輪郭には効かせない（その 2 倍で全部）
const DECONV_MAX = 0.3; // 直す量の上限（まわりの最小〜最大の幅に対して）
export function deconvResidual(small, { sigma = DECONV_SIGMA * Math.max(small.width, small.height) / 2592, iters = DECONV_ITERS } = {}) {
  const { width: w, height: h, data } = small; const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
  const out = new Float32Array(n * 3);
  if (!(sigma > 0.3)) return { width: w, height: h, data: out };
  const g = gaussKernel(sigma); const tmp = new Float32Array(n);
  // Richardson–Lucy（暗い所で割り算が暴れないよう、少し持ち上げてから）
  const B = 0.02; const obs = new Float32Array(n); for (let i = 0; i < n; i++) obs[i] = Y[i] + B;
  const X = Float32Array.from(obs); const c = new Float32Array(n);
  for (let k = 0; k < iters; k++) {
    gaussBlur(X, w, h, g, c, tmp);
    for (let i = 0; i < n; i++) c[i] = obs[i] / Math.max(c[i], 1e-4);
    gaussBlur(c, w, h, g, c, tmp);
    for (let i = 0; i < n; i++) X[i] *= c[i];
  }
  const lo = minMax(Y, w, h, 2, Math.min); const hi = minMax(Y, w, h, 2, Math.max);
  // 輪郭の明るさの差（ぼかした絵の傾き × ぼけの幅）
  const Bl = new Float32Array(n); gaussBlur(Y, w, h, g, Bl, tmp);
  const range = new Float32Array(n); for (let i = 0; i < n; i++) range[i] = hi[i] - lo[i];
  gaussBlur(range, w, h, gaussKernel(1), range, tmp);
  const at = (x, y) => Bl[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
      const edge = Math.hypot(gx, gy) * sigma * 2.5;
      const A = Math.min(1, Math.max(0, (edge - DECONV_EDGE) / DECONV_EDGE)) * DECONV_MAX * range[i];
      const o = (hi[i] - lo[i]) * DECONV_OVER;
      const v = Math.min(hi[i] + o, Math.max(lo[i] - o, X[i] - B));
      const r = Math.min(A, Math.max(-A, v - Y[i]));
      out[i * 3] = r; out[i * 3 + 1] = r; out[i * 3 + 2] = r;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * AI の差分に、逆畳み込みの差分を足す。2 つで「直してよい量」（gateMap）を分け合い、AI がもう直した所には、残りの分しか足さない。
 * また、変える量はその画素の明るさの DECONV_REL 倍まで（暗い所を大きく暗くしない）。
 * 大きくブレた写真（IMG_9345）では、ブレたままの目の縁だけを戻すと、目が縁だけくっきりした黒い切り抜きのようになった（ユーザーの声「これだけ不自然。特に目」）
 * @param {{data:Float32Array}} res AI の差分（書き換える） @param {{data:Float32Array}} dc deconvResidual の結果
 * @param {{width:number,height:number,data:Float32Array}} small AI に渡した縮めた絵
 */
const DECONV_REL = 0.06;
export function addDeconv(res, dc, small) {
  const { width: w, height: h, data } = small; const A = gateMap(data, w, h); const R = res.data;
  for (let i = 0; i < w * h; i++) {
    const a = Math.abs(0.299 * R[i * 3] + 0.587 * R[i * 3 + 1] + 0.114 * R[i * 3 + 2]);
    const Y = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
    const room = Math.min(Math.max(0, A[i] - a), DECONV_REL * Y);
    const d = Math.max(-room, Math.min(room, dc.data[i * 3]));
    R[i * 3] += d; R[i * 3 + 1] += d; R[i * 3 + 2] += d;
  }
  return res;
}

/** ガウスぼかしの重み（半分。中心から 3σ まで） */
function gaussKernel(s) {
  const r = Math.max(1, Math.ceil(3 * s)); const k = new Float32Array(r + 1); let sum = 0;
  for (let i = 0; i <= r; i++) { k[i] = Math.exp(-0.5 * (i / s) ** 2); sum += i ? 2 * k[i] : k[i]; }
  for (let i = 0; i <= r; i++) k[i] /= sum;
  return k;
}
/** 縦横に分けたガウスぼかし（端は折り返す）。out は src と同じでもよい */
function gaussBlur(src, w, h, k, out, tmp) {
  const r = k.length - 1; const row = new Float32Array(w);
  const ref = (v, m) => { if (v < 0) v = -v - 1; if (v >= m) v = 2 * m - v - 1; return Math.max(0, Math.min(m - 1, v)); };
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = src[o + x] * k[0];
      if (x >= r && x < w - r) for (let j = 1; j <= r; j++) s += (src[o + x - j] + src[o + x + j]) * k[j];
      else for (let j = 1; j <= r; j++) s += (src[o + ref(x - j, w)] + src[o + ref(x + j, w)]) * k[j];
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    if (y >= r && y < h - r) {
      // 1 行分の小さな配列に足し込んでから書く（足すたびに 32bit に丸めるのは out と同じなので、結果は変わらない）
      for (let x = 0; x < w; x++) row[x] = tmp[o + x] * k[0];
      for (let j = 1; j <= r; j++) { const a = o - j * w; const b = o + j * w; const kj = k[j]; for (let x = 0; x < w; x++) row[x] += (tmp[a + x] + tmp[b + x]) * kj; }
      out.set(row, o);
    } else {
      for (let x = 0; x < w; x++) {
        let s = tmp[o + x] * k[0];
        for (let j = 1; j <= r; j++) s += (tmp[ref(y - j, h) * w + x] + tmp[ref(y + j, h) * w + x]) * k[j];
        out[o + x] = s;
      }
    }
  }
  return out;
}
/** まわり（(2r+1)×(2r+1)）の最小・最大（最大・最小は、比べる順番によらず同じ値になる） */
function minMax(src, w, h, r, pick) {
  const t = new Float32Array(w * h); const out = new Float32Array(w * h); const max = pick === Math.max;
  if (!max && pick !== Math.min) throw new Error('minMax: Math.max か Math.min');
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const j1 = Math.min(w - 1, x + r); let v = src[o + x];
      if (max) for (let j = Math.max(0, x - r); j <= j1; j++) v = Math.max(v, src[o + j]);
      else for (let j = Math.max(0, x - r); j <= j1; j++) v = Math.min(v, src[o + j]);
      t[o + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    const o = y * w; out.set(t.subarray(o, o + w), o);
    for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) {
      const q = j * w;
      if (max) for (let x = 0; x < w; x++) out[o + x] = Math.max(out[o + x], t[q + x]);
      else for (let x = 0; x < w; x++) out[o + x] = Math.min(out[o + x], t[q + x]);
    }
  }
  return out;
}
