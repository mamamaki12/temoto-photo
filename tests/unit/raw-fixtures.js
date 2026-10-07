// テスト用の RAW ファイルを組み立てる（DNG: 非圧縮・可逆JPEG、プレビューJPEG入りの TIFF 型 RAW、CR3 のような独自形式）
// ブラウザにも Node にも依存しない（E2E では Node 側で作ってアップロードする）

/** 小さな TIFF 書き出し（リトルエンディアン） */
export function writeTiff(ifds, chunks) {
  // ifds: [[{tag, type, values}], ...] 1つ目が IFD0（2つ目以降は SubIFD として IFD0 から指す）
  // chunks: 画像データなど。{ id, bytes } を置き、値に { chunk: id } / { chunkLen: id } と書くと位置・長さに置き換わる
  const TS = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
  const parts = []; let size = 8;
  const ifdOffsets = [];
  const plan = ifds.map((entries) => {
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    const off = size; size += 2 + sorted.length * 12 + 4;
    ifdOffsets.push(off);
    return { off, sorted };
  });
  // 4バイトを超える値の置き場
  const extra = [];
  for (const p of plan) for (const e of p.sorted) {
    const bytes = (TS[e.type] || 1) * e.values.length;
    if (bytes > 4) { e.extraAt = size; size += bytes + (bytes & 1); extra.push(e); }
  }
  const chunkAt = {};
  for (const c of chunks) { chunkAt[c.id] = size; size += c.bytes.length + (c.bytes.length & 1); }
  const buf = new Uint8Array(size); const v = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; v.setUint16(2, 42, true); v.setUint32(4, plan[0].off, true);
  const resolve = (x) => (x && typeof x === 'object' ? (x.chunk ? chunkAt[x.chunk] : x.ifd != null ? ifdOffsets[x.ifd] : chunks.find((c) => c.id === x.chunkLen).bytes.length) : x);
  const writeVal = (at, type, val) => {
    switch (type) {
      case 1: case 2: case 7: buf[at] = val; break;
      case 3: v.setUint16(at, val, true); break;
      case 4: v.setUint32(at, val, true); break;
      case 9: v.setInt32(at, val, true); break;
      case 5: v.setUint32(at, Math.round(val * 10000), true); v.setUint32(at + 4, 10000, true); break;
      case 10: v.setInt32(at, Math.round(val * 10000), true); v.setInt32(at + 4, 10000, true); break;
      case 11: v.setFloat32(at, val, true); break;
      default: break;
    }
  };
  plan.forEach((p, k) => {
    v.setUint16(p.off, p.sorted.length, true);
    p.sorted.forEach((e, i) => {
      const at = p.off + 2 + i * 12;
      v.setUint16(at, e.tag, true); v.setUint16(at + 2, e.type, true); v.setUint32(at + 4, e.values.length, true);
      const base = e.extraAt ?? at + 8;
      e.values.forEach((val, j) => writeVal(base + j * (TS[e.type] || 1), e.type, resolve(val)));
      if (e.extraAt != null) v.setUint32(at + 8, e.extraAt, true);
    });
    v.setUint32(p.off + 2 + p.sorted.length * 12, 0, true);
    void k;
  });
  for (const c of chunks) buf.set(c.bytes, chunkAt[c.id]);
  return buf;
}

/** 可逆JPEG（SOF3・予測1）で符号化する。samples は行ごとに width*comps 個 */
export function encodeLosslessJpeg(samples, width, height, comps, precision = 16) {
  const out = [];
  const seg = (m, data) => { out.push(0xff, m, (data.length + 2) >> 8, (data.length + 2) & 255, ...data); };
  out.push(0xff, 0xd8);
  const sof = [precision, height >> 8, height & 255, width >> 8, width & 255, comps];
  for (let c = 0; c < comps; c++) sof.push(c + 1, 0x11, 0);
  seg(0xc3, sof);
  // 17種類（0〜16）を、すべて長さ5の符号にする
  const counts = new Array(16).fill(0); counts[4] = 17;
  seg(0xc4, [0x00, ...counts, ...Array.from({ length: 17 }, (_, i) => i)]);
  const sos = [comps]; for (let c = 0; c < comps; c++) sos.push(c + 1, 0x00);
  sos.push(1, 0, 0); seg(0xda, sos);
  let acc = 0; let n = 0;
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) { acc = (acc << 1) | ((val >> i) & 1); n++; if (n === 8) { out.push(acc); if (acc === 0xff) out.push(0); acc = 0; n = 0; } } };
  const rowLen = width * comps; const initial = 1 << (precision - 1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < comps; c++) {
    const i = y * rowLen + x * comps + c;
    const pv = y === 0 && x === 0 ? initial : y === 0 ? samples[i - comps] : x === 0 ? samples[i - rowLen] : samples[i - comps];
    let d = (samples[i] - pv) & 0xffff; if (d >= 32768) d -= 65536;
    let ssss = 0; let a = Math.abs(d); while (a) { ssss++; a >>= 1; }
    if (d === -32768) ssss = 16;
    put(ssss, 5);
    if (ssss && ssss < 16) put(d < 0 ? d + (1 << ssss) - 1 : d, ssss);
  }
  if (n) put(0x7f, 8 - n);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

const toLinear = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);

/**
 * ベイヤー配列の DNG を作る。scene(x, y) は sRGB の 0〜255 の [r,g,b]
 * @param {{w:number,h:number,scene:Function,compression?:1|7,pattern?:number[],neutral?:number[],black?:number,white?:number,orientation?:number,colorMatrix?:number[]|null,tiles?:number,baselineExposure?:number}} o
 */
export function makeDng(o) {
  const { w, h, scene, compression = 1, pattern = [0, 1, 1, 2], neutral = [1, 1, 1], black = 0, white = 65535, orientation = 1, colorMatrix = null, tiles = 0, baselineExposure = 0 } = o;
  const cfa = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = pattern[(y & 1) * 2 + (x & 1)];
    const lin = toLinear(scene(x, y)[c] / 255) / 2 ** baselineExposure;
    // カメラの値 = リニア × neutral（ホワイトバランスの逆）
    cfa[y * w + x] = Math.round(black + Math.min(1, lin * neutral[c]) * (white - black));
  }
  const blocks = [];
  const bw = tiles || w; const bh = tiles || h;
  for (let by = 0; by < h; by += bh) for (let bx = 0; bx < w; bx += bw) {
    const tile = new Uint16Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) tile[y * bw + x] = cfa[Math.min(h - 1, by + y) * w + Math.min(w - 1, bx + x)];
    let bytes;
    if (compression === 7) bytes = encodeLosslessJpeg(tile, bw / 2, bh, 2, 16); // DNG でよくある「幅半分・2成分」
    else { bytes = new Uint8Array(tile.length * 2); const dv = new DataView(bytes.buffer); tile.forEach((val, i) => dv.setUint16(i * 2, val, true)); }
    blocks.push({ id: `b${blocks.length}`, bytes });
  }
  const e = [
    { tag: 0xfe, type: 4, values: [0] }, { tag: 0x100, type: 4, values: [w] }, { tag: 0x101, type: 4, values: [h] },
    { tag: 0x102, type: 3, values: [16] }, { tag: 0x103, type: 3, values: [compression] }, { tag: 0x106, type: 3, values: [32803] },
    { tag: 0x10f, type: 2, values: [...Buffer.from('TestCam\0')] }, { tag: 0x110, type: 2, values: [...Buffer.from('RAW-1\0')] },
    { tag: 0x112, type: 3, values: [orientation] }, { tag: 0x115, type: 3, values: [1] },
    { tag: 0x828d, type: 3, values: [2, 2] }, { tag: 0x828e, type: 1, values: pattern },
    { tag: 0xc612, type: 1, values: [1, 4, 0, 0] }, { tag: 0xc61a, type: 4, values: [black] }, { tag: 0xc61d, type: 4, values: [white] },
    { tag: 0xc628, type: 5, values: neutral }, { tag: 0xc62a, type: 10, values: [baselineExposure] },
  ];
  if (colorMatrix) e.push({ tag: 0xc621, type: 10, values: colorMatrix }, { tag: 0xc65a, type: 3, values: [21] });
  if (tiles) e.push({ tag: 0x142, type: 4, values: [bw] }, { tag: 0x143, type: 4, values: [bh] }, { tag: 0x144, type: 4, values: blocks.map((b) => ({ chunk: b.id })) }, { tag: 0x145, type: 4, values: blocks.map((b) => ({ chunkLen: b.id })) });
  else e.push({ tag: 0x111, type: 4, values: [{ chunk: 'b0' }] }, { tag: 0x116, type: 4, values: [h] }, { tag: 0x117, type: 4, values: [{ chunkLen: 'b0' }] });
  return writeTiff([e], blocks);
}

/** XYZ → sRGB（リニア）の行列（これを ColorMatrix にすると、カメラの色 = sRGB になる） */
export const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252];

/** 本物っぽい構造だけを持つ JPEG（SOF の種類と大きさだけ確認用。ブラウザでは表示できない） */
export function fakeJpeg(w, h, sof = 0xc0, pad = 100) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, sof, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, ...new Array(pad).fill(0x12), 0xff, 0xd9]);
}

/** NEF / ARW / CR2 のような「TIFF の中にプレビュー JPEG がある」RAW。本体の RAW は独自圧縮のふり */
export function makePreviewRaw(jpeg, { orientation = 1, thumb = null } = {}) {
  const ifd0 = [
    { tag: 0xfe, type: 4, values: [1] }, { tag: 0x100, type: 4, values: [160] }, { tag: 0x101, type: 4, values: [120] },
    { tag: 0x103, type: 3, values: [6] }, { tag: 0x10f, type: 2, values: [...Buffer.from('NIKON CORPORATION\0')] }, { tag: 0x110, type: 2, values: [...Buffer.from('Z TEST\0')] },
    { tag: 0x112, type: 3, values: [orientation] },
    { tag: 0x201, type: 4, values: [{ chunk: thumb ? 'thumb' : 'jpg' }] }, { tag: 0x202, type: 4, values: [{ chunkLen: thumb ? 'thumb' : 'jpg' }] },
    { tag: 0x14a, type: 4, values: [{ ifd: 1 }, { ifd: 2 }] },
  ];
  const sub1 = [{ tag: 0xfe, type: 4, values: [1] }, { tag: 0x103, type: 3, values: [6] }, { tag: 0x201, type: 4, values: [{ chunk: 'jpg' }] }, { tag: 0x202, type: 4, values: [{ chunkLen: 'jpg' }] }];
  const sub2 = [{ tag: 0xfe, type: 4, values: [0] }, { tag: 0x100, type: 4, values: [6000] }, { tag: 0x101, type: 4, values: [4000] }, { tag: 0x103, type: 3, values: [34713] }, { tag: 0x106, type: 3, values: [32803] }, { tag: 0x111, type: 4, values: [{ chunk: 'raw' }] }, { tag: 0x117, type: 4, values: [{ chunkLen: 'raw' }] }];
  const chunks = [{ id: 'jpg', bytes: jpeg }, { id: 'raw', bytes: new Uint8Array(4000).map((_, i) => (i * 37) & 255) }];
  if (thumb) chunks.push({ id: 'thumb', bytes: thumb });
  return writeTiff([ifd0, sub1, sub2], chunks);
}

/** CR3 / RAF のような TIFF でない独自形式の中に JPEG が埋まっているもの */
export function makeContainerRaw(jpegs) {
  const parts = [new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x63, 0x72, 0x78, 0x20]), new Uint8Array(500).map((_, i) => (i * 13) & 255)];
  for (const j of jpegs) { parts.push(j, new Uint8Array(300).map((_, i) => (i * 7 + 3) & 0x7f)); }
  const total = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
