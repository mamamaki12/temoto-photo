import { test, expect } from '@playwright/test';
import { openTool, blurredPhoto } from './photo-helpers.js';

// 仕上げ（ノイズ除去と明るさ補正・ブレ補正）の途中でアプリが落ちたとき（iPhone でメモリが足りないとき）
test.setTimeout(240_000);

/**
 * ページが落ちて、読み込み直されたのと同じにする（iPhone でメモリが足りずに落とされたときは pagehide が来ないので、
 * 編集していた写真・計算中の印が残る。ここでは、閉じたときの片付けで消されないようにしてから読み込み直す）
 */
async function crashAndReload(page) {
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (/^temoto:(editing|heavy)$/.test(k)) return; return set.call(this, k, v); };
  });
  await page.goto('/');
  return page;
}
const stageOf = (page, id) => page.evaluate(async (id) => { const r = await (await import('/db.js')).getStage(id); return r ? Object.keys(r).filter((k) => ['ll', 'db', 'wh'].includes(k) && r[k]) : null; }, id);

async function openBlurred(page) {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await blurredPhoto(page));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
}
const set = async (page, label, v) => { const c = page.getByLabel(label, { exact: true }); await c.fill(String(v)); await c.dispatchEvent('change'); };

test('途中で落ちたら、次に開いたとき済んだ段（ノイズ除去と明るさ補正）から続ける。終わったら途中の結果は消す', async ({ page }) => {
  await openBlurred(page);
  const id = await page.evaluate(() => window.__temoto.editor.id);
  await set(page, '写真全体の明るさ補正', 60);
  await set(page, '被写体ブレの補正', 50);
  // ノイズ除去と明るさ補正が済んで保存されたら（ブレ補正の途中で）落とす
  await expect.poll(() => stageOf(page, id), { timeout: 120_000 }).toContain('ll');
  expect(await page.evaluate(() => !!window.__temoto.editor.hq?.canvas)).toBe(false);
  const p2 = await crashAndReload(page);
  await p2.waitForFunction((id) => window.__temoto?.editor?.id === id && window.__temoto.editor.L, id); // 編集していた写真に戻る
  expect(await p2.evaluate(() => window.__temoto.state.adj.deblur)).toBe(50); // 編集の値は残っている
  // 保存しておいた段を使う（ノイズ除去と明るさ補正はやり直さない）
  expect(await p2.evaluate(() => !!window.__temoto.editor.hqCache?.lls)).toBe(true);
  const steps = [];
  await p2.exposeFunction('__step', (t) => steps.push(t));
  await p2.evaluate(() => new MutationObserver(() => { const e = document.querySelector('.hq-status'); if (e && !e.hidden) window.__step(e.textContent); })
    .observe(document.querySelector('.hq-status'), { attributes: true, childList: true, subtree: true, characterData: true }));
  await p2.waitForFunction(() => !!window.__temoto.editor.hq?.canvas, null, { timeout: 180_000 });
  expect(steps.some((t) => /ノイズ除去/.test(t))).toBe(false);
  // 仕上げの結果を保存したら、途中の結果は消す
  await expect.poll(() => stageOf(p2, id), { timeout: 30_000 }).toBeNull();
  // 落ちた印も消えている
  expect(await p2.evaluate(() => localStorage.getItem('temoto:heavy'))).toBe('null');
});

test('同じ計算の途中で 2 回落ちたら、自動では計算せず「続ける」を出す', async ({ page }) => {
  await openBlurred(page);
  const { id } = await page.evaluate(() => ({ id: window.__temoto.editor.id }));
  await set(page, '被写体ブレの補正', 50);
  await page.waitForFunction(() => !!window.__temoto.editor.hq?.canvas, null, { timeout: 180_000 });
  const key = await page.evaluate(() => window.__temoto.editor.hq.key);
  // 2 回落ちた後と同じ状態にする（結果は保存されていない・落ちた印が 2 回）
  await page.waitForTimeout(2500);
  await page.evaluate(async ({ id, key }) => { await (await import('/db.js')).deleteHq(id); localStorage.setItem('temoto:heavy', JSON.stringify({ id, key, n: 2, t: 1 })); }, { id, key });
  const p2 = await crashAndReload(page);
  await p2.waitForFunction((id) => window.__temoto?.editor?.id === id && window.__temoto.editor.L, id);
  const note = p2.getByRole('region', { name: 'お知らせ' });
  await expect(note).toContainText('アプリが 2 回止まりました');
  await p2.waitForTimeout(1500);
  expect(await p2.evaluate(() => !!window.__temoto.editor.hq?.canvas)).toBe(false); // 計算していない
  await expect(p2.locator('.hq-status')).toBeHidden();
  await note.getByRole('button', { name: '続ける' }).click();
  await expect(note).toBeHidden();
  await p2.waitForFunction(() => !!window.__temoto.editor.hq?.canvas, null, { timeout: 180_000 });
});
