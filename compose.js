// 仕上げの合成（2D Canvas）: 色を整えた画像 + フレーム（枠・角丸・余白）
// プレビューと書き出しで同じ関数を使うので、見た目が一致する。
import { ctx2d } from './color.js';

/** フレームを含めた最終的な大きさと、画像を置く位置 */
export function layout(W, H, frame) {
  const m = Math.min(W, H);
  const b = Math.round((frame.width / 100) * m);
  let cw = W + b * 2; let ch = H + b * 2;
  if (frame.pad && frame.pad !== 'none') {
    const [a, c] = frame.pad.split(':').map(Number); const r = a / c;
    if (cw / ch > r) ch = Math.round(cw / r); else cw = Math.round(ch * r);
  }
  return { cw, ch, ix: Math.round((cw - W) / 2), iy: Math.round((ch - H) / 2), iw: W, ih: H, border: b };
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

/**
 * 合成する。image: 色を整えた画像（WebGL の canvas など）
 */
export function compose(target, image, state) {
  const W = image.width; const H = image.height;
  const L = layout(W, H, state.frame);
  if (target.width !== L.cw || target.height !== L.ch) { target.width = L.cw; target.height = L.ch; }
  const ctx = ctx2d(target);
  ctx.save();
  ctx.clearRect(0, 0, L.cw, L.ch);
  const f = state.frame;
  // 余白（ぼかした写真か単色）
  if (L.cw !== W + L.border * 2 || L.ch !== H + L.border * 2) {
    if (f.padFill === 'blur') {
      const s = Math.max(L.cw / W, L.ch / H);
      ctx.filter = `blur(${Math.round(Math.max(L.cw, L.ch) / 30)}px) brightness(0.85)`;
      ctx.drawImage(image, (L.cw - W * s) / 2, (L.ch - H * s) / 2, W * s, H * s);
      ctx.filter = 'none';
    } else { ctx.fillStyle = f.padColor; ctx.fillRect(0, 0, L.cw, L.ch); }
  }
  // 枠
  const r = (f.radius / 100) * Math.min(W, H) / 2;
  if (L.border > 0) { ctx.fillStyle = f.color; roundRect(ctx, L.ix - L.border, L.iy - L.border, W + L.border * 2, H + L.border * 2, r > 0 ? r + L.border * 0.6 : 0); ctx.fill(); }
  if (r > 0) { ctx.save(); roundRect(ctx, L.ix, L.iy, W, H, r); ctx.clip(); ctx.drawImage(image, L.ix, L.iy); ctx.restore(); }
  else ctx.drawImage(image, L.ix, L.iy);
  ctx.restore();
  return L;
}
