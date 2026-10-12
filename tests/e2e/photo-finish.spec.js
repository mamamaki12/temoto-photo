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
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ops = (page) => page.evaluate(() => window.__temoto.state.retouch);

test('明るく・暗く: なぞった所だけ明るく（暗く）なり、元に戻せる。保存して開き直しても同じ', async ({ page }) => {
  await open(page);
  const R = [0.3, 0.4, 0.7, 0.6]; const other = [0.0, 0.85, 0.15, 1.0];
  const b0 = lum(await viewMean(page, R)); const o0 = lum(await viewMean(page, other));
  await openTool(page, '明暗');
  await expect(page.getByRole('button', { name: '明るく', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('ブラシの大きさ', { exact: true }).evaluate((el) => { el.value = 15; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await stroke(page, [[0.32, 0.5], [0.68, 0.5]]);
  expect((await ops(page)).map((o) => o.type)).toEqual(['dodge']);
  const b1 = lum(await viewMean(page, R));
  expect(b1).toBeGreaterThan(b0 + 4);
  expect(Math.abs(lum(await viewMean(page, other)) - o0)).toBeLessThan(1); // なぞっていない所は変わらない
  await page.getByRole('button', { name: '暗く', exact: true }).click();
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
    await stroke(page, [[0.55, 0.2], [0.7, 0.3]]);
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
