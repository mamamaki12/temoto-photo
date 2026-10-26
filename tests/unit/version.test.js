// 版の番号が、画面（app.js）・Service Worker（sw.js）・package.json でそろっていること
// （sw.js の版がずれると、アプリの「更新」が、ずっと「新しい版があります」と出したり、更新を見逃したりする）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (f) => readFile(new URL(`../../${f}`, import.meta.url), 'utf8');

test('app.js・sw.js・package.json の版が同じ', async () => {
  const app = (await read('app.js')).match(/const VERSION = '([^']+)'/)?.[1];
  const sw = (await read('sw.js')).match(/const VERSION = '([^']+)'/)?.[1];
  const pkg = JSON.parse(await read('package.json')).version;
  assert.ok(app && sw, 'VERSION が見つかりません');
  assert.equal(sw, app, 'sw.js の VERSION を app.js と同じにしてください');
  assert.equal(pkg, app, 'package.json の version を app.js と同じにしてください');
});

// sw.js の VENDOR_CACHE（版を上げても残す vendor/ のキャッシュ）の名前は、vendor/ の中身の指紋。
// vendor/ を変えたのに名前を変えないと、端末に古い AI・WebAssembly が残り続ける
test('sw.js の VENDOR_CACHE が vendor/ の中身と合っている', async () => {
  const { createHash } = await import('node:crypto');
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../../vendor/', import.meta.url);
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((d) => d.isFile())
    .map((d) => `${d.parentPath ?? d.path}/${d.name}`.slice(root.pathname.length).replace(/^\/+/, '')).sort();
  const all = createHash('sha256');
  for (const f of files) all.update(`${f}\0${createHash('sha256').update(await readFile(new URL(f, root))).digest('hex')}\n`);
  const want = `temoto-vendor-${all.digest('hex').slice(0, 8)}`;
  const sw = (await read('sw.js')).match(/const VENDOR_CACHE = '([^']+)'/)?.[1];
  assert.equal(sw, want, `vendor/ が変わりました。sw.js の VENDOR_CACHE を '${want}' にしてください`);
});
