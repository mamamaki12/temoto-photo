// 切り抜き・回転・反転・傾き補正・遠近補正の計算。
// シェーダー（engine.js）と同じ式を JS でも持ち、画面上の指の位置 → 元写真の位置の変換や、テストに使う。
//
// 座標の約束:
//   元写真の座標 (s, t)      : 0..1（読み込んだ写真。EXIFの向きは読み込み時に反映済み）
//   向きを変えた後の座標 (u, v): 0..1（90°回転・反転の後。傾き補正と遠近補正はこの枠の中で行う）
//   出力の座標 (x, y)        : 0..1（切り抜いた結果の画像）

export const DEG = Math.PI / 180;

/** 90°回転を反映した大きさ */
export function orientedSize(geo, W, H) { return geo.rot % 2 ? { w: H, h: W } : { w: W, h: H }; }

/** 傾けても四隅に余白が出ないための拡大率 */
export function straightenZoom(angleDeg, w, h) {
  const a = Math.abs(angleDeg * DEG); const c = Math.cos(a); const s = Math.sin(a);
  return Math.max(c + (h / w) * s, c + (w / h) * s);
}

/** シェーダーに渡す値（engine.js の GLSL と同じ意味） */
export function geoParams(geo, W, H) {
  const o = orientedSize(geo, W, H);
  const a = (geo.persV / 100) * 0.35; const b = (geo.persH / 100) * 0.35;
  return {
    crop: [geo.crop.x, geo.crop.y, geo.crop.w, geo.crop.h], size: [o.w, o.h],
    cos: Math.cos(-geo.angle * DEG), sin: Math.sin(-geo.angle * DEG), zoom: straightenZoom(geo.angle, o.w, o.h),
    pa: a, pb: b, pk: (1 + Math.abs(a) / 2) * (1 + Math.abs(b) / 2),
    rot: geo.rot, flipH: geo.flipH ? 1 : 0, flipV: geo.flipV ? 1 : 0,
  };
}

/** 出力の座標 → 元写真の座標 */
export function outToSrc(x, y, p) {
  let u = p.crop[0] + x * p.crop[2]; let v = p.crop[1] + y * p.crop[3];
  let px = (u - 0.5) * p.size[0]; let py = (v - 0.5) * p.size[1];
  // 傾き補正（逆回転）と拡大
  const rx = (px * p.cos - py * p.sin) / p.zoom; const ry = (px * p.sin + py * p.cos) / p.zoom;
  px = rx / p.pk; py = ry / p.pk;
  // 遠近補正（台形）
  const qx = px * (1 + p.pa * (py / p.size[1])); const qy = py * (1 + p.pb * (px / p.size[0]));
  u = qx / p.size[0] + 0.5; v = qy / p.size[1] + 0.5;
  if (p.flipH) u = 1 - u;
  if (p.flipV) v = 1 - v;
  if (p.rot === 1) return [v, 1 - u];
  if (p.rot === 2) return [1 - u, 1 - v];
  if (p.rot === 3) return [1 - v, u];
  return [u, v];
}

/** 元写真の座標 → 出力の座標（ニュートン法で outToSrc を逆に解く） */
export function srcToOut(s, t, p) {
  let x = 0.5; let y = 0.5; const e = 1e-4;
  for (let i = 0; i < 12; i++) {
    const [a, b] = outToSrc(x, y, p);
    const fx = a - s; const fy = b - t;
    if (Math.abs(fx) + Math.abs(fy) < 1e-9) break;
    const [ax, bx] = outToSrc(x + e, y, p); const [ay, by] = outToSrc(x, y + e, p);
    const j11 = (ax - a) / e; const j21 = (bx - b) / e; const j12 = (ay - a) / e; const j22 = (by - b) / e;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) break;
    x -= (j22 * fx - j12 * fy) / det; y -= (-j21 * fx + j11 * fy) / det;
  }
  return [x, y];
}

/** 出力画像の大きさ（px） */
export function outputSize(geo, W, H) {
  const o = orientedSize(geo, W, H);
  return { w: Math.max(1, Math.round(o.w * geo.crop.w)), h: Math.max(1, Math.round(o.h * geo.crop.h)) };
}
