// 暗所補正の試作を Node で動かす。使い方は docs/lowlight-handoff.md。
// 入力・出力は P6 の PPM（写真は PIL などで PPM に変換する）。
import fs from 'node:fs';
import { enhance } from '../lowlight.js';
const [,, inp, outp, ...rest] = process.argv;
const o = Object.fromEntries(rest.map((a) => a.split('=')).map(([k, v]) => [k, Number(v)]));
const buf = fs.readFileSync(inp);
// P6 ppm
let pos = 0; const tok = () => { while (/\s/.test(String.fromCharCode(buf[pos]))) pos++; let s = ''; while (!/\s/.test(String.fromCharCode(buf[pos]))) s += String.fromCharCode(buf[pos++]); return s; };
tok(); const w = +tok(); const h = +tok(); tok(); pos++;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) { rgba[i*4] = buf[pos+i*3]; rgba[i*4+1] = buf[pos+i*3+1]; rgba[i*4+2] = buf[pos+i*3+2]; rgba[i*4+3] = 255; }
let last = 0; const t0 = Date.now();
const { out, info } = enhance(rgba, w, h, o, (t) => { if (t - last > 0.1) { last = t; process.stderr.write(`${Math.round(t*100)}% `); } });
console.error(`\n${((Date.now()-t0)/1000).toFixed(1)}s`, JSON.stringify(info));
const hdr = Buffer.from(`P6\n${w} ${h}\n255\n`); const px = Buffer.alloc(w*h*3);
for (let i = 0; i < w*h; i++) { px[i*3] = out[i*4]; px[i*3+1] = out[i*4+1]; px[i*3+2] = out[i*4+2]; }
fs.writeFileSync(outp, Buffer.concat([hdr, px]));
