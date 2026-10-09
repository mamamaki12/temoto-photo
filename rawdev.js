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
 * 0〜1 のリニア → 8bit（sRGB・Display P3 は同じ曲線）の表。
 * カメラの JPEG に近い見た目になるよう、ゆるい S 字のトーンカーブ（中間の明暗差を少し強く）も一緒に入れる
 */
const CONTRAST = 0.3;
const ENC = (() => {
  const t = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) {
    const x = i / 4096; const e = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    const sc = e * e * (3 - 2 * e); t[i] = Math.round((e + (sc - e) * CONTRAST) * 255);
  }
  return t;
})();
/** 彩度（リニアで、明るさを保ったまま）。実写真でカメラの JPEG と比べると、そのままで同じくらいの鮮やかさ */
const SAT = 1.0;
/** 暗部のつま先の強さ（リニアの明るさ。これより十分明るい所はほとんど変わらない） */
const TOE = 0.004;

/**
 * 現像の設定。exposure: RAW の露出（EV × 100）
 * @returns {{ M: number[][], gain: number }}
 */
export function developParams({ exposure = 0 } = {}, gain0, space) {
  return { M: fromRec2020(space), gain: gain0 * 2 ** (exposure / 100) };
}

/**
 * 一部（x, y から w×h）を現像して RGBA を返す。lin: { data: Uint16Array（RGB、リニア Rec.2020）, width, height }
 * 暗い所に出る色のノイズ（赤・緑・青の粒）は、色の成分だけを少しぼかして消す（明るさの成分はぼかさないので、細部は残る）。
 * ぼかしの届く範囲だけ広く読むので、一部ずつ現像しても、全体をまとめて現像したのと同じになる
 */
export function developRegion(lin, x, y, w, h, { M, gain }) {
  const { data, width: W, height: H } = lin; const out = new Uint8ClampedArray(w * h * 4);
  const r = Math.max(1, Math.round(Math.min(W, H) / 1500)); // 色ノイズのぼかしの半径（写真の大きさに比例）
  const m = r * 2; // 2回ぼかすので
  const X0 = Math.max(0, x - m); const Y0 = Math.max(0, y - m); const X1 = Math.min(W, x + w + m); const Y1 = Math.min(H, y + h + m);
  const ww = X1 - X0; const hh = Y1 - Y0; const N = ww * hh;
  const L = new Float32Array(N); const U = new Float32Array(N); const V = new Float32Array(N);
  const s = gain / 65535;
  const [a, b, c] = M; const a0 = a[0] * s; const a1 = a[1] * s; const a2 = a[2] * s; const b0 = b[0] * s; const b1 = b[1] * s; const b2 = b[2] * s; const c0 = c[0] * s; const c1 = c[1] * s; const c2 = c[2] * s;
  for (let yy = 0, i = 0; yy < hh; yy++) {
    let k = ((Y0 + yy) * W + X0) * 3;
    for (let xx = 0; xx < ww; xx++, i++, k += 3) {
      const r0 = data[k]; const g0 = data[k + 1]; const bl = data[k + 2];
      const R = a0 * r0 + a1 * g0 + a2 * bl; const G = b0 * r0 + b1 * g0 + b2 * bl; const B = c0 * r0 + c1 * g0 + c2 * bl;
      const Y = 0.2627 * R + 0.678 * G + 0.0593 * B; L[i] = Y; U[i] = R - Y; V[i] = B - Y;
    }
  }
  const Ub = boxBlur(U, ww, hh, r, 2); const Vb = boxBlur(V, ww, hh, r, 2);
  for (let yy = 0; yy < h; yy++) {
    let i = (y - Y0 + yy) * ww + (x - X0); let o = yy * w * 4;
    for (let xx = 0; xx < w; xx++, i++, o += 4) {
      // 暗部の「つま先」: いちばん暗い所を黒へ沈め、色も抜く（カメラの JPEG と同じく、ノイズの底が赤紫に浮かないように）
      const Y0r = L[i]; const k = Y0r > 0 ? Y0r / (Y0r + TOE) : 0; const Y = Y0r * k; const u = Ub[i] * SAT * k * k; const v = Vb[i] * SAT * k * k;
      let R = Y + u; let B = Y + v; let G = (Y - 0.2627 * R - 0.0593 * B) / 0.678;
      // 色域の外（負の値）は、明るさを保ったまま灰色に寄せる（成分ごとに 0 で切ると、暗い所のノイズが赤・緑の粒になる）
      const mn = R < G ? (R < B ? R : B) : G < B ? G : B;
      if (mn < 0) {
        if (Y <= 0) { R = 0; G = 0; B = 0; } else { const t = Y / (Y - mn); R = Y + (R - Y) * t; G = Y + (G - Y) * t; B = Y + (B - Y) * t; }
      }
      const mx = R > G ? (R > B ? R : B) : G > B ? G : B;
      if (mx > KNEE) { const f = shoulder(mx) / mx; R *= f; G *= f; B *= f; }
      out[o] = ENC[(R >= 1 ? 4096 : (R * 4096) | 0)]; out[o + 1] = ENC[(G >= 1 ? 4096 : (G * 4096) | 0)]; out[o + 2] = ENC[(B >= 1 ? 4096 : (B * 4096) | 0)]; out[o + 3] = 255;
    }
  }
  return out;
}
