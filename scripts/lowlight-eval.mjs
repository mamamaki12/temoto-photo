// 暗所補正（restoration-lowlight.js）を、手元の写真で Node から試す。アプリの Worker と同じ帯の分け方で処理する。
// 入力・出力は RGB を並べただけのファイル（写真は PIL などで変換する。docs/lowlight-handoff.md）。
//   node scripts/lowlight-eval.mjs in.rgb 幅 高さ out.rgb ノイズ軽減(0〜100) 明るさ補正(0〜100)
import fs from 'node:fs';
import { measureNoise, planTone, enhanceBand, BAND_MARGIN } from '../restoration-lowlight.js';

const [,, inp, W, H, outp, noise = '50', lowlight = '50'] = process.argv;
const w = +W; const h = +H; const nr = +noise / 50; const light = +lowlight;
const rgb = fs.readFileSync(inp); const rgba = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) { rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
const t0 = Date.now();
// ノイズの量: 中央 2048×2048（restoration-photo.js と同じ）
const cw = Math.min(w, 2048); const ch = Math.min(h, 2048); const cx = (w - cw) >> 1; const cy = (h - ch) >> 1;
const crop = new Uint8ClampedArray(cw * ch * 4);
for (let y = 0; y < ch; y++) crop.set(rgba.subarray(((cy + y) * w + cx) * 4, ((cy + y) * w + cx + cw) * 4), y * cw * 4);
const profile = nr > 0 ? measureNoise(crop, cw, ch) : null;
if (profile) profile.forEach((p, l) => console.error(`ノイズ 段${l}:`, Array.from(p, (v) => (v * 255).toFixed(2)).join(' ')));
// 明るさの曲線: 長い辺 512 に縮めた絵（面積平均）
const s = 512 / Math.max(w, h); const sw = Math.round(w * s); const sh = Math.round(h * s); const small = new Uint8ClampedArray(sw * sh * 4);
for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
  const x0 = Math.floor(x / s); const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) / s)));
  const y0 = Math.floor(y / s); const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) / s)));
  const acc = [0, 0, 0]; let n = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { for (let c = 0; c < 3; c++) acc[c] += rgba[(yy * w + xx) * 4 + c]; n++; }
  for (let c = 0; c < 3; c++) small[(y * sw + x) * 4 + c] = acc[c] / n; small[(y * sw + x) * 4 + 3] = 255;
}
const tone = light > 0 ? planTone({ width: sw, height: sh, data: small }, light) : null;
if (tone) console.error('倍率', tone.gain.toFixed(2), '白', tone.white.toFixed(2), '色', tone.wb.map((v) => v.toFixed(2)).join(' '));
const out = Buffer.alloc(w * h * 3); const ROWS = Math.max(64, Math.min(512, Math.floor(1_000_000 / w / 4) * 4));
for (let y = 0; y < h; y += ROWS) {
  const end = Math.min(h, y + ROWS); const top = Math.max(0, y - BAND_MARGIN); const bottom = Math.min(h, end + BAND_MARGIN);
  const r = enhanceBand({ width: w, height: bottom - top, data: rgba.slice(top * w * 4, bottom * w * 4) },
    { top: y - top, bottom: end - top, y0: top, fullW: w, fullH: h }, { nr, profile, tone });
  for (let i = 0; i < (end - y) * w; i++) out.set(r.subarray(i * 4, i * 4 + 3), (y * w + i) * 3);
  process.stderr.write(`\r残り${100 - Math.round(end / h * 100)}%  `);
}
console.error(`\n${((Date.now() - t0) / 1000).toFixed(1)}秒`);
fs.writeFileSync(outp, out);
