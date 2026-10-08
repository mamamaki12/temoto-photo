// 美肌（写真館の「肌の仕上げ」）。肌の場所を見つけて（タップした肌の色と、そこからのつながりで。タップがなければ一般的な肌の色で）、
// 元写真の画素（ImageData）を直接書き換える。
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

const toYcc = (r, g, b) => [0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b];

function median(a) { if (!a.length) return 0; const b = Float32Array.from(a).sort(); return b[b.length >> 1]; }

/** 細かい明暗の量（％）: |明るさ − 少しぼかした明るさ| を、まわりで平均して、まわりの明るさで割る */
function textureMap(d, W, H, S) {
  const N = W * H; const Y = new Float32Array(N);
  for (let i = 0, k = 0; i < N; i++, k += 4) Y[i] = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
  const fine = boxBlur(Y.slice(), W, H, Math.max(1, Math.round(S / 500)), 1);
  for (let i = 0; i < N; i++) fine[i] = Math.abs(Y[i] - fine[i]);
  const rl = Math.max(1, Math.round(S / 150));
  const e = boxBlur(fine, W, H, rl, 1); const m = boxBlur(Y, W, H, rl, 1);
  for (let i = 0; i < N; i++) e[i] = (e[i] / (m[i] + 20)) * 100;
  return e;
}

/** タップがないとき: 肌の色の範囲にあって、なめらか（髪・布の模様のような細かい明暗がない）な所の色の中央値を、肌の色とみなす */
function autoSkinColor(img) {
  const { width: W, height: H, data: d } = img;
  const g = Math.max(2, Math.ceil(Math.max(W, H) / 240)); const cbs = []; const crs = []; const ys = [];
  for (let y0 = 0; y0 + g <= H; y0 += g) for (let x0 = 0; x0 + g <= W; x0 += g) {
    let sY = 0; let sY2 = 0; let sb = 0; let sr = 0; let sk = 0; const n = g * g;
    for (let y = y0; y < y0 + g; y++) for (let x = x0; x < x0 + g; x++) {
      const k = (y * W + x) * 4; const [Y, cb, cr] = toYcc(d[k], d[k + 1], d[k + 2]);
      sY += Y; sY2 += Y * Y; sb += cb; sr += cr; sk += skinness(d[k], d[k + 1], d[k + 2]);
    }
    const mY = sY / n; if (sk / n < 0.8 || Math.sqrt(Math.max(0, sY2 / n - mY * mY)) > 6 || mY < 60) continue;
    cbs.push(sb / n); crs.push(sr / n); ys.push(mY);
  }
  if (cbs.length < 20) return null;
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(cbs), med(crs), med(ys)];
}

/**
 * 肌の重み（0〜1、W×H）。
 * 肌の場所（p.seeds: 写真上の [x, y]、0〜1）が選ばれていれば、
 *   ① その場所の肌の色に近い色だけを肌とみなし（p.tol: 色の幅 0〜100）、
 *   ② さらに、選んだ場所から「色が急に変わらずに」つながっている範囲だけに絞る。
 *      肌に似た色の背景（ベージュの壁・木・布）も、顔とつながっていなければ外れる。
 * 選ばれていなければ、写真の中のなめらかな肌らしい所から肌の色を推定して、その色に近い所を肌とする（つながりは見ない）。
 */
export function skinWeights(img, p) {
  const seeds = p?.seeds || [];
  const { width: W, height: H, data: d } = img; const N = W * H; const S = Math.min(W, H);
  // ① 基準にする肌の色（Cb・Cr）。選んだ場所があればそのまわり、なければ写真から推定する
  let refs;
  if (seeds.length) {
    const rad = Math.max(2, Math.round(S / 120));
    refs = seeds.map(([sx, sy]) => {
      const cx = Math.round(sx * (W - 1)); const cy = Math.round(sy * (H - 1)); let cb = 0; let cr = 0; let yy = 0; let n = 0;
      for (let y = Math.max(0, cy - rad); y <= Math.min(H - 1, cy + rad); y++) for (let x = Math.max(0, cx - rad); x <= Math.min(W - 1, cx + rad); x++) {
        const k = (y * W + x) * 4; const [Y, b, r] = toYcc(d[k], d[k + 1], d[k + 2]); if (Y < 20) continue; cb += b; cr += r; yy += Y; n++;
      }
      return n ? [cb / n, cr / n, yy / n] : null;
    }).filter(Boolean);
    if (!refs.length) return new Float32Array(N);
  } else {
    const ref = autoSkinColor(img);
    if (!ref) return skinMask(img);
    refs = [ref];
  }
  // 色は「色相（赤〜黄のどちら寄りか）」と「鮮やかさ」に分けて比べる。
  // 同じ人の肌は、光の当たり方で鮮やかさは 0.5〜2 倍ほど変わるが、色相はほぼ同じ（±4°）。金髪・茶髪は 15〜30° ずれる
  const tol = (p?.tol ?? 50) / 100; const Th = 5 + tol * 10; const softH = 4; const T = 6 + tol * 12;
  // [色相, 鮮やかさ, 明るさ]
  const refA = refs.map(([rb, rr, ry]) => [Math.atan2(rr - 128, 128 - rb), Math.hypot(rb - 128, rr - 128), ry]);
  // 細かい明暗の量（髪の毛・ひげ・布の織り目は多く、肌は少ない）。明るさで割って、暗い髪でも比べられるようにする
  const tex = textureMap(d, W, H, S);
  let texRef;
  if (seeds.length) {
    const vals = []; const rad = Math.max(3, Math.round(S / 60));
    for (const [sx, sy] of seeds) {
      const cx = Math.round(sx * (W - 1)); const cy = Math.round(sy * (H - 1));
      for (let y = Math.max(0, cy - rad); y <= Math.min(H - 1, cy + rad); y += 2) for (let x = Math.max(0, cx - rad); x <= Math.min(W - 1, cx + rad); x += 2) vals.push(tex[y * W + x]);
    }
    texRef = median(vals);
  }
  // 1画素ずつの判定（tight）と、明らかに肌でない色だけを外す判定（loose: 目・眉・服などをくっきり外す）
  const tight = new Float32Array(N); const loose = new Float32Array(N);
  for (let i = 0, k = 0; i < N; i++, k += 4) {
    const r = d[k]; const g = d[k + 1]; const b = d[k + 2];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b; if (Y < 18) continue;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b; const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const warm = cr - cb; if (warm <= 3) continue; // 白・灰色・黒（色みのないもの）は肌ではない
    const a = Math.atan2(cr - 128, 128 - cb); const m = Math.hypot(cb - 128, cr - 128);
    let dh = Infinity; let sat = 1; let bright = 0;
    for (const [ra, rs, ry] of refA) {
      const q = Math.abs(a - ra) * 57.2958;
      if (q < dh) { dh = q; sat = rs > 0.5 ? m / rs : 1; bright = Math.min(1, Math.max(0, (Y - ry - 10) / 40)); }
    }
    // 鮮やかさ: 基準の 0.45〜2 倍なら肌（影・赤み）。基準の肌より明るい所（光で白っぽくなった肌）だけは、もっと薄くても許す。
    // 白髪・灰色の髪は、肌より明るくないのに色が薄いので外れる
    const lo = 0.45 - 0.25 * bright;
    const ws = sat < lo - 0.15 || sat > 2.6 ? 0 : sat < lo ? (sat - lo + 0.15) / 0.15 : sat > 2 ? (2.6 - sat) / 0.6 : 1;
    const wm = Math.min(1, (warm - 3) / 6) * ws;
    // 光で白っぽくなった肌は色相がぶれやすいので、そのぶん許す（基準より明るい所だけ）
    const th = Th + (40 / Math.max(m, 2)) * bright;
    tight[i] = (dh <= th ? 1 : dh >= th + softH ? 0 : 1 - (dh - th) / softH) * wm;
    const L = th * 2.2 + softH; loose[i] = (dh <= L ? 1 : dh >= L + softH ? 0 : 1 - (dh - L) / softH) * wm;
  }
  // 面で判定する: 髪（金髪・茶髪）は肌に近い色の毛がまばらに混じるだけだが、肌はほぼ全部が肌の色。
  // まわりの画素のうち肌の色の割合で決めるので、髪が外れ、肌の中のまだら（判定のムラ）もなくなる
  if (texRef == null) { const vals = []; for (let i = 0; i < N; i += 7) if (tight[i] > 0.9) vals.push(tex[i]); texRef = vals.length ? median(vals) : 1; }
  const tLo = 2 * texRef + 1; const tHi = tLo * 2;
  for (let i = 0; i < N; i++) { const t = tex[i]; if (t > tLo) tight[i] *= t >= tHi ? 0 : 1 - (t - tLo) / (tHi - tLo); }
  const area = boxBlur(tight, W, H, Math.max(1, Math.round(S / 220)), 2);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) { if (!loose[i]) continue; const t = (area[i] - 0.3) / 0.35; w[i] = (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)) * loose[i]; }
  if (!seeds.length) return w;
  // ② 選んだ場所からつながっている範囲（粗いマス目で、となりのマスと色が近いときだけ広げる）
  const g = Math.max(1, Math.ceil(Math.max(W, H) / 360)); const gw = Math.ceil(W / g); const gh = Math.ceil(H / g); const G = gw * gh;
  const mw = new Float32Array(G); const mY = new Float32Array(G); const mb = new Float32Array(G); const mr = new Float32Array(G); const vc = new Float32Array(G); const vy = new Float32Array(G); const cnt = new Float32Array(G);
  const colOf = new Int32Array(W); for (let x = 0; x < W; x++) colOf[x] = (x / g) | 0;
  for (let y = 0, i = 0; y < H; y++) {
    const o = ((y / g) | 0) * gw;
    for (let x = 0; x < W; x++, i++) {
      const j = o + colOf[x]; const k = i * 4; const [Y, cb, cr] = toYcc(d[k], d[k + 1], d[k + 2]);
      mw[j] += w[i]; mY[j] += Y; mb[j] += cb; mr[j] += cr; vc[j] += cb * cb + cr * cr; vy[j] += Y * Y; cnt[j]++;
    }
  }
  // vc: マスの中の色のばらつき（くっきりした境目をまたぐマスは大きい）
  for (let j = 0; j < G; j++) { mw[j] /= cnt[j]; mY[j] /= cnt[j]; mb[j] /= cnt[j]; mr[j] /= cnt[j]; vc[j] = Math.sqrt(Math.max(0, vc[j] / cnt[j] - mb[j] * mb[j] - mr[j] * mr[j])); vy[j] = Math.sqrt(Math.max(0, vy[j] / cnt[j] - mY[j] * mY[j])); }
  const gate = new Uint8Array(G); const queue = new Int32Array(G); let qh = 0; let qt = 0;
  for (const [sx, sy] of seeds) {
    const j = Math.min(gh - 1, (sy * (H - 1) / g) | 0) * gw + Math.min(gw - 1, (sx * (W - 1) / g) | 0);
    if (!gate[j]) { gate[j] = 1; queue[qt++] = j; }
  }
  // となりのマスとの色の差、またはマスの中の色のばらつきがこれより大きいと「境目」として越えない
  const stepY = 10 + T * 0.4; const stepC = 3 + T * 0.2; const edgeC = 2.5 + T * 0.15; const edgeY = 12 + T * 0.2; // edgeY: マスの中の明るさのばらつき（顔の輪郭など）
  while (qh < qt) {
    const j = queue[qh++]; const x = j % gw; const y = (j / gw) | 0;
    // 眼鏡のふち・眉のような細い仕切りは飛び越えられるよう、3マス先まで見る（色が近いマスだけ）
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx; const ny = y + dy; if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const n = ny * gw + nx; if (gate[n] || mw[n] < 0.5 || vc[n] > edgeC || vy[n] > edgeY) continue; // 半分以上が肌の色のマスだけを通る（色が少しずつずれて背景へ抜けるのを防ぐ）
      const far = Math.max(Math.abs(dx), Math.abs(dy)); // 離れたマスとは、そのぶん明るさの差を許す（色の差は許さない）
      if (far > 1) {
        // 飛び越えてよいのは、両側の肌より暗い、肌でないマス（眼鏡のふち・眉・まつげ）だけ。
        // 肌に似た色の境目（顔と壁の境）や、明るい髪の輪郭の先のぼけた背景へは飛ばない
        let ok = true; const dark = Math.min(mY[j], mY[n]) - 15;
        for (let t = 1; t < far && ok; t++) { const m2 = Math.round(y + (dy * t) / far) * gw + Math.round(x + (dx * t) / far); if (!gate[m2] && (mw[m2] >= 0.3 || mY[m2] > dark)) ok = false; }
        if (!ok) continue;
      }
      if (Math.abs(mY[n] - mY[j]) > stepY * far || Math.hypot(mb[n] - mb[j], mr[n] - mr[j]) > stepC) continue;
      gate[n] = 1; queue[qt++] = n;
    }
  }
  // マスの境目がカクカクしないよう、1マス広げてからぼかし、なめらかに引き伸ばす
  let soft2 = new Float32Array(G);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let on = 0; for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && gate[ny * gw + nx]) { on = 1; break; } }
    soft2[y * gw + x] = on;
  }
  soft2 = boxBlur(soft2, gw, gh, 1, 1);
  for (let y = 0, i = 0; y < H; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / g - 0.5)); const y0 = fy | 0; const y1 = Math.min(gh - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < W; x++, i++) {
      if (w[i] === 0) continue;
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / g - 0.5)); const x0 = fx | 0; const x1 = Math.min(gw - 1, x0 + 1); const tx = fx - x0;
      const top = soft2[y0 * gw + x0] + (soft2[y0 * gw + x1] - soft2[y0 * gw + x0]) * tx; const bot = soft2[y1 * gw + x0] + (soft2[y1 * gw + x1] - soft2[y1 * gw + x0]) * tx;
      w[i] *= Math.min(1, (top + (bot - top) * ty) * 1.5);
    }
  }
  return w;
}

/** 肌と判定した範囲を赤く重ねる（確認用。img の画素に色をつける。weightsFrom は判定に使う元の画像） */
export function tintSkin(img, weightsFrom, p) {
  const w = skinWeights(weightsFrom, p); const d = img.data;
  for (let i = 0, k = 0; i < w.length; i++, k += 4) {
    const a = w[i] * 0.55; if (a <= 0) continue;
    d[k] = d[k] + (255 - d[k]) * a; d[k + 1] *= 1 - a * 0.8; d[k + 2] *= 1 - a * 0.6;
  }
}

const active = (p) => !!p && (p.smooth > 0 || p.even > 0 || p.bright > 0);
export { active as portraitActive };

/** 美肌を当てる。p = { smooth, even, bright }（各 0〜100） */
export function applyPortrait(img, p) {
  if (!active(p)) return;
  const { width: W, height: H, data: d } = img; const S = Math.min(W, H);
  // 肌のある範囲（＋ぼかしの届く余白）だけを切り出して計算する（背景の多い写真ほど速い）
  const full = skinWeights(img, p);
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
          // 赤みだけを抑える（血色は残す）。口紅・チークのようにはっきり赤い所（平均より 25 以上）はそのまま
          const red = cr - crAvg; if (red > 0) cr -= red * t * 0.75 * Math.min(1, Math.max(0, (35 - red) / 10));
          cb += (cbAvg - cb) * t * 0.4; // 黄ぐすみ・青ぐすみをそろえる
        }
        if (br > 0) Y += (255 - Y) * br * w * 0.35 * (Y / 255) ** 0.5; // 暗い影は持ち上げすぎない
        r = Y + 1.402 * (cr - 128); g = Y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128); b = Y + 1.772 * (cb - 128);
      }
      const k4 = i * 4; d[k4] = clamp255(r); d[k4 + 1] = clamp255(g); d[k4 + 2] = clamp255(b);
    }
  }
}
