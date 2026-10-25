// 目線: 黒目をまぶたの中で動かす（まぶたの外は変えない。つなぎ目を作らない）
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrush, brushBounds } from '../../brushfx.js';

// 作りものの目: 肌の中に、白目（横長の楕円）と黒目（円）。黒目は右に寄っている（横を見ている）
const W = 300; const H = 200; const CX = 150; const CY = 100; const EW = 60; const EH = 24; const IX = 172; const R = 18;
const SKIN = [205, 160, 140]; const WHITE = [235, 232, 228]; const IRIS = [50, 35, 30];
function eyeImage() {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = SKIN; const u = (x - CX) / EW; const v = (y - CY) / EH;
    if (u * u + v * v < 1) c = Math.hypot(x - IX, y - CY) < R ? IRIS : WHITE;
    const k = (y * W + x) * 4; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
  }
  return { width: W, height: H, data: d };
}
// まぶたのふち 16 点（楕円の上）。0: 目頭、8: 目尻、4: 下まぶたの真ん中、12: 上まぶたの真ん中
const lid = Array.from({ length: 16 }, (_, i) => { const a = Math.PI - (i / 16) * Math.PI * 2; return [(CX + Math.cos(a) * EW) / W, (CY + Math.sin(a) * EH) / H]; });
const iris = [[IX / W, CY / H], [IX / W, (CY - R) / H], [(IX + R) / W, CY / H], [IX / W, (CY + R) / H], [(IX - R) / W, CY / H]];
const face = [{ lid, iris, pose: [0, 0] }]; // 片目だけの顔（両目は同じ処理）
const op = (extra = {}) => ({ type: 'gaze', pts: [[0.5, 0.5]], r: 0.01, amt: 1, eyes: [face], ...extra });
const px = (img, x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
const dark = (img, x, y) => px(img, x, y).every((v, i) => Math.abs(v - IRIS[i]) < 25);
/** 黒目（暗い画素）の重心の x */
function irisCenterX(img) { let s = 0; let n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dark(img, x, y)) { s += x; n++; } return s / n; }

test('目線: 黒目が目の真ん中へ動き、白目に黒目の残りが出ず、まぶたの外（肌）は変わらない', () => {
  const img = eyeImage(); const before = eyeImage();
  applyBrush(img, op());
  assert.ok(Math.abs(irisCenterX(img) - CX) < 2, `黒目の中心 ${irisCenterX(img)} が真ん中 ${CX} に来る`);
  assert.ok(dark(img, CX, CY) && !dark(img, IX + R - 3, CY), '元の位置の右端は白目に戻る');
  let outside = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const u = (x - CX) / EW; const v = (y - CY) / EH; if (u * u + v * v > 1.1 && px(img, x, y).some((c, i) => c !== px(before, x, y)[i])) outside++; }
  assert.equal(outside, 0, '楕円の外は 1 画素も変わらない');
  // 白目に、黒目と肌の中間のような灰色のつなぎ目ができない（黒目か白目に近い色だけ）
  let odd = 0; for (let x = CX - EW + 3; x < CX + EW - 3; x++) { const p = px(img, x, CY); const L = (p[0] + p[1] + p[2]) / 3; if (L > 90 && L < 180) odd++; }
  assert.ok(odd <= 4, `横 1 行で中間色の画素は黒目のふちの数画素だけ（${odd}）`);
});

test('目線: 寄せる量（amt）と微調整（tune）で動かす量が変わる。動かす量が 0 なら何も変えない', () => {
  const half = eyeImage(); applyBrush(half, op({ amt: 0.5 }));
  assert.ok(Math.abs(irisCenterX(half) - (IX + CX) / 2) < 2, '半分だけ動く');
  const tuned = eyeImage(); applyBrush(tuned, op({ tune: [-0.5, 0] }));
  assert.ok(Math.abs(irisCenterX(tuned) - (CX - R * 0.5)) < 2.5, '微調整で黒目の半径の半分ぶんさらに左へ');
  const same = eyeImage(); const before = eyeImage(); applyBrush(same, op({ amt: 0.001 }));
  assert.deepEqual([...same.data], [...before.data]);
});

test('目線: 閉じかけの目（開きが黒目の半径の 7 割より小さい）は動かさない。書き出しで読み出す範囲は両目のまわり', () => {
  const narrow = lid.map(([x, y]) => [x, (CY + (y * H - CY) * 0.2) / H]);
  const img = eyeImage(); const before = eyeImage();
  applyBrush(img, op({ eyes: [[{ lid: narrow, iris, pose: [0, 0] }]] }));
  assert.deepEqual([...img.data], [...before.data]);
  const [x, y, w, h] = brushBounds(op(), W, H);
  assert.ok(x <= CX - EW - R && x + w >= CX + EW + R && y <= CY - EH - R && y + h >= CY + EH + R);
});

test('目線: 白目が見えない目（暗くて目全体が黒くつぶれている）は動かさない', () => {
  const img = eyeImage(); const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (d[i] === WHITE[0]) { d[i] = 60; d[i + 1] = 45; d[i + 2] = 40; } // 白目も黒目と同じくらい暗い
  const before = new Uint8ClampedArray(d);
  applyBrush(img, op());
  assert.deepEqual([...img.data], [...before]);
});
