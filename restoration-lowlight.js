// 暗い写真の補正（ノイズ除去 → 明るくする）の計算。DOM を使わない（Web Worker・Node のどちらでも動く）。
// ノイズが乗ったまま明るくするとノイズも一緒に増えるので、先にノイズを取ってから明るさを持ち上げる。
//  1. ノイズの量を、明るさごと・粒の大きさ（段）ごとに写真から測る（measureNoise）
//  2. 輪郭を残してノイズだけならす。細かい粒は元の大きさで、大きな粒は縮めた絵で（denoise）
//     色のムラ（赤緑のまだら）は輝度の輪郭に沿って広くならす（cleanChroma）
//  3. 明るさの大きな流れ（ベース）だけを持ち上げ、細かい模様（ディテール）はそのまま残す（planTone・applyTone）
// 大きな写真は横長の帯に分けて Worker で処理する（enhanceBand）。ノイズの量と明るさの曲線は写真全体で 1 つに決めて
// 全部の帯に渡すので、帯の境目で明るさやなめらかさが変わらない。
// 色は 8bit の値（sRGB・Display P3 とも同じ伝達関数）を 0〜1 にして、輝度・色差に分けて扱う。

import { NLM_WASM } from './nlm.wasm.js';
import { lowMemory } from './cores.js';

const SRGB_LUT = new Float32Array(4096);
for (let i = 0; i < 4096; i++) { const v = i / 4095; SRGB_LUT[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
const toLinear = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : SRGB_LUT[(v * 4095 + 0.5) | 0]);
const toSrgb = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export const NOISE_BINS = 12;
const hash = (v) => { let h = Math.imul(v ^ (v >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
/** 帯の上下に余分に読む行数（いちばん粗い段の探索範囲と、色ムラ除去の半径が収まる大きさ。4 の倍数） */
export const BAND_MARGIN = 48;
const LEVELS = 3;
// ノイズ除去で取った明るさの成分のうち、戻す割合（強さ 1 のとき）。模様のある所（肌のきめ・レース・髪）は多く、
// 平らな所（カーテン・背景）は少なく戻す。平らな所に戻すと、それはただのノイズに見える
const KEEP_FLAT = 0.1;
const KEEP_TEXTURE = 0.6;
// 取った成分のうち、ごく細かい粒（1〜2 画素。肌のきめ・生地の目）を戻す割合。人物（肌・衣装・髪）は全部、背景（壁・カーテン）は FINE_BACK だけ
// （ユーザーの声「元の写真にあったきめ細やかさは残したい。ノイズはもちろん消す」。にじんだ大きな粒・色のムラは戻さないので、ノイズのムラは残らない）
const FINE_KEEP = 1;
const FINE_BACK = 0.35;
// 大きく明るくする写真（暗い元の写真）では、戻す細かい粒もそれだけ持ち上がり、肌がカサカサに見える（IMG_9348・9321。倍率 13.5・7.4）。
// 明るくする倍率が FINE_GAIN を超えた分だけ、戻す量を減らす（IMG_9365 は倍率 4.7 で、そのままの仕上がりがきれい）
const FINE_GAIN = 5;
/** 戻す細かい粒の割合（明るくする倍率で決める）。tone は planTone の結果（null なら明るくしない） */
export const fineScale = (tone) => (tone ? Math.min(1, FINE_GAIN / tone.gain) : 1);
// ノイズの代わりに足す、細かい粒（色のない粒。フィルムの粒のように均一で、中間の明るさで強い）。8bit の標準偏差。
// ノイズを取りきって粒もないと、肌・髪・衣装が絵の具でなでたような面になり、写真全体がイラストのように見える（IMG_9348・9321・9250）。
// 消したノイズが多い写真ほど（ノイズの量 × 明るくした分）、粒を強くする: 明るくしたあとのノイズの GRAIN_REL 倍。FILM_GRAIN〜GRAIN_MAX
const FILM_GRAIN = 1.5;
const GRAIN_REL = 0.45;
const GRAIN_MAX = 4;
const binOf = (y) => Math.min(NOISE_BINS - 1, Math.max(0, Math.floor(y * NOISE_BINS * 1.6))); // 暗い側を細かく（0〜0.625）

/** 平均化（端は、範囲に入る画素だけで平均する） */
export function boxBlur(src, w, h, r, out = new Float32Array(w * h), tmp = new Float32Array(w * h)) {
  const hr = Math.min(r, w - 1); const k = 2 * r + 1;
  for (let y = 0; y < h; y++) hsum(src, tmp, y * w, w, r, hr, k, y * w);
  const col = new Float64Array(w); const row = new Float32Array(w);
  for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    const y1 = y + r; const y0 = y - r - 1;
    vsum(tmp, col, row, w, y > 0 && y1 < h ? y1 * w : -1, y > 0 && y0 >= 0 ? y0 * w : -1, Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
    out.set(row, y * w);
  }
  return out;
}
// boxBlur の横の 1 行（src の so から w 個 → tmp の o から）。端は、範囲に入る画素だけで平均する。
// 足す・引く順番と割り算は、どの画素でも同じ（分けて書いても結果は 1 ビットも変わらない）
function hsum(src, tmp, o, w, r, hr, k, so = 0) {
  let s = 0;
  for (let x = 0; x <= hr; x++) s += src[so + x];
  tmp[o] = s / (hr + 1);
  const a = Math.min(r, w - 1); const b = Math.max(r + 1, w - r);
  for (let x = 1; x <= a; x++) { const x1 = x + r; if (x1 < w) s += src[so + x1]; tmp[o + x] = s / (Math.min(w - 1, x1) + 1); }
  for (let x = r + 1; x < w - r; x++) { s += src[so + x + r]; s -= src[so + x - r - 1]; tmp[o + x] = s / k; }
  for (let x = b; x < w; x++) { const x1 = x + r; const x0 = x - r - 1; if (x1 < w) s += src[so + x1]; if (x0 >= 0) s -= src[so + x0]; tmp[o + x] = s / (Math.min(w - 1, x1) - (x - r) + 1); }
}
// boxBlur の縦の 1 行: 列の和に add 行を足し、sub 行を引いて（-1 ならしない）、cnt で割る
function vsum(tmp, col, row, w, add, sub, cnt) {
  if (add >= 0 && sub >= 0) for (let x = 0; x < w; x++) { const c = col[x] + tmp[add + x] - tmp[sub + x]; col[x] = c; row[x] = c / cnt; }
  else if (add >= 0) for (let x = 0; x < w; x++) { const c = col[x] + tmp[add + x]; col[x] = c; row[x] = c / cnt; }
  else if (sub >= 0) for (let x = 0; x < w; x++) { const c = col[x] - tmp[sub + x]; col[x] = c; row[x] = c / cnt; }
  else for (let x = 0; x < w; x++) row[x] = col[x] / cnt;
}

/** ガイデッドフィルターの係数（guide の輪郭に沿ってなめらかにする。出力は ma*guide+mb） */
function guidedCoef(guide, src, w, h, r, eps) {
  const n = w * h;
  const mI = boxBlur(guide, w, h, r); const mP = boxBlur(src, w, h, r);
  const ip = new Float32Array(n); const ii = new Float32Array(n);
  for (let i = 0; i < n; i++) { ip[i] = guide[i] * src[i]; ii[i] = guide[i] * guide[i]; }
  const mIP = boxBlur(ip, w, h, r); const mII = boxBlur(ii, w, h, r);
  for (let i = 0; i < n; i++) {
    const va = mII[i] - mI[i] * mI[i]; const k = (mIP[i] - mI[i] * mP[i]) / (va + eps);
    ip[i] = k; ii[i] = mP[i] - k * mI[i];
  }
  return { a: boxBlur(ip, w, h, r, mIP), b: boxBlur(ii, w, h, r, mII) };
}
export function guided(guide, src, w, h, r, eps) {
  const { a, b } = guidedCoef(guide, src, w, h, r, eps);
  for (let i = 0; i < a.length; i++) a[i] = a[i] * guide[i] + b[i];
  return a;
}

/** 2×2 の平均で半分の大きさに */
export function down2(c, w, h) {
  const w2 = (w + 1) >> 1; const h2 = (h + 1) >> 1; const o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const x1 = Math.min(w - 1, 2 * x + 1); const y1 = Math.min(h - 1, 2 * y + 1);
    o[y * w2 + x] = (c[2 * y * w + 2 * x] + c[2 * y * w + x1] + c[y1 * w + 2 * x] + c[y1 * w + x1]) / 4;
  }
  return o;
}
/** 2 倍の大きさに（双一次補間。画素の中心をそろえる） */
function up2(c, w2, h2, w, h) {
  const o = new Float32Array(w * h);
  // 列ごとの読む位置と割合は、どの行でも同じなので先に求める（計算は 1 画素ずつ求めるのとまったく同じ）
  const X0 = new Int32Array(w); const X1 = new Int32Array(w); const TX = new Float64Array(w);
  for (let x = 0; x < w; x++) { const fx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5)); X0[x] = Math.floor(fx); X1[x] = Math.min(w2 - 1, X0[x] + 1); TX[x] = fx - X0[x]; }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(h2 - 1, y0 + 1); const ty = fy - y0;
    const r0 = y0 * w2; const r1 = y1 * w2;
    for (let x = 0; x < w; x++) {
      const x0 = X0[x]; const x1 = X1[x]; const tx = TX[x];
      o[y * w + x] = (c[r0 + x0] * (1 - tx) + c[r0 + x1] * tx) * (1 - ty) + (c[r1 + x0] * (1 - tx) + c[r1 + x1] * tx) * ty;
    }
  }
  return o;
}

/** RGBA（8bit）→ 輝度・色差（0〜1） */
export function toYCC(rgba, w, h) {
  const n = w * h; const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255; const g = rgba[i * 4 + 1] / 255; const b = rgba[i * 4 + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b; Y[i] = y; Cb[i] = b - y; Cr[i] = r - y;
  }
  return [Y, Cb, Cr];
}

/**
 * 1 段分のノイズの量（輝度の標準偏差）を、明るさごとに測る。
 * 8×8 の区画ごとに、傾き（平面）を引いた残りのばらつきを求め、明るさの近い区画のうち下から 10% の値を使う。
 * 模様のある区画はばらつきが大きいので、平らな区画（カーテン・肌・背景）の値がとれる。
 * 高感度のノイズは 2〜3 画素の大きな粒になるので、3×3 の差分フィルターではなく区画全体のばらつきで測る（粒の大きさによらない）。
 */
function noiseBins(Y, w, h) {
  const B = 16; const lists = Array.from({ length: NOISE_BINS }, () => []);
  // 平面の当てはめ用（区画の中心を原点に）
  const c = (B - 1) / 2; let sxx = 0; for (let k = 0; k < B; k++) sxx += (k - c) ** 2; sxx *= B;
  for (let by = 0; by + B <= h; by += B) for (let bx = 0; bx + B <= w; bx += B) {
    let s = 0; let sx = 0; let sy = 0;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const v = Y[(by + y) * w + bx + x]; s += v; sx += v * (x - c); sy += v * (y - c); }
    const m = s / (B * B); const gx = sx / sxx; const gy = sy / sxx;
    if (m < 0.004 || m > 0.97) continue; // 真っ黒・白飛びはノイズが測れない
    let ss = 0;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const d = Y[(by + y) * w + bx + x] - m - gx * (x - c) - gy * (y - c); ss += d * d; }
    lists[binOf(m)].push(Math.sqrt(ss / (B * B - 3)));
  }
  const bins = new Float32Array(NOISE_BINS).fill(NaN);
  for (let k = 0; k < NOISE_BINS; k++) {
    const l = lists[k]; if (l.length < 24) continue;
    l.sort((a, b) => a - b);
    // 平らな区画でも、64 画素から求めたばらつきは本当の値の前後に散る。下から 10% は本当の値の約 0.88 倍
    bins[k] = l[Math.floor(l.length * 0.1)] / 0.88;
  }
  // 測れなかった明るさは近くの値で埋める
  let last = NaN; for (let k = 0; k < NOISE_BINS; k++) { if (Number.isNaN(bins[k])) bins[k] = last; else last = bins[k]; }
  last = NaN; for (let k = NOISE_BINS - 1; k >= 0; k--) { if (Number.isNaN(bins[k])) bins[k] = last; else last = bins[k]; }
  for (let k = 0; k < NOISE_BINS; k++) if (!(bins[k] > 0)) bins[k] = 0.002;
  return bins;
}

/**
 * ノイズの量を段（元の大きさ・1/2・1/4）ごとに測る。写真全体（大きいときは中央の一部）の RGBA を渡す
 * @returns {Float32Array[]} 段ごとの、明るさ別の標準偏差
 */
export function measureNoise(rgba, w, h) {
  let [Y] = toYCC(rgba, w, h); const out = [];
  for (let l = 0; l < LEVELS; l++) {
    out.push(noiseBins(Y, w, h));
    Y = down2(Y, w, h); w = (w + 1) >> 1; h = (h + 1) >> 1;
  }
  return out;
}
/**
 * 取った成分を「模様」として戻すかを決めるときの、ノイズの量の下限（真っ暗に近い所だけ）。
 * 黒に近い所は 0 で切れるので、測ったばらつきは本当より小さく出る。そこに残った JPEG の 1〜2 階調の塊を
 * 「模様」とみなして戻すと、大きく明るくしたときに髪の中の黒い点（十字の染み）になる。1.5 階調（8bit）を下限にする。
 * 明るい所（FLOOR_TO より上）は測った値のまま（低感度の写真の細かい模様を消さない）
 */
const NOISE_FLOOR = 1.5 / 255;
const FLOOR_FULL = 0.05; // これより暗い所は下限をそのまま
const FLOOR_TO = 0.12; // これより明るい所は下限なし
const noiseFloor = (y) => NOISE_FLOOR * Math.min(1, Math.max(0, (FLOOR_TO - y) / (FLOOR_TO - FLOOR_FULL)));
const noiseAt = (bins, y) => {
  const f = Math.min(NOISE_BINS - 1, Math.max(0, y * NOISE_BINS * 1.6 - 0.5)); const k = Math.floor(f); const t = f - k;
  return bins[k] * (1 - t) + bins[Math.min(NOISE_BINS - 1, k + 1)] * t;
};

/**
 * Non-Local Means（輝度で似た模様を探して、輝度・色差をまとめて平均する）
 * @param {Float32Array[]} ch [Y, Cb, Cr]
 * @param {Float32Array} sig 各画素のノイズの量
 */
// nlm の中心（重みの計算と足し込み）は WebAssembly（nlm.wasm.js。元の C は scripts/nlm/nlm.c）で。JavaScript より 2 割ほど速く、結果は 1 ビットも変わらない
// （倍精度で計算して 32bit に丸める順番も同じ。exp は V8（Chrome・Edge）の Math.exp と同じ fdlibm の手順）。
// iPhone・iPad は JavaScript で（呼ぶたびに大きなメモリを確保し直すので、メモリの少ない端末では使わない。Safari の Math.exp は fdlibm と最後の桁が違うことがある）
const NLM_BASE = 65536 * 2;
let nlmModule;
function nlmWasm() {
  if (nlmModule === undefined) {
    try { nlmModule = !lowMemory() && typeof WebAssembly === 'object' && WebAssembly.validate(NLM_WASM) ? new WebAssembly.Module(NLM_WASM) : null; } catch { nlmModule = null; }
  }
  return nlmModule;
}
/** テスト用: WebAssembly を使わない */
export function useWasm(on) { nlmModule = on ? undefined : null; }

function nlm(ch, sig, w, h, opts) {
  const mod = nlmWasm();
  if (!mod) return nlmJS(ch, sig, w, h, opts);
  const { R, r = 2, hh = 1, onProgress = () => {} } = opts;
  const n = w * h; const [Y, U, V] = ch;
  // 置き場所（バイト。16 の倍数に）。WebAssembly 自身が使う所（スタックなど。__heap_base まで）の後ろから
  const al = (v) => (v + 15) & ~15;
  const oY = NLM_BASE; const oSrc = al(oY + 4 * n); const oAcc = al(oSrc + 16 * n); const oTmp = al(oAcc + 16 * n);
  const oD2 = al(oTmp + 4 * n); const oCol = al(oD2 + 4 * w); const oBox = al(oCol + 8 * w); const end = al(oBox + 4 * w);
  const memory = new WebAssembly.Memory({ initial: Math.ceil(end / 65536) });
  const { nlm_offset: run, __heap_base: heapBase } = new WebAssembly.Instance(mod, { env: { memory } }).exports;
  if (!(heapBase.value <= NLM_BASE)) throw new Error('nlm.wasm: __heap_base');
  const buf = memory.buffer;
  new Float32Array(buf, oY, n).set(Y);
  const src = new Float32Array(buf, oSrc, 4 * n); const acc = new Float32Array(buf, oAcc, 4 * n);
  for (let i = 0; i < n; i++) { acc[4 * i] = src[4 * i] = Y[i]; acc[4 * i + 1] = src[4 * i + 1] = U[i]; acc[4 * i + 2] = src[4 * i + 2] = V[i]; acc[4 * i + 3] = 1; src[4 * i + 3] = Math.max(1e-8, sig[i] * sig[i]); }
  const total = (R + 1) * (2 * R + 1) - R - 1; let done = 0;
  for (let dy = 0; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dy === 0 && dx <= 0) continue;
      run(w, h, r, hh * hh, dx, dy, oY, oSrc, oAcc, oTmp, oD2, oCol, oBox);
      done++;
    }
    onProgress(done / total);
  }
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { const ws = acc[4 * i + 3]; out[0][i] = acc[4 * i] / ws; out[1][i] = acc[4 * i + 1] / ws; out[2][i] = acc[4 * i + 2] / ws; }
  return out;
}

function nlmJS(ch, sig, w, h, { R, r = 2, hh = 1, onProgress = () => {} }) {
  const n = w * h; const [Y, U, V] = ch;
  // 足し込む先（輝度・色差 2 つ・重みの和）と、読む元（輝度・色差 2 つ）を、画素ごとに並べて持つ（メモリを読む場所が近くなって速い。値は同じ）
  const acc = new Float32Array(n * 4); const src = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { acc[4 * i] = src[4 * i] = Y[i]; acc[4 * i + 1] = src[4 * i + 1] = U[i]; acc[4 * i + 2] = src[4 * i + 2] = V[i]; acc[4 * i + 3] = 1; src[4 * i + 3] = Math.max(1e-8, sig[i] * sig[i]); }
  // 差の 2 乗の平均（boxBlur と同じ計算・同じ順番）。横は 1 行ずつ、縦は行ごとに求めて、すぐ重みに使う（大きな配列を何度も読み書きしない）
  const d2 = new Float32Array(w); const tmp = new Float32Array(n); const col = new Float64Array(w); const box = new Float32Array(w);
  const total = (R + 1) * (2 * R + 1) - R - 1; let done = 0;
  const hr = Math.min(r, w - 1); const k = 2 * r + 1; const h2 = hh * hh;
  for (let dy = 0; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dy === 0 && dx <= 0) continue;
      for (let y = 0; y < h; y++) {
        const qy = Math.min(h - 1, y + dy); const o = y * w; const oq = qy * w;
        for (let x = 0; x < w; x++) { const qx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx; const d = Y[o + x] - Y[oq + qx]; d2[x] = d * d; }
        hsum(d2, tmp, o, w, r, hr, k);
      }
      col.fill(0);
      for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
      const x0 = Math.max(0, -dx); const x1 = Math.min(w, w - dx);
      for (let y = 0; y < h - dy; y++) {
        const y1 = y + r; const y0 = y - r - 1; const cnt = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
        vsum(tmp, col, box, w, y > 0 && y1 < h ? y1 * w : -1, y > 0 && y0 >= 0 ? y0 * w : -1, cnt);
        const o = y * w; const oq = (y + dy) * w + dx;
        for (let x = x0; x < x1; x++) {
          const p = 4 * (o + x); const q = 4 * (oq + x);
          // 同じ模様なら、差の 2 乗の平均はノイズの量の 2 倍くらいになる。それを超えた分だけ似ていないとみなす
          const D = (box[x] / (0.5 * (src[p + 3] + src[q + 3])) - 2) / h2;
          if (D >= 6) continue;
          const wt = Math.exp(-(D > 0 ? D : 0));
          acc[p + 3] += wt; acc[q + 3] += wt;
          acc[p] += wt * src[q]; acc[q] += wt * src[p];
          acc[p + 1] += wt * src[q + 1]; acc[q + 1] += wt * src[p + 1];
          acc[p + 2] += wt * src[q + 2]; acc[q + 2] += wt * src[p + 2];
        }
      }
      done++;
    }
    onProgress(done / total);
  }
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { const ws = acc[4 * i + 3]; out[0][i] = acc[4 * i] / ws; out[1][i] = acc[4 * i + 1] / ws; out[2][i] = acc[4 * i + 2] / ws; }
  return out;
}

// 8 個を小さい順に（19 回の比べて入れ替え）
const NET8 = [0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7, 0, 1, 2, 3, 4, 5, 6, 7, 2, 4, 3, 5, 1, 4, 3, 6, 1, 2, 3, 4, 5, 6];
function sort8(s) {
  for (let k = 0; k < NET8.length; k += 2) { const a = s[NET8[k]]; const b = s[NET8[k + 1]]; if (b < a) { s[NET8[k]] = b; s[NET8[k + 1]] = a; } }
}
// まわり 8 画素のどれよりも t 以上はずれているか
function outside(img, i, iw, t) {
  const a = img[i - iw - 1]; const b = img[i - iw]; const c = img[i - iw + 1]; const d = img[i - 1]; const e = img[i + 1]; const f = img[i + iw - 1]; const g = img[i + iw]; const k = img[i + iw + 1];
  const mx = Math.max(a, b, c, d, e, f, g, k); const mn = Math.min(a, b, c, d, e, f, g, k); const v = img[i];
  return v > mx + t || v < mn - t;
}

/**
 * ぽつんと飛び出した点（明るい・暗い小さな点）を消す。似た模様が見つからないので Non-Local Means では消えずに、
 * 明るくすると目立つ。高感度の点は JPEG で 2〜3 画素ににじんでいるので、
 * 1 画素の点は元の大きさで、2〜3 画素の点は半分に縮めた絵で探す。
 * まわり 8 画素のどれよりも、ノイズの 3 倍以上はずれているときだけ直す（細い線や光の点は、となりにも同じ明るさがあるので残る）。
 * まわりよりノイズの SPOT_MAX 倍以上明るい点は、2〜3 画素の小さな光の点（目の光など）なので残す
 */
function removeSpeckles(ch, w, h, profile) {
  const [Y, Cb, Cr] = ch; const nb = new Float32Array(8);
  // 輝度だけでなく色差も調べる（赤や青の 1 点は、明るさの差は小さくても、色ムラ除去でにじんで灰色の点になる）
  const find = (chs, iw, ih, bins) => {
    const hits = []; const [A, B, C] = chs; const s = new Float64Array(8);
    for (let y = 1; y < ih - 1; y++) for (let x = 1; x < iw - 1; x++) {
      const i = y * iw + x;
      // 輝度: まわり 8 画素を並べて（並べ替えの網。Float32Array の sort と同じ並びになる）、中央の 2 つと最小・最大
      s[0] = A[i - iw - 1]; s[1] = A[i - iw]; s[2] = A[i - iw + 1]; s[3] = A[i - 1]; s[4] = A[i + 1]; s[5] = A[i + iw - 1]; s[6] = A[i + iw]; s[7] = A[i + iw + 1];
      sort8(s);
      const med = (s[3] + s[4]) / 2;
      let t = 3 * noiseAt(bins, s[4]); const v = A[i];
      // ノイズよりずっと明るい点は、光の点（ティアラ・目の光）なので残す
      if (v - med > SPOT_MAX * t / 3) continue;
      let hit = v > s[7] + t || v < s[0] - t;
      if (!hit) {
        t = 4 * noiseAt(bins, v);
        hit = outside(B, i, iw, t) || outside(C, i, iw, t);
      }
      if (hit) hits.push(x, y, med);
    }
    return hits;
  };
  // 直す: 範囲の輝度を中央値に、色差を範囲のまわりの平均に
  const fill = (x0, y0, s, val) => {
    let cb = 0; let cr = 0; let n = 0;
    for (let y = y0 - 1; y <= y0 + s; y++) for (let x = x0 - 1; x <= x0 + s; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s)) continue;
      cb += Cb[y * w + x]; cr += Cr[y * w + x]; n++;
    }
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + s); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + s); x++) {
      const i = y * w + x; Y[i] = val; if (n) { Cb[i] = cb / n; Cr[i] = cr / n; }
    }
  };
  const one = find(ch, w, h, profile[0]);
  for (let j = 0; j < one.length; j += 3) fill(one[j], one[j + 1], 1, one[j + 2]);
  const w2 = (w + 1) >> 1; const h2 = (h + 1) >> 1;
  const two = find(ch.map((c) => down2(c, w, h)), w2, h2, profile[1]);
  // 半分の大きさの 1 画素 = 元の 2×2。にじみの分、まわり 1 画素も含めて 4×4 を直す
  for (let j = 0; j < two.length; j += 3) fill(two[j] * 2 - 1, two[j + 1] * 2 - 1, 4, two[j + 2]);
}

/**
 * ノイズを取ったあとに残った小さな点（2〜4 画素の、明るい・暗い点）を消す。
 * 高感度の粒は JPEG で 2〜4 画素の塊やすじになり、Non-Local Means では似た模様が見つからずにそのまま残る。明るくすると目立つ。
 * 半径 2 の輪（16 画素）の中央値より、ノイズの量と輪のばらつきに比べてはっきり明るい（暗い）画素を、輪の明るさに寄せる。
 * - 細い線（髪・レースの糸）は残す: 向かい合う 2 画素がどちらも中心に近い組があれば、線が中心を通っている
 * - 光の点（ティアラ・ネックレス・目の光）は残す: ずれがノイズの SPOT_MAX 倍より大きいものは直さない
 * 元の大きさで 1〜3 画素の点を、半分の大きさで 2〜4 画素の点を探す。Y0（ノイズ除去の前）も同じ値にして、きめを戻すときに点が戻らないようにする
 */
const SPOT_K = 1; // ノイズの量の何倍ずれたら点とみなすか（強さ 1 のとき）
const SPOT_IQR = 0.7; // 輪のばらつき（四分位範囲）の何倍を足すか（模様のある所では点とみなしにくく）
const SPOT_MAX = 8;
function removeSpots(Y, Y0, w, h, profile, nr) {
  const ring = new Float32Array(16); const k = SPOT_K / Math.max(0.25, nr);
  const pass = (img, iw, ih, s, bins) => {
    const RING = [[-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [2, -1], [2, 0], [2, 1]].map(([dx, dy]) => dy * iw + dx); // 残りの 8 画素は向かい側
    const fixes = [];
    for (let y = 2; y < ih - 2; y++) for (let x = 2; x < iw - 2; x++) {
      const i = y * iw + x; const v = img[i];
      // 向かい合う 2 画素の組ごとに、中心から遠い方の明るさを比べる（lo: 明るい点を調べるとき、hi: 暗い点のとき）
      let lo = -Infinity; let hi = Infinity;
      for (let j = 0; j < 8; j++) {
        const a = img[i + RING[j]]; const c = img[i - RING[j]]; ring[j] = a; ring[j + 8] = c;
        lo = Math.max(lo, Math.min(a, c)); hi = Math.min(hi, Math.max(a, c));
      }
      const sg = noiseAt(bins, v); const t0 = k * sg;
      if (v - lo <= t0 / 2 && hi - v <= t0 / 2) continue;
      ring.sort(); const med = (ring[7] + ring[8]) / 2;
      const d = v - med; const ad = Math.abs(d); const t = t0 + SPOT_IQR * (ring[12] - ring[3]);
      // 線なら、どこかの組の 2 画素がどちらも、中心と中央値の中ほどより中心側にある
      if (ad > t && ad < SPOT_MAX * sg && (d > 0 ? lo < med + d / 2 : hi > med + d / 2)) fixes.push(x, y, med, d > 0 ? t / 2 : -t / 2, ad);
    }
    // 点とそのまわり 1 画素（にじみ）のうち、同じ向きにずれた画素を直す（点よりずっと明るい・暗い画素は、となりの光の点なので残す）
    for (let j = 0; j < fixes.length; j += 5) {
      const x = fixes[j]; const y = fixes[j + 1]; const med = fixes[j + 2]; const t = fixes[j + 3]; const lim = fixes[j + 4] * 1.25;
      for (let yy = Math.max(0, y * s - 1); yy < Math.min(h, y * s + s + 1); yy++) for (let xx = Math.max(0, x * s - 1); xx < Math.min(w, x * s + s + 1); xx++) {
        const p = yy * w + xx; const d = Y[p] - med;
        if ((t > 0 ? d > t : d < t) && Math.abs(d) <= lim) { Y[p] = med + t; Y0[p] = Y[p]; }
      }
    }
  };
  pass(Y, w, h, 1, profile[0]);
  pass(down2(Y, w, h), (w + 1) >> 1, (h + 1) >> 1, 2, profile[1]);
}

/**
 * 段ごとにノイズを取る。細かい粒は元の大きさで、大きな粒は半分・4 分の 1 の大きさの絵で。
 * 各段では、その段で測ったノイズの量を使う（縮めると細かい粒は平均されて消え、大きな粒だけが残る）
 * @param {Float32Array[][]} profile measureNoise の結果
 * @param {number} nr 強さ（1 が標準）
 */
export function denoise(ch, w, h, { profile, nr = 1, level = 0, onProgress = () => {} }) {
  const bins = profile[level]; const sm = boxBlur(ch[0], w, h, 3); const sig = new Float32Array(w * h);
  // 粗い段ほど控えめに（細部を薄くしない）。粗い段（半分・4 分の 1）を強くならすと、肌のゆるやかなむら・髪の束・生地のしわまで消えて、
  // 縮めて見たときに絵の具でなでたような面になる（イラストのように見える）。残った大きな粒は、足す粒にまぎれて写真らしく見える
  const k = nr * [0.75, 0.4, 0.25][level];
  for (let i = 0; i < sig.length; i++) sig[i] = noiseAt(bins, sm[i]) * k;
  const last = level >= LEVELS - 1 || Math.min(w, h) < 32;
  const share = last ? 1 : 0.75;
  const d = nlm(ch, sig, w, h, { R: level === 0 ? 4 : 3, onProgress: (t) => onProgress(t * share) });
  if (last) return d;
  const w2 = (w + 1) >> 1; const h2 = (h + 1) >> 1;
  const lo = d.map((c) => down2(c, w, h));
  const lod = denoise(lo, w2, h2, { profile, nr, level: level + 1, onProgress: (t) => onProgress(share + (1 - share) * t) });
  // 細かい成分（d - up(lo)）は残して、大きな成分だけを、より強くならした方に置き換える
  return d.map((c, j) => {
    const a = up2(lo[j], w2, h2, w, h); const b = up2(lod[j], w2, h2, w, h);
    for (let i = 0; i < c.length; i++) c[i] += b[i] - a[i];
    return c;
  });
}

/** 色のムラ（色ノイズ）を、輝度の輪郭に沿って広くならす。半径は写真全体の大きさに合わせる */
export function cleanChroma(Y, Cb, Cr, w, h, { nr = 1, radius }) {
  const eps = (0.012 * nr) ** 2;
  return [guided(Y, Cb, w, h, radius, eps), guided(Y, Cr, w, h, radius, eps)];
}
export const chromaRadius = (fullW, fullH) => Math.max(3, Math.min(BAND_MARGIN / 2 - 4, Math.round(Math.min(fullW, fullH) / 250))); // ガイデッドフィルターは半径の 2 倍先まで届くので、帯の余分な行に収まるように

// ───────── 明るさ ─────────
const logLum = (r, g, b) => Math.log(0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b) + 1e-4);

/**
 * 明るさの曲線を決める。小さく縮めた写真（長い辺 512 くらい）から、明るさの大きな流れ（ベース）と倍率・白の押さえを求める
 * @param {{width:number,height:number,data:Uint8ClampedArray}} small
 * @param {number} light 0〜100（50 で自動の狙いどおり）
 */
/**
 * @param {{m:Float32Array,w:number,h:number}|null} [o.person] 人物の地図（0〜1。skinseg.js の personSeg）。
 *   人物（肌・衣装・髪）と背景で、照明の色の直し方を変える。ないときは、その間
 */
export function planTone(small, light, { person = null, sat = SAT_EXP, target = TARGET, wbPerson = WB_PERSON, wbBack = WB_BACK } = {}) {
  const { width: w, height: h, data } = small; const n = w * h;
  const logL = new Float32Array(n);
  for (let i = 0; i < n; i++) logL[i] = logLum(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255);
  const r = Math.max(2, Math.round(Math.min(w, h) / 40));
  const { a, b } = guidedCoef(logL, logL, w, h, r, 0.05 ** 2 * 4);
  let mean = 0; for (let i = 0; i < n; i++) mean += a[i] * logL[i] + b[i]; mean /= n;
  // 自動の倍率: ベースの平均の明るさが TARGET くらい（明るい場所で撮った写真の肌に近い明るさ）になるように。12 倍まで
  const auto = Math.min(12, Math.max(1, target / Math.exp(mean)));
  const gain = Math.min(16, Math.exp(Math.log(auto) * light / 50) * (1 + light / 400));
  // 白い所が飛ばないよう、明るい側を押さえる（いちばん明るい 0.1% の明るさが、白より少し手前に来るように。白い衣装のレースの模様を残す）
  const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = Math.exp(logL[i]);
  L.sort(); const p999 = L[Math.floor(n * 0.999)];
  const white = Math.max(0.25, gain * p999 * 1.1);
  return { w, h, a, b, gain, white, hiY: toSrgb(0.55 * p999), wb: whiteBalance(data, n, wbBack), wbP: whiteBalance(data, n, wbPerson), sat, person: person && smoothMask(person) };
}

/**
 * 人物の地図を整える。AI が見落とした小さな穴（衣装の暗い帯など）を埋めてから（いちばん大きい値で広げて、小さい値で縮める）、
 * 境目を少しぼかす（髪の縁などで、色の直し方が急に変わらないように）
 */
function smoothMask({ m, w, h }) {
  const r = Math.max(2, Math.round(Math.max(w, h) / 80));
  const closed = rank(rank(m, w, h, r, Math.max), w, h, r, Math.min);
  return { m: boxBlur(boxBlur(closed, w, h, 2), w, h, 2), w, h };
}
/** 縦横 (2r+1) の範囲の、いちばん大きい（小さい）値 */
function rank(src, w, h, r, pick) {
  const f = pick === Math.max ? rowMax : pick === Math.min ? rowMin : null;
  const tmp = new Float32Array(w * h); const out = new Float32Array(w * h);
  if (!f) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = src[y * w + x]; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]); tmp[y * w + x] = v; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = tmp[y * w + x]; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]); out[y * w + x] = v; }
    return out;
  }
  // 横は 1 行ずつ、縦は行どうしで（最大・最小は、比べる順番によらず同じ値になる）
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tmp[y * w + x] = f(src, y * w, Math.max(0, x - r), Math.min(w - 1, x + r), 1);
  const ext = pick === Math.max;
  for (let y = 0; y < h; y++) {
    const o = y * w; out.set(tmp.subarray(o, o + w), o);
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
      const q = k * w;
      if (ext) for (let x = 0; x < w; x++) out[o + x] = Math.max(out[o + x], tmp[q + x]);
      else for (let x = 0; x < w; x++) out[o + x] = Math.min(out[o + x], tmp[q + x]);
    }
  }
  return out;
}
function rowMax(a, o, k0, k1) { let v = a[o + k0]; for (let k = k0 + 1; k <= k1; k++) v = Math.max(v, a[o + k]); return v; }
function rowMin(a, o, k0, k1) { let v = a[o + k0]; for (let k = k0 + 1; k <= k1; k++) v = Math.min(v, a[o + k]); return v; }

/**
 * 照明の色を直す倍率（R・G・B）。白飛びしていない明るい所（上位 5%。白い衣装など）を白とみなして照明の色を測る。
 * 照明の色は、色温度（青 ⇔ 電球の琥珀）と色かぶり（緑 ⇔ 赤紫）に分けて、どれだけ戻すかを決める。
 * - 人物（肌・衣装）: どちらも 3 割だけ白に戻す。肌は明るく自然に、白い衣装は白に近く
 * - 背景（カーテンなど）: 色かぶり（暗い所で出やすい赤紫）だけ戻し、琥珀色は残す。
 *   同じ舞台を明るく撮った写真（IMG_9228）のカーテンの色。戻しすぎると灰色っぽく（ドライに）見える
 */
// 2026-10-26: プロのステージ写真（白い衣装が白、肌は淡いピンク、髪は黒）に寄せる。
// - 人物: 琥珀色をほぼ白に戻す（0.3 ではオレンジの肌・クリーム色の衣装のまま）。色かぶりは全部戻す
// - 背景: 琥珀色を半分戻す（0 のままでは人物だけ白くなって浮く。全部戻すと灰色のカーテンでドライ）
const WB_PERSON = { tint: 1, temp: 0.6 };
// 2026-10-26 ユーザー「元の写真の色味が失われ過ぎている」→ 背景の琥珀はほぼ残す（3 割 → 1 割）
const WB_BACK = { tint: 1, temp: 0.1 };
// 明るくした倍率 k に対して、色の濃さ（明るさとの差）を k^SAT_EXP 倍にする（1 で元の色のまま明るく）。
// 1 では暗い舞台の赤い照明の肌が、明るくするぶんだけ赤く濃くなる（a* 30〜40。明るい場所の写真は 10〜20）。
// 抑えるのは人物の暖色（赤 ≥ 緑 ≥ 青: 肌・琥珀の照明が当たった所）だけ。青い衣装・緑のリボン・背景は元の濃さのまま明るくする
const SAT_EXP = 0.8;
// 黒の下限（リニア）。暗い写真を明るくすると黒（髪・レース・幕の影）まで持ち上がって灰色に浮く。この分を引いて黒を締める
const BLACK = 0.012;
// 中間の明るさのメリハリ（1 で変えない）。局所的な明るさの補正（ベース）は平らになりがちなので、少しだけ全体に戻す
const CONTRAST = 1.06;
const TARGET = 0.12; // 自動の明るさの狙い（ベースの平均、リニア）。0.16 では顔が同じ舞台を明るく撮った写真（IMG_9228）より 3 割明るく、光の頬が飛んで平らに見えた
const KNEE = 0.65; // いちばん明るい色（リニア）がこれを超えたら、なだらかに押さえはじめる（2 - KNEE で白に届く）
function whiteBalance(data, n, amount) {
  const lum = new Float32Array(n); const lin = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) lin[i * 3 + c] = toLinear(data[i * 4 + c] / 255);
    lum[i] = 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2];
  }
  const th = Float32Array.from(lum).sort()[Math.floor(n * 0.95)];
  const m = [0, 0, 0]; let k = 0;
  for (let i = 0; i < n; i++) {
    if (lum[i] < th || data[i * 4] > 250 || data[i * 4 + 1] > 250 || data[i * 4 + 2] > 250) continue;
    for (let c = 0; c < 3; c++) m[c] += lin[i * 3 + c]; k++;
  }
  if (k < 20 || m.some((v) => !(v > 0))) return [1, 1, 1];
  // 照明の色を 2 つに分ける: 色温度（青 ⇔ 琥珀）と、色かぶり（緑 ⇔ 赤紫）
  const mid = Math.sqrt(m[0] * m[2]);
  const tint = [1, mid / m[1], 1]; // 緑を赤と青の間にそろえる倍率
  const temp = [mid / m[0], 1, mid / m[2]]; // 赤と青をそろえる倍率
  const g = [0, 1, 2].map((c) => Math.min(3, Math.max(1 / 3, tint[c] ** amount.tint * temp[c] ** amount.temp)));
  const Lg = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]; // 明るさは変えない
  return g.map((v) => v / Lg);
}

/** 縮めた絵の係数を、帯の画素の位置で読む（双一次補間） */
function sampleGrid(g, gw, gh, fx, fy) {
  const x = Math.min(gw - 1, Math.max(0, fx)); const y = Math.min(gh - 1, Math.max(0, fy));
  const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(gw - 1, x0 + 1); const y1 = Math.min(gh - 1, y0 + 1); const tx = x - x0; const ty = y - y0;
  return (g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x1] * tx) * (1 - ty) + (g[y1 * gw + x0] * (1 - tx) + g[y1 * gw + x1] * tx) * ty;
}

/**
 * 輝度・色差（ノイズを取ったもの）を明るくして 8bit の RGBA にする
 * @param {object|null} tone planTone の結果（null なら明るさは変えない）
 * @param {{y0:number,fullW:number,fullH:number}} at この帯が写真全体のどこか
 */
export function applyTone(Y, Cb, Cr, w, h, tone, at, out = new Uint8ClampedArray(w * h * 4)) {
  const sx = tone ? tone.w / at.fullW : 0; const sy = tone ? tone.h / at.fullH : 0;
  const Wp2 = tone ? tone.white * tone.white : 1;
  for (let y = 0; y < h; y++) {
    const gy = (at.y0 + y + 0.5) * sy - 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const yy = Y[i]; const r0 = yy + Cr[i]; const b0 = yy + Cb[i]; const g0 = (yy - 0.299 * r0 - 0.114 * b0) / 0.587;
      let r = toLinear(r0); let g = toLinear(g0); let bl = toLinear(b0);
      if (tone) {
        // 人物と背景で、照明の色の直し方を変える（人物の地図がないときは、その間）
        const p = tone.person ? sampleGrid(tone.person.m, tone.person.w, tone.person.h, (x + 0.5) * tone.person.w / at.fullW - 0.5, (at.y0 + y + 0.5) * tone.person.h / at.fullH - 0.5) : 0.5;
        r *= tone.wb[0] + (tone.wbP[0] - tone.wb[0]) * p; g *= tone.wb[1] + (tone.wbP[1] - tone.wb[1]) * p; bl *= tone.wb[2] + (tone.wbP[2] - tone.wb[2]) * p;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl; const lg = Math.log(L + 1e-4);
        const gx = (x + 0.5) * sx - 0.5;
        // ベース（明るさの大きな流れ）。縮めた絵の係数を、この画素の明るさに当てる（輪郭は元の大きさのまま保たれる）
        const base = sampleGrid(tone.a, tone.w, tone.h, gx, gy) * lg + sampleGrid(tone.b, tone.w, tone.h, gx, gy);
        const xb = Math.max(0, Math.exp(base) - 1e-4) * tone.gain;
        const yb = xb * (1 + xb / Wp2) / (1 + xb); // ベースだけを曲線に通す
        const Lo = yb * Math.exp(lg - base); // 細かい模様（ディテール）はそのまま
        // 照明の色（舞台の暖かさ）は残す。色の濃さは SAT_EXP で決める
        const k = Lo / (L + 1e-4);
        const warm = r >= g && g >= bl ? p : 0; // 人物の暖色だけ色の濃さを抑える
        const kc = k > 1 && warm > 0 ? k ** (1 - (1 - tone.sat) * warm) : k;
        r = Lo + (r - L) * kc; g = Lo + (g - L) * kc; bl = Lo + (bl - L) * kc;
        // いちばん明るい色（舞台の照明の下の肌では赤）が白に近づいたら、3 色を同じ割合でなだらかに押さえる。
        // 1 を超えた分を白に寄せると、光の当たった頬だけが白っぽく平らに抜けて、頬の丸み（立体感）が消える（IMG_9263）
        const mx = Math.max(r, g, bl);
        if (mx > KNEE) { const u = Math.min(1, (mx - KNEE) / (2 * (1 - KNEE))); const q = (KNEE + (1 - KNEE) * u * (2 - u)) / mx; r *= q; g *= q; bl *= q; }
        // 黒を締める: v → v²/(v + BLACK)。BLACK より十分明るい所は v − BLACK とほぼ同じで、黒のそばは 0 に向かってなだらかに
        // 縮む（一律に引いて 0 で切ると、暗い所の 1〜2 階調の塊が逆に目立つ）。3 色とも同じ式なので色みは変わらない
        r = r * r / (r + BLACK); g = g * g / (g + BLACK); bl = bl * bl / (bl + BLACK);
        // 中間の明るさのメリハリを少し足す（中間の灰色 0.18 を中心に、明るさだけ CONTRAST 乗。3 色を同じ倍率にするので色みは変わらない）
        const Lc = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        if (Lc > 1e-5) { const f = (Lc / 0.18) ** (CONTRAST - 1); r *= f; g *= f; bl *= f; }
      }
      // 8bit にするとき、ごく弱いディザ（位置で決まるので、帯に分けても同じ）
      const p = (at.y0 + y) * at.fullW + x;
      let d = ((((p * 2654435761) >>> 0) / 4294967296) - 0.5) / 255;
      if (at.grain) {
        // 細かい粒（位置で決まる）
        const lv = Math.min(1, Math.max(0, toSrgb(0.2126 * r + 0.7152 * g + 0.0722 * bl)));
        d += grainAt(p, at.fullW) * at.grain / 255 * 4 * lv * (1 - lv);
      }
      out[i * 4] = 255 * (toSrgb(r) + d) + 0.5;
      out[i * 4 + 1] = 255 * (toSrgb(g) + d) + 0.5;
      out[i * 4 + 2] = 255 * (toSrgb(bl) + d) + 0.5;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/**
 * 1 本の帯を処理する（Worker の中で呼ぶ）
 * @param {{width:number,height:number,data:Uint8ClampedArray}} band 上下に余分な行を含む帯
 * @param {{top:number,bottom:number,y0:number,fullW:number,fullH:number}} at
 *   top・bottom: 帯のうち、余分な行を除いた範囲（帯の中の行番号）。y0: 帯の 1 行目が写真全体の何行目か
 * @param {{nr:number,profile:Float32Array[]|null,tone:object|null,grain?:boolean,fine?:boolean}} o
 *   fine: false で、取った成分のうち細かい粒（肌のきめ）を戻さない。ブレ補正の AI は、戻した粒をブレの模様と見て、
 *   頬に筋やゆがみを作る（IMG_9242・9345）。また、ブレ補正を効かせる所（まわりのばらつきが大きい所）が平らな肌にまで広がる
 * @returns {Uint8ClampedArray} top〜bottom の行の RGBA
 */
export function enhanceBand(band, at, { nr, profile, tone, grain = true, fine: keepFine = true }, onProgress = () => {}) {
  const { width: w, height: h, data } = band;
  let [Y, Cb, Cr] = toYCC(data, w, h);
  if (nr > 0 && profile) {
    removeSpeckles([Y, Cb, Cr], w, h, profile);
    const Y0 = Float32Array.from(Y);
    [Y, Cb, Cr] = denoise([Y, Cb, Cr], w, h, { profile, nr, onProgress: (t) => onProgress(t * 0.9) });
    removeSpots(Y, Y0, w, h, profile, nr);
    smoothSteps(Y, w, h, profile[0], nr);
    for (let k = 0; k < EDGE_PASSES; k++) smoothAlongEdges(Y, w, h, profile[0]);
    [Cb, Cr] = cleanChroma(Y, Cb, Cr, w, h, { nr, radius: chromaRadius(at.fullW, at.fullH) });
    // 明るさのざらつきは少しだけ戻す（全部取ると肌・指・レースがろう細工のようになる。色のムラは戻さない）
    // 取った成分の強さが、ノイズの量よりはっきり大きい所を「模様」とみなす
    const res = new Float32Array(Y.length); for (let i = 0; i < Y.length; i++) { const d = Y0[i] - Y[i]; res[i] = d * d; }
    const energy = boxBlur(res, w, h, 3); const k = 1 / Math.max(1, nr);
    // 取った成分のうち、1〜2 画素のごく細かい粒（肌のきめ）。にじんだ大きな粒（ノイズのムラ）は戻さない
    for (let i = 0; i < Y.length; i++) res[i] = Y0[i] - Y[i];
    const fine = boxBlur(boxBlur(res, w, h, 1), w, h, 1); for (let i = 0; i < Y.length; i++) fine[i] = res[i] - fine[i];
    const fg = fineScale(tone);
    const pm = tone && tone.person; const px = pm ? pm.w / at.fullW : 0; const py = pm ? pm.h / at.fullH : 0;
    for (let y = 0, i = 0; y < h; y++) {
      const gy = (at.y0 + y + 0.5) * py - 0.5;
      for (let x = 0; x < w; x++, i++) {
        const s = Math.max(noiseFloor(Y[i]), noiseAt(profile[0], Y[i])); const t = Math.min(1, Math.max(0, (energy[i] / (s * s + 1e-8) - 1.3) / 1.5));
        const kk = (KEEP_FLAT + (KEEP_TEXTURE - KEEP_FLAT) * t) * k;
        // 細かい粒は戻す（人物は全部、背景は少し。人物の地図がなければその間）。真っ暗に近い所（髪・背景の影）は戻さない（黒い点に見える）。
        // とび出た点は戻さない（ノイズの量の 1.5 倍で切る）
        const p = pm ? sampleGrid(pm.m, pm.w, pm.h, (x + 0.5) * px - 0.5, gy) : 0.5;
        const f = !keepFine ? 0 : Math.max(0, FINE_KEEP * fg * (FINE_BACK + (1 - FINE_BACK) * p) * k * Math.min(1, Math.max(0, (Y[i] - FLOOR_FULL) / (FLOOR_TO - FLOOR_FULL))) - kk);
        Y[i] += res[i] * kk + Math.min(1.5 * s, Math.max(-1.5 * s, fine[i])) * f;
      }
    }
    sharpenDetail(Y, w, h, profile, nr, tone ? tone.hiY : HI_Y);
  }
  onProgress(0.95);
  const rows = at.bottom - at.top; const o = at.top * w;
  const out = applyTone(Y.subarray(o, o + rows * w), Cb.subarray(o, o + rows * w), Cr.subarray(o, o + rows * w), w, rows, tone, { y0: at.y0 + at.top, fullW: at.fullW, fullH: at.fullH, grain: grain ? grainFor(nr, profile, tone) : 0 });
  onProgress(1);
  return out;
}

/**
 * ノイズを取ったあとに残る、ゆるやかな面どうしの小さな段差をならす（肌・カーテンが塗り絵のように、平らな面の継ぎはぎに見えるのを防ぐ）。
 * Non-Local Means は似た模様ごとに平均するので、なめらかな明るさの変化が、ノイズより小さな段のついた面に分かれる。
 * まわりのばらつきがノイズの量より小さい所だけ、広い範囲（半径 STEP_R）の平均に寄せる（明るさごとのノイズの量で決める）。
 * 輪郭・模様はばらつきが大きいので、そのまま残る
 */
const STEP_R = 6; // 寄せる先の平均の半径
const STEP_V = 2; // ばらつきを測る半径（小さくして、細い線（髪・糸）を段差と見まちがえないように）
const STEP_K = 1; // ノイズの量の何倍までのばらつきをならすか（強さ 1 のとき）
function smoothSteps(Y, w, h, bins, nr) {
  const n = w * h; const mean = boxBlur(Y, w, h, STEP_V); const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = Y[i] * Y[i];
  const m2 = boxBlur(sq, w, h, STEP_V);
  for (let i = 0; i < n; i++) { const v = Math.max(0, m2[i] - mean[i] * mean[i]); const s = noiseAt(bins, mean[i]) * STEP_K * nr; sq[i] = v / (v + s * s + 1e-10); }
  const a = boxBlur(sq, w, h, STEP_V, m2); const far = boxBlur(Y, w, h, STEP_R, mean);
  for (let i = 0; i < n; i++) Y[i] = a[i] * Y[i] + (1 - a[i]) * far[i];
}

/**
 * 輪郭のギザギザ（髪・耳・あごの縁が、細かい階段や、ちぎれたような縁になる）を、輪郭に沿ってならす。
 * 暗い所のやわらかい輪郭は、ノイズに埋もれているので、Non-Local Means は縁の 1 画素ごとに違う模様を選んで、縁がガタガタになる。
 * 輪郭の向き（明るさの傾きを、まわりで平均して求める）に沿った前後 2 画素の平均に寄せる。輪郭をまたぐ向きには平均しないので、
 * 輪郭のくっきりさと、細い線（髪の毛 1 本）はそのまま残る。向きがそろっていない所（模様・角・平らな所）はそのまま
 */
const EDGE_K = 1; // 寄せる強さ（向きがそろった、はっきりした輪郭で）
const EDGE_PASSES = 2; // 何回くり返すか（1 回では、前髪の縁などの大きな段が残る）
function smoothAlongEdges(Y, w, h, bins) {
  const n = w * h; const xx = new Float32Array(n); const xy = new Float32Array(n); const yy = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const gx = (Y[y * w + Math.min(w - 1, x + 1)] - Y[y * w + Math.max(0, x - 1)]) / 2;
    const gy = (Y[Math.min(h - 1, y + 1) * w + x] - Y[Math.max(0, y - 1) * w + x]) / 2;
    xx[i] = gx * gx; xy[i] = gx * gy; yy[i] = gy * gy;
  }
  const a = boxBlur(xx, w, h, 2); const b = boxBlur(xy, w, h, 2); const c = boxBlur(yy, w, h, 2);
  const at = (fx, fy) => {
    fx = Math.min(w - 1, Math.max(0, fx)); fy = Math.min(h - 1, Math.max(0, fy));
    const x0 = Math.floor(fx); const y0 = Math.floor(fy); const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1); const tx = fx - x0; const ty = fy - y0;
    return (Y[y0 * w + x0] * (1 - tx) + Y[y0 * w + x1] * tx) * (1 - ty) + (Y[y1 * w + x0] * (1 - tx) + Y[y1 * w + x1] * tx) * ty;
  };
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const A = a[i]; const B = b[i]; const C = c[i];
    const d = Math.sqrt((A - C) * (A - C) + 4 * B * B); const l1 = (A + C + d) / 2; const l2 = (A + C - d) / 2;
    const coh = ((l1 - l2) / (l1 + l2 + 1e-12)) ** 2;
    // 輪郭の強さ（傾きの大きさ ÷ ノイズの量）。ノイズと同じくらいの傾きは輪郭とみなさない
    const s = Math.sqrt(l1) / (noiseAt(bins, Y[i]) + 1e-6); const str = Math.min(1, Math.max(0, (s - 0.5) / 1));
    const k = EDGE_K * coh * str;
    if (k < 0.02) { out[i] = Y[i]; continue; }
    // 傾きの向き (A-C, 2B) の半分の角度 → それに直交する向きが輪郭に沿う向き
    const th = 0.5 * Math.atan2(2 * B, A - C); const tx = -Math.sin(th); const ty = Math.cos(th);
    const m = (Y[i] * 3 + (at(x + tx, y + ty) + at(x - tx, y - ty)) * 2 + at(x + 2 * tx, y + 2 * ty) + at(x - 2 * tx, y - 2 * ty)) / 9;
    out[i] = Y[i] + k * (m - Y[i]);
  }
  Y.set(out);
}

/**
 * 輪郭と立体感を、元の写真より少しくっきりさせる（ノイズを取ると、髪・目・歯・指の輪郭がやわらかくなり、解像度が落ちたように見える）。
 * 2 つの細かさで、ぼかした絵との差を足す: 細かい輪郭（約 1 画素）と、中くらいの立体感（約 4 画素。髪の束・まぶた・指の境目）。
 * - ノイズの量よりはっきり強い模様だけ（平らな所・肌のなだらかな所にノイズを戻さない）
 * - もともとはっきりした輪郭（明るさの比が大きい所）はほとんど足さない（白い縁・黒い縁が出る）
 * - まわり（7×7）の最小〜最大から少ししかはみ出させない（輪郭の外に縁を作らない）
 * - 白く飛びそうな明るい所（ティアラ・目の光）のまわりは控えめに（光が白い塊になり、黒い縁がつく）
 */
const SHARP_FINE = 0.8; // 細かい輪郭の強さ
const SHARP_MID = 5; // 中くらいの立体感の強さ
const SHARP_MID_R = 4;
const SHARP_OVER = 0.15; // まわりの最小〜最大の幅の何割まではみ出してよいか
// 中くらいの立体感で変えてよい明るさの割合（その画素の明るさの何割まで）。暗い所の小さな黒い部分（瞳・鼻の穴・口の端）は、
// 少し暗くしただけでも明るくすると真っ黒につぶれ、白目は白く浮く（IMG_9263・9365 の目）
const SHARP_MID_CAP = 0.1;
const HI_Y = 0.77; // 明るさを変えないときの「明るい所」（輝度）
function sharpenDetail(Y, w, h, profile, nr, hiY) {
  const amt = Math.min(1, nr); const n = w * h;
  const b1 = boxBlur(boxBlur(Y, w, h, 1), w, h, 1); const b2 = boxBlur(boxBlur(b1, w, h, SHARP_MID_R), w, h, SHARP_MID_R);
  const e1 = new Float32Array(n); const e2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = Y[i] - b1[i]; e1[i] = x * x; const z = b1[i] - b2[i]; e2[i] = z * z; }
  const g1 = boxBlur(e1, w, h, 2); const g2 = boxBlur(e2, w, h, SHARP_MID_R, e1);
  const lo = rank(Y, w, h, 3, Math.min); const hi = rank(Y, w, h, 3, Math.max);
  // 模様の強さ（差の強さ ÷ ノイズの量）で 0〜1、明るさの比（差の強さ ÷ 明るさ）が大きいほど弱く
  const gate = (r, s, t0, t1, base, c0) => { const c = r / (base + 0.02) / c0; return Math.min(1, Math.max(0, (r / s - t0) / t1)) / (1 + c * c); };
  for (let i = 0; i < n; i++) {
    const t1 = gate(Math.sqrt(g1[i]), noiseAt(profile[0], b1[i]), 0.8, 2, b1[i], 0.35);
    const t2 = gate(Math.sqrt(g2[i]), noiseAt(profile[1], b2[i]), 0.7, 1.5, b2[i], 0.5);
    const ph = Math.max(0.1, Math.min(1, (hiY - hi[i]) / (0.5 * hiY)));
    const c = SHARP_MID_CAP * Y[i]; const mid = Math.min(c, Math.max(-c, SHARP_MID * t2 * (b1[i] - b2[i])));
    const v = Y[i] + amt * ph * (SHARP_FINE * t1 * (Y[i] - b1[i]) + mid);
    const o = (hi[i] - lo[i]) * SHARP_OVER;
    Y[i] = Math.min(hi[i] + o, Math.max(lo[i] - o, v));
  }
}

/**
 * 位置で決まる粒（標準偏差 1）。となりの画素と少しつながった粒にする（1 画素ずつばらばらの粒は、デジタルのノイズのようにざらついて見える）。
 * 位置だけで決まるので、帯に分けても同じになる
 */
const GRAIN_K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
const GRAIN_NORM = 1 / 16 / (Math.sqrt(1 / 12) * 0.375); // 一様な乱数（標準偏差 √(1/12)）を GRAIN_K で平均したもの（標準偏差 0.375 倍）を 1 に
function grainAt(p, W) {
  let s = 0; let k = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += GRAIN_K[k++] * (hash(p + dy * W + dx) - 0.5);
  return s * GRAIN_NORM;
}

/**
 * 足す粒の強さ（8bit の標準偏差）。ノイズ軽減の強さ・写真で測ったノイズの量・明るくする倍率で決める
 * @param {Float32Array[]|null} profile measureNoise の結果
 * @param {object|null} tone planTone の結果（null なら明るくしない）
 */
export function grainFor(nr, profile = null, tone = null) {
  if (!(nr > 0)) return 0;
  let s = 0;
  if (profile) { const b = profile[0]; for (let k = 4; k < 8; k++) s += b[k] / 4; } // 中くらいの明るさ（0.21〜0.42）のノイズの量
  // 明るくしたあとのノイズ（8bit）: リニアで gain 倍すると、暗い所の sRGB の値はおよそ gain^0.45 倍になる
  const out = s * 255 * (tone ? tone.gain : 1) ** 0.45;
  return Math.min(1, nr) * Math.min(GRAIN_MAX, Math.max(FILM_GRAIN, GRAIN_REL * out));
}

/**
 * 8bit の RGBA に、applyTone と同じ細かい粒を足す（ブレ補正のあとに足すとき。粒の後にブレ補正を当てると粒が筋になる）
 * @param {{y0:number,fullW:number}} at data の 1 行目が写真全体の何行目か
 */
export function addGrain(data, w, rows, at, grain) {
  if (!(grain > 0)) return data;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; const p = (at.y0 + y) * at.fullW + x;
      const r = data[i] / 255; const g = data[i + 1] / 255; const b = data[i + 2] / 255;
      const lv = toSrgb(0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b));
      const d = grainAt(p, at.fullW) * grain * 4 * lv * (1 - lv);
      data[i] += d; data[i + 1] += d; data[i + 2] += d; // Uint8ClampedArray は代入で四捨五入される
    }
  }
  return data;
}
