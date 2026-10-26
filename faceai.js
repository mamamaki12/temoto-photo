// 顔専用 AI（暗い写真・ブレの大きい写真の顔を、明るい所で撮ったようにくっきりさせる）の計算。DOM なし。
// 流れ（1 つの顔）:
//   ① 顔の 478 点（MediaPipe）から、AI が学んだ位置合わせ（FFHQ と同じ）で 512×512 に切り出す（alignMatrix・cropFace）
//   ② 本人の写真（明るい所で撮ったもの）を、顔の点の三角形ごとに曲げてこの顔に重ね（meshWarp）、
//      形がよく合う所だけ、本人の写真の細かい模様（まつげ・歯の形・まぶた）を移す（transferDetail）
//   ③ 顔専用 AI（GFPGAN v1.4）に通す（face-worker.js）
//   ④ 写真に戻すときは、大まかな形と色は元の写真のまま、細かい所だけ AI のものに入れ替え、顔の輪郭の内側だけに当てる（mergeFace）。
//      AI がまるごと描き直すと、別人のように見えたり、ティアラ・背景が崩れたりするため
export const SIZE = 512;
/** 切り出した顔で、大まかな形と細かい所を分けるぼかしの大きさ（512 の画素） */
export const SPLIT = 3;

// 位置合わせに使う顔の点（目尻・目頭・黒目・鼻・口角・唇・眉）と、FFHQ の位置合わせで 512 に切り出したときの平均の位置
// （テスト写真 53 人分の中央値。scripts/face-proto/README.md）。鼻と眉は顔の向きで動くので軽く
const ALIGN_IDX = [33, 133, 362, 263, 468, 473, 1, 4, 5, 6, 168, 61, 291, 0, 17, 13, 14, 70, 300, 105, 334];
const ALIGN_WT = [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5];
const ALIGN_TPL = [162.5, 239.5, 219.4, 246.1, 292.3, 245.5, 346.4, 239.1, 190.4, 239.3, 319.8, 238.8, 265.6, 325.5, 266.4, 312.7, 265.3, 295.7,
  261.4, 253.7, 259.5, 237.1, 197.5, 371.4, 314.0, 368.8, 260.9, 359.7, 258.6, 406.9, 259.1, 370.1, 259.0, 388.5, 136.2, 208.0, 368.7, 206.9,
  175.9, 192.9, 337.6, 193.1];
/** 顔の輪郭（MediaPipe の顔の外周）。AI の結果はこの内側（少し広げたもの）だけに当てる */
export const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

/**
 * 写真の画素の座標の顔の点（[[x, y], …478 点]）→ 写真から 512 の切り出しへの変換 [a, b, tx, ty]
 * （u = a·x − b·y + tx、v = b·x + a·y + ty。回転・拡大・移動だけ）
 */
export const alignMatrix = (pts) => fitMatrix(pts, ALIGN_IDX, ALIGN_TPL, ALIGN_WT);
/** 顔の点のうち idx の点を、目標の位置 tpl（[x0, y0, x1, y1, …]）に重みつき最小二乗で合わせる変換（回転・拡大・移動だけ） */
export function fitMatrix(pts, idx, tpl, wt = null) {
  let sw = 0; let mx = 0; let my = 0; let ux = 0; let uy = 0;
  for (let k = 0; k < idx.length; k++) {
    const w = wt ? wt[k] : 1; const p = pts[idx[k]]; sw += w; mx += w * p[0]; my += w * p[1]; ux += w * tpl[k * 2]; uy += w * tpl[k * 2 + 1];
  }
  mx /= sw; my /= sw; ux /= sw; uy /= sw;
  let a = 0; let b = 0; let n = 0;
  for (let k = 0; k < idx.length; k++) {
    const w = wt ? wt[k] : 1; const p = pts[idx[k]];
    const sx = p[0] - mx; const sy = p[1] - my; const dx = tpl[k * 2] - ux; const dy = tpl[k * 2 + 1] - uy;
    a += w * (sx * dx + sy * dy); b += w * (sx * dy - sy * dx); n += w * (sx * sx + sy * sy);
  }
  a /= n; b /= n;
  return [a, b, ux - (a * mx - b * my), uy - (b * mx + a * my)];
}
/** alignMatrix の逆（切り出しの座標 → 写真の座標） */
export function invertMatrix([a, b, tx, ty]) {
  const d = a * a + b * b; const ia = a / d; const ib = -b / d;
  return [ia, ib, -(ia * tx - ib * ty), -(ib * tx + ia * ty)];
}
export const applyMatrix = ([a, b, tx, ty], x, y) => [a * x - b * y + tx, b * x + a * y + ty];
/** 切り出しの 1 画素が、写真の何画素か */
export const matrixScale = ([a, b]) => 1 / Math.hypot(a, b);

/**
 * 写真（RGBA）から顔を 512×512 に切り出す（双一次。外は端の色）。返すのは RGB の Float32Array（0〜255）
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} img
 */
export function cropFace(img, M, size = SIZE) {
  const { width: W, height: H, data } = img; const inv = invertMatrix(M); const out = new Float32Array(size * size * 3);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const [x, y] = applyMatrix(inv, u, v); sampleRGBA(data, W, H, x, y, out, (v * size + u) * 3);
    }
  }
  return out;
}
function sampleRGBA(data, W, H, x, y, out, o) {
  x = Math.min(W - 1, Math.max(0, x)); y = Math.min(H - 1, Math.max(0, y));
  const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(W - 1, x0 + 1); const y1 = Math.min(H - 1, y0 + 1); const fx = x - x0; const fy = y - y0;
  const i00 = (y0 * W + x0) * 4; const i10 = (y0 * W + x1) * 4; const i01 = (y1 * W + x0) * 4; const i11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const t = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx; const b = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[o + c] = t + (b - t) * fy;
  }
}
/** RGB（Float32、ch 個ずつ）の画像を双一次で読む */
export function sampleF(img, w, h, ch, x, y, out, o) {
  x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1); const fx = x - x0; const fy = y - y0;
  for (let c = 0; c < ch; c++) {
    const a = img[(y0 * w + x0) * ch + c]; const b = img[(y0 * w + x1) * ch + c]; const d = img[(y1 * w + x0) * ch + c]; const e = img[(y1 * w + x1) * ch + c];
    const t = a + (b - a) * fx; out[o + c] = t + (d + (e - d) * fx - t) * fy;
  }
}

/** 分離できるガウスぼかし（端は折り返し）。ch 個ずつ並んだ Float32Array を新しく返す */
export function gauss(img, w, h, ch, sigma) {
  if (!(sigma > 0)) return Float32Array.from(img);
  const r = Math.max(1, Math.ceil(sigma * 3)); const k = new Float32Array(r + 1); let sum = 0;
  for (let i = 0; i <= r; i++) { k[i] = Math.exp(-0.5 * (i / sigma) ** 2); sum += i ? 2 * k[i] : k[i]; }
  for (let i = 0; i <= r; i++) k[i] /= sum;
  const n = w * h; const out = new Float32Array(img.length); const a = new Float32Array(n); const t = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    for (let i = 0; i < n; i++) a[i] = img[i * ch + c];
    blur1(a, w, h, k, t);
    for (let i = 0; i < n; i++) out[i * ch + c] = a[i];
  }
  return out;
}
const refl = (v, m) => { while (v < 0 || v >= m) v = v < 0 ? -v - 1 : 2 * m - v - 1; return v; };
/** 1 チャンネルを、その場でぼかす（k: 片側の重み） */
function blur1(a, w, h, k, t) {
  const r = k.length - 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = a[o + x] * k[0];
      if (x >= r && x < w - r) for (let j = 1; j <= r; j++) s += (a[o + x - j] + a[o + x + j]) * k[j];
      else for (let j = 1; j <= r; j++) s += (a[o + refl(x - j, w)] + a[o + refl(x + j, w)]) * k[j];
      t[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) a[o + x] = t[o + x] * k[0];
    for (let j = 1; j <= r; j++) {
      const p = refl(y - j, h) * w; const q = refl(y + j, h) * w; const kj = k[j];
      for (let x = 0; x < w; x++) a[o + x] += (t[p + x] + t[q + x]) * kj;
    }
  }
}

/** 点の集まりを三角形に分ける（ドロネー分割。Bowyer–Watson）。返すのは頂点の番号 3 つずつ */
export function delaunay(pts) {
  const n = pts.length; let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const d = Math.max(x1 - x0, y1 - y0) * 20 + 1; const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  const P = pts.concat([[cx - d, cy - d], [cx + d, cy - d], [cx, cy + d]]);
  const circ = (a, b, c) => {
    const [ax, ay] = P[a]; const [bx, by] = P[b]; const [qx, qy] = P[c];
    const D = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
    const A = ax * ax + ay * ay; const B = bx * bx + by * by; const C = qx * qx + qy * qy;
    const ux = (A * (by - qy) + B * (qy - ay) + C * (ay - by)) / D; const uy = (A * (qx - bx) + B * (ax - qx) + C * (bx - ax)) / D;
    return [ux, uy, (ax - ux) ** 2 + (ay - uy) ** 2];
  };
  let tris = [[n, n + 1, n + 2, ...circ(n, n + 1, n + 2)]];
  for (let i = 0; i < n; i++) {
    const [px, py] = P[i]; const bad = []; const keep = [];
    for (const t of tris) ((px - t[3]) ** 2 + (py - t[4]) ** 2 < t[5] * (1 + 1e-9) ? bad : keep).push(t);
    // 穴のふち（悪い三角形のうち、ほかと共有していない辺）
    const edges = new Map();
    for (const t of bad) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) { const k = a < b ? `${a},${b}` : `${b},${a}`; edges.set(k, edges.has(k) ? null : [a, b]); }
    for (const e of edges.values()) if (e) keep.push([e[0], e[1], i, ...circ(e[0], e[1], i)]);
    tris = keep;
  }
  const out = [];
  for (const t of tris) if (t[0] < n && t[1] < n && t[2] < n) out.push(t[0], t[1], t[2]);
  return Int32Array.from(out);
}

/** 512 の切り出しの周りに置く点（曲げるとき、顔の外も滑らかにつなぐ） */
function borderPts(size = SIZE, k = 8) {
  const out = []; const m = size - 1;
  for (let i = 0; i < k; i++) { const t = (m * i) / (k - 1); out.push([t, 0], [t, m]); if (i > 0 && i < k - 1) out.push([0, t], [m, t]); }
  return out;
}

/**
 * 本人の写真の切り出し（ref, RGB Float32）を、顔の点が合うように三角形ごとに曲げて、この顔（target の点）に重ねる
 * @param {Float32Array} ref @param {number[][]} refPts ref の顔の点（512 の座標） @param {number[][]} pts この顔の点（512 の座標）
 */
export function meshWarp(ref, refPts, pts, size = SIZE) {
  const B = borderPts(size); const dst = pts.map((p) => [p[0], p[1]]).concat(B); const src = refPts.map((p) => [p[0], p[1]]).concat(B);
  const tri = delaunay(dst); const out = new Float32Array(size * size * 3); const done = new Uint8Array(size * size);
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]];
    const [ax, ay] = dst[a]; const [bx, by] = dst[b]; const [cx, cy] = dst[c];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-9) continue;
    const xs = Math.max(0, Math.floor(Math.min(ax, bx, cx))); const xe = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const ys = Math.max(0, Math.floor(Math.min(ay, by, cy))); const ye = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = ys; y <= ye; y++) {
      for (let x = xs; x <= xe; x++) {
        const i = y * size + x; if (done[i]) continue;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det; const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det; const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const sx = l1 * src[a][0] + l2 * src[b][0] + l3 * src[c][0]; const sy = l1 * src[a][1] + l2 * src[b][1] + l3 * src[c][1];
        sampleF(ref, size, size, 3, sx, sy, out, i * 3); done[i] = 1;
      }
    }
  }
  return out;
}

const luma = (img, n) => { const g = new Float32Array(n); for (let i = 0; i < n; i++) g[i] = 0.299 * img[i * 3] + 0.587 * img[i * 3 + 1] + 0.114 * img[i * 3 + 2]; return g; };
/** 2 つの画像（明るさ）の、まわり（ぼかし s）での形の似かた（正規化相互相関、−1〜1） */
function localCorr(a, b, w, h, s) {
  const n = w * h; const ab = new Float32Array(n); const aa = new Float32Array(n); const bb = new Float32Array(n);
  for (let i = 0; i < n; i++) { ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; }
  const ma = gauss(a, w, h, 1, s); const mb = gauss(b, w, h, 1, s); const mab = gauss(ab, w, h, 1, s); const maa = gauss(aa, w, h, 1, s); const mbb = gauss(bb, w, h, 1, s);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (mab[i] - ma[i] * mb[i]) / Math.sqrt(Math.max(maa[i] - ma[i] * ma[i], 1) * Math.max(mbb[i] - mb[i] * mb[i], 1));
  return out;
}
/** 中くらいの細かさ（ぼかし 1.5 と 8 の差）の明るさ。形が合っているかを比べるのに使う */
function midBand(img, w, h) {
  const g = luma(img, w * h); const a = gauss(g, w, h, 1, 1.5); const b = gauss(g, w, h, 1, 8);
  for (let i = 0; i < a.length; i++) a[i] -= b[i];
  return a;
}

/** 目のまわり（MediaPipe の目の縁。目尻 → 下まぶた → 目頭 → 上まぶた） */
const EYES = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]];
/** 目のまわりで使う本人の写真の枚数（その目の形がいちばん合うもの） */
const EYE_TOP = 3;

/**
 * 本人の写真の細かい模様を、この顔に移す（AI に渡す前）。大まかな形と色はこの顔のまま。
 * 本人の写真を顔の点で曲げて重ね、まわりの形がよく合う所（目・歯・まぶたの線が同じ位置にある所）だけ、その細かい所を使う。
 * 合わない所（口の開き方・目線が違う所）は、この顔の細かい所のまま。
 * 目のまわりだけは、その目の形がいちばん合う EYE_TOP 枚だけを使う（たくさんの写真を平均すると、黒目の光やまつげの線が薄まって目が眠そうに見えるため）
 * @param {Float32Array} face この顔の切り出し（RGB、0〜255） @param {number[][]} pts この顔の点（512 の座標）
 * @param {{img:Float32Array,pts:number[][]}[]} refs 本人の写真の切り出しと顔の点
 */
export function transferDetail(face, pts, refs, size = SIZE) {
  const n = size * size; const base = gauss(face, size, size, 3, SPLIT); const tm = midBand(face, size, size);
  const acc = new Float32Array(n * 3); const wsum = new Float32Array(n);
  const eyes = EYES.map((idx) => { const m = polyMask(idx.map((i) => pts[i]), size, 18, 6); return { m, box: maskBox(m, size), top: [] }; });
  for (const r of refs) {
    const w = meshWarp(r.img, r.pts, pts, size); const wl = gauss(w, size, size, 3, SPLIT); const q = localCorr(tm, midBand(w, size, size), size, size, 6);
    const k = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      k[i] = Math.min(1, Math.max(0, (q[i] - 0.3) / 0.4)) ** 2; if (!k[i]) continue;
      wsum[i] += k[i]; for (let c = 0; c < 3; c++) acc[i * 3 + c] += (w[i * 3 + c] - wl[i * 3 + c]) * k[i];
    }
    for (const e of eyes) {
      if (!e.box) continue;
      const [x0, y0, x1, y1] = e.box; let sq = 0; let sm = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * size + x; sq += q[i] * e.m[i]; sm += e.m[i]; }
      const score = sq / sm;
      if (e.top.length >= EYE_TOP && score <= e.top[e.top.length - 1].score) continue;
      const bw = x1 - x0; const D = new Float32Array(bw * (y1 - y0) * 3); const K = new Float32Array(bw * (y1 - y0));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * size + x; const j = (y - y0) * bw + x - x0; K[j] = k[i];
          for (let c = 0; c < 3; c++) D[j * 3 + c] = w[i * 3 + c] - wl[i * 3 + c];
        }
      }
      e.top.push({ score, D, K }); e.top.sort((a, b) => b.score - a.score); if (e.top.length > EYE_TOP) e.top.pop();
    }
  }
  const mask = faceMask(pts, size, 0, 8); const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const cover = Math.min(1, wsum[i]) * mask[i];
    for (let c = 0; c < 3; c++) {
      const o = i * 3 + c; const own = face[o] - base[o]; const ref = wsum[i] > 1e-3 ? acc[o] / wsum[i] : 0;
      out[o] = base[o] + ref * cover + own * (1 - cover);
    }
  }
  // 目のまわり: 形がいちばん合う写真だけで作り直して、なめらかに入れ替える
  for (const e of eyes) {
    if (!e.box || !e.top.length) continue;
    const [x0, y0, x1, y1] = e.box; const bw = x1 - x0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * size + x; const j = (y - y0) * bw + x - x0; const em = e.m[i]; if (!em) continue;
        let ks = 0; for (const t of e.top) ks += t.K[j];
        const cover = Math.min(1, ks);
        for (let c = 0; c < 3; c++) {
          const o = i * 3 + c; let ref = 0;
          if (ks > 1e-3) { for (const t of e.top) ref += t.D[j * 3 + c] * t.K[j]; ref /= ks; }
          const eye = base[o] + ref * cover + (face[o] - base[o]) * (1 - cover);
          out[o] = out[o] * (1 - em) + eye * em;
        }
      }
    }
  }
  for (let o = 0; o < out.length; o++) out[o] = Math.min(255, Math.max(0, out[o]));
  return out;
}

/** 多角形の内側を 1 にした地図（grow: 外へ広げる画素、soft: ぼかし）。512 の座標 */
function polyMask(poly, size, grow, soft) {
  const m = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    // 横の線と輪郭の交わる所
    const xs = [];
    for (let k = 0; k < poly.length; k++) {
      const [ax, ay] = poly[k]; const [bx, by] = poly[(k + 1) % poly.length];
      if ((ay <= y + 0.5) !== (by <= y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(size - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * size + x] = 1;
  }
  let out = m;
  if (grow > 0) { const g = gauss(m, size, size, 1, grow / 2); out = new Float32Array(m.length); for (let i = 0; i < m.length; i++) out[i] = g[i] > 0.02 ? 1 : 0; }
  return soft > 0 ? gauss(out, size, size, 1, soft) : out;
}
/** 地図の 0 でない所を囲む四角 [x0, y0, x1, y1]（なければ null） */
function maskBox(m, size) {
  let x0 = size; let y0 = size; let x1 = -1; let y1 = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y * size + x] > 1e-3) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/** 顔の輪郭の内側を 1、外を 0 にした地図（grow: 外へ広げる画素、soft: ぼかし）。512 の座標 */
export function faceMask(pts, size = SIZE, grow = 12, soft = 8) {
  return polyMask(OVAL.map((i) => pts[i]), size, grow, soft);
}

/**
 * 写真のうち、顔のまわりの四角を返す（mergeFace に渡す範囲）。[x, y, w, h]（W・H の中に収める）
 * @param {number[]} M 写真 → 512 の変換（写真の画素の座標）
 */
export function faceRegion(M, W, H, size = SIZE) {
  const inv = invertMatrix(M); let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [u, v] of [[0, 0], [size, 0], [0, size], [size, size]]) { const [x, y] = applyMatrix(inv, u, v); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const rx = Math.max(0, Math.floor(x0)); const ry = Math.max(0, Math.floor(y0)); const rx1 = Math.min(W, Math.ceil(x1)); const ry1 = Math.min(H, Math.ceil(y1));
  return rx1 > rx && ry1 > ry ? [rx, ry, rx1 - rx, ry1 - ry] : null;
}

/**
 * 顔専用 AI の結果を写真（RGBA の一部）に戻す。大まかな形と色（ぼかし SPLIT より大きいもの）は写真のまま、
 * それより細かい所を AI のものに入れ替える。いちばん細かい粒（写真の 1 画素くらい）は写真のまま（粒の見た目をまわりとそろえる）。
 * 顔の輪郭の内側（mask）だけに、amount（0〜1）の強さで当てる
 * @param {{data:Uint8ClampedArray,width:number,height:number}} region 写真の一部（ox, oy はその左上の、写真の中の位置）
 * @param {{M:number[],out:Float32Array,mask:Float32Array}} face M: 写真の画素 → 512、out: AI の結果（RGB 0〜255）、mask: 当てる所
 */
export function mergeFace(region, ox, oy, face, amount = 1, size = SIZE) {
  const { data, width: w, height: h } = region; const n = w * h; const sc = matrixScale(face.M);
  const up = new Float32Array(n * 3); const m = new Float32Array(n); const I = new Float32Array(n * 3); const tmp = new Float32Array(1);
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x; const [u, v] = applyMatrix(face.M, ox + x, oy + y);
      sampleF(face.out, size, size, 3, u, v, up, i * 3);
      if (u >= 0 && v >= 0 && u <= size - 1 && v <= size - 1) { sampleF(face.mask, size, size, 1, u, v, tmp, 0); m[i] = tmp[0] * amount; if (m[i] > 0) any = true; }
      for (let c = 0; c < 3; c++) I[i * 3 + c] = data[i * 4 + c];
    }
  }
  if (!any) return region;
  const s = SPLIT * sc; // 写真の画素でのぼかし
  const upL = gauss(up, w, h, 3, s); const iL = gauss(I, w, h, 3, s); const iF = gauss(I, w, h, 3, 1);
  for (let i = 0; i < n; i++) {
    if (!(m[i] > 0)) continue;
    for (let c = 0; c < 3; c++) {
      const o = i * 3 + c; const d = (up[o] - upL[o]) - (iF[o] - iL[o]);
      data[i * 4 + c] = Math.min(255, Math.max(0, Math.round(I[o] + d * m[i])));
    }
  }
  return region;
}
