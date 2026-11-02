// 仕上げの段ごとの計算に使うファイルの指紋を作る（tests/unit/calc-hashes.json）。
// 段の計算のファイルを変えると tests/unit/calc.test.js が止まるので、結果が変わる直しなら calc-version.js の CALC のその段の数を上げてから、
// 変わらない直しならそのまま `npm run calc-hashes` を実行して記録を更新する
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = new URL('../', import.meta.url);
/** 段 → 入口のファイル・AI のフォルダー（import でたどれる先も全部入る。app.js は画面の直しで変わるので入れない） */
export const STAGES = {
  ll: ['restoration-photo.js'],
  db: ['deblur-photo.js', 'vendor/deblur'],
  wh: ['face-photo.js', 'vendor/wholeai'],
  cm: ['crisp-photo.js', 'skinseg.js', 'vendor/mediapipe'],
  fa: ['face-photo.js', 'skinseg.js', 'vendor/faceai', 'vendor/facerec', 'vendor/mediapipe'],
  bs: ['bokeh-photo.js', 'skinseg.js', 'vendor/depth', 'vendor/mediapipe'],
  bk: ['bokeh-photo.js'],
  mix: ['restoration-photo.js', 'deblur-photo.js', 'crisp-photo.js', 'face-photo.js', 'bokeh-photo.js'],
};
const SKIP = new Set(['app.js', 'lib.js', 'ui.js']); // 画面のファイルはたどらない
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|new URL\s*\(\s*)['"](\.\/)?([\w./-]+\.js)['"]/g;
/** import・Worker でたどれるファイル（自分も含む） */
async function closure(entry, seen = new Set()) {
  if (seen.has(entry) || SKIP.has(entry)) return seen;
  seen.add(entry);
  const src = await readFile(new URL(entry, ROOT), 'utf8').catch(() => null);
  if (src == null) return seen;
  for (const m of src.matchAll(IMPORT_RE)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[2]));
    if (!dep.startsWith('..')) await closure(dep, seen);
  }
  return seen;
}
async function filesUnder(dir) {
  const root = new URL(dir + '/', ROOT);
  return (await readdir(root, { recursive: true, withFileTypes: true })).filter((d) => d.isFile())
    .map((d) => path.posix.join(dir, `${d.parentPath ?? d.path}/${d.name}`.slice(root.pathname.length).replace(/^\/+/, '')));
}
/** 段ごとの、使うファイルの一覧と指紋 */
export async function stageHashes() {
  const out = {};
  for (const [stage, entries] of Object.entries(STAGES)) {
    const files = new Set();
    for (const e of entries) { if (e.startsWith('vendor/')) for (const f of await filesUnder(e)) files.add(f); else for (const f of await closure(e)) files.add(f); }
    const list = [...files].sort(); const h = createHash('sha256');
    for (const f of list) h.update(`${f}\0${createHash('sha256').update(await readFile(new URL(f, ROOT))).digest('hex')}\n`);
    out[stage] = { hash: h.digest('hex').slice(0, 16), files: list };
  }
  return out;
}
export const RECORD = new URL('../tests/unit/calc-hashes.json', import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { CALC } = await import('../calc-version.js');
  const hashes = await stageHashes();
  const rec = Object.fromEntries(Object.entries(hashes).map(([k, v]) => [k, { calc: CALC[k], hash: v.hash, files: v.files }]));
  await writeFile(RECORD, JSON.stringify(rec, null, 1) + '\n');
  console.log('tests/unit/calc-hashes.json を更新しました:', Object.entries(rec).map(([k, v]) => `${k}=${v.calc}/${v.hash}`).join(' '));
}
