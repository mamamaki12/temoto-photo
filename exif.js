// JPEG の Exif（撮影日時・カメラ・位置情報）を読む小さな解析器。
// 目的は「この写真に位置情報が入っているか」を利用者に知らせること。書き出す画像には Exif を入れない（Canvas から作るので自然に消える）。
// 壊れたファイル・悪意のあるファイルでも落ちないよう、すべての読み取りで範囲を確認する。

const TAGS = { 0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0131: 'software', 0x0132: 'modified', 0x8769: 'exifIfd', 0x8825: 'gpsIfd', 0x9003: 'date', 0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8827: 'iso', 0x920a: 'focalLength', 0xa434: 'lens' };

export function readExif(buffer) {
  const v = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const len = v.byteLength;
  if (len < 4 || v.getUint16(0) !== 0xffd8) return null; // JPEG ではない
  let off = 2;
  for (let n = 0; n < 100 && off + 4 <= len; n++) {
    if (v.getUint8(off) !== 0xff) return null;
    const marker = v.getUint8(off + 1);
    const size = v.getUint16(off + 2);
    if (marker === 0xda || size < 2) return null; // 画像データに入った
    if (marker === 0xe1 && off + 10 <= len && v.getUint32(off + 4) === 0x45786966) { // "Exif"
      try { return parseTiff(v, off + 10, Math.min(len, off + 2 + size)); } catch { return null; }
    }
    off += 2 + size;
  }
  return null;
}

function parseTiff(v, start, end) {
  if (start + 8 > end) return null;
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => { if (o < start || o + 2 > end) throw new Error('range'); return v.getUint16(o, le); };
  const u32 = (o) => { if (o < start || o + 4 > end) throw new Error('range'); return v.getUint32(o, le); };
  const out = {};
  const seen = new Set();
  const readIfd = (rel, gps = false) => {
    const at = start + rel;
    if (seen.has(at) || seen.size > 8) return; seen.add(at);
    const count = Math.min(u16(at), 200);
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      const tag = u16(e); const type = u16(e + 2); const num = u32(e + 4);
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const bytes = (sizes[type] || 0) * num;
      const valOff = bytes <= 4 ? e + 8 : start + u32(e + 8);
      const read = () => {
        if (type === 2) { let s = ''; for (let k = 0; k < Math.min(num, 128); k++) { const c = v.getUint8(valOff + k); if (valOff + k >= end || !c) break; s += String.fromCharCode(c); } return s.trim(); }
        if (type === 3) return u16(valOff);
        if (type === 4) return u32(valOff);
        if (type === 5 || type === 10) { const r = []; for (let k = 0; k < Math.min(num, 4); k++) { const a = u32(valOff + k * 8); const b = u32(valOff + k * 8 + 4); r.push(b ? a / b : 0); } return num === 1 ? r[0] : r; }
        if (type === 1 || type === 7) return v.getUint8(valOff);
        return null;
      };
      if (gps) {
        if (tag === 1 || tag === 3) out[tag === 1 ? 'latRef' : 'lonRef'] = read();
        if (tag === 2 || tag === 4) out[tag === 2 ? 'latDms' : 'lonDms'] = read();
        continue;
      }
      const name = TAGS[tag];
      if (!name) continue;
      if (name === 'exifIfd') readIfd(u32(e + 8));
      else if (name === 'gpsIfd') readIfd(u32(e + 8), true);
      else out[name] = read();
    }
  };
  readIfd(u32(start + 4));
  const dms = (a, ref, neg) => (Array.isArray(a) && a.length === 3 ? (a[0] + a[1] / 60 + a[2] / 3600) * (ref === neg ? -1 : 1) : null);
  const lat = dms(out.latDms, out.latRef, 'S'); const lon = dms(out.lonDms, out.lonRef, 'W');
  const gps = lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? { lat, lon } : null;
  return {
    make: out.make || '', model: out.model || '', software: out.software || '', lens: out.lens || '',
    date: out.date || out.modified || '', orientation: out.orientation || 1, gps,
    exposureTime: typeof out.exposureTime === 'number' ? out.exposureTime : null, fNumber: typeof out.fNumber === 'number' ? out.fNumber : null,
    iso: typeof out.iso === 'number' ? out.iso : null, focalLength: typeof out.focalLength === 'number' ? out.focalLength : null,
  };
}

/** TIFF 形式の RAW（DNG・CR2・NEF・ARW など）の先頭から Exif を読む */
export function readTiffExif(buffer) {
  const v = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  if (v.byteLength < 8) return null;
  const b0 = v.getUint8(0); const b1 = v.getUint8(1);
  if (!((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d))) return null;
  try { return parseTiff(v, 0, v.byteLength); } catch { return null; }
}
