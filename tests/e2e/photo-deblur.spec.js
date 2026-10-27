import { test, expect } from '@playwright/test';
import { openTool, blurredPhoto } from './photo-helpers.js';

// ブレ補正の AI（約 36MB）を端末の中で動かすので、時間を長めに
test.setTimeout(180_000);

/** 補正した写真（編集用の大きさ）の、左半分の輪郭の強さと、右半分の平らな所の平均 */
const measure = (page) => page.evaluate(() => {
  const E = window.__temoto.editor; const c = E.hq?.canvas || E.base;
  const t = document.createElement('canvas'); t.width = E.W; t.height = E.H; const x = t.getContext('2d'); x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, E.W, E.H).data; let edge = 0; let flat = 0; let n = 0;
  for (let y = 60; y < 240; y++) {
    for (let X = 10; X < 170; X++) { const i = (y * E.W + X) * 4; edge += Math.abs(d[i + 1] - d[i + 5]); }
    for (let X = 220; X < 340; X++) { flat += d[(y * E.W + X) * 4 + 1]; n++; }
  }
  return { edge, flat: flat / n };
});

test('被写体ブレの補正: AI で輪郭をくっきりさせ、平らな所は変えない。残り%のバー・書き出し', async ({ page }) => {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await blurredPhoto(page));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const before = await measure(page);
  await page.evaluate(() => {
    window.__hq = [];
    new MutationObserver(() => { const e = document.querySelector('.hq-status'); if (e && !e.hidden) window.__hq.push(e.textContent); })
      .observe(document.querySelector('.hq-status'), { attributes: true, childList: true, subtree: true, characterData: true });
  });
  const control = page.getByLabel('被写体ブレの補正', { exact: true });
  await control.fill('50'); await control.dispatchEvent('change');
  await page.waitForFunction(() => !!window.__temoto.editor.hq?.canvas, null, { timeout: 150_000 });
  await expect(page.locator('.hq-status')).toBeHidden();
  expect((await page.evaluate(() => window.__hq)).some((t) => /ブレ補正… 残り\d+%/.test(t))).toBe(true);
  const after = await measure(page);
  expect(after.edge).toBeGreaterThan(before.edge * 1.05); // 輪郭がくっきり
  expect(Math.abs(after.flat - before.flat)).toBeLessThan(1.5); // 平らな所はそのまま（色空間の変換で 1 階調ずれることはある）
  // 強さだけを変えたときは、AI を動かし直さない（すぐにできる）
  const t0 = Date.now();
  await control.fill('100'); await control.dispatchEvent('change');
  await page.waitForFunction(() => { const E = window.__temoto.editor; return E.hq?.canvas && JSON.parse(E.hq.key)[2] === 100; }, null, { timeout: 20_000 });
  expect(Date.now() - t0).toBeLessThan(20_000);
  expect((await measure(page)).edge).toBeGreaterThan(after.edge);
  // 書き出し（進捗バーが最後まで進む）
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'PNG（劣化なし）', exact: true }).click();
  const pending = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await expect(dlg).toContainText('✓ できました');
  await expect(dlg.locator('.prog-pop')).toBeHidden();
});

test('被写体ブレの補正: 元の大きさの書き出しでも、編集中と同じ差分を足す（暗所補正・粒と重ねても）', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { COLOR_SPACE } = await import('/color.js');
    const { defaultState } = await import('/state.js');
    const { exportFull } = await import('/fullres.js');
    const { enhanceCanvas, lowlightOptions } = await import('/restoration-photo.js');
    const { deblurResidualFor, finishCanvas, deblurAmount } = await import('/deblur-photo.js');
    const w = 300; const h = 700; // 帯が何本かに分かれる高さ
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { colorSpace: COLOR_SPACE });
    x.fillStyle = '#2a1c14'; x.fillRect(0, 0, w, h);
    x.filter = 'blur(3px)'; x.fillStyle = '#6a4a34'; for (let i = 0; i < 8; i++) x.fillRect(10 + i * 35, 30, 14, 640); x.filter = 'none';
    const st = defaultState(); st.adj.lowlight = 50; st.adj.noise = 50; st.adj.deblur = 60;
    const ll = lowlightOptions(st.adj);
    // 編集中と同じ手順: 暗所補正（粒なし）→ ブレ補正の差分 → 粒
    let grain = 0;
    const lc = await enhanceCanvas(c, w, h, { ...ll, grain: false }, { onGrain: (g) => { grain = g; } });
    const res = await deblurResidualFor(lc, w, h, w, h);
    const view = await finishCanvas(lc, w, h, { res, amount: deblurAmount(st.adj), grain });
    const vd = view.getContext('2d', { colorSpace: COLOR_SPACE }).getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data;
    let resMax = 0; for (const v of res.data) resMax = Math.max(resMax, Math.abs(v));
    const out = await exportFull({ full: c, work: view, lowlightFrom: c, mask: document.createElement('canvas'), state: st, format: 'image/png', space: COLOR_SPACE,
      lowlight: ll, deblur: { res, amount: deblurAmount(st.adj), grain: 0 } }); // 粒の強さは、書き出しでも同じように測る
    const bmp = await createImageBitmap(out.blob); const t = document.createElement('canvas'); t.width = w; t.height = h;
    const tx = t.getContext('2d', { colorSpace: COLOR_SPACE }); tx.drawImage(bmp, 0, 0);
    const ed = tx.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data;
    let diff = 0; for (let i = 0; i < ed.length; i++) if (i % 4 !== 3) diff = Math.max(diff, Math.abs(ed[i] - vd[i]));
    return { diff, resMax, grain, size: [bmp.width, bmp.height] };
  });
  expect(r.resMax).toBeGreaterThan(0.002); // AI が何か直している
  expect(r.grain).toBeGreaterThan(0);
  expect(r.size).toEqual([300, 700]);
  expect(r.diff).toBeLessThanOrEqual(3); // 粒（暗い写真では最大 4 階調）は明るさで強さが変わるので、GPU を通した 1〜2 階調の違いが少し広がる
});

test('被写体ブレの補正: iPhone（メモリの少ない端末）でも、パソコンと同じ差分になる（AI に 1 枚ずつ渡す・組み替えなし・終わったら片付ける）', async ({ browser }) => {
  test.setTimeout(360_000); // AI を 2 回（パソコン・iPhone）動かす
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const run = async (userAgent) => {
    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', ...(userAgent ? { userAgent } : {}) });
    const page = await ctx.newPage(); await page.goto('/');
    const r = await page.evaluate(async () => {
      const { deblurResidualFor } = await import('/deblur-photo.js');
      const w = 320; const h = 300; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      x.fillStyle = '#c9a27e'; x.fillRect(0, 0, w, h); x.fillStyle = '#3b2a20';
      for (let i = 0; i < 7; i++) x.fillRect(20 + i * 40, 30, 14, 240);
      x.filter = 'blur(3px)'; x.drawImage(c, 0, 0); x.filter = 'none';
      const res = await deblurResidualFor(c, w, h, w, h);
      let s = 0; for (let i = 0; i < res.data.length; i++) s += Math.abs(res.data[i]);
      return { data: Array.from(res.data.filter((_, i) => i % 7 === 0)), s };
    });
    await ctx.close();
    return r;
  };
  const pc = await run(null); const ios = await run(IPHONE);
  expect(pc.s).toBeGreaterThan(1); // 直している
  let mx = 0; for (let i = 0; i < pc.data.length; i++) mx = Math.max(mx, Math.abs(pc.data[i] - ios.data[i]));
  expect(mx).toBeLessThan(1 / 255); // 違いは計算の丸めの分だけ（8bit の 1 階調より小さい）
});
