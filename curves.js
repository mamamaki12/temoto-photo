// トーンカーブ: 点を通るなめらかな曲線（単調な3次スプライン。Fritsch–Carlson 法で行き過ぎを防ぐ）
export function monotoneSpline(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return () => 0;
  const dx = []; const m = []; const t = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = dx[i] > 0 ? (p[i + 1][1] - p[i][1]) / dx[i] : 0; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i]; const b = t[i + 1] / m[i]; const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0; while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = dx[i]; const u = (x - p[i][0]) / h; const u2 = u * u; const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p[i][1] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * p[i + 1][1] + (u3 - u2) * h * t[i + 1];
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 4本のカーブ（RGB全体・R・G・B）を 256段の表（RGBA）にまとめる。R = r(rgb(x)) など */
export function curvesLut(curves) {
  const all = monotoneSpline(curves.rgb); const ch = [monotoneSpline(curves.r), monotoneSpline(curves.g), monotoneSpline(curves.b)];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const m = clamp01(all(i / 255));
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(clamp01(ch[c](m)) * 255);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
export const isIdentityCurve = (pts) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
