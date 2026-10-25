// 写真館の仕上げのブラシ（形を整える・目元と歯・明るく／暗く・しわ取り）
import { test, expect } from '@playwright/test';
import { makePhoto, viewMean, openTool } from './photo-helpers.js';

async function open(page) {
  await page.goto('/');
  await page.locator('#open-file').setInputFiles(await makePhoto(page));
  await expect(page.locator('canvas.view')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => window.__temoto.editor?.L);
  await page.waitForTimeout(150);
}
/** 写真の上（0〜1）を、指でなぞる */
async function stroke(page, pts) {
  const b = await page.locator('canvas.view').boundingBox();
  const at = ([x, y]) => [b.x + b.width * x, b.y + b.height * y];
  await page.mouse.move(...at(pts[0])); await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(...at(pts[i]), { steps: 8 });
  await page.mouse.up(); await page.waitForTimeout(250);
}
/** ブラシの大きさのスライダーを動かす */
const setSize = (page, v) => page.getByLabel('ブラシの大きさ', { exact: true }).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ops = (page) => page.evaluate(() => window.__temoto.state.retouch);

test('明るく・暗く: なぞった所だけ明るく（暗く）なり、元に戻せる。保存して開き直しても同じ', async ({ page }) => {
  await open(page);
  const R = [0.3, 0.4, 0.7, 0.6]; const other = [0.0, 0.85, 0.15, 1.0];
  const b0 = lum(await viewMean(page, R)); const o0 = lum(await viewMean(page, other));
  await openTool(page, '明暗');
  await expect(page.getByRole('button', { name: '明るく', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await setSize(page, 15);
  await stroke(page, [[0.32, 0.5], [0.68, 0.5]]);
  expect((await ops(page)).map((o) => o.type)).toEqual(['dodge']);
  const b1 = lum(await viewMean(page, R));
  expect(b1).toBeGreaterThan(b0 + 4);
  expect(Math.abs(lum(await viewMean(page, other)) - o0)).toBeLessThan(1); // なぞっていない所は変わらない
  await page.getByRole('button', { name: '暗く', exact: true }).click();
  await setSize(page, 15); // 大きさは種類ごとに覚える
  await stroke(page, [[0.32, 0.5], [0.68, 0.5]]); await stroke(page, [[0.32, 0.5], [0.68, 0.5]]);
  expect(lum(await viewMean(page, R))).toBeLessThan(b1 - 4);
  await page.locator('body').press('Control+z'); await page.locator('body').press('Control+z'); await page.waitForTimeout(300);
  expect(Math.abs(lum(await viewMean(page, R)) - b1)).toBeLessThan(1.5);
  // 保存して開き直しても、同じに再現される
  await page.waitForTimeout(1200); await page.reload();
  await page.locator('.lib-open').first().click(); await page.waitForFunction(() => window.__temoto.editor?.L); await page.waitForTimeout(300);
  expect(Math.abs(lum(await viewMean(page, R)) - b1)).toBeLessThan(1.5);
});

test('形を整える: なぞった向きに画素が動く（なぞっている間にも見える）。しわ取り・目元・歯もなぞった所が変わる', async ({ page }) => {
  await open(page);
  // 人物の代わりの円（中心 x=0.3, y=0.72、右の縁は x≒0.36）の右の縁を、左へ押す → 円の右の内側に背景の草が入ってくる
  const edge = [0.31, 0.68, 0.355, 0.76];
  const e0 = await viewMean(page, edge);
  await openTool(page, '形');
  await stroke(page, [[0.41, 0.72], [0.36, 0.72], [0.33, 0.72]]);
  expect((await ops(page))[0].type).toBe('warp');
  const e1 = await viewMean(page, edge);
  expect(Math.abs(lum(e1) - lum(e0)) + Math.abs(e1[0] - e0[0])).toBeGreaterThan(3);
  for (const [tool, mode, type] of [['しわ取り', null, 'wrinkle'], ['目元・歯', '目元', 'eyes'], ['目元・歯', '歯', 'teeth']]) {
    await openTool(page, tool);
    if (mode) await page.getByRole('button', { name: mode, exact: true }).click();
    const n = (await ops(page)).length;
    await stroke(page, [[0.55, 0.2], [0.7, 0.3]]);
    await page.waitForFunction((n) => window.__temoto.state.retouch.length > n && !document.querySelector('.stage.busy'), n, { timeout: 60000 }); // 歯は口を AI で探してから当てる
    expect((await ops(page)).at(-1).type).toBe(type);
  }
  await expect(page.getByText(/なぞった回数: 2/)).toBeVisible(); // 目元・歯は 2 回
});

test('書き出し（元の大きさ）でも、編集中と同じ所に同じように当たる（写真の一部だけを読み出して当てても同じ）', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { applyBrush, brushBounds, BRUSH_TYPES } = await import('/brushfx.js');
    const W = 640; const H = 480; const base = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; base[k] = (x * 7 + y * 3) % 256; base[k + 1] = (x * 2 + y * 5) % 256; base[k + 2] = 120 + 60 * Math.sin(x / 9) * Math.cos(y / 13); base[k + 3] = 255; }
    const out = {};
    for (const type of BRUSH_TYPES) {
      const op = { type, pts: [[0.3, 0.4], [0.36, 0.45], [0.42, 0.47]], r: 0.06, amt: 0.8 };
      if (type === 'gaze') { // 目線は AI が見つけた両目（まぶたのふち 16 点と黒目）に当てる: 作りものの目を 2 つ
        const eye = (cx) => ({ lid: Array.from({ length: 16 }, (_, i) => { const a = Math.PI - (i / 16) * Math.PI * 2; return [(cx + Math.cos(a) * 40) / W, (200 + Math.sin(a) * 16) / H]; }), iris: [[(cx + 12) / W, 200 / H], [(cx + 12) / W, 188 / H], [(cx + 24) / W, 200 / H], [(cx + 12) / W, 212 / H], [cx / W, 200 / H]], pose: [0, 0] });
        op.eyes = [[eye(200), eye(300)]];
      }
      // 鼻筋は、AI で見つけた顔の点から範囲を決める（作りものの鼻: まん中の線と、左右のふち・頬の境目）
      if (type === 'nose') { const col = (dx) => [0.2, 0.3, 0.4, 0.5].map((t) => [0.36 + dx, 0.3 + t * 0.4]); op.nose = { mid: [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((t) => [0.36, 0.3 + t * 0.4]), li: col(-0.02), ri: col(0.02), lo: col(-0.06), ro: col(0.06) }; }
      const whole = { width: W, height: H, data: new Uint8ClampedArray(base) }; applyBrush(whole, op);
      const [rx, ry, rw, rh] = brushBounds(op, W, H); const part = { width: rw, height: rh, data: new Uint8ClampedArray(rw * rh * 4) };
      for (let y = 0; y < rh; y++) part.data.set(base.subarray(((ry + y) * W + rx) * 4, ((ry + y) * W + rx + rw) * 4), y * rw * 4);
      applyBrush(part, op, { W, H, ox: rx, oy: ry });
      let maxDiff = 0; let changed = 0; let outside = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4; const inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
        for (let c = 0; c < 3; c++) {
          if (whole.data[k + c] !== base[k + c]) { changed++; if (!inside) outside++; }
          if (inside) maxDiff = Math.max(maxDiff, Math.abs(whole.data[k + c] - part.data[((y - ry) * rw + x - rx) * 4 + c]));
        }
      }
      out[type] = { maxDiff, changed, outside };
    }
    return out;
  });
  for (const [type, v] of Object.entries(r)) {
    expect(v.changed, `${type} が効く`).toBeGreaterThan(100);
    expect(v.outside, `${type} は読み出す範囲の外を変えない`).toBe(0);
    expect(v.maxDiff, `${type} は一部だけでも同じ`).toBeLessThanOrEqual(2);
  }
});

test('ブラシの大きさ: スライダーを動かすと写真の上に丸が出て、初期値は全身・上半身の写真向けに小さめ。種類ごとに覚える', async ({ page }) => {
  await open(page);
  await openTool(page, '明暗');
  const size = page.getByLabel('ブラシの大きさ', { exact: true });
  await expect(size).toHaveValue('3');
  await setSize(page, 10);
  await expect(page.locator('.handles circle.cursor')).toHaveCount(1); // 丸が出る
  const r10 = Number(await page.locator('.handles circle.cursor').getAttribute('r'));
  await setSize(page, 5);
  const r5 = Number(await page.locator('.handles circle.cursor').getAttribute('r'));
  expect(r10 / r5).toBeCloseTo(2, 1);
  await expect(page.locator('.handles circle.cursor')).toHaveCount(0, { timeout: 3000 }); // しばらくすると消える
  await page.getByRole('button', { name: '暗く', exact: true }).click();
  await expect(size).toHaveValue('3'); // 暗くは別に覚える
  await page.getByRole('button', { name: '明るく', exact: true }).click();
  await expect(size).toHaveValue('5');
  await openTool(page, '目元・歯');
  await expect(size).toHaveValue('1.5');
});

test('形を整える: 押した所の背景（縞模様）はゆがまず、人物の側だけが縮む。なぞりながら見えたものと、保存から作り直したものが同じ', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { applyBrush } = await import('/brushfx.js');
    // 左半分は肌色の人物、右半分は縦縞の背景（壁の柱の代わり）。境目は x=300
    const W = 600; const H = 400; const base = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4; const skin = x < 300;
      const stripe = Math.floor(x / 12) % 2 ? 200 : 150;
      base.set(skin ? [225, 180, 150, 255] : [stripe, stripe, stripe + 10, 255], k);
    }
    const op = { type: 'warp', pts: Array.from({ length: 13 }, (_, i) => [(330 - i * 4) / W, 200 / H]), r: 90 / H, amt: 1 };
    const run = (o) => { const im = { width: W, height: H, data: new Uint8ClampedArray(base) }; applyBrush(im, o); return im.data; };
    const kept = run(op); const old = run({ ...op, keepBg: false });
    // 背景（境目より 20px 以上右）の変化と、境目の移動
    const bgDiff = (d) => { let m = 0; for (let y = 150; y < 250; y++) for (let x = 320; x < 420; x++) { const k = (y * W + x) * 4; m = Math.max(m, Math.abs(d[k] - base[k])); } return m; };
    const edge = (d) => { for (let x = 200; x < 400; x++) { const k = (200 * W + x) * 4; if (Math.abs(d[k] - 225) > 20) return x; } return -1; };
    return { bgKept: bgDiff(kept), bgOld: bgDiff(old), edgeKept: edge(kept), edgeOld: edge(old) };
  });
  expect(r.bgOld).toBeGreaterThan(40); // 今までは背景の縞が曲がっていた
  expect(r.bgKept).toBeLessThan(6); // 背景は（ほぼ）そのまま
  expect(r.edgeKept).toBeLessThan(296); // 人物の側は縮む（境目が左へ）
});
