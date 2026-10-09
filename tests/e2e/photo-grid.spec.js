// てもとフォト: 複数の写真を1枚にまとめるグリッド
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { solidPhoto } from './photo-helpers.js';

test.describe.configure({ timeout: 60000 });
const COLORS = { red: [255, 0, 0], green: [0, 200, 0], blue: [0, 0, 255], yellow: [255, 220, 0] };
/** グリッドの表示の、点（0〜1）の色 */
const at = (page, x, y) => page.locator('canvas.grid-view').evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1, { colorSpace: 'srgb' }).data].slice(0, 3), [x, y]);
const is = (got, want, tol = 30) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

async function setup(page) {
  await page.goto('/');
  const files = [];
  for (const [name, c] of Object.entries(COLORS)) files.push(await solidPhoto(page, `rgb(${c.join(',')})`, { name: `${name}.png` }));
  await page.locator('#open-file').setInputFiles(files);
  await expect(page.locator('.lib-item')).toHaveCount(4);
  // 一覧は新しい順なので、名前で並び順を確かめておく
  return page.locator('.lib-name').allTextContents();
}

test('4枚を選んでグリッド: 2×2・すき間の色・レイアウト変更・入れ替え・書き出し・一覧に保存', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const names = await setup(page);
  await page.getByRole('button', { name: 'すべて選択' }).click();
  await page.getByRole('button', { name: /グリッドを作る/ }).click();
  await expect(page.locator('canvas.grid-view')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(200);
  // 2×2: 4つのマスに、選んだ順の写真の色
  const quad = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const got = await Promise.all(quad.map(([x, y]) => at(page, x, y)));
  got.forEach((c, i) => expect(is(c, COLORS[names[i]]), `${i}: ${c} vs ${names[i]}`).toBe(true));
  expect(is(await at(page, 0.5, 0.25), [255, 255, 255], 5)).toBe(true); // すき間は背景の白
  // 背景を黒に
  await page.getByRole('tab', { name: '余白・色' }).click();
  await page.getByRole('button', { name: '背景の色: #000000' }).click();
  expect(is(await at(page, 0.5, 0.25), [0, 0, 0], 5)).toBe(true);
  // 上に大きく
  await page.getByRole('tab', { name: 'レイアウト' }).click();
  await page.getByRole('button', { name: '上に大きく' }).click();
  expect(is(await at(page, 0.2, 0.25), COLORS[names[0]])).toBe(true);
  expect(is(await at(page, 0.8, 0.25), COLORS[names[0]])).toBe(true);
  // 入れ替え: 1つ目のマスを選んで、2つ目（下の左）と入れ替える
  const box = await page.locator('canvas.grid-view').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.25);
  await page.getByRole('button', { name: '⇄ ほかの写真と入れ替え' }).click();
  await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.8);
  expect(is(await at(page, 0.5, 0.25), COLORS[names[1]])).toBe(true);
  expect(is(await at(page, 0.15, 0.8), COLORS[names[0]])).toBe(true);
  // 比率 9:16 で書き出し
  await page.getByRole('tab', { name: 'レイアウト' }).click();
  await page.getByRole('button', { name: '9:16' }).click();
  expect(await page.locator('canvas.grid-view').evaluate((c) => c.width / c.height)).toBeCloseTo(9 / 16, 2);
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: '1080px（SNS）' }).click();
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  const d = await dl;
  const buf = await readFile(await d.path());
  const size = await page.evaluate(async (b64) => { const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))])); return [bmp.width, bmp.height]; }, buf.toString('base64'));
  expect(size).toEqual([608, 1080]);
  // 一覧に保存して、続けて編集できる
  await dlg.getByRole('button', { name: '写真一覧に保存' }).click();
  await expect(dlg).toContainText('写真一覧に保存しました', { timeout: 20000 });
  await dlg.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await expect(page.locator('.lib-item')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('グリッド: 1枚だけ・10枚以上は作れない／写真をドラッグして見える位置を変える', async ({ page }) => {
  await setup(page);
  await page.locator('.lib-check').first().check();
  await expect(page.getByRole('button', { name: /グリッドを作る/ })).toBeDisabled();
  await page.locator('.lib-check').nth(1).check();
  await page.getByRole('button', { name: /グリッドを作る/ }).click();
  await expect(page.locator('canvas.grid-view')).toBeVisible({ timeout: 20000 });
  // 横に2つ（縦長のマスに横長の写真）→ 左右にはみ出しているのでドラッグで動く
  const box = await page.locator('canvas.grid-view').boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5, { steps: 5 }); await page.mouse.up();
  const c = await page.evaluate(() => window.__temoto.grid.grid.cells[0]);
  expect(c.ox).toBeLessThan(-0.3);
  await page.getByLabel('拡大', { exact: true }).evaluate((el) => { el.value = 200; el.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(await page.evaluate(() => window.__temoto.grid.grid.cells[0].zoom)).toBe(2);
});

test('a11y: グリッドの画面（重大な違反なし）', async ({ page }) => {
  const { createRequire } = await import('node:module');
  await setup(page);
  await page.getByRole('button', { name: 'すべて選択' }).click();
  await page.getByRole('button', { name: /グリッドを作る/ }).click();
  await expect(page.locator('canvas.grid-view')).toBeVisible({ timeout: 20000 });
  const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  for (const t of ['レイアウト', '余白・色', '写真']) {
    await page.getByRole('tab', { name: t }).click();
    await page.evaluate(axe);
    const res = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
    const serious = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    expect(serious, `${t}: ${serious.join('\n')}`).toEqual([]);
  }
});

test('グリッド: 写真の間の線をドラッグして大きさの割合を変える（書き出しにも反映・元に戻せる）', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const names = await setup(page);
  await page.getByRole('button', { name: 'すべて選択' }).click();
  await page.getByRole('button', { name: /グリッドを作る/ }).click();
  await expect(page.locator('canvas.grid-view')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(200);
  const box = await page.locator('canvas.grid-view').boundingBox();
  const drag = async ([x0, y0], [x1, y1]) => {
    await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0); await page.mouse.down();
    await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 8 }); await page.mouse.up();
  };
  // 2×2 の縦線を右へ: 左の列（上下とも）が広くなる。写真は選ばれない
  await drag([0.5, 0.25], [0.75, 0.25]);
  expect(is(await at(page, 0.65, 0.25), COLORS[names[0]])).toBe(true);
  expect(is(await at(page, 0.65, 0.75), COLORS[names[2]])).toBe(true);
  expect(is(await at(page, 0.85, 0.25), COLORS[names[1]])).toBe(true);
  expect(await page.evaluate(() => window.__temoto.grid.sel)).toBe(-1);
  // 横線を上へ: 下の段が高くなる
  await drag([0.3, 0.5], [0.3, 0.3]);
  expect(is(await at(page, 0.3, 0.4), COLORS[names[2]])).toBe(true);
  // 端まで動かしても、写真は消えない（最小の大きさで止まる）
  await drag([0.75, 0.75], [1.2, 0.75]);
  expect(is(await at(page, 0.97, 0.75), COLORS[names[3]])).toBe(true);
  // 書き出しにも反映（1:1 の 1080px）
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: '1080px（SNS）' }).click();
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  const buf = await readFile(await (await dl).path());
  const px = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return [[0.65, 0.2], [0.65, 0.45]].map(([u, v]) => [...x.getImageData(Math.floor(u * bmp.width), Math.floor(v * bmp.height), 1, 1, { colorSpace: 'srgb' }).data].slice(0, 3));
  }, buf.toString('base64'));
  expect(is(px[0], COLORS[names[0]])).toBe(true);
  expect(is(px[1], COLORS[names[2]])).toBe(true);
  await dlg.getByRole('button', { name: '閉じる' }).click();
  // 元に戻す
  await page.getByRole('tab', { name: 'レイアウト' }).click();
  await page.getByRole('button', { name: '線の位置を元に戻す' }).click();
  expect(is(await at(page, 0.65, 0.25), COLORS[names[1]])).toBe(true);
  await expect(page.getByRole('button', { name: '線の位置を元に戻す' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
