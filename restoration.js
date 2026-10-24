// 写真復元の比較用コア。UI未接続。リニアRGBのまま処理し、HDR値も切り捨てない。
// noiseSigma は入力と同じ単位の標準偏差。カメラ別・信号依存の推定は別工程。
export function restorationOptions(image, options = {}) {
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !(data instanceof Float32Array) || data.length !== width * height * 3) throw new Error('リニアRGBのFloat32Arrayが必要です');
  const opts = { noiseSigma: 0.01, strength: 1, exposureEV: 0, searchRadius: 3, tileSize: 128, ...options };
  for (const [key, lo, hi] of [['noiseSigma', 0, 1], ['strength', 0, 2], ['exposureEV', -5, 5], ['searchRadius', 1, 5], ['tileSize', 16, 256]]) {
    if (!Number.isFinite(opts[key]) || opts[key] < lo || opts[key] > hi) throw new Error(`不正な設定: ${key}`);
  }
  if (!Number.isInteger(opts.searchRadius) || !Number.isInteger(opts.tileSize)) throw new Error('探索範囲とタイル幅は整数が必要です');
  return opts;
}

const abort = () => new DOMException('処理を中止しました', 'AbortError');

/**
 * 3×3パッチのNon-local means。タイルの外側も参照するので境界に線が出ない。
 * RGB一緒の重みで色ずれを防ぐ。計算はJSの倍精度、保存先はFloat32。
 * onProgress は実際の完了タイル数。UI・書き出し全体の進捗ではない。
 */
export async function restoreLinear(image, options = {}, { onProgress = () => {}, signal, yieldTask = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const opts = restorationOptions(image, options);
  const { width: W, height: H, data } = image;
  const check = () => { if (signal?.aborted) throw abort(); };
  check();
  for (const v of data) if (!Number.isFinite(v) || v < 0 || v > 1e30) throw new Error('画素は有限の非負リニア値が必要です');
  const out = new Float32Array(data.length);
  const { tileSize: T, searchRadius: R, noiseSigma: sigma, strength, exposureEV } = opts;
  const gain = 2 ** exposureEV;
  const total = Math.ceil(W / T) * Math.ceil(H / T);
  let completed = 0;
  onProgress({ completed, total, percent: 0 });
  const pixel = (x, y) => (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3;
  for (let Y = 0; Y < H; Y += T) for (let X = 0; X < W; X += T) {
    check();
    const w = Math.min(T, W - X); const h = Math.min(T, H - Y);
    if (sigma === 0 || strength === 0) {
      for (let y = Y; y < Y + h; y++) for (let x = X; x < X + w; x++) {
        const i = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) out[i + c] = data[i + c] * gain;
      }
    } else {
      const n = w * h; const sums = new Float64Array(n * 3); const weights = new Float64Array(n);
      // 各探索位置の差分の積分画像。3×3の差を定数時間で求める。
      const stride = w + 3; const integral = new Float64Array(stride * (h + 3));
      const variance = sigma * sigma; const bandwidth = Math.max(Number.MIN_VALUE, variance * strength * strength);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        integral.fill(0);
        for (let y = 0; y < h + 2; y++) {
          let row = 0;
          for (let x = 0; x < w + 2; x++) {
            const p = pixel(X + x - 1, Y + y - 1); const q = pixel(X + x - 1 + dx, Y + y - 1 + dy);
            for (let c = 0; c < 3; c++) row += (data[p + c] - data[q + c]) ** 2;
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
          }
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const a = y * stride + x; const b = (y + 3) * stride + x;
          const distance = Math.max(0, (integral[b + 3] - integral[b] - integral[a + 3] + integral[a]) / 27 - 2 * variance);
          const weight = Math.exp(-distance / bandwidth);
          const j = y * w + x; const q = pixel(X + x + dx, Y + y + dy);
          weights[j] += weight;
          for (let c = 0; c < 3; c++) sums[j * 3 + c] += weight * data[q + c];
        }
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const j = y * w + x; const i = ((Y + y) * W + X + x) * 3;
        for (let c = 0; c < 3; c++) out[i + c] = sums[j * 3 + c] / weights[j] * gain;
      }
    }
    check();
    completed++;
    onProgress({ completed, total, percent: Math.floor(completed * 100 / total) });
    await yieldTask();
  }
  check();
  return { width: W, height: H, data: out };
}
