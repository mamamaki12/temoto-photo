// 自動補正: 元写真のヒストグラムから、露光・白黒レベル・ホワイトバランスを決める（Snapseed の「自動」、Lightroom の「自動」に相当）
// hist: { r, g, b, l } それぞれ 256 要素の度数

function percentile(h, p) {
  const total = h.reduce((a, b) => a + b, 0) || 1; let acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc / total >= p) return i / 255; }
  return 1;
}
const mean = (h) => { let s = 0; let n = 0; for (let i = 0; i < 256; i++) { s += i * h[i]; n += h[i]; } return n ? s / n / 255 : 0.5; };
const clamp = (v, a, b) => Math.round(Math.min(b, Math.max(a, v)));

export function autoAdjust(hist) {
  const lo = percentile(hist.l, 0.005); const hi = percentile(hist.l, 0.995); const m = mean(hist.l);
  // 平均の明るさを 0.46 付近に（露光は 1 段 = 25）
  const ev = Math.log2(0.46 / Math.max(0.02, m));
  const exposure = clamp(ev * 25 * 0.7, -60, 60);
  // 白・黒を広げる（すでに広がっていれば動かさない）
  const blacks = clamp(-(lo * 300), -40, 0);
  const whites = clamp((1 - hi) * 250, 0, 40);
  // ホワイトバランス: 中間の明るさの R・B の平均の差（グレーワールド仮説を弱めに）
  const mr = mean(hist.r); const mg = mean(hist.g); const mb = mean(hist.b);
  // 青空や夕焼けの写真まで「直して」しまわないよう、弱めにかける
  const temp = clamp((mb - mr) * 80, -20, 20);
  const tint = clamp((mg - (mr + mb) / 2) * 80, -15, 15);
  // コントラストが低い写真だけ強める
  const spread = hi - lo;
  const contrast = clamp((0.85 - spread) * 40, 0, 25);
  // 暗部が多い・明部が多いときは、シャドウ・ハイライトで戻す
  const dark = hist.l.slice(0, 50).reduce((a, b) => a + b, 0) / (hist.l.reduce((a, b) => a + b, 0) || 1);
  const bright = hist.l.slice(220).reduce((a, b) => a + b, 0) / (hist.l.reduce((a, b) => a + b, 0) || 1);
  return { exposure, blacks, whites, temp, tint, contrast, shadows: clamp(dark * 120, 0, 40), highlights: clamp(-bright * 150, -50, 0), vibrance: 15 };
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
