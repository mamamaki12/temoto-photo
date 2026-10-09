// 仕上げの合成（2D Canvas）: 色を整えた画像 + フレーム（枠・角丸・余白） + 文字・スタンプ・手描き
// プレビューと書き出しで同じ関数を使うので、見た目が一致する。
import { FONT_CSS } from './state.js';
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

/** 文字・スタンプの見た目の大きさ（当たり判定にも使う） */
export function overlayBox(ctx, o, L) {
  const m = Math.min(L.iw, L.ih);
  if (o.type === 'text') {
    const fs = o.size * m; ctx.font = `${o.bold ? '700' : '400'} ${fs}px ${FONT_CSS[o.font]}`;
    const lines = o.text.split('\n');
    if (o.vertical) {
      const cols = lines.length; const rows = Math.max(...lines.map((l) => [...l].length), 1);
      return { w: cols * fs * 1.15, h: rows * fs * 1.05, fs, lines };
    }
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width), fs * 0.5);
    return { w, h: lines.length * fs * 1.25, fs, lines };
  }
  if (o.type === 'sticker') { const fs = o.size * m; return { w: fs * 1.2, h: fs * 1.2, fs }; }
  if (o.type === 'draw') {
    if (!o.pts.length) return { w: 0, h: 0, x0: 0, y0: 0 };
    const xs = o.pts.map((p) => p[0]); const ys = o.pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  return { w: 0, h: 0 };
}

export function drawOverlay(ctx, o, L) {
  const m = Math.min(L.iw, L.ih);
  const cx = L.ix + o.x * L.iw; const cy = L.iy + o.y * L.ih;
  ctx.save();
  ctx.globalAlpha = o.opacity;
  if (o.type === 'draw') {
    if (o.pts.length) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = o.width * m;
      ctx.beginPath();
      o.pts.forEach(([x, y], i) => { const px = L.ix + x * L.iw; const py = L.iy + y * L.ih; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      if (o.pts.length === 1) ctx.lineTo(L.ix + o.pts[0][0] * L.iw + 0.01, L.iy + o.pts[0][1] * L.ih);
      if (o.mode === 'marker') { ctx.globalAlpha = o.opacity * 0.45; ctx.strokeStyle = o.color; ctx.stroke(); }
      else if (o.mode === 'neon') { ctx.shadowColor = o.color; ctx.shadowBlur = o.width * m * 2.5; ctx.strokeStyle = o.color; ctx.stroke(); ctx.shadowBlur = 0; ctx.lineWidth = o.width * m * 0.35; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
      else { ctx.strokeStyle = o.color; ctx.stroke(); }
    }
    ctx.restore();
    return;
  }
  ctx.translate(cx, cy); ctx.rotate((o.rot * Math.PI) / 180);
  const box = overlayBox(ctx, o, L);
  if (o.type === 'sticker') {
    ctx.font = `${box.fs}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(o.emoji, 0, box.fs * 0.05);
    ctx.restore();
    return;
  }
  // 文字
  const { fs, lines } = box;
  if (o.bg) {
    const pad = fs * 0.35; ctx.fillStyle = o.bgColor; ctx.globalAlpha = o.opacity * 0.85;
    roundRect(ctx, -box.w / 2 - pad, -box.h / 2 - pad, box.w + pad * 2, box.h + pad * 2, fs * 0.3); ctx.fill();
    ctx.globalAlpha = o.opacity;
  }
  if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = fs * 0.25; ctx.shadowOffsetY = fs * 0.06; }
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const paint = (t, x, y) => {
    if (o.stroke > 0) { ctx.lineWidth = o.stroke * fs; ctx.strokeStyle = o.strokeColor; ctx.strokeText(t, x, y); }
    ctx.fillStyle = o.color; ctx.fillText(t, x, y);
  };
  if (o.vertical) {
    // 縦書き（右の列から）
    ctx.textAlign = 'center';
    lines.forEach((line, ci) => {
      const x = box.w / 2 - fs * 1.15 * (ci + 0.5);
      [...line].forEach((ch, ri) => paint(ch, x, -box.h / 2 + fs * 1.05 * (ri + 0.5)));
    });
  } else {
    ctx.textAlign = o.align;
    const ax = o.align === 'left' ? -box.w / 2 : o.align === 'right' ? box.w / 2 : 0;
    lines.forEach((line, i) => paint(line, ax, -box.h / 2 + fs * 1.25 * (i + 0.5)));
  }
  ctx.restore();
}

/**
 * 合成する。image: 色を整えた画像（WebGL の canvas など）
 * @param {{hide?: string}} opts hide: 編集中で表示しない文字の id
 */
export function compose(target, image, state, { hide } = {}) {
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
  for (const o of state.overlays) if (o.id !== hide) drawOverlay(ctx, o, L);
  ctx.restore();
  return L;
}

/** 画面上の点（合成後の画像の px）にある文字・スタンプを探す（上にあるものから） */
export function hitOverlay(ctx, overlays, px, py, L) {
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i];
    if (o.type === 'draw') {
      const m = Math.min(L.iw, L.ih); const tol = Math.max(o.width * m, m * 0.02);
      if (o.pts.some(([x, y]) => Math.hypot(L.ix + x * L.iw - px, L.iy + y * L.ih - py) < tol)) return o;
      continue;
    }
    const b = overlayBox(ctx, o, L);
    const cx = L.ix + o.x * L.iw; const cy = L.iy + o.y * L.ih; const a = (-o.rot * Math.PI) / 180;
    const dx = px - cx; const dy = py - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a); const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const pad = (b.fs || 0) * 0.4;
    if (Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad) return o;
  }
  return null;
}
