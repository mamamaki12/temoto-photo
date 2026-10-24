// 暗い写真の補正（ノイズ除去 → 明るくする）。DOM を使わない純粋な計算（Web Worker・Node のどちらでも動く）。
// ノイズが乗ったまま明るくするとノイズも一緒に増えるので、先にノイズを取ってから明るさを持ち上げる。
//  1. ノイズの量を、明るさごとに写真から測る
//  2. 輪郭を残してノイズだけならす（近くの似た模様どうしを平均する Non-Local Means）。色のムラは輝度を手がかりに広くならす
//  3. 明るさの大きな流れ（ベース）だけを持ち上げ、細かい模様（ディテール）はそのまま残して明るくする
// 色は 8bit sRGB の値（0〜1）を輝度・色差に分けて扱う。

const SRGB_LUT = new Float32Array(4096);
for (let i = 0; i < 4096; i++) { const v = i / 4095; SRGB_LUT[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
const toLinear = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : SRGB_LUT[(v * 4095 + 0.5) | 0]);
const toSrgb = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** 平均化（端は、範囲に入る画素だけで平均する） */
export function boxBlur(src, w, h, r, out = new Float32Array(w * h), tmp = new Float32Array(w * h)) {
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      const x0 = x - r - 1; const x1 = x + r;
      if (x > 0) { if (x1 < w) s += src[o + x1]; if (x0 >= 0) s -= src[o + x0]; }
      tmp[o + x] = s / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  const col = new Float32Array(w);
  for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    if (y > 0) {
      const y1 = y + r; const y0 = y - r - 1;
      if (y1 < h) for (let x = 0; x < w; x++) col[x] += tmp[y1 * w + x];
      if (y0 >= 0) for (let x = 0; x < w; x++) col[x] -= tmp[y0 * w + x];
    }
    const n = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < w; x++) out[y * w + x] = col[x] / n;
  }
  return out;
}

/** ガイデッドフィルター（輪郭を残してなめらかにする。guide の輪郭に沿う） */
export function guided(guide, src, w, h, r, eps) {
  const n = w * h;
  const mI = boxBlur(guide, w, h, r); const mP = boxBlur(src, w, h, r);
  const ip = new Float32Array(n); const ii = new Float32Array(n);
  for (let i = 0; i < n; i++) { ip[i] = guide[i] * src[i]; ii[i] = guide[i] * guide[i]; }
  const mIP = boxBlur(ip, w, h, r); const mII = boxBlur(ii, w, h, r);
  const a = ip; const b = ii;
  for (let i = 0; i < n; i++) {
    const va = mII[i] - mI[i] * mI[i]; const cov = mIP[i] - mI[i] * mP[i];
    const k = cov / (va + eps); a[i] = k; b[i] = mP[i] - k * mI[i];
  }
  const ma = boxBlur(a, w, h, r); const mb = boxBlur(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ma[i] * guide[i] + mb[i];
  return out;
}

/**
 * 輝度のノイズの量（標準偏差）を、明るさごとに測る。
 * 3×3 のラプラシアン風フィルターの結果の「中央値の絶対偏差」を使うので、模様の多い所に引きずられにくい
 * @returns {{bins:Float32Array, at:(y:number)=>number}}
 */
export function noiseProfile(Y, w, h) {
  const NB = 12; const mean = boxBlur(Y, w, h, 2);
  const lists = Array.from({ length: NB }, () => []);
  const step = 2; // 間引いて数える
  for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
    const i = y * w + x;
    const v = 4 * Y[i] - 2 * (Y[i - 1] + Y[i + 1] + Y[i - w] + Y[i + w]) + (Y[i - w - 1] + Y[i - w + 1] + Y[i + w - 1] + Y[i + w + 1]);
    // 4 - 2*4 + 4 = 0。係数の 2 乗和は 16 + 4*4 + 4 = 36
    const bin = Math.min(NB - 1, Math.max(0, Math.floor(mean[i] * NB * 1.6))); // 暗い側を細かく（0〜0.625）
    lists[bin].push(Math.abs(v));
  }
  const bins = new Float32Array(NB).fill(NaN);
  for (let k = 0; k < NB; k++) {
    const l = lists[k]; if (l.length < 400) continue;
    l.sort((a, b) => a - b);
    bins[k] = l[l.length >> 1] / 0.6745 / 6;
  }
  // 測れなかった所は近くの値で埋める
  let last = NaN; for (let k = 0; k < NB; k++) { if (Number.isNaN(bins[k])) bins[k] = last; else last = bins[k]; }
  last = NaN; for (let k = NB - 1; k >= 0; k--) { if (Number.isNaN(bins[k])) bins[k] = last; else last = bins[k]; }
  for (let k = 0; k < NB; k++) if (!(bins[k] > 0)) bins[k] = 0.01;
  return { bins, at: (y) => { const f = Math.min(NB - 1, Math.max(0, y * NB * 1.6 - 0.5)); const k = Math.floor(f); const t = f - k; return bins[k] * (1 - t) + bins[Math.min(NB - 1, k + 1)] * t; } };
}

/**
 * Non-Local Means（輝度で似た模様を探して、チャンネルをまとめて平均する）
 * @param {Float32Array[]} ch [Y, Cb, Cr]
 * @param {Float32Array} sig 各画素のノイズの量
 */
export function nlm(ch, sig, w, h, { R = 9, r = 2, hh = 1.0, onProgress = () => {} } = {}) {
  const n = w * h; const [Y] = ch;
  const acc = ch.map((c) => Float32Array.from(c)); const wsum = new Float32Array(n).fill(1);
  const d2 = new Float32Array(n); const box = new Float32Array(n); const tmp = new Float32Array(n);
  const s2 = new Float32Array(n);
  for (let i = 0; i < n; i++) s2[i] = Math.max(1e-8, sig[i] * sig[i]);
  const total = (R + 1) * (2 * R + 1) - R - 1; let done = 0;
  for (let dy = 0; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dy === 0 && dx <= 0) continue;
      for (let y = 0; y < h; y++) {
        const qy = Math.min(h - 1, y + dy); const o = y * w; const oq = qy * w;
        for (let x = 0; x < w; x++) { const qx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx; const d = Y[o + x] - Y[oq + qx]; d2[o + x] = d * d; }
      }
      boxBlur(d2, w, h, r, box, tmp);
      const x0 = Math.max(0, -dx); const x1 = Math.min(w, w - dx);
      for (let y = 0; y < h - dy; y++) {
        const o = y * w; const oq = (y + dy) * w + dx;
        for (let x = x0; x < x1; x++) {
          const p = o + x; const q = oq + x;
          // 同じ模様なら、差の 2 乗の平均はノイズの量の 2 倍くらいになる。それを超えた分だけ似ていないとみなす
          const D = (box[p] / (0.5 * (s2[p] + s2[q])) - 2) / (hh * hh);
          if (D >= 8) continue;
          const wt = Math.exp(-(D > 0 ? D : 0));
          wsum[p] += wt; wsum[q] += wt;
          for (let c = 0; c < 3; c++) { const a = acc[c]; const s = ch[c]; a[p] += wt * s[q]; a[q] += wt * s[p]; }
        }
      }
      done++;
    }
    onProgress(done / total);
  }
  return acc.map((a) => { for (let i = 0; i < n; i++) a[i] /= wsum[i]; return a; });
}

/** 2×2 の平均で半分の大きさに */
function down2(c, w, h) {
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
  for (let y = 0; y < h; y++) {
    const fy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(h2 - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5)); const x0 = Math.floor(fx); const x1 = Math.min(w2 - 1, x0 + 1); const tx = fx - x0;
      o[y * w + x] = (c[y0 * w2 + x0] * (1 - tx) + c[y0 * w2 + x1] * tx) * (1 - ty) + (c[y1 * w2 + x0] * (1 - tx) + c[y1 * w2 + x1] * tx) * ty;
    }
  }
  return o;
}

/**
 * 何段階かの大きさでノイズを取る。細かい粒は元の大きさで、大きな粒（高感度ノイズはにじんで大きな粒になる）は
 * 半分・4 分の 1 の大きさの絵で取る。段ごとにノイズの量を測り直す
 */
export function denoise(ch, w, h, { nr = 1, hh = 1, levels = 3, onProgress = () => {} } = {}) {
  const prof = noiseProfile(ch[0], w, h); const sm = boxBlur(ch[0], w, h, 3); const sig = new Float32Array(w * h);
  for (let i = 0; i < sig.length; i++) sig[i] = prof.at(sm[i]) * nr;
  const R = w * h > 600 * 600 ? 9 : 7;
  const d = nlm(ch, sig, w, h, { R, hh, onProgress: (t) => onProgress(t * (levels > 1 ? 0.6 : 1)) });
  if (levels <= 1 || Math.min(w, h) < 64) return d;
  const w2 = (w + 1) >> 1; const h2 = (h + 1) >> 1;
  const lo = d.map((c) => down2(c, w, h));
  const lod = denoise(lo, w2, h2, { nr, hh, levels: levels - 1, onProgress: (t) => onProgress(0.6 + 0.4 * t) });
  // 細かい成分（d - up(lo)）は残して、大きな成分だけを、より強くならした方に置き換える
  return d.map((c, k) => { const a = up2(lo[k], w2, h2, w, h); const b = up2(lod[k], w2, h2, w, h); const o = new Float32Array(c.length); for (let i = 0; i < o.length; i++) o[i] = c[i] - a[i] + b[i]; return o; });
}

/**
 * 暗い写真を補正する
 * @param {Uint8ClampedArray} rgba 入力（書き換えない）
 * @param {object} o { nr: ノイズ除去の強さ(0〜2, 1が標準), gain: 明るさの倍率（0 なら自動）, target: 自動のときの狙い（ベースの平均の明るさ） }
 * @returns {{out: Uint8ClampedArray, info: object}}
 */
export function enhance(rgba, w, h, o = {}, onProgress = () => {}) {
  const { nr = 1, gain = 0, target = 0.12, hh = 1.0 } = o;
  const n = w * h;
  // 輝度・色差（sRGB のまま）
  const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255; const g = rgba[i * 4 + 1] / 255; const b = rgba[i * 4 + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b; Y[i] = y; Cb[i] = b - y; Cr[i] = r - y;
  }
  onProgress(0.01);
  // 1・2. ノイズの量を測って、ノイズを取る
  let [Yd, Cbd, Crd] = nr > 0 ? denoise([Y, Cb, Cr], w, h, { nr, hh, levels: o.levels ?? 3, onProgress: (t) => onProgress(0.02 + t * 0.78) }) : [Y, Cb, Cr];
  // 色のムラ（色ノイズ）は、輝度の輪郭に沿って広くならす
  if (nr > 0) {
    const eps = (0.015 * nr) ** 2;
    Cbd = guided(Yd, Cbd, w, h, 10, eps); Crd = guided(Yd, Crd, w, h, 10, eps);
  }
  onProgress(0.85);
  // 3. 明るくする（リニアの輝度で）
  const R = new Float32Array(n); const G = new Float32Array(n); const B = new Float32Array(n); const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = Yd[i]; const r = y + Crd[i]; const b = y + Cbd[i]; const g = (y - 0.299 * r - 0.114 * b) / 0.587;
    const lr = toLinear(r); const lg = toLinear(g); const lb = toLinear(b);
    R[i] = lr; G[i] = lg; B[i] = lb; L[i] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  }
  const logL = new Float32Array(n);
  for (let i = 0; i < n; i++) logL[i] = Math.log(L[i] + 1e-4);
  const rad = Math.max(8, Math.round(Math.min(w, h) / 40));
  const base = guided(logL, logL, w, h, rad, 0.05 ** 2 * 4);
  // 自動の倍率: ベースの対数平均が target になるように（持ち上げすぎない）
  let mean = 0; for (let i = 0; i < n; i++) mean += base[i]; mean /= n;
  const g0 = gain > 0 ? gain : Math.min(8, Math.max(1, target / Math.exp(mean)));
  // 白い所が飛ばないよう、明るい側を押さえる曲線（拡張ライインハルト）
  const sorted = Float32Array.from(L).sort(); const p995 = sorted[Math.floor(n * 0.995)];
  const Wp = Math.max(0.25, g0 * p995 * 1.0);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const b0 = Math.exp(base[i]) - 1e-4; const dtl = logL[i] - base[i]; // ベースとディテール
    const xb = Math.max(0, b0) * g0;
    const yb = xb * (1 + xb / (Wp * Wp)) / (1 + xb); // ベースだけを曲線に通す
    const Lo = yb * Math.exp(dtl);
    const k = Lo / (L[i] + 1e-4);
    let r = R[i] * k; let g = G[i] * k; let bl = B[i] * k;
    const mx = Math.max(r, g, bl);
    if (mx > 1) { // はみ出したら、色を保ったまま輝度の側へ寄せる
      const Lc = Math.min(1, Lo); const t = Math.min(1, (mx - 1) / mx);
      r += (Lc - r) * t; g += (Lc - g) * t; bl += (Lc - bl) * t;
    }
    // 8bit にするとき、ごく弱いディザ
    const d = (((i * 2654435761) >>> 0) / 4294967296 - 0.5) / 255;
    out[i * 4] = Math.round(255 * Math.min(1, Math.max(0, toSrgb(r) + d)));
    out[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, toSrgb(g) + d)));
    out[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, toSrgb(bl) + d)));
    out[i * 4 + 3] = 255;
  }
  onProgress(1);
  return { out, info: { gain: +g0.toFixed(2), whitePoint: +Wp.toFixed(2) } };
}
