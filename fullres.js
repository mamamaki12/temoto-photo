// 元の大きさで書き出す。
// 編集中は端末が扱いやすい大きさ（約1,670万画素まで）に縮めた写真で見せ、書き出すときだけ元の写真から描き直す。
// iPhone の Safari は大きな Canvas を作れないので、
//   ① 元の写真を GPU に送り（美肌・修復は一部ずつ当てる）、
//   ② 仕上がりを横長の帯に分けて描き、
//   ③ 帯ごとに JPEG / PNG のファイルに書き足す（encode.js）。
// どの段階でも、端末の上限を超える大きさの Canvas は作らない。
import { Engine } from './engine.js';
import { effective } from './presets.js';
import { outputSize } from './geometry.js';
import { layout, roundRect } from './compose.js';
import { skinPlan, portraitTile, portraitMargin, portraitActive } from './portrait.js';
import { heal, mosaic, blurRect } from './retouch.js';
import { jpegEncoder, pngEncoder, readJpegIcc } from './encode.js';
import { COLOR_SPACE, ctx2d, imageData } from './color.js';

const TILE = 1024; // 美肌を当てる一部の大きさ
const STRIP_PIXELS = 4_000_000; // 帯 1 本の画素数の目安

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const later = () => new Promise((r) => setTimeout(r, 0)); // 画面が固まらないよう、ときどき手を放す

/** 書き出すファイルに入れる色の情報（ICC プロファイル）。ブラウザ自身が作る JPEG から取り出す */
const iccCache = {};
async function iccFor(space) {
  if (space === 'srgb') return null; // sRGB はプロファイルがなくても sRGB として扱われる
  if (!(space in iccCache)) {
    const c = canvas(2, 2); const x = c.getContext('2d', { colorSpace: space }); x.fillRect(0, 0, 2, 2);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    iccCache[space] = b ? readJpegIcc(new Uint8Array(await b.arrayBuffer())) : null;
  }
  return iccCache[space];
}

/**
 * @param {object} a
 * @param {ImageBitmap|HTMLCanvasElement|{width,height,region}} a.full 元の大きさの写真（向きは直したもの）。
 *   region(x, y, w, h) を持つものは、RAW を現像した画素（書き出す色空間の値。Canvas を通さずに一部ずつ取り出す）
 * @param {HTMLCanvasElement|ImageBitmap} a.work 編集用の大きさの写真（美肌の範囲を決めるのに使う）
 * @param {object} a.state 編集内容（検証済み）
 * @param {ImageData|object} a.mask ブラシの部分補正のマスク
 * @param {'image/jpeg'|'image/png'} a.format
 * @param {'display-p3'|'srgb'} a.space 書き出す色空間
 * @param {(t:number)=>void} [a.onProgress] 0〜1
 */
export async function exportFull({ full, work, state, mask, format, quality = 0.92, space = COLOR_SPACE, maxSide = 0, onProgress = () => {} }) {
  const glc = canvas(1, 1); const eng = new Engine(glc);
  try {
    // 写真が GPU で扱える大きさを超えるときは、そこまで縮める
    let src = full; let FW = full.width; let FH = full.height;
    const lim = eng.maxSize;
    if (Math.max(FW, FH) > lim) {
      if (full.region) throw new Error('too large for GPU');
      const s = lim / Math.max(FW, FH); FW = Math.floor(FW * s); FH = Math.floor(FH * s);
      src = await createImageBitmap(full, { resizeWidth: FW, resizeHeight: FH, resizeQuality: 'high' });
    }
    onProgress(0.02);
    // ① 元の写真を GPU に
    eng.allocSource(FW, FH);
    if (src.region) {
      // RAW を現像した画素（Canvas に入りきらない大きさ）: 帯ごとに現像して GPU に送る。8bit に丸めた残りも送って、16bit の細かさで描く
      const band = Math.max(1, Math.floor(STRIP_PIXELS / FW));
      if (src.regionHi) eng.allocResidual(FW, FH);
      for (let y = 0; y < FH; y += band) {
        const bh = Math.min(band, FH - y);
        if (src.regionHi) { const r = src.regionHi(0, y, FW, bh); eng.putSourcePixels(0, y, FW, bh, r.px); eng.putResidualPixels(0, y, FW, bh, r.res); }
        else eng.putSourcePixels(0, y, FW, bh, src.region(0, y, FW, bh));
        onProgress(0.02 * (y / FH)); await later();
      }
    } else eng.putSource(0, 0, src);
    if (portraitActive(state.portrait)) await portraitFull(eng, src, work, state.portrait, FW, FH, (t) => onProgress(0.02 + t * 0.3));
    for (const op of state.retouch) await retouchFull(eng, op, FW, FH);
    eng.finishSource();
    if (src !== full) src.close?.();
    eng.setMask(mask);
    onProgress(0.35);

    // ② 大きさを決める（枠・余白を含めた長辺の指定と、GPU の上限）
    const st = effective(state);
    const o = outputSize(state.geo, FW, FH);
    const L0 = layout(o.w, o.h, state.frame);
    const s = Math.min(1, (maxSide || Infinity) / Math.max(L0.cw, L0.ch), lim / Math.max(o.w, o.h));
    const outW = Math.max(1, Math.round(o.w * s)); const outH = Math.max(1, Math.round(o.h * s));
    const L = layout(outW, outH, state.frame);
    const f = state.frame;
    // 余白をぼかした写真で埋めるときの背景（ぼかすので、小さく描いて引き伸ばす）
    let padBg = null;
    if (f.pad !== 'none' && f.padFill === 'blur' && (L.cw !== outW + L.border * 2 || L.ch !== outH + L.border * 2)) {
      const k = Math.min(1, 1024 / Math.max(L.cw, L.ch)); const sw = Math.max(1, Math.round(outW * k)); const sh = Math.max(1, Math.round(outH * k));
      eng.render(st, sw, sh);
      padBg = canvas(Math.max(1, Math.round(L.cw * k)), Math.max(1, Math.round(L.ch * k)));
      const bx = ctx2d(padBg); const sc = Math.max(padBg.width / sw, padBg.height / sh);
      bx.filter = `blur(${Math.round(Math.max(padBg.width, padBg.height) / 30)}px) brightness(0.85)`;
      bx.drawImage(glc, (padBg.width - sw * sc) / 2, (padBg.height - sh * sc) / 2, sw * sc, sh * sc);
    }

    // ③ 帯ごとに描いて、ファイルに書き足す
    const icc = await iccFor(space);
    const enc = format === 'image/png'
      ? pngEncoder({ width: L.cw, height: L.ch, icc, iccName: space === 'display-p3' ? 'Display P3' : 'sRGB' })
      : jpegEncoder({ width: L.cw, height: L.ch, quality, icc });
    eng.beginStrips(st, outW, outH);
    const SH = Math.max(16, Math.min(1024, Math.floor(STRIP_PIXELS / L.cw / 16) * 16));
    const strip = canvas(L.cw, SH); const sx = ctx2d(strip, { willReadFrequently: true });
    const img = canvas(outW, SH); const ix = ctx2d(img);
    const r = (f.radius / 100) * Math.min(outW, outH) / 2;
    for (let Y0 = 0; Y0 < L.ch; Y0 += SH) {
      const rows = Math.min(SH, L.ch - Y0);
      sx.save(); sx.setTransform(1, 0, 0, 1, 0, 0); sx.clearRect(0, 0, L.cw, SH);
      if (format === 'image/jpeg') { sx.fillStyle = '#ffffff'; sx.fillRect(0, 0, L.cw, SH); }
      sx.translate(0, -Y0);
      if (L.cw !== outW + L.border * 2 || L.ch !== outH + L.border * 2) {
        if (padBg) sx.drawImage(padBg, 0, 0, L.cw, L.ch); else { sx.fillStyle = f.padColor; sx.fillRect(0, 0, L.cw, L.ch); }
      }
      if (L.border > 0) { sx.fillStyle = f.color; roundRect(sx, L.ix - L.border, L.iy - L.border, outW + L.border * 2, outH + L.border * 2, r > 0 ? r + L.border * 0.6 : 0); sx.fill(); }
      // 写真のうち、この帯に入る行
      const a = Math.max(Y0, L.iy) - L.iy; const b = Math.min(Y0 + rows, L.iy + outH) - L.iy;
      if (b > a) {
        const px = eng.renderStrip(a, b - a);
        ix.putImageData(imageData(px, outW, b - a), 0, 0);
        if (r > 0) { sx.save(); roundRect(sx, L.ix, L.iy, outW, outH, r); sx.clip(); }
        sx.drawImage(img, 0, 0, outW, b - a, L.ix, L.iy + a, outW, b - a);
        if (r > 0) sx.restore();
      }
      sx.restore();
      const data = sx.getImageData(0, 0, L.cw, rows, { colorSpace: space }).data;
      await enc.add(data, rows);
      onProgress(0.35 + 0.63 * Math.min(1, (Y0 + rows) / L.ch));
      await later();
    }
    eng.endStrips();
    const blob = await enc.finish();
    onProgress(1);
    return { blob, w: L.cw, h: L.ch };
  } finally { eng.dispose(); }
}

/** 美肌を、元の大きさの写真に一部ずつ当てる（肌の範囲は編集用の大きさの写真で決める） */
async function portraitFull(eng, src, work, p, FW, FH, onProgress) {
  const wc = canvas(work.width, work.height); const wx = ctx2d(wc, { willReadFrequently: true }); wx.drawImage(work, 0, 0);
  const plan = skinPlan(wx.getImageData(0, 0, wc.width, wc.height), p);
  if (!plan.enough || !plan.bbox) return;
  const S = Math.min(FW, FH); const { f, margin } = portraitMargin(S);
  // 肌のある範囲（＋余白）だけを、そろえた位置から一部ずつ
  const align = (v) => Math.floor(v / f) * f;
  const bx0 = align(Math.max(0, plan.bbox[0] * FW - margin)); const by0 = align(Math.max(0, plan.bbox[1] * FH - margin));
  const bx1 = Math.min(FW, Math.ceil(plan.bbox[2] * FW + margin)); const by1 = Math.min(FH, Math.ceil(plan.bbox[3] * FH + margin));
  const T = Math.ceil(TILE / f) * f; const tiles = [];
  for (let ty = by0; ty < by1; ty += T) for (let tx = bx0; tx < bx1; tx += T) tiles.push([tx, ty]);
  const tc = canvas(1, 1);
  let n = 0;
  for (const [tx, ty] of tiles) {
    const x0 = Math.max(0, tx - margin); const y0 = Math.max(0, ty - margin);
    const x1 = Math.min(FW, tx + T + margin); const y1 = Math.min(FH, ty + T + margin);
    const w = x1 - x0; const h = y1 - y0;
    let img;
    if (src.region) img = { width: w, height: h, data: src.region(x0, y0, w, h) };
    else {
      tc.width = w; tc.height = h; const tx2 = ctx2d(tc, { willReadFrequently: true });
      tx2.clearRect(0, 0, w, h); tx2.drawImage(src, x0, y0, w, h, 0, 0, w, h);
      img = tx2.getImageData(0, 0, w, h);
    }
    if (portraitTile(img, p, plan, { S, ox: x0, oy: y0, fullW: FW, fullH: FH })) {
      // 内側（余白を除いた部分）だけを GPU に戻す
      const ix0 = tx - x0; const iy0 = ty - y0; const iw = Math.min(T, FW - tx); const ih = Math.min(T, FH - ty);
      const out = new Uint8ClampedArray(iw * ih * 4);
      for (let y = 0; y < ih; y++) out.set(img.data.subarray(((iy0 + y) * w + ix0) * 4, ((iy0 + y) * w + ix0 + iw) * 4), y * iw * 4);
      eng.putSourcePixels(tx, ty, iw, ih, out);
    }
    onProgress(++n / tiles.length);
    await later();
  }
}

/** 修復・モザイク・ぼかしを、元の大きさの写真に当てる（その場所だけ読み出して書き戻す） */
async function retouchFull(eng, op, W, H) {
  const S = Math.min(W, H);
  const region = (x0, y0, x1, y1) => {
    const rx = Math.max(0, Math.floor(x0)); const ry = Math.max(0, Math.floor(y0)); const rx1 = Math.min(W, Math.ceil(x1)); const ry1 = Math.min(H, Math.ceil(y1));
    return rx1 > rx && ry1 > ry ? [rx, ry, rx1 - rx, ry1 - ry] : null;
  };
  if (op.type === 'heal') {
    const r = Math.max(2, op.r * S); const cx = op.x * W; const cy = op.y * H;
    const sx = (op.sx ?? op.x) * W; const sy = (op.sy ?? op.y) * H; const R = r * 1.3 + 3;
    const g = region(Math.min(cx, sx) - R, Math.min(cy, sy) - R, Math.max(cx, sx) + R, Math.max(cy, sy) + R); if (!g) return;
    const [rx, ry, rw, rh] = g; const img = { width: rw, height: rh, data: eng.readSource(rx, ry, rw, rh) };
    heal(img, cx - rx, cy - ry, r, [sx - rx, sy - ry]);
    eng.putSourcePixels(rx, ry, rw, rh, img.data);
  } else if (op.type === 'mosaic') {
    const g = region(op.x * W, op.y * H, (op.x + op.w) * W, (op.y + op.h) * H); if (!g) return;
    const [rx, ry, rw, rh] = g; const block = Math.max(2, Math.max(2, (op.size / 400) * Math.max(W, H)) | 0);
    // 大きな範囲は、マスの区切りにそろえた帯に分けて
    const band = Math.max(1, Math.floor(2_000_000 / rw / block)) * block;
    for (let y = 0; y < rh; y += band) {
      const bh = Math.min(band, rh - y); const img = { width: rw, height: bh, data: eng.readSource(rx, ry + y, rw, bh) };
      mosaic(img, 0, 0, rw, bh, block); eng.putSourcePixels(rx, ry + y, rw, bh, img.data);
      await later();
    }
  } else if (op.type === 'blur') {
    const g = region(op.x * W, op.y * H, (op.x + op.w) * W, (op.y + op.h) * H); if (!g) return;
    const [rx, ry, rw, rh] = g; const radius = Math.max(1, (op.size / 600) * Math.max(W, H));
    // 強いぼかしなので、縮めた画像の上でぼかして引き伸ばしても見た目は同じ
    const k = Math.min(1, Math.sqrt(2_000_000 / (rw * rh))); const sw = Math.max(2, Math.round(rw * k)); const sh = Math.max(2, Math.round(rh * k));
    const img = { width: sw, height: sh, data: eng.readSourceScaled(rx, ry, rw, rh, sw, sh) };
    blurRect(img, 0, 0, sw, sh, Math.max(1, radius * k));
    eng.putSourceScaled(rx, ry, rw, rh, sw, sh, img.data);
  }
}
