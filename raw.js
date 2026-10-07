// RAW ファイルを開く（DOM を使わないので Worker でも動く）
// - DNG（スマホ・Adobe・Leica・Pentax など）: RAW データそのものを現像する
//   （非圧縮・可逆JPEG圧縮、ベイヤー配列／線形RAW、黒レベル・白レベル、ホワイトバランス、色変換行列、デモザイク）
// - CR2 / CR3 / NEF / ARW / RAF / ORF / RW2 / PEF など: メーカー独自の圧縮なので、
//   ファイルの中にカメラが入れている JPEG（多くはフルサイズ）を取り出して使う
// - 非圧縮の TIFF（RGB 8/16bit）も開ける
// 壊れたファイル・悪意のあるファイルでも止まるよう、読み取り位置・大きさ・件数をすべて確認する。
import { decodeLosslessJpeg } from './ljpeg.js';

export const RAW_RE = /\.(dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|3fr|fff|iiq|erf|mef|mos|kdc|dcr|x3f|tif|tiff)$/i;
export const isRawName = (name) => RAW_RE.test(name || '');
const MAX_SAMPLES = 120_000_000;

// ───────────── TIFF の構造を読む ─────────────
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

export function parseTiff(buf) {
  if (buf.length < 16) return null;
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  if (!le && !(buf[0] === 0x4d && buf[1] === 0x4d)) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = v.getUint16(2, le);
  if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) return null; // TIFF / ORF / RW2
  const u16 = (o) => v.getUint16(o, le); const u32 = (o) => v.getUint32(o, le);
  const inRange = (o, n) => o >= 0 && o + n <= buf.length;
  const ifds = []; const seen = new Set();
  const readIfd = (off, kind, depth) => {
    if (depth > 4 || ifds.length > 40 || seen.has(off) || !inRange(off, 2)) return null;
    seen.add(off);
    const n = u16(off);
    if (n > 1000 || !inRange(off + 2, n * 12 + 4)) return null;
    const tags = new Map();
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const type = u16(e + 2); const count = u32(e + 4); const size = (TYPE_SIZE[type] || 1) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (!inRange(at, Math.min(size, buf.length))) continue;
      tags.set(u16(e), { type, count, at });
    }
    const ifd = { offset: off, kind, tags };
    ifds.push(ifd);
    for (const sub of nums(ifd, 0x14a)) readIfd(sub, 'sub', depth + 1);
    if (tags.has(0x8769)) readIfd(num(ifd, 0x8769), 'exif', depth + 1);
    return u32(off + 2 + n * 12);
  };
  const nums = (ifd, tag, max = 100000) => {
    const e = ifd.tags.get(tag); if (!e) return [];
    const out = []; const n = Math.min(e.count, max);
    for (let i = 0; i < n; i++) {
      const o = e.at + i * (TYPE_SIZE[e.type] || 1);
      if (!inRange(o, TYPE_SIZE[e.type] || 1)) break;
      switch (e.type) {
        case 1: case 2: case 7: out.push(buf[o]); break;
        case 6: out.push(v.getInt8(o)); break;
        case 3: out.push(u16(o)); break;
        case 8: out.push(v.getInt16(o, le)); break;
        case 4: case 13: out.push(u32(o)); break;
        case 9: out.push(v.getInt32(o, le)); break;
        case 5: { const d = u32(o + 4); out.push(d ? u32(o) / d : 0); break; }
        case 10: { const d = v.getInt32(o + 4, le); out.push(d ? v.getInt32(o, le) / d : 0); break; }
        case 11: out.push(v.getFloat32(o, le)); break;
        case 12: out.push(v.getFloat64(o, le)); break;
        default: out.push(0);
      }
    }
    return out;
  };
  const num = (ifd, tag, d = 0) => { const a = nums(ifd, tag, 1); return a.length ? a[0] : d; };
  const str = (ifd, tag) => { const e = ifd.tags.get(tag); if (!e || e.type !== 2) return ''; let s = ''; for (let i = 0; i < Math.min(e.count, 200); i++) { const c = buf[e.at + i]; if (!c) break; s += String.fromCharCode(c); } return s.trim(); };
  let next = u32(4); let depth = 0;
  while (next && depth++ < 10) next = readIfd(next, depth === 1 ? 'ifd0' : 'next', 0);
  return { le, v, buf, ifds, nums, num, str };
}

// ───────────── 入っている JPEG を探す ─────────────
/** JPEG の始まり（offset）から、大きさ・種類・終わりを調べる。ダメなら null */
export function probeJpeg(buf, offset, limit = buf.length) {
  if (buf[offset] !== 0xff || buf[offset + 1] !== 0xd8 || buf[offset + 2] !== 0xff) return null;
  let p = offset + 2; let sof = null;
  for (let i = 0; i < 300 && p + 4 <= limit; i++) {
    if (buf[p] !== 0xff) return null;
    const m = buf[p + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    const len = (buf[p + 2] << 8) | buf[p + 3];
    if (len < 2 || p + 2 + len > limit) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      sof = { type: m, h: (buf[p + 5] << 8) | buf[p + 6], w: (buf[p + 7] << 8) | buf[p + 8] };
    }
    if (m === 0xda) {
      // 画像データの後ろの FFD9 を探す（データ中の FF は FF00 か RST なので、FFD9 は終わり）
      for (let q = p + 2 + len; q + 1 < limit; q++) {
        if (buf[q] === 0xff && buf[q + 1] === 0xd9) return sof ? { offset, length: q + 2 - offset, ...sof } : null;
      }
      return null;
    }
    p += 2 + len;
  }
  return null;
}

/** ファイルの中の、ブラウザで表示できる JPEG（ベースライン・プログレッシブ）を、大きい順に */
export function findPreviews(buf, tiff) {
  const found = new Map();
  const add = (off, len) => {
    if (found.has(off) || off < 0 || off >= buf.length) return;
    const j = probeJpeg(buf, off, len ? Math.min(buf.length, off + len) : buf.length);
    if (j && [0xc0, 0xc1, 0xc2].includes(j.type) && j.w > 0 && j.h > 0) found.set(off, j);
  };
  if (tiff) {
    for (const ifd of tiff.ifds) {
      if (ifd.tags.has(0x201)) add(tiff.num(ifd, 0x201), tiff.num(ifd, 0x202));
      const comp = tiff.num(ifd, 0x103); const photo = tiff.num(ifd, 0x106);
      if ((comp === 6 || comp === 7 || comp === 99) && photo !== 32803 && photo !== 34892) {
        const offs = tiff.nums(ifd, 0x111, 4); const cnts = tiff.nums(ifd, 0x117, 4);
        if (offs.length === 1) add(offs[0], cnts[0]);
      }
    }
  }
  // どのメーカーでも見つけられるよう、ファイル全体からも探す（CR3・RAF など）
  let hits = 0;
  for (let i = 0; i + 3 < buf.length && hits < 64; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) { hits++; add(i); }
  }
  return [...found.values()].sort((a, b) => b.w * b.h - a.w * a.h || b.length - a.length);
}

// ───────────── DNG の現像 ─────────────
const XYZ_RGB = [[0.412453, 0.357580, 0.180423], [0.212671, 0.715160, 0.072169], [0.019334, 0.119193, 0.950227]]; // sRGB(D65) → XYZ

function inv3(m) {
  const [a, b, c] = m; const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-12) return null;
  const d = 1 / det;
  return [
    [(b[1] * c[2] - b[2] * c[1]) * d, (a[2] * c[1] - a[1] * c[2]) * d, (a[1] * b[2] - a[2] * b[1]) * d],
    [(b[2] * c[0] - b[0] * c[2]) * d, (a[0] * c[2] - a[2] * c[0]) * d, (a[2] * b[0] - a[0] * b[2]) * d],
    [(b[0] * c[1] - b[1] * c[0]) * d, (a[1] * c[0] - a[0] * c[1]) * d, (a[0] * b[1] - a[1] * b[0]) * d],
  ];
}
const mul3 = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));

/** カメラの色 → sRGB（リニア）の行列。ColorMatrix（XYZ → カメラ）から作る（dcraw と同じ方法） */
export function cameraToSrgb(colorMatrix) {
  if (!colorMatrix || colorMatrix.length < 9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const camXyz = [colorMatrix.slice(0, 3), colorMatrix.slice(3, 6), colorMatrix.slice(6, 9)];
  const camRgb = mul3(camXyz, XYZ_RGB).map((r) => { const s = r[0] + r[1] + r[2]; return s ? r.map((x) => x / s) : r; });
  return inv3(camRgb) || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

/** 明るい所をなめらかに飽和させて sRGB の 0〜255 にする表（入力 0〜4 を 16384 段階で） */
function toneLut() {
  const lut = new Uint8ClampedArray(16384);
  for (let i = 0; i < 16384; i++) {
    let x = (i / 16383) * 4;
    if (x > 0.8) x = 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2)); // 肩（白飛びをやわらかく）
    const s = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    lut[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
  }
  return lut;
}

/** ストリップ／タイルに分かれた画素を読み出して、W×H×spp の配列にする */
function readSamples(t, ifd, W, H, spp, bps, comp) {
  const { buf } = t;
  if (W * H * spp > MAX_SAMPLES) throw new Error('too large');
  const out = new Uint16Array(W * H * spp);
  const tiled = ifd.tags.has(0x144);
  const bw = tiled ? t.num(ifd, 0x142) : W; const bh = tiled ? t.num(ifd, 0x143) : Math.min(H, t.num(ifd, 0x116, H) || H);
  if (!bw || !bh) throw new Error('bad blocks');
  const offs = t.nums(ifd, tiled ? 0x144 : 0x111); const cnts = t.nums(ifd, tiled ? 0x145 : 0x117);
  const across = tiled ? Math.ceil(W / bw) : 1;
  offs.forEach((off, k) => {
    const bx = (k % across) * bw; const by = Math.floor(k / across) * bh;
    if (by >= H) return;
    const len = Math.min(cnts[k] || 0, buf.length - off);
    if (len <= 0) return;
    const rowSamples = bw * spp;
    const put = (r, ci, val) => {
      const y = by + r; const x = bx + Math.floor(ci / spp);
      if (y < H && x < W) out[(y * W + x) * spp + (ci % spp)] = val;
    };
    if (comp === 7) {
      const j = decodeLosslessJpeg(buf, off, off + len);
      // 復号した値を、ブロックの中に左上から順に並べる（DNG の「幅を半分・成分2つ」の書き方にも対応）
      const n = Math.min(j.data.length, rowSamples * bh);
      for (let i = 0; i < n; i++) put(Math.floor(i / rowSamples), i % rowSamples, j.data[i]);
    } else if (comp === 1) {
      const rowsHere = Math.min(bh, H - by);
      if (bps === 16) {
        for (let r = 0; r < rowsHere; r++) for (let ci = 0; ci < rowSamples; ci++) { const o = off + (r * rowSamples + ci) * 2; if (o + 2 > off + len) return; put(r, ci, t.v.getUint16(o, t.le)); }
      } else if (bps === 8) {
        for (let r = 0; r < rowsHere; r++) for (let ci = 0; ci < rowSamples; ci++) { const o = off + r * rowSamples + ci; if (o >= off + len) return; put(r, ci, buf[o]); }
      } else {
        // 10/12/14bit などは上位ビットから詰めて並ぶ（各行は1バイト境界から）
        const rowBytes = Math.ceil((rowSamples * bps) / 8);
        for (let r = 0; r < rowsHere; r++) {
          let bitPos = 0; const base = off + r * rowBytes;
          for (let ci = 0; ci < rowSamples; ci++) {
            let val = 0;
            for (let b = 0; b < bps; b++, bitPos++) { const o = base + (bitPos >> 3); if (o >= off + len) return; val = (val << 1) | ((buf[o] >> (7 - (bitPos & 7))) & 1); }
            put(r, ci, val);
          }
        }
      }
    } else throw new Error('compression');
  });
  return out;
}

/** Malvar–He–Cutler のデモザイク（2×2 のベイヤー配列）。m はホワイトバランス済みの値 */
export function demosaic(m, W, H, pat) {
  const out = new Float32Array(W * H * 3);
  // 端では折り返して読む（ベイヤー配列の色の並びが崩れないように）
  const rx = (x) => (x < 0 ? -x : x >= W ? 2 * W - 2 - x : x); const ry = (y) => (y < 0 ? -y : y >= H ? 2 * H - 2 - y : y);
  const Ps = (x, y) => m[Math.min(H - 1, Math.max(0, ry(y))) * W + Math.min(W - 1, Math.max(0, rx(x)))];
  const set = (o, c, v0, a, b, ca, cb) => {
    // c の位置に v0、ca の位置に a、cb の位置に b（負の値は0に）
    out[o + c] = v0; out[o + ca] = a > 0 ? a : 0; out[o + cb] = b > 0 ? b : 0;
  };
  for (let y = 0; y < H; y++) {
    const edgeY = y < 2 || y >= H - 2;
    for (let x = 0; x < W; x++) {
      const c = pat[(y & 1) * 2 + (x & 1)]; const o = (y * W + x) * 3;
      let v0; let l1; let r1; let u1; let d1; let l2; let r2; let u2; let d2; let ul; let ur; let dl; let dr;
      if (edgeY || x < 2 || x >= W - 2) {
        v0 = Ps(x, y); l1 = Ps(x - 1, y); r1 = Ps(x + 1, y); u1 = Ps(x, y - 1); d1 = Ps(x, y + 1);
        l2 = Ps(x - 2, y); r2 = Ps(x + 2, y); u2 = Ps(x, y - 2); d2 = Ps(x, y + 2);
        ul = Ps(x - 1, y - 1); ur = Ps(x + 1, y - 1); dl = Ps(x - 1, y + 1); dr = Ps(x + 1, y + 1);
      } else {
        const i = y * W + x;
        v0 = m[i]; l1 = m[i - 1]; r1 = m[i + 1]; u1 = m[i - W]; d1 = m[i + W];
        l2 = m[i - 2]; r2 = m[i + 2]; u2 = m[i - 2 * W]; d2 = m[i + 2 * W];
        ul = m[i - W - 1]; ur = m[i - W + 1]; dl = m[i + W - 1]; dr = m[i + W + 1];
      }
      const diag = ul + ur + dl + dr;
      if (c === 1) {
        // 緑の画素: 横の色（hc）と縦の色（vc）を求める
        const hc = pat[(y & 1) * 2 + ((x + 1) & 1)]; const vc = pat[((y + 1) & 1) * 2 + (x & 1)];
        const fh = l2 + r2; const fv = u2 + d2;
        set(o, 1, v0, (5 * v0 + 4 * (l1 + r1) - diag - fh + 0.5 * fv) / 8, (5 * v0 + 4 * (u1 + d1) - diag - fv + 0.5 * fh) / 8, hc, vc);
      } else {
        const far = l2 + r2 + u2 + d2;
        set(o, c, v0, (4 * v0 + 2 * (l1 + r1 + u1 + d1) - far) / 8, (6 * v0 + 2 * diag - 1.5 * far) / 8, 1, 2 - c);
      }
    }
  }
  return out;
}

/** 2×2 を1画素にまとめる（とても大きい RAW を、メモリに収まる大きさで現像する） */
function superpixel(m, W, H, pat) {
  const w = W >> 1; const h = H >> 1; const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = [0, 0, 0]; const n = [0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const c = pat[dy * 2 + dx]; s[c] += m[(y * 2 + dy) * W + x * 2 + dx]; n[c]++; }
    const o = (y * w + x) * 3; out[o] = s[0] / (n[0] || 1); out[o + 1] = s[1] / (n[1] || 1); out[o + 2] = s[2] / (n[2] || 1);
  }
  return { rgb: out, w, h };
}

/** 向き（Exif の Orientation 1〜8）を画素に反映する */
export function orient(rgba, w, h, o) {
  if (!o || o === 1) return { data: rgba, width: w, height: h };
  const swap = o >= 5; const W2 = swap ? h : w; const H2 = swap ? w : h;
  const out = new Uint8ClampedArray(W2 * H2 * 4); const u32in = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h); const u32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X; let Y;
    switch (o) {
      case 2: X = w - 1 - x; Y = y; break;
      case 3: X = w - 1 - x; Y = h - 1 - y; break;
      case 4: X = x; Y = h - 1 - y; break;
      case 5: X = y; Y = x; break;
      case 6: X = h - 1 - y; Y = x; break;
      case 7: X = h - 1 - y; Y = w - 1 - x; break;
      case 8: X = y; Y = w - 1 - x; break;
      default: X = x; Y = y;
    }
    u32[Y * W2 + X] = u32in[y * w + x];
  }
  return { data: out, width: W2, height: H2 };
}

function develop(t, ifd0, raw, { maxPixels }) {
  const W0 = t.num(raw, 0x100); const H0 = t.num(raw, 0x101);
  const photo = t.num(raw, 0x106); const spp = t.num(raw, 0x115, 1) || 1; const bps = t.nums(raw, 0x102)[0] || 16; const comp = t.num(raw, 0x103, 1);
  if (!W0 || !H0 || W0 > 20000 || H0 > 20000) throw new Error('size');
  if (photo === 32803 && spp !== 1) throw new Error('cfa spp');
  if (photo === 34892 && spp !== 3) throw new Error('linear spp');
  const samples = readSamples(t, raw, W0, H0, spp, bps, comp);
  // リニア化テーブル
  const lin = t.nums(raw, 0xc618, 65536);
  if (lin.length > 1) for (let i = 0; i < samples.length; i++) samples[i] = lin[Math.min(lin.length - 1, samples[i])];
  // 有効な範囲（ActiveArea → DefaultCrop）
  const aa = t.nums(raw, 0xc68d, 4); const [top, left, bottom, right] = aa.length === 4 ? aa : [0, 0, H0, W0];
  let x0 = left; let y0 = top; let W = Math.max(1, right - left); let H = Math.max(1, bottom - top);
  const co = t.nums(raw, 0xc61f, 2); const cs = t.nums(raw, 0xc620, 2);
  if (co.length === 2 && cs.length === 2 && cs[0] > 0 && cs[1] > 0) {
    // ベイヤー配列の並びを保つため、偶数にそろえる
    const cx = Math.round(co[0]) & ~1; const cy = Math.round(co[1]) & ~1;
    x0 += cx; y0 += cy; W = Math.min(W - cx, Math.round(cs[0])); H = Math.min(H - cy, Math.round(cs[1]));
  }
  // 黒レベル・白レベル
  const blackDim = t.nums(raw, 0xc619, 2); const bRows = blackDim[0] || 1; const bCols = blackDim[1] || 1;
  const black = t.nums(raw, 0xc61a, 64); const white = t.nums(raw, 0xc61d, 4);
  const blk = (x, y, s) => { if (!black.length) return 0; const i = ((y % bRows) * bCols + (x % bCols)) * (black.length >= bRows * bCols * spp ? spp : 1) + (black.length >= bRows * bCols * spp ? s : 0); return black[Math.min(i, black.length - 1)]; };
  const wht = (s) => white[Math.min(s, white.length - 1)] || (2 ** bps - 1);
  // ホワイトバランス（AsShotNeutral の逆数。最小を1に）
  const neutral = t.nums(raw, 0xc628, 3);
  let wb = neutral.length === 3 && neutral.every((n) => n > 0) ? neutral.map((n) => 1 / n) : [1, 1, 1];
  const mn = Math.min(...wb); wb = wb.map((g) => g / mn);
  // 色変換（D65 の行列を優先）
  const ill1 = t.num(raw, 0xc65a, 0) || t.num(ifd0, 0xc65a, 0); const ill2 = t.num(raw, 0xc65b, 0) || t.num(ifd0, 0xc65b, 0);
  const cm1 = t.nums(raw, 0xc621, 9).length === 9 ? t.nums(raw, 0xc621, 9) : t.nums(ifd0, 0xc621, 9);
  const cm2 = t.nums(raw, 0xc622, 9).length === 9 ? t.nums(raw, 0xc622, 9) : t.nums(ifd0, 0xc622, 9);
  const cm = cm2.length === 9 && (ill2 === 21 || ill1 !== 21) ? cm2 : cm1;
  const M = cameraToSrgb(cm.length === 9 ? cm : null);
  const be = t.num(ifd0, 0xc62a, 0) || t.num(raw, 0xc62a, 0);
  const gainAll = 2 ** Math.max(-4, Math.min(4, be));
  let rgb; let w; let h;
  if (photo === 32803) {
    const dim = t.nums(raw, 0x828d, 2); const pat = t.nums(raw, 0x828e, 4);
    if (dim[0] !== 2 || dim[1] !== 2 || pat.length !== 4 || pat.some((c) => c > 2)) throw new Error('cfa pattern');
    // 切り抜き位置に合わせて配列の並びをずらす
    const p2 = [0, 1, 2, 3].map((i) => pat[(((i >> 1) + y0) & 1) * 2 + (((i & 1) + x0) & 1)]);
    const m = new Float32Array(W * H);
    const wl = wht(0);
    for (let y = 0; y < H; y++) {
      const Y = y + y0;
      // 黒レベルは行・列の繰り返し（最大 2×2 など）なので、この行の分を先に計算しておく
      const bl = [0, 1, 2, 3].map((k) => blk(x0 + k, Y, 0)); const sc = bl.map((b, k) => wb[p2[(y & 1) * 2 + (k & 1)]] / Math.max(1, wl - b));
      const row = Y * W0 + x0; const orow = y * W;
      for (let x = 0; x < W; x++) { const k = x & 3; const v = samples[row + x] - bl[k]; m[orow + x] = v > 0 ? v * sc[k] : 0; }
    }
    if (W * H > maxPixels) ({ rgb, w, h } = superpixel(m, W, H, p2)); else { rgb = demosaic(m, W, H, p2); w = W; h = H; }
  } else if (photo === 34892 || photo === 2) {
    rgb = new Float32Array(W * H * 3); w = W; h = H;
    const lin8 = photo === 2; // ふつうの RGB の TIFF は sRGB の値なのでリニアに戻す
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let s = 0; s < 3; s++) {
      const X = x + x0; const Y = y + y0; const b = blk(X, Y, s);
      let val = Math.max(0, (samples[(Y * W0 + X) * spp + s] - b) / Math.max(1, wht(s) - b));
      if (lin8) val = val <= 0.04045 ? val / 12.92 : ((val + 0.055) / 1.055) ** 2.4;
      rgb[(y * W + x) * 3 + s] = val * (lin8 ? 1 : wb[s]);
    }
    if (W * H > maxPixels) {
      // 大きすぎる場合は2×2で縮める
      const w2 = W >> 1; const h2 = H >> 1; const r2 = new Float32Array(w2 * h2 * 3);
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let s = 0; s < 3; s++) r2[(y * w2 + x) * 3 + s] = (rgb[((2 * y) * W + 2 * x) * 3 + s] + rgb[((2 * y) * W + 2 * x + 1) * 3 + s] + rgb[((2 * y + 1) * W + 2 * x) * 3 + s] + rgb[((2 * y + 1) * W + 2 * x + 1) * 3 + s]) / 4;
      rgb = r2; w = w2; h = h2;
    }
  } else throw new Error('photometric');
  // 色変換 → 露出 → トーン → 8bit
  const lut = toneLut(); const useM = photo !== 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    let r = rgb[i]; let g = rgb[i + 1]; let b = rgb[i + 2];
    if (useM) { const R = M[0][0] * r + M[0][1] * g + M[0][2] * b; const G = M[1][0] * r + M[1][1] * g + M[1][2] * b; const B = M[2][0] * r + M[2][1] * g + M[2][2] * b; r = R; g = G; b = B; }
    rgba[j] = lut[Math.min(16383, Math.max(0, Math.round(r * gainAll * 4095.75)))];
    rgba[j + 1] = lut[Math.min(16383, Math.max(0, Math.round(g * gainAll * 4095.75)))];
    rgba[j + 2] = lut[Math.min(16383, Math.max(0, Math.round(b * gainAll * 4095.75)))];
    rgba[j + 3] = 255;
  }
  return { rgba, width: w, height: h, scaled: w !== W };
}

const FORMAT = { dng: 'DNG', cr2: 'Canon CR2', cr3: 'Canon CR3', crw: 'Canon CRW', nef: 'Nikon NEF', nrw: 'Nikon NRW', arw: 'Sony ARW', srf: 'Sony SRF', sr2: 'Sony SR2', raf: 'Fujifilm RAF', orf: 'Olympus ORF', rw2: 'Panasonic RW2', pef: 'Pentax PEF', srw: 'Samsung SRW', '3fr': 'Hasselblad 3FR', fff: 'Hasselblad FFF', iiq: 'Phase One IIQ', erf: 'Epson ERF', mef: 'Mamiya MEF', mos: 'Leaf MOS', kdc: 'Kodak KDC', dcr: 'Kodak DCR', x3f: 'Sigma X3F', tif: 'TIFF', tiff: 'TIFF' };

/**
 * RAW を開く。
 * @returns {{kind:'raw', rgba, width, height, scaled, format, orientation:1} | {kind:'preview', previews:[{offset,length,w,h}], orientation, format}}
 */
export function decodeRaw(arrayBuffer, { name = '', maxPixels = 16_700_000 } = {}) {
  const buf = new Uint8Array(arrayBuffer);
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const format = FORMAT[ext] || 'RAW';
  const t = parseTiff(buf);
  const ifd0 = t?.ifds.find((i) => i.kind === 'ifd0');
  const orientation = ifd0 ? t.num(ifd0, 0x112, 1) : 1;
  let reason = '';
  if (t && ifd0) {
    const isDng = ifd0.tags.has(0xc612);
    // 本体の画像（NewSubFileType = 0）で、現像できる種類のもの
    const cands = t.ifds.filter((i) => i.kind !== 'exif' && t.num(i, 0x100) > 0 && (t.num(i, 0xfe, 0) & 1) === 0);
    const pick = (fn) => cands.filter(fn).sort((a, b) => t.num(b, 0x100) * t.num(b, 0x101) - t.num(a, 0x100) * t.num(a, 0x101))[0];
    const rawIfd = isDng ? pick((i) => [32803, 34892].includes(t.num(i, 0x106))) : null;
    const rgbTiff = !isDng && /tiff?$/.test(ext) ? pick((i) => t.num(i, 0x106) === 2 && t.num(i, 0x103, 1) === 1 && t.num(i, 0x115, 1) >= 3) : null;
    const target = rawIfd || rgbTiff;
    if (target) {
      const comp = t.num(target, 0x103, 1);
      if (comp === 1 || comp === 7) {
        try {
          const r = develop(t, ifd0, target, { maxPixels });
          const o = orient(r.rgba, r.width, r.height, orientation);
          return { kind: 'raw', rgba: o.data, width: o.width, height: o.height, scaled: r.scaled, format: rgbTiff ? 'TIFF' : format, orientation: 1 };
        } catch (e) { reason = String(e.message || e); }
      } else reason = `compression ${comp}`;
    }
  }
  const previews = findPreviews(buf, t);
  if (!previews.length) throw new Error(reason || 'no image');
  return { kind: 'preview', previews: previews.slice(0, 6), orientation, format, reason };
}

/** RAW の中の撮影情報（メーカー・機種・日時・位置情報など）。TIFF 形式でない RAW（CR3 など）は null */
export function rawInfo(arrayBuffer) {
  const t = parseTiff(new Uint8Array(arrayBuffer));
  const ifd0 = t?.ifds.find((i) => i.kind === 'ifd0');
  if (!ifd0) return null;
  return { make: t.str(ifd0, 0x10f), model: t.str(ifd0, 0x110) || t.str(ifd0, 0xc614) };
}
