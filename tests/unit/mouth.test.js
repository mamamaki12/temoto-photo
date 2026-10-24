// 唇・歯の範囲を自動で決める（AI の口の輪郭は目印。境目は色で決める）
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrush } from '../../brushfx.js';

// 作りものの口: 肌の中に、唇（楕円の輪）と、口の中に歯（明るく色の薄い帯）と口の奥（暗い所）
const W = 400; const H = 300;
const SKIN = [205, 160, 140]; const LIP = [190, 95, 105]; const TOOTH = [215, 200, 160]; const DARK = [60, 30, 30];
function mouthImage({ open = true } = {}) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x - 200) / 90; const v = (y - 150) / 45; const r = u * u + v * v;
    const ui = (x - 200) / 70; const vi = (y - 150) / 18; const ri = ui * ui + vi * vi;
    let c = SKIN;
    if (r < 1) c = LIP;
    if (open && ri < 1) c = Math.abs(y - 150) < 9 && Math.abs(x - 200) < 60 ? TOOTH : DARK;
    const k = (y * W + x) * 4; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
  }
  return { width: W, height: H, data: d };
}
// AI の輪郭のかわり（少しずらしてある: 内側の輪郭は実際より上に 6 画素ずれて、小さめ）
const ring = (cx, cy, rx, ry, n = 20) => Array.from({ length: n }, (_, i) => [(cx + rx * Math.cos(i / n * 2 * Math.PI)) / W, (cy + ry * Math.sin(i / n * 2 * Math.PI)) / H]);
const lips = [{ outer: ring(200, 150, 88, 44), inner: ring(200, 144, 62, 14) }];
const px = (img, x, y) => { const k = (y * W + x) * 4; return [img.data[k], img.data[k + 1], img.data[k + 2]]; };
const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

test('歯: 輪郭が少しずれていても、歯だけを白くし、唇・口の奥・肌は変えない', () => {
  const img = mouthImage(); const org = mouthImage();
  applyBrush(img, { type: 'teeth', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, whole: true, lips });
  // 歯（輪郭の外にはみ出た下の方も）: 黄ばみ（色の濃さ）が減り、明るくなる
  for (const [x, y] of [[200, 150], [170, 156], [230, 145]]) {
    assert.ok(chroma(px(img, x, y)) < chroma(px(org, x, y)) - 8, `歯 ${x},${y}`);
    assert.ok(px(img, x, y)[1] >= px(org, x, y)[1], `歯は暗くならない ${x},${y}`);
  }
  // 唇・口の奥・肌は変わらない
  for (const [x, y] of [[200, 185], [200, 118], [265, 150], [200, 250], [20, 20]]) assert.deepEqual(px(img, x, y), px(org, x, y), `${x},${y}`);
});

test('リップ: 唇の全体に色がのり、歯（内側の輪郭からはみ出た所も）と肌には付かない', () => {
  const img = mouthImage(); const org = mouthImage();
  applyBrush(img, { type: 'lip', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, col: [196, 30, 48], whole: true, lips });
  for (const [x, y] of [[200, 185], [200, 116], [118, 150]]) { const a = px(img, x, y); const b = px(org, x, y); assert.ok(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 15, `唇 ${x},${y}`); }
  for (const [x, y] of [[200, 156], [200, 250], [20, 20]]) { const a = px(img, x, y); const b = px(org, x, y); for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - b[c]) <= 2, `${x},${y}`); }
});

test('歯: 口を閉じている（内側の輪郭がつぶれている）ときは、何も変えない', () => {
  const img = mouthImage({ open: false }); const org = mouthImage({ open: false });
  applyBrush(img, { type: 'teeth', pts: [[0.5, 0.5]], r: 0.01, amt: 1, whole: true, lips: [{ outer: ring(200, 150, 88, 44), inner: ring(200, 150, 62, 0.5) }] });
  assert.deepEqual(img.data, org.data);
});
