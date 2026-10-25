// PC 版が動くかの確認（GitHub Actions の Windows の機械で、作った .exe を実際に起動して確かめる）
//   node desktop/smoke.cjs <TemotoPhoto.exe>            … 作った .exe
//   node desktop/smoke.cjs <electron> desktop/main.cjs  … 開発中（Linux など）
// 確かめること: app://temoto/ で開く・PC 用の AI が使われる・暗所補正＋ブレ補正をして、原寸の JPEG を書き出せる
const { _electron } = require('@playwright/test');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const [exe, ...args] = process.argv.slice(2);
const PHOTO = path.join(__dirname, '..', 'tests', 'fixtures', 'portrait.jpg');
(async () => {
  const errors = []; let aiCalls = 0; let ep = null;
  const el = await _electron.launch({ executablePath: exe, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...args],
    env: { ...process.env, TEMOTO_LOG: '1' }, timeout: 120_000 });
  el.process().stdout.on('data', (d) => { aiCalls += (String(d).match(/deblur \d+ tiles/g) || []).length; ep = String(d).match(/deblur \d+ tiles (\w+)/)?.[1] || ep; });
  // GPU（DirectML）が使えなかったわけ（main.cjs の console.warn）も出す
  el.process().stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (/DirectML|GPU/.test(l)) console.log('[main]', l.slice(0, 400)); });
  const out = path.join(os.tmpdir(), `temoto-smoke-${process.env.TEMOTO_EP || 'auto'}.jpg`); fs.rmSync(out, { force: true });
  await el.evaluate(({ session }, out) => session.defaultSession.on('will-download', (e, item) => item.setSavePath(out)), out);
  const page = await el.firstWindow(); page.setDefaultTimeout(10 * 60_000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/^INFO:/.test(m.text())) errors.push(m.text()); });
  await page.waitForLoadState('load');
  const info = await page.evaluate(() => ({ href: location.href, ua: navigator.userAgent }));
  console.log(JSON.stringify(info));
  if (info.href !== 'app://temoto/index.html' || !/Electron\//.test(info.ua)) throw new Error('アプリが app://temoto/ で開いていない');
  const t0 = Date.now();
  await page.locator('#open-file').setInputFiles(PHOTO);
  await page.waitForFunction(() => window.__temoto?.editor?.L);
  const tab = page.getByRole('tab', { name: '自動補正', exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  for (const [label, v] of [['ノイズ軽減', 50], ['写真全体の明るさ補正', 50], ['被写体ブレの補正', 50]]) {
    const c = page.getByLabel(label, { exact: true }); await c.fill(String(v)); await c.dispatchEvent('change');
  }
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !!window.__temoto.editor.hq?.canvas && document.querySelector('.hq-status').hidden);
  const tEdit = (Date.now() - t0) / 1000;
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'JPEG', exact: true }).click();
  await dlg.getByRole('button', { name: /^元の大きさ/ }).click();
  await dlg.getByRole('button', { name: '書き出す', exact: true }).click();
  for (let last = -1, i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = fs.statSync(out, { throwIfNoEntry: false })?.size ?? -1;
    if (s > 0 && s === last) break; last = s;
    if (i > 300) throw new Error('書き出したファイルができない');
  }
  await el.close();
  const head = fs.readFileSync(out).subarray(0, 2);
  console.log(JSON.stringify({ ai: ep, edit: tEdit, aiCalls, exported: fs.statSync(out).size, errors }));
  if (!aiCalls) throw new Error('PC 用の AI が使われていない');
  if (head[0] !== 0xff || head[1] !== 0xd8) throw new Error('書き出したファイルが JPEG でない');
  if (errors.length) throw new Error(`画面のエラー: ${errors.join(' / ')}`);
  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
