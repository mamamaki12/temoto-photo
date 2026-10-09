// 色の範囲（色空間）。iPhone などの写真は Display P3（sRGB より鮮やかな赤・緑まで記録できる）で保存されている。
// 対応しているブラウザでは、読み込み・編集・表示・書き出しのすべてを Display P3 のまま行い、振袖の赤などがくすまないようにする。
// 対応していないブラウザでは、これまでどおり sRGB。

function detect() {
  try {
    if (typeof document === 'undefined') return 'srgb';
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const ctx = c.getContext('2d', { colorSpace: 'display-p3' });
    return ctx?.getContextAttributes?.().colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
  } catch { return 'srgb'; }
}

/** この端末で使う色空間（'display-p3' か 'srgb'） */
export const COLOR_SPACE = detect();

/** 2D の Canvas を、決まった色空間で取り出す（最初に取り出したときの設定がずっと使われるので、必ずこれを通す） */
export function ctx2d(canvas, opts = {}) {
  return canvas.getContext('2d', { ...opts, colorSpace: COLOR_SPACE });
}

/** 画素の配列から ImageData を作る（色空間をそろえる。そろえないと Canvas に戻すときに色が変換されてしまう） */
export function imageData(data, w, h) {
  return COLOR_SPACE === 'srgb' ? new ImageData(data, w, h) : new ImageData(data, w, h, { colorSpace: COLOR_SPACE });
}

/** WebGL の読み込み・描画を同じ色空間にする */
export function glColorSpace(gl) {
  if (COLOR_SPACE === 'srgb') return;
  try { if ('unpackColorSpace' in gl) gl.unpackColorSpace = COLOR_SPACE; if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = COLOR_SPACE; } catch { /* 古いブラウザ */ }
}
