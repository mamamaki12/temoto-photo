// 写真館の仕上げ用のブラシ: 形を整える（ゆがみ）・目元・歯・明るく／暗く（覆い焼き・焼き込み）・しわ取り。
// 修復と同じく、元写真の画素（{ width, height, data: RGBA }）を直接書き換える。編集内容としては、なぞった線（0〜1 の座標）・
// ブラシの半径（短い辺に対する割合）・強さだけを保存し、開くたび・書き出すたびに元写真から再現する（非破壊）。
//
// 書き出し（元の大きさ）では、写真全体ではなく「なぞった所のまわり」だけを読み出して当てるので、
// 画像の一部 img が、全体（W×H）の (ox, oy) の位置にあるとして計算する（at = { W, H, ox, oy }）。

export const BRUSH_TYPES = ['warp', 'eyes', 'teeth', 'lip', 'nose', 'dodge', 'burn', 'wrinkle'];
/**
 * 鼻筋に使う顔の点（MediaPipe の 478 点の番号）。mid: 鼻筋のまん中（眉間→鼻先→鼻先の下）、
 * li/ri: 鼻筋の左右のふち（鼻の上の面と横の面の境目）、lo/ro: 鼻の横の面と頬の境目（小鼻の上まで）
 */
export const NOSE_POINTS = { mid: [168, 6, 197, 195, 5, 4, 1], li: [122, 196, 3, 51, 45], ri: [351, 419, 248, 281, 275], lo: [174, 236, 131, 115], ro: [399, 456, 360, 344] };
/** リップの色（名前・RGB） */
// リップの色の見本は、市販の口紅（ディオール・シャネル・イヴ・サンローラン・ジバンシィ・メイベリンの 287 色）を色の系統で分け、
// それぞれの系統のまん中に近い実際の色にした（ピンク: ディオール 351、コーラル: ディオール 644、レッド: ジバンシィ 13、
// ローズ: ジバンシィ 23、ベリー: ディオール 867、ヌード: イヴ・サンローラン 11 の色）
export const LIP_COLORS = [['pink', 'ピンク', [228, 97, 119]], ['coral', 'コーラル', [234, 83, 49]], ['red', 'レッド', [202, 41, 46]], ['rose', 'ローズ', [198, 46, 84]], ['berry', 'ベリー', [144, 26, 50]], ['nude', 'ヌード', [192, 107, 114]]];

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

/** 輪郭の高さ（画素） */
const polyH = (poly) => { const ys = poly.map((q) => q[1]); return Math.max(...ys) - Math.min(...ys); };
const toPx = (poly, at) => poly.map(([x, y]) => [x * at.W - at.ox, y * at.H - at.oy]);

/** 明るさ・色（Y・Cb・Cr）の正規分布（共分散つき）。重み w の画素から作る。少なすぎれば null */
function gauss(F, w, n) {
  let s = 0; const m = [0, 0, 0];
  for (let i = 0; i < n; i++) { const a = w[i]; if (a <= 0) continue; s += a; m[0] += a * F[i * 3]; m[1] += a * F[i * 3 + 1]; m[2] += a * F[i * 3 + 2]; }
  if (s < 12) return null;
  m[0] /= s; m[1] /= s; m[2] /= s;
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (let i = 0; i < n; i++) {
    const a = w[i]; if (a <= 0) continue; const x = F[i * 3] - m[0]; const y = F[i * 3 + 1] - m[1]; const z = F[i * 3 + 2] - m[2];
    C[0] += a * x * x; C[1] += a * x * y; C[2] += a * x * z; C[3] += a * y * y; C[4] += a * y * z; C[5] += a * z * z;
  }
  for (let k = 0; k < 6; k++) C[k] /= s;
  C[0] += 9; C[3] += 2; C[5] += 2; // ノイズのぶん少し広げる（明るさは色より大きく）
  const [xx, xy, xz, yy, yz, zz] = C;
  const A = yy * zz - yz * yz; const B = xz * yz - xy * zz; const D = xy * yz - xz * yy;
  const det = xx * A + xy * B + xz * D; if (!(det > 1e-6)) return null;
  const inv = [A / det, B / det, D / det, (xx * zz - xz * xz) / det, (xz * xy - xx * yz) / det, (xx * yy - xy * xy) / det];
  return { m, inv, norm: -0.5 * Math.log(det) };
}
const logLike = (g, F, i) => {
  const x = F[i * 3] - g.m[0]; const y = F[i * 3 + 1] - g.m[1]; const z = F[i * 3 + 2] - g.m[2]; const v = g.inv;
  const q = x * (v[0] * x + v[1] * y + v[2] * z) + y * (v[1] * x + v[3] * y + v[4] * z) + z * (v[2] * x + v[4] * y + v[5] * z);
  return g.norm - 0.5 * Math.min(q, 200);
};
/**
 * 明るい所と暗い所に分けた、2 つの正規分布（日の当たった肌と影の肌、つやのある下唇と影の上唇など、明るさで色が変わるもの用）。
 * どちらかが作れなければ 1 つだけ
 */
function gauss2(F, w, n) {
  const ys = []; for (let i = 0; i < n; i++) if (w[i] > 0) ys.push(F[i * 3]);
  if (ys.length < 24) { const g = gauss(F, w, n); return g ? [g] : null; }
  ys.sort((a, b) => a - b); const mid = ys[ys.length >> 1];
  const lo = new Float32Array(n); const hi = new Float32Array(n);
  for (let i = 0; i < n; i++) if (w[i] > 0) (F[i * 3] < mid ? lo : hi)[i] = w[i];
  const g = [gauss(F, lo, n), gauss(F, hi, n)].filter(Boolean);
  if (g.length) return g;
  const one = gauss(F, w, n); return one ? [one] : null;
}
const mixLike = (gs, F, i) => {
  if (gs.length === 1) return logLike(gs[0], F, i);
  const a = logLike(gs[0], F, i); const b = logLike(gs[1], F, i); const m = Math.max(a, b);
  return m + Math.log(0.5 * Math.exp(a - m) + 0.5 * Math.exp(b - m));
};
/**
 * 影に入った歯（口の端の奥歯・上の歯の陰になった下の歯）: 影では明るさも色の濃さ（Cb・Cr の 128 からの差）も同じ割合で小さくなるので、
 * 画素を 1/k 倍に戻してから日の当たった歯の分布で測る。暗い所ほどノイズが大きいので、少しだけ割り引く
 */
const SHADE = [0.7, 0.5, 0.35]; const F1 = new Float32Array(3);
const shadeLike = (gs, F, i) => {
  let best = mixLike(gs, F, i);
  for (const k of SHADE) {
    F1[0] = F[i * 3] / k; F1[1] = 128 + (F[i * 3 + 1] - 128) / k; F1[2] = 128 + (F[i * 3 + 2] - 128) / k;
    best = Math.max(best, mixLike(gs, F1, 0) - 1.2);
  }
  return best;
};
/** しきい値より大きい所のつながり（4 近傍）。つながりごとの番号と大きさ */
function components(a, w, h, th) {
  const lab = new Int32Array(w * h).fill(-1); const sizes = []; const st = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] < th || lab[i] >= 0) continue;
    const id = sizes.length; let n = 0; lab[i] = id; st.push(i);
    while (st.length) {
      const j = st.pop(); n++; const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) if (k >= 0 && k < a.length && lab[k] < 0 && a[k] >= th) { lab[k] = id; st.push(k); }
    }
    sizes.push(n);
  }
  return { lab, sizes };
}

/**
 * 口のまわりを「肌・唇・歯・口の奥（暗い所）」に塗り分ける。AI の輪郭は大きく笑うとずれる（上唇が細く写る・内側の輪郭が歯の上に乗る）ので、
 * 輪郭は「だいたいこのあたり」という目安にとどめ、境目はこの写真の色で決める:
 * 1. 確かな所（輪郭から離れた肌・唇の中で肌よりはっきり赤い所・口の中で明るく赤みの少ない所・暗い所）から、4 つの色の分布を覚える
 * 2. 画素ごとに、色の分布と輪郭の目安から、どれらしいかを出す。となりの画素と揃うように何回かならす（ノイズ・つやで斑にならない）
 * 3. 分けた結果で色の分布を作り直して、もう 1 回
 * 4. 歯は、大きな歯のかたまりから離れた小さな明るい所（唇のつや・肌のてかり）を外す
 * @returns {{ lip: Float32Array, teeth: Float32Array, skin: number[] }} skin: まわりの肌の色（明るさで割った Cb・Cr。歯の色の目安）
 */
function segmentMouth(img, mk, p, at) {
  const { bx, by, w, h } = mk; const d = img.data; const W = img.width; const n = w * h;
  const o = toPx(p.outer, at); const nn = toPx(p.inner, at); const lipH = Math.max(3, polyH(o));
  const F = new Float32Array(n * 3); const gr = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const k = ((by + y) * W + bx + x) * 4; const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]);
    F[i * 3] = Y; F[i * 3 + 1] = cb; F[i * 3 + 2] = cr; gr[i] = d[k + 1] / Math.max(1, d[k]);
  }
  const face = fillPoly(mk, o, null); const inner = fillPoly(mk, nn, null); const ring = fillPoly(mk, o, nn);
  const open = polyH(nn) >= Math.max(1.5, lipH * 0.04);
  const sOutT = blur(face, w, h, 1, Math.max(1, lipH * 0.08)); // 輪郭の目安（ずれを見込んで、外へ少しぼかす。中は 1 のまま）
  for (let i = 0; i < n; i++) if (face[i]) sOutT[i] = 1; // 口の端の細い所でも、輪郭の中を薄めない
  const sIn = blur(inner, w, h, 1, Math.max(2, lipH * 0.12));
  const sLip = new Float32Array(n); for (let i = 0; i < n; i++) sLip[i] = Math.max(0, sOutT[i] - sIn[i] * 0.7);
  // 確かな所から、まわりの肌・唇の基準
  const q = (a, t) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[Math.floor(a.length * t)]; };
  const skinW = new Float32Array(n); const skinGr = []; const skinY = []; let rs = 0; let rb = 0; let rr = 0;
  for (let i = 0; i < n; i++) {
    if (sOutT[i] >= 0.02) continue; // 確かな肌（輪郭から唇の厚みの 2 割ほど離れた所）
    skinW[i] = 1; skinGr.push(gr[i]); skinY.push(F[i * 3]);
    if (F[i * 3] > 8) { rs++; rb += (F[i * 3 + 1] - 128) / F[i * 3]; rr += (F[i * 3 + 2] - 128) / F[i * 3]; }
  }
  const gSkin = q(skinGr, 0.5); const ySkin = q(skinY, 0.5);
  const ringGr = []; const innerY = []; const faceY = [];
  for (let i = 0; i < n; i++) { if (ring[i]) ringGr.push(gr[i]); if (face[i]) faceY.push(F[i * 3]); if (inner[i] || sIn[i] > 0.5) innerY.push(F[i * 3]); }
  const span = Math.max(0.04, gSkin - (ringGr.length ? q(ringGr, 0.3) : gSkin - 0.1));
  // 歯の明るさの目安: 口の中（内側の輪郭の中）の明るい方。唇のつや・日の当たった肌の明るさには合わせない
  const yT = innerY.length > 20 ? q(innerY, 0.4) : faceY.length ? q(faceY, 0.7) : 255; // 影になった奥の歯も入るよう、口の中の明るい方 6 割
  const lipW = new Float32Array(n); const teethW = new Float32Array(n); const darkW = new Float32Array(n);
  const gTooth = gSkin - 0.3 * span; // 歯は、唇よりずっと赤みが少ない（肌と同じくらいか、少ない）
  const isTooth = (i) => gr[i] > gTooth && F[i * 3] >= yT && F[i * 3] > ySkin * 0.4; // 明るく、赤みが少ない
  let nT = 0;
  for (let i = 0; i < n; i++) {
    if (!face[i]) continue; const Y = F[i * 3];
    if (ring[i] && gr[i] < gSkin - 0.5 * span) lipW[i] = 1; // 唇: 肌よりはっきり赤い
    if (open && (inner[i] || sIn[i] > 0.5) && isTooth(i)) { teethW[i] = 1; nT++; } // 歯: 内側の輪郭の中（唇のつやを拾わないように）
    if (open && Y < Math.min(ySkin, yT) * 0.45) darkW[i] = 1; // 口の奥
  }
  let nF = 0; for (let i = 0; i < n; i++) nF += face[i];
  if (nT < Math.max(12, nF * 0.004)) teethW.fill(0); // 口の中に歯らしい所がほとんどない（口を閉じている・口の奥しか見えない）
  // 暗い写真を明るくしたもの: 明るいが、歯の白さ（赤みの少なさ）が唇とあまり変わらない。色では歯と、影になった唇・口の端の見分けがつきにくいので、
  // 歯の確かな所は、口の中のいちばん明るい所（上から 3 割）だけにする
  const tgr = []; for (let i = 0; i < n; i++) if (teethW[i]) tgr.push(gr[i]);
  const faint = ySkin >= 70 && tgr.length > 0 && q(tgr, 0.5) - (gSkin - span) < 0.15;
  if (faint) { const yHi = q(innerY, 0.7); for (let i = 0; i < n; i++) if (teethW[i] && F[i * 3] < yHi) { teethW[i] = 0; nT--; } }
  let G = [gauss2(F, skinW, n), gauss2(F, lipW, n), open ? gauss2(F, teethW, n) : null, open ? gauss2(F, darkW, n) : null, null];
  // 歯ぐき: 上の歯のすぐ上にある、歯より赤く暗くない所のうち、唇の色とははっきり違う所（唇の色に近ければ、歯に接した唇）。
  // 見つかれば別の色として覚え、リップの色をのせない
  const gumW = new Float32Array(n); let nG = 0;
  if (open && nT && G[1]) {
    const ll = []; for (let i = 0; i < n; i++) if (lipW[i]) ll.push(mixLike(G[1], F, i));
    const llMin = q(ll, 0.05); const rG = Math.max(2, Math.round(lipH * 0.08));
    for (let x = 0; x < w; x++) {
      let below = Infinity; // この列で、下にあるいちばん近い確かな歯までの距離
      for (let y = h - 1; y >= 0; y--) {
        const i = y * w + x; below = teethW[i] ? 0 : below + 1;
        if (below > 0 && below <= rG && face[i] && sIn[i] > 0.3 && gr[i] < gTooth && F[i * 3] > Math.min(ySkin, yT) * 0.6 && mixLike(G[1], F, i) < llMin) { gumW[i] = 1; nG++; }
      }
    }
    if (nG >= Math.max(12, nF * 0.004)) G[4] = gauss2(F, gumW, n);
  }
  if (!G[0] || !G[1]) return { lip: blur(ring, w, h, 1, Math.max(1, lipH * 0.04)), teeth: new Float32Array(n), skin: rs ? [rb / rs, rr / rs] : [0, 0] };
  // 上の歯の上の端は、内側の輪郭の上の線からほとんど上に出ない（上唇は日が当たると歯と同じような色になるので、場所で見分ける）。
  // 下は、大きく笑うと内側の輪郭より下に歯が見えることがよくあるので、制限しない
  const top = new Float32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (inner[y * w + x]) { top[x] = y; break; }
  const above = (i) => { const t = top[i % w]; return t >= 0 && Math.floor(i / w) < t - lipH * 0.06; };
  // 輪郭の目安（どれも、どこにでも少しはありうる）
  const nearT = G[4] ? blur(teethW, w, h, 1, Math.max(2, lipH * 0.2)) : null;
  // 歯ぐき（上の歯ぐき）は、上の歯より上にしかない。上の歯の陰になった下の歯は、暗く赤みがかって歯ぐきと同じような色になるので、
  // 列ごとに、確かな歯のいちばん上より下は歯ぐきにしない（なければ、となりの列の値）
  const tTop = new Float32Array(w).fill(-1);
  if (G[4]) {
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (teethW[y * w + x]) { tTop[x] = y; break; }
    const known = []; for (let x = 0; x < w; x++) if (tTop[x] >= 0) known.push(x);
    for (let x = 0, j = 0; x < w && known.length; x++) { // ない列は、いちばん近い列の値
      while (j + 1 < known.length && Math.abs(known[j + 1] - x) <= Math.abs(known[j] - x)) j++;
      if (tTop[x] < 0) tTop[x] = tTop[known[j]];
    }
  }
  const gumOk = (i) => { const t = tTop[i % w]; return t < 0 || Math.floor(i / w) <= t + lipH * 0.03; };
  const prior = (c, i) => (c === 0 ? 0.01 + (1 - sOutT[i]) : c === 1 ? 0.005 + sLip[i] : c === 4 ? (0.003 + sIn[i] * Math.min(1, nearT[i] * 5)) * (gumOk(i) ? 1 : 0.02) : (0.003 + 0.25 * sOutT[i] + 0.75 * sIn[i]) * (above(i) ? 0.05 : 1)); // 唇・歯・口の奥は、外側の輪郭から離れた所にはまずない
  // 影の歯は、口の中（内側の輪郭のあたり）だけで探す（口の端の影になった肌・唇を歯にしない）。
  // 暗い写真（舞台など）は、どこも暗くノイズも多く、影の歯と暗い唇・口の端の見分けがつかないので、探さない。
  // 暗い写真を明るくしたもの（明るいが、歯の白さが唇とあまり変わらない）も同じ（口の端の暗い所が歯になる）
  const dim = ySkin < 70 || faint;
  const P = Array.from({ length: 5 }, () => new Float32Array(n));
  const L = Array.from({ length: 5 }, () => new Float32Array(n));
  const R = Math.max(1, lipH * 0.03); const e = [0, 0, 0, 0, 0];
  const post = (Q) => {
    for (let i = 0; i < n; i++) {
      let mx = -Infinity;
      for (let c = 0; c < 5; c++) if (G[c]) { e[c] = L[c][i] + (Q ? 2 * Math.log(Q[c][i] + 0.02) : 0); if (e[c] > mx) mx = e[c]; }
      let s = 0; for (let c = 0; c < 5; c++) if (G[c]) { e[c] = Math.exp(e[c] - mx); s += e[c]; } else e[c] = 0;
      for (let c = 0; c < 5; c++) P[c][i] = e[c] / s;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < 5; c++) if (G[c]) for (let i = 0; i < n; i++) L[c][i] = (c === 2 && !dim && sIn[i] > 0.2 ? shadeLike : mixLike)(G[c], F, i) + Math.log(prior(c, i));
    post(null);
    for (let it = 0; it < 4; it++) post(P.map((a, c) => (G[c] ? blur(a, w, h, 1, R) : a)));
    if (pass === 0) G = G.map((g, c) => (g ? gauss2(F, P[c].map((v) => (v > 0.6 ? v : 0)), n) || g : null));
  }
  if (G[4]) {
    // 歯ぐきは、唇の内側（口の中の側）にしかない。上から（下唇は下から）たどって、肌の次に出てくる赤い所は唇とする
    // （日の当たった細い唇は歯ぐきと同じような色になるので、色だけでは決めない）
    // 肌との境目の数画素は色が混ざって唇らしく見えるので、唇の画素を数え始めるのは、赤い所に入ってから少し先。歯ぐきを唇に戻すのは、唇の厚みほどまで
    const m = Math.max(2, Math.round(lipH * 0.015)); const skip = Math.max(1, Math.round(lipH * 0.02)); const reach = lipH * 0.15;
    for (let x = 0; x < w; x++) for (const dir of [1, -1]) {
      let seen = -1; let run = 0; // seen -1: まだ肌、0 以上: 赤い所に入ってから見た唇の画素の数。run: 赤い所に入ってからの画素の数
      for (let t = 0; t < h; t++) {
        const i = (dir > 0 ? t : h - 1 - t) * w + x; const red = P[1][i] + P[4][i] > 0.5;
        if (seen < 0) { if (red) seen = 0; else continue; }
        if (!red || seen >= m || run++ > reach) break;
        if (P[1][i] >= P[4][i]) { if (run > skip) seen++; } else { P[1][i] += P[4][i]; P[4][i] = 0; }
      }
    }
  }
  const lip = P[1]; const teeth = G[2] ? P[2] : new Float32Array(n);
  if (G[2]) {
    // 歯は、唇・歯ぐきのように赤い所には広げない（濡れた下唇の内側・歯ぐきの縁）。確かな歯と唇の赤みの中間で分ける
    const tg = []; for (let i = 0; i < n; i++) if (teethW[i]) tg.push(gr[i]);
    // 暗い写真では赤みの差が小さくノイズも多いので、境目を唇寄りにして、広くならしてから比べる
    const gT = q(tg, 0.5); const gL = gSkin - span; const low = gT - gL < 0.22 && ySkin < 70;
    // 歯と唇の赤みは、場所によって違う（日の当たった上唇の歯に近い所は淡く、影の歯は赤みが強い）。写真全体の値で切ると、
    // 淡い上唇が歯に入ったり影の歯が抜けたりするので、その場所の近くの歯と唇の赤みの中間で切る。近くにどちらかが少なければ、写真全体の値に寄せる
    const cT = new Float32Array(n); const aT = new Float32Array(n); const sT = new Float32Array(n); const aL = new Float32Array(n); const sL = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // 歯の側は、赤みの少ない（白い）所ほど重く数える（歯と同じ側に入った淡い歯ぐき・唇の縁に引っぱられない）
      const t = P[2][i] > 0.5 ? P[2][i] * Math.max(0, gr[i] - gL) ** 2 : 0; const l = P[1][i] > 0.5 ? P[1][i] : 0;
      cT[i] = P[2][i] > 0.5 ? P[2][i] : 0; aT[i] = t; sT[i] = t * gr[i]; aL[i] = l; sL[i] = l * gr[i];
    }
    const RL = Math.max(2, lipH * 0.2); const [bc, bT, bsT, bL, bsL] = [cT, aT, sT, aL, sL].map((a) => blur(a, w, h, 1, RL));
    const grS = blur(gr, w, h, 1, Math.max(1, low ? lipH * 0.04 : Math.min(3, lipH * 0.02))); // 大きな口でも、細く見える下の歯がならしで消えないよう、明るい写真は 3 画素まで
    for (let i = 0; i < n; i++) {
      const kT = Math.min(1, bc[i] * 5); const kL = Math.min(1, bL[i] * 5);
      const tT = kT * (bT[i] > 1e-6 ? bsT[i] / bT[i] : gT) + (1 - kT) * gT; const tL = kL * (bL[i] > 1e-4 ? bsL[i] / bL[i] : gL) + (1 - kL) * gL;
      const sep = Math.max(0.04, tT - tL); const mid = tL + sep * (low ? 0.3 : 0.5); const wd = Math.max(0.01, sep * 0.12);
      teeth[i] *= clamp01((grS[i] - mid) / wd + 0.5);
    }
  }
  // 下の歯: 上の歯の陰に入り、口の中の照り返しで赤みがかるので、色の分布でも赤みの切りでも唇とされやすい。
  // 上の歯のすぐ下（内側の輪郭は下の歯の上を通ることが多いので、外側の輪郭の中）にあり、口の奥ほど暗くなく、赤み（Cr）が確かな歯と唇の中間より少ない所は歯とする。
  // 唇は日陰でも赤み（Cr）が強いので、ここには入らない（リップの色も下の歯にはのせない）
  if (G[2] && G[3] && !dim) {
    const crT = []; const crL = []; for (let i = 0; i < n; i++) { if (teethW[i]) crT.push(F[i * 3 + 2] - 128); if (lipW[i]) crL.push(F[i * 3 + 2] - 128); }
    const cT = q(crT, 0.5); const cL = q(crL, 0.5);
    if (cL - cT > 12) {
      const crMid = cT + (cL - cT) * 0.55; const yDark = Math.min(ySkin, yT) * 0.45; const reach = lipH * 0.5;
      const lower = new Float32Array(n);
      for (let x = 0; x < w; x++) {
        let last = -Infinity; let cnt = 0; // この列で、上にあるいちばん近い歯の行と、上にある歯の画素の数
        for (let y = 0; y < h; y++) {
          const i = y * w + x; if (teeth[i] > 0.5) { last = y; cnt++; continue; }
          if (cnt < lipH * 0.06 || y - last > reach || !face[i] || P[0][i] > 0.5) continue; // 口の端の肌（赤みが少ない）は入れない
          const Y = F[i * 3]; const cr = F[i * 3 + 2] - 128;
          if (Y > yDark && cr < crMid + 3 && cr < Y * 0.38) lower[i] = clamp01((crMid - cr) / 6 + 0.5) * clamp01((Y - yDark) / 10);
        }
      }
      const lowS = blur(lower, w, h, 1, Math.max(1, lipH * 0.015)); // 1 画素ずつのざらつきをならす
      for (let i = 0; i < n; i++) if (lowS[i] > teeth[i]) { teeth[i] = lowS[i]; lip[i] *= 1 - lowS[i]; }
    }
  }
  // 口に当てた指: 光った指は、色では歯と見分けられない。歯は唇に囲まれていて、口の外の肌と、唇・口の奥・歯ぐきを通らずに
  // 幅広くつながることはない。口の外の確かな肌から、唇・口の奥・歯ぐきでない所を、指ほどの幅（唇の厚みの 16% 以上）で
  // たどって届く所は、歯にしない（肌に戻す）。細いすき間（口の端・唇の切れ目）は通らない
  if (G[2]) {
    const pass = new Uint8Array(n);
    for (let i = 0; i < n; i++) pass[i] = P[1][i] < 0.5 && P[3][i] < 0.5 && P[4][i] < 0.5 ? 1 : 0;
    const r = Math.max(2, lipH * 0.08); const r2 = r * r;
    const block = new Uint8Array(n); for (let i = 0; i < n; i++) block[i] = 1 - pass[i];
    const dB = dist2(block, w, h); const reach = new Uint8Array(n); const st = [];
    for (let i = 0; i < n; i++) if (dB[i] > r2 && sOutT[i] < 0.02) { reach[i] = 1; st.push(i); }
    while (st.length) {
      const j = st.pop(); const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) if (k >= 0 && k < n && !reach[k] && dB[k] > r2) { reach[k] = 1; st.push(k); }
    }
    const dR = dist2(reach, w, h);
    for (let i = 0; i < n; i++) if (pass[i] && dR[i] <= r2 && sOutT[i] >= 0.02 && teeth[i] > 0) { P[0][i] += teeth[i]; teeth[i] = 0; }
    // 指の縁の赤い所が、唇の小さなかけらになることがある。指のすぐ横にある小さな唇のかけらは外す
    const { lab, sizes } = components(P[1], w, h, 0.5); const big = Math.max(0, ...sizes); const nr = new Float32Array(sizes.length);
    const nonLip = new Uint8Array(n); for (let i = 0; i < n; i++) nonLip[i] = lab[i] < 0 ? 1 : 0;
    const dL = dist2(nonLip, w, h); const th = new Float32Array(sizes.length); // かけらの太さ（中心から縁までのいちばん長い距離の 2 乗）
    for (let i = 0; i < n; i++) if (lab[i] >= 0) { if (dR[i] <= r2 * 4) nr[lab[i]]++; if (dL[i] > th[lab[i]]) th[lab[i]] = dL[i]; }
    // 細いかけらだけ（指と指のあいだに見える唇は、太いので残す）
    for (let i = 0; i < n; i++) { const c = lab[i]; if (c >= 0 && sizes[c] < big * 0.15 && nr[c] > sizes[c] * 0.6 && th[c] <= r2) { P[0][i] += P[1][i]; P[1][i] = 0; } }
  }
  // 歯: 小さな（いちばん大きなかたまりの 2 割より小さな）明るい所のうち、まわりが唇・肌だけの所（唇のつや・肌のてかり）は外す。
  // 歯と歯のすき間で分かれた奥の歯は、まわりに口の奥（暗い所）があるので残る
  if (G[2]) {
    const { lab, sizes } = components(teeth, w, h, 0.5); const big = Math.max(0, ...sizes);
    const edge = new Float32Array(sizes.length); const darkEdge = new Float32Array(sizes.length); const lipEdge = new Float32Array(sizes.length); const inSum = new Float32Array(sizes.length);
    for (let i = 0; i < n; i++) {
      const c = lab[i]; if (c < 0) continue; const x = i % w; inSum[c] += sIn[i];
      for (const k of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (k >= 0 && k < n && lab[k] !== c) { edge[c]++; if (G[3] && P[3][k] > 0.4) darkEdge[c]++; if (lip[k] > 0.5) lipEdge[c]++; }
    }
    const keep = new Float32Array(n);
    // 残すのは: 口の中（内側の輪郭のあたり）にあるもの。大きいか、口の奥の暗い所に接しているもの
    // ごく小さなもの（唇の厚みの 15% 四方より小さい）は、口の中にしっかり入っているときだけ（口の端の影の縁を歯にしない）
    // 小さく、まわりがほとんど唇のもの（下唇のつや）は外す
    const tiny = (lipH * 0.15) ** 2;
    for (let i = 0; i < n; i++) {
      const c = lab[i]; if (c < 0) continue; const m = inSum[c] / sizes[c];
      if (m > 0.1 && (sizes[c] >= big * 0.2 || darkEdge[c] > edge[c] * 0.15 || m > 0.4) && (sizes[c] >= tiny || m > 0.4) && !(sizes[c] < big * 0.2 && lipEdge[c] > edge[c] * 0.85)) keep[i] = 1;
    }
    const near = blur(keep, w, h, 1, Math.max(1, lipH * 0.03)); // かたまりの縁のなだらかな所は残す
    for (let i = 0; i < n; i++) teeth[i] *= Math.min(1, near[i] * 3);
  }
  const cut = new Uint8Array(n); for (let i = 0; i < n; i++) if (teeth[i] > 0.5) cut[i] = 1; // 歯には唇を足さない
  tidyLip(lip, cut, G[3] ? P[3] : null, sOutT, w, h, lipH);
  if (G[2]) {
    const inMouth = new Float32Array(n); for (let i = 0; i < n; i++) inMouth[i] = Math.max(teeth[i], G[3] ? P[3][i] : 0);
    const ly = []; for (let i = 0; i < n; i++) if (lipW[i]) ly.push(F[i * 3]);
    smoothUpperLip(lip, inMouth, F, w, h, lipH, q(ly, 0.5));
  }
  const soft = Math.max(1, lipH * 0.012);
  return { lip: blur(lip, w, h, 1, soft), teeth: blur(teeth, w, h, 1, soft), skin: rs ? [rb / rs, rr / rs] : [0, 0] };
}

/**
 * 上唇の下の縁（口の中との境目）は、なめらかな線になる（唇の縁がガタガタの人はいない）。
 * 色だけで分けると、歯ぐきの山なり・歯の形に沿って唇が下へはみ出すので、縁の高さを
 * 「縁より上は唇・下は唇でない」によく合い、曲がり方がなだらかな線として選ぶ（動的計画法。数列おきの点を結ぶ折れ線）。
 * 唇の下側の影が終わって明るくなる所（歯ぐきとの境目）は、縁の手がかりにする。縁より下（歯ぐき・歯の側）の唇は消す。唇を足すことはしない
 */
function smoothUpperLip(lip, inMouth, F, w, h, lipH, yLip) {
  const d = Math.max(1, Math.round(lipH * 0.02)); const Yc = new Float32Array(w * h); for (let i = 0; i < w * h; i++) Yc[i] = F[i * 3];
  const YS = blur(Yc, w, h, 1, d);
  const cols = []; // 列ごと: 上唇の上の端 y0、口の中（歯・口の奥）が始まる所 y1
  for (let x = 0; x < w; x++) {
    let y0 = -1; let y1 = -1;
    for (let y = 0; y < h; y++) { const i = y * w + x; if (y0 < 0) { if (lip[i] >= 0.5) y0 = y; } else if (inMouth[i] >= 0.5) { y1 = y; break; } }
    cols.push(y0 >= 0 && y1 - y0 >= 3 ? [y0, y1] : null);
  }
  const k = Math.max(1, Math.round(lipH * 0.03)); const S = Math.max(2, Math.round(k * 1.5)); const GAM = lipH * 0.2; const ALPHA = lipH * 0.08;
  let x = 0;
  while (x < w) {
    if (!cols[x]) { x++; continue; }
    let x1 = x; while (x1 + 1 < w && cols[x1 + 1]) x1++;
    const nc = x1 - x + 1;
    if (nc >= Math.max(4, lipH * 0.15)) {
      let ymin = h; let ymax = 0; for (let c = x; c <= x1; c++) { ymin = Math.min(ymin, cols[c][0]); ymax = Math.max(ymax, cols[c][1]); }
      const ny = ymax - ymin + 1; const nk = Math.ceil(nc / k);
      // 点ごとの費用（その点が受け持つ列の合計）: 縁より上で唇らしくない所 + 縁より下で唇らしい所 − くぼみ
      const D = Array.from({ length: nk }, () => new Float32Array(ny));
      for (let c = x; c <= x1; c++) {
        const [y0, y1] = cols[c]; const Dk = D[Math.floor((c - x) / k)];
        let dn = 0; for (let y = y0; y < y1; y++) dn += lip[y * w + c];
        let up = 0;
        for (let t = 0; t < ny; t++) {
          const y = ymin + t;
          if (y < y0) { Dk[t] += dn; continue; } // 唇を全部消す
          if (y >= y1) { Dk[t] += up + (y - y1 + 1); continue; } // 口の中まで唇を残す（その下へは行かない）
          // 唇の下側の影（唇のふだんの明るさより暗い）が終わって、下が明るくなる所
          const ya = YS[Math.max(0, y - d) * w + c]; const yb = YS[Math.min(h - 1, y + d) * w + c];
          const edge = clamp01((yb - ya) / 30) * clamp01((yLip - ya) / 20);
          Dk[t] += up + dn - ALPHA * edge;
          const v = lip[y * w + c]; up += 1 - v; dn -= v;
        }
      }
      // 状態: 高さ y と、前の点からの傾き s。傾きの変わり方（曲がり）に罰
      const NS = 2 * S + 1; let prev = new Float32Array(ny * NS).fill(Infinity);
      for (let t = 0; t < ny; t++) for (let si = 0; si < NS; si++) prev[t * NS + si] = D[0][t];
      const back = [null];
      for (let j = 1; j < nk; j++) {
        const cur = new Float32Array(ny * NS).fill(Infinity); const bk = new Int32Array(ny * NS).fill(-1);
        for (let t = 0; t < ny; t++) for (let si = 0; si < NS; si++) {
          const tp = t - (si - S); if (tp < 0 || tp >= ny) continue;
          let best = Infinity; let bj = -1;
          for (let sp = 0; sp < NS; sp++) { const v = prev[tp * NS + sp]; if (v === Infinity) continue; const ds = (si - sp) / k; const c2 = v + GAM * ds * ds; if (c2 < best) { best = c2; bj = tp * NS + sp; } }
          if (bj >= 0) { cur[t * NS + si] = best + D[j][t]; bk[t * NS + si] = bj; }
        }
        back.push(bk); prev = cur;
      }
      let st = 0; for (let q = 1; q < prev.length; q++) if (prev[q] < prev[st]) st = q;
      const yk = new Float32Array(nk);
      for (let j = nk - 1; j >= 0; j--) { yk[j] = ymin + Math.floor(st / NS); if (j > 0) st = back[j][st]; }
      for (let c = x; c <= x1; c++) {
        const u = (c - x) / k - 0.5; const j0 = Math.max(0, Math.min(nk - 1, Math.floor(u))); const j1 = Math.min(nk - 1, j0 + 1); const f = clamp01(u - j0);
        const yb = yk[j0] * (1 - f) + yk[j1] * f; const [y0, y1] = cols[c];
        for (let y = Math.max(y0, Math.floor(yb)); y < y1; y++) lip[y * w + c] *= clamp01(yb - y + 0.5);
      }
    }
    x = x1 + 1;
  }
}

/** 2 値（1 の所）までの距離の 2 乗（Felzenszwalb の方法。行・列の順に 1 次元で） */
function dist2(bin, w, h) {
  const INF = 1e12; const D = new Float64Array(w * h); for (let i = 0; i < w * h; i++) D[i] = bin[i] ? 0 : INF;
  const N = Math.max(w, h); const f = new Float64Array(N); const z = new Float64Array(N + 1); const v = new Int32Array(N); const out = new Float64Array(N);
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s; do { const p = v[k]; s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) k--; else break; } while (k >= 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    for (let q = 0, j = 0; q < len; q++) { while (z[j + 1] < q) j++; const p = v[j]; out[q] = (q - p) * (q - p) + f[p]; }
    for (let q = 0; q < len; q++) set(q, out[q]);
  };
  for (let y = 0; y < h; y++) pass(w, (x) => D[y * w + x], (x, val) => { D[y * w + x] = val; });
  for (let x = 0; x < w; x++) pass(h, (y) => D[y * w + x], (y, val) => { D[y * w + x] = val; });
  return D;
}

/**
 * 唇の範囲を、唇らしい形に整える（唇がガタガタ・穴あきの人はいない）:
 * - 唇から離れた小さなかたまり（鼻の下の影・肌の赤み）は外す
 * - 唇に囲まれた小さな穴（つや・口の端の暗い点・しわ）は埋める（歯の入った穴・口の端の奥の暗い所は埋めない）
 * - 縁の細いくぼみは、その幅だけ閉じる（クロージング。口の奥の暗いすき間は閉じない）
 * cut: 唇を足さない所（歯・歯ぐき・上唇の縁より下）。dark: 口の奥らしさ
 */
function tidyLip(lip, cut, dark, sOutT, w, h, lipH) {
  const n = w * h;
  {
    const { lab, sizes } = components(lip, w, h, 0.5); const big = Math.max(0, ...sizes); const so = new Float32Array(sizes.length);
    for (let i = 0; i < n; i++) if (lab[i] >= 0) so[lab[i]] += sOutT[i];
    for (let i = 0; i < n; i++) { const c = lab[i]; if (c >= 0 && (sizes[c] < big * 0.03 || (sizes[c] < big * 0.15 && so[c] / sizes[c] < 0.6))) lip[i] = 0; }
  }
  {
    const inv = new Float32Array(n); for (let i = 0; i < n; i++) inv[i] = lip[i] < 0.5 ? 1 : 0;
    const { lab, sizes } = components(inv, w, h, 0.5); const m = sizes.length;
    const border = new Uint8Array(m); const nCut = new Float32Array(m); const nDark = new Float32Array(m);
    const x0 = new Int32Array(m).fill(w); const x1 = new Int32Array(m).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = lab[i]; if (c < 0) continue; const x = i % w; const y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border[c] = 1;
      if (cut[i]) nCut[c]++; if (dark && dark[i] > 0.5) nDark[c]++; if (x < x0[c]) x0[c] = x; if (x > x1[c]) x1[c] = x;
    }
    // 口の中（歯の入った所・口の幅ほどの暗いすき間）は、大きいか横に長いので埋まらない。暗い穴（口の端の奥）は、点のように小さいときだけ埋める
    const maxA = (lipH * 0.3) ** 2; const darkA = (lipH * 0.13) ** 2;
    const fill = new Uint8Array(m);
    for (let c = 0; c < m; c++) fill[c] = !border[c] && sizes[c] <= maxA && x1[c] - x0[c] <= lipH * 0.6 && nCut[c] <= sizes[c] * 0.25 && (nDark[c] <= sizes[c] * 0.5 || sizes[c] <= darkA) ? 1 : 0;
    for (let i = 0; i < n; i++) if (lab[i] >= 0 && fill[lab[i]] && !cut[i]) lip[i] = 1;
  }
  {
    const r = Math.max(1, lipH * 0.06); const r2 = r * r;
    const bin = new Uint8Array(n); for (let i = 0; i < n; i++) bin[i] = lip[i] >= 0.5 ? 1 : 0;
    const dIn = dist2(bin, w, h); const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = dIn[i] > r2 ? 1 : 0;
    const dOut = dist2(out, w, h);
    for (let i = 0; i < n; i++) if (!bin[i] && !cut[i] && !(dark && dark[i] > 0.5) && dOut[i] > r2) lip[i] = Math.max(lip[i], clamp01((Math.sqrt(dOut[i]) - r) + 0.5));
  }
}

/** 唇・歯の範囲（顔ごとに塗り分けて、重ねる） */
function mouthAreas(img, mk, polys, at) {
  const n = mk.w * mk.h; const lip = new Float32Array(n); const teeth = new Float32Array(n); let skin = [0, 0];
  for (const p of polys) {
    if (p.outer.length < 3 || p.inner.length < 3) continue;
    const r = segmentMouth(img, mk, p, at); skin = r.skin;
    for (let i = 0; i < n; i++) { lip[i] = Math.max(lip[i], r.lip[i]); teeth[i] = Math.max(teeth[i], r.teeth[i]); }
  }
  return { lip, teeth, skin };
}
/** 唇の範囲（0〜1。歯・口の奥・肌は 0） */
const lipArea = (img, mk, polys, at) => mouthAreas(img, mk, polys, at).lip;
/** 歯の範囲（0〜1）と、まわりの肌の色（歯の色の目安） */
const teethArea = (img, mk, polys, at) => { const r = mouthAreas(img, mk, polys, at); return { area: r.teeth, skin: r.skin }; };

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
  // 目標の明るさへの寄せ方（唇全体の明るさを、目標の色の明るさへ。暗い色（ベリー・レッド）は暗くなる。明るくするのは控えめ）
  const yGain = Math.min(1.1, Math.max(0.45, tY / Math.max(mY, 1)));
  // 目標の色の濃さは、唇の明るさに合わせる（暗い唇に明るい色の濃さをそのままのせると、蛍光色のように浮く）
  const cScale = Math.min(1, Math.max(0.35, mY / Math.max(tY, 1)));
  // 色の濃さは、元の唇の濃さから目標の 6 割まで（そのまま目標の濃さにすると、元の唇よりずっと鮮やかになり、塗ったように浮く）
  const tCe = mC + (tC * cScale - mC) * 0.6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const a0 = m[i]; if (!a0) continue;
    const k = ((by + y) * W + bx + x) * 4; const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]);
    const a = a0 * amt * lipOf(i, Y, cr); if (a <= 0) continue;
    // この所の元の色の濃さ・明るさの、唇の平均に対する比（濃淡・明暗）
    const relC = Math.min(1.8, Math.max(0.4, Math.hypot(cb - 128, cr - 128) / mC));
    const relY = Math.min(1.6, Math.max(0.5, Y / mY));
    const c = tCe * relC * Math.min(1.2, Math.max(0.6, relY ** 0.5)); // 明るい所は少し濃く、影は少し淡く
    const gCb = 128 + tdir[0] * c; const gCr = 128 + tdir[1] * c;
    const Y1 = Y * (1 + (yGain - 1) * a);
    const cb1 = cb + (gCb - cb) * a; const cr1 = cr + (gCr - cr) * a;
    d[k] = Math.max(0, Math.min(255, Y1 + 1.402 * (cr1 - 128)));
    d[k + 1] = Math.max(0, Math.min(255, Y1 - 0.344136 * (cb1 - 128) - 0.714136 * (cr1 - 128)));
    d[k + 2] = Math.max(0, Math.min(255, Y1 + 1.772 * (cb1 - 128)));
  }
}

/**
 * 歯を白く（範囲を自動で決めたとき）。area: { area: 歯らしさ 0〜1, skin: まわりの肌の Cb・Cr（明るさで割った値） }
 * - 色: 色の濃さだけを、歯の平均が目安になるまで減らす（色合い＝角度はそのまま。歯全体で同じ倍率）。黄色だけ消すと赤みが残って
 *   ピンク・灰色っぽくなるため。目安はまわりの肌の色の濃さの 0.22 倍。照明の色が強いときはそのぶん残す（照明の色は少し残り、真っ白・青白くならない）
 * - 明るさ: 色を抜くだけだと灰色にくすむので、歯の明るい所（上から 1 割）が 232 ほどになるまで、全体に同じ倍率で
 *   明るくする（最大 1.25 倍）。同じ倍率なので、奥の歯の影・歯と歯のすき間の暗さは残る。明るい所はなだらかに抑える
 * - 唇・歯ぐき（はっきり赤い所）は、範囲の縁にかかっても色を抜かない（灰色の縁が出ないように）
 */
function teethWhole(img, mk, amt, area) {
  const { m, bx, by, w, h } = mk; const d = img.data; const W = img.width; const A = area.area;
  const notRed = (r, g) => clamp01((g / Math.max(r, 1) - 0.47) / 0.08); // 唇・歯ぐきは 0.5 以下。歯と唇の境目の混ざった色（0.75 ほど）・影で赤みがかった下の歯（0.55〜0.7）は抜く（抜かないと、白い歯のまわりに橙の縁が残り、下の歯が茶色いまま）
  // 歯の明るさと色の濃さ（明るさに対する比）
  const px = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (m[i] * A[i] < 0.5) continue; const k = ((by + y) * W + bx + x) * 4;
    const [Y, cb, cr] = ycc(d[k], d[k + 1], d[k + 2]); px.push([Y, Y > 8 ? Math.hypot(cb - 128, cr - 128) / Y : 0]);
  }
  if (px.length < 8) return;
  px.sort((p, q) => p[0] - q[0]); const top = px[Math.floor(px.length * 0.9)][0];
  const avg = (a) => a.reduce((s, p) => s + p[1], 0) / Math.max(1, a.length);
  const rTeeth = avg(px.slice(Math.floor(px.length * 0.5))); // 歯の色: 明るい方の半分（影・照り返しで赤みがかった所は数えない）
  // 目安の色の濃さ: まわりの肌の色の濃さの 0.22 倍。夕日・舞台など照明の色が強い（肌の色が濃い）ときは、そのぶん照明の色を残す
  // （残さないと、まわりが色づいているのに歯だけ灰色・青白く見える）。そのときも少しは減らす（0.85 倍まで）
  const rS = Math.hypot(area.skin[0], area.skin[1]);
  const rT = Math.max(rS * 0.32, (rS - 0.17) * 1.2);
  // 色の濃さは、歯全体で同じ倍率で減らす（画素ごとに揃えると、根もとの黄みと先の透けた所の差が消えて、のっぺりする）
  const f = Math.min(0.9, Math.max(0.38, rT / Math.max(rTeeth, 1e-3)));
  const gain = Math.min(1.18, Math.max(1, 224 / Math.max(top, 1)));
  const knee = 225; const roll = (v) => (v <= knee ? v : knee + (255 - knee) * (1 - Math.exp(-(v - knee) / (255 - knee)))); // 白飛びさせない
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const s = m[i] * amt * A[i]; if (s <= 0.002) continue;
    const k = ((by + y) * W + bx + x) * 4; const r = d[k]; const g = d[k + 1]; const b = d[k + 2];
    const [Y, cb, cr] = ycc(r, g, b);
    const t = s * notRed(r, g);
    const fc = 1 + (f - 1) * t;
    const cb1 = 128 + (cb - 128) * fc; const cr1 = 128 + (cr - 128) * fc;
    const Y1 = Y + (roll(Y * gain) - Y) * s;
    d[k] = Math.max(0, Math.min(255, Y1 + 1.402 * (cr1 - 128)));
    d[k + 1] = Math.max(0, Math.min(255, Y1 - 0.344136 * (cb1 - 128) - 0.714136 * (cr1 - 128)));
    d[k + 2] = Math.max(0, Math.min(255, Y1 + 1.772 * (cb1 - 128)));
  }
}

/** 歯を白く（ブラシでなぞった所）: 黄ばみ（色）を減らし、少し明るく。赤い唇・歯ぐきはほとんど変えない */
function teeth(img, mk, amt, area) {
  if (area) { teethWhole(img, mk, amt, area); return; }
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

/** ブラシの形（中心からの距離 q 0〜1 → 動かす割合）。中ほどまでは全部動かし、縁に向かってなめらかに 0 に（尖った山だと輪郭がへこむ） */
export const warpKernel = (q) => { if (q >= 1) return 0; const t = (1 - q * q); return t * t; };

/**
 * 形を整える（2 版）: なぞった区間ごとに「どこから画素を持ってくるか」（ずらす量の地図 D）だけを重ねていき、
 * 画素は、なぞる前の写真から 1 回だけ読み直す（区間ごとに読み直すと、そのたびに少しずつぼける）。
 * protect（人物の地図から作った、動かしてよい度合い。warpProtect）があれば:
 *   - 背景（人物から離れた所）は動かさない。人物の側（髪・肌・服）でずれを受け止める
 *   - 人物を外へ広げるときは、人物の画素を受け取る背景の画素も動かす（人物の地図は、動かした分だけずれた所で見る）
 * 色で混ぜ合わせない（背景を元の色に戻さない）ので、輪郭が透けたり二重になったりしない。
 * 返す物の seg(p0, p1, amt) で 1 区間を当て、書き換えた範囲 [x, y, w, h] を返す
 */
export function warpStroke(img, rad, protect = null) {
  const W = img.width; const H = img.height; const d = img.data;
  let rx = 0; let ry = 0; let rw = 0; let rh = 0; let D = new Float32Array(0); let O = new Uint8ClampedArray(0); let maxD = 0;
  // ずらす量の地図 D（x, y の 2 つずつ）と、なぞる前の画素 O を持つ四角を、必要なだけ広げる
  const grow = (x0, y0, x1, y1) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    if (rw && x0 >= rx && y0 >= ry && x1 <= rx + rw && y1 <= ry + rh) return;
    if (rw) { x0 = Math.min(x0, rx); y0 = Math.min(y0, ry); x1 = Math.max(x1, rx + rw); y1 = Math.max(y1, ry + rh); }
    const nw = x1 - x0; const nh = y1 - y0; const nD = new Float32Array(nw * nh * 2); const nO = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) nO.set(d.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4), y * nw * 4); // 四角の外は、まだ書き換えていない
    for (let y = 0; y < rh; y++) {
      nD.set(D.subarray(y * rw * 2, (y + 1) * rw * 2), ((ry - y0 + y) * nw + rx - x0) * 2);
      nO.set(O.subarray(y * rw * 4, (y + 1) * rw * 4), ((ry - y0 + y) * nw + rx - x0) * 4);
    }
    rx = x0; ry = y0; rw = nw; rh = nh; D = nD; O = nO;
  };
  const px = (x, y, c) => (x >= rx && y >= ry && x < rx + rw && y < ry + rh ? O[((y - ry) * rw + x - rx) * 4 + c] : d[(y * W + x) * 4 + c]);
  const out = [0, 0, 0];
  const orig = (x, y) => {
    x = x < 0 ? 0 : x > W - 1 ? W - 1 : x; y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
    const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(x0 + 1, W - 1); const y1 = Math.min(y0 + 1, H - 1); const fx = x - x0; const fy = y - y0;
    for (let c = 0; c < 3; c++) out[c] = (px(x0, y0, c) * (1 - fx) + px(x1, y0, c) * fx) * (1 - fy) + (px(x0, y1, c) * (1 - fx) + px(x1, y1, c) * fx) * fy;
  };
  return {
    seg(p0, p1, amt) {
      let dx = (p1[0] - p0[0]) * amt; let dy = (p1[1] - p0[1]) * amt;
      if (!dx && !dy) return null;
      // 1 区間で動かすのは半径の 2 割まで（速くなぞっても、画素がちぎれない）
      const lim = rad * 0.2; const len = Math.hypot(dx, dy); if (len > lim) { dx *= lim / len; dy *= lim / len; }
      const x0 = Math.max(0, Math.floor(p1[0] - rad - 1)); const y0 = Math.max(0, Math.floor(p1[1] - rad - 1));
      const x1 = Math.min(W, Math.ceil(p1[0] + rad + 2)); const y1 = Math.min(H, Math.ceil(p1[1] + rad + 2));
      if (x1 <= x0 || y1 <= y0) return null;
      const m = Math.hypot(dx, dy); const pad = Math.ceil(m + maxD) + 2;
      grow(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
      // 動かす前のずらす量（読み出す所は、動かす量だけ広く）
      const tx0 = Math.max(rx, x0 - Math.ceil(m) - 2); const ty0 = Math.max(ry, y0 - Math.ceil(m) - 2);
      const tx1 = Math.min(rx + rw, x1 + Math.ceil(m) + 2); const ty1 = Math.min(ry + rh, y1 + Math.ceil(m) + 2); const tw = tx1 - tx0; const th = ty1 - ty0;
      const T = new Float32Array(tw * th * 2);
      for (let y = 0; y < th; y++) T.set(D.subarray(((ty0 - ry + y) * rw + tx0 - rx) * 2, ((ty0 - ry + y) * rw + tx1 - rx) * 2), y * tw * 2);
      const tAt = (x, y, c) => {
        x -= tx0; y -= ty0; x = x < 0 ? 0 : x > tw - 1 ? tw - 1 : x; y = y < 0 ? 0 : y > th - 1 ? th - 1 : y;
        const a = Math.floor(x); const b = Math.floor(y); const a1 = Math.min(a + 1, tw - 1); const b1 = Math.min(b + 1, th - 1); const fx = x - a; const fy = y - b;
        return (T[(b * tw + a) * 2 + c] * (1 - fx) + T[(b * tw + a1) * 2 + c] * fx) * (1 - fy) + (T[(b1 * tw + a) * 2 + c] * (1 - fx) + T[(b1 * tw + a1) * 2 + c] * fx) * fy;
      };
      // 今の絵の中で、(x, y) にある物が人物の側かどうか（なぞる前の地図を、動かした分だけずらした所で見る）
      const pw = (x, y) => protect(x - tAt(x, y, 0), y - tAt(x, y, 1));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const q = Math.hypot(x - p1[0], y - p1[1]) / rad; if (q >= 1) continue;
        let f = warpKernel(q); // 中心ほど大きく動かす
        if (protect) {
          // 動かしてよいのは、人物の側にある画素と、人物の画素を受け取る（人物を外へ広げる先の）画素。それ以外の背景は動かさない
          const g = Math.max(pw(x, y), pw(x - dx * f, y - dy * f)); if (g <= 0) continue;
          f *= g;
        }
        const ex = dx * f; const ey = dy * f;
        const nx = ex + tAt(x - ex, y - ey, 0); const ny = ey + tAt(x - ex, y - ey, 1);
        const j = ((y - ry) * rw + x - rx) * 2; D[j] = nx; D[j + 1] = ny;
        const a = Math.hypot(nx, ny); if (a > maxD) maxD = a;
        orig(x - nx, y - ny);
        const k = (y * W + x) * 4; d[k] = out[0]; d[k + 1] = out[1]; d[k + 2] = out[2];
      }
      return [x0, y0, x1 - x0, y1 - y0];
    },
  };
}

/**
 * 人物の地図（op.pm: なぞり始めのまわりの、人物らしさ 0〜1 を n×n に縮めたもの）から、動かしてよい度合いを返す関数を作る。
 * 人物の中は 1、背景は 0。人物の外は、人物から離れるほど（半径の band 倍で 0 に）だんだん動かさなくなる（人物の輪郭を内へ押すとき、
 * 輪郭のそばの背景が少し伸びてすき間を埋める。帯が狭いと柵・柱などの線が急に折れ、全部止めると押した分だけ背景がずれて継ぎ目ができる。
 * 半径 1 つ分の帯だと、線はゆるやかに曲がる程度）。
 * 人物がブラシの中にほとんどないときは null（ふつうに動かす）
 */
export function warpProtect(pm, rad, at, p0, band = 1) {
  if (!pm?.d) return null;
  const n = pm.n; const bin = atob(pm.d); if (bin.length !== n * n) return null;
  const P = new Float32Array(n * n); for (let i = 0; i < n * n; i++) P[i] = bin.charCodeAt(i) / 255;
  const bx0 = pm.b[0] * at.W - at.ox; const by0 = pm.b[1] * at.H - at.oy; const cw = (pm.b[2] - pm.b[0]) * at.W / n; const ch = (pm.b[3] - pm.b[1]) * at.H / n;
  if (!(cw > 0 && ch > 0)) return null;
  // ブラシの中に人物がほとんどなければ、守らない
  let inside = 0; let tot = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = bx0 + (i + 0.5) * cw; const y = by0 + (j + 0.5) * ch; if (Math.hypot(x - p0[0], y - p0[1]) > rad) continue;
    tot++; if (P[j * n + i] > 0.5) inside++;
  }
  if (!tot || inside / tot < 0.08) return null;
  // 人物の外の、人物からの距離（升目の数。8 方向の近似）
  const INF = 1e9; const dist = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) dist[i] = P[i] > 0.5 ? 0 : INF;
  const pass = (ys, xs, nb) => { for (const y of ys) for (const x of xs) { let v = dist[y * n + x]; for (const [ox, oy, w] of nb) { const a = x + ox; const b = y + oy; if (a >= 0 && b >= 0 && a < n && b < n) v = Math.min(v, dist[b * n + a] + w); } dist[y * n + x] = v; } };
  const up = [...Array(n).keys()]; const down = [...up].reverse();
  pass(up, up, [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.414], [1, -1, 1.414]]);
  pass(down, down, [[1, 0, 1], [0, 1, 1], [1, 1, 1.414], [-1, 1, 1.414]]);
  const bw = Math.max(1, rad * band / Math.min(cw, ch));
  const G = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) { const t = clamp01(1 - dist[i] / bw); G[i] = P[i] > 0.5 ? 1 : Math.max(P[i], t * t * (3 - 2 * t)); }
  return (x, y) => {
    let u = (x - bx0) / cw - 0.5; let v = (y - by0) / ch - 0.5; if (u < -1 || v < -1 || u > n || v > n) return 1; // 地図の外は、ふつうに動かす
    u = u < 0 ? 0 : u > n - 1 ? n - 1 : u; v = v < 0 ? 0 : v > n - 1 ? n - 1 : v;
    const a = Math.floor(u); const b = Math.floor(v); const a1 = Math.min(a + 1, n - 1); const b1 = Math.min(b + 1, n - 1); const fx = u - a; const fy = v - b;
    return (G[b * n + a] * (1 - fx) + G[b * n + a1] * fx) * (1 - fy) + (G[b1 * n + a] * (1 - fx) + G[b1 * n + a1] * fx) * fy;
  };
}

/** 人物の地図を作る範囲（なぞり始めのまわり。写真全体に対する 0〜1 の [x0, y0, x1, y1]） */
export function warpProtectBox(p0, r, W, H) {
  const S = Math.min(W, H); const h = r * S * 3;
  return [Math.max(0, p0[0] * W - h) / W, Math.max(0, p0[1] * H - h) / H, Math.min(W, p0[0] * W + h) / W, Math.min(H, p0[1] * H + h) / H];
}

/** 折れ線（画素）に沿った位置: t は始点 0〜終点 1（両端の区間はその外へ伸ばす）、s は線からの横の距離（符号つき） */
function alongLine(P, cum, x, y) {
  let best = null; let bd = Infinity;
  for (let i = 1; i < P.length; i++) {
    const ax = P[i - 1][0]; const ay = P[i - 1][1]; const dx = P[i][0] - ax; const dy = P[i][1] - ay; const len2 = dx * dx + dy * dy || 1e-6;
    let u = ((x - ax) * dx + (y - ay) * dy) / len2;
    const uc = i === 1 ? Math.min(u, 1) : i === P.length - 1 ? Math.max(u, 0) : Math.min(1, Math.max(0, u)); // 両端の区間は外へ伸ばす
    const px = ax + uc * dx; const py = ay + uc * dy; const d = Math.hypot(x - px, y - py);
    if (d < bd) { bd = d; const len = Math.sqrt(len2); best = { t: (cum[i - 1] + uc * len) / cum[cum.length - 1], s: ((x - ax) * dy - (y - ay) * dx) / len }; }
  }
  return best;
}
const sm = (v, a, b) => { const u = clamp01((v - a) / (b - a)); return u * u * (3 - 2 * u); };
/** t ごとの幅（[t, w] を t で並べたもの）を線形に補う */
function widthAt(tw, t) {
  if (t <= tw[0][0]) return tw[0][1]; if (t >= tw[tw.length - 1][0]) return tw[tw.length - 1][1];
  for (let i = 1; i < tw.length; i++) if (t <= tw[i][0]) { const u = (t - tw[i - 1][0]) / (tw[i][0] - tw[i - 1][0] || 1e-6); return tw[i - 1][1] + (tw[i][1] - tw[i - 1][1]) * u; }
  return tw[tw.length - 1][1];
}

/**
 * 鼻筋: AI で見つけた顔の点から、鼻筋のまん中に細いハイライト、両脇（鼻の横の面）に影を入れて、鼻を高く見せる（メイクのノーズシャドウと同じ）。
 * - 幅は顔の点から決める（鼻筋のふちまでがハイライト、ふちから頬の境目までが影）。眉間の少し上から始め、影は鼻先の手前で消す（小鼻は変えない）
 * - 顔が横を向いているときは、奥側（細く写っている側）の影を弱める（もともと陰になっている）
 * - 肌の色・明るさから外れた所（髪・めがね・小鼻の穴）には当てない。肌のきめは残す（明るさを掛けて変えるだけ）
 * nose: { mid, li, ri, lo, ro }（写真全体に対する 0〜1 の座標の列）
 */
function noseShade(img, nose, amt, at) {
  const W = img.width; const H = img.height; const d = img.data;
  const px = (q) => [q[0] * at.W - at.ox, q[1] * at.H - at.oy];
  const mid = nose.mid.map(px); if (mid.length < 3) return;
  const cum = [0]; for (let i = 1; i < mid.length; i++) cum.push(cum[i - 1] + Math.hypot(mid[i][0] - mid[i - 1][0], mid[i][1] - mid[i - 1][1]));
  const L = cum[cum.length - 1]; if (L < 4) return;
  // 左右それぞれの、鼻筋のふちまでの幅と、頬の境目までの幅（t ごと）
  const side = (pts) => { const tw = pts.map(px).map((q) => { const a = alongLine(mid, cum, q[0], q[1]); return [a.t, Math.abs(a.s)]; }).sort((p, q) => p[0] - q[0]); return tw.length ? tw : null; };
  const li = side(nose.li); const ri = side(nose.ri); const lo = side(nose.lo); const ro = side(nose.ro); if (!li || !ri || !lo || !ro) return;
  const sgnL = Math.sign(alongLine(mid, cum, ...px(nose.li[0])).s) || -1; // 左の点が s のどちら側か
  // 顔の向き: 横の面の幅（頬の境目 − ふち）が狭い側が奥。奥側の影は弱める
  const span = (i, o) => Math.max(1, widthAt(o, 0.5) - widthAt(i, 0.5)); const sl = span(li, lo); const sr = span(ri, ro);
  const scaleL = sm(sl / sr, 0.35, 0.85); const scaleR = sm(sr / sl, 0.35, 0.85);
  // 計算する四角: 鼻の点ぜんぶ＋横の面の幅のぶん
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const k of ['mid', 'li', 'ri', 'lo', 'ro']) for (const q of nose[k].map(px)) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const padv = L * 0.35; const bx = Math.max(0, Math.floor(x0 - padv)); const by = Math.max(0, Math.floor(y0 - padv));
  const bx1 = Math.min(W, Math.ceil(x1 + padv)); const by1 = Math.min(H, Math.ceil(y1 + padv)); const w = bx1 - bx; const h = by1 - by; if (w <= 0 || h <= 0) return;
  const n = w * h; const hl = new Float32Array(n); const sh = new Float32Array(n); const sideL = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = alongLine(mid, cum, bx + x + 0.5, by + y + 0.5); const t = a.t; if (t < -0.4 || t > 1.3) continue;
    const left = Math.sign(a.s) === sgnL; const hi = Math.max(1, widthAt(left ? li : ri, t)); const ho = Math.max(hi * 1.4, widthAt(left ? lo : ro, t));
    const s = Math.abs(a.s); const i = y * w + x;
    // ハイライト: 鼻筋のまん中がいちばん明るく、ふちに向かってなだらかに消える。眉間の少し上から鼻先の下まで
    hl[i] = sm(t, -0.3, 0.05) * (1 - sm(s / hi, 0, 1)) * (1 - sm(t, 1.0, 1.2));
    // 影: ふちのすぐ外がいちばん濃く、頬へ広くなめらかに消える。目頭のあたりから始め、鼻先の手前（小鼻の上）で消える
    const v = (s - hi) / (ho - hi);
    sh[i] = sm(t, -0.1, 0.3) * sm(v, -0.2, 0.3) * (1 - sm(v, 0.4, 2.0)) * (1 - sm(t, 0.65, 0.95)) * (left ? scaleL : scaleR);
    if (left) sideL[i] = 1;
  }
  // 肌の色: ハイライトの所（鼻筋）の色みと明るさを基準にする
  const lum = new Float32Array(n); const ca = new Float32Array(n); const cb = new Float32Array(n); const ref = [[], [], []]; const sideLum = [[], []];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = ((by + y) * W + bx + x) * 4; const i = y * w + x; const r = d[k]; const g = d[k + 1]; const b = d[k + 2];
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b; ca[i] = (r - g) / (lum[i] + 15); cb[i] = (b - (r + g) / 2) / (lum[i] + 15);
    if (hl[i] > 0.6) { ref[0].push(lum[i]); ref[1].push(ca[i]); ref[2].push(cb[i]); }
    if (sh[i] > 0.6) sideLum[sideL[i] ? 0 : 1].push(lum[i]);
  }
  if (ref[0].length < 4) return;
  const med = (v) => { v.sort((p, q) => p - q); return v[v.length >> 1]; }; const rl = med(ref[0]); const ra = med(ref[1]); const rb = med(ref[2]);
  // もともと横の面が鼻筋より暗い（陰になっている）側は、影を控えめに。陰の深さ（段）のぶんだけ減らす
  const coef = sideLum.map((v) => { if (v.length < 4) return 0.45; const c = Math.log2((rl + 4) / (med(v) + 4)); return 0.45 * clamp01(1 - Math.max(0, c) / 0.8); });
  // 鼻筋がもともと明るい（日なた・てかり）なら、ハイライトは控えめに（てかりを強めない）
  const hcoef = 0.3 * (1 - 0.6 * sm(rl, 170, 225));
  const soft = Math.max(1, L * 0.035); const hlS = blur(hl, w, h, 1, soft); const shS = blur(sh, w, h, 1, soft * 1.5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const H1 = hlS[i]; const S1 = shS[i]; if (H1 < 0.003 && S1 < 0.003) continue;
    // 肌らしさ: 色みが鼻筋と近く、暗すぎない所だけ（髪・めがね・鼻の穴は外す）
    const dc = Math.hypot(ca[i] - ra, cb[i] - rb); const skin = Math.exp(-(dc * dc) / (2 * 0.1 * 0.1)) * sm(lum[i] / (rl + 1), 0.3, 0.5);
    const spec = 1 - sm(lum[i] / (rl + 1), 1.08, 1.3); // すでに鼻筋より明るい所（てかり）は、これ以上明るくしない
    const e = amt * skin * (hcoef * spec * H1 - coef[sideL[i] ? 0 : 1] * S1); if (!e) continue;
    const k = ((by + y) * W + bx + x) * 4;
    const r = LIN[d[k]]; const g = LIN[d[k + 1]]; const b = LIN[d[k + 2]]; const Lv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const f = 2 ** e; const L1 = e > 0 ? Math.min(Lv * f, Lv + (1 - Lv) * 0.6) : Lv * f; // 白飛びさせない
    const kc = Lv > 1e-5 ? (e > 0 ? Math.sqrt(L1 / Lv) : L1 / Lv) : 1;
    d[k] = toSrgb(L1 + (r - Lv) * kc); d[k + 1] = toSrgb(L1 + (g - Lv) * kc); d[k + 2] = toSrgb(L1 + (b - Lv) * kc);
  }
}

/** ブラシの操作 1 つを、画像（全体または一部）に当てる */
export function applyBrush(img, op, at = { W: img.width, H: img.height, ox: 0, oy: 0 }) {
  const { pts, rad, amt } = geom(op, at);
  if (!pts.length) return;
  if (op.type === 'nose') { if (op.nose) noseShade(img, op.nose, amt, at); return; } // 目印をなぞっただけでは何もしない（顔の点が要る）
  if (op.type === 'warp') {
    // 区間の長さで動かす量が決まるので、ブラシの大きさ（画素）に合わせて、全体と一部で同じになる
    // 背景の色は、なぞり始めの区間で決めて、最後まで同じものを使う
    if (op.v === 2) {
      // 2 版: ずらす量を重ねて 1 回だけ読み直す。人物の地図（op.pm）があれば背景を守る
      const st = warpStroke(img, rad, warpProtect(op.pm, rad, at, pts[0]));
      for (let i = 1; i < pts.length; i++) st.seg(pts[i - 1], pts[i], amt);
      return;
    }
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
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let travel = 0; let shift = 0;
  op.pts.forEach(([x, y], i) => {
    const px = x * W; const py = y * H; x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    if (i) { const l = Math.hypot(px - op.pts[i - 1][0] * W, py - op.pts[i - 1][1] * H); travel = Math.max(travel, l); shift += Math.min(l * op.amt, rad * 0.2); }
  });
  // 形を整える（2 版）は、なぞる前の画素を、区間ごとのずらした量の合計だけ遠くから読む
  if (op.type === 'warp' && op.v === 2) travel = shift;
  // 範囲を自動で決めるときは、唇のまわりも読み出す（唇の高さの 5 割ほど外まで。色を覚える所とぼかしのぶん）
  if ((op.type === 'lip' || op.type === 'teeth') && op.whole) for (const l of op.lips || []) {
    const ys = l.outer.map((q) => q[1] * H); const m = (Math.max(...ys) - Math.min(...ys)) * 0.5 + 8;
    for (const [x, y] of l.outer) { x0 = Math.min(x0, x * W - m); y0 = Math.min(y0, y * H - m); x1 = Math.max(x1, x * W + m); y1 = Math.max(y1, y * H + m); }
  }
  // 鼻筋: 鼻の点ぜんぶと、その高さの 4 割ほど外まで
  if (op.type === 'nose' && op.nose) {
    const all = Object.values(op.nose).flat(); const ys = all.map((q) => q[1] * H); const m = (Math.max(...ys) - Math.min(...ys)) * 0.4 + 8;
    for (const [x, y] of all) { x0 = Math.min(x0, x * W - m); y0 = Math.min(y0, y * H - m); x1 = Math.max(x1, x * W + m); y1 = Math.max(y1, y * H + m); }
  }
  // しわ取り・目元のぼかしは、ブラシの外の画素も少し使う（境目が変わらないよう、余白を足す）
  const pad = rad * (op.type === 'wrinkle' ? 1.5 : op.type === 'eyes' ? 1.3 : op.type === 'warp' ? 2.6 : 1.05) + travel + 4;
  const rx = Math.max(0, Math.floor(x0 - pad)); const ry = Math.max(0, Math.floor(y0 - pad));
  const rx1 = Math.min(W, Math.ceil(x1 + pad)); const ry1 = Math.min(H, Math.ceil(y1 + pad));
  return rx1 > rx && ry1 > ry ? [rx, ry, rx1 - rx, ry1 - ry] : null;
}

/** 唇・歯の範囲（確かめる用。写真全体に対する輪郭 polys から）。{ mk, lip, teeth } */
export function mouthMasks(img, polys, at = { W: img.width, H: img.height, ox: 0, oy: 0 }) {
  const mk = lipBoxMask(img, polys, at); if (!mk) return null;
  return { mk, lip: lipArea(img, mk, polys, at), teeth: teethArea(img, mk, polys, at).area };
}
