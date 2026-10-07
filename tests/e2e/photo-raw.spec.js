// てもとフォト: RAW ファイル（DNG は現像、NEF/CR3 などは中のプレビュー）を開く
import { test, expect } from '@playwright/test';
import { makePhoto, viewMean, savedExposures } from './photo-helpers.js';
import { makeDng, makePreviewRaw, makeContainerRaw, XYZ_TO_SRGB } from '../unit/raw-fixtures.js';

test.describe.configure({ timeout: 60000 });
const URL0 = '/';
const PATCH = [[200, 70, 60], [60, 90, 170], [70, 150, 80], [128, 128, 128]];
const scene = (w, h) => (x, y) => PATCH[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
const file = (name, bytes, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(bytes) });
async function opened(page) {
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => window.__temoto.editor?.L);
  await page.waitForTimeout(200);
}
const close = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('DNG（可逆JPEG圧縮・ホワイトバランス・色変換つき）を現像して開き、再読み込みしても開ける', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL0);
  const dng = makeDng({ w: 600, h: 400, scene: scene(600, 400), compression: 7, tiles: 128, neutral: [0.5, 1, 0.75], black: 512, white: 16000, colorMatrix: XYZ_TO_SRGB });
  await page.locator('#open-file').setInputFiles(file('IMG_0001.DNG', dng, 'image/x-adobe-dng'));
  await opened(page);
  // 4つの色の面が、元の色で表示される（左上=赤、右上=青、左下=緑、右下=灰色）
  const got = await Promise.all([[0.1, 0.1, 0.4, 0.4], [0.6, 0.1, 0.9, 0.4], [0.1, 0.6, 0.4, 0.9], [0.6, 0.6, 0.9, 0.9]].map((r) => viewMean(page, r)));
  got.forEach((c, i) => expect(close(c, PATCH[i], 6), `${i}: ${c} vs ${PATCH[i]}`).toBe(true));
  await page.getByRole('tab', { name: '情報' }).click();
  await expect(page.locator('.info')).toContainText('RAW（DNG）');
  await expect(page.locator('.info')).toContainText('RAW データから現像');
  await expect(page.locator('.info')).toContainText('TestCam RAW-1');
  // 編集して、一覧に戻って開き直す（保存した RAW をもう一度現像する）
  await page.getByRole('tab', { name: 'ライト' }).click();
  await page.getByLabel('露光量', { exact: true }).evaluate((el) => { el.value = 30; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  // 保存が終わるまで待ってから再読み込み
  await expect.poll(() => savedExposures(page), { timeout: 15000 }).toContain(30);
  await page.reload();
  await expect(page.locator('.lib-badge.raw')).toHaveText('RAW');
  await page.locator('.lib-open').first().click();
  await opened(page);
  expect(await page.evaluate(() => window.__temoto.state.adj.exposure)).toBe(30);
  expect(lum(await viewMean(page, [0.6, 0.6, 0.9, 0.9]))).toBeGreaterThan(140);
  // 書き出しもできる
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '書き出す', exact: true }).click();
  expect((await dl).suggestedFilename()).toBe('IMG_0001_edit.jpg');
  expect(errors).toEqual([]);
});
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('NEF（TIFF型）は中のプレビュー JPEG を使い、向きも反映する・CR3（独自形式）も開ける', async ({ page }) => {
  await page.goto(URL0);
  const photo = await makePhoto(page, { w: 900, h: 600 });
  const nef = makePreviewRaw(new Uint8Array(photo.buffer), { orientation: 6 });
  await page.locator('#open-file').setInputFiles(file('DSC_0002.NEF', nef));
  await opened(page);
  // 横長の写真が、向きの情報で縦長になる
  const ratio = await page.locator('canvas.view').evaluate((c) => c.width / c.height);
  expect(ratio).toBeLessThan(0.8);
  await page.getByRole('tab', { name: '情報' }).click();
  await expect(page.locator('.info')).toContainText('Nikon NEF');
  await expect(page.locator('.info')).toContainText('プレビュー画像（900×600）');
  await page.getByRole('button', { name: '‹ 写真' }).click();
  const cr3 = makeContainerRaw([new Uint8Array(photo.buffer)]);
  await page.locator('#open-file').setInputFiles(file('IMG_0003.CR3', cr3));
  await opened(page);
  const r2 = await page.locator('canvas.view').evaluate((c) => c.width / c.height);
  expect(r2).toBeGreaterThan(1.3);
});

test('対応していない・壊れた RAW は、分かる言葉で知らせる', async ({ page }) => {
  await page.goto(URL0);
  await page.locator('#open-file').setInputFiles(file('broken.CR3', new Uint8Array(5000).map((_, i) => i & 0x7f)));
  await expect(page.locator('.toast').last()).toContainText('このRAWの形式には対応していません');
  await expect(page.locator('.lib-item')).toHaveCount(0);
});
