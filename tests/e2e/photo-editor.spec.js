// てもとフォト（写真編集）: 実際に画素が変わること・端末の外に出ないこと・書き出しにメタデータが残らないこと
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { makePhoto, viewMean, withExif, savedExposures } from './photo-helpers.js';

const URL0 = '/';
const SKY = [0.05, 0.05, 0.5, 0.3]; // 表示中の写真の、空の部分（左上）

async function openWith(page, file) {
  await page.goto(URL0);
  await page.locator('#open-file').setInputFiles(file || await makePhoto(page));
  // CI（ソフトウェアのGPU）ではシェーダーの準備に時間がかかる
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => window.__temoto.editor?.L);
  await page.waitForTimeout(150);
}
/** スライダーを動かす（離したときの change まで送る） */
async function setSlider(page, label, value) {
  const s = page.getByLabel(label, { exact: true });
  await s.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  await page.waitForTimeout(120);
}
const tab = (page, name) => page.getByRole('tab', { name }).click();
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** 表示中の写真の上の点（0〜1）を押す・なぞる */
async function viewBox(page) { return page.locator('canvas.view').boundingBox(); }
async function tapAt(page, x, y) { const b = await viewBox(page); await page.mouse.click(b.x + b.width * x, b.y + b.height * y); }
async function dragOn(page, from, to, steps = 8) {
  const b = await viewBox(page);
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]); await page.mouse.down();
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps }); await page.mouse.up();
}
async function exportFile(page, opts = {}) {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  if (opts.format) await dlg.getByRole('button', { name: opts.format }).click();
  if (opts.size) await dlg.getByRole('button', { name: opts.size }).click();
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  const d = await dl;
  const buf = await readFile(await d.path());
  await dlg.getByRole('button', { name: '閉じる' }).click();
  return { name: d.suggestedFilename(), buf };
}
/** 画像ファイルの大きさを読む（ブラウザでデコード） */
async function imageSize(page, buf, mime) {
  return page.evaluate(async ({ b64, mime }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: mime }));
    return [bmp.width, bmp.height];
  }, { b64: buf.toString('base64'), mime });
}

test.describe.configure({ timeout: 60000 });

test.beforeEach(async ({ page }) => {
  // 外部への通信が一切ないこと（同じサイトの静的ファイルだけ）
  page.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !u.protocol.startsWith('blob') && !u.protocol.startsWith('data')) throw new Error(`外部通信: ${r.url()}`); });
});

test('写真一覧: 通信を禁止する CSP・プライバシーの説明・横スクロールなし', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL0);
  await expect(page.getByRole('heading', { name: 'てもとフォト' })).toBeVisible();
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("connect-src 'none'");
  await expect(page.locator('.privacy')).toContainText('この端末から出ません');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // 画像以外は読み込まない
  await page.locator('#open-file').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('.toast')).toContainText('画像ファイルを選んでください');
  expect(errors).toEqual([]);
});

test('露光・彩度で画素が変わり、元に戻す／やり直す／編集前の表示ができる', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await openWith(page);
  const before = await viewMean(page);
  await tab(page, 'ライト');
  await setSlider(page, '露光量', 60);
  const bright = await viewMean(page);
  expect(lum(bright)).toBeGreaterThan(lum(before) + 20);
  await tab(page, 'カラー');
  await setSlider(page, '彩度', -100);
  const [r, g, b] = await viewMean(page, SKY);
  expect(Math.max(Math.abs(r - g), Math.abs(g - b))).toBeLessThan(4);
  // 編集前を押している間だけ元の画像
  const cmp = page.getByRole('button', { name: /編集前を表示/ });
  await cmp.dispatchEvent('pointerdown');
  await page.waitForTimeout(150);
  expect(Math.abs(lum(await viewMean(page)) - lum(before))).toBeLessThan(2);
  await expect(page.locator('.orig-badge')).toBeVisible();
  await cmp.dispatchEvent('pointerup');
  await page.waitForTimeout(150);
  // 元に戻す（キーボード）
  await page.locator('body').press('Control+z');
  await page.waitForTimeout(150);
  const undone = await viewMean(page, SKY);
  expect(Math.abs(undone[2] - undone[0])).toBeGreaterThan(20); // 色が戻った
  await page.getByRole('button', { name: /やり直す/ }).click();
  await page.waitForTimeout(150);
  const re = await viewMean(page, SKY);
  expect(Math.abs(re[2] - re[0])).toBeLessThan(4);
  expect(errors).toEqual([]);
});

test('フィルター（モノクロ）と強さ、自動補正', async ({ page }) => {
  await openWith(page);
  await tab(page, 'フィルター');
  await page.getByRole('button', { name: 'モノクロ', exact: true }).click();
  await page.waitForTimeout(150);
  let [r, g, b] = await viewMean(page, SKY);
  expect(Math.abs(b - r)).toBeLessThan(4);
  await setSlider(page, '強さ', 0);
  [r, g, b] = await viewMean(page, SKY);
  expect(b - r).toBeGreaterThan(40);
  // 見本の画像が描かれている
  const thumbFilled = await page.locator('.look canvas').nth(3).evaluate((c) => { const d = c.getContext('2d').getImageData(40, 40, 1, 1).data; return d[3] > 0; });
  expect(thumbFilled).toBe(true);
  await tab(page, '自動');
  await page.getByRole('button', { name: '✦ 自動補正' }).click();
  await page.waitForTimeout(150);
  const st = await page.evaluate(() => window.__temoto.state.adj);
  expect(st.vibrance).toBe(15);
});

test('HSL・カーブ・カラーグレーディング・効果', async ({ page }) => {
  await openWith(page);
  const sky0 = await viewMean(page, SKY);
  await tab(page, 'HSL');
  await page.getByRole('button', { name: 'ブルー' }).click();
  await setSlider(page, '彩度', -100);
  const sky1 = await viewMean(page, SKY);
  expect(sky1[2] - sky1[0]).toBeLessThan((sky0[2] - sky0[0]) * 0.4);
  await tab(page, 'カーブ');
  const l0 = lum(await viewMean(page));
  await page.getByRole('button', { name: '明るく' }).click();
  await page.waitForTimeout(150);
  expect(lum(await viewMean(page))).toBeGreaterThan(l0 + 8);
  // カーブを直接ドラッグして点を追加
  const svg = page.locator('svg.curve'); const bb = await svg.boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height * 0.5); await page.mouse.down(); await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height * 0.2, { steps: 4 }); await page.mouse.up();
  expect((await page.evaluate(() => window.__temoto.state.curves.rgb)).length).toBe(4);
  await tab(page, '効果');
  const corner0 = lum(await viewMean(page, [0, 0, 0.08, 0.08]));
  await setSlider(page, '周辺光量', -100);
  expect(lum(await viewMean(page, [0, 0, 0.08, 0.08]))).toBeLessThan(corner0 - 15);
});

test('切り抜き（比率・回転）と書き出しの大きさ', async ({ page }) => {
  await openWith(page);
  await tab(page, '切り抜き');
  await page.getByRole('button', { name: '1:1' }).click();
  await page.getByRole('button', { name: '⟳ 右に回転' }).click();
  await tab(page, 'ライト');
  await page.waitForTimeout(150);
  const ratio = await page.locator('canvas.view').evaluate((c) => c.width / c.height);
  expect(Math.abs(ratio - 1)).toBeLessThan(0.02);
  const f = await exportFile(page, { format: 'PNG（劣化なし）' });
  expect(f.name).toMatch(/\.png$/);
  expect([...f.buf.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  const [w, hh] = await imageSize(page, f.buf, 'image/png');
  expect(w).toBe(hh); expect(w).toBe(800);
});

test('位置情報入りの写真: 警告を出し、書き出した JPEG には Exif が残らない', async ({ page }) => {
  await page.goto(URL0);
  const file = withExif(await makePhoto(page));
  await page.locator('#open-file').setInputFiles(file);
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await tab(page, '情報');
  await expect(page.locator('.gps-warn')).toContainText('位置情報');
  await expect(page.locator('.info')).toContainText('SecretCam');
  const out = await exportFile(page, { format: 'JPEG', size: '1080px（SNS）' });
  expect(out.buf[0]).toBe(0xff); expect(out.buf[1]).toBe(0xd8);
  expect(out.buf.includes(Buffer.from('Exif'))).toBe(false);
  expect(out.buf.includes(Buffer.from('SecretCam'))).toBe(false);
  const [w, hh] = await imageSize(page, out.buf, 'image/jpeg');
  expect(Math.max(w, hh)).toBe(1080);
});

test('部分補正（円形）で中心だけ明るくなる・範囲を赤く表示', async ({ page }) => {
  await openWith(page);
  const center0 = lum(await viewMean(page, [0.45, 0.45, 0.55, 0.55]));
  const corner0 = lum(await viewMean(page, [0, 0.9, 0.05, 1]));
  await tab(page, '部分補正');
  await page.getByRole('button', { name: '＋ 円形グラデーション' }).click();
  await setSlider(page, '露光量', 80);
  expect(lum(await viewMean(page, [0.45, 0.45, 0.55, 0.55]))).toBeGreaterThan(center0 + 15);
  expect(Math.abs(lum(await viewMean(page, [0, 0.9, 0.05, 1])) - corner0)).toBeLessThan(3);
  // 中心の丸をドラッグして動かせる
  const cx0 = await page.evaluate(() => window.__temoto.state.locals[0].cx);
  await dragOn(page, [0.5, 0.5], [0.3, 0.5]);
  expect(await page.evaluate(() => window.__temoto.state.locals[0].cx)).toBeLessThan(cx0 - 0.1);
  await page.getByText('範囲を赤く表示').click();
  await page.waitForTimeout(150);
  const [r, , b] = await viewMean(page, [0.25, 0.45, 0.35, 0.55]);
  expect(r).toBeGreaterThan(b);
});

test('ブラシの部分補正: 塗った場所だけ暗くなり、元に戻すで消える', async ({ page }) => {
  await openWith(page);
  const left0 = lum(await viewMean(page, [0.05, 0.1, 0.25, 0.2]));
  const right0 = lum(await viewMean(page, [0.75, 0.75, 0.95, 0.85]));
  await tab(page, '部分補正');
  await page.getByRole('button', { name: '＋ ブラシ' }).click();
  await setSlider(page, '露光量', -100);
  await dragOn(page, [0.05, 0.15], [0.3, 0.15], 15);
  await page.waitForTimeout(200);
  expect(lum(await viewMean(page, [0.08, 0.12, 0.22, 0.18]))).toBeLessThan(left0 - 20);
  expect(Math.abs(lum(await viewMean(page, [0.75, 0.75, 0.95, 0.85])) - right0)).toBeLessThan(3);
  expect(await page.evaluate(() => window.__temoto.state.locals[0].strokes.length)).toBe(1);
  await page.getByRole('button', { name: /元に戻す/ }).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__temoto.state.locals[0].strokes.length)).toBe(0);
});

test('スポット修復で黒い点が消え、モザイクで細部が消える', async ({ page }) => {
  await openWith(page);
  const dust = [0.61, 0.24, 0.63, 0.26];
  const d0 = lum(await viewMean(page, dust));
  await tab(page, '修復');
  await tapAt(page, 0.62, 0.25);
  await page.waitForTimeout(200);
  expect(lum(await viewMean(page, dust))).toBeGreaterThan(d0 + 25);
  await tab(page, 'モザイク');
  const sd = () => page.evaluate(() => { const c = document.querySelector('canvas.view'); const d = c.getContext('2d').getImageData(Math.round(c.width * 0.22), Math.round(c.height * 0.5), Math.round(c.width * 0.16), Math.round(c.height * 0.3)).data; let s = 0; let s2 = 0; const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { s += d[i]; s2 += d[i] * d[i]; } return Math.sqrt(s2 / n - (s / n) ** 2); });
  const before = await sd();
  await dragOn(page, [0.2, 0.48], [0.4, 0.82]);
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => window.__temoto.state.retouch);
  expect(st.map((x) => x.type)).toEqual(['heal', 'mosaic']);
  expect(st[0].sx).not.toBeNull();
  expect(await sd()).not.toBe(before);
});

test('文字（XSSの文字列も文字として描くだけ）・ドラッグで移動・スタンプ・描画', async ({ page }) => {
  await openWith(page);
  const m0 = await viewMean(page);
  await tab(page, '文字');
  await page.getByRole('button', { name: '＋ 文字を追加' }).click();
  await page.getByLabel('文字（改行できます）').fill('<img src=x onerror="window.__xss=1">こんにちは');
  await page.getByLabel('文字（改行できます）').blur();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  const m1 = await viewMean(page);
  expect(m1).not.toEqual(m0);
  await dragOn(page, [0.5, 0.5], [0.5, 0.2]);
  const y = await page.evaluate(() => window.__temoto.state.overlays[0].y);
  expect(y).toBeLessThan(0.35);
  await page.getByText('縦書き').click();
  await tab(page, 'スタンプ');
  await page.getByRole('button', { name: '🎉 を追加' }).click();
  await tab(page, '描画');
  await dragOn(page, [0.1, 0.9], [0.9, 0.9]);
  const ov = await page.evaluate(() => window.__temoto.state.overlays.map((o) => [o.type, o.vertical ?? null]));
  expect(ov.map((o) => o[0])).toEqual(['text', 'sticker', 'draw']);
  expect(ov[0][1]).toBe(true);
});

test('フレーム: 枠と、余白で正方形にする', async ({ page }) => {
  await openWith(page);
  const w0 = await page.locator('canvas.view').evaluate((c) => c.width / c.height);
  await tab(page, 'フレーム');
  await page.getByRole('button', { name: '正方形 1:1' }).click();
  await page.waitForTimeout(150);
  const w1 = await page.locator('canvas.view').evaluate((c) => c.width / c.height);
  expect(w0).toBeGreaterThan(1.3); expect(Math.abs(w1 - 1)).toBeLessThan(0.01);
  await setSlider(page, '枠の太さ', 10);
  const f = await exportFile(page, { format: 'JPEG' });
  const [w, hh] = await imageSize(page, f.buf, 'image/jpeg');
  expect(w).toBe(hh);
});

test('保存して再読み込みしても編集が残る・プリセット・編集の貼り付け・まとめて書き出し・削除', async ({ page }) => {
  await openWith(page);
  await tab(page, 'ライト');
  await setSlider(page, '露光量', 40);
  await tab(page, 'フィルター');
  await page.getByLabel('プリセットの名前').fill('明るめ');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.menu summary').click();
  await page.getByRole('button', { name: '編集をコピー' }).click();
  // 保存が終わるまで待ってから再読み込み（遅い CI では決め打ちの待ち時間では足りない）
  await expect.poll(() => savedExposures(page), { timeout: 15000 }).toContain(40);
  await page.reload();
  await expect(page.locator('.lib-item')).toHaveCount(1);
  await expect(page.locator('.lib-badge')).toHaveText('編集済み');
  // 2枚目を追加して、コピーした編集を貼り付け
  await page.locator('#open-file').setInputFiles(await makePhoto(page, { w: 600, h: 900 }));
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '‹ 写真' }).click();
  await expect(page.locator('.lib-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'すべて選択' }).click();
  await page.getByRole('button', { name: '編集を貼り付け' }).click();
  await expect(page.locator('.lib-badge')).toHaveCount(2);
  // 1枚目を開くと露光量が残っている
  await page.locator('.lib-open').last().click();
  await page.waitForFunction(() => window.__temoto.editor?.L);
  expect(await page.evaluate(() => window.__temoto.state.adj.exposure)).toBe(40);
  // プリセットが使える
  await tab(page, 'フィルター');
  await expect(page.getByRole('button', { name: '明るめ', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '‹ 写真' }).click();
  // まとめて書き出し
  await page.getByRole('button', { name: 'すべて選択' }).click();
  await page.getByRole('button', { name: 'まとめて書き出し' }).click();
  const files = [];
  page.on('download', (d) => files.push(d.suggestedFilename()));
  await page.getByRole('dialog').getByRole('button', { name: '2枚を書き出す' }).click();
  await expect(page.getByRole('dialog')).toContainText('2枚を書き出しました', { timeout: 15000 });
  expect(files).toHaveLength(2);
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  // 削除（確認つき）
  await page.getByRole('button', { name: '削除' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '削除する' }).click();
  await expect(page.locator('.lib-item')).toHaveCount(0);
});

test('a11y: 編集画面（重大な違反なし）', async ({ page }) => {
  await openWith(page);
  const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
  const axe = await readFile(axePath, 'utf8');
  for (const t of ['フィルター', '切り抜き', '文字']) {
    await tab(page, t);
    if (t === '文字') await page.getByRole('button', { name: '＋ 文字を追加' }).click();
    await page.evaluate(axe); // CSP は script-src 'self' だが evaluate は CDP 経由なので注入できる
    const res = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
    const serious = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    expect(serious, `${t}: ${serious.join('\n')}`).toEqual([]);
  }
});

/** 表示中の写真の一部の「細かさ」（隣の画素との差の平均）。ぼけると小さくなる */
const detail = (page, [x0, y0, x1, y1]) => page.evaluate(([x0, y0, x1, y1]) => {
  const c = document.querySelector('canvas.view'); const w = Math.floor(c.width * (x1 - x0)); const hh = Math.floor(c.height * (y1 - y0));
  const d = c.getContext('2d').getImageData(Math.floor(c.width * x0), Math.floor(c.height * y0), w, hh).data;
  let s = 0; let n = 0;
  for (let y = 0; y < hh; y++) for (let x = 1; x < w; x++) { const i = (y * w + x) * 4; s += Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]); n++; }
  return s / n;
}, [x0, y0, x1, y1]);

test('画質: ハイライト-100で明るい所が濁らない・明瞭度-100で全体がぼけない・HSLは色の境目でも効く', async ({ page }) => {
  await openWith(page);
  const ridge = [0.2, 0.3, 0.45, 0.65]; // 山の稜線と人物の周り
  const d0 = await detail(page, ridge);
  await tab(page, 'ライト');
  await setSlider(page, 'ハイライト', -100);
  await page.waitForTimeout(300);
  // 太陽（いちばん明るい所）が中間の灰色より暗くならない
  expect(lum(await viewMean(page, [0.76, 0.18, 0.8, 0.22]))).toBeGreaterThan(150);
  await setSlider(page, 'ハイライト', 0);
  await tab(page, 'ディテール');
  await setSlider(page, '明瞭度', -100);
  await page.waitForTimeout(300);
  expect(await detail(page, ridge)).toBeGreaterThan(d0 * 0.6);
  await setSlider(page, '明瞭度', 0);
  // 草（黄緑。イエローとグリーンの間の色）がグリーンの彩度で十分に変わる
  const grass = [0.05, 0.85, 0.2, 0.95];
  const [r0, g0] = await viewMean(page, grass);
  await tab(page, 'HSL');
  await page.getByRole('button', { name: 'グリーン' }).click();
  await setSlider(page, '彩度', -100);
  await page.getByRole('button', { name: 'イエロー' }).click();
  await setSlider(page, '彩度', -100);
  await page.waitForTimeout(300);
  const [r1, g1] = await viewMean(page, grass);
  expect(g1 - r1).toBeLessThan((g0 - r0) * 0.35);
});

test('枠と余白をつけても、書き出しは端末の上限（約1,670万画素）を超えない・メニューは選ぶと閉じる', async ({ page }) => {
  await page.goto(URL0);
  await page.locator('#open-file').setInputFiles(await makePhoto(page, { w: 4032, h: 3024 }));
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => window.__temoto.editor?.L);
  await tab(page, 'フレーム');
  await setSlider(page, '枠の太さ', 10);
  await page.getByRole('button', { name: 'ストーリー 9:16' }).click();
  await tab(page, '情報');
  await expect(page.locator('.info')).toContainText('端末の上限に合わせて縮小');
  const f = await exportFile(page, { format: 'JPEG' });
  const [w, hh] = await imageSize(page, f.buf, 'image/jpeg');
  expect(w * hh).toBeLessThanOrEqual(16_700_000);
  expect(Math.abs(hh / w - 16 / 9)).toBeLessThan(0.01);
  // メニュー
  await page.locator('.menu summary').click();
  await page.getByRole('button', { name: '編集をコピー' }).click();
  expect(await page.locator('.menu').evaluate((m) => m.open)).toBe(false);
  await page.locator('.menu summary').click();
  await page.locator('canvas.view').click();
  expect(await page.locator('.menu').evaluate((m) => m.open)).toBe(false);
});
