// 可逆JPEG（Lossless JPEG / ITU T.81 の SOF3）の復号。DNG の RAW データの圧縮に使われる。
// 壊れたデータでも止まるように、読み取り位置と大きさをすべて確認する。

class BitReader {
  constructor(buf, pos, end) { this.b = buf; this.p = pos; this.end = end; this.acc = 0; this.n = 0; this.marker = false; }
  fill() {
    while (this.n <= 24) {
      let byte = 0;
      if (!this.marker && this.p < this.end) {
        byte = this.b[this.p++];
        if (byte === 0xff) {
          const next = this.p < this.end ? this.b[this.p] : 0;
          if (next === 0x00) this.p++; // FF 00 は FF というデータ
          else { this.marker = true; this.p--; byte = 0; } // マーカー（RST など）に当たった
        }
      }
      this.acc = (this.acc << 8) | byte; this.n += 8;
    }
  }
  bits(k) {
    if (k === 0) return 0;
    if (this.n < k) this.fill();
    this.n -= k;
    return (this.acc >>> this.n) & ((1 << k) - 1);
  }
  peek16() { if (this.n < 16) this.fill(); return (this.acc >>> (this.n - 16)) & 0xffff; }
  skip(k) { this.n -= k; }
  /** RSTn マーカーの直後へ */
  restart() {
    this.acc = 0; this.n = 0; this.marker = false;
    while (this.p + 1 < this.end && !(this.b[this.p] === 0xff && this.b[this.p + 1] >= 0xd0 && this.b[this.p + 1] <= 0xd7)) this.p++;
    this.p += 2;
  }
}

/** ハフマン表から、16ビット先読み用の表を作る */
function buildHuffman(counts, symbols) {
  const lookup = new Uint32Array(65536); // 上位16ビット → (長さ << 8) | 値
  let code = 0; let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const sym = symbols[k++];
      const shift = 16 - len; const start = code << shift; const n = 1 << shift;
      if (start + n > 65536) throw new Error('bad huffman');
      for (let j = 0; j < n; j++) lookup[start + j] = (len << 8) | sym;
      code++;
    }
    code <<= 1;
  }
  return lookup;
}

/**
 * @param {Uint8Array} buf
 * @returns {{width:number, height:number, comps:number, precision:number, data:Uint16Array}} data は 行ごとに [各画素の成分…] の並び
 */
export function decodeLosslessJpeg(buf, start = 0, end = buf.length) {
  let p = start;
  if (buf[p] !== 0xff || buf[p + 1] !== 0xd8) throw new Error('not jpeg');
  p += 2;
  const tables = {}; let frame = null; let restart = 0;
  while (p + 4 <= end) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; }
    const len = (buf[p + 2] << 8) | buf[p + 3];
    const seg = p + 4; const segEnd = p + 2 + len;
    if (segEnd > end) throw new Error('truncated');
    if (m === 0xc3) {
      const comps = buf[seg + 5];
      frame = { precision: buf[seg], height: (buf[seg + 1] << 8) | buf[seg + 2], width: (buf[seg + 3] << 8) | buf[seg + 4], comps, ids: [] };
      for (let i = 0; i < comps; i++) frame.ids.push(buf[seg + 6 + i * 3]);
      if (!frame.width || !frame.height || comps < 1 || comps > 4 || frame.precision < 2 || frame.precision > 16) throw new Error('bad frame');
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('not lossless');
    } else if (m === 0xc4) {
      let q = seg;
      while (q < segEnd) {
        const id = buf[q] & 0x0f; const counts = buf.subarray(q + 1, q + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        tables[id] = buildHuffman(counts, buf.subarray(q + 17, q + 17 + total));
        q += 17 + total;
      }
    } else if (m === 0xdd) {
      restart = (buf[seg] << 8) | buf[seg + 1];
    } else if (m === 0xda) {
      if (!frame) throw new Error('no frame');
      const ns = buf[seg];
      const sel = [];
      for (let i = 0; i < ns; i++) sel.push(buf[seg + 2 + i * 2] >> 4);
      const pred = buf[seg + 1 + ns * 2]; const pt = buf[seg + 3 + ns * 2] & 0x0f;
      return decodeScan(buf, segEnd, end, frame, sel.map((t) => tables[t]), pred, pt, restart);
    }
    p = segEnd;
  }
  throw new Error('no scan');
}

function decodeScan(buf, pos, end, f, huff, pred, pt, restart) {
  const { width: W, height: H, comps: C } = f;
  if (huff.some((t) => !t)) throw new Error('missing table');
  if (W * H * C > 200_000_000) throw new Error('too large');
  const out = new Uint16Array(W * H * C);
  const br = new BitReader(buf, pos, end);
  const initial = 1 << (f.precision - pt - 1);
  const rowLen = W * C;
  let mcu = 0; let firstLine = 0; // リスタートの直後の行は「最初の行」と同じ扱い
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let reset = y === 0 && x === 0;
      if (restart && mcu && mcu % restart === 0) { br.restart(); reset = true; if (x === 0) firstLine = y; }
      for (let c = 0; c < C; c++) {
        const e = huff[c][br.peek16()];
        const len = e >> 8;
        if (!len) throw new Error('bad code');
        br.skip(len);
        const s = e & 0xff;
        let diff;
        if (s === 0) diff = 0;
        else if (s === 16) diff = 32768;
        else { diff = br.bits(s); if (diff < (1 << (s - 1))) diff -= (1 << s) - 1; }
        const i = y * rowLen + x * C + c;
        let pv;
        if (reset) pv = initial;
        else if (y === firstLine) pv = out[i - C];
        else if (x === 0) pv = out[i - rowLen];
        else {
          const ra = out[i - C]; const rb = out[i - rowLen]; const rc = out[i - rowLen - C];
          switch (pred) {
            case 2: pv = rb; break;
            case 3: pv = rc; break;
            case 4: pv = ra + rb - rc; break;
            case 5: pv = ra + ((rb - rc) >> 1); break;
            case 6: pv = rb + ((ra - rc) >> 1); break;
            case 7: pv = (ra + rb) >> 1; break;
            default: pv = ra;
          }
        }
        out[i] = (pv + diff) & 0xffff;
      }
      mcu++;
    }
  }
  if (pt) for (let i = 0; i < out.length; i++) out[i] <<= pt; // 予測は縮めた値のままで行い、最後に戻す
  return { width: W, height: H, comps: C, precision: f.precision, data: out };
}
