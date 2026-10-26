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

test('リップ: 口のまわりを大ざっぱになぞっても、AI で見つけた唇だけに色がのる（なぞった線は目印）。色合い・濃さ・明るさを選べる', async ({ page }) => {
  await open(page);
  const skin0 = await srcPixel(page, 0.513, 0.62); // 唇の下の肌（ブラシの中）
  await openTool(page, '顔');
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
  expect(op.type).toBe('lip'); expect(op.lips.length).toBe(1); expect(op.whole).toBe(true); // 唇を見つけ、範囲は自動で
  const lip1 = await srcPixel(page, 0.513, 0.592); const skin1 = await srcPixel(page, 0.513, 0.62);
  expect(lip1[0] - lip1[1]).toBeGreaterThan(lip0[0] - lip0[1] + 15); // 下唇は赤く
  for (let c = 0; c < 3; c++) expect(Math.abs(skin1[c] - skin0[c])).toBeLessThan(3); // 唇の下の肌は変わらない
});

test('リップ: 唇をタップする・丸で囲むと、AI で見つけた唇の全体（上唇も下唇も）に色がのる', async ({ page }) => {
  await open(page);
  await openTool(page, '顔');
  await page.getByRole('button', { name: 'リップ', exact: true }).click();
  await page.getByRole('button', { name: /レッド/ }).click();
  await page.getByLabel('ブラシの大きさ', { exact: true }).evaluate((el) => { el.value = 1; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const view = await page.locator('canvas.view').boundingBox();
  const L = await page.evaluate(() => { const E = window.__temoto.editor; return { ix: E.L.ix / E.view.width, iy: E.L.iy / E.view.height, iw: E.L.iw / E.view.width, ih: E.L.ih / E.view.height }; });
  const at = (x, y) => [view.x + view.width * (L.ix + L.iw * x), view.y + view.height * (L.iy + L.ih * y)];
  const red = ([r, g]) => r - g;
  const done = (n) => page.waitForFunction((n) => window.__temoto.state.retouch.length === n && !document.querySelector('.stage.busy'), n, { timeout: 60000 });
  // 唇の真ん中（上唇: 外側の上のまん中と内側の上のまん中の間、下唇: 同じく下）。輪郭の 15 番目・5 番目
  const mids = async () => { const l = (await page.evaluate(() => window.__temoto.state.retouch.at(-1).lips[0])); const mid = (i) => [(l.outer[i][0] + l.inner[i][0]) / 2, (l.outer[i][1] + l.inner[i][1]) / 2]; return { up: mid(15), low: mid(5), l }; };
  const base = async (x, y) => page.evaluate(([x, y]) => { const E = window.__temoto.editor; const cv = document.createElement('canvas'); cv.width = E.W; cv.height = E.H; const g = cv.getContext('2d'); g.drawImage(E.base, 0, 0); return [...g.getImageData(Math.round(x * (E.W - 1)), Math.round(y * (E.H - 1)), 1, 1).data.slice(0, 3)]; }, [x, y]);
  // ① 下唇を 1 回タップ
  await page.mouse.click(...at(0.513, 0.592)); await done(1);
  const op = (await page.evaluate(() => window.__temoto.state.retouch))[0];
  expect(op.whole).toBe(true); expect(op.lips.length).toBe(1);
  const { up, low, l } = await mids();
  expect(red(await srcPixel(page, ...up))).toBeGreaterThan(red(await base(...up)) + 12); // タップしていない上唇にも色がのる
  expect(red(await srcPixel(page, ...low))).toBeGreaterThan(red(await base(...low)) + 12);
  // 唇の外（あごの肌）は変わらない
  const ys = l.outer.map((q) => q[1]); const chin = [0.513, Math.max(...ys) + (Math.max(...ys) - Math.min(...ys)) * 0.6];
  const c0 = await base(...chin); const c1 = await srcPixel(page, ...chin);
  for (let c = 0; c < 3; c++) expect(Math.abs(c1[c] - c0[c])).toBeLessThan(3);
  // ② 元に戻して、口のまわりを丸で囲む（線は唇にかからない）
  await page.getByRole('button', { name: '元に戻す（Ctrl+Z）' }).click(); await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__temoto.state.retouch.length)).toBe(0);
  const xs = l.outer.map((q) => q[0]); const cx = (Math.max(...xs) + Math.min(...xs)) / 2; const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const rx = (Math.max(...xs) - Math.min(...xs)) * 0.85; const ry = (Math.max(...ys) - Math.min(...ys)) * 1.3;
  await page.mouse.move(...at(cx + rx, cy)); await page.mouse.down();
  for (let i = 1; i <= 32; i++) await page.mouse.move(...at(cx + rx * Math.cos(i / 32 * 2 * Math.PI), cy + ry * Math.sin(i / 32 * 2 * Math.PI)));
  await page.mouse.up(); await done(1);
  expect(red(await srcPixel(page, ...up))).toBeGreaterThan(red(await base(...up)) + 12);
  expect(red(await srcPixel(page, ...low))).toBeGreaterThan(red(await base(...low)) + 12);
});

test('歯: 口をタップすると AI で口を見つけて範囲を自動で決める。口を閉じた写真では、唇・肌を白くしない', async ({ page }) => {
  await open(page);
  await openTool(page, '顔');
  await page.getByRole('button', { name: '歯', exact: true }).click();
  const view = await page.locator('canvas.view').boundingBox();
  const L = await page.evaluate(() => { const E = window.__temoto.editor; return { ix: E.L.ix / E.view.width, iy: E.L.iy / E.view.height, iw: E.L.iw / E.view.width, ih: E.L.ih / E.view.height }; });
  const at = (x, y) => [view.x + view.width * (L.ix + L.iw * x), view.y + view.height * (L.iy + L.ih * y)];
  const lip0 = await srcPixel(page, 0.513, 0.592); const up0 = await srcPixel(page, 0.513, 0.565);
  await page.mouse.click(...at(0.513, 0.578));
  await page.waitForFunction(() => window.__temoto.state.retouch.length === 1 && !document.querySelector('.stage.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const op = (await page.evaluate(() => window.__temoto.state.retouch))[0];
  expect(op.type).toBe('teeth'); expect(op.whole).toBe(true); expect(op.lips.length).toBe(1);
  const lip1 = await srcPixel(page, 0.513, 0.592); const up1 = await srcPixel(page, 0.513, 0.565);
  for (let c = 0; c < 3; c++) { expect(Math.abs(lip1[c] - lip0[c])).toBeLessThan(4); expect(Math.abs(up1[c] - up0[c])).toBeLessThan(4); }
});

test('リップ: 2本指での拡大・移動はリップの範囲にしない（2本目の指が写真の外・下のパネルの上でも）。1本指ではなぞれる', async ({ page }) => {
  await open(page);
  await openTool(page, '顔');
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

test('目線: 顔をタップすると AI で両目を見つけて黒目をカメラの方へ動かす。矢印で微調整でき、まぶたの外は変わらない', async ({ page }) => {
  await open(page);
  await openTool(page, '顔');
  await page.getByRole('button', { name: '目線', exact: true }).click();
  await expect(page.getByLabel('カメラへ寄せる量', { exact: true })).toBeVisible();
  const view = await page.locator('canvas.view').boundingBox();
  const L = await page.evaluate(() => { const E = window.__temoto.editor; return { ix: E.L.ix / E.view.width, iy: E.L.iy / E.view.height, iw: E.L.iw / E.view.width, ih: E.L.ih / E.view.height }; });
  const at = (x, y) => [view.x + view.width * (L.ix + L.iw * x), view.y + view.height * (L.iy + L.ih * y)];
  const brow0 = await srcPixel(page, 0.46, 0.37); const cheek0 = await srcPixel(page, 0.46, 0.44); // 目の上（まゆ）と下（ほお）
  await page.mouse.click(...at(0.515, 0.40)); // 両目の間
  await page.waitForFunction(() => window.__temoto.state.retouch.length === 1 && !document.querySelector('.stage.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const op = (await page.evaluate(() => window.__temoto.state.retouch))[0];
  expect(op.type).toBe('gaze'); expect(op.eyes.length).toBe(1); expect(op.eyes[0].length).toBe(2); // 1 人の両目
  for (const e of op.eyes[0]) { expect(e.lid.length).toBe(16); expect(e.iris.length).toBe(5); expect(e.pose.length).toBe(2); }
  const brow1 = await srcPixel(page, 0.46, 0.37); const cheek1 = await srcPixel(page, 0.46, 0.44);
  for (let c = 0; c < 3; c++) { expect(Math.abs(brow1[c] - brow0[c])).toBeLessThan(3); expect(Math.abs(cheek1[c] - cheek0[c])).toBeLessThan(3); }
  // 矢印で微調整: 左へ押すと黒目が左へ、右へ押すと右へ動き、「戻す」で戻る
  // 左目の黒目の高さの 3 行の明るさ（目頭〜目尻）。黒目の動きは、黒目の所の明るさの並びが何画素ずれたかで測る
  // （暗い画素・明るい画素の重心は、まつげ・アイライン・黒目の中の光の点に引っぱられて当てにならない）
  const row = () => page.evaluate(() => {
    const E = window.__temoto.editor; const c = E.src || E.base; const cv = document.createElement('canvas'); cv.width = E.W; cv.height = E.H; const g = cv.getContext('2d'); g.drawImage(c, 0, 0);
    const e = window.__temoto.state.retouch[0].eyes[0][0]; const cy = Math.round(e.iris[0][1] * E.H);
    const xa = Math.round(Math.min(e.lid[0][0], e.lid[8][0]) * E.W); const xb = Math.round(Math.max(e.lid[0][0], e.lid[8][0]) * E.W);
    const d = g.getImageData(xa, cy - 1, xb - xa, 3).data; const n = xb - xa; const L = new Array(n).fill(0);
    for (let i = 0; i < d.length; i += 4) L[(i / 4) % n] += (d[i] + d[i + 1] + d[i + 2]) / 9;
    return L;
  });
  const shift = (p0, p1) => { // p1 は p0 を何画素ずらしたものか（黒目のまわりで比べる）
    let s0 = 0; let n0 = 0; p0.forEach((v, i) => { const w = Math.max(0, 110 - v); s0 += w * i; n0 += w; }); const c = s0 / n0;
    const at = (p, x) => { const i = Math.max(0, Math.min(p.length - 2, Math.floor(x))); const t = x - i; return p[i] + (p[i + 1] - p[i]) * t; };
    let best = 0; let bd = Infinity;
    for (let s = -6; s <= 6; s += 0.25) { let e = 0; for (let x = c - 4; x <= c + 4; x++) e += (at(p1, x + s) - at(p0, x)) ** 2; if (e < bd) { bd = e; best = s; } }
    return best;
  };
  const r0 = await row();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '黒目を左へ', exact: true }).click();
  expect((await page.evaluate(() => window.__temoto.state.retouch[0].tune))).toEqual([-0.4, 0]);
  const rl = await row();
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: '黒目を右へ', exact: true }).click();
  const rr = await row();
  // 黒目の半径 7px の 4 割 ≒ 3px
  expect(shift(r0, rl)).toBeLessThan(-1.5); expect(shift(r0, rr)).toBeGreaterThan(1.5);
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '黒目を左へ', exact: true }).click();
  await page.getByRole('button', { name: '戻す', exact: true }).click();
  expect((await page.evaluate(() => window.__temoto.state.retouch[0].tune))).toBeUndefined();
  expect((await row()).every((v, i) => Math.abs(v - r0[i]) < 0.5)).toBe(true); // 戻すと元どおり
  await page.getByRole('button', { name: /元に戻す/ }).click(); // 微調整の 1 手ずつ戻せる
  expect((await page.evaluate(() => window.__temoto.state.retouch[0].tune))).toBeTruthy();
});

test('鼻筋: 鼻をタップすると、AI で見つけた顔の点から、鼻筋は明るく・両脇は暗くなり、頬・髪は変わらない', async ({ page }) => {
  await open(page);
  // この写真の鼻: 鼻先 (0.51, 0.48)、頬 (0.42, 0.5)、髪 (0.3, 0.3)。鼻筋・横の面の位置は、見つけた顔の点から決める
  const cheek0 = await srcPixel(page, 0.42, 0.5); const hair0 = await srcPixel(page, 0.3, 0.3);
  const org = await page.evaluate(() => { const E = window.__temoto.editor; const cv = document.createElement('canvas'); cv.width = E.W; cv.height = E.H; cv.getContext('2d').drawImage(E.base, 0, 0); return [...cv.getContext('2d').getImageData(0, 0, E.W, E.H).data]; });
  await openTool(page, '顔');
  await page.getByRole('button', { name: '鼻筋', exact: true }).click();
  const view = await page.locator('canvas.view').boundingBox();
  const L = await page.evaluate(() => { const E = window.__temoto.editor; return { ix: E.L.ix / E.view.width, iy: E.L.iy / E.view.height, iw: E.L.iw / E.view.width, ih: E.L.ih / E.view.height }; });
  await page.mouse.click(view.x + view.width * (L.ix + L.iw * 0.51), view.y + view.height * (L.iy + L.ih * 0.47));
  await page.waitForFunction(() => { const r = window.__temoto.state.retouch; return r.length && !document.querySelector('.stage.busy'); }, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const op = (await page.evaluate(() => window.__temoto.state.retouch))[0];
  expect(op.type).toBe('nose'); expect(op.nose.mid.length).toBe(7); expect(op.nose.li.length).toBe(5); expect(op.v).toBe(2); expect(op.nose.al.length).toBe(4); // 顔の点を見つけ、範囲は自動で（2 版は小鼻のふちも）
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  const { W, H } = await page.evaluate(() => ({ W: window.__temoto.editor.W, H: window.__temoto.editor.H }));
  const before = ([x, y]) => { const k = (Math.round(y * (H - 1)) * W + Math.round(x * (W - 1))) * 4; return org.slice(k, k + 3); };
  const bridge = op.nose.mid[2]; const side = [(op.nose.ri[1][0] + op.nose.ro[1][0]) / 2, (op.nose.ri[1][1] + op.nose.ro[1][1]) / 2]; // 鼻筋のまん中と、右の横の面（ふちと頬の境目の間。この写真では左の横の面はもともと陰なので、影は控えめになる）
  expect(lum(await srcPixel(page, ...bridge))).toBeGreaterThan(lum(before(bridge)) + 4); // 鼻筋は明るく
  expect(lum(await srcPixel(page, ...side))).toBeLessThan(lum(before(side)) - 3); // 横の面は暗く
  const cheek1 = await srcPixel(page, 0.42, 0.5); const hair1 = await srcPixel(page, 0.3, 0.3);
  for (let c = 0; c < 3; c++) { expect(Math.abs(cheek1[c] - cheek0[c])).toBeLessThan(3); expect(Math.abs(hair1[c] - hair0[c])).toBeLessThan(3); } // 頬・髪は変わらない
  await expect(page.getByText(/なぞった回数: 1/)).toBeVisible();
});
