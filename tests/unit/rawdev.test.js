// RAW の現像（LibRaw が出した 16bit・リニア・Rec.2020 → 8bit）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoGain, developParams, developRegion, fromRec2020, estimateCA } from '../../rawdev.js';

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
  const out = developRegion(L, 0, 0, w, h, developParams({}, { gain: 1 }, 'srgb'));
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
  const p = developParams({}, { gain: 1.3 }, 'display-p3');
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
  assert.equal(developParams({ exposure: 100 }, { gain: 2 }, 'srgb').gain, 4);
  assert.equal(developParams({ exposure: -200 }, { gain: 2 }, 'srgb').gain, 0.5);
  // 露出を下げると暗くなる（16bit から現像し直すので、白飛びしていた所の階調が戻る）
  const hi = lin(8, 8, () => [0.9, 0.9, 0.9]);
  const a = px(developRegion(hi, 0, 0, 8, 8, developParams({}, { gain: 2 }, 'srgb')), 8, 4, 4);
  const b = px(developRegion(hi, 0, 0, 8, 8, developParams({ exposure: -150 }, { gain: 2 }, 'srgb')), 8, 4, 4);
  assert.ok(a[1] >= 250 && b[1] < 235, `${a} / ${b}`);
});

test('rawdev: 暗い所のノイズが赤・緑の粒にならず、黒く沈む', () => {
  // 黒の近くで、成分ごとにばらばらに揺れるノイズ（センサーの暗部ノイズのような）
  let s = 1; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const w = 120; const h = 120; const L = lin(w, h, () => [0.003 * rnd() * 2, 0.002 * rnd() * 2, 0.003 * rnd() * 2]);
  const out = developRegion(L, 0, 0, w, h, developParams({}, { gain: 1 }, 'srgb'));
  let sat = 0; let sum = 0; const n = (w - 20) * (h - 20);
  for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) {
    const c = px(out, w, x, y); sat += Math.max(...c) - Math.min(...c); sum += lum(c);
  }
  assert.ok(sat / n < 3, `色の粒 ${sat / n}`);
  assert.ok(sum / n < 12, `明るさ ${sum / n}`);
});

test('rawdev: 色にじみ（赤・青の写る大きさのずれ）を写真から測って、直す', () => {
  // 白黒の模様（中心からいろいろな向きの輪郭）。赤は 0.12% 大きく、青は 0.08% 小さく写っているとする
  const W = 900; const H = 600; const cx = (W - 1) / 2; const cy = (H - 1) / 2;
  const pat = (x, y) => { const a = Math.atan2(y - cy, x - cx); const r = Math.hypot(x - cx, y - cy); const v = Math.sin(a * 24) * Math.sin(r / 9); return 0.08 + 0.32 * (0.5 + 0.5 * Math.tanh(v * 6)); };
  const L = lin(W, H, (x, y) => [pat(cx + (x - cx) / 1.0012, cy + (y - cy) / 1.0012), pat(x, y), pat(cx + (x - cx) / 0.9992, cy + (y - cy) / 0.9992)]);
  L.scale = 1; const ca = estimateCA(L);
  assert.ok(ca, '測れる');
  assert.ok(Math.abs(ca.r[0] - 0.0012) < 0.0003, `赤 ${ca.r[0]}`);
  assert.ok(Math.abs(ca.b[0] + 0.0008) < 0.0003, `青 ${ca.b[0]}`);
  // 直すと、端の輪郭で赤・緑・青がそろう（灰色の模様なので、色の差が小さくなる）
  const colorErr = (p) => { const out = developRegion(L, 0, 0, W, H, p); let e = 0; let n = 0; for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) { if (Math.hypot(x - cx, y - cy) < 250) continue; const [r, g, b] = px(out, W, x, y); e += Math.abs(r - g) + Math.abs(b - g); n++; } return e / n; };
  const off = colorErr(developParams({ ca: false, nr: 0, sharpen: 0 }, { gain: 1 }, 'srgb'));
  const on = colorErr(developParams({ nr: 0, sharpen: 0 }, { gain: 1, ca }, 'srgb'));
  assert.ok(on < off * 0.5, `${on} < ${off}`);
});

test('rawdev: ゆがみの補正（＋で樽型を直すと端の線が外へ、−で糸巻き型を直すと内へ）・周辺の暗さの補正', () => {
  const W = 300; const H = 200; const X = 250; // 右寄りの縦線
  const L = lin(W, H, (x) => (Math.abs(x - X) < 1.5 ? [0.5, 0.5, 0.5] : [0.05, 0.05, 0.05]));
  const lineAt = (r) => { const out = developRegion(L, 0, 0, W, H, developParams({ nr: 0, sharpen: 0, ...r }, { gain: 1 }, 'srgb')); let sw = 0; let sx = 0; for (let x = 0; x < W; x++) { const g = Math.max(0, px(out, W, x, 100)[1] - 80); sw += g; sx += g * x; } return sx / sw; }; // 線の重心
  assert.ok(Math.abs(lineAt({}) - X) < 0.5);
  assert.ok(lineAt({ distortion: 100 }) > X + 2, `樽型 ${lineAt({ distortion: 100 })}`);
  // 糸巻き型を直すときは、すみが外にはみ出さないよう 8% 拡大するので、拡大だけのときより内側にあればよい
  const cx = (W - 1) / 2;
  assert.ok(lineAt({ distortion: -100 }) < cx + (X - cx) * 1.08 - 1.5, `糸巻き型 ${lineAt({ distortion: -100 })}`);
  // 周辺の暗さの補正: すみは明るく、真ん中は変わらない
  const flat = lin(W, H, () => [0.1, 0.1, 0.1]);
  const a = developRegion(flat, 0, 0, W, H, developParams({ nr: 0, sharpen: 0, vignette: 100 }, { gain: 1 }, 'srgb'));
  const b = developRegion(flat, 0, 0, W, H, developParams({ nr: 0, sharpen: 0 }, { gain: 1 }, 'srgb'));
  assert.ok(px(a, W, 0, 0)[1] > px(b, W, 0, 0)[1] + 20);
  assert.ok(Math.abs(px(a, W, 150, 100)[1] - px(b, W, 150, 100)[1]) <= 1);
});
