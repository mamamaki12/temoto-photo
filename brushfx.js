// 写真館の仕上げ用のブラシ: 形を整える（ゆがみ）・目元・歯・明るく／暗く（覆い焼き・焼き込み）・しわ取り。
// 修復と同じく、元写真の画素（{ width, height, data: RGBA }）を直接書き換える。編集内容としては、なぞった線（0〜1 の座標）・
// ブラシの半径（短い辺に対する割合）・強さだけを保存し、開くたび・書き出すたびに元写真から再現する（非破壊）。
//
// 書き出し（元の大きさ）では、写真全体ではなく「なぞった所のまわり」だけを読み出して当てるので、
// 画像の一部 img が、全体（W×H）の (ox, oy) の位置にあるとして計算する（at = { W, H, ox, oy }）。

export const BRUSH_TYPES = ['warp', 'eyes', 'teeth', 'lip', 'dodge', 'burn', 'wrinkle'];
/** リップの色（名前・RGB） */
export const LIP_COLORS = [['pink', 'ピンク', [214, 92, 120]], ['coral', 'コーラル', [232, 110, 88]], ['red', 'レッド', [196, 30, 48]], ['rose', 'ローズ', [178, 70, 92]], ['berry', 'ベリー', [140, 34, 70]], ['nude', 'ヌード', [196, 122, 106]]];

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

/** 点が多角形の中にあるか */
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const ycc = (r, g, b) => [0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b];

/** 唇の輪郭（とその少し外）を囲む四角の中を、ブラシの効き具合 1 で埋めたもの（範囲を自動で決めるとき） */
function lipBoxMask(img, polys, at) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) { const X = x * at.W - at.ox; const Y = y * at.H - at.oy; x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y); }
  const pad = (y1 - y0) * 0.45 + 4;
  const bx = Math.max(0, Math.floor(x0 - pad)); const by = Math.max(0, Math.floor(y0 - pad));
  const bx1 = Math.min(img.width, Math.ceil(x1 + pad)); const by1 = Math.min(img.height, Math.ceil(y1 + pad));
  const w = bx1 - bx; const h = by1 - by;
  return w > 0 && h > 0 ? { m: new Float32Array(w * h).fill(1), bx, by, w, h } : null;
}

/** 輪郭の中を 1 で塗る（inner があれば、その中は 0）。四角 mk の中の画素ごと */
function fillPoly(mk, outer, inner) {
  const { bx, by, w, h } = mk; const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = bx + x + 0.5; const Y = by + y + 0.5;
    if (inPoly(X, Y, outer) && !(inner && inPoly(X, Y, inner))) a[y * w + x] = 1;
  }
  return a;
}

/**
 * AI の輪郭は数画素ずれることがあるので、輪郭のそばでは色で境目を決め直す。
 * prior: 輪郭からの「それらしさ」（輪郭をぼかしたもの。輪郭の上で 0.5）。fg / bg: 色を覚える画素（それらしい所・違う所）。
 * 明るさ・色（YCbCr）のヒストグラムで、その色が「それらしい所」と「違う所」のどちらに多いかを、prior に掛ける（ベイズ）
 */
function refineByColor(img, mk, prior, fg, bg) {
  const { bx, by, w, h } = mk; const d = img.data; const W = img.width;
  const NY = 8; const NC = 24; const span = 48; // Cb・Cr は 128±48 を 24 段に
  const bin = (Y, cb, cr) => {
    const iy = Math.min(NY - 1, Math.max(0, Math.floor(Y / 256 * NY)));
    const ib = Math.min(NC - 1, Math.max(0, Math.floor((cb - 128 + span) / (2 * span) * NC)));
    const ir = Math.min(NC - 1, Math.max(0, Math.floor((cr - 128 + span) / (2 * span) * NC)));
    return (iy * NC + ib) * NC + ir;
  };
  const n = w * h; const bins = new Int32Array(n); const hf = new Float32Array(NY * NC * NC); const hb = new Float32Array(NY * NC * NC);
  let sf = 0; let sb = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const k = ((by + y) * W + bx + x) * 4; const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]);
    const b = bin(Y, cb, cr); bins[i] = b;
    if (fg[i] > 0) { hf[b] += fg[i]; sf += fg[i]; }
    if (bg[i] > 0) { hb[b] += bg[i]; sb += bg[i]; }
  }
  if (sf < 20 || sb < 20) return prior; // 色を覚えるには小さすぎる
  // ヒストグラムを少しならす（隣の段にも少し分ける。サンプルの少ない色で急に変わらないように）
  const smooth = (hh) => {
    let a = hh; for (let ax = 0; ax < 3; ax++) {
      const o = new Float32Array(a.length); const st = ax === 0 ? 1 : ax === 1 ? NC : NC * NC; const len = ax === 2 ? NY : NC;
      for (let i = 0; i < a.length; i++) { const p = Math.floor(i / st) % len; o[i] = a[i] * 0.5 + (p > 0 ? a[i - st] : a[i]) * 0.25 + (p < len - 1 ? a[i + st] : a[i]) * 0.25; }
      a = o;
    }
    return a;
  };
  const pf = smooth(hf); const pb = smooth(hb); const eps = 0.3 / (NY * NC * NC);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = prior[i]; if (p <= 0.01) continue; if (p >= 0.99) { out[i] = 1; continue; }
    const lf = pf[bins[i]] / sf + eps; const lb = pb[bins[i]] / sb + eps;
    out[i] = (p * lf) / (p * lf + (1 - p) * lb);
  }
  return out;
}

/** 輪郭の高さ（画素） */
const polyH = (poly) => { const ys = poly.map((q) => q[1]); return Math.max(...ys) - Math.min(...ys); };
const toPx = (poly, at) => poly.map(([x, y]) => [x * at.W - at.ox, y * at.H - at.oy]);

/**
 * 唇の範囲（0〜1）: AI で見つけた唇の外側の輪郭の内側で、内側の輪郭（口の中）の外。
 * 輪郭のそばは、唇の色とまわり（肌・歯・口の中）の色の違いで境目を決め直し、なめらかにぼかす。
 * polys: [{ outer, inner }]（写真全体に対する 0〜1）。at: この画像の一部が写真全体のどこか
 */
function lipArea(img, mk, polys, at) {
  const { w, h } = mk; const area = new Float32Array(w * h);
  for (const p of polys) {
    const o = toPx(p.outer, at); const n = toPx(p.inner, at); const lipH = Math.max(2, polyH(o));
    const fill = fillPoly(mk, o, n);
    const prior = blur(fill, w, h, 1, Math.max(1, lipH * 0.06)); // 輪郭から唇の厚みの 6% ほどの所までは、色で決める
    // 色を覚える所: 唇の芯（輪郭から離れた所）と、輪郭から離れた外（肌）・口の中
    const core = blur(fill, w, h, 1, Math.max(1, lipH * 0.04)); const wide = blur(fill, w, h, 1, Math.max(2, lipH * 0.18));
    const fg = new Float32Array(w * h); const bg = new Float32Array(w * h);
    for (let i = 0; i < fg.length; i++) { if (core[i] > 0.97) fg[i] = 1; else if (wide[i] < 0.03 || (prior[i] < 0.02 && fill[i] === 0)) bg[i] = 1; }
    const post = refineByColor(img, mk, prior, fg, bg);
    const soft = blur(post, w, h, 1, Math.max(1, lipH * 0.04)); // ざらつき（ノイズで色の判定がばらつく所）をならす
    for (let i = 0; i < area.length; i++) area[i] = Math.max(area[i], soft[i]);
  }
  // 内側の輪郭がずれて歯が唇の範囲に入っていても、歯には色をのせない
  const t = teethArea(img, mk, polys, at).area;
  for (let i = 0; i < area.length; i++) area[i] *= 1 - Math.min(1, t[i] * 1.5);
  return area;
}

/**
 * 歯の範囲（0〜1）と、まわりの肌の色（照明の色の目安）。
 * 口を大きく開けて笑っていると AI の内側の輪郭は歯の上にずれることがあるので、範囲は外側の輪郭の中から色で選ぶ:
 * 肌より赤みが少ない（または同じくらいの）明るい所が歯。唇・歯ぐき・舌（赤い所）と、口の奥の暗い所は選ばない。
 * 暗い舞台など照明の色が強い写真では、歯もオレンジ色に写るので、色の基準は決まった値ではなく、その写真の肌・唇と比べる
 */
function teethArea(img, mk, polys, at) {
  const { bx, by, w, h } = mk; const d = img.data; const W = img.width; const area = new Float32Array(w * h);
  let rs = 0; let rb = 0; let rr = 0; // まわりの肌の色（明るさで割った Cb・Cr）
  const px = (i) => ((by + Math.floor(i / w)) * W + bx + (i % w)) * 4;
  const gr = (k) => d[k + 1] / Math.max(1, d[k]);
  for (const p of polys) {
    const n = toPx(p.inner, at); const o = toPx(p.outer, at);
    const lipH = Math.max(2, polyH(o)); if (polyH(n) < Math.max(1.5, lipH * 0.04)) continue; // 口を閉じている
    const face = fillPoly(mk, o, null); const lipFill = fillPoly(mk, o, n);
    const wide = blur(face, w, h, 1, Math.max(2, lipH * 0.15)); const edge = blur(face, w, h, 1, Math.max(1, lipH * 0.04));
    const mouth = blur(fillPoly(mk, n, null), w, h, 1, Math.max(1, lipH * 0.06)); // 内側の輪郭の中は、歯らしさを高めに
    // 基準: 口の中の明るさ（明るい方から 1 割の所）、唇と肌の赤み（緑÷赤のまん中）
    const Ls = []; const lipGr = []; const skinGr = [];
    for (let i = 0; i < face.length; i++) {
      const k = px(i);
      if (face[i]) { Ls.push(ycc(d[k], d[k + 1], d[k + 2])[0]); if (lipFill[i]) lipGr.push(gr(k)); }
      else if (wide[i] < 0.02) { const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]); if (Y > 8) { skinGr.push(gr(k)); rs += 1; rb += (cb - 128) / Y; rr += (cr - 128) / Y; } }
    }
    if (Ls.length < 10 || lipGr.length < 10 || skinGr.length < 10) continue;
    const med = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    Ls.sort((x, y) => x - y); const Lref = Math.max(12, Ls[Math.floor(Ls.length * 0.9)]);
    const gSkin = med(skinGr); const span = Math.max(0.05, gSkin - med(lipGr));
    const g0 = gSkin - 0.3 * span; const g1 = gSkin + 0.15 * span; // 唇と肌の間より赤い所は歯ではない
    const like = new Float32Array(w * h); const fg = new Float32Array(w * h); const bg = new Float32Array(w * h); const prior = new Float32Array(w * h);
    for (let i = 0; i < like.length; i++) {
      prior[i] = clamp01((edge[i] - 0.5) * 2.5) * (0.55 + 0.45 * mouth[i]); if (prior[i] <= 0.01) continue; // 外側の輪郭の少し内側まで
      const k = px(i); const [Y] = ycc(d[k], d[k + 1], d[k + 2]);
      const bright = clamp01((Y / Lref - 0.5) / 0.3); // 口の中のいちばん明るい所の半分より暗い所（口の奥・影・唇の陰）は除く
      const notRed = clamp01((gr(k) - g0) / (g1 - g0));
      like[i] = bright * notRed;
      if (like[i] > 0.8) fg[i] = 1; else if (like[i] < 0.15) bg[i] = 1;
    }
    const post = refineByColor(img, mk, prior, fg, bg);
    for (let i = 0; i < like.length; i++) like[i] = Math.min(1, like[i] * 1.25) * post[i];
    const soft = blur(like, w, h, 1, Math.max(1, lipH * 0.01));
    for (let i = 0; i < area.length; i++) area[i] = Math.max(area[i], soft[i]);
  }
  return { area, skin: rs ? [rb / rs, rr / rs] : [0, 0] };
}

/**
 * リップ: なぞった中の「唇」だけに色をのせる（AI で見つけた唇の範囲。なければ、まわりの肌より赤い所）。col: [r, g, b]
 * 唇の中を同じ色で塗りつぶさず、元の唇の明暗（つや・しわ・影）と色の濃淡を、そのまま新しい色に写す:
 * - 明るさ: 元の明るさ × (目標の明るさ ÷ 唇の平均の明るさ) を少しだけ。つやは明るいまま、影は暗いまま
 * - 色の濃さ: 目標の色の濃さ × (その所の元の色の濃さ ÷ 唇の平均の色の濃さ)。濃い所は濃く、薄い所は薄く
 */
function lip(img, mk, amt, col, area) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  // まわりの肌の赤み（AI の範囲がないとき用）: ブラシの中の赤みの少ない方から 25% の所
  const crs = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { if (m[y * w + x] < 0.2) continue; const k = ((by + y) * W + bx + x) * 4; crs.push(ycc(d[k], d[k + 1], d[k + 2])[2]); }
  if (!crs.length) return;
  crs.sort((p, q) => p - q); const skinCr = crs[Math.floor(crs.length * 0.25)];
  const lipOf = (i, Y, cr) => (area ? area[i] * clamp01((Y - 20) / 20) : clamp01((cr - skinCr - 6) / 10) * clamp01((Y - 25) / 25));
  // 唇の平均の明るさ・色の濃さ（唇らしさで重みをつけて）
  let sw = 0; let sY = 0; let sC = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!m[i]) continue; const k = ((by + y) * W + bx + x) * 4; const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]);
    const l = lipOf(i, Y, cr) * m[i]; if (l <= 0.3) continue; sw += l; sY += l * Y; sC += l * Math.hypot(cb - 128, cr - 128);
  }
  if (!sw) return;
  const mY = sY / sw; const mC = Math.max(4, sC / sw);
  const [tY, tCb, tCr] = ycc(col[0], col[1], col[2]); const tC = Math.hypot(tCb - 128, tCr - 128);
  const tdir = tC > 0 ? [(tCb - 128) / tC, (tCr - 128) / tC] : [0, 0];
  // 目標の明るさへの寄せ方（唇全体の明るさを、目標の色の明るさへ少しだけ。明るくするのは控えめ）
  const yGain = Math.min(1.15, Math.max(0.6, tY / Math.max(mY, 1)));
  // 目標の色の濃さは、唇の明るさに合わせる（暗い唇に明るい色の濃さをそのままのせると、蛍光色のように浮く）
  const cScale = Math.min(1, Math.max(0.35, mY / Math.max(tY, 1)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const a0 = m[i]; if (!a0) continue;
    const k = ((by + y) * W + bx + x) * 4; const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]);
    const a = a0 * amt * lipOf(i, Y, cr); if (a <= 0) continue;
    // この所の元の色の濃さ・明るさの、唇の平均に対する比（濃淡・明暗）
    const relC = Math.min(1.8, Math.max(0.4, Math.hypot(cb - 128, cr - 128) / mC));
    const relY = Math.min(1.6, Math.max(0.5, Y / mY));
    const c = tC * cScale * relC * Math.min(1.2, Math.max(0.6, relY ** 0.5)); // 明るい所は少し濃く、影は少し淡く
    const gCb = 128 + tdir[0] * c; const gCr = 128 + tdir[1] * c;
    const Y1 = Y * (1 + (yGain - 1) * 0.5 * a);
    const cb1 = cb + (gCb - cb) * a; const cr1 = cr + (gCr - cr) * a;
    d[k] = Math.max(0, Math.min(255, Y1 + 1.402 * (cr1 - 128)));
    d[k + 1] = Math.max(0, Math.min(255, Y1 - 0.344136 * (cb1 - 128) - 0.714136 * (cr1 - 128)));
    d[k + 2] = Math.max(0, Math.min(255, Y1 + 1.772 * (cb1 - 128)));
  }
}

/**
 * 歯を白く: 黄ばみ（色）を減らし、少し明るく。赤い唇・歯ぐきはほとんど変えない。
 * area があれば（自動で決めた歯の範囲）、その範囲に当てる。黄ばみは消しきらず半分ほどにする
 * （照明の色がついた写真で歯だけ真っ白・青白くなると、浮いて見えるため）
 */
function teeth(img, mk, amt, area) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = m[y * w + x]; if (!a) continue;
    const k = ((by + y) * W + bx + x) * 4;
    const r = d[k]; const g = d[k + 1]; const b = d[k + 2];
    if (area) {
      const s = a * amt * area.area[y * w + x]; if (s <= 0.002) continue;
      const [Y, cb, cr] = ycc(r, g, b);
      // 色（黄ばみ）を、まわりの肌の色の半分くらいの淡い色に寄せる（照明の色は残る。真っ白・青白くはしない）
      const t = 0.75 * s; const tb = area.skin[0] * 0.55 * Y; const tr = area.skin[1] * 0.55 * Y;
      const cb1 = cb - 128 < tb ? cb + (tb - (cb - 128)) * t : cb; // 黄色み（青の不足）が目安より強いときだけ減らす
      const cr1 = cr - 128 > tr ? cr + (tr - (cr - 128)) * t : cr; // 赤みも同じ
      const Y1 = Y + Math.min(Y * 0.16, 255 - Y) * s * (1 - Y / 300); // 少し明るく（もともと明るい所は控えめ）
      d[k] = Math.max(0, Math.min(255, Y1 + 1.402 * (cr1 - 128)));
      d[k + 1] = Math.max(0, Math.min(255, Y1 - 0.344136 * (cb1 - 128) - 0.714136 * (cr1 - 128)));
      d[k + 2] = Math.max(0, Math.min(255, Y1 + 1.772 * (cb1 - 128)));
      continue;
    }
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
 * しわ取り: 布のしわ・ほうれい線などの「陰」をならす。
 * - 明るさを「大まかな明るさ（土台）＋ 細かい質感（布目・肌のきめ）」に分け、土台だけをなめらかにする
 * - 土台は、同じ素材（色みが近い）の画素だけで平均する（色みで重みをつけたぼかし）。だから深いしわの陰はならすが、
 *   服と肌・服と背景の境目は混ざらない（にじみ・光の輪ができない）
 * - 色みはそのままで、明るさだけを変える（柄の色は残る）
 */
function wrinkle(img, mk, amt, rad) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width;
  const n = w * h; const L = new Float32Array(n); const ca = new Float32Array(n); const cb = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = ((by + y) * W + bx + x) * 4; const r = d[k]; const g = d[k + 1]; const b = d[k + 2]; const i = y * w + x;
    // 色み（明るさで割った値）: しわの暗い所も明るい所も同じ素材なら同じ。黒いひもと紺の服は違う
    L[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b; ca[i] = (r - g) / (L[i] + 15); cb[i] = (b - (r + g) / 2) / (L[i] + 15);
  }
  // 細かい質感（これは残す）
  const fineR = Math.max(1, rad * 0.04);
  const Ls = blur(L, w, h, 1, fineR);
  // 土台: 粗い格子（1 マス f 画素）の上で、色みの近いマスだけを平均する
  const reach = Math.max(4, rad * 1.2); /* なぞったブラシの大きさくらいのしわまでならす */ const f = Math.max(1, Math.round(reach / 8)); const K = Math.max(2, Math.round(reach / f));
  const gw = Math.ceil(w / f); const gh = Math.ceil(h / f);
  const gL = new Float32Array(gw * gh); const gA = new Float32Array(gw * gh); const gB = new Float32Array(gw * gh); const gn = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; const c = ((y / f) | 0) * gw + ((x / f) | 0); gL[c] += Ls[i]; gA[c] += ca[i]; gB[c] += cb[i]; gn[c]++; }
  for (let c = 0; c < gw * gh; c++) { gL[c] /= gn[c]; gA[c] /= gn[c]; gB[c] /= gn[c]; }
  const base = new Float32Array(gw * gh); const sp = 2 * (K / 2) ** 2; const sc = 2 * 0.12 ** 2;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const c0 = gy * gw + gx; let sw = 0; let sv = 0;
    for (let yy = Math.max(0, gy - K); yy <= Math.min(gh - 1, gy + K); yy++) for (let xx = Math.max(0, gx - K); xx <= Math.min(gw - 1, gx + K); xx++) {
      const c = yy * gw + xx; const dA = gA[c] - gA[c0]; const dB = gB[c] - gB[c0]; const dL = gL[c] - gL[c0];
      // 明るさの差は、暗い所ほど小さな差でも別の物（黒いひもと紺の服など）とみなす
      const sL = 0.45 * (gL[c0] + 20);
      const wgt = Math.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / sp - (dA * dA + dB * dB) / sc - (dL * dL) / (2 * sL * sL));
      sw += wgt; sv += wgt * gL[c];
    }
    base[c0] = sv / sw;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const a = m[i] * amt; if (!a) continue;
    // 土台を元の大きさに戻す: まわりのマスのうち、この画素と色み・明るさが近いマスだけから取る（境目で別の素材が混ざらない）
    const fx = (x + 0.5) / f - 0.5; const fy = (y + 0.5) / f - 0.5; const cx0 = Math.floor(fx); const cy0 = Math.floor(fy);
    const sL = 0.45 * (Ls[i] + 20); let sw = 0; let sv = 0;
    for (let yy = cy0 - 1; yy <= cy0 + 2; yy++) for (let xx = cx0 - 1; xx <= cx0 + 2; xx++) {
      if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
      const c = yy * gw + xx; const dA = gA[c] - ca[i]; const dB = gB[c] - cb[i]; const dL = gL[c] - Ls[i];
      const wgt = Math.max(0, 1.5 - Math.abs(xx - fx)) * Math.max(0, 1.5 - Math.abs(yy - fy)) * Math.exp(-(dA * dA + dB * dB) / sc - (dL * dL) / (2 * sL * sL));
      sw += wgt; sv += wgt * base[c];
    }
    if (sw < 0.05) continue; // 近いマスがない（細い別の物）→ ならさない
    const bse = sv / sw;
    // 同じ素材の土台からかけ離れた画素（細いひも・髪など）は、ならさない
    const rel = Math.abs(Ls[i] - bse) / (bse + 15);
    const keep = 1 - Math.min(1, Math.max(0, (rel - 0.45) / 0.3));
    // 明るさだけを、R・G・B に同じだけ足して変える（色を濃くしない。ほくろが赤い点になったりしない）
    const dl = (bse + (L[i] - Ls[i]) - L[i]) * a * keep * Math.min(1, sw);
    const k = ((by + y) * W + bx + x) * 4;
    d[k] = Math.max(0, Math.min(255, d[k] + dl)); d[k + 1] = Math.max(0, Math.min(255, d[k + 1] + dl)); d[k + 2] = Math.max(0, Math.min(255, d[k + 2] + dl));
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
 * 形を整えるとき、背景をゆがませないための「動かさない色」を決める（なぞり始めの 1 区間から）。
 * ブラシの中の色を 2 つに分け、指の後ろ側（押す向きと反対側）に多い方を「背景」とする。
 * あごの外側から内側へ押すと、背景は動かさずに、顔の側だけが縮み、空いた所に背景が入る。
 * 2 つの色が近すぎる（境目がない）ときは null（ふつうにゆがませる）
 */
/** 色の見分け用の特徴: 明るさより色み（肌の赤み・壁の無彩色など）を重く見る */
const feat = (r, g, b) => [(r + g + b) / 6, (r - g) * 1.5, (b - (r + g) / 2) * 1.5];
export function warpGuard(img, p0, p1, rad) {
  const dx = p1[0] - p0[0]; const dy = p1[1] - p0[1]; const len = Math.hypot(dx, dy); if (!len) return null;
  const ux = dx / len; const uy = dy / len; const W = img.width; const H = img.height; const d = img.data;
  const step = Math.max(1, Math.round(rad / 24)); const px = []; const proj = [];
  for (let y = Math.max(0, Math.floor(p0[1] - rad)); y < Math.min(H, Math.ceil(p0[1] + rad)); y += step) {
    for (let x = Math.max(0, Math.floor(p0[0] - rad)); x < Math.min(W, Math.ceil(p0[0] + rad)); x += step) {
      const ox = x - p0[0]; const oy = y - p0[1]; if (ox * ox + oy * oy > rad * rad) continue;
      const k = (y * W + x) * 4; px.push(feat(d[k], d[k + 1], d[k + 2])); proj.push(ox * ux + oy * uy);
    }
  }
  if (px.length < 8) return null;
  // 2 つに分ける（はじめは指の後ろ側と前側の平均から）
  const mean = (sel) => { const m = [0, 0, 0]; let n = 0; px.forEach((c, i) => { if (sel(i)) { m[0] += c[0]; m[1] += c[1]; m[2] += c[2]; n++; } }); return n ? m.map((v) => v / n) : null; };
  let a = mean((i) => proj[i] < 0); let b = mean((i) => proj[i] >= 0); if (!a || !b) return null;
  const dist = (c, m) => Math.hypot(c[0] - m[0], c[1] - m[1], c[2] - m[2]);
  let lab = [];
  for (let it = 0; it < 8; it++) {
    lab = px.map((c) => (dist(c, a) <= dist(c, b) ? 0 : 1));
    const na = mean((i) => lab[i] === 0); const nb = mean((i) => lab[i] === 1); if (!na || !nb) return null; a = na; b = nb;
  }
  const gap = dist(a, b); if (gap < 28) return null;
  // より指の後ろ側にある方（位置の平均が、押す向きと反対側）が、動かさない色
  let pa = 0; let na = 0; let pb = 0; let nb = 0; lab.forEach((l, i) => { if (l === 0) { pa += proj[i]; na++; } else { pb += proj[i]; nb++; } });
  const keepA = pa / na <= pb / nb;
  const u = keepA ? a : b; const v = keepA ? b : a; const t = gap * 0.2;
  // 動かさない所の地図: なぞり始めのまわり（半径の 2.5 倍の四角）で、背景の色に近く、
  // しかも指の後ろ側の背景とつながっている所だけ（髪・ひげの暗い所が背景と同じ色でも、離れていれば動かす）
  const R = rad * 2.5; const mx0 = Math.max(0, Math.floor(p0[0] - R)); const my0 = Math.max(0, Math.floor(p0[1] - R));
  const mw = Math.min(W, Math.ceil(p0[0] + R)) - mx0; const mh = Math.min(H, Math.ceil(p0[1] + R)) - my0;
  if (mw <= 0 || mh <= 0) return null;
  const mem = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const k = ((my0 + y) * W + mx0 + x) * 4; const c = feat(d[k], d[k + 1], d[k + 2]);
    mem[y * mw + x] = clamp01((dist(c, v) - dist(c, u)) / (2 * t) + 0.5);
  }
  const reach = new Uint8Array(mw * mh); const queue = [];
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const ox = mx0 + x - p0[0]; const oy = my0 + y - p0[1];
    if (ox * ox + oy * oy <= rad * rad && ox * ux + oy * uy < -0.3 * rad && mem[y * mw + x] > 0.6) { reach[y * mw + x] = 1; queue.push(y * mw + x); }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]; const x = c % mw; const y = (c / mw) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
      const n = ny * mw + nx; if (reach[n] || mem[n] <= 0.5) continue; reach[n] = 1; queue.push(n);
    }
  }
  if (!queue.length) return null;
  // 押す先（指の前側）にある、動かす物（肌など）と違う色の物（向こう側のリュック・服など）も動かさない。
  // 動かす物の色の広がりは、なぞり始めのブラシの中で動かす側に分けた色から決める
  const vd = []; lab.forEach((l, i) => { if ((l === 0) !== keepA) vd.push(dist(px[i], v)); }); vd.sort((p, q) => p - q);
  const thr1 = vd[Math.floor(vd.length * 0.85)] ?? t; const thr2 = thr1 * 1.6 + 10;
  let keep = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const n = y * mw + x;
    if (reach[n]) { keep[n] = mem[n]; continue; }
    const ox = mx0 + x - p0[0]; const oy = my0 + y - p0[1]; if (ox * ux + oy * uy < 0) continue;
    const k = ((my0 + y) * W + mx0 + x) * 4; const dv = dist(feat(d[k], d[k + 1], d[k + 2]), v);
    keep[n] = clamp01((dv - thr1) / (thr2 - thr1));
  }
  keep = blur(keep, mw, mh, 1, Math.max(1, rad * 0.04)); // 境目をなめらかに（ギザギザ・ちぎれを防ぐ）
  return { keep, x0: mx0, y0: my0, w: mw, h: mh };
}

/**
 * 形を整える（ゆがみ・押し出し）: ブラシの中の画素を、なぞった向きに少し動かす。線の 1 区間ごとに順に当てる
 * （だから、なぞっている途中に 1 区間ずつ当てても、最後にまとめて当てても同じになる）。
 * guard があれば、その色（背景）の画素は動かさない
 */
export function warpSegment(img, p0, p1, rad, amt, guard = null) {
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
    const k = (y * W + x) * 4;
    const gx = x - (guard?.x0 ?? 0); const gy = y - (guard?.y0 ?? 0);
    const keep = guard && gx >= 0 && gy >= 0 && gx < guard.w && gy < guard.h ? guard.keep[gy * guard.w + gx] : 0;
    if (keep > 0) {
      // 背景（なぞり始めに決めた、動かさない所）は動かさない。背景のまっすぐな線が曲がらない
      d[k] = d[k] * keep + px[0] * (1 - keep); d[k + 1] = d[k + 1] * keep + px[1] * (1 - keep); d[k + 2] = d[k + 2] * keep + px[2] * (1 - keep);
    } else { d[k] = px[0]; d[k + 1] = px[1]; d[k + 2] = px[2]; }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** ブラシの操作 1 つを、画像（全体または一部）に当てる */
export function applyBrush(img, op, at = { W: img.width, H: img.height, ox: 0, oy: 0 }) {
  const { pts, rad, amt } = geom(op, at);
  if (!pts.length) return;
  if (op.type === 'warp') {
    // 区間の長さで動かす量が決まるので、ブラシの大きさ（画素）に合わせて、全体と一部で同じになる
    // 背景の色は、なぞり始めの区間で決めて、最後まで同じものを使う
    const guard = op.keepBg === false || pts.length < 2 ? null : warpGuard(img, pts[0], pts[1], rad);
    for (let i = 1; i < pts.length; i++) warpSegment(img, pts[i - 1], pts[i], rad, amt, guard);
    return;
  }
  if ((op.type === 'lip' || op.type === 'teeth') && op.whole && op.lips?.length) {
    // 範囲を自動で: なぞった所は目印。AI で見つけた唇（上唇・下唇）・歯の全体に当てる
    const mk = lipBoxMask(img, op.lips, at); if (!mk) return;
    if (op.type === 'lip') lip(img, mk, amt, op.col || LIP_COLORS[0][2], lipArea(img, mk, op.lips, at));
    else teeth(img, mk, amt, teethArea(img, mk, op.lips, at));
    return;
  }
  const mk = strokeMask(img, pts, rad); if (!mk) return;
  if (op.type === 'dodge') dodgeBurn(img, mk, amt, 1);
  else if (op.type === 'burn') dodgeBurn(img, mk, amt, -1);
  else if (op.type === 'teeth') teeth(img, mk, amt);
  else if (op.type === 'lip') lip(img, mk, amt, op.col || LIP_COLORS[0][2], op.lips?.length ? lipArea(img, mk, op.lips, at) : null);
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
  // 範囲を自動で決めるときは、唇のまわりも読み出す（唇の高さの 5 割ほど外まで。色を覚える所とぼかしのぶん）
  if ((op.type === 'lip' || op.type === 'teeth') && op.whole) for (const l of op.lips || []) {
    const ys = l.outer.map((q) => q[1] * H); const m = (Math.max(...ys) - Math.min(...ys)) * 0.5 + 8;
    for (const [x, y] of l.outer) { x0 = Math.min(x0, x * W - m); y0 = Math.min(y0, y * H - m); x1 = Math.max(x1, x * W + m); y1 = Math.max(y1, y * H + m); }
  }
  // しわ取り・目元のぼかしは、ブラシの外の画素も少し使う（境目が変わらないよう、余白を足す）
  const pad = rad * (op.type === 'wrinkle' ? 1.5 : op.type === 'eyes' ? 1.3 : op.type === 'warp' ? 2.6 : 1.05) + travel + 4;
  const rx = Math.max(0, Math.floor(x0 - pad)); const ry = Math.max(0, Math.floor(y0 - pad));
  const rx1 = Math.min(W, Math.ceil(x1 + pad)); const ry1 = Math.min(H, Math.ceil(y1 + pad));
  return rx1 > rx && ry1 > ry ? [rx, ry, rx1 - rx, ry1 - ry] : null;
}
