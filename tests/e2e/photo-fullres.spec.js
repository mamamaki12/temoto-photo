// 元の大きさでの書き出し（大きな写真を帯に分けて描き、自分で JPEG / PNG にする）と、Display P3 の色
import { test, expect } from '@playwright/test';
import { makePhoto } from './photo-helpers.js';

test.setTimeout(180_000);

/** iPhone の Safari と同じく、約1,670万画素を超える Canvas を作れなくする（作ろうとしたら記録してエラー） */
async function iphoneCanvasLimit(page) {
  await page.evaluate(() => {
    const LIM = 16_777_216; window.__bigCanvas = [];
    for (const k of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k);
      Object.defineProperty(HTMLCanvasElement.prototype, k, {
        configurable: true,
        get() { return d.get.call(this); },
        set(v) { const w = k === 'width' ? v : this.width; const h = k === 'height' ? v : this.height; if (w * h > LIM) { window.__bigCanvas.push([w, h]); throw new Error('canvas too big'); } d.set.call(this, v); },
      });
    }
  });
}
async function open(page, file) {
  await page.locator('#open-file').setInputFiles(file);
  await page.waitForFunction(() => window.__temoto?.editor?.L, null, { timeout: 60_000 });
  await page.waitForTimeout(200);
}
async function exportFile(page, { size, format = 'JPEG', space } = {}) {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: format }).click();
  await dlg.getByRole('button', { name: size }).click();
  if (space) await dlg.getByRole('button', { name: space }).click();
  const dl = page.waitForEvent('download', { timeout: 150_000 });
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  const buf = await (await dl).createReadStream().then((s) => new Promise((res) => { const b = []; s.on('data', (c) => b.push(c)); s.on('end', () => res(Buffer.concat(b))); }));
  await dlg.getByRole('button', { name: '閉じる' }).click();
  return buf;
}
const b64 = (buf) => buf.toString('base64');
/** 画像を縮めて読み、[幅, 高さ, sRGB の画素] を返す */
const decode = (page, buf, w) => page.evaluate(async ([s, w]) => {
  const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))]));
  const h = Math.round((bm.height * w) / bm.width); const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high'; x.drawImage(bm, 0, 0, w, h);
  return [bm.width, bm.height, Array.from(x.getImageData(0, 0, w, h, { colorSpace: 'srgb' }).data)];
}, [b64(buf), w]);

test('大きな写真（2,400万画素）を、編集を全部のせて元の大きさで書き出す（iPhone と同じく大きな Canvas は作らない）', async ({ page }) => {
  const logs = []; page.on('pageerror', (e) => logs.push(String(e))); page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('元の大きさ')) logs.push(m.text()); });
  await page.goto('/');
  const photo = await makePhoto(page, { w: 6000, h: 4000 }); // テスト用の写真を作ってから、上限をかける
  await iphoneCanvasLimit(page);
  await open(page, photo);
  expect(await page.evaluate(() => window.__temoto.editor.W * window.__temoto.editor.H)).toBeLessThanOrEqual(16_700_000); // 編集は縮めた写真で
  await page.evaluate(() => {
    const s = window.__temoto.editor.state;
    Object.assign(s.adj, { exposure: 20, clarity: 30, vignette: -30, grain: 20, sharpen: 30 });
    s.locals.push({ id: 'r1', type: 'radial', invert: false, cx: 0.7, cy: 0.3, rx: 0.2, ry: 0.2, feather: 50, adj: { exposure: 40, contrast: 0, highlights: 0, shadows: 0, temp: 30, tint: 0, saturation: 0, clarity: 0, dehaze: 0, blur: 0 } });
    s.portrait = { smooth: 50, even: 40, bright: 18, tol: 50, seeds: [[0.3, 0.6]] };
    s.retouch.push({ type: 'heal', x: 0.62, y: 0.25, r: 0.01, sx: 0.66, sy: 0.25 }, { type: 'mosaic', x: 0.05, y: 0.7, w: 0.1, h: 0.1, size: 20 });
    s.frame = { width: 3, color: '#ffffff', radius: 10, pad: '4:5', padFill: 'blur', padColor: '#ffffff' };
  });
  await page.getByRole('tab', { name: '情報' }).click();
  await expect(page.locator('.info')).toContainText('6240×7800（JPEG・PNG は元の写真から描き直します）');
  const full = await exportFile(page, { size: /元の大きさ/ });
  const small = await exportFile(page, { size: '2048px' });
  const [fw, fh, fpx] = await decode(page, full, 400); const [sw, sh, spx] = await decode(page, small, 400);
  expect([fw, fh]).toEqual([6240, 7800]); // 枠と 4:5 の余白を含めて、元の大きさ（6000×4000 の写真）
  expect([sw, sh]).toEqual([1639, 2049]);
  // 中身は、縮めた写真から書き出したものと同じ（粒子・圧縮の違いだけ）
  let diff = 0; for (let i = 0; i < fpx.length; i += 4) for (let c = 0; c < 3; c++) diff += Math.abs(fpx[i + c] - spx[i + c]);
  expect(diff / (fpx.length / 4) / 3).toBeLessThan(4);
  expect(await page.evaluate(() => window.__bigCanvas)).toEqual([]);
  expect(logs).toEqual([]);
  // PNG（劣化なし）でも
  const png = await exportFile(page, { size: /元の大きさ/, format: 'PNG（劣化なし）' });
  const [pw, ph] = await decode(page, png, 100);
  expect([pw, ph]).toEqual([6240, 7800]);
  expect(await page.evaluate(() => window.__bigCanvas)).toEqual([]);
});

test('Display P3 の鮮やかな色を、くすませずに書き出す（元の大きさでも、縮めた写真でも）・sRGB も選べる', async ({ page }) => {
  await page.goto('/');
  // P3 の色票（純色の赤・緑・振袖のような赤紫・肌）。sRGB にすると、赤・緑・赤紫はくすむ
  const make = (w, h) => page.evaluate(async ([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { colorSpace: 'display-p3' });
    ['color(display-p3 1 0 0)', 'color(display-p3 0 1 0)', 'color(display-p3 0.85 0 0.45)', 'color(display-p3 0.9 0.72 0.62)'].forEach((col, i) => { x.fillStyle = col; x.fillRect((i * w) / 4, 0, w / 4, h); });
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s);
  }, [w, h]);
  const readP3 = (buf) => page.evaluate(async (s) => {
    const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))]));
    const c = document.createElement('canvas'); c.width = 400; c.height = 100; const x = c.getContext('2d', { colorSpace: 'display-p3' }); x.drawImage(bm, 0, 0, 400, 100);
    return [0, 1, 2, 3].map((i) => Array.from(x.getImageData(i * 100 + 50, 50, 1, 1, { colorSpace: 'display-p3' }).data.slice(0, 3)));
  }, b64(buf));
  const near = (a, b, e = 4) => a.every((v, i) => Math.abs(v - b[i]) <= e);
  const P3 = [[255, 0, 0], [0, 255, 0], [217, 0, 115], [229, 184, 158]];
  for (const [w, h, size] of [[1200, 400, /元の大きさ/], [6400, 2700, /元の大きさ/]]) {
    await open(page, { name: 'p3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(await make(w, h), 'base64') });
    const out = await exportFile(page, { size });
    expect(out.includes(Buffer.from('ICC_PROFILE'))).toBe(true);
    const got = await readP3(out);
    got.forEach((c, i) => expect(near(c, P3[i]), `${w}: ${c} vs ${P3[i]}`).toBe(true));
    // sRGB を選ぶと、sRGB の範囲に収める（純色の赤は P3 では 234,51,35 くらいになる）
    const s = await readP3(await exportFile(page, { size, space: /sRGB/ }));
    expect(near(s[0], [234, 51, 35], 6), `${w} sRGB: ${s[0]}`).toBe(true);
    expect(near(s[3], P3[3], 4)).toBe(true); // 肌の色は変わらない
    // 次のために、書き出しの設定を Display P3 に戻す
    await page.getByRole('button', { name: '書き出し', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: /Display P3/ }).click(); await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
    await page.getByRole('button', { name: '‹ 写真' }).click();
  }
});
