// RAW の現像（LibRaw が出した 16bit・リニア・Rec.2020 の画素 → 画面・ファイル用の 8bit）。DOM を使わない計算だけ。
// 16bit のまま持っておき、「RAW の露出」を変えたときはここからやり直すので、白飛び・黒つぶれした所の階調も戻せる。
import { boxBlur } from './portrait.js';

// 色の変換（どれも白は D65）
const REC2020_XYZ = [[0.6369580, 0.1446169, 0.1688810], [0.2627002, 0.6779981, 0.0593017], [0, 0.0280727, 1.0609851]];
const P3_XYZ = [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0, 0.0451134, 1.0439444]];
const SRGB_XYZ = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
function inv3([a, b, c]) {
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]); const d = 1 / det;
  return [
    [(b[1] * c[2] - b[2] * c[1]) * d, (a[2] * c[1] - a[1] * c[2]) * d, (a[1] * b[2] - a[2] * b[1]) * d],
    [(b[2] * c[0] - b[0] * c[2]) * d, (a[0] * c[2] - a[2] * c[0]) * d, (a[2] * b[0] - a[0] * b[2]) * d],
    [(b[0] * c[1] - b[1] * c[0]) * d, (a[1] * c[0] - a[0] * c[1]) * d, (a[0] * b[1] - a[1] * b[0]) * d],
  ];
}
const mul3 = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
/** Rec.2020（リニア）→ 書き出す色空間（リニア）の行列 */
export const fromRec2020 = (space) => mul3(inv3(space === 'display-p3' ? P3_XYZ : SRGB_XYZ), REC2020_XYZ);

/** 明るさをそろえる倍率（明るい方から 1% の所が白になるように。dcraw と同じ考え方）。小さな画像から決めて、全体にも同じ値を使う */
export function autoGain(data, w, h) {
  const hist = new Uint32Array(4096); let n = 0;
  const step = Math.max(1, Math.floor((w * h) / 400_000)); // 40万画素ほど見れば十分
  for (let i = 0; i < w * h; i += step) {
    const k = i * 3; const m = Math.max(data[k], data[k + 1], data[k + 2]);
    hist[m >> 4]++; n++;
  }
  let acc = 0; let top = 4095; const lim = n * 0.01;
  for (; top > 0; top--) { acc += hist[top]; if (acc > lim) break; }
  const v = ((top + 0.5) * 16) / 65535;
  return Math.min(16, Math.max(1, 0.78 / Math.max(v, 1 / 16))); // 少し控えめに（あとの S 字カーブで明るい所が持ち上がるので）
}

/** 明るい所をなめらかに飽和させる（白飛びの手前で階調を残す）。色みが変わらないよう、いちばん明るい成分で決めて全体に掛ける */
const KNEE = 0.8;
const shoulder = (x) => (x <= KNEE ? x : KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE))));

/**
 * 0〜1 のリニア → 0〜255（小数つき。sRGB・Display P3 は同じ曲線）の表。間は直線でつなぐ（暗い所も 8bit より細かく）。
 * カメラの JPEG に近い見た目になるよう、ゆるい S 字のトーンカーブ（中間の明暗差を少し強く）も一緒に入れる
 */
const CONTRAST = 0.3;
const ENC_N = 16384;
const ENC = (() => {
  const t = new Float32Array(ENC_N + 2);
  for (let i = 0; i <= ENC_N; i++) {
    const x = i / ENC_N; const e = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    const sc = e * e * (3 - 2 * e); t[i] = (e + (sc - e) * CONTRAST) * 255;
  }
  t[ENC_N + 1] = t[ENC_N];
  return t;
})();
// 暗い所は曲線が急なので、いちばん暗い区間だけ細かい表を別に持つ（リニアで 1/2^20 きざみ）
const ENC_LO = (() => { const n = 1024; const t = new Float32Array(n + 2); for (let i = 0; i <= n; i++) { const x = (i / n) * (16 / ENC_N); const e = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; t[i] = (e + (e * e * (3 - 2 * e) - e) * CONTRAST) * 255; } t[n + 1] = t[n]; return t; })();
function enc(x) {
  if (x >= 1) return ENC[ENC_N];
  if (x < 16 / ENC_N) { const f = x * (ENC_N / 16) * 1024; const i = f | 0; return ENC_LO[i] + (ENC_LO[i + 1] - ENC_LO[i]) * (f - i); }
  const f = x * ENC_N; const i = f | 0; return ENC[i] + (ENC[i + 1] - ENC[i]) * (f - i);
}
/** 0〜255 の小数 → 8bit に丸めた値と、丸めた残り（-0.5〜0.5 を 0〜255 に）。残りは GPU で足し戻す（16bit 相当の細かさ） */
const RES = (v, q) => { const r = Math.round((v - q + 0.5) * 255); return r < 0 ? 0 : r > 255 ? 255 : r; };

/** 彩度（リニアで、明るさを保ったまま）。実写真でカメラの JPEG と比べると、そのままで同じくらいの鮮やかさ */
const SAT = 1.0;
/** 暗部のつま先の強さ（リニアの明るさ。これより十分明るい所はほとんど変わらない） */
const TOE = 0.004;


/**
 * 明るさのノイズは、平方根（に少し足したもの）の上で扱う。光の粒の揺らぎは明るさの平方根に比例するので、
 * 平方根にすると明るさによらずノイズの量がほぼ同じになる（足すぶんは、いちばん暗い所でセンサー自体のノイズが目立つのを抑える）
 */
const PC = 0.002;
/**
 * ノイズの量（上の平方根の上での標準偏差。倍率 gain のとき）。{ mid: 中間の明るさの所, A: 暗い所で増えるぶん }。
 * 平方根の上でも、いちばん暗い所はセンサー自体のノイズで揺らぎが大きくなる（σ² ≈ mid² + A / P²）。
 * 写真を小さな区画に分け、区画ごとに「2 画素離れた画素との差」の中央値からばらつきを求め、平らな区画（空・壁・肌など）の値を使う
 * （模様の多い所をノイズと見誤らない。となりの画素どうしは色の補間でノイズが似通っているので、離して見る）
 */
export function estimateNoise(lin, gain = 1) {
  const { data, width: W, height: H } = lin; const s = gain / 65535; const PD = Math.sqrt(0.01 + PC);
  const P = (x, y) => { const k = (y * W + x) * 3; return Math.sqrt(Math.max(0, 0.2627 * data[k] + 0.678 * data[k + 1] + 0.0593 * data[k + 2]) * s + PC); };
  const B = 24; const nb = Math.floor((W - 4) / B) * Math.floor((H - 4) / B);
  const stride = Math.max(1, Math.floor(Math.sqrt(nb / 3000))); // 区画は 3000 個ほど
  const mids = []; const darks = []; const d = new Float32Array(144);
  for (let by = 0; by + B + 4 <= H; by += B * stride) for (let bx = 0; bx + B + 4 <= W; bx += B * stride) {
    let n = 0; let sp = 0;
    for (let y = by + 2; y < by + B + 2; y += 2) for (let x = bx + 2; x < bx + B + 2; x += 2) {
      const p = P(x, y); sp += p; d[n++] = Math.abs(p - (P(x - 2, y) + P(x + 2, y) + P(x, y - 2) + P(x, y + 2)) / 4);
    }
    const sorted = d.subarray(0, n).sort(); const sig = (1.4826 * sorted[n >> 1]) / Math.sqrt(1.25);
    (sp / n < PD ? darks : mids).push([sig, sp / n]);
  }
  const low = (a) => { a.sort((x, y) => x[0] - y[0]); return a.length ? a[Math.floor(a.length * 0.15)] : null; }; // 平らな方から 15%
  const m = low(mids); const dk = low(darks);
  const mid = m ? m[0] : dk ? dk[0] : 0;
  return { mid, A: dk ? Math.max(0, dk[0] * dk[0] - mid * mid) * dk[1] * dk[1] : 0 };
}
/** これより暗い所（リニア）は、ノイズ除去を強める */
const DARK = 0.02;
/** 明るさ P（平方根）の所のノイズの量の 2 乗 */
const noiseVar = (n, p) => n.mid * n.mid + n.A / (p * p);

/**
 * 色にじみ（倍率色収差）を写真から求める。レンズは色ごとに少しだけ写る大きさが違うので、
 * 画面の端ほど、赤・青の輪郭が緑から外側（または内側）にずれる。
 * 中心から外へ向かう輪郭をたくさん選び、輪郭ごとに赤・青の明るさの並びが緑と一番よく重なるずれを測って、
 * 「ずれ = k × 中心からの距離 + 全体のずれ」に当てはめる。{ r: [k, sx, sy], b: [k, sx, sy] }（測れなければ null）
 */
export function estimateCA(lin) {
  const { data, width: W, height: H } = lin; const cx = (W - 1) / 2; const cy = (H - 1) / 2; const R0 = Math.hypot(cx, cy);
  const at = (c, x, y) => sample(data, W, H, c, x, y);
  // 1. 輪郭を選ぶ（緑の明るさの変化が、中心から外への向きに大きい所）
  const step = Math.max(2, Math.floor(Math.sqrt((W * H) / 250_000)));
  const cand = [];
  for (let y = 8; y < H - 8; y += step) for (let x = 8; x < W - 8; x += step) {
    const dx = x - cx; const dy = y - cy; const r = Math.hypot(dx, dy); if (r < R0 * 0.3) continue;
    const ex = dx / r; const ey = dy / r; const k = (y * W + x) * 3;
    if (data[k] > 60000 || data[k + 1] > 60000 || data[k + 2] > 60000) continue; // 白飛びの所は測れない
    const gx = data[k + 4] - data[k - 2]; const gy = data[k + W * 3 + 1] - data[k - W * 3 + 1];
    const gr = gx * ex + gy * ey; const gt = -gx * ey + gy * ex;
    if (Math.abs(gr) > 2 * Math.abs(gt)) cand.push([Math.abs(gr) / (data[k + 1] + 600), x, y, ex, ey, r]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  const pts = cand.slice(0, 6000);
  // 2. 輪郭ごとのずれ（±3 画素を 0.1 画素きざみで）
  const J = 4; const T = 30; const meas = { r: [], b: [] };
  const norm = (v) => { let m = 0; for (const x of v) m += x; m /= v.length; let n = 0; for (let i = 0; i < v.length; i++) { v[i] -= m; n += v[i] * v[i]; } n = Math.sqrt(n); if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n; return n; };
  const gp = new Float64Array(2 * J + 1); const cp = new Float64Array(2 * J + 1); const corr = new Float64Array(2 * T + 1);
  for (const [, x, y, ex, ey, r] of pts) {
    for (let j = -J; j <= J; j++) gp[j + J] = at(1, x + j * ex, y + j * ey);
    if (norm(gp) < 200) continue;
    for (const [c, key] of [[0, 'r'], [2, 'b']]) {
      let best = -2; let bi = 0;
      for (let t = -T; t <= T; t++) {
        const sh = t / 10;
        for (let j = -J; j <= J; j++) cp[j + J] = at(c, x + (j + sh) * ex, y + (j + sh) * ey);
        if (norm(cp) < 100) { corr[t + T] = -2; continue; }
        let s = 0; for (let j = 0; j < cp.length; j++) s += cp[j] * gp[j];
        corr[t + T] = s; if (s > best) { best = s; bi = t; }
      }
      if (best < 0.9 || bi === -T || bi === T) continue;
      // 放物線で 0.1 画素より細かく
      const a = corr[bi + T - 1]; const b = corr[bi + T]; const d = corr[bi + T + 1]; const den = a - 2 * b + d;
      const t = (bi + (den < 0 ? (0.5 * (a - d)) / den : 0)) / 10;
      meas[key].push([t, r, ex, ey]);
    }
  }
  // 3. ずれ = k × r + sx × ex + sy × ey に当てはめる（外れたものの影響を小さく）
  const fit = (m) => {
    if (m.length < 150) return null;
    let p = [0, 0, 0];
    for (let it = 0; it < 6; it++) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const v = [0, 0, 0];
      for (const [t, r, ex, ey] of m) {
        const e = t - (p[0] * r + p[1] * ex + p[2] * ey); const w = 1 / Math.max(0.15, Math.abs(e)); const f = [r, ex, ey];
        for (let i = 0; i < 3; i++) { v[i] += w * f[i] * t; for (let j = 0; j < 3; j++) A[i][j] += w * f[i] * f[j]; }
      }
      const Ai = inv3(A); p = Ai.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
    }
    if (!p.every(Number.isFinite) || Math.abs(p[0]) > 0.004 || Math.abs(p[1]) > 2 || Math.abs(p[2]) > 2) return null;
    return p;
  };
  const r = fit(meas.r); const b = fit(meas.b);
  if (!r && !b) return null;
  return { r: r || [0, 0, 0], b: b || [0, 0, 0], n: [meas.r.length, meas.b.length] };
}

/**
 * 現像に使う値を RAW のデータに付けておく。fullW: 元の大きさの幅（編集中の半分の大きさのデータでも、効き方をそろえる）。
 * gain: 明るさをそろえる倍率（書き出しでは編集中と同じ値を使う）
 */
export function prepareLin(lin, fullW, gain) {
  lin.gain = gain ?? autoGain(lin.data, lin.width, lin.height);
  lin.scale = lin.width / (fullW || lin.width);
  lin.noise = estimateNoise(lin, lin.gain);
  // 色にじみは元の大きさのときだけ求める（半分の大きさでは 4 画素を 1 つにする並びのずれが混ざって正しく測れない。ずれも 0.25 画素ほどで見えない）
  lin.ca = lin.scale >= 0.75 ? estimateCA(lin) : null;
  return lin;
}

/**
 * 現像の設定。r: 編集内容の raw（exposure: RAW の露出 EV×100、nr・sharpen: 0〜100、vignette・distortion: -100〜100）
 * lin: prepareLin したデータ
 */
export function developParams(r = {}, lin, space) {
  const { exposure = 0, nr = 50, sharpen = 50, vignette = 0, distortion = 0 } = r;
  const kd = (-distortion / 100) * 0.08; // 樽型（＋）を直すときは、外側ほど内側から持ってくる
  return {
    M: fromRec2020(space), gain: (lin.gain ?? 1) * 2 ** (exposure / 100),
    // RAW の露出を変えたとき: 光の粒のノイズ（平方根の上で）は倍率の平方根に、センサー自体のノイズは倍率に比例する
    nr: nr / 100, sharpen: sharpen / 100, scale: lin.scale ?? 1,
    noise: lin.noise ? { mid: lin.noise.mid * 2 ** (exposure / 200), A: lin.noise.A * 2 ** (exposure / 50) } : null,
    vignette: vignette / 100, kd, fit: 1 / (1 + Math.max(kd, 0)), // 糸巻き型を直すときは、すみが写真の外にはみ出さないよう少し拡大
    ca: r.ca === false ? null : lin.ca ?? null,
  };
}

/** 16bit の 1 つの色を、(x, y) で直線補間して読む */
function sample(data, W, H, c, x, y) {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  const x0 = x | 0; const y0 = y | 0; const x1 = x0 < W - 1 ? x0 + 1 : x0; const y1 = y0 < H - 1 ? y0 + 1 : y0; const fx = x - x0; const fy = y - y0;
  const a = data[(y0 * W + x0) * 3 + c]; const b = data[(y0 * W + x1) * 3 + c]; const d = data[(y1 * W + x0) * 3 + c]; const e = data[(y1 * W + x1) * 3 + c];
  return (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
}

/**
 * 一部（x, y から w×h）を現像して RGBA を返す。res（w×h×4 の配列）を渡すと、8bit に丸めた残りも入れる。
 * 1. レンズの補正: ゆがみ・色にじみ（色ごとに少し違う倍率で、中心からの位置を読み替える）・周辺の暗さ
 * 2. 色の変換（Rec.2020 → 書き出す色空間）と明るさの倍率
 * 3. ノイズ除去: 色の成分は少しぼかす（色の粒を消す）。明るさの成分は、輪郭を残すフィルター（ガイデッドフィルター）で平らな所だけならす
 * 4. シャープ: 細かい輪郭を少し強める（ノイズの大きさより小さな揺らぎは強めない）
 * 5. 暗部のつま先・明るい所の肩・トーンカーブ
 * 近くの画素を使う処理の届く範囲だけ広く読むので、一部ずつ現像しても、全体をまとめて現像したのと同じになる
 */
export function developRegion(lin, x, y, w, h, P, res = null) {
  const { data, width: W, height: H } = lin; const out = new Uint8ClampedArray(w * h * 4);
  const rc = Math.max(1, Math.round(Math.min(W, H) / 1500)); // 色ノイズのぼかしの半径（写真の大きさに比例）
  const rn = P.scale >= 0.75 ? 2 : 1; // 明るさのノイズ除去の半径（元の大きさで 2 画素）
  const m = Math.max(rc * 2, rn * 2 + 2) + 1; // 近くの画素を使うぶん（色のぼかし・1 画素の除去＋ガイデッドフィルター＋シャープ）
  const X0 = Math.max(0, x - m); const Y0 = Math.max(0, y - m); const X1 = Math.min(W, x + w + m); const Y1 = Math.min(H, y + h + m);
  const ww = X1 - X0; const hh = Y1 - Y0; const N = ww * hh;
  const L = new Float32Array(N); const U = new Float32Array(N); const V = new Float32Array(N);
  const s = P.gain / 65535;
  const [a, b, c] = P.M; const a0 = a[0] * s; const a1 = a[1] * s; const a2 = a[2] * s; const b0 = b[0] * s; const b1 = b[1] * s; const b2 = b[2] * s; const c0 = c[0] * s; const c1 = c[1] * s; const c2 = c[2] * s;
  // レンズの補正（中心からの距離は、対角線の半分を 1 とする）
  const cx = (W - 1) / 2; const cy = (H - 1) / 2; const R0 = Math.hypot(cx, cy);
  const ca = P.ca; const geo = P.kd !== 0 || ca; const vig = P.vignette;
  const kr = ca ? 1 + ca.r[0] : 1; const kb = ca ? 1 + ca.b[0] : 1;
  const sxr = ca ? ca.r[1] : 0; const syr = ca ? ca.r[2] : 0; const sxb = ca ? ca.b[1] : 0; const syb = ca ? ca.b[2] : 0;
  for (let yy = 0, i = 0; yy < hh; yy++) {
    const Y = Y0 + yy; let k = (Y * W + X0) * 3;
    for (let xx = 0; xx < ww; xx++, i++, k += 3) {
      let r0; let g0; let bl;
      const X = X0 + xx;
      if (geo || vig) {
        const dx = (X - cx) / R0; const dy = (Y - cy) / R0; const q = dx * dx + dy * dy;
        if (geo) {
          const D = (1 + P.kd * q) * P.fit * R0;
          g0 = sample(data, W, H, 1, cx + dx * D, cy + dy * D);
          r0 = sample(data, W, H, 0, cx + dx * D * kr + sxr, cy + dy * D * kr + syr);
          bl = sample(data, W, H, 2, cx + dx * D * kb + sxb, cy + dy * D * kb + syb);
        } else { r0 = data[k]; g0 = data[k + 1]; bl = data[k + 2]; }
        if (vig) { const gv = Math.max(0, 1 + vig * q * (0.6 + 0.4 * q)); r0 *= gv; g0 *= gv; bl *= gv; }
      } else { r0 = data[k]; g0 = data[k + 1]; bl = data[k + 2]; }
      const R = a0 * r0 + a1 * g0 + a2 * bl; const G = b0 * r0 + b1 * g0 + b2 * bl; const B = c0 * r0 + c1 * g0 + c2 * bl;
      const Yl = 0.2627 * R + 0.678 * G + 0.0593 * B; L[i] = Yl; U[i] = R - Yl; V[i] = B - Yl;
    }
  }
  const Ub = boxBlur(U, ww, hh, rc, 2); const Vb = boxBlur(V, ww, hh, rc, 2);
  // 明るさは平方根の上で（ノイズの量が明るさによらずほぼ同じになる）
  const nz = P.noise && P.noise.mid > 0 ? P.noise : null;
  let Pl = new Float32Array(N); for (let i = 0; i < N; i++) Pl[i] = Math.sqrt((L[i] > 0 ? L[i] : 0) + PC);
  if (P.nr > 0 && nz) {
    Pl = despeckle(Pl, ww, hh, nz, 4); // ぽつんと明るい・暗い 1 画素（熱ノイズなど）
    Pl = guided(Pl, ww, hh, rn, nz, (0.2 + 1.04 * P.nr) ** 2); // 既定（50）は模様を残す控えめな強さ
  }
  if (P.sharpen > 0) Pl = sharpen(Pl, ww, hh, P.sharpen * (P.scale >= 0.75 ? 1 : 0.5) * 2.8, nz); // 既定（50）でカメラの JPEG くらいのくっきりさ
  for (let yy = 0; yy < h; yy++) {
    let i = (y - Y0 + yy) * ww + (x - X0); let o = yy * w * 4;
    for (let xx = 0; xx < w; xx++, i++, o += 4) {
      // 暗部の「つま先」: いちばん暗い所を黒へ沈め、色も抜く（カメラの JPEG と同じく、ノイズの底が赤紫に浮かないように）
      const Yd = Math.max(0, Pl[i] * Pl[i] - PC); const k = Yd > 0 ? Yd / (Yd + TOE) : 0; const Yv = Yd * k;
      const u = Ub[i] * SAT * k * k; const v = Vb[i] * SAT * k * k;
      let R = Yv + u; let B = Yv + v; let G = (Yv - 0.2627 * R - 0.0593 * B) / 0.678;
      // 色域の外（負の値）は、明るさを保ったまま灰色に寄せる（成分ごとに 0 で切ると、暗い所のノイズが赤・緑の粒になる）
      const mn = R < G ? (R < B ? R : B) : G < B ? G : B;
      if (mn < 0) {
        if (Yv <= 0) { R = 0; G = 0; B = 0; } else { const t = Yv / (Yv - mn); R = Yv + (R - Yv) * t; G = Yv + (G - Yv) * t; B = Yv + (B - Yv) * t; }
      }
      const mx = R > G ? (R > B ? R : B) : G > B ? G : B;
      if (mx > KNEE) { const f = shoulder(mx) / mx; R *= f; G *= f; B *= f; }
      const er = enc(R); const eg = enc(G); const eb = enc(B); const qr = Math.round(er); const qg = Math.round(eg); const qb = Math.round(eb);
      out[o] = qr; out[o + 1] = qg; out[o + 2] = qb; out[o + 3] = 255;
      if (res) { res[o] = RES(er, qr); res[o + 1] = RES(eg, qg); res[o + 2] = RES(eb, qb); res[o + 3] = 255; }
    }
  }
  return out;
}

/**
 * ガイデッドフィルター（自分自身を手がかりに）。ばらつきが「ノイズの量の 2 乗 × k」より十分大きい所（輪郭・模様）は残し、
 * 小さい所（ノイズ）はならす。ノイズの量は明るさで変わる（暗い所ほど強くならす）
 */
function guided(I, W, H, r, nz, k) {
  const n = I.length; const I2 = new Float32Array(n); for (let i = 0; i < n; i++) I2[i] = I[i] * I[i];
  const mI = boxBlur(Float32Array.from(I), W, H, r, 1); const mII = boxBlur(I2, W, H, r, 1);
  const A = new Float32Array(n); const B = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = Math.max(0, mII[i] - mI[i] * mI[i]);
    // いちばん暗い所（細部が見えにくく、ノイズが目立つ）は強めに
    const yd = 1 - (mI[i] * mI[i] - PC) / DARK; const kd = yd > 0 ? 1 + 3 * yd * yd : 1;
    const a = v / (v + k * kd * noiseVar(nz, mI[i])); A[i] = a; B[i] = mI[i] * (1 - a); }
  const mA = boxBlur(A, W, H, r, 1); const mB = boxBlur(B, W, H, r, 1);
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = mA[i] * I[i] + mB[i];
  return out;
}

/** まわり 8 画素のどれよりも（ノイズの量 × t）以上明るい・暗い画素を、まわりの範囲に収める */
function despeckle(I, W, H, nz, t2) {
  const out = Float32Array.from(I);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1, i = y * W + 1; x < W - 1; x++, i++) {
      const a0 = I[i - W - 1]; const a1 = I[i - W]; const a2 = I[i - W + 1]; const a3 = I[i - 1]; const a4 = I[i + 1]; const a5 = I[i + W - 1]; const a6 = I[i + W]; const a7 = I[i + W + 1];
      const mx = Math.max(a0, a1, a2, a3, a4, a5, a6, a7); const mn = Math.min(a0, a1, a2, a3, a4, a5, a6, a7);
      const v = I[i]; const t = Math.sqrt(t2 * noiseVar(nz, v)); if (v > mx + t) out[i] = mx; else if (v < mn - t) out[i] = mn;
    }
  }
  return out;
}

/** シャープ（3×3 のぼかしとの差を足す）。差がノイズの量くらいまでのものは弱める */
function sharpen(I, W, H, amount, nz) {
  const out = Float32Array.from(I);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1, i = y * W + 1; x < W - 1; x++, i++) {
      const bl = (4 * I[i] + 2 * (I[i - 1] + I[i + 1] + I[i - W] + I[i + W]) + I[i - W - 1] + I[i - W + 1] + I[i + W - 1] + I[i + W + 1]) / 16;
      const d = I[i] - bl; const d2 = d * d; const t2 = nz ? 0.64 * noiseVar(nz, bl) : 0;
      out[i] = I[i] + amount * d * (d2 / (d2 + t2 + 1e-12));
    }
  }
  return out;
}
