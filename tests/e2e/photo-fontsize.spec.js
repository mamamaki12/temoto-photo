// ブラウザの文字の大きさを変えても（設定の「大」「特大」など）、表示が崩れない
import { test, expect } from '@playwright/test';
import { makePhoto } from './photo-helpers.js';

// 文字の大きさの設定は、ページの基準の大きさ（html の font-size）を変えるのと同じ。CSP で <style> を足せないので、テストだけ外す
test.use({ bypassCSP: true, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }); // パソコンの画面として（スマホの表示では、はみ出すと画面全体が縮んで見つけにくい）
test.describe.configure({ timeout: 90000 });

/** 画面の横にはみ出しているもの（横スクロールの中・閉じたメニューの中は除く） */
const overflow = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth; const out = [];
  if (document.scrollingElement.scrollWidth > vw + 1) out.push(`ページの幅 ${document.scrollingElement.scrollWidth} > ${vw}`);
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('details:not([open]) > :not(summary)')) continue;
    const b = el.getBoundingClientRect(); if (!b.width || !b.height) continue;
    let p = el.parentElement; let inScroller = false;
    while (p && p !== document.body) { if (p.matches('.tabs, .subtabs, .looks, .grid-layouts')) { inScroller = true; break; } p = p.parentElement; }
    if (!inScroller && (b.right > vw + 1 || b.left < -1)) out.push(`${el.tagName.toLowerCase()}.${el.className}「${el.textContent.trim().slice(0, 12)}」 ${Math.round(b.left)}〜${Math.round(b.right)}`);
  }
  return out;
});

for (const [px, w, h] of [[16, 561, 759], [20, 561, 759], [24, 390, 844], [32, 375, 740], [24, 1280, 800], [32, 1280, 800]]) {
  test(`文字 ${px}px・幅 ${w}px: 一覧・編集の全部のタブ・メニュー・書き出しで、横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.addInitScript((px) => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = `html{font-size:${px}px}`; document.head.append(s); }), px);
    await page.goto('/');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(`${px}px`);
    expect(await overflow(page)).toEqual([]);
    // 長い名前の写真（見出しに名前が入る）
    await page.locator('#open-file').setInputFiles({ ...await makePhoto(page), name: '成人式の前撮り_振袖_とても長いファイル名のテスト_2027年1月.jpg' });
    await page.waitForFunction(() => window.__temoto.editor?.L, null, { timeout: 30000 });
    // 見出しのボタンが画面に入っている
    await expect(page.getByRole('button', { name: '書き出し', exact: true })).toBeInViewport({ ratio: 1 });
    // 道具のグループと、その中の道具を全部開く
    const groups = page.locator('.rail [role=tab]');
    for (let i = 0; i < await groups.count(); i++) {
      if ((await groups.nth(i).getAttribute('aria-selected')) !== 'true') await groups.nth(i).click();
      await page.waitForTimeout(80);
      expect(await overflow(page), await groups.nth(i).textContent()).toEqual([]);
      const subs = page.locator('.subtabs [role=tab]');
      for (let j = 0; j < await subs.count(); j++) {
        await subs.nth(j).click(); await page.waitForTimeout(80);
        expect(await overflow(page), await subs.nth(j).textContent()).toEqual([]);
      }
    }
    await page.locator('.menu summary').click();
    await page.getByRole('button', { name: 'すべての編集をリセット' }).scrollIntoViewIfNeeded(); // 長いメニューは中でスクロールする
    await expect(page.getByRole('button', { name: 'すべての編集をリセット' })).toBeInViewport({ ratio: 0.95 });
    expect(await overflow(page), 'メニュー').toEqual([]);
    await page.locator('.menu summary').click();
    await page.getByRole('button', { name: '書き出し', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '書き出す', exact: true })).toBeVisible();
    expect(await overflow(page), '書き出し').toEqual([]);
  });
}
