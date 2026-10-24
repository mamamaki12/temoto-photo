import { restoreInWorker } from './restoration-client.js';

// 一度にWorkerへ送る範囲を限定する。3画素の探索+1画素のパッチ分を重ねて継ぎ目を防ぐ。
export async function restorePhotoBanded(input, options = {}, hooks = {}) {
  const { width, height, data } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 16384 || width * height > 16_000_000 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new Error('比較画面は1600万画素・幅16384pxまで対応しています。自動縮小はしません。');
  }
  const output = new Uint8ClampedArray(data.length);
  const rows = Math.min(256, Math.floor(4_000_000 / width) - 8);
  for (let y = 0; y < height; y += rows) {
    if (hooks.signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError');
    const end = Math.min(height, y + rows); const top = Math.max(0, y - 4); const bottom = Math.min(height, end + 4);
    const part = await restorePhoto({ width, height: bottom - top, colorSpace: input.colorSpace,
      data: data.slice(top * width * 4, bottom * width * 4) }, options, {
      signal: hooks.signal,
      onProgress: ({ percent }) => hooks.onProgress?.({ percent: Math.min(99, Math.floor(100 * (y + (end - y) * percent / 100) / height)) }),
    });
    output.set(part.data.subarray((y - top) * width * 4, (end - top) * width * 4), y * width * 4);
  }
  if (hooks.signal?.aborted) throw new DOMException('処理を中止しました', 'AbortError');
  hooks.onProgress?.({ percent: 100 });
  return { width, height, data: output, colorSpace: input.colorSpace || 'srgb' };
}

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
