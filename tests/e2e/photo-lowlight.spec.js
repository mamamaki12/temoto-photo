import { test, expect } from '@playwright/test';
import { solidPhoto, viewMean, openTool } from './photo-helpers.js';

test('写真全体の明るさ: 操作・Undo・再読み込み・PNG書き出し', async ({ page }) => {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#34251c', { w: 128, h: 128 }));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const before = await viewMean(page);
  const control = page.getByLabel('写真全体の明るさ補正', { exact: true });
  await control.fill('70'); await control.dispatchEvent('change');
  await expect.poll(async () => (await viewMean(page))[0]).toBeGreaterThan(before[0] + 35);
  await page.getByRole('button', { name: '元に戻す（Ctrl+Z）' }).click();
  await expect.poll(() => page.evaluate(() => window.__temoto.state.adj.lowlight)).toBe(0);
  await page.getByLabel('写真全体の明るさ補正', { exact: true }).fill('70');
  await page.getByLabel('写真全体の明るさ補正', { exact: true }).dispatchEvent('change');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1200);
  await page.reload();
  // 保存した写真を開き直す
  await page.locator('.lib-open').first().click();
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  expect(await page.evaluate(() => window.__temoto.state.adj.lowlight)).toBe(70);
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'PNG（劣化なし）', exact: true }).click();
  const pending = page.waitForEvent('download');
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await expect(dlg.getByRole('progressbar')).toHaveAttribute('value', '100');
});

test('暗部を上げ、白と色を保つ。元解像度の書き出しにも適用', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { COLOR_SPACE } = await import('/color.js');
    const { Engine } = await import('/engine.js');
    const { defaultState, validateState } = await import('/state.js');
    const { exportFull } = await import('/fullres.js');
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const ctx = c.getContext('2d', { colorSpace: COLOR_SPACE });
    ctx.fillStyle = '#302018'; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#fafafa'; ctx.fillRect(64, 0, 64, 64);
    const eng = new Engine(document.createElement('canvas')); eng.setSource(c, 128, 64);
    const st = defaultState(); st.adj.lowlight = 70;
    const read = (s) => { eng.render(s, 128, 64); const a = new Uint8Array(4); const b = new Uint8Array(4);
      eng.gl.readPixels(20, 32, 1, 1, eng.gl.RGBA, eng.gl.UNSIGNED_BYTE, a);
      eng.gl.readPixels(100, 32, 1, 1, eng.gl.RGBA, eng.gl.UNSIGNED_BYTE, b); return [[...a], [...b]]; };
    const before = read(defaultState()); const after = read(st); eng.dispose();
    const progress = [];
    const r = await exportFull({ full: c, work: c, mask: document.createElement('canvas'), state: st, format: 'image/png', space: COLOR_SPACE, onProgress: (v) => progress.push(v) });
    const bmp = await createImageBitmap(r.blob); ctx.drawImage(bmp, 0, 0);
    return { before, after, exported: [...ctx.getImageData(20, 32, 1, 1, { colorSpace: COLOR_SPACE }).data], size: [bmp.width, bmp.height], progress,
      legacy: validateState({ adj: {} }).adj.lowlight, clamped: validateState({ adj: { lowlight: 999 } }).adj.lowlight };
  });
  expect(result.after[0][0]).toBeGreaterThan(result.before[0][0] + 35);
  expect(result.after[0][0]).toBeGreaterThan(result.after[0][1]);
  expect(result.after[0][1]).toBeGreaterThan(result.after[0][2]);
  expect(result.after[1][0]).toBeGreaterThanOrEqual(result.before[1][0]);
  expect(result.after[1][0]).toBeLessThanOrEqual(255);
  expect(Math.abs(result.exported[0] - result.after[0][0])).toBeLessThan(4);
  expect(result.size).toEqual([128, 64]);
  expect(result.progress.at(-1)).toBe(1);
  expect(result.legacy).toBe(0); expect(result.clamped).toBe(100);
});
