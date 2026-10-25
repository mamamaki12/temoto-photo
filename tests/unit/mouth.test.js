// 唇・歯の範囲を自動で決める（AI の口の輪郭は目印。境目は色で決める）
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrush } from '../../brushfx.js';

// 作りものの口: 肌の中に、唇（楕円の輪）と、口の中に歯（明るく色の薄い帯）と口の奥（暗い所）
const W = 400; const H = 300;
const SKIN = [205, 160, 140]; const LIP = [190, 95, 105]; const TOOTH = [215, 200, 160]; const DARK = [60, 30, 30];
const LOWER = [120, 80, 75]; const SHADED = TOOTH.map((v) => Math.round(v * 0.45)); const PALE = [200, 130, 120]; const GUM = [235, 135, 140];
// back: 口の左端の奥に、影に入った歯 / pale: 歯のすぐ上まで、日の当たった淡い上唇がかぶさっている / gum: 上の歯の上に歯ぐき
// lower: 上の歯のすぐ下に、上の歯の陰で暗く赤みがかった下の歯
function mouthImage({ open = true, back = false, pale = false, gum = false, lower = false } = {}) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x - 200) / 90; const v = (y - 150) / 45; const r = u * u + v * v;
    const ui = (x - 200) / 70; const vi = (y - 150) / 18; const ri = ui * ui + vi * vi;
    let c = SKIN;
    if (r < 1) c = LIP;
    if (open && ri < 1) c = Math.abs(y - 150) < 9 && Math.abs(x - 200) < 60 ? TOOTH : DARK;
    if (back && ri < 1 && Math.abs(y - 150) < 7 && x >= 142 && x < 156) c = SHADED;
    if (pale && ri < 1 && y < 142) c = PALE;
    if (gum && ri < 1 && y >= 134 && y < 142 && Math.abs(x - 200) < 58) c = GUM;
    if (lower && ri < 1 && y >= 159 && y < 166 && Math.abs(x - 200) < 40) c = LOWER;
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

test('歯: 口の端の影に入った奥の歯も白くし、まわりの口の奥は変えない', () => {
  const img = mouthImage({ back: true }); const org = mouthImage({ back: true });
  applyBrush(img, { type: 'teeth', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, whole: true, lips });
  for (const [x, y] of [[149, 150], [146, 147]]) assert.ok(chroma(px(img, x, y)) < chroma(px(org, x, y)) - 4, `影の歯 ${x},${y}`);
  for (const [x, y] of [[200, 163], [137, 150]]) assert.deepEqual(px(img, x, y), px(org, x, y), `口の奥 ${x},${y}`);
});

test('歯: 日の当たった淡い上唇が歯のすぐ上にかぶさっていても、上唇は白くしない', () => {
  const img = mouthImage({ pale: true }); const org = mouthImage({ pale: true });
  applyBrush(img, { type: 'teeth', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, whole: true, lips });
  assert.ok(chroma(px(img, 200, 152)) < chroma(px(org, 200, 152)) - 8, '歯');
  for (const [x, y] of [[200, 139], [170, 138], [230, 139]]) { const a = px(img, x, y); const b = px(org, x, y); for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - b[c]) <= 3, `上唇 ${x},${y}`); }
});

test('リップ: 上の歯の上に見える歯ぐきには色をのせない（唇には付く）', () => {
  const img = mouthImage({ gum: true }); const org = mouthImage({ gum: true });
  applyBrush(img, { type: 'lip', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, col: [196, 30, 48], whole: true, lips });
  for (const [x, y] of [[200, 138], [170, 139], [230, 138]]) { const a = px(img, x, y); const b = px(org, x, y); for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - b[c]) <= 3, `歯ぐき ${x},${y}`); }
  for (const [x, y] of [[200, 116], [200, 185]]) { const a = px(img, x, y); const b = px(org, x, y); assert.ok(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 15, `唇 ${x},${y}`); }
});

test('歯: 色合いはそのままで色を抜き、明るくする（ピンク・灰色にくすまない）', () => {
  const img = mouthImage(); const org = mouthImage();
  applyBrush(img, { type: 'teeth', pts: [[0.5, 0.5]], r: 0.01, amt: 1, whole: true, lips });
  const ycc = ([r, g, b]) => [0.299 * r + 0.587 * g + 0.114 * b, -0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];
  const [Y0, cb0, cr0] = ycc(px(org, 200, 150)); const [Y1, cb1, cr1] = ycc(px(img, 200, 150));
  assert.ok(Y1 > Y0 + 8, `明るくなる ${Y0} → ${Y1}`);
  assert.ok(Math.hypot(cb1, cr1) < Math.hypot(cb0, cr0) * 0.6, '色が抜ける');
  const turn = Math.abs(Math.atan2(cr1, cb1) - Math.atan2(cr0, cb0)) * 180 / Math.PI;
  assert.ok(turn < 12, `色合いが変わらない（${turn.toFixed(1)}°）`);
});

test('歯: 上の歯の陰で暗く赤みがかった下の歯も白くし、唇にはリップの色の代わりに付けない', () => {
  const img = mouthImage({ lower: true }); const org = mouthImage({ lower: true });
  applyBrush(img, { type: 'teeth', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, whole: true, lips });
  for (const [x, y] of [[200, 162], [180, 163], [222, 161]]) assert.ok(chroma(px(img, x, y)) < chroma(px(org, x, y)) - 8, `下の歯 ${x},${y}`);
  for (const [x, y] of [[200, 185], [200, 250]]) assert.deepEqual(px(img, x, y), px(org, x, y), `唇・肌 ${x},${y}`);
  const lp = mouthImage({ lower: true });
  applyBrush(lp, { type: 'lip', pts: [[0.5, 0.5]], r: 0.01, amt: 0.8, col: [196, 30, 48], whole: true, lips });
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(px(lp, 200, 162)[c] - px(org, 200, 162)[c]) <= 3, 'リップは下の歯に付かない');
});
