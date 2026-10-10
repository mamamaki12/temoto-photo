// RAW を 16bit の細かさで編集する（強く持ち上げても、なめらかなグラデーションに縞が出ない）
import { test, expect } from '@playwright/test';

/**
 * 暗い所のなめらかなグラデーション（リニアで 0.012〜0.03。8bit だと 20 段階ほど）を現像して、トーンカーブで 10 倍ほどに引き伸ばして描き、
 * 列ごとの平均（ディザは平均すると消える）の、となりとの差の最大を返す。縞があると、段差のところで大きく跳ぶ
 */
async function banding(page, { residual }) {
  return page.evaluate(async (residual) => {
    const { Engine } = await import('/engine.js'); const { developToCanvas } = await import('/rawlib.js'); const { defaultState } = await import('/state.js');
    const W = 512; const H = 64; const data = new Uint16Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = Math.round((0.012 + (x / (W - 1)) * 0.018) * 65535); data.set([v, v, v], (y * W + x) * 3); }
    const base = developToCanvas({ data, width: W, height: H, gain: 1 }, { exposure: 0, nr: 0, sharpen: 0 });
    const eng = new Engine(document.createElement('canvas'));
    eng.setSource(base, W, H); eng.setResidual(residual ? base.residual : null);
    const st = defaultState(); st.curves.rgb = [[0, 0], [0.08, 0.05], [0.16, 0.95], [1, 1]];
    eng.render(st, W, H);
    const gl = eng.gl; const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const col = []; for (let x = 0; x < W; x++) { let s = 0; for (let y = 0; y < H; y++) s += px[(y * W + x) * 4 + 1]; col.push(s / H); }
    let jump = 0; for (let x = 1; x < W; x++) jump = Math.max(jump, Math.abs(col[x] - col[x - 1]));
    eng.dispose();
    return { jump, lo: col[0], hi: col[W - 1], hi16: eng.hi };
  }, residual);
}

test('RAW は 16bit の細かさで編集する: 暗い所を強く持ち上げても、グラデーションに縞（段差）が出ない', async ({ page }) => {
  await page.goto('/');
  const r8 = await banding(page, { residual: false });
  const r16 = await banding(page, { residual: true });
  // どちらも同じように引き伸ばされている
  expect(r16.hi - r16.lo).toBeGreaterThan(150);
  expect(Math.abs(r16.hi - r8.hi)).toBeLessThan(3);
  // 8bit だけだと段差（となりの列と数段階の差）ができる。16bit なら、なめらかに増えていく
  expect(r8.jump).toBeGreaterThan(8);
  expect(r16.jump).toBeLessThan(1.6);
});

test('シャドウで暗い紺を持ち上げても、鮮やかな青にならない（色の濃さは明るさほど増やさない）', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { Engine } = await import('/engine.js'); const { defaultState } = await import('/state.js');
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = 'rgb(22,26,52)'; x.fillRect(0, 0, 64, 64);
    const eng = new Engine(document.createElement('canvas')); eng.setSource(c, 64, 64);
    const read = (st) => { eng.render(st, 64, 64); const px = new Uint8Array(4); eng.gl.readPixels(32, 32, 1, 1, eng.gl.RGBA, eng.gl.UNSIGNED_BYTE, px); return [...px.slice(0, 3)]; };
    const before = read(defaultState()); const st = defaultState(); st.adj.shadows = 60; const after = read(st);
    eng.dispose(); return { before, after };
  });
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b; const chroma = (p) => Math.max(...p) - Math.min(...p);
  const lr = luma(r.after) / luma(r.before);
  expect(lr).toBeGreaterThan(1.5); // ちゃんと明るくなる
  expect(chroma(r.after) / chroma(r.before)).toBeLessThan(lr * 0.8); // 色の濃さは明るさほど増えない
  expect(r.after[2]).toBeGreaterThan(r.after[0]); // 紺（青み）のまま
});
