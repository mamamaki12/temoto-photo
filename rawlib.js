// キヤノン（CR3・CR2）・ニコン・ソニー・富士フイルムなどの RAW を、LibRaw（WebAssembly）で RAW データから現像する。
// LibRaw は別スレッド（Worker）で動き、端末の外には何も送らない（読み込むのは同じサイトの vendor/libraw だけ）。
// 出力は 16bit・リニア・Rec.2020（広い色域）。見た目への仕上げ（rawdev.js）はこのアプリで行う。
import { autoGain, developParams, developRegion } from './rawdev.js';
import { COLOR_SPACE, ctx2d, imageData } from './color.js';

/** LibRaw で現像する RAW（DNG はこれまでどおり raw.js で現像する） */
export const LIBRAW_RE = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|3fr|fff|iiq|erf|mef|mos|kdc|dcr|x3f)$/i;

/** 16bit・リニア・Rec.2020・撮影時のホワイトバランス。白飛びした所は周りの色となじませる（highlight 2） */
const OPTIONS = { outputBps: 16, outputColor: 8, gamm: [1, 1], noAutoBright: true, useCameraWb: true, highlight: 2 };

/**
 * @param {ArrayBuffer} buffer RAW ファイル（中身はコピーして渡すので、呼び出し側でそのまま使える）
 * @param {{half?: boolean}} o half: 半分の大きさ（4画素を1つに。速い。編集中の表示用）。
 *   false なら元の大きさで、デモザイク（色の補間）は DHT（細かい所の色にじみ・迷路模様が出にくい）
 */
export async function decodeLibRaw(buffer, { half = false } = {}) {
  const { default: LibRaw } = await import('./vendor/libraw/index.js');
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(buffer.slice(0)), { ...OPTIONS, halfSize: half, userQual: half ? 0 : 11 });
    const meta = await raw.metadata();
    // 画素数に対してファイルが小さすぎる（RAW データが入っていない）ものは、読めたことにしない（中のプレビューを使う）
    if (!(meta.width > 0 && meta.height > 0) || buffer.byteLength * 4 < meta.width * meta.height) throw new Error('libraw: no raw data');
    const img = await raw.imageData();
    if (!img?.data || img.colors !== 3 || img.bits !== 16 || !img.width || !img.height) throw new Error('libraw output');
    const swap = meta.flip === 5 || meta.flip === 6; // 縦位置（LibRaw が回してくれる）
    return {
      lin: { data: img.data, width: img.width, height: img.height },
      fullW: swap ? meta.height : meta.width, fullH: swap ? meta.width : meta.height,
      model: `${meta.camera_make || ''} ${meta.camera_model || ''}`.trim(),
    };
  } finally { raw.dispose(); }
}

/** 現像して Canvas にする（編集中の写真）。gain: 明るさをそろえる倍率（なければ画素から決める） */
export function developToCanvas(lin, rawState, gain = lin.gain ?? autoGain(lin.data, lin.width, lin.height), canvas = document.createElement('canvas')) {
  canvas.width = lin.width; canvas.height = lin.height;
  const px = developRegion(lin, 0, 0, lin.width, lin.height, developParams(rawState, gain, COLOR_SPACE));
  ctx2d(canvas).putImageData(imageData(px, lin.width, lin.height), 0, 0);
  return canvas;
}

/**
 * 元の大きさで書き出すための「画素の入れ物」。Canvas に入りきらない大きさでも、一部ずつ現像して渡せる（fullres.js が使う）
 * 値は書き出す色空間（COLOR_SPACE）のまま
 */
export function pixelSource(lin, rawState, gain) {
  const p = developParams(rawState, gain, COLOR_SPACE);
  return { width: lin.width, height: lin.height, region: (x, y, w, h) => developRegion(lin, x, y, w, h, p), close() { lin.data = null; } };
}
