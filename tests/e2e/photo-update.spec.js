// アプリの更新: 一覧の見出しと「⋯」メニューに更新ボタンがあり、新しい版がなければ「最新の版です」と出す
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makePhoto } from './photo-helpers.js';

test('更新ボタン: 版を確かめて、最新なら知らせる（一覧・編集画面のメニュー）', async ({ page }) => {
  const version = (await readFile(new URL('../../app.js', import.meta.url), 'utf8')).match(/const VERSION = '([^']+)'/)[1];
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  // Service Worker が画面と同じ版を答える
  expect(await page.evaluate(() => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data.version); navigator.serviceWorker.controller.postMessage({ type: 'version' }, [ch.port2]); }))).toBe(version);
  const btn = page.locator('.lib-head').getByRole('button', { name: `アプリの更新を確認（今の版 ${version}）` });
  await btn.click();
  await expect(page.locator('.toast').filter({ hasText: `最新の版です（${version}）` })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.update-bar')).toHaveCount(0);
  await page.locator('#open-file').setInputFiles(await makePhoto(page));
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await page.locator('details.menu > summary').click();
  await expect(page.locator('.menu-list .app-update')).toHaveText(`アプリの更新を確認（${version}）`);
});
