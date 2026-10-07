// RAW の読み込み（DNG の現像・プレビュー JPEG の取り出し・可逆JPEG）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRaw, demosaic, cameraToSrgb, findPreviews, parseTiff, isRawName } from '../../raw.js';
import { decodeLosslessJpeg } from '../../ljpeg.js';
import { readTiffExif } from '../../exif.js';
import { makeDng, encodeLosslessJpeg, XYZ_TO_SRGB, fakeJpeg, makePreviewRaw, makeContainerRaw } from './raw-fixtures.js';

// 4つの色の面（左上: 赤みのグレー、右上: 青、左下: 緑、右下: 中間グレー）。明るすぎない色（トーンの肩にかからない）
const PATCH = [[180, 120, 100], [60, 90, 170], [70, 150, 80], [128, 128, 128]];
const scene = (w, h) => (x, y) => PATCH[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
const pixel = (r, x, y) => { const i = (y * r.width + x) * 4; return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]; };
const near = (a, b, tol, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${msg}: ${a} ≈ ${b}`));
const centers = (w, h) => [[w / 4, h / 4], [3 * w / 4, h / 4], [w / 4, 3 * h / 4], [3 * w / 4, 3 * h / 4]].map(([x, y]) => [Math.floor(x), Math.floor(y)]);

test('raw: 拡張子の判定', () => {
  for (const n of ['a.DNG', 'b.cr3', 'c.NEF', 'd.arw', 'e.raf', 'f.orf', 'g.rw2', 'h.tif']) assert.ok(isRawName(n), n);
  for (const n of ['a.jpg', 'b.png', 'dng', 'x.dng.jpg']) assert.ok(!isRawName(n), n);
});

test('raw: 非圧縮 DNG を現像すると、元の色に戻る（デモザイク・トーン）', () => {
  const w = 64; const h = 48;
  const r = decodeRaw(makeDng({ w, h, scene: scene(w, h) }).buffer, { name: 'x.dng' });
  assert.equal(r.kind, 'raw'); assert.equal(r.width, w); assert.equal(r.height, h); assert.equal(r.format, 'DNG');
  centers(w, h).forEach(([x, y], i) => near(pixel(r, x, y), PATCH[i], 3, `patch ${i}`));
});

test('raw: 可逆JPEG圧縮・タイル分割の DNG も同じ結果になる', () => {
  const w = 64; const h = 48;
  const a = decodeRaw(makeDng({ w, h, scene: scene(w, h) }).buffer, { name: 'a.dng' });
  const b = decodeRaw(makeDng({ w, h, scene: scene(w, h), compression: 7 }).buffer, { name: 'b.dng' });
  const c = decodeRaw(makeDng({ w, h, scene: scene(w, h), compression: 7, tiles: 16 }).buffer, { name: 'c.dng' });
  assert.deepEqual([...b.rgba], [...a.rgba]);
  assert.deepEqual([...c.rgba], [...a.rgba]);
});

test('raw: ホワイトバランス（AsShotNeutral）・黒/白レベル・色変換行列・露出補正', () => {
  const w = 64; const h = 48;
  const r = decodeRaw(makeDng({ w, h, scene: scene(w, h), neutral: [0.45, 1, 0.7], black: 1024, white: 15000, colorMatrix: XYZ_TO_SRGB, baselineExposure: 0.5 }).buffer, { name: 'x.dng' });
  centers(w, h).forEach(([x, y], i) => near(pixel(r, x, y), PATCH[i], 4, `patch ${i}`));
});

test('raw: ベイヤー配列の並びが違っても（BGGR・GRBG）正しい色', () => {
  const w = 64; const h = 48;
  for (const pattern of [[2, 1, 1, 0], [1, 0, 2, 1], [1, 2, 0, 1]]) {
    const r = decodeRaw(makeDng({ w, h, scene: scene(w, h), pattern }).buffer, { name: 'x.dng' });
    centers(w, h).forEach(([x, y], i) => near(pixel(r, x, y), PATCH[i], 3, `pattern ${pattern} patch ${i}`));
  }
});

test('raw: 向き（Orientation=6）を反映する', () => {
  const w = 64; const h = 48;
  const r = decodeRaw(makeDng({ w, h, scene: scene(w, h), orientation: 6 }).buffer, { name: 'x.dng' });
  assert.equal(r.width, h); assert.equal(r.height, w);
  // 時計回りに90°: 元の左上（赤みのグレー）は右上に来る
  near(pixel(r, r.width - 6, 6), PATCH[0], 3, '右上'); near(pixel(r, 6, 6), PATCH[2], 3, '左上');
});

test('raw: 大きすぎる RAW は 2×2 をまとめて半分の大きさで現像する', () => {
  const w = 64; const h = 48;
  const r = decodeRaw(makeDng({ w, h, scene: scene(w, h) }).buffer, { name: 'x.dng', maxPixels: 1000 });
  assert.equal(r.width, 32); assert.equal(r.height, 24); assert.equal(r.scaled, true);
  centers(32, 24).forEach(([x, y], i) => near(pixel(r, x, y), PATCH[i], 3, `patch ${i}`));
});

test('raw: デモザイクは なめらかな模様をほぼ再現する', () => {
  const W = 40; const H = 40; const pat = [0, 1, 1, 2];
  const f = (x, y, c) => 0.3 + 0.2 * Math.sin((x + c * 3) / 6) * Math.cos(y / 7);
  const m = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = f(x, y, pat[(y & 1) * 2 + (x & 1)]);
  const out = demosaic(m, W, H, pat);
  let err = 0; let n = 0;
  for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) for (let c = 0; c < 3; c++) { err += Math.abs(out[(y * W + x) * 3 + c] - f(x, y, c)); n++; }
  assert.ok(err / n < 0.01, `平均誤差 ${err / n}`);
});

test('raw: ColorMatrix が XYZ→sRGB なら、カメラの色＝sRGB（単位行列）', () => {
  const M = cameraToSrgb(XYZ_TO_SRGB);
  M.forEach((row, i) => row.forEach((v, j) => assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-3, `${i},${j}: ${v}`)));
  assert.deepEqual(cameraToSrgb(null), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test('ljpeg: 符号化 → 復号で元に戻る（成分1〜3、精度12〜16bit）', () => {
  for (const [comps, prec] of [[1, 16], [2, 14], [3, 12]]) {
    const w = 23; const h = 11; const s = new Uint16Array(w * h * comps);
    for (let i = 0; i < s.length; i++) s[i] = (i * 2654435761) % (1 << prec);
    const j = decodeLosslessJpeg(encodeLosslessJpeg(s, w, h, comps, prec));
    assert.equal(j.width, w); assert.equal(j.comps, comps);
    assert.deepEqual([...j.data], [...s]);
  }
  assert.throws(() => decodeLosslessJpeg(new Uint8Array([1, 2, 3])));
  assert.throws(() => decodeLosslessJpeg(fakeJpeg(10, 10))); // 普通の JPEG は可逆JPEGではない
});

test('raw: NEF/ARW/CR2 のような RAW は、中の一番大きい JPEG を取り出す（向きも）', () => {
  const big = fakeJpeg(6000, 4000, 0xc0, 500); const thumb = fakeJpeg(160, 120, 0xc0, 50);
  const buf = makePreviewRaw(big, { orientation: 8, thumb });
  const r = decodeRaw(buf.buffer, { name: 'x.NEF' });
  assert.equal(r.kind, 'preview'); assert.equal(r.format, 'Nikon NEF'); assert.equal(r.orientation, 8);
  assert.equal(r.previews[0].w, 6000); assert.equal(r.previews[0].h, 4000);
  assert.deepEqual([...buf.subarray(r.previews[0].offset, r.previews[0].offset + r.previews[0].length)], [...big]);
  assert.equal(readTiffExif(buf.buffer).make, 'NIKON CORPORATION');
});

test('raw: CR3/RAF のような独自形式でも、埋め込み JPEG を探す（可逆JPEGは除く）', () => {
  const big = fakeJpeg(4000, 3000, 0xc2, 300); const small = fakeJpeg(320, 240); const lossless = fakeJpeg(8000, 6000, 0xc3);
  const r = decodeRaw(makeContainerRaw([small, lossless, big]).buffer, { name: 'x.cr3' });
  assert.equal(r.kind, 'preview'); assert.equal(r.format, 'Canon CR3');
  assert.deepEqual(r.previews.map((p) => [p.w, p.h]), [[4000, 3000], [320, 240]]);
  assert.throws(() => decodeRaw(new Uint8Array(1000).buffer, { name: 'x.cr3' }), /no image/);
});

test('raw: 壊れたファイルでも、すぐに止まって例外を出す（固まらない）', () => {
  const good = makeDng({ w: 32, h: 24, scene: scene(32, 24), compression: 7 });
  const t0 = Date.now();
  for (let k = 0; k < 150; k++) {
    const bad = good.slice();
    for (let i = 0; i < 8; i++) bad[Math.floor(Math.random() * bad.length)] = Math.floor(Math.random() * 256);
    try { decodeRaw(bad.buffer, { name: 'x.dng' }); } catch (e) { assert.ok(e instanceof Error); }
  }
  assert.ok(Date.now() - t0 < 20000);
  // 巨大な大きさを名乗るファイル
  const t = parseTiff(good);
  assert.ok(t.ifds.length >= 1);
  assert.equal(findPreviews(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 2]), null).length, 0);
});
