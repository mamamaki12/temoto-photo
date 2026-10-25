// 暗所補正（restoration-lowlight.js）の仕組みのテスト。
// 仕上がりの良し悪しは、ここでは決めない（実際の写真を 100% で見て確かめる。docs/lowlight-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureNoise, planTone, enhanceBand, boxBlur, addGrain, BAND_MARGIN } from '../../restoration-lowlight.js';

function randomNormal(seed = 521) {
  const uniform = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}
/** 8bit の RGBA。fn(x, y) は [r, g, b]（0〜255、小数可） */
function rgba(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); d.set([v[0], v[1], v[2], 255], (y * w + x) * 4); }
  return d;
}
const whole = (data, w, h, o) => enhanceBand({ width: w, height: h, data }, { top: 0, bottom: h, y0: 0, fullW: w, fullH: h }, o);
const binAt = (y) => Math.floor(y * 12 * 1.6);

test('lowlight: ノイズの量を、細かい粒でも大きな粒（高感度のにじんだ粒）でも同じように測る', () => {
  const w = 256; const h = 256; const rand = randomNormal();
  // 細かい粒: 画素ごとに独立。標準偏差 4/255
  const fine = rgba(w, h, () => { const v = 50 + 4 * rand(); return [v, v, v]; });
  // 大きな粒: 独立なノイズを 3×3 で平均して、同じ標準偏差 4/255 に戻したもの（2〜3 画素の粒）
  const raw = new Float32Array(w * h).map(() => rand());
  const blurred = boxBlur(raw, w, h, 1); const k = 4 * 3; // 3×3 の平均で標準偏差は 1/3
  const coarse = rgba(w, h, (x, y) => { const v = 50 + k * blurred[y * w + x]; return [v, v, v]; });
  for (const [name, img] of [['細かい粒', fine], ['大きな粒', coarse]]) {
    const s = measureNoise(img, w, h)[0][binAt(50 / 255)] * 255;
    assert.ok(Math.abs(s - 4) < 0.8, `${name}: ${s.toFixed(2)}（正しくは 4）`);
  }
});

test('lowlight: 帯に分けて処理しても、写真全体を一度に処理したのと同じ（継ぎ目が出ない）', () => {
  const w = 160; const h = 300; const rand = randomNormal(7);
  const data = rgba(w, h, (x, y) => [30 + 25 * Math.sin(x / 9) + 6 * rand(), 20 + (y % 40 < 20 ? 15 : 0) + 6 * rand(), 12 + 6 * rand()]);
  const profile = measureNoise(data, w, h);
  const small = { width: 80, height: 150, data: rgba(80, 150, (x, y) => [data[(y * 2 * w + x * 2) * 4], data[(y * 2 * w + x * 2) * 4 + 1], data[(y * 2 * w + x * 2) * 4 + 2]]) };
  const o = { nr: 1, profile, tone: planTone(small, 50) };
  const all = whole(data, w, h, o);
  const ROWS = 64;
  for (let y = 0; y < h; y += ROWS) {
    const end = Math.min(h, y + ROWS); const top = Math.max(0, y - BAND_MARGIN); const bottom = Math.min(h, end + BAND_MARGIN);
    const part = enhanceBand({ width: w, height: bottom - top, data: data.slice(top * w * 4, bottom * w * 4) },
      { top: y - top, bottom: end - top, y0: top, fullW: w, fullH: h }, o);
    assert.deepEqual(part, all.subarray(y * w * 4, end * w * 4), `${y} 行目からの帯`);
  }
});

test('lowlight: ノイズを先に取ってから明るくする。平らな所のざらつきが減り、境目は残る', () => {
  const w = 128; const h = 128; const rand = randomNormal(11);
  const clean = (x) => (x < 64 ? [24, 18, 14] : [60, 40, 26]);
  const data = rgba(w, h, (x) => clean(x).map((v) => v + 5 * rand()));
  const profile = measureNoise(data, w, h);
  const small = { width: 64, height: 64, data: rgba(64, 64, (x) => clean(x * 2)) };
  const tone = planTone(small, 50);
  const plain = whole(data, w, h, { nr: 0, profile: null, tone });
  const cleaned = whole(data, w, h, { nr: 1, profile, tone });
  const spread = (img, x0, x1) => {
    let s = 0; let s2 = 0; let n = 0;
    for (let y = 8; y < h - 8; y++) for (let x = x0; x < x1; x++) { const v = img[(y * w + x) * 4 + 1]; s += v; s2 += v * v; n++; }
    return Math.sqrt(s2 / n - (s / n) ** 2);
  };
  assert.ok(spread(cleaned, 8, 56) < spread(plain, 8, 56) * 0.6, `暗い側 ${spread(cleaned, 8, 56)} / ${spread(plain, 8, 56)}`);
  assert.ok(spread(cleaned, 72, 120) < spread(plain, 72, 120) * 0.6, '明るい側');
  // 明るくなっていて、境目（左右の差）は残る
  const mean = (img, x0, x1) => { let s = 0; let n = 0; for (let y = 8; y < h - 8; y++) for (let x = x0; x < x1; x++) { s += img[(y * w + x) * 4 + 1]; n++; } return s / n; };
  assert.ok(mean(cleaned, 8, 56) > 18 + 30, `明るさ ${mean(cleaned, 8, 56)}`);
  assert.ok(mean(cleaned, 66, 72) - mean(cleaned, 56, 62) > 20, '境目');
});

test('lowlight: ノイズ除去なし・明るさなしなら、元のまま（1 階調以内）', () => {
  const w = 40; const h = 30;
  const data = rgba(w, h, (x, y) => [x * 6, y * 8, (x + y) * 3]);
  const out = whole(data, w, h, { nr: 0, profile: null, tone: null });
  for (let i = 0; i < data.length; i++) assert.ok(Math.abs(out[i] - data[i]) <= 1, `${i}: ${out[i]} / ${data[i]}`);
});

test('lowlight: 明るくしても白は飛ばさず、色の順番（赤 > 緑 > 青）を保つ', () => {
  const w = 64; const h = 64;
  const data = rgba(w, h, (x) => (x < 48 ? [40, 26, 16] : [250, 246, 238]));
  const tone = planTone({ width: w, height: h, data }, 50);
  const out = whole(data, w, h, { nr: 0, profile: null, tone });
  const px = (x) => [...out.subarray((32 * w + x) * 4, (32 * w + x) * 4 + 3)];
  const dark = px(10); const white = px(60);
  assert.ok(dark[0] > 40 + 30, `暗い所が明るくなる ${dark}`);
  assert.ok(dark[0] > dark[1] && dark[1] > dark[2], `色の順番 ${dark}`);
  assert.ok(white.every((v) => v < 255) || white[2] < 255, `白に階調が残る ${white}`);
  assert.ok(tone.gain > 1 && tone.gain <= 16);
});

test('lowlight: ノイズを取ったあとに残る小さな点は消し、細い線と光の点は残す', () => {
  const w = 160; const h = 160; const rand = randomNormal(11);
  const raw = new Float32Array(w * h).map(() => rand());
  const grain = boxBlur(raw, w, h, 1); // JPEG でにじんだような 2〜3 画素の粒。標準偏差 3/255
  const extra = (x, y) => {
    if (Math.abs(x - 40) <= 1 && Math.abs(y - 40) <= 1) return x === 40 || y === 40 ? 14 : 8; // 3×3 の点（ノイズの約 4 倍）
    if (x === 100 && y >= 20 && y < 140) return 12; // 1 画素の細い線（髪・糸）
    const r = Math.hypot(x - 70, y - 120); if (r < 3.5) return 90 * Math.exp(-r * r / 4); // 光の点（ティアラ・目の光）。中心はノイズの 30 倍
    return 0;
  };
  const data = rgba(w, h, (x, y) => { const v = 60 + 9 * grain[y * w + x] + extra(x, y); return [v, v, v]; });
  const profile = measureNoise(data, w, h);
  const out = whole(data, w, h, { nr: 1, profile, tone: null });
  const Y = (x, y) => out[(y * w + x) * 4 + 1];
  const around = (x, y) => { const v = []; for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) >= 4) v.push(Y(x + dx, y + dy)); v.sort((a, b) => a - b); return v[v.length >> 1]; };
  let line = 0; for (let y = 30; y < 130; y++) line += Y(100, y) - (Y(96, y) + Y(104, y)) / 2;
  assert.ok(Y(40, 40) - around(40, 40) < 4, `点が残っている: ${Y(40, 40)} / まわり ${around(40, 40)}`);
  assert.ok(line / 100 > 6, `細い線が薄くなった: ${(line / 100).toFixed(1)}`);
  assert.ok(Y(70, 120) - around(70, 120) > 60, `光の点が消えた: ${Y(70, 120)}`);
});

test('lowlight: ぼやけた輪郭は元の写真よりくっきりさせ、輪郭の外に縁（はみ出し）はほとんど作らない', () => {
  const w = 160; const h = 96; const rand = randomNormal(5);
  // 縦の輪郭（暗 50 → 明 110）を、ぶれたように 6 画素ほどの幅でなだらかにしたもの。ノイズ 3/255
  const edge = (x) => 50 + 60 / (1 + Math.exp(-(x - 80) / 1.6));
  const data = rgba(w, h, (x) => { const v = edge(x) + 3 * rand(); return [v, v, v]; });
  const profile = measureNoise(data, w, h);
  const out = whole(data, w, h, { nr: 1, profile, tone: null, grain: false });
  const col = (img, x) => { let s = 0; for (let y = 16; y < h - 16; y++) s += img[(y * w + x) * 4 + 1]; return s / (h - 32); };
  const steep = (img) => Math.max(...[77, 78, 79, 80, 81, 82].map((x) => col(img, x + 1) - col(img, x)));
  assert.ok(steep(out) > steep(data) * 1.15, `くっきりしていない: ${steep(out).toFixed(1)} / 元 ${steep(data).toFixed(1)}`);
  assert.ok(col(out, 60) > 50 - 4 && col(out, 100) < 110 + 4, `縁が出た: ${col(out, 60).toFixed(1)} ${col(out, 100).toFixed(1)}`);
});

test('lowlight: ノイズより小さな段差（塗り絵のような面の継ぎ目）はならし、はっきりした境目は残す', () => {
  const w = 160; const h = 96; const rand = randomNormal(9);
  // 左半分に 2 階調の小さな段（ノイズ 4/255 の半分）、右半分に 40 階調の境目
  const data = rgba(w, h, (x, y) => { const v = (x < 80 ? 70 + (y < 48 ? 0 : 2) : y < 48 ? 70 : 110) + 4 * rand(); return [v, v, v]; });
  const profile = measureNoise(data, w, h);
  const out = whole(data, w, h, { nr: 1, profile, tone: null, grain: false });
  const at = (x, y) => out[(y * w + x) * 4 + 1];
  const jump = (x0, x1) => { let s = 0; for (let x = x0; x < x1; x++) s += at(x, 48) - at(x, 47); return s / (x1 - x0); };
  assert.ok(jump(20, 60) < 1.2, `小さな段がそのまま: ${jump(20, 60).toFixed(2)}`);
  assert.ok(jump(100, 140) > 25, `境目がぼやけた: ${jump(100, 140).toFixed(1)}`);
});

test('lowlight: 足す粒は位置で決まり、となりの画素と少しつながっている（1 画素ずつばらばらのざらつきにしない）', () => {
  const w = 256; const h = 64; const mk = () => new Uint8ClampedArray(w * h * 4).fill(128);
  const a = addGrain(mk(), w, h, { y0: 0, fullW: w }, 1.5);
  const b = mk(); addGrain(b.subarray(0, w * 20 * 4), w, 20, { y0: 0, fullW: w }, 1.5); addGrain(b.subarray(w * 20 * 4), w, h - 20, { y0: 20, fullW: w }, 1.5);
  assert.deepEqual(a, b);
  let s = 0; let s2 = 0; let c = 0; let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = (y * w + x) * 4; const v = a[i] - 128; s += v; s2 += v * v; c += v * (a[i + 4] - 128); n++; }
  const sd = Math.sqrt(s2 / n - (s / n) ** 2); const corr = c / n / (sd * sd);
  assert.ok(sd > 1.1 && sd < 1.9, `粒の強さ: ${sd.toFixed(2)}`);
  assert.ok(corr > 0.2 && corr < 0.8, `となりとのつながり: ${corr.toFixed(2)}`);
});
