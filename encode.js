// 画像ファイルを自分で組み立てる（JPEG・PNG）。
// iPhone の Safari は約1,670万画素より大きい Canvas を作れないので、元の大きさの写真を書き出すときは
// 画像を横長の帯に分けて描き、帯ごとにここへ渡してファイルにする（大きな Canvas を作らない）。
// 色の情報（ICC プロファイル）も埋め込むので、Display P3 の鮮やかな色がほかのアプリでも正しく表示される。

// ── JPEG（ベースライン、4:4:4。色の細部が失われないよう、色差を間引かない） ──
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const STD_Y = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const STD_C = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
// 標準のハフマン表（JPEG 規格の付録 K）
const DC_Y_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]; const DC_Y_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_C_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]; const DC_C_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_Y_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_Y_VALS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const AC_C_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALS = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

/** ハフマン符号の表（値 → [符号, 長さ]） */
function huffTable(bits, vals) {
  const t = []; let code = 0; let k = 0;
  for (let len = 1; len <= 16; len++) { for (let i = 0; i < bits[len - 1]; i++) t[vals[k++]] = [code++, len]; code <<= 1; }
  return t;
}
const HT = { dcY: huffTable(DC_Y_BITS, DC_Y_VALS), dcC: huffTable(DC_C_BITS, DC_C_VALS), acY: huffTable(AC_Y_BITS, AC_Y_VALS), acC: huffTable(AC_C_BITS, AC_C_VALS) };

/** 画質（1〜100）から量子化表を作る（IJG と同じ式）。返すのはジグザグ順 */
function quantTable(std, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.min(255, Math.max(1, Math.floor((std[ZIGZAG[i]] * s + 50) / 100)));
  return out;
}

/** 浮動小数の DCT（AAN）。結果は量子化の割り算と一緒に倍率をかけるので、その倍率表も作る */
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.541196100, 0.275899379];
function divisors(qz) {
  const d = new Float64Array(64);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const nat = r * 8 + c; const zz = ZIGZAG.indexOf(nat);
    d[nat] = 1 / (qz[zz] * AAN[r] * AAN[c] * 8);
  }
  return d;
}
function fdct(b) {
  for (let i = 0; i < 64; i += 8) dct8(b, i, 1);
  for (let i = 0; i < 8; i++) dct8(b, i, 8);
}
function dct8(b, o, s) {
  const d0 = b[o]; const d1 = b[o + s]; const d2 = b[o + 2 * s]; const d3 = b[o + 3 * s]; const d4 = b[o + 4 * s]; const d5 = b[o + 5 * s]; const d6 = b[o + 6 * s]; const d7 = b[o + 7 * s];
  const t0 = d0 + d7; const t7 = d0 - d7; const t1 = d1 + d6; const t6 = d1 - d6; const t2 = d2 + d5; const t5 = d2 - d5; const t3 = d3 + d4; const t4 = d3 - d4;
  let t10 = t0 + t3; const t13 = t0 - t3; let t11 = t1 + t2; let t12 = t1 - t2;
  b[o] = t10 + t11; b[o + 4 * s] = t10 - t11;
  const z1 = (t12 + t13) * 0.707106781; b[o + 2 * s] = t13 + z1; b[o + 6 * s] = t13 - z1;
  t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
  const z5 = (t10 - t12) * 0.382683433; const z2 = 0.541196100 * t10 + z5; const z4 = 1.306562965 * t12 + z5; const z3 = t11 * 0.707106781;
  const z11 = t7 + z3; const z13 = t7 - z3;
  b[o + 5 * s] = z13 + z2; b[o + 3 * s] = z13 - z2; b[o + s] = z11 + z4; b[o + 7 * s] = z11 - z4;
}

/** ICC プロファイルを APP2 に（64KB ごとに分けて）入れる */
function iccSegments(icc) {
  const out = []; const max = 65519; const n = Math.ceil(icc.length / max);
  for (let i = 0; i < n; i++) {
    const part = icc.subarray(i * max, (i + 1) * max); const len = part.length + 16;
    const seg = new Uint8Array(len + 2);
    seg.set([0xff, 0xe2, len >> 8, len & 255]); seg.set([73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0], 4); seg[16] = i + 1; seg[17] = n; seg.set(part, 18);
    out.push(seg);
  }
  return out;
}

/**
 * JPEG を帯ごとに作る。add(rgba, rows) で上から順に画素を渡し、finish() で Blob を返す
 * @param {{width:number,height:number,quality?:number,icc?:Uint8Array}} o quality は 0〜1
 */
export function jpegEncoder({ width, height, quality = 0.92, icc }) {
  const chunks = []; const qY = quantTable(STD_Y, quality * 100); const qC = quantTable(STD_C, quality * 100);
  const dY = divisors(qY); const dC = divisors(qC);
  // ── ヘッダー ──
  const head = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  chunks.push(new Uint8Array(head));
  if (icc?.length) chunks.push(...iccSegments(icc));
  const dqt = [0xff, 0xdb, 0, 132, 0, ...qY, 1, ...qC];
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  const dht = (cls, id, bits, vals) => { const len = 3 + 16 + vals.length; return [0xff, 0xc4, len >> 8, len & 255, (cls << 4) | id, ...bits, ...vals]; };
  const sos = [0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0];
  chunks.push(new Uint8Array([...dqt, ...sof, ...dht(0, 0, DC_Y_BITS, DC_Y_VALS), ...dht(1, 0, AC_Y_BITS, AC_Y_VALS), ...dht(0, 1, DC_C_BITS, DC_C_VALS), ...dht(1, 1, AC_C_BITS, AC_C_VALS), ...sos]));
  // ── 符号化したデータ（0xFF の後には 0x00 を入れる） ──
  let buf = new Uint8Array(1 << 16); let pos = 0; let acc = 0; let nbits = 0;
  const flushBuf = () => { if (pos) { chunks.push(buf.slice(0, pos)); pos = 0; } };
  const byte = (v) => { if (pos >= buf.length - 2) flushBuf(); buf[pos++] = v; if (v === 0xff) buf[pos++] = 0; };
  const bits = (code, len) => { acc = (acc << len) | code; nbits += len; while (nbits >= 8) { nbits -= 8; byte((acc >> nbits) & 255); } acc &= (1 << nbits) - 1; };
  const sizeOf = (v) => { v = v < 0 ? -v : v; let n = 0; while (v) { n++; v >>= 1; } return n; };
  const blk = new Float64Array(64); const zq = new Int32Array(64);
  const pred = [0, 0, 0];
  const block = (ci, d, dc, ac) => {
    fdct(blk);
    for (let i = 0; i < 64; i++) { const v = blk[ZIGZAG[i]] * d[ZIGZAG[i]]; zq[i] = v < 0 ? Math.ceil(v - 0.5) : Math.floor(v + 0.5); }
    const diff = zq[0] - pred[ci]; pred[ci] = zq[0];
    const s = sizeOf(diff); bits(dc[s][0], dc[s][1]); if (s) bits(diff < 0 ? diff + (1 << s) - 1 : diff, s);
    let run = 0;
    for (let i = 1; i < 64; i++) {
      const v = zq[i];
      if (!v) { run++; continue; }
      while (run > 15) { bits(ac[0xf0][0], ac[0xf0][1]); run -= 16; }
      const n = sizeOf(v); const sym = (run << 4) | n; bits(ac[sym][0], ac[sym][1]); bits(v < 0 ? v + (1 << n) - 1 : v, n); run = 0;
    }
    if (run) bits(ac[0][0], ac[0][1]);
  };
  // 8行ずつ処理する。足りない行は次の add まで持ち越す
  let pending = new Uint8ClampedArray(0); let pendingRows = 0; let done = 0;
  const Yb = new Float64Array(64); const Cbb = new Float64Array(64); const Crb = new Float64Array(64);
  const encodeRows = (rgba, rows8) => {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const ry = Math.min(y, rows8 - 1); // 画像の下端では最後の行をくり返す
        for (let x = 0; x < 8; x++) {
          const k = (ry * width + Math.min(bx + x, width - 1)) * 4; const r = rgba[k]; const g = rgba[k + 1]; const b = rgba[k + 2];
          const i = y * 8 + x;
          Yb[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128; Cbb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b; Crb[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      blk.set(Yb); block(0, dY, HT.dcY, HT.acY); blk.set(Cbb); block(1, dC, HT.dcC, HT.acC); blk.set(Crb); block(2, dC, HT.dcC, HT.acC);
    }
  };
  return {
    /** rgba: 幅 width × rows 行の画素（RGBA）。透明な所は白にする */
    add(rgba, rows) {
      const all = new Uint8ClampedArray((pendingRows + rows) * width * 4);
      all.set(pending); all.set(rgba.subarray(0, rows * width * 4), pendingRows * width * 4);
      let total = pendingRows + rows; let off = 0;
      while (total >= 8 && done + 8 <= height) { encodeRows(all.subarray(off * width * 4), 8); off += 8; total -= 8; done += 8; }
      pending = all.slice(off * width * 4, (off + total) * width * 4); pendingRows = total;
    },
    finish() {
      if (done < height && pendingRows > 0) { encodeRows(pending, pendingRows); done = height; }
      if (nbits > 0) bits((1 << (8 - nbits)) - 1, 8 - nbits); // 残りのビットを 1 で埋める
      flushBuf(); chunks.push(new Uint8Array([0xff, 0xd9]));
      return new Blob(chunks, { type: 'image/jpeg' });
    },
  };
}

// ── PNG（劣化なし。透明も残す） ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts) { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = new Uint8Array([...type].map((ch) => ch.charCodeAt(0))); const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(t, 4); out.set(data, 8); dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}
async function zlib(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** PNG を帯ごとに作る（圧縮は CompressionStream で、端末の中で行う） */
export function pngEncoder({ width, height, icc, iccName = 'ICC profile' }) {
  const cs = new CompressionStream('deflate'); const writer = cs.writable.getWriter();
  const out = new Response(cs.readable).arrayBuffer();
  const stride = width * 4; let prev = new Uint8Array(stride);
  return {
    async add(rgba, rows) {
      const raw = new Uint8Array(rows * (stride + 1));
      for (let y = 0; y < rows; y++) {
        const o = y * (stride + 1); const row = rgba.subarray(y * stride, (y + 1) * stride);
        raw[o] = 2; // 上の行との差（Up）。写真では無圧縮よりかなり小さくなる
        for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - prev[i]) & 255;
        prev = row.slice();
      }
      await writer.write(raw);
    },
    async finish() {
      await writer.close(); const z = new Uint8Array(await out);
      const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, width); dv.setUint32(4, height); ihdr.set([8, 6, 0, 0, 0], 8);
      const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
      if (icc?.length) { const name = new TextEncoder().encode(iccName.slice(0, 79)); const zi = await zlib(icc); const d = new Uint8Array(name.length + 2 + zi.length); d.set(name); d.set(zi, name.length + 2); parts.push(chunk('iCCP', d)); }
      for (let i = 0; i < z.length; i += 1 << 20) parts.push(chunk('IDAT', z.subarray(i, i + (1 << 20))));
      parts.push(chunk('IEND', new Uint8Array(0)));
      return new Blob(parts, { type: 'image/png' });
    },
  };
}

/** JPEG の中の ICC プロファイル（APP2）を取り出す */
export function readJpegIcc(bytes) {
  const parts = []; let i = 2;
  while (i + 4 < bytes.length && bytes[i] === 0xff) {
    const m = bytes[i + 1]; const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (m === 0xda || m === 0xd9) break;
    if (m === 0xe2 && String.fromCharCode(...bytes.subarray(i + 4, i + 15)) === 'ICC_PROFILE') parts[bytes[i + 16] - 1] = bytes.subarray(i + 18, i + 2 + len);
    i += 2 + len;
  }
  if (!parts.length || parts.some((p) => !p)) return null;
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
