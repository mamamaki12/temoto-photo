// RAW の現像（LibRaw が出した 16bit・リニア・Rec.2020 → 8bit）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoGain, developParams, developRegion, fromRec2020 } from '../../rawdev.js';

/** w×h の 16bit RGB（f(x, y) → [r, g, b]（0〜1 のリニア）） */
function lin(w, h, f) {
  const data = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 3; f(x, y).forEach((v, c) => { data[k + c] = Math.round(Math.min(1, Math.max(0, v)) * 65535); }); }
  return { data, width: w, height: h };
}
const px = (out, w, x, y) => { const i = (y * w + x) * 4; return [out[i], out[i + 1], out[i + 2]]; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('rawdev: 色の変換行列は白（1,1,1）を白のまま移す', () => {
  for (const sp of ['srgb', 'display-p3']) for (const row of fromRec2020(sp)) assert.ok(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-3, sp);
});

test('rawdev: 灰色は灰色のまま、明るいほど明るく現像される', () => {
  const w = 64; const h = 8; const L = lin(w, h, (x) => { const v = 0.02 + (x / w) * 0.9; return [v, v, v]; });
  const out = developRegion(L, 0, 0, w, h, developParams({}, 1, 'srgb'));
  let prev = -1;
  for (let x = 0; x < w; x += 4) {
    const [r, g, b] = px(out, w, x, 4);
    assert.ok(Math.abs(r - g) <= 1 && Math.abs(b - g) <= 1, `x=${x}: ${r},${g},${b}`);
    assert.ok(g >= prev, `x=${x}`); prev = g;
  }
  assert.ok(px(out, w, w - 1, 4)[1] > 235); // 明るい所は白近くまで（肩でなめらかに）
});

test('rawdev: 一部ずつ現像しても、まとめて現像したのと同じになる（書き出しのタイル分割）', () => {
  const w = 97; const h = 61;
  const L = lin(w, h, (x, y) => [((x * 37 + y * 11) % 97) / 120, ((x * 13 + y * 29) % 61) / 80, (((x ^ y) * 7) % 50) / 70]);
  const p = developParams({}, 1.3, 'display-p3');
  const all = developRegion(L, 0, 0, w, h, p);
  for (const [x0, y0, tw, th] of [[0, 0, 40, 30], [40, 30, 57, 31], [13, 7, 20, 41]]) {
    const part = developRegion(L, x0, y0, tw, th, p);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) assert.deepEqual(px(part, tw, x, y), px(all, w, x0 + x, y0 + y), `${x0 + x},${y0 + y}`);
  }
});

test('rawdev: 明るさの自動調整と「RAW の露出」', () => {
  // 明るい方から 1% の所が 0.78 になる倍率
  const L = lin(100, 100, (x, y) => { const v = y < 99 ? 0.1 : 0.4; return [v, v, v]; });
  const g = autoGain(L.data, 100, 100);
  assert.ok(Math.abs(g - 0.78 / 0.1) < 0.2, `gain ${g}`);
  assert.equal(developParams({ exposure: 100 }, 2, 'srgb').gain, 4);
  assert.equal(developParams({ exposure: -200 }, 2, 'srgb').gain, 0.5);
  // 露出を下げると暗くなる（16bit から現像し直すので、白飛びしていた所の階調が戻る）
  const hi = lin(8, 8, () => [0.9, 0.9, 0.9]);
  const a = px(developRegion(hi, 0, 0, 8, 8, developParams({}, 2, 'srgb')), 8, 4, 4);
  const b = px(developRegion(hi, 0, 0, 8, 8, developParams({ exposure: -150 }, 2, 'srgb')), 8, 4, 4);
  assert.ok(a[1] >= 250 && b[1] < 235, `${a} / ${b}`);
});

test('rawdev: 暗い所のノイズが赤・緑の粒にならず、黒く沈む', () => {
  // 黒の近くで、成分ごとにばらばらに揺れるノイズ（センサーの暗部ノイズのような）
  let s = 1; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const w = 120; const h = 120; const L = lin(w, h, () => [0.003 * rnd() * 2, 0.002 * rnd() * 2, 0.003 * rnd() * 2]);
  const out = developRegion(L, 0, 0, w, h, developParams({}, 1, 'srgb'));
  let sat = 0; let sum = 0; const n = (w - 20) * (h - 20);
  for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) {
    const c = px(out, w, x, y); sat += Math.max(...c) - Math.min(...c); sum += lum(c);
  }
  assert.ok(sat / n < 3, `色の粒 ${sat / n}`);
  assert.ok(sum / n < 12, `明るさ ${sum / n}`);
});
