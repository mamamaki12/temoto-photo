// AI（端末の中で動く MediaPipe）で、美肌の肌の範囲と、リップの唇の範囲を見つける
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTool } from './photo-helpers.js';

test.describe.configure({ timeout: 90000 });
const PORTRAIT = { name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: await readFile(new URL('../fixtures/portrait.jpg', import.meta.url)) };
// この写真の顔: ほお (0.43, 0.49)、口の中心 (0.513, 0.578)、唇の左右 0.472〜0.554、顔の幅は短い辺の 35%
async function open(page) {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(PORTRAIT);
  await page.waitForFunction(() => window.__temoto.editor?.L, null, { timeout: 30000 });
}
/** 編集用の画素（元写真の座標 0〜1）を読む */
const srcPixel = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.__temoto.editor; const c = E.src || E.base; const cv = document.createElement('canvas'); cv.width = E.W; cv.height = E.H;
  const g = cv.getContext('2d'); g.drawImage(c, 0, 0); return [...g.getImageData(Math.round(x * (E.W - 1)), Math.round(y * (E.H - 1)), 1, 1).data.slice(0, 3)];
}, [x, y]);

test('美肌: AI で人物の肌だけを見分け、背景・髪・服は変えない', async ({ page }) => {
  await open(page);
  const bg0 = await srcPixel(page, 0.08, 0.1); const hair0 = await srcPixel(page, 0.3, 0.3); const cheek0 = await srcPixel(page, 0.43, 0.49);
  await openTool(page, '美肌');
  const view = await page.locator('canvas.view').boundingBox();
  const L = await page.evaluate(() => { const E = window.__temoto.editor; return { ix: E.L.ix / E.view.width, iy: E.L.iy / E.view.height, iw: E.L.iw / E.view.width, ih: E.L.ih / E.view.height }; });
  await page.getByRole('button', { name: 'しっかり', exact: true }).click();
  await page.mouse.click(view.x + view.width * (L.ix + L.iw * 0.43), view.y + view.height * (L.iy + L.ih * 0.49));
  await page.waitForFunction(async () => { const m = await import('/skinseg.js'); const E = window.__temoto.editor; return !!E.baseData && !!m.skinSegFor(E.baseData) && !document.querySelector('.stage.busy'); }, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  expect(lum(await srcPixel(page, 0.43, 0.49))).toBeGreaterThan(lum(cheek0) + 3); // ほおは明るく
  const bg1 = await srcPixel(page, 0.08, 0.1); const hair1 = await srcPixel(page, 0.3, 0.3);
  for (let c = 0; c < 3; c++) { expect(Math.abs(bg1[c] - bg0[c])).toBeLessThan(3); expect(Math.abs(hair1[c] - hair0[c])).toBeLessThan(3); } // 背景・髪は変わらない
});

test('リップ: 口のまわりを大ざっぱになぞっても、AI で見つけた唇だけに色がのる。色合い・濃さ・明るさを選べる', async ({ page }) => {
  await open(page);
  const skin0 = await srcPixel(page, 0.513, 0.62); // 唇の下の肌（ブラシの中）
  await openTool(page, '目元・歯');
  await page.getByRole('button', { name: 'リップ', exact: true }).click();
  await page.getByRole('button', { name: /レッド/ }).click();
  for (const label of ['色合い', '色の濃さ', '色の明るさ']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  await page.getByLabel('ブラシの大きさ', { exact: true }).evaluate((el) => { el.value = 6; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const view = await page.locator('canvas.view').boundingBox();
  const L = await page.evaluate(() => { const E = window.__temoto.editor; return { ix: E.L.ix / E.view.width, iy: E.L.iy / E.view.height, iw: E.L.iw / E.view.width, ih: E.L.ih / E.view.height }; });
  const at = (x, y) => [view.x + view.width * (L.ix + L.iw * x), view.y + view.height * (L.iy + L.ih * y)];
  const lip0 = await srcPixel(page, 0.513, 0.592);
  await page.mouse.move(...at(0.45, 0.585)); await page.mouse.down(); await page.mouse.move(...at(0.58, 0.585), { steps: 20 }); await page.mouse.up();
  expect(await page.evaluate(() => document.querySelectorAll('.handles .heal-path').length)).toBe(0); // なぞった線は、AI を待たずにすぐ消える
  await page.waitForFunction(() => { const r = window.__temoto.state.retouch; return r.length && !document.querySelector('.stage.busy'); }, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const op = (await page.evaluate(() => window.__temoto.state.retouch))[0];
  expect(op.type).toBe('lip'); expect(op.lips.length).toBe(1); // 唇を見つけた
  const lip1 = await srcPixel(page, 0.513, 0.592); const skin1 = await srcPixel(page, 0.513, 0.62);
  expect(lip1[0] - lip1[1]).toBeGreaterThan(lip0[0] - lip0[1] + 15); // 下唇は赤く
  for (let c = 0; c < 3; c++) expect(Math.abs(skin1[c] - skin0[c])).toBeLessThan(3); // 唇の下の肌は変わらない
});

test('リップ: 2本指での拡大・移動はリップの範囲にしない（2本目の指が写真の外・下のパネルの上でも）。1本指ではなぞれる', async ({ page }) => {
  await open(page);
  await openTool(page, '目元・歯');
  await page.getByRole('button', { name: 'リップ', exact: true }).click();
  const v = await page.locator('canvas.view').boundingBox();
  const cx = v.x + v.width / 2; const cy = v.y + v.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  const n = () => page.evaluate(() => window.__temoto.state.retouch.length);
  // ① 写真の上で 2 本指を広げる（1 本目は少しずれてから 2 本目が着く）。拡大はされ、リップは付かない
  await T('touchStart', [[cx - 10, cy, 0]]);
  for (let i = 1; i <= 3; i++) await T('touchMove', [[cx - 10 - i * 4, cy, 0]]);
  await T('touchStart', [[cx - 22, cy, 0], [cx + 30, cy, 1]]);
  for (let i = 1; i <= 8; i++) await T('touchMove', [[cx - 22 - i * 6, cy, 0], [cx + 30 + i * 6, cy, 1]]);
  await T('touchEnd', [[cx + 78, cy, 1]]); // 1 本目を先に離し、残った指を動かす
  for (let i = 1; i <= 4; i++) await T('touchMove', [[cx + 78 - i * 8, cy, 1]]);
  await T('touchEnd', []);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__temoto.editor.zoom)).toBeGreaterThan(1.5);
  expect(await n()).toBe(0);
  // ② 1 本目でなぞっている間に、2 本目を写真の外（下のパネルの上）に置く
  const zb = await page.locator('.side').boundingBox();
  await T('touchStart', [[cx, cy, 0]]);
  for (let i = 1; i <= 5; i++) await T('touchMove', [[cx + i * 6, cy, 0]]);
  await T('touchStart', [[cx + 30, cy, 0], [zb.x + zb.width / 2, zb.y + zb.height / 2, 1]]);
  for (let i = 1; i <= 5; i++) await T('touchMove', [[cx + 30 + i * 6, cy, 0], [zb.x + zb.width / 2, zb.y + zb.height / 2, 1]]);
  await T('touchEnd', [[zb.x + zb.width / 2, zb.y + zb.height / 2, 1]]);
  await T('touchEnd', []);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !document.querySelector('.stage.busy'), null, { timeout: 60000 }); // 唇を探す AI が終わるまで待つ
  expect(await n()).toBe(0);
  // ③ 指を全部離したら、1 本指でなぞれる
  await T('touchStart', [[cx - 20, cy, 0]]);
  for (let i = 1; i <= 8; i++) await T('touchMove', [[cx - 20 + i * 5, cy, 0]]);
  await T('touchEnd', []);
  await page.waitForFunction(() => window.__temoto.state.retouch.length && !document.querySelector('.stage.busy'), null, { timeout: 60000 });
  expect(await n()).toBe(1);
});
