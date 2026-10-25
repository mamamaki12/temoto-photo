import { test, expect } from '@playwright/test';
import { openTool } from './photo-helpers.js';

// ブレ補正の AI（約 36MB）を端末の中で動かすので、時間を長めに
test.setTimeout(180_000);

/** 横に流れた縞（左半分）と、平らな所（右半分）の写真 */
async function blurredPhoto(page) {
  const b64 = await page.evaluate(async () => {
    const w = 360; const h = 300; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.fillStyle = '#c9a27e'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#3b2a20'; for (let i = 0; i < 6; i++) x.fillRect(20 + i * 26, 40, 10, 220);
    // 横に 12 画素ぶれた（動いた）ように、ずらして重ねる
    const src = x.getImageData(0, 0, w / 2, h); const out = x.createImageData(w / 2, h);
    for (let y = 0; y < h; y++) for (let X = 0; X < w / 2; X++) for (let ch = 0; ch < 4; ch++) {
      let s = 0; for (let k = -6; k <= 6; k++) s += src.data[(y * (w / 2) + Math.min(w / 2 - 1, Math.max(0, X + k))) * 4 + ch];
      out.data[(y * (w / 2) + X) * 4 + ch] = s / 13;
    }
    x.putImageData(out, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return { name: 'blur.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

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
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await expect(dlg.getByRole('progressbar')).toHaveAttribute('value', '100');
});

test('被写体ブレの補正: 元の大きさの書き出しでも、編集中と同じ差分を足す（暗所補正・粒と重ねても）', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { COLOR_SPACE } = await import('/color.js');
    const { defaultState } = await import('/state.js');
    const { exportFull } = await import('/fullres.js');
    const { enhanceCanvas, lowlightOptions } = await import('/restoration-photo.js');
    const { deblurResidualFor, finishCanvas, deblurAmount } = await import('/deblur-photo.js');
    const { grainFor } = await import('/restoration-lowlight.js');
    const w = 300; const h = 700; // 帯が何本かに分かれる高さ
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { colorSpace: COLOR_SPACE });
    x.fillStyle = '#2a1c14'; x.fillRect(0, 0, w, h);
    x.filter = 'blur(3px)'; x.fillStyle = '#6a4a34'; for (let i = 0; i < 8; i++) x.fillRect(10 + i * 35, 30, 14, 640); x.filter = 'none';
    const st = defaultState(); st.adj.lowlight = 50; st.adj.noise = 50; st.adj.deblur = 60;
    const ll = lowlightOptions(st.adj);
    // 編集中と同じ手順: 暗所補正（粒なし）→ ブレ補正の差分 → 粒
    const lc = await enhanceCanvas(c, w, h, { ...ll, grain: false });
    const res = await deblurResidualFor(lc, w, h, w, h);
    const view = await finishCanvas(lc, w, h, { res, amount: deblurAmount(st.adj), grain: grainFor(ll.nr) });
    const vd = view.getContext('2d', { colorSpace: COLOR_SPACE }).getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data;
    let resMax = 0; for (const v of res.data) resMax = Math.max(resMax, Math.abs(v));
    const out = await exportFull({ full: c, work: view, lowlightFrom: c, mask: document.createElement('canvas'), state: st, format: 'image/png', space: COLOR_SPACE,
      lowlight: ll, deblur: { res, amount: deblurAmount(st.adj), grain: grainFor(ll.nr) } });
    const bmp = await createImageBitmap(out.blob); const t = document.createElement('canvas'); t.width = w; t.height = h;
    const tx = t.getContext('2d', { colorSpace: COLOR_SPACE }); tx.drawImage(bmp, 0, 0);
    const ed = tx.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data;
    let diff = 0; for (let i = 0; i < ed.length; i++) if (i % 4 !== 3) diff = Math.max(diff, Math.abs(ed[i] - vd[i]));
    return { diff, resMax, size: [bmp.width, bmp.height] };
  });
  expect(r.resMax).toBeGreaterThan(0.002); // AI が何か直している
  expect(r.size).toEqual([300, 700]);
  expect(r.diff).toBeLessThanOrEqual(2);
});

test('被写体ブレの補正（大きなブレ）: 人物の写真では強い AI も通すが、顔は今までと同じ', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { deblurResidualFor } = await import('/deblur-photo.js');
    const img = new Image(); img.src = '/tests/fixtures/portrait.jpg'; await img.decode();
    const w = img.naturalWidth; const h = img.naturalHeight;
    const pct = []; const a = await deblurResidualFor(img, w, h, w, h, { onProgress: (p) => pct.push(p) });
    const b = await deblurResidualFor(img, w, h, w, h, { strong: false });
    // 顔（目・鼻・口のあたり）と、首・服のあたりで、強い AI の分だけ変わった量
    const diff = (x0, y0, x1, y1) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 3; s = Math.max(s, Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1])); } return s; };
    return { face: diff(270, 150, 370, 260), body: diff(100, 330, 540, 427), last: pct.at(-1), n: pct.length };
  });
  expect(r.face).toBeLessThan(1e-6); // 顔には当てない
  expect(r.body).toBeGreaterThan(0); // 首・服には当てる
  expect(r.n).toBeGreaterThan(3); expect(r.last).toBeGreaterThan(0.95); // 残り%のバーが進む
});
