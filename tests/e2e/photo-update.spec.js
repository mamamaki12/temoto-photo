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

test('Service Worker: 写真を処理する Worker の中からも、外のサイトへは通信できない（同じサイトのファイルは読める）', async ({ page, context }) => {
  // 止めていなければ届くように、外のサイトの返事を用意しておく（本物の外には出ない）
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, body: 'ok' }));
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const probe = (url) => page.evaluate((url) => new Promise((res) => {
    const w = new Worker('./tests/fixtures/net-probe-worker.js'); w.onmessage = (e) => { w.terminate(); res(e.data); }; w.onerror = () => res('error'); w.postMessage(url);
  }), url);
  expect(await probe('https://example.com/upload')).toBe('blocked');
  expect(await probe(new URL('vendor/deblur/LICENSE.txt', page.url()).href)).toBe('ok 200'); // AI のモデルなど、同じサイトのファイルは読める
});

test('Service Worker: 版を上げたときに消すのは、このアプリの前の版のキャッシュだけ（同じアドレスのほかのアプリのキャッシュは残す）', async ({ page }) => {
  // Service Worker が入る前に、同じアドレスのほかのアプリのキャッシュと、このアプリの前の版のキャッシュを作っておく
  await page.goto('/icon.svg');
  await page.evaluate(async () => { for (const k of ['other-app-v3', 'temoto-photo-v1', 'temoto-vendor-00000000', 'temoto-faceai-old']) await (await caches.open(k)).put(`/${k}`, new Response('x')); });
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller); // 前の版のキャッシュを片付けてから、画面を受け持つ
  const keys = await page.evaluate(() => caches.keys());
  expect(keys).toContain('other-app-v3');
  expect(keys).toContain('temoto-faceai-old'); // 顔専用 AI は face-worker.js が自分で入れ替える
  expect(keys).not.toContain('temoto-photo-v1');
  expect(keys).not.toContain('temoto-vendor-00000000');
});
