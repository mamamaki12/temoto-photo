// 写真編集（てもとフォト）の計算部分
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, validateState, newLocal, presetPart, applyPreset, isEdited, ADJ, MAX_LOCALS } from '../../state.js';
import { geoParams, outToSrc, srcToOut, outputSize, fitCrop, dragCrop, straightenZoom, aspectValue } from '../../geometry.js';
import { monotoneSpline, curvesLut } from '../../curves.js';
import { autoAdjust, histogram } from '../../auto.js';
import { LOOKS, effective } from '../../presets.js';
import { readExif } from '../../exif.js';
import { heal, mosaic, blurRect, applyRetouch, findHealSource } from '../../retouch.js';
import { applyPortrait, skinness, skinWeights } from '../../portrait.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test('photo: 編集内容の検証（不正な値・型・件数を直す）', () => {
  const d = defaultState();
  assert.deepEqual(validateState(d), d);
  assert.deepEqual(validateState(null), d);
  assert.equal(isEdited(d), false);
  const bad = validateState({
    adj: { exposure: 999, contrast: 'x', sharpen: -50, __proto__: { polluted: 1 } },
    hsl: { red: { h: 1e9 } },
    curves: { rgb: [[0.5, 2], 'x', [0.2, -1], [0.2, 0.3]] },
    geo: { rot: 7, angle: 90, crop: { x: 0.9, y: 0, w: 0.5, h: 2 }, aspect: 'constructor' },
    locals: Array(20).fill({ type: 'brush', strokes: [{ pts: [[0.1, 0.1]] }] }),
    retouch: [{ type: 'heal', x: 0.5, y: 0.5 }, { type: 'evil' }],
    overlays: [{ type: 'text', text: 'a\u0000b', color: 'red;background:url(x)', font: '__proto__' }, { type: 'script' }],
    frame: { width: 1000, color: 'javascript:alert(1)', pad: 'x' },
  });
  assert.equal(bad.adj.exposure, 100); assert.equal(bad.adj.contrast, 0); assert.equal(bad.adj.sharpen, 0);
  assert.equal({}.polluted, undefined);
  assert.equal(bad.hsl.red.h, 100);
  assert.deepEqual(bad.curves.rgb, [[0.2, 0], [0.5, 1]]);
  assert.equal(bad.geo.rot, 0); assert.equal(bad.geo.angle, 45); assert.equal(bad.geo.aspect, 'free');
  near(bad.geo.crop.x + bad.geo.crop.w, 1, 1e-9); assert.ok(bad.geo.crop.h <= 1);
  assert.equal(bad.locals.length, 4); // ブラシは4つまで
  assert.deepEqual(bad.retouch, [{ type: 'heal', x: 0.5, y: 0.5, r: 0.02, sx: null, sy: null }]);
  assert.equal(bad.overlays.length, 1);
  assert.equal(bad.overlays[0].text, 'ab'); assert.equal(bad.overlays[0].color, '#ffffff'); assert.equal(bad.overlays[0].font, 'gothic');
  assert.equal(bad.frame.width, 30); assert.equal(bad.frame.color, '#ffffff'); assert.equal(bad.frame.pad, 'none');
  const many = validateState({ locals: Array(20).fill(0).map(() => newLocal('radial', 'x')) });
  assert.equal(many.locals.length, MAX_LOCALS);
});

test('photo: プリセットは色と明るさだけを運ぶ（切り抜きや文字は運ばない）', () => {
  const s = defaultState(); s.adj.exposure = 30; s.geo.rot = 1; s.overlays = [{ type: 'sticker', emoji: '⭐' }];
  const p = presetPart(s);
  assert.deepEqual(Object.keys(p).sort(), ['adj', 'curves', 'grade', 'hsl', 'look', 'portrait']);
  const t = applyPreset(defaultState(), JSON.parse(JSON.stringify(p)));
  assert.equal(t.adj.exposure, 30); assert.equal(t.geo.rot, 0);
});

test('photo: 幾何変換 — 何もしなければそのまま、回転・反転は正しい向き', () => {
  const g = defaultState().geo;
  const p = geoParams(g, 400, 300);
  for (const [x, y] of [[0, 0], [1, 0], [0.3, 0.7], [1, 1]]) { const [s, t] = outToSrc(x, y, p); near(s, x); near(t, y); }
  // 90°右回転: 出力の左上 = 元の左下
  const r1 = geoParams({ ...g, rot: 1 }, 400, 300);
  assert.deepEqual(outputSize({ ...g, rot: 1 }, 400, 300), { w: 300, h: 400 });
  { const [s, t] = outToSrc(0, 0, r1); near(s, 0); near(t, 1); }
  { const [s, t] = outToSrc(1, 0, r1); near(s, 0); near(t, 0); }
  { const [s, t] = outToSrc(0, 0, geoParams({ ...g, rot: 2 }, 400, 300)); near(s, 1); near(t, 1); }
  { const [s, t] = outToSrc(0, 0, geoParams({ ...g, rot: 3 }, 400, 300)); near(s, 1); near(t, 0); }
  { const [s, t] = outToSrc(0.2, 0.3, geoParams({ ...g, flipH: true }, 400, 300)); near(s, 0.8); near(t, 0.3); }
  // 切り抜き
  const c = geoParams({ ...g, crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } }, 400, 300);
  { const [s, t] = outToSrc(0, 0, c); near(s, 0.25); near(t, 0.5); }
  assert.deepEqual(outputSize({ ...g, crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } }, 400, 300), { w: 200, h: 150 });
});

test('photo: 傾き補正・遠近補正をしても、出力の四隅は元写真の内側', () => {
  const g = defaultState().geo;
  for (const angle of [-45, -10, 3, 30]) for (const persV of [-100, 0, 60]) for (const persH of [-80, 0, 100]) for (const rot of [0, 1]) {
    const p = geoParams({ ...g, angle, persV, persH, rot }, 4000, 3000);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0]]) {
      const [s, t] = outToSrc(x, y, p);
      assert.ok(s >= -1e-9 && s <= 1 + 1e-9 && t >= -1e-9 && t <= 1 + 1e-9, `angle ${angle} v${persV} h${persH} rot${rot}: (${x},${y}) → (${s},${t})`);
    }
  }
  near(straightenZoom(0, 4, 3), 1);
  assert.ok(straightenZoom(10, 4, 3) > 1);
});

test('photo: 元写真 → 出力の逆変換（ブラシや円の位置の表示に使う）', () => {
  const p = geoParams({ ...defaultState().geo, angle: 12, persV: 40, rot: 3, flipV: true, crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.7 } }, 4032, 3024);
  for (const [x, y] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.3]]) {
    const [s, t] = outToSrc(x, y, p); const [x2, y2] = srcToOut(s, t, p);
    near(x2, x, 1e-6); near(y2, y, 1e-6);
  }
});

test('photo: 切り抜きの比率合わせとドラッグ', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const sq = fitCrop(full, 1, 4000, 3000);
  near(sq.w * 4000, sq.h * 3000, 1e-6); near(sq.h, 1); near(sq.x, (1 - sq.w) / 2);
  assert.equal(aspectValue('4:5', 1, 1), 0.8); assert.equal(aspectValue('free', 1, 1), null); assert.equal(aspectValue('original', 4, 3), 4 / 3);
  // 枠の外には出ない
  const moved = dragCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 'move', 0.5, -0.9, null, 1, 1);
  near(moved.x, 0.6); near(moved.y, 0);
  // 比率を保ったまま角をドラッグ
  const r = dragCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 'br', 0.2, 0.05, 1, 1000, 1000);
  near(r.w, r.h); assert.ok(r.x + r.w <= 1 && r.y + r.h <= 1);
  const tiny = dragCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 'tl', 0.9, 0.9, null, 1, 1);
  assert.ok(tiny.w >= 0.05 - 1e-9 && tiny.h >= 0.05 - 1e-9);
});

test('photo: トーンカーブは点を通り、行き過ぎない', () => {
  const f = monotoneSpline([[0, 0], [0.25, 0.15], [0.75, 0.9], [1, 1]]);
  near(f(0.25), 0.15); near(f(0.75), 0.9); near(f(0), 0); near(f(1), 1);
  let prev = -1; for (let i = 0; i <= 100; i++) { const v = f(i / 100); assert.ok(v >= prev - 1e-12); prev = v; }
  const id = curvesLut(defaultState().curves);
  for (let i = 0; i < 256; i++) assert.equal(id[i * 4], i);
  const inv = curvesLut({ ...defaultState().curves, r: [[0, 1], [1, 0]] });
  assert.equal(inv[0], 255); assert.equal(inv[255 * 4], 0); assert.equal(inv[255 * 4 + 1], 255);
});

test('photo: 自動補正 — 暗い写真は明るく、青い写真は暖かく', () => {
  const dark = new Uint8ClampedArray(4 * 1000);
  for (let i = 0; i < 1000; i++) { dark[i * 4] = 20 + (i % 40); dark[i * 4 + 1] = 25 + (i % 40); dark[i * 4 + 2] = 60 + (i % 40); dark[i * 4 + 3] = 255; }
  const a = autoAdjust(histogram(dark));
  assert.ok(a.exposure > 20, `exposure ${a.exposure}`);
  assert.ok(a.temp > 0, `temp ${a.temp}`);
  for (const [k, , min, max] of ADJ) if (k in a) assert.ok(a[k] >= min && a[k] <= max, k);
});

test('photo: フィルターの強さ（0%なら変わらない・100%で全部効く・範囲を超えない）', () => {
  assert.ok(LOOKS.length >= 20);
  const s = defaultState(); s.adj.saturation = -50; s.look = { id: 'mono', amount: 100 };
  assert.equal(effective(s).adj.saturation, -100);
  s.look.amount = 0; assert.equal(effective(s).adj.saturation, -50);
  s.look = { id: 'film-cine', amount: 50 };
  const e = effective(s);
  assert.equal(e.grade.shadows.s, 15); assert.equal(e.grade.shadows.h, 190);
  s.look = { id: 'no-such', amount: 100 }; assert.deepEqual(effective(s).adj, s.adj);
});

/** テスト用の小さな JPEG（Exif に位置情報入り）を組み立てる */
function jpegWithExif({ gps = true, le = false } = {}) {
  const b = []; const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]); const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const tiff = [];
  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  // IFD0: Make, Orientation, GPS IFD pointer
  const ifd0 = 8; const entries = gps ? 3 : 2; const ifd0End = ifd0 + 2 + entries * 12 + 4;
  const makeOff = ifd0End; const make = [...Buffer.from('TestCam\0')];
  const gpsOff = makeOff + make.length;
  tiff.push(...u16(entries));
  tiff.push(...u16(0x010f), ...u16(2), ...u32(make.length), ...u32(makeOff));
  tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(6), 0, 0);
  if (gps) tiff.push(...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsOff));
  tiff.push(...u32(0), ...make);
  if (gps) {
    const n = 4; const dataOff = gpsOff + 2 + n * 12 + 4;
    tiff.push(...u16(n));
    tiff.push(...u16(1), ...u16(2), ...u32(2), 78, 0, 0, 0); // N
    tiff.push(...u16(2), ...u16(5), ...u32(3), ...u32(dataOff));
    tiff.push(...u16(3), ...u16(2), ...u32(2), 69, 0, 0, 0); // E
    tiff.push(...u16(4), ...u16(5), ...u32(3), ...u32(dataOff + 24));
    tiff.push(...u32(0));
    for (const [a, c] of [[35, 1], [40, 1], [5292, 100], [139, 1], [46, 1], [324, 10]]) tiff.push(...u32(a), ...u32(c));
  }
  const app1 = [...Buffer.from('Exif\0\0'), ...tiff];
  b.push(0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9);
  return new Uint8Array(b).buffer;
}

test('photo: Exif の位置情報・向き・カメラを読む（壊れたデータでも落ちない）', () => {
  for (const le of [false, true]) {
    const e = readExif(jpegWithExif({ le }));
    assert.equal(e.make, 'TestCam'); assert.equal(e.orientation, 6);
    near(e.gps.lat, 35 + 40 / 60 + 52.92 / 3600, 1e-6); near(e.gps.lon, 139 + 46 / 60 + 32.4 / 3600, 1e-6);
  }
  assert.equal(readExif(jpegWithExif({ gps: false })).gps, null);
  assert.equal(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(readExif(new ArrayBuffer(0)), null);
  // ランダムに壊しても例外を出さない
  const good = new Uint8Array(jpegWithExif());
  for (let i = 0; i < 300; i++) {
    const bad = good.slice(); for (let k = 0; k < 6; k++) bad[12 + Math.floor(Math.random() * (bad.length - 12))] = Math.floor(Math.random() * 256);
    readExif(bad.buffer);
  }
  // 自分を指すIFD（無限ループ）でも止まる
  const loop = good.slice(); loop[loop.length - 1] = 0xd9; readExif(loop.buffer);
});

function img(w, h, fn) { const data = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const k = (y * w + x) * 4; data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 255; } return { width: w, height: h, data }; }

test('photo: スポット修復で、まわりと違う点が消える', () => {
  const im = img(80, 80, (x, y) => ((x - 40) ** 2 + (y - 40) ** 2 < 16 ? [0, 0, 0] : [200, 180 + (x % 3), 160]));
  heal(im, 40, 40, 6);
  const k = (40 * 80 + 40) * 4;
  assert.ok(im.data[k] > 150, `中心が明るくなる: ${im.data[k]}`);
  const [sx, sy] = findHealSource(im, 40, 40, 6);
  assert.ok(Math.hypot(sx - 40, sy - 40) >= 12);
  // 画像の端でも落ちない
  heal(im, 1, 1, 6); heal(im, 79, 79, 30);
});

test('photo: モザイク・ぼかし・操作の再現', () => {
  const im = img(40, 40, (x) => [x * 6, 0, 0]);
  mosaic(im, 0, 0, 20, 20, 10);
  assert.equal(im.data[0], im.data[9 * 4]); assert.notEqual(im.data[0], im.data[10 * 4]);
  const im2 = img(40, 40, (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255]));
  blurRect(im2, 0, 0, 40, 40, 3);
  const mid = im2.data[(10 * 40 + 20) * 4]; assert.ok(mid > 30 && mid < 225, `境目がなめらか: ${mid}`);
  blurRect(im2, -10, -10, 5, 5, 3); mosaic(im2, 50, 50, 10, 10, 4); // 範囲外でも落ちない
  const ops = [{ type: 'heal', x: 0.5, y: 0.5, r: 0.05, sx: null, sy: null }, { type: 'mosaic', x: 0, y: 0, w: 0.2, h: 0.2, size: 20 }];
  applyRetouch(img(50, 50, () => [100, 100, 100]), ops);
  assert.ok(ops[0].sx != null, '自動で選んだコピー元を記録する');
});

// 肌（ノイズとシミ入り）・眉（暗い線）・青い背景の画像
function facePhoto(W = 300, H = 240) {
  const data = new Uint8ClampedArray(W * H * 4); let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4; let c;
    if (x >= 200) c = [60, 110, 200]; // 背景
    else if (y >= 40 && y < 46 && x > 40 && x < 160) c = [50, 35, 30]; // 眉
    else { const n = (rnd() - 0.5) * 30; const spot = Math.hypot(x - 100, y - 140) < 4 ? [-4, -24, -20] : [0, 0, 0]; /* 赤いシミ */ c = [225 + n + spot[0], 180 + n + spot[1], 155 + n + spot[2]]; }
    data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
  }
  return { width: W, height: H, data };
}
const regionStat = (img, x0, y0, x1, y1, ch = 0) => { let s = 0; let s2 = 0; let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = img.data[(y * img.width + x) * 4 + ch]; s += v; s2 += v * v; n++; } return { mean: s / n, sd: Math.sqrt(s2 / n - (s / n) ** 2) }; };

test('photo: 美肌 — 肌の色だけを判定する', () => {
  assert.ok(skinness(225, 180, 155) > 0.9); // 明るい肌
  assert.ok(skinness(170, 120, 95) > 0.5); // 影の肌
  assert.equal(skinness(60, 110, 200), 0); // 青空
  assert.equal(skinness(128, 128, 128), 0); // 灰色
  assert.equal(skinness(200, 20, 40), 0); // 真っ赤な振袖
  assert.equal(skinness(20, 15, 12), 0); // 黒髪
});

test('photo: 美肌 — 肌のムラ・シミは整い、眉と背景はそのまま', () => {
  const img = facePhoto(); const before = facePhoto();
  applyPortrait(img, { smooth: 0, even: 0, bright: 0 });
  assert.deepEqual(img.data, before.data); // 0 なら何もしない
  applyPortrait(img, { smooth: 80, even: 60, bright: 20 });
  // シミ（緑が暗い円）がまわりに近づく
  const spot0 = regionStat(before, 98, 138, 102, 142, 1).mean; const spot1 = regionStat(img, 98, 138, 102, 142, 1).mean; const skinG = regionStat(before, 20, 80, 60, 120, 1).mean;
  assert.ok(Math.abs(skinG - spot1) < Math.abs(skinG - spot0) * 0.6, `シミ ${spot0} → ${spot1}（肌 ${skinG}）`);
  // きめ（細かいノイズ）は残るが、少し穏やかになる
  const sd0 = regionStat(before, 20, 80, 60, 120).sd; const sd1 = regionStat(img, 20, 80, 60, 120).sd;
  assert.ok(sd1 < sd0 && sd1 > sd0 * 0.2, `きめ ${sd0} → ${sd1}`);
  // 肌は明るく
  assert.ok(regionStat(img, 20, 80, 60, 120).mean > regionStat(before, 20, 80, 60, 120).mean + 2);
  // 眉は暗いまま、背景は変わらない
  assert.ok(regionStat(img, 60, 41, 140, 45).mean < 70);
  assert.deepEqual(regionStat(img, 220, 0, 300, 240), regionStat(before, 220, 0, 300, 240));
});

test('photo: 美肌の値の検証・プリントの比率', () => {
  const v = validateState({ portrait: { smooth: 500, even: 'x', bright: -3 } });
  assert.deepEqual(v.portrait, { smooth: 100, even: 0, bright: 0, tol: 50, seeds: [] });
  assert.deepEqual(defaultState().portrait, { smooth: 0, even: 0, bright: 0, tol: 50, seeds: [] });
  assert.deepEqual(validateState({ portrait: { seeds: [[0.5, 2], 'x', [-1, 0.3]], tol: 'a' } }).portrait.seeds, [[0.5, 1], [0, 0.3]]);
  assert.equal(validateState({ portrait: { seeds: Array(50).fill([0.5, 0.5]) } }).portrait.seeds.length, 12);
  // 肌の場所は写真ごとのものなので、プリセットでは運ばない（当てる側の場所を残す）
  const withSeeds = defaultState(); withSeeds.portrait.seeds = [[0.3, 0.4]]; withSeeds.portrait.smooth = 60;
  assert.equal(presetPart(withSeeds).portrait.seeds, undefined);
  const target = defaultState(); target.portrait.seeds = [[0.7, 0.7]];
  const applied = applyPreset(target, presetPart(withSeeds));
  assert.deepEqual(applied.portrait.seeds, [[0.7, 0.7]]); assert.equal(applied.portrait.smooth, 60);
  // 美肌を含まない古いプリセットを当てても、今の美肌は消えない
  const s = defaultState(); s.portrait.smooth = 40;
  assert.equal(applyPreset(s, { adj: { exposure: 10 } }).portrait.smooth, 40);
  assert.equal(applyPreset(s, presetPart(defaultState())).portrait.smooth, 0);
  // L判は 89×127mm。縦の写真なら縦長、横の写真なら横長
  near(aspectValue('print-L', 3000, 4000), 89 / 127); near(aspectValue('print-L', 4000, 3000), 127 / 89);
  near(aspectValue('print-A4', 2000, 3000), 210 / 297);
  assert.equal(validateState({ geo: { aspect: 'print-2L' } }).geo.aspect, 'print-2L');
  assert.ok(LOOKS.filter((l) => l.group === 'studio').length >= 5);
});

// ベージュの壁（肌に近い色）の前の、髪に囲まれた顔
function wallPhoto(W = 320, H = 240, hair = true) {
  const data = new Uint8ClampedArray(W * H * 4); let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4; const n = (rnd() - 0.5) * 16; const r = Math.hypot(x - 110, y - 120);
    let c = [222 + n, 196 + n, 166 + n]; // ベージュの壁
    if (r < 60) c = [228 + n, 182 + n, 158 + n]; // 顔
    else if (r < 75 && hair) c = [35 + n, 25 + n, 22 + n]; // 髪
    data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
  }
  return { width: W, height: H, data };
}
const meanW = (w, W, x0, y0, x1, y1) => { let s = 0; let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += w[y * W + x]; n++; } return s / n; };

test('photo: 美肌 — 肌をタップすると、肌に似た色の背景を外せる', () => {
  const img = wallPhoto();
  // タップなし（色だけで判定）だと、壁も肌になってしまう
  const auto = skinWeights(img, { seeds: [] });
  assert.ok(meanW(auto, 320, 240, 20, 310, 220) > 0.5, '色だけだと壁も肌');
  // 顔をタップすると、顔だけが肌になる
  const w = skinWeights(img, { seeds: [[110 / 319, 120 / 239]], tol: 50 });
  assert.ok(meanW(w, 320, 90, 100, 130, 140) > 0.9, '顔は肌');
  assert.ok(meanW(w, 320, 240, 20, 310, 220) < 0.02, '壁は肌ではない');
  assert.ok(meanW(w, 320, 0, 0, 30, 30) < 0.02, '左上の壁も');
  // 美肌を当てても、壁の画素は変わらない
  const before = wallPhoto(); const out = wallPhoto();
  applyPortrait(out, { smooth: 80, even: 60, bright: 30, seeds: [[110 / 319, 120 / 239]], tol: 50 });
  assert.deepEqual(regionStat(out, 240, 20, 310, 220), regionStat(before, 240, 20, 310, 220));
  assert.ok(regionStat(out, 90, 100, 130, 140).mean > regionStat(before, 90, 100, 130, 140).mean + 2);
  // 壁をタップすると、壁のほうが選ばれる（タップした色が基準）
  const ww = skinWeights(img, { seeds: [[0.9, 0.5]], tol: 50 });
  assert.ok(meanW(ww, 320, 240, 20, 310, 220) > 0.8);
  // 髪がなく、顔が壁にじかに接していても、くっきりした境目は越えない
  const bare = wallPhoto(320, 240, false);
  const wb = skinWeights(bare, { seeds: [[110 / 319, 120 / 239]], tol: 50 });
  assert.ok(meanW(wb, 320, 90, 100, 130, 140) > 0.9, '顔は肌');
  assert.ok(meanW(wb, 320, 240, 20, 310, 220) < 0.05, `壁は肌ではない ${meanW(wb, 320, 240, 20, 310, 220)}`);
});

test('photo: 美肌 — 赤みは整えるが、口紅のようにはっきり赤い所は残す', () => {
  const W = 200; const H = 160; const mk = () => {
    const data = new Uint8ClampedArray(W * H * 4); let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4; const n = (rnd() - 0.5) * 6; let c = [226 + n, 184 + n, 160 + n]; // 肌
      const a = Math.max(0, 1 - Math.hypot(x - 55, y - 75) / 18); c = [c[0] + 8 * a, c[1] - 14 * a, c[2] - 8 * a]; // 少し赤い（ニキビ跡など。ふちはぼやけている）
      if (x >= 120 && x < 160 && y >= 70 && y < 85) c = [200 + n, 40 + n, 60 + n]; // 口紅
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
    }
    return { width: W, height: H, data };
  };
  const before = mk(); const img = mk();
  applyPortrait(img, { smooth: 0, even: 100, bright: 0, seeds: [[0.1, 0.2]], tol: 50 });
  const cr = (im, x0, y0, x1, y1) => { let s = 0; let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 4; s += 0.5 * im.data[k] - 0.418688 * im.data[k + 1] - 0.081312 * im.data[k + 2]; n++; } return s / n; };
  assert.ok(cr(img, 50, 70, 60, 80) < cr(before, 50, 70, 60, 80) - 3, '赤みは減る');
  assert.ok(Math.abs(cr(img, 125, 73, 155, 82) - cr(before, 125, 73, 155, 82)) < 2, '口紅はそのまま');
});
