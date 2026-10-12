// 写真館の仕上げ用のブラシ: 形を整える（ゆがみ）・目元・歯・明るく／暗く（覆い焼き・焼き込み）・しわ取り。
// 修復と同じく、元写真の画素（{ width, height, data: RGBA }）を直接書き換える。編集内容としては、なぞった線（0〜1 の座標）・
// ブラシの半径（短い辺に対する割合）・強さだけを保存し、開くたび・書き出すたびに元写真から再現する（非破壊）。
//
// 書き出し（元の大きさ）では、写真全体ではなく「なぞった所のまわり」だけを読み出して当てるので、
// 画像の一部 img が、全体（W×H）の (ox, oy) の位置にあるとして計算する（at = { W, H, ox, oy }）。

export const BRUSH_TYPES = ['warp', 'eyes', 'teeth', 'dodge', 'burn', 'wrinkle'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const LIN = new Float32Array(256).map((_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const toSrgb = (v) => { v = clamp01(v); return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055); };

/** なぞった線（0〜1）を、この画像の中の画素の座標に。半径も画素に */
function geom(op, at) {
  const S = Math.min(at.W, at.H);
  return { pts: op.pts.map(([x, y]) => [x * at.W - at.ox, y * at.H - at.oy]), rad: Math.max(1.5, op.r * S), amt: op.amt };
}

/** 線のまわりの、ブラシの効き具合（0〜1。中心は 1、縁に向かってなめらかに 0）。線の外接する四角の中だけ */
function strokeMask(img, pts, rad) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const bx = Math.max(0, Math.floor(x0 - rad)); const by = Math.max(0, Math.floor(y0 - rad));
  const bx1 = Math.min(img.width, Math.ceil(x1 + rad + 1)); const by1 = Math.min(img.height, Math.ceil(y1 + rad + 1));
  const w = bx1 - bx; const h = by1 - by;
  if (w <= 0 || h <= 0) return null;
  const m = new Float32Array(w * h);
  const seg = (ax, ay, cx, cy) => {
    const sx0 = Math.max(bx, Math.floor(Math.min(ax, cx) - rad)); const sy0 = Math.max(by, Math.floor(Math.min(ay, cy) - rad));
    const sx1 = Math.min(bx1, Math.ceil(Math.max(ax, cx) + rad + 1)); const sy1 = Math.min(by1, Math.ceil(Math.max(ay, cy) + rad + 1));
    const dx = cx - ax; const dy = cy - ay; const len2 = dx * dx + dy * dy;
    for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
      let t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) / rad;
      if (d >= 1) continue;
      // 中心から半分までは全部効き、そこから縁へなめらかに（smoothstep）
      const u = d <= 0.5 ? 1 : 1 - ((d - 0.5) / 0.5) ** 2 * (3 - 2 * ((d - 0.5) / 0.5));
      const k = (y - by) * w + (x - bx); if (u > m[k]) m[k] = u;
    }
  };
  if (pts.length === 1) seg(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return { m, bx, by, w, h };
}

/** 箱型ぼかしを 3 回（≒ガウスぼかし）。src は Float32Array（ch チャンネル）、w×h */
function blur(src, w, h, ch, r) {
  r = Math.max(1, Math.round(r));
  let a = Float32Array.from(src); let b = new Float32Array(src.length); // 元の配列は書き換えない（呼び出し側があとで使う）
  const pass = (from, to, horiz) => {
    const len = horiz ? w : h; const lines = horiz ? h : w; const n = 2 * r + 1;
    for (let l = 0; l < lines; l++) for (let c = 0; c < ch; c++) {
      const at = (i) => { const j = i < 0 ? 0 : i >= len ? len - 1 : i; return from[(horiz ? l * w + j : j * w + l) * ch + c]; };
      let s = 0; for (let i = -r; i <= r; i++) s += at(i);
      for (let i = 0; i < len; i++) { to[(horiz ? l * w + i : i * w + l) * ch + c] = s / n; s += at(i + r + 1) - at(i - r); }
    }
  };
  for (let i = 0; i < 3; i++) { pass(a, b, true); [a, b] = [b, a]; pass(a, b, false); [a, b] = [b, a]; }
  return a;
}

/** 明るく（覆い焼き）・暗く（焼き込み）: 光の量を増やす・減らす。明るくするときは色が濃くなりすぎないように */
function dodgeBurn(img, mk, amt, dir) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = m[y * w + x]; if (!a) continue;
    const k = ((by + y) * W + bx + x) * 4;
    const r = LIN[d[k]]; const g = LIN[d[k + 1]]; const b = LIN[d[k + 2]];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 1 回なぞるごとに、明るくは最大 +0.6 段・暗くは最大 -0.6 段ほど
    const f = 2 ** (dir * 0.6 * amt * a);
    const L1 = dir > 0 ? Math.min(L * f, L + (1 - L) * 0.8) : L * f; // 白飛びさせない
    const kc = L > 1e-5 ? (dir > 0 ? Math.sqrt(L1 / L) : L1 / L) : 1;
    d[k] = toSrgb(L1 + (r - L) * kc); d[k + 1] = toSrgb(L1 + (g - L) * kc); d[k + 2] = toSrgb(L1 + (b - L) * kc);
  }
}

/** 歯を白く: 黄ばみ（青の不足）だけを減らし、少し明るく。赤い唇・歯ぐきはほとんど変えない */
function teeth(img, mk, amt) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = m[y * w + x]; if (!a) continue;
    const k = ((by + y) * W + bx + x) * 4;
    const r = d[k]; const g = d[k + 1]; const b = d[k + 2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 黄色っぽい（赤と緑が近く、青が少ない）・暗すぎない所ほど強く
    const yellow = Math.max(0, (r + g) / 2 - b) / 255;
    const notRed = clamp01((g / Math.max(r, 1) - 0.8) / 0.1); // 唇・歯ぐき・唇の内側のつや（赤み・ピンク）は除く
    const mx = Math.max(r, g, b); const sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
    const pale = clamp01((0.5 - sat) / 0.2); // 歯は色が薄い
    const bright = clamp01((L - 70) / 60);
    const s = a * amt * notRed * pale * bright;
    if (s <= 0) continue;
    const nb = b + yellow * 255 * s; // 黄ばみ（青の不足）を消す
    const gray = (r + g + nb) / 3;
    const lift = 1 + 0.14 * s; // 少し明るく
    d[k] = Math.min(255, (r + (gray - r) * 0.55 * s) * lift);
    d[k + 1] = Math.min(255, (g + (gray - g) * 0.55 * s) * lift);
    d[k + 2] = Math.min(255, (nb + (gray - nb) * 0.55 * s) * lift);
  }
}

/** 目元: 白目の赤みを減らして明るく、黒目・まつげの輪郭をくっきり、全体を少し明るく（くまを薄く） */
function eyes(img, mk, amt, rad) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  // 細かい所をくっきりさせるため、ぼかした明るさとの差を足す（ブラシの大きさに合わせた半径）
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = ((by + y) * W + bx + x) * 4; lum[y * w + x] = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; }
  const soft = blur(lum, w, h, 1, Math.max(1, rad * 0.08));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = m[y * w + x] * amt; if (!a) continue;
    const k = ((by + y) * W + bx + x) * 4; let r = d[k]; let g = d[k + 1]; let b = d[k + 2];
    const L = lum[y * w + x]; const mx = Math.max(r, g, b); const sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
    // 白目（明るく色の薄い所）: 赤み・黄ばみを減らして、少し白く
    const white = clamp01((L - 110) / 60) * clamp01((0.45 - sat) / 0.25);
    if (white > 0) { const gray = (r + g + b) / 3; const t = 0.6 * white * a; r += (gray - r) * t; g += (gray - g) * t; b += (gray - b) * t; }
    // 輪郭をくっきり＋全体を少し明るく
    const detail = (L - soft[y * w + x]) * 0.5 * a; // 強すぎるとアイラインのように濃くなる
    const lift = 1 + (0.1 + 0.08 * white) * a;
    d[k] = Math.max(0, Math.min(255, (r + detail) * lift)); d[k + 1] = Math.max(0, Math.min(255, (g + detail) * lift)); d[k + 2] = Math.max(0, Math.min(255, (b + detail) * lift));
  }
}

/**
 * しわ取り: 中くらいの大きさの明暗（布のしわ・ほうれい線など）だけをならし、細かい質感（布目・肌のきめ）と大きな明暗（体の形）は残す。
 * pad: ぼかしの計算に必要な、まわりの余白（画素）
 */
function wrinkle(img, mk, amt, rad) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  const big = Math.max(2, rad * 0.35); const small = Math.max(1, big * 0.12);
  const src = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = ((by + y) * W + bx + x) * 4; const o = (y * w + x) * 3; src[o] = d[k]; src[o + 1] = d[k + 1]; src[o + 2] = d[k + 2]; }
  const lo = blur(src, w, h, 3, big); const mid = blur(src, w, h, 3, small);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = m[y * w + x] * amt; if (!a) continue;
    const k = ((by + y) * W + bx + x) * 4; const o = (y * w + x) * 3;
    // 服と肌の境目のような強い輪郭のそばは、ならさない（色がにじんで、光の輪ができるのを防ぐ）。
    // しわの陰は明るさの差が小さく、輪郭は大きいので、その差で見分ける
    const dev = Math.max(Math.abs(mid[o] - lo[o]), Math.abs(mid[o + 1] - lo[o + 1]), Math.abs(mid[o + 2] - lo[o + 2]));
    const t = Math.min(1, Math.max(0, (dev - 14) / 26)); const keep = 1 - t * t * (3 - 2 * t);
    if (keep <= 0) continue;
    const aa = a * keep;
    for (let c = 0; c < 3; c++) {
      // 大きな明暗 ＋ 細かい質感 ＝ 中くらいの明暗（しわ）だけを抜いたもの
      const v = lo[o + c] + (src[o + c] - mid[o + c]);
      d[k + c] = Math.max(0, Math.min(255, src[o + c] + (v - src[o + c]) * aa));
    }
  }
}

/** 双一次補間で 1 画素を読む（コピーから） */
function sample(src, W, H, x, y, out) {
  x = x < 0 ? 0 : x > W - 1 ? W - 1 : x; y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
  const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(x0 + 1, W - 1); const y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0; const fy = y - y0;
  const k00 = (y0 * W + x0) * 4; const k10 = (y0 * W + x1) * 4; const k01 = (y1 * W + x0) * 4; const k11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 3; c++) out[c] = (src[k00 + c] * (1 - fx) + src[k10 + c] * fx) * (1 - fy) + (src[k01 + c] * (1 - fx) + src[k11 + c] * fx) * fy;
}

/**
 * 形を整える（ゆがみ・押し出し）: ブラシの中の画素を、なぞった向きに少し動かす。線の 1 区間ごとに順に当てる
 * （だから、なぞっている途中に 1 区間ずつ当てても、最後にまとめて当てても同じになる）
 */
export function warpSegment(img, p0, p1, rad, amt) {
  let dx = (p1[0] - p0[0]) * amt; let dy = (p1[1] - p0[1]) * amt;
  if (!dx && !dy) return null;
  // 1 区間で動かすのは半径の 2 割まで（速くなぞっても、画素がちぎれない）
  const lim = rad * 0.2; const len = Math.hypot(dx, dy); if (len > lim) { dx *= lim / len; dy *= lim / len; }
  const W = img.width; const H = img.height; const d = img.data;
  const x0 = Math.max(0, Math.floor(p1[0] - rad - 1)); const y0 = Math.max(0, Math.floor(p1[1] - rad - 1));
  const x1 = Math.min(W, Math.ceil(p1[0] + rad + 2)); const y1 = Math.min(H, Math.ceil(p1[1] + rad + 2));
  if (x1 <= x0 || y1 <= y0) return null;
  // 読み出す元（動かす前）は、動かす量だけ広く
  const pad = Math.ceil(Math.hypot(dx, dy)) + 2;
  const cx0 = Math.max(0, x0 - pad); const cy0 = Math.max(0, y0 - pad); const cx1 = Math.min(W, x1 + pad); const cy1 = Math.min(H, y1 + pad);
  const cw = cx1 - cx0; const ch = cy1 - cy0; const copy = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) copy.set(d.subarray(((cy0 + y) * W + cx0) * 4, ((cy0 + y) * W + cx1) * 4), y * cw * 4);
  const px = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const q = Math.hypot(x - p1[0], y - p1[1]) / rad; if (q >= 1) continue;
    const f = (1 - q * q) ** 2; // 中心ほど大きく動かす（ブラシが大きいほど、なめらかに形が変わる）
    sample(copy, cw, ch, x - dx * f - cx0, y - dy * f - cy0, px);
    const k = (y * W + x) * 4; d[k] = px[0]; d[k + 1] = px[1]; d[k + 2] = px[2];
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** ブラシの操作 1 つを、画像（全体または一部）に当てる */
export function applyBrush(img, op, at = { W: img.width, H: img.height, ox: 0, oy: 0 }) {
  const { pts, rad, amt } = geom(op, at);
  if (!pts.length) return;
  if (op.type === 'warp') {
    // 区間の長さで動かす量が決まるので、ブラシの大きさ（画素）に合わせて、全体と一部で同じになる
    for (let i = 1; i < pts.length; i++) warpSegment(img, pts[i - 1], pts[i], rad, amt);
    return;
  }
  const mk = strokeMask(img, pts, rad); if (!mk) return;
  if (op.type === 'dodge') dodgeBurn(img, mk, amt, 1);
  else if (op.type === 'burn') dodgeBurn(img, mk, amt, -1);
  else if (op.type === 'teeth') teeth(img, mk, amt);
  else if (op.type === 'eyes') eyes(img, mk, amt, rad);
  else if (op.type === 'wrinkle') wrinkle(img, mk, amt, rad);
}

/** 書き出しで読み出す範囲（全体の画素の座標 [x, y, w, h]）。ぼかし・動かす量のぶん、まわりも含める */
export function brushBounds(op, W, H) {
  const S = Math.min(W, H); const rad = Math.max(1.5, op.r * S);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let travel = 0;
  op.pts.forEach(([x, y], i) => {
    const px = x * W; const py = y * H; x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    if (i) travel = Math.max(travel, Math.hypot(px - op.pts[i - 1][0] * W, py - op.pts[i - 1][1] * H));
  });
  // しわ取り・目元のぼかしは、ブラシの外の画素も少し使う（境目が変わらないよう、余白を足す）
  const pad = rad * (op.type === 'wrinkle' ? 1.5 : op.type === 'eyes' ? 1.3 : op.type === 'warp' ? 1.2 : 1.05) + travel + 4;
  const rx = Math.max(0, Math.floor(x0 - pad)); const ry = Math.max(0, Math.floor(y0 - pad));
  const rx1 = Math.min(W, Math.ceil(x1 + pad)); const ry1 = Math.min(H, Math.ceil(y1 + pad));
  return rx1 > rx && ry1 > ry ? [rx, ry, rx1 - rx, ry1 - ry] : null;
}
