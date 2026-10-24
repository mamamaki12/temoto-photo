import { test, expect } from '@playwright/test';

test('復元Worker: 元データを維持して進捗を返し、中止後にも再実行できる', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { restoreInWorker } = await import('/restoration-client.js');
    const data = new Float32Array(32 * 32 * 3).fill(0.125);
    const image = { data, width: 32, height: 32 }; const progress = [];
    const restored = await restoreInWorker(image, { exposureEV: 2, tileSize: 16 }, { onProgress: (p) => progress.push(p.percent) });
    const controller = new AbortController();
    const cancelled = restoreInWorker(image, {}, { signal: controller.signal, onProgress: () => controller.abort() }).catch((e) => e.name);
    const cancellation = await cancelled;
    const retry = await restoreInWorker(image, { strength: 0 });
    let invalid;
    try { await restoreInWorker(image, { tileSize: -1 }); } catch (e) { invalid = e.message; }
    return { progress, value: restored.data[0], source: data[0], length: data.length, cancellation, retry: retry.data[0], invalid };
  });
  expect(result.progress).toEqual([0, 25, 50, 75, 100]);
  expect(result.value).toBe(0.5);
  expect(result.source).toBe(0.125);
  expect(result.length).toBe(32 * 32 * 3);
  expect(result.cancellation).toBe('AbortError');
  expect(result.retry).toBe(0.125);
  expect(result.invalid).toContain('tileSize');
});
