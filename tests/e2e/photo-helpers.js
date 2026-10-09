// 写真編集のテスト用: ブラウザの Canvas で「写真らしい」画像（空・太陽・山・草・人物の代わりの円）を作る
export async function makePhoto(page, { w = 1200, h = 800, type = 'image/jpeg' } = {}) {
  const b64 = await page.evaluate(async ({ w, h, type }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    const sky = x.createLinearGradient(0, 0, 0, h * 0.6); sky.addColorStop(0, '#3d6fb6'); sky.addColorStop(1, '#bcd6ee');
    x.fillStyle = sky; x.fillRect(0, 0, w, h);
    x.fillStyle = '#ffe08a'; x.beginPath(); x.arc(w * 0.78, h * 0.2, h * 0.08, 0, 7); x.fill();
    x.fillStyle = '#5b6b4e'; x.beginPath(); x.moveTo(0, h * 0.62); x.lineTo(w * 0.3, h * 0.35); x.lineTo(w * 0.55, h * 0.6); x.lineTo(w * 0.75, h * 0.42); x.lineTo(w, h * 0.62); x.lineTo(w, h); x.lineTo(0, h); x.fill();
    const g = x.createLinearGradient(0, h * 0.6, 0, h); g.addColorStop(0, '#6f9a3c'); g.addColorStop(1, '#2f4d1d'); x.fillStyle = g; x.fillRect(0, h * 0.62, w, h);
    x.fillStyle = '#c96f4a'; x.beginPath(); x.arc(w * 0.3, h * 0.72, h * 0.09, 0, 7); x.fill();
    x.fillStyle = '#f0d2b4'; x.beginPath(); x.arc(w * 0.3, h * 0.6, h * 0.05, 0, 7); x.fill();
    x.fillStyle = '#111'; x.beginPath(); x.arc(w * 0.62, h * 0.25, 6, 0, 7); x.fill(); // 消したい点（ほこり）
    for (let i = 0; i < 3000; i++) { x.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`; x.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { w, h, type });
  return { name: type === 'image/png' ? 'test.png' : 'test.jpg', mimeType: type, buffer: Buffer.from(b64, 'base64') };
}

/** 表示中の写真（.view）の平均色 [r, g, b] */
export async function viewMean(page, region) {
  return page.evaluate((region) => {
    const c = document.querySelector('canvas.view'); const x = c.getContext('2d');
    const [x0, y0, x1, y1] = region || [0, 0, 1, 1];
    const d = x.getImageData(Math.floor(c.width * x0), Math.floor(c.height * y0), Math.max(1, Math.floor(c.width * (x1 - x0))), Math.max(1, Math.floor(c.height * (y1 - y0))), { colorSpace: 'srgb' }).data;
    let r = 0; let g = 0; let b = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return [r / n, g / n, b / n];
  }, region);
}

/** JPEG に Exif（カメラ名・位置情報）を差し込む（書き出しで消えることの確認用） */
export function withExif(file) {
  const u16 = (v) => [v >> 8, v & 255]; const u32 = (v) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const make = [...Buffer.from('SecretCam\0')];
  const ifd0End = 8 + 2 + 2 * 12 + 4; const makeOff = ifd0End; const gpsOff = makeOff + make.length; const dataOff = gpsOff + 2 + 4 * 12 + 4;
  const t = [0x4d, 0x4d, ...u16(42), ...u32(8), ...u16(2),
    ...u16(0x010f), ...u16(2), ...u32(make.length), ...u32(makeOff),
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsOff), ...u32(0), ...make,
    ...u16(4), ...u16(1), ...u16(2), ...u32(2), 78, 0, 0, 0, ...u16(2), ...u16(5), ...u32(3), ...u32(dataOff),
    ...u16(3), ...u16(2), ...u32(2), 69, 0, 0, 0, ...u16(4), ...u16(5), ...u32(3), ...u32(dataOff + 24), ...u32(0)];
  for (const [a, c] of [[35, 1], [40, 1], [5292, 100], [139, 1], [46, 1], [324, 10]]) t.push(...u32(a), ...u32(c));
  const app1 = [...Buffer.from('Exif\0\0'), ...t];
  const seg = Buffer.from([0xff, 0xe1, ...u16(app1.length + 2), ...app1]);
  return { ...file, buffer: Buffer.concat([file.buffer.subarray(0, 2), seg, file.buffer.subarray(2)]) };
}

/** 単色の写真（グリッドのテスト用） */
export async function solidPhoto(page, color, { w = 800, h = 600, name = 'solid.png' } = {}) {
  const b64 = await page.evaluate(async ({ color, w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { color, w, h });
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

/** 端末内（IndexedDB）に保存された、各写真の露光量（保存が終わるのを待つ用） */
export function savedExposures(page) {
  return page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('temoto-photo');
    r.onsuccess = () => {
      const q = r.result.transaction('projects').objectStore('projects').getAll();
      q.onsuccess = () => { res(q.result.map((p) => p.state?.adj?.exposure)); r.result.close(); };
      q.onerror = () => res([]);
    };
    r.onerror = () => res([]);
  }));
}
