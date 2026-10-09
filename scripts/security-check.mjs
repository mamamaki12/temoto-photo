// 静的セキュリティチェック: node scripts/security-check.mjs
// - 危険なAPI（innerHTML への代入、eval、new Function、document.write、insertAdjacentHTML）を禁止
// - HTML のインラインスクリプト・インラインイベントハンドラを禁止
// - すべての HTML に CSP（script-src 'self'、object-src 'none'）があること
// - target="_blank" には rel="noopener" を必須
// - 外部スクリプトの読み込みを禁止
// - CSP で外部への通信を禁止していること（connect-src 'none'。写真を端末の外に出さない）
// - vendor/（そのまま入れた外部のライブラリ。WebAssembly のつなぎで new Function を使う）は上の規則の対象外にし、
//   代わりに「外部の URL を含まない」「決めたファイルだけ」を確かめる（Worker の中で、同じサイトのファイルだけを読む）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'tests', 'scripts', '_site', 'playwright.config.js', 'vendor']);
const VENDOR = { 'vendor/libraw': ['index.js', 'worker.js', 'libraw.js', 'libraw.wasm', 'LICENSE.txt'] };
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (SKIP.has(n)) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs|html)$/.test(n)) files.push(p);
  }
})(root);

const problems = [];
const JS_RULES = [
  [/\.innerHTML\s*=(?!=)/, 'innerHTML への代入（h()/textContent を使う）'],
  [/\.outerHTML\s*=(?!=)/, 'outerHTML への代入'],
  [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'new Function'],
  [/document\.write\s*\(/, 'document.write'],
  [/setTimeout\s*\(\s*['"`]/, '文字列を渡す setTimeout'],
  [/setInterval\s*\(\s*['"`]/, '文字列を渡す setInterval'],
  [/localStorage\.setItem\([^)]*(password|token|secret)/i, '秘密情報を localStorage に保存'],
];
for (const f of files) {
  const rel = relative(root, f);
  const src = readFileSync(f, 'utf8');
  if (f.endsWith('.html')) {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(src)) problems.push(`${rel}: インラインスクリプト`);
    if (/\son[a-z]+\s*=\s*["']/i.test(src)) problems.push(`${rel}: インラインイベントハンドラ`);
    const csp = src.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    if (!csp) problems.push(`${rel}: CSP がない`);
    else {
      if (!/script-src 'self'(;|$)/.test(csp[1])) problems.push(`${rel}: script-src が 'self' のみになっていない`);
      if (!/object-src 'none'/.test(csp[1])) problems.push(`${rel}: object-src 'none' がない`);
      if (/unsafe-(inline|eval)/.test(csp[1])) problems.push(`${rel}: CSP に unsafe-* がある`);
      if (!/connect-src 'none'/.test(csp[1])) problems.push(`${rel}: connect-src 'none' がない（外部へ通信できてしまう）`);
    }
    for (const m of src.matchAll(/<script[^>]+src="([^"]+)"/g)) if (/^(https?:)?\/\//.test(m[1])) problems.push(`${rel}: 外部スクリプト ${m[1]}`);
    for (const m of src.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)) if (!/rel="[^"]*noopener/.test(m[0])) problems.push(`${rel}: target=_blank に rel=noopener がない`);
  } else {
    src.split('\n').forEach((line, i) => {
      for (const [re, msg] of JS_RULES) if (re.test(line)) problems.push(`${rel}:${i + 1}: ${msg}`);
      if (/target:\s*'_blank'/.test(line) && !/rel:\s*'[^']*noopener/.test(line)) problems.push(`${rel}:${i + 1}: target=_blank に rel=noopener がない`);
    });
    if (/import\s[^;]*from\s+['"]https?:/.test(src)) problems.push(`${rel}: 外部モジュールの import`);
  }
}

for (const [dir, allowed] of Object.entries(VENDOR)) {
  const names = readdirSync(join(root, dir));
  for (const n of names) if (!allowed.includes(n)) problems.push(`${dir}/${n}: 決めたファイル以外がある`);
  for (const n of names.filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(join(root, dir, n), 'utf8');
    if (/https?:\/\//.test(src)) problems.push(`${dir}/${n}: 外部の URL がある`);
    if (/import\s*\(\s*['"`]https?:/.test(src) || /importScripts\s*\(\s*['"`]https?:/.test(src)) problems.push(`${dir}/${n}: 外部のスクリプトを読み込む`);
  }
}

if (problems.length) {
  console.error(`✗ セキュリティチェック: ${problems.length} 件の問題\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`✓ セキュリティチェック: ${files.length} ファイル、問題なし`);
