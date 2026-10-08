// 美肌（写真館の「肌の仕上げ」）。肌の色の場所を自動で見つけて、元写真の画素（ImageData）を直接書き換える。
// - なめらかに: 肌のムラ（ニキビ跡・毛穴の影・赤み）になる「中くらいの細かさ」だけを平らにし、肌のきめ（細かい質感）は残す
//   （周波数分離: 細かい成分＝きめ はそのまま、粗い成分は「肌の画素だけ」で平均を取るので、髪・眉・目の色が混ざらない）
// - 色むら・赤み: 肌の平均の色より赤いところを、平均に近づける
// - 明るく: 肌だけを、白飛びしないように持ち上げる
// 強さは写真の短い辺に対する割合で決めるので、プレビューと書き出しで同じ見た目になる。

export const PORTRAIT = [['smooth', 'なめらかに'], ['even', '色むら・赤みを整える'], ['bright', '肌を明るく']];

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 横方向の箱型ぼかし（端はくり返し）。src/dst は1チャンネルの配列 */
function boxH(src, dst, W, H, r) {
  const n = 2 * r + 1; const last = W - 1;
  for (let o = 0; o < W * H; o += W) {
    const first = src[o]; const end = src[o + last];
    let sum = first * (r + 1); for (let i = 1; i <= r; i++) sum += src[o + Math.min(i, last)];
    for (let i = 0; i < W; i++) {
      dst[o + i] = sum / n;
      const add = i + r + 1; const sub = i - r;
      sum += (add > last ? end : src[o + add]) - (sub < 0 ? first : src[o + sub]);
    }
  }
}
/** 縦方向の箱型ぼかし。列ごとに飛び飛びに読むと遅いので、行単位で足し引きする */
function boxV(src, dst, W, H, r) {
  const n = 2 * r + 1; const last = H - 1; const sum = new Float64Array(W);
  for (let i = -r; i <= r; i++) { const o = Math.min(Math.max(i, 0), last) * W; for (let x = 0; x < W; x++) sum[x] += src[o + x]; }
  for (let y = 0; y < H; y++) {
    const o = y * W; const ao = Math.min(y + r + 1, last) * W; const so = Math.max(y - r, 0) * W;
    for (let x = 0; x < W; x++) { dst[o + x] = sum[x] / n; sum[x] += src[ao + x] - src[so + x]; }
  }
}
/** 箱型ぼかしを縦横に passes 回（2〜3回でガウスぼかしに近くなる） */
export function boxBlur(plane, W, H, r, passes = 2) {
  if (r < 1) return plane;
  let a = plane; let b = new Float32Array(plane.length);
  for (let p = 0; p < passes; p++) { boxH(a, b, W, H, r); boxV(b, a, W, H, r); }
  return a;
}

/** 肌らしさ（0〜1）。YCbCr で肌の色の範囲にあるか（暗すぎ・灰色・真っ赤な布などは外す） */
export function skinness(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const band = (v, lo, hi, soft) => (v < lo - soft || v > hi + soft ? 0 : v < lo ? (v - lo + soft) / soft : v > hi ? (hi + soft - v) / soft : 1);
  return band(cr, 138, 170, 8) * band(cb, 88, 124, 8) * band(y, 55, 255, 25) * band(cr - cb, 12, 85, 8);
}

/** 肌のマスク（0〜1、W×H）。強さの計算とテストで使う */
export function skinMask(img) {
  const { width: W, height: H, data: d } = img; const m = new Float32Array(W * H);
  for (let i = 0, k = 0; i < m.length; i++, k += 4) m[i] = skinness(d[k], d[k + 1], d[k + 2]);
  return m;
}

const active = (p) => !!p && (p.smooth > 0 || p.even > 0 || p.bright > 0);
export { active as portraitActive };

/** 美肌を当てる。p = { smooth, even, bright }（各 0〜100） */
export function applyPortrait(img, p) {
  if (!active(p)) return;
  const { width: W, height: H, data: d } = img; const S = Math.min(W, H);
  // 肌のある範囲（＋ぼかしの届く余白）だけを切り出して計算する（背景の多い写真ほど速い）
  const full = skinMask(img);
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (let y = 0, i = 0; y < H; y++) {
    let any = false;
    for (let x = 0; x < W; x++, i++) if (full[i] > 0.02) { any = true; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (any) { if (y < y0) y0 = y; y1 = y; }
  }
  if (x1 < 0) return;
  const pad = Math.round(S / 30) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  if (w === W && h === H) { portraitCore(img, p, S, full); return; }
  const sub = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    sub.data.set(d.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1 + 1) * 4), y * w * 4);
    raw.set(full.subarray((y0 + y) * W + x0, (y0 + y) * W + x1 + 1), y * w);
  }
  portraitCore(sub, p, S, raw);
  for (let y = 0; y < h; y++) d.set(sub.data.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * W + x0) * 4);
}

/** S: 元の写真の短い辺（切り出しても、効き方は写真全体の大きさで決める）。raw: 肌らしさ */
function portraitCore(img, p, S, raw) {
  const { width: W, height: H, data: d } = img; const N = W * H;
  // 肌のマスク: 画素単位だと目・まつげの境目がガタつくので、ごく小さくぼかす
  const m = boxBlur(raw.slice(), W, H, Math.max(1, Math.round(S / 900)), 2);
  let msum = 0; for (let i = 0; i < N; i++) msum += m[i];
  if (msum < S * S * 0.002) return; // 肌がほとんど写っていない

  const a = (p.smooth || 0) / 100; const ev = (p.even || 0) / 100; const br = (p.bright || 0) / 100;
  const R = new Float32Array(N); const G = new Float32Array(N); const B = new Float32Array(N);
  for (let i = 0, k = 0; i < N; i++, k += 4) { R[i] = d[k]; G[i] = d[k + 1]; B[i] = d[k + 2]; }

  // 肌の平均の色（色むらを整える目標）
  let cbAvg = 0; let crAvg = 0; let wsum = 0;
  for (let i = 0; i < N; i++) {
    const w = raw[i]; if (w < 0.5) continue;
    cbAvg += w * (128 - 0.168736 * R[i] - 0.331264 * G[i] + 0.5 * B[i]);
    crAvg += w * (128 + 0.5 * R[i] - 0.418688 * G[i] - 0.081312 * B[i]); wsum += w;
  }
  if (wsum > 0) { cbAvg /= wsum; crAvg /= wsum; } else { cbAvg = 108; crAvg = 152; }

  let Ls = null; let Ll = null; let lw = 0; let lh = 0; let f = 1;
  if (a > 0) {
    // 細かい成分（きめ）: 小さいぼかしとの差
    const rs = Math.max(1, Math.round(S / 1400));
    Ls = [boxBlur(R.slice(), W, H, rs, 2), boxBlur(G.slice(), W, H, rs, 2), boxBlur(B.slice(), W, H, rs, 2)];
    // 粗い成分: 縮めた画像で「肌の画素だけ」の平均（正規化畳み込み）。髪や眉の色が肌ににじまない
    const rl = Math.max(2, Math.round(S / 90));
    f = Math.max(1, Math.round(rl / 5)); lw = Math.ceil(W / f); lh = Math.ceil(H / f);
    const sm = new Float32Array(lw * lh); const sc = [new Float32Array(lw * lh), new Float32Array(lw * lh), new Float32Array(lw * lh)];
    const cnt = new Float32Array(lw * lh);
    const colOf = new Int32Array(W); for (let x = 0; x < W; x++) colOf[x] = (x / f) | 0;
    const [s0, s1, s2] = sc;
    for (let y = 0, i = 0; y < H; y++) {
      const o = ((y / f) | 0) * lw;
      for (let x = 0; x < W; x++, i++) {
        const j = o + colOf[x]; const w = raw[i]; cnt[j]++;
        if (w > 0) { sm[j] += w; s0[j] += R[i] * w; s1[j] += G[i] * w; s2[j] += B[i] * w; }
      }
    }
    for (let j = 0; j < sm.length; j++) { sm[j] /= cnt[j]; for (let c = 0; c < 3; c++) sc[c][j] /= cnt[j]; }
    const r2 = Math.max(1, Math.round(rl / f / 2));
    const bm = boxBlur(sm, lw, lh, r2, 3);
    Ll = sc.map((ch) => { const bl = boxBlur(ch, lw, lh, r2, 3); for (let j = 0; j < bl.length; j++) bl[j] = bm[j] > 1e-4 ? bl[j] / bm[j] : 0; return bl; });
    Ll.push(bm);
  }
  // 縮めた画像の値を、なめらかに（双線形で）取り出すための表
  const tab = (len, ln) => {
    const i0 = new Int32Array(len); const i1 = new Int32Array(len); const t = new Float32Array(len);
    for (let x = 0; x < len; x++) { const fx = Math.min(ln - 1, Math.max(0, (x + 0.5) / f - 0.5)); i0[x] = fx | 0; i1[x] = Math.min(ln - 1, i0[x] + 1); t[x] = fx - i0[x]; }
    return { i0, i1, t };
  };
  const tx = a > 0 ? tab(W, lw) : null; const ty = a > 0 ? tab(H, lh) : null;
  const up = [0, 0, 0, 0];
  const keepTex = 1 - 0.35 * a; // きめは少しだけ弱める（残しすぎるとザラつき、消しすぎるとのっぺりする）
  const T = 34; // これより大きい差は「輪郭」とみなして平らにしない
  for (let y = 0, i = 0; y < H; y++) {
    const r0 = ty ? ty.i0[y] * lw : 0; const r1 = ty ? ty.i1[y] * lw : 0; const wy = ty ? ty.t[y] : 0;
    for (let x = 0; x < W; x++, i++) {
      const w = m[i]; if (w <= 0.003) continue;
      let r = R[i]; let g = G[i]; let b = B[i];
      if (a > 0) {
        const c0 = tx.i0[x]; const c1 = tx.i1[x]; const wx = tx.t[x];
        for (let c = 0; c < 4; c++) { const L = Ll[c]; const top = L[r0 + c0] + (L[r0 + c1] - L[r0 + c0]) * wx; const bot = L[r1 + c0] + (L[r1 + c1] - L[r1 + c0]) * wx; up[c] = top + (bot - top) * wy; }
        const cov = Math.min(1, up[3] * 3); // まわりに肌が少ない（輪郭ぎわ）ほど弱く
        const sr = Ls[0][i]; const sg = Ls[1][i]; const sb = Ls[2][i];
        const lr = up[0]; const lg = up[1]; const lb = up[2];
        const dl = Math.abs(0.299 * (lr - sr) + 0.587 * (lg - sg) + 0.114 * (lb - sb)) / T;
        const k = a * 0.92 * w * cov / (1 + dl * dl);
        const tex = 1 - (1 - keepTex) * w;
        r = sr + (r - sr) * tex + (lr - sr) * k; g = sg + (g - sg) * tex + (lg - sg) * k; b = sb + (b - sb) * tex + (lb - sb) * k;
      }
      if (ev > 0 || br > 0) {
        let Y = 0.299 * r + 0.587 * g + 0.114 * b;
        let cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        let cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (ev > 0) {
          const t = ev * w;
          if (cr > crAvg) cr -= (cr - crAvg) * t * 0.75; // 赤みだけを抑える（血色は残す）
          cb += (cbAvg - cb) * t * 0.4; // 黄ぐすみ・青ぐすみをそろえる
        }
        if (br > 0) Y += (255 - Y) * br * w * 0.35 * (Y / 255) ** 0.5; // 暗い影は持ち上げすぎない
        r = Y + 1.402 * (cr - 128); g = Y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128); b = Y + 1.772 * (cb - 128);
      }
      const k4 = i * 4; d[k4] = clamp255(r); d[k4 + 1] = clamp255(g); d[k4 + 2] = clamp255(b);
    }
  }
}
