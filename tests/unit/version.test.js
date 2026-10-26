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
