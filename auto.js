// 自動補正: 元写真から、露光・白黒レベル・シャドウ・ハイライト・ホワイトバランスを決める（Snapseed の「自動」、Lightroom の「自動」に相当）
// hist: { r, g, b, l } それぞれ 256 要素の度数。data（RGBA の画素）があれば、ホワイトバランスは白・灰色らしい所から決める

function percentile(h, p) {
  const total = h.reduce((a, b) => a + b, 0) || 1; let acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc / total >= p) return i / 255; }
  return 1;
}
const mean = (h) => { let s = 0; let n = 0; for (let i = 0; i < 256; i++) { s += i * h[i]; n += h[i]; } return n ? s / n / 255 : 0.5; };
const clamp = (v, a, b) => Math.round(Math.min(b, Math.max(a, v)));
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const LIN = Array.from({ length: 256 }, (_, i) => toLin(i));

/**
 * 白・灰色らしい画素（色が薄く、暗すぎず白飛びしていない所）の平均の色（リニア）。
 * 壁・天井・白い服などは本当は灰色のはずなので、そこに残る色が照明の色かぶり。見つからなければ null
 */
export function neutralCast(data, step = 1) {
  let r = 0; let g = 0; let b = 0; let n = 0; let all = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    all++;
    const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
    const mx = Math.max(R, G, B); const mn = Math.min(R, G, B);
    if (mx < 60 || mx > 250 || (mx - mn) / mx > 0.3) continue;
    r += LIN[R]; g += LIN[G]; b += LIN[B]; n++;
  }
  if (n < all * 0.03) return null;
  return [r / n, g / n, b / n];
}

/** 色温度を t（-1〜1）にしたときの赤・青の倍率（engine.js の wbGain と同じ） */
const wbR = (t) => 1 + t * 0.18; const wbB = (t) => 1 - t * 0.22;

export function autoAdjust(hist, data) {
  const lo = percentile(hist.l, 0.005); const hi = percentile(hist.l, 0.995); const m = mean(hist.l);
  const med = percentile(hist.l, 0.5);
  // 平均と真ん中の明るさの間を 0.46 付近に（露光は 1 段 = 25）。暗い服などが多くても上げすぎない
  const ev = Math.log2(0.46 / Math.max(0.02, (m + med) / 2));
  const exposure = clamp(ev * 25 * 0.6, -50, 50);
  // 白・黒を広げる（すでに広がっていれば動かさない）
  const blacks = clamp(-(lo * 250), -30, 0);
  const whites = clamp((1 - hi) * 200, 0, 30);
  // ホワイトバランス
  let temp = 0; let tint = 0;
  const cast = data ? neutralCast(data, Math.max(1, Math.floor(data.length / 4 / 60000))) : null;
  if (cast) {
    const [r, g, b] = cast;
    // 灰色にするための色温度（赤/青の比を 1 にする t）を求めて、そのうちの一部だけ直す。
    // 電球の部屋の暖かい雰囲気は残したいので、暖かすぎる（赤い）方は控えめに、青白い方はしっかり直す
    const want = Math.log(b / Math.max(r, 1e-4)); // 正 = 青い（暖かくする）
    let t = 0; for (let k = 0; k < 30; k++) { const f = Math.log(wbR(t) / wbB(t)) + Math.log(r / b); t -= f / (0.18 / wbR(t) + 0.22 / wbB(t)); t = Math.max(-1, Math.min(1, t)); }
    temp = clamp(t * 100 * (want > 0 ? 0.6 : 0.35), -15, 20);
    const gm = g / Math.max((r + b) / 2, 1e-4);
    tint = clamp((gm - 1) * 60, -10, 10); // 緑かぶり → マゼンタ側へ（緑が強いと tint は正）
  } else {
    // 灰色の所がないときは、全体の平均で弱めに（青空や夕焼けまで直さない）
    const mr = mean(hist.r); const mg = mean(hist.g); const mb = mean(hist.b);
    temp = clamp((mb - mr) * 60, -10, 15);
    tint = clamp((mg - (mr + mb) / 2) * 60, -10, 10);
  }
  // コントラストが低い写真だけ強める
  const spread = hi - lo;
  const contrast = clamp((0.85 - spread) * 35, 0, 20);
  // 暗部・明部が多いときは、シャドウ・ハイライトで戻す（暗い服や髪のための持ち上げすぎを防いで、控えめに）
  const total = hist.l.reduce((a, b) => a + b, 0) || 1;
  const dark = hist.l.slice(0, 40).reduce((a, b) => a + b, 0) / total;
  const bright = hist.l.slice(225).reduce((a, b) => a + b, 0) / total;
  return { exposure, blacks, whites, temp, tint, contrast, shadows: clamp(dark * 60, 0, 20), highlights: clamp(-bright * 120, -40, 0), vibrance: 8 };
}

/** RGBA の画素からヒストグラムを作る（step 画素おきに数えて速くする） */
export function histogram(data, step = 1) {
  const r = new Array(256).fill(0); const g = new Array(256).fill(0); const b = new Array(256).fill(0); const l = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4 * step) {
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++;
    l[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  }
  return { r, g, b, l };
}
