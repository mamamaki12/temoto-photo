import { test, expect } from '@playwright/test';
import { solidPhoto } from './photo-helpers.js';

test('写真の比較: 原寸読み込み・補正・PNG保存・中止・再実行', async ({ page }) => {
  await page.goto('/restoration-check.html');
  await page.getByLabel('元の写真').setInputFiles(await solidPhoto(page, '#302018', { w: 256, h: 256 }));
  await expect(page.getByRole('button', { name: '補正して比較', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '補正して比較', exact: true }).click();
  await expect(page.locator('#status')).toContainText('補正完了');
  expect(await page.locator('#after').evaluate((c) => c.width)).toBe(256);
  const px = await page.evaluate(() => ['before', 'after'].map((id) => document.getElementById(id).getContext('2d').getImageData(50, 50, 1, 1).data[0]));
  expect(px[1]).toBeGreaterThan(px[0] + 30);
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '補正画像をPNGで保存' }).click();
  expect((await dl).suggestedFilename()).toMatch(/_restored.png$/);
  await page.evaluate(() => { document.getElementById('run').click(); document.getElementById('cancel').click(); });
  await expect(page.locator('#status')).toContainText('中止しました');
  await expect(page.getByRole('button', { name: '補正画像をPNGで保存' })).toBeDisabled();
  await page.getByRole('button', { name: '補正して比較', exact: true }).click();
  await expect(page.locator('#status')).toContainText('補正完了');
});

test('写真アダプター: ノイズによる誤差を減らし、境界と元データを維持', async ({ page }) => {
  await page.goto('/restoration-check.html');
  const r = await page.evaluate(async () => {
    const { restorePhoto } = await import('/restoration-photo.js');
    const width = 64; const height = 48; const clean = new Uint8ClampedArray(width * height * 4);
    let seed = 1; const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
    const noisy = clean.slice();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4; const color = x < 32 ? [35, 28, 24] : [110, 55, 35];
      for (let c = 0; c < 3; c++) {
        clean[i + c] = color[c]; noisy[i + c] = color[c] + Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()) * 3;
      }
      clean[i + 3] = noisy[i + 3] = 255;
    }
    const original = noisy.slice();
    const run = (data, noise) => restorePhoto({ data, width, height }, { amount: 60, noise });
    const target = await run(clean, 0); const untreated = await run(noisy, 0); const treated = await run(noisy, 3);
    let before = 0; let after = 0; let edge = 0;
    for (let y = 4; y < height - 4; y++) for (let x = 4; x < width - 4; x++) for (let c = 0; c < 3; c++) {
      const i = (y * width + x) * 4 + c;
      before += (untreated.data[i] - target.data[i]) ** 2;
      after += (treated.data[i] - target.data[i]) ** 2;
      if (x === 31 || x === 32) edge = Math.max(edge, Math.abs(treated.data[i] - target.data[i]));
    }
    let limit;
    try { await restorePhoto({ width: 2001, height: 2000, data: new Uint8ClampedArray(2001 * 2000 * 4) }); } catch (e) { limit = e.message; }
    return { ratio: after / before, edge, unchanged: noisy.every((v, i) => v === original[i]), limit };
  });
  console.log('合成画像の品質指標', JSON.stringify(r));
  expect(r.ratio).toBeLessThan(0.5);
  expect(r.edge).toBeLessThan(20);
  expect(r.unchanged).toBe(true);
  expect(r.limit).toContain('400万画素');
});
