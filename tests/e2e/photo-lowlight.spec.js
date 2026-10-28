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
  await dlg.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await expect(dlg).toContainText('✓ できました');
  await expect(dlg.locator('.prog-pop')).toBeHidden();
});

test('開き直したとき、前に計算した明るさ補正の結果をすぐ見せる（計算し直さない）', async ({ page }) => {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#34251c', { w: 128, h: 128 }));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const control = page.getByLabel('写真全体の明るさ補正', { exact: true });
  await control.fill('70'); await control.dispatchEvent('change');
  await page.waitForFunction(() => window.__temoto.editor.hq?.canvas);
  const bright = await viewMean(page);
  // 補正の結果が保存されるまで待つ
  await expect.poll(() => page.evaluate(async () => !!(await (await import('/db.js')).getHq(window.__temoto.editor.id))), { timeout: 10000 }).toBe(true);
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await page.reload();
  await page.locator('.lib-open').first().click();
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  expect(await page.evaluate(() => window.__temoto.editor.hq?.saved)).toBe(true);
  expect(await page.evaluate(() => !!window.__temoto.editor.hq?.ctrl)).toBe(false); // 計算し直していない
  const again = await viewMean(page);
  expect(Math.abs(again[0] - bright[0])).toBeLessThan(1.5);
  // 値を変えたら計算し直し、補正をやめたら保存した結果も消す
  await openTool(page, '自動補正');
  await page.getByLabel('写真全体の明るさ補正', { exact: true }).fill('0');
  await page.getByLabel('写真全体の明るさ補正', { exact: true }).dispatchEvent('change');
  await expect.poll(() => page.evaluate(async () => !!(await (await import('/db.js')).getHq(window.__temoto.editor.id))), { timeout: 10000 }).toBe(false);
});

test('前の版で保存した補正の結果は使わず、計算し直す（補正の計算を直したら、開き直した写真にも効く）', async ({ page }) => {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#34251c', { w: 128, h: 128 }));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const control = page.getByLabel('写真全体の明るさ補正', { exact: true });
  await control.fill('70'); await control.dispatchEvent('change');
  await page.waitForFunction(() => window.__temoto.editor.hq?.canvas);
  await expect.poll(() => page.evaluate(async () => !!(await (await import('/db.js')).getHq(window.__temoto.editor.id))), { timeout: 10000 }).toBe(true);
  // 保存した結果を、前の版で保存したものに書き換える
  await page.evaluate(async () => { const db = await import('/db.js'); const id = window.__temoto.editor.id; const rec = await db.getHq(id); await db.putHq(id, { ...rec, ver: '1.31.3' }); });
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await page.reload();
  await page.locator('.lib-open').first().click();
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  expect(await page.evaluate(() => !!window.__temoto.editor.hq?.saved)).toBe(false);
  await page.waitForFunction(() => { const E = window.__temoto.editor; return E.hq?.canvas && !E.hq.ctrl; }); // 計算し直した
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

test('暗い写真の補正: ノイズを取ってから明るくする処理を、編集画面から Worker で実行し、残り%のバーを出す', async ({ page }) => {
  await page.goto('/');
  // 暗くてざらついた写真（左右で明るさの違う布と、ノイズ）
  const b64 = await page.evaluate(async () => {
    const w = 480; const h = 360; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    const img = x.createImageData(w, h); let seed = 7;
    const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647 - 0.5; };
    for (let i = 0; i < w * h; i++) {
      const base = (i % w) < w / 2 ? [34, 22, 14] : [70, 46, 28]; const n = rnd() * 16;
      img.data.set([base[0] + n, base[1] + n, base[2] + n, 255], i * 4);
    }
    x.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await page.locator('#open-file').setInputFiles({ name: 'dark.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const before = await viewMean(page);
  // バーの「残り○%」を記録する
  await page.evaluate(() => {
    window.__hq = [];
    new MutationObserver(() => { const e = document.querySelector('.hq-status'); if (e && !e.hidden) window.__hq.push(e.textContent); })
      .observe(document.querySelector('.hq-status'), { attributes: true, childList: true, subtree: true, characterData: true });
  });
  for (const label of ['ノイズ軽減', '写真全体の明るさ補正']) {
    const control = page.getByLabel(label, { exact: true }); await control.fill('50'); await control.dispatchEvent('change');
  }
  await page.waitForFunction(() => !!window.__temoto.editor.hq?.canvas, null, { timeout: 30_000 });
  await expect(page.locator('.hq-status')).toBeHidden();
  const seen = await page.evaluate(() => window.__hq);
  expect(seen.some((t) => /残り\d+%/.test(t))).toBe(true);
  // 明るくなり、ざらつきが減っている（GPU の簡易版は二重にかけない）
  await expect.poll(async () => (await viewMean(page))[0]).toBeGreaterThan(before[0] + 30);
  const spread = await page.evaluate(() => {
    const c = document.querySelector('canvas.view'); const x = c.getContext('2d');
    const d = x.getImageData(Math.floor(c.width * 0.1), Math.floor(c.height * 0.2), Math.floor(c.width * 0.3), Math.floor(c.height * 0.6), { colorSpace: 'srgb' }).data;
    let s = 0; let s2 = 0; const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { s += d[i + 1]; s2 += d[i + 1] ** 2; }
    return { sd: Math.sqrt(s2 / n - (s / n) ** 2), mean: s / n };
  });
  // 元のノイズ（標準偏差 約 4.6 階調）を明るくした分だけ増やすと 15 階調を超える。それより十分小さい
  expect(spread.sd).toBeLessThan(8);
  // 値を 0 に戻すと、元の写真に戻る
  for (const label of ['ノイズ軽減', '写真全体の明るさ補正']) {
    const control = page.getByLabel(label, { exact: true }); await control.fill('0'); await control.dispatchEvent('change');
  }
  await expect.poll(async () => Math.abs((await viewMean(page))[0] - before[0])).toBeLessThan(2);
  await expect.poll(() => page.evaluate(() => window.__temoto.editor.srcHQ)).toBe(false);
  // もう一度かけて、書き出し（進捗バーが最後まで進む）
  await page.getByRole('button', { name: '元に戻す（Ctrl+Z）' }).click();
  await page.getByRole('button', { name: '元に戻す（Ctrl+Z）' }).click();
  await page.waitForFunction(() => !!window.__temoto.editor.hq?.canvas, null, { timeout: 30_000 });
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'PNG（劣化なし）', exact: true }).click();
  const pending = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await expect(dlg).toContainText('✓ できました');
  await expect(dlg.locator('.prog-pop')).toBeHidden();
});

test('暗い写真の補正: 明るさ補正だけを変えたときは、ノイズ除去をやり直さずに仕上げ直す（最初から処理したのと同じ）。動かしている間は見本を見せる', async ({ page }) => {
  await page.goto('/');
  const b64 = await page.evaluate(async () => {
    const w = 480; const h = 360; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    const img = x.createImageData(w, h); let seed = 11;
    const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647 - 0.5; };
    for (let i = 0; i < w * h; i++) { const base = (i % w) < w / 2 ? [34, 22, 14] : [70, 46, 28]; const n = rnd() * 16; img.data.set([base[0] + n, base[1] + n, base[2] + n, 255], i * 4); }
    x.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await page.locator('#open-file').setInputFiles({ name: 'dark.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const done = (light) => page.waitForFunction((l) => { const E = window.__temoto.editor; return E.hq?.canvas && !E.hq.ctrl && JSON.parse(E.hq.key)[1] === l; }, light, { timeout: 30_000 });
  const light = page.getByLabel('写真全体の明るさ補正', { exact: true });
  for (const label of ['ノイズ軽減', '写真全体の明るさ補正']) { const c = page.getByLabel(label, { exact: true }); await c.fill('50'); await c.dispatchEvent('change'); }
  await done(50);
  expect(await page.evaluate(() => window.__temoto.editor.hqCache.den.bands.some(Boolean))).toBe(true);
  // 動かしている間（指を離す前）は、ノイズを取った写真に新しい明るさを当てた見本を見せる（元の写真＋簡易版に戻らない）
  const before = await viewMean(page);
  await light.fill('80');
  await page.waitForFunction(() => { const E = window.__temoto.editor; return E.toneShown && E.tone?.light === 80; });
  await expect.poll(async () => (await viewMean(page))[0]).toBeGreaterThan(before[0] + 5);
  await light.dispatchEvent('change');
  await done(80);
  // 最初から計算したもの（途中の結果を取っておかない）と 1 ビットも違わない
  const same = await page.evaluate(async () => {
    const E = window.__temoto.editor; const { enhanceCanvas, lowlightOptions } = await import('/restoration-photo.js');
    const ref = await enhanceCanvas(E.base, E.W, E.H, lowlightOptions(E.state.adj));
    const a = E.hq.canvas.getContext('2d').getImageData(0, 0, E.W, E.H).data; const b = ref.getContext('2d').getImageData(0, 0, E.W, E.H).data;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  });
  expect(same).toBe(true);
  expect(await page.evaluate(() => window.__temoto.editor.toneShown)).toBeFalsy();
});

test('暗い写真の補正: 元の大きさの書き出しでも、帯ごとに同じ補正を当てる', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { COLOR_SPACE } = await import('/color.js');
    const { defaultState } = await import('/state.js');
    const { exportFull } = await import('/fullres.js');
    const { enhanceCanvas, lowlightOptions } = await import('/restoration-photo.js');
    const w = 300; const h = 1100; // 帯が何本かに分かれる高さ
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { colorSpace: COLOR_SPACE });
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#120c08'); g.addColorStop(1, '#4a3020'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    const st = defaultState(); st.adj.lowlight = 50; st.adj.noise = 50;
    const progress = [];
    const res = await exportFull({ full: c, work: c, mask: document.createElement('canvas'), state: st, format: 'image/png', space: COLOR_SPACE, lowlight: lowlightOptions(st.adj), onProgress: (v) => progress.push(v) });
    const bmp = await createImageBitmap(res.blob); const o = document.createElement('canvas'); o.width = w; o.height = h;
    const ox = o.getContext('2d', { colorSpace: COLOR_SPACE }); ox.drawImage(bmp, 0, 0);
    const ref = await enhanceCanvas(c, w, h, lowlightOptions(st.adj));
    const a = ox.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data; const b = ref.getContext('2d', { colorSpace: COLOR_SPACE }).getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data;
    let max = 0; for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    const src = x.getImageData(150, 550, 1, 1, { colorSpace: COLOR_SPACE }).data[0];
    return { max, before: src, after: a[(550 * w + 150) * 4], progress, size: [bmp.width, bmp.height] };
  });
  expect(r.size).toEqual([300, 1100]);
  expect(r.after).toBeGreaterThan(r.before + 30);
  expect(r.max).toBeLessThanOrEqual(2); // 編集画面で計算したもの（同じ大きさ）と同じ
  expect(r.progress.at(-1)).toBe(1);
  for (let i = 1; i < r.progress.length; i++) expect(r.progress[i]).toBeGreaterThanOrEqual(r.progress[i - 1]);
});

test('暗い写真の補正は、明暗ブラシ・露光量と重ねて使え、書き出しにも全部のる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#2a1c14', { w: 400, h: 300 }));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  await openTool(page, '自動補正');
  const c = page.getByLabel('写真全体の明るさ補正', { exact: true }); await c.fill('50'); await c.dispatchEvent('change');
  await page.waitForFunction(() => window.__temoto.editor.srcHQ, null, { timeout: 30_000 });
  const R = [0.35, 0.4, 0.65, 0.6]; const other = [0, 0, 0.15, 0.15];
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const base = lum(await viewMean(page, R));
  // 明暗ブラシ（明るく）でなぞる
  await openTool(page, '明暗');
  await page.getByLabel('ブラシの大きさ', { exact: true }).evaluate((el) => { el.value = 15; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  const b = await page.locator('canvas.view').boundingBox();
  await page.mouse.move(b.x + b.width * 0.36, b.y + b.height * 0.5); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.64, b.y + b.height * 0.5, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(300);
  expect((await page.evaluate(() => window.__temoto.state.retouch)).map((o) => o.type)).toEqual(['dodge']);
  await expect.poll(async () => lum(await viewMean(page, R))).toBeGreaterThan(base + 4);
  // 露光量も
  await openTool(page, 'ライト');
  const e = page.getByLabel('露光量', { exact: true }).first(); await e.fill('20'); await e.dispatchEvent('change');
  await expect.poll(async () => lum(await viewMean(page, other))).toBeGreaterThan(base + 4);
  expect(await page.evaluate(() => window.__temoto.editor.srcHQ)).toBe(true); // ブラシを足しても、補正したものの上に重なる
  const view = await viewMean(page, R); const viewOther = await viewMean(page, other);
  // 書き出し（同じ大きさ）
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'PNG（劣化なし）', exact: true }).click();
  const pending = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  const file = await (await pending).path();
  const buf = (await import('node:fs')).readFileSync(file).toString('base64');
  const out = await page.evaluate(async ({ buf, R, other }) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(buf), (ch) => ch.charCodeAt(0))], { type: 'image/png' })); // 通信を禁止する CSP なので、data: URL は読めない
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height; const x = cv.getContext('2d'); x.drawImage(bmp, 0, 0);
    const mean = ([x0, y0, x1, y1]) => { const d = x.getImageData(Math.floor(cv.width * x0), Math.floor(cv.height * y0), Math.max(1, Math.floor(cv.width * (x1 - x0))), Math.max(1, Math.floor(cv.height * (y1 - y0))), { colorSpace: 'srgb' }).data; let r = 0; let g = 0; let bb = 0; const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bb += d[i + 2]; } return [r / n, g / n, bb / n]; };
    return { R: mean(R), other: mean(other) };
  }, { buf, R, other });
  expect(Math.abs(lum(out.R) - lum(view))).toBeLessThan(6);
  expect(Math.abs(lum(out.other) - lum(viewOther))).toBeLessThan(6);
  expect(lum(out.R)).toBeGreaterThan(lum(out.other) + 3);
});

test('暗い写真を開くと、何も押さなくてもおまかせで明るくする（元に戻せる。切り替えで、すすめるだけにもできる。明るい写真ではしない）', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('temoto:autoDark', 'true'));
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#2a221c', { w: 160, h: 120, name: 'dark.png' }));
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  const box = page.getByRole('region', { name: 'おすすめ' });
  await expect(box).toContainText('自動で整えました');
  await expect.poll(() => page.evaluate(() => [window.__temoto.state.adj.lowlight, window.__temoto.state.adj.noise])).toEqual([50, 50]);
  // 元に戻すと 1 回で戻る。パネルのボタンでも当て直せる
  await box.getByRole('button', { name: '元に戻す' }).click();
  await expect(box).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__temoto.state.adj.lowlight)).toBe(0);
  await openTool(page, '自動補正');
  await page.getByRole('button', { name: '✦ おまかせで明るくする' }).click();
  expect(await page.evaluate(() => window.__temoto.state.adj.noise)).toBe(50);
  await expect(page.getByText('おまかせ中')).toBeVisible();
  // 自動で明るくしない設定では、すすめるだけ
  await page.getByLabel('暗い写真を開いたら自動で明るくする').uncheck();
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#2a221c', { w: 160, h: 120, name: 'dark2.png' }));
  await page.waitForFunction(() => window.__temoto?.editor?.proj?.name?.startsWith('dark2'));
  await expect(box).toContainText('暗い写真です');
  expect(await page.evaluate(() => window.__temoto.state.adj.lowlight)).toBe(0);
  await box.getByRole('button', { name: '✦ 明るくする' }).click();
  await expect(box).toHaveCount(0);
  expect(await page.evaluate(() => [window.__temoto.state.adj.lowlight, window.__temoto.state.adj.noise])).toEqual([50, 50]);
  // 明るい写真・編集した写真では出さない
  await page.evaluate(() => localStorage.setItem('temoto:autoDark', 'true'));
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await page.locator('#open-file').setInputFiles(await solidPhoto(page, '#c8b8a8', { w: 160, h: 120, name: 'bright.png' }));
  await page.waitForFunction(() => window.__temoto?.editor?.proj?.name?.startsWith('bright'));
  await page.waitForTimeout(300);
  await expect(box).toHaveCount(0);
  expect(await page.evaluate(() => window.__temoto.state.adj.lowlight)).toBe(0);
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await page.getByRole('button', { name: /^dark2.*を編集$/ }).click();
  await page.waitForFunction(() => window.__temoto?.editor?.proj?.name?.startsWith('dark2'));
  await page.waitForTimeout(300);
  await expect(box).toHaveCount(0);
});

test('顔 AI の鍵は、開き直しても同じ（本人の写真を登録し直した回数で変わらない。保存した結果をそのまま使える）', async ({ page }) => {
  await page.goto('/');
  const key = (save) => page.evaluate(async (save) => {
    const m = await import('/face-photo.js'); const { defaultState } = await import('/state.js');
    if (save) { await m.savePeople([{ id: 'p1', name: '人1', refs: [] }]); await m.savePeople([{ id: 'p1', name: '人1', refs: [{ id: 'r1', crop: new Blob(['x'], { type: 'image/png' }) }] }]); } else await m.loadPeople(); // 本人の写真には顔の写真（crop）を入れる（ないものは読み込むとき外す）
    const s = defaultState(); s.faceai.faces = [{ x: 0.5, y: 0.4, on: true, person: 'p1' }];
    return m.faceaiKey(s);
  }, save);
  const before = await key(true);
  expect(before).toContain('r1');
  await page.reload();
  expect(await key(false)).toBe(before);
});
