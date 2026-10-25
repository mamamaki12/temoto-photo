// 形を整える（2 版）: ずらす量を重ねて 1 回だけ読み直す。人物の地図で背景を守る
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrush, brushBounds } from '../../brushfx.js';

// 左半分は肌色の人物（細かい模様つき）、右半分は縦縞の背景（柵・柱の代わり）。境目は x=300
const W = 600; const H = 400;
function image() {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4; const stripe = Math.floor(x / 12) % 2 ? 200 : 150; const dot = (x + y) % 7 === 0 ? -40 : 0;
    d.set(x < 300 ? [225 + dot, 180 + dot, 150 + dot, 255] : [stripe, stripe, stripe + 10, 255], k);
  }
  return d;
}
const base = image();
/** 人物の地図: 左半分が人物（n×n、写真全体） */
const pm = (n = 32) => { let s = ''; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) s += String.fromCharCode(i < n / 2 ? 255 : 0); return { b: [0, 0, 1, 1], n, d: btoa(s) }; };
const run = (op, at) => { const im = { width: W, height: H, data: new Uint8ClampedArray(base) }; applyBrush(im, op, at); return im.data; };
const bgDiff = (d, x0 = 400) => { let m = 0; for (let y = 150; y < 250; y++) for (let x = x0; x < x0 + 100; x++) { const k = (y * W + x) * 4; m = Math.max(m, Math.abs(d[k] - base[k])); } return m; };
const edge = (d, y = 200) => { for (let x = 150; x < 450; x++) { const k = (y * W + x) * 4; if (d[k + 2] > d[k]) return x; } return -1; }; // 背景（青みが赤より強い）が始まる所
const push = { type: 'warp', v: 2, pts: Array.from({ length: 13 }, (_, i) => [(330 - i * 4) / W, 200 / H]), r: 90 / H, amt: 1, pm: pm() };

test('人物の地図があれば、押した所の背景（境目から半径以上離れた縞）はそのまま。人物の側は縮む（境目が左へ）', () => {
  const kept = run(push); const free = run({ ...push, pm: undefined });
  assert.ok(bgDiff(free, 320) > 40, '地図がなければ背景の縞も曲がる');
  assert.ok(bgDiff(kept, 400) < 6, `半径より外の背景は変わらない: ${bgDiff(kept, 400)}`);
  assert.ok(edge(kept) < 296 && edge(kept) > 0, `境目が左へ: ${edge(kept)}`);
});

test('人物を外へ広げる（境目を右へ押す）と、人物の画素を受け取る背景だけが動く', () => {
  const out = run({ ...push, pts: push.pts.map(([x, y]) => [(270 + (330 - x * W) * 1) / W, y]) }); // 270 → 318 へ右向き
  assert.ok(edge(out) > 304, `境目が右へ: ${edge(out)}`);
  assert.ok(bgDiff(out, 450) < 6, '離れた背景は変わらない');
});

test('何回なぞっても、人物の模様がぼけない（点の濃さが残る）。全体と一部（書き出し）で同じ結果', () => {
  const long = { ...push, pts: Array.from({ length: 60 }, (_, i) => [(200 + (i % 2 ? 3 : 0)) / W, (200 + i * 0.5) / H]) }; // 同じ所を往復
  const out = run(long);
  let minv = 255; for (let y = 180; y < 220; y++) for (let x = 170; x < 230; x++) minv = Math.min(minv, out[(y * W + x) * 4]);
  assert.ok(minv < 200, `点（暗い所）が残る: ${minv}`);
  const g = brushBounds(push, W, H); assert.ok(g && g[0] < 300 - 90 && g[0] + g[2] > 330 + 90);
  const part = { width: g[2], height: g[3], data: new Uint8ClampedArray(g[2] * g[3] * 4) };
  for (let y = 0; y < g[3]; y++) part.data.set(base.subarray(((g[1] + y) * W + g[0]) * 4, ((g[1] + y) * W + g[0] + g[2]) * 4), y * g[2] * 4);
  applyBrush(part, push, { W, H, ox: g[0], oy: g[1] });
  const whole = run(push); let md = 0;
  for (let y = 0; y < g[3]; y++) for (let x = 0; x < g[2]; x++) for (let c = 0; c < 3; c++) md = Math.max(md, Math.abs(part.data[(y * g[2] + x) * 4 + c] - whole[((g[1] + y) * W + g[0] + x) * 4 + c]));
  assert.ok(md <= 1, `全体と一部の差: ${md}`);
});
