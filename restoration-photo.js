import { restoreInWorker } from './restoration-client.js';

// 評価用の写真アダプター。入力は同一色空間の8bit RGBA。
// 既存エンジンに合わせたgamma 2.2の近似。平方根領域でノイズを軽減してから明るくする。
// noise は平方根領域の標準偏差（255倍）。自動推定値ではない。
export async function restorePhoto(input, { amount = 60, noise = 3, strength = 1 } = {}, hooks = {}) {
  const { width, height, data } = input;
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4 ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 4_000_000) {
    throw new Error('評価用は400万画素までのRGBA画像に対応しています。画像は自動縮小しません。');
  }
  for (const [v, lo, hi] of [[amount, 0, 100], [noise, 0, 30], [strength, 0, 2]]) {
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error('補正の設定が範囲外です');
  }
  const check = () => { if (hooks.signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError'); };
  check();
  const rgb = new Float32Array(width * height * 3);
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    if (data[p + 3] !== 255) throw new Error('評価用は不透明な写真を使ってください');
    for (let c = 0; c < 3; c++) rgb[q + c] = (data[p + c] / 255) ** 1.1;
  }
  const result = await restoreInWorker({ width, height, data: rgb }, { noiseSigma: noise / 255, strength, exposureEV: 0 }, {
    signal: hooks.signal, onProgress: (p) => hooks.onProgress?.({ ...p, percent: Math.floor(p.percent * 0.95) }),
  });
  check();
  const output = new Uint8ClampedArray(data.length); const gain = 2 ** (amount / 25);
  for (let p = 0, q = 0; p < output.length; p += 4, q += 3) {
    const r = result.data[q] ** 2; const g = result.data[q + 1] ** 2; const b = result.data[q + 2] ** 2;
    const scale = gain / (1 + (gain - 1) * Math.max(r, g, b));
    output[p] = 255 * (r * scale) ** (1 / 2.2);
    output[p + 1] = 255 * (g * scale) ** (1 / 2.2);
    output[p + 2] = 255 * (b * scale) ** (1 / 2.2); output[p + 3] = 255;
  }
  check(); hooks.onProgress?.({ percent: 100 });
  return { width, height, data: output, colorSpace: input.colorSpace || 'srgb' };
}
