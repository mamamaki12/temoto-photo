// 暗い写真の補正（ノイズ除去 → 明るくする）の計算。DOM を使わない（Web Worker・Node のどちらでも動く）。
// ノイズが乗ったまま明るくするとノイズも一緒に増えるので、先にノイズを取ってから明るさを持ち上げる。
//  1. ノイズの量を、明るさごと・粒の大きさ（段）ごとに写真から測る（measureNoise）
//  2. 輪郭を残してノイズだけならす。細かい粒は元の大きさで、大きな粒は縮めた絵で（denoise）
//     色のムラ（赤緑のまだら）は輝度の輪郭に沿って広くならす（cleanChroma）
//  3. 明るさの大きな流れ（ベース）だけを持ち上げ、細かい模様（ディテール）はそのまま残す（planTone・applyTone）
// 大きな写真は横長の帯に分けて Worker で処理する（enhanceBand）。ノイズの量と明るさの曲線は写真全体で 1 つに決めて
// 全部の帯に渡すので、帯の境目で明るさやなめらかさが変わらない。
// 色は 8bit の値（sRGB・Display P3 とも同じ伝達関数）を 0〜1 にして、輝度・色差に分けて扱う。

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
// ノイズの代わりに足す、細かい粒（1 画素の、色のない粒。フィルムの粒のように均一で、中間の明るさで強い）。8bit の標準偏差
const FILM_GRAIN = 1.5;
const binOf = (y) => Math.min(NOISE_BINS - 1, Math.max(0, Math.floor(y * NOISE_BINS * 1.6))); // 暗い側を細かく（0〜0.625）

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
  const col = new Float64Array(w);
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
  for (let y = 0; y < h; y++) {
    const fy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(h2 - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5)); const x0 = Math.floor(fx); const x1 = Math.min(w2 - 1, x0 + 1); const tx = fx - x0;
      o[y * w + x] = (c[y0 * w2 + x0] * (1 - tx) + c[y0 * w2 + x1] * tx) * (1 - ty) + (c[y1 * w2 + x0] * (1 - tx) + c[y1 * w2 + x1] * tx) * ty;
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
const noiseAt = (bins, y) => {
  const f = Math.min(NOISE_BINS - 1, Math.max(0, y * NOISE_BINS * 1.6 - 0.5)); const k = Math.floor(f); const t = f - k;
  return bins[k] * (1 - t) + bins[Math.min(NOISE_BINS - 1, k + 1)] * t;
};

/**
 * Non-Local Means（輝度で似た模様を探して、輝度・色差をまとめて平均する）
 * @param {Float32Array[]} ch [Y, Cb, Cr]
 * @param {Float32Array} sig 各画素のノイズの量
 */
function nlm(ch, sig, w, h, { R, r = 2, hh = 1, onProgress = () => {} }) {
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
          if (D >= 6) continue;
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
    const hits = [];
    for (let y = 1; y < ih - 1; y++) for (let x = 1; x < iw - 1; x++) {
      const i = y * iw + x; let med = 0; let hit = false;
      for (let c = 0; c < 3; c++) {
        const img = chs[c]; let k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb[k++] = img[i + dy * iw + dx];
        nb.sort();
        if (c === 0) med = (nb[3] + nb[4]) / 2;
        const t = (c === 0 ? 3 : 4) * noiseAt(bins, c === 0 ? nb[4] : chs[0][i]); const v = img[i];
        // ノイズよりずっと明るい点は、光の点（ティアラ・目の光）なので残す
        if (c === 0 && v - med > SPOT_MAX * t / 3) { hit = false; break; }
        if (v > nb[7] + t || v < nb[0] - t) hit = true;
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
  // 粗い段ほど控えめに（細部を薄くしない）
  const k = nr * [0.75, 0.6, 0.5][level];
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
  return { w, h, a, b, gain, white, wb: whiteBalance(data, n, wbBack), wbP: whiteBalance(data, n, wbPerson), sat, person: person && smoothMask(person) };
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
  const tmp = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = src[y * w + x]; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]); tmp[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = tmp[y * w + x]; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]); out[y * w + x] = v; }
  return out;
}

/**
 * 照明の色を直す倍率（R・G・B）。白飛びしていない明るい所（上位 5%。白い衣装など）を白とみなして照明の色を測る。
 * 照明の色は、色温度（青 ⇔ 電球の琥珀）と色かぶり（緑 ⇔ 赤紫）に分けて、どれだけ戻すかを決める。
 * - 人物（肌・衣装）: どちらも 3 割だけ白に戻す。肌は明るく自然に、白い衣装は白に近く
 * - 背景（カーテンなど）: 色かぶり（暗い所で出やすい赤紫）だけ戻し、琥珀色は残す。
 *   同じ舞台を明るく撮った写真（IMG_9228）のカーテンの色。戻しすぎると灰色っぽく（ドライに）見える
 */
const WB_PERSON = { tint: 0.3, temp: 0.3 };
const WB_BACK = { tint: 1, temp: 0 };
const SAT_EXP = 1; // 明るくした倍率 k に対して、色の濃さ（明るさとの差）を k^SAT_EXP 倍にする（1 で元の色のまま明るく）
const TARGET = 0.16; // 自動の明るさの狙い（ベースの平均、リニア）
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
        const k = Lo / (L + 1e-4); const kc = k > 1 ? k ** tone.sat : k;
        r = Lo + (r - L) * kc; g = Lo + (g - L) * kc; bl = Lo + (bl - L) * kc;
        const mx = Math.max(r, g, bl);
        if (mx > 1) { const Lc = Math.min(1, Lo); const t = Math.min(1, (mx - 1) / (mx - Lc + 1e-6)); r += (Lc - r) * t; g += (Lc - g) * t; bl += (Lc - bl) * t; }
      }
      // 8bit にするとき、ごく弱いディザ（位置で決まるので、帯に分けても同じ）
      const p = (at.y0 + y) * at.fullW + x;
      let d = ((((p * 2654435761) >>> 0) / 4294967296) - 0.5) / 255;
      if (at.grain) {
        // 細かい粒（位置で決まる。3 つの乱数の和で、なめらかな山形の分布に）
        const u = hash(p) + hash(p + 0x9e3779b9) + hash(p + 0x7f4a7c15) - 1.5;
        const lv = Math.min(1, Math.max(0, toSrgb(0.2126 * r + 0.7152 * g + 0.0722 * bl)));
        d += u * 2 * at.grain / 255 * 4 * lv * (1 - lv);
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
 * @param {{nr:number,profile:Float32Array[]|null,tone:object|null}} o
 * @returns {Uint8ClampedArray} top〜bottom の行の RGBA
 */
export function enhanceBand(band, at, { nr, profile, tone }, onProgress = () => {}) {
  const { width: w, height: h, data } = band;
  let [Y, Cb, Cr] = toYCC(data, w, h);
  if (nr > 0 && profile) {
    removeSpeckles([Y, Cb, Cr], w, h, profile);
    const Y0 = Float32Array.from(Y);
    [Y, Cb, Cr] = denoise([Y, Cb, Cr], w, h, { profile, nr, onProgress: (t) => onProgress(t * 0.9) });
    removeSpots(Y, Y0, w, h, profile, nr);
    [Cb, Cr] = cleanChroma(Y, Cb, Cr, w, h, { nr, radius: chromaRadius(at.fullW, at.fullH) });
    // 明るさのざらつきは少しだけ戻す（全部取ると肌・指・レースがろう細工のようになる。色のムラは戻さない）
    // 取った成分の強さが、ノイズの量よりはっきり大きい所を「模様」とみなす
    const res = new Float32Array(Y.length); for (let i = 0; i < Y.length; i++) { const d = Y0[i] - Y[i]; res[i] = d * d; }
    const energy = boxBlur(res, w, h, 3); const k = 1 / Math.max(1, nr);
    for (let i = 0; i < Y.length; i++) {
      const s = noiseAt(profile[0], Y[i]); const t = Math.min(1, Math.max(0, (energy[i] / (s * s + 1e-8) - 1.3) / 1.5));
      Y[i] += (Y0[i] - Y[i]) * (KEEP_FLAT + (KEEP_TEXTURE - KEEP_FLAT) * t) * k;
    }
  }
  onProgress(0.95);
  const rows = at.bottom - at.top; const o = at.top * w;
  const out = applyTone(Y.subarray(o, o + rows * w), Cb.subarray(o, o + rows * w), Cr.subarray(o, o + rows * w), w, rows, tone, { y0: at.y0 + at.top, fullW: at.fullW, fullH: at.fullH, grain: nr > 0 ? FILM_GRAIN * Math.min(1, nr) : 0 });
  onProgress(1);
  return out;
}
