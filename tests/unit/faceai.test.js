// 顔専用 AI の計算（faceai.js）のテスト。AI の代わりに、決まった絵を使う。
// 仕上がりの良し悪しは、ここでは決めない（実際の写真を 100% で見て確かめる。docs/faceai-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZE, alignMatrix, applyMatrix, invertMatrix, matrixScale, cropFace, delaunay, meshWarp, transferDetail, faceMask, faceRegion, mergeFace, gauss } from '../../faceai.js';
import { FACE_PTS } from './face-fixture.js';
import { validateState } from '../../state.js';

/** 512 の RGB（並んだ形）。fn(x, y) → [r, g, b] */
function rgb(fn, size = SIZE) {
  const d = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) d.set(fn(x, y), (y * size + x) * 3);
  return d;
}
const checker = (x, y) => { const v = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 ? 200 : 60; return [v, v * 0.9, v * 0.8]; };

test('位置合わせ: 写真の中で回転・拡大した顔を、決まった位置に切り出す', () => {
  // 512 の顔の点を、写真の中で 2.3 倍・20 度回して (900, 600) に置く
  const s = 2.3; const r = (20 * Math.PI) / 180; const pts = FACE_PTS.map(([u, v]) => [900 + s * (Math.cos(r) * u - Math.sin(r) * v), 600 + s * (Math.sin(r) * u + Math.cos(r) * v)]);
  const M = alignMatrix(pts);
  // 写真の点を戻すと、元の 512 の点のまわりに来る（決まった位置への最小二乗なので、全体のずれは小さい）
  let err = 0; for (const i of [33, 263, 1, 61, 291]) { const [u, v] = applyMatrix(M, ...pts[i]); err = Math.max(err, Math.hypot(u - FACE_PTS[i][0], v - FACE_PTS[i][1])); }
  assert.ok(err < 30, `ずれ ${err}`);
  assert.ok(Math.abs(matrixScale(M) - s) / s < 0.1, `大きさ ${matrixScale(M)}`);
  // 逆の変換
  const inv = invertMatrix(M); const [x, y] = applyMatrix(inv, ...applyMatrix(M, 1000, 700));
  assert.ok(Math.hypot(x - 1000, y - 700) < 1e-6);
});

test('切り出し: 写真の画素を、変換どおりに読む', () => {
  const W = 800; const H = 600; const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; data[i] = x % 256; data[i + 1] = y % 256; data[i + 2] = 7; data[i + 3] = 255; }
  const M = [0.5, 0, -100, -50]; // u = 0.5 x − 100 → x = 2u + 200
  const c = cropFace({ width: W, height: H, data }, M);
  const at = (u, v) => c.slice((v * SIZE + u) * 3, (v * SIZE + u) * 3 + 3);
  assert.deepEqual([...at(10, 20)], [(2 * 10 + 200) % 256, (2 * 20 + 100) % 256, 7]);
});

test('三角形分け: どの点も三角形の頂点になり、三角形は重ならない（面積の和 = 全体を囲む形の面積）', () => {
  const pts = FACE_PTS.map((p) => [p[0], p[1]]);
  const t = delaunay(pts); assert.equal(t.length % 3, 0);
  const used = new Set(t); assert.ok(used.size >= pts.length - 5, `${used.size} / ${pts.length}`); // ほぼ同じ位置の点は除かれることがある
  let area = 0; for (let k = 0; k < t.length; k += 3) { const [a, b, c] = [pts[t[k]], pts[t[k + 1]], pts[t[k + 2]]]; area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2; }
  // 凸包の面積
  const hull = (() => { const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); } const up = []; for (const q of p.reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); } return lo.slice(0, -1).concat(up.slice(0, -1)); })();
  let ha = 0; for (let i = 0; i < hull.length; i++) { const a = hull[i]; const b = hull[(i + 1) % hull.length]; ha += a[0] * b[1] - b[0] * a[1]; }
  assert.ok(Math.abs(area - Math.abs(ha) / 2) / (Math.abs(ha) / 2) < 1e-3, `${area} / ${Math.abs(ha) / 2}`);
});

test('曲げ: 同じ点どうしならそのまま、ずらした点なら模様もずれる', () => {
  const ref = rgb(checker);
  const same = meshWarp(ref, FACE_PTS, FACE_PTS);
  let d = 0; for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(same[i] - ref[i]));
  assert.ok(d < 1e-3, `差 ${d}`);
  // 本人の写真の顔が 12 画素右にあるなら、重ねた絵の (x, y) は本人の写真の (x+12, y)
  const moved = meshWarp(ref, FACE_PTS.map(([x, y]) => [x + 12, y]), FACE_PTS);
  const i = (300 * SIZE + 250) * 3; const j = (300 * SIZE + 262) * 3;
  assert.ok(Math.abs(moved[i] - ref[j]) < 1e-3);
});

test('本人の写真の細かい模様を移す: 形が合う所だけ。大まかな明るさ・色はこの顔のまま', () => {
  // この顔: ぼやけた市松模様（色は赤み）、本人の写真: くっきりした同じ模様（色は青み）
  const face = gauss(rgb((x, y) => checker(x, y).map((v, c) => v * [1.1, 0.9, 0.8][c])), SIZE, SIZE, 3, 2.5);
  const ref = rgb((x, y) => checker(x, y).map((v, c) => v * [0.8, 0.9, 1.1][c]));
  const out = transferDetail(face, FACE_PTS, [{ img: ref, pts: FACE_PTS }]);
  const m = faceMask(FACE_PTS, SIZE, 0, 0);
  // 顔の中: 細かさ（となりとの差）が増え、平均の色はこの顔に近い
  let gOut = 0; let gFace = 0; let mo = [0, 0, 0]; let mf = [0, 0, 0]; let n = 0;
  for (let y = 200; y < 400; y++) for (let x = 180; x < 340; x++) {
    const i = y * SIZE + x; if (m[i] < 1) continue; n++;
    gOut += Math.abs(out[i * 3] - out[(i + 1) * 3]); gFace += Math.abs(face[i * 3] - face[(i + 1) * 3]);
    for (let c = 0; c < 3; c++) { mo[c] += out[i * 3 + c]; mf[c] += face[i * 3 + c]; }
  }
  assert.ok(gOut > gFace * 1.5, `細かさ ${gOut / n} / ${gFace / n}`);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(mo[c] - mf[c]) / n < 4, `色 ${c}: ${mo[c] / n} / ${mf[c] / n}`);
  // 形の合わない本人の写真（模様がずれている）は使わない
  const off = rgb((x, y) => checker(x + 3, y + 3));
  const out2 = transferDetail(face, FACE_PTS, [{ img: off, pts: FACE_PTS }]);
  let d = 0; for (let y = 200; y < 400; y++) for (let x = 180; x < 340; x++) { const i = (y * SIZE + x) * 3; d = Math.max(d, Math.abs(out2[i] - face[i])); }
  assert.ok(d < 20, `ずれた写真で ${d}`);
});

test('写真に戻す: 大まかな明るさは写真のまま、細かい所は AI のもの。顔の外は変えない', () => {
  const W = 700; const H = 700; const data = new Uint8ClampedArray(W * H * 4);
  // 写真: ぼやけた模様（AI がくっきりさせたものの、ぼやけた版）＋全体に明るい
  const sharp = rgb(checker);
  const M = [0.8, 0, -40, -40]; const inv = invertMatrix(M);
  const blurred = gauss(sharp, SIZE, SIZE, 3, 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [u, v] = applyMatrix(M, x, y); const uu = Math.min(SIZE - 1, Math.max(0, Math.round(u))); const vv = Math.min(SIZE - 1, Math.max(0, Math.round(v)));
    const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, blurred[(vv * SIZE + uu) * 3 + c] + 20); data[i + 3] = 255;
  }
  const before = Uint8ClampedArray.from(data);
  const mask = faceMask(FACE_PTS); const face = { M, out: sharp, mask };
  const r = faceRegion(M, W, H); assert.ok(r);
  const region = { data: new Uint8ClampedArray(r[2] * r[3] * 4), width: r[2], height: r[3] };
  for (let y = 0; y < r[3]; y++) region.data.set(data.subarray(((r[1] + y) * W + r[0]) * 4, ((r[1] + y) * W + r[0] + r[2]) * 4), y * r[2] * 4);
  mergeFace(region, r[0], r[1], face, 1);
  // 顔の真ん中: となりとの差（くっきりさ）が増え、平均は写真のまま（+20 の明るさを保つ）
  const [cx, cy] = applyMatrix(inv, 256, 300); let gA = 0; let gB = 0; let mA = 0; let mB = 0; let n = 0;
  for (let y = Math.round(cy) - 40; y < cy + 40; y++) for (let x = Math.round(cx) - 40; x < cx + 40; x++) {
    const i = ((y - r[1]) * r[2] + (x - r[0])) * 4; const j = (y * W + x) * 4;
    gA += Math.abs(region.data[i] - region.data[i + 4]); gB += Math.abs(before[j] - before[j + 4]); mA += region.data[i]; mB += before[j]; n++;
  }
  assert.ok(gA > gB * 1.3, `くっきりさ ${gA / n} / ${gB / n}`);
  assert.ok(Math.abs(mA - mB) / n < 3, `明るさ ${mA / n} / ${mB / n}`);
  // 顔の外（四角の角）は変わらない
  const i0 = 0; const j0 = (r[1] * W + r[0]) * 4;
  assert.deepEqual([...region.data.subarray(i0, i0 + 3)], [...before.subarray(j0, j0 + 3)]);
  // 強さ 0 なら何も変えない
  const region2 = { data: Uint8ClampedArray.from(region.data), width: r[2], height: r[3] }; const copy = Uint8ClampedArray.from(region2.data);
  mergeFace(region2, r[0], r[1], face, 0); assert.deepEqual(region2.data, copy);
});

test('編集内容: 顔 AI の顔は 8 つまで、値は範囲に収める', () => {
  const s = validateState({ faceai: { faces: Array.from({ length: 12 }, (_, i) => ({ x: i / 10, y: 2, on: i % 2 === 0, person: 'p'.repeat(60) })), amount: 300 } });
  assert.equal(s.faceai.faces.length, 8); assert.equal(s.faceai.amount, 100);
  assert.equal(s.faceai.faces[0].y, 1); assert.equal(s.faceai.faces[1].on, false); assert.equal(s.faceai.faces[0].person.length, 40);
  assert.deepEqual(validateState({}).faceai, { faces: [], amount: 100 });
});
