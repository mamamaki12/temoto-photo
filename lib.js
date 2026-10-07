// 共通の小さな部品。innerHTML は使わず h() で DOM を組み立てる（XSS対策）。

/** DOM要素を作る。子要素の文字列は textContent として入るのでエスケープ不要。 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    // value は属性ではなくプロパティで、子要素（select の option）を入れた後に設定する。
    // textarea は value 属性を無視するため、属性で入れると保存した文章が表示されない
    if (k === 'value') { value = v; continue; }
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  if (value !== undefined) el.value = String(value);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
/** 子要素を末尾に追加する（null/false は無視。ネイティブ append は null を "null" と表示してしまう） */
export function add(el, ...children) { append(el, children); return el; }
/** 子要素を入れ替える */
export function render(el, ...children) { el.replaceChildren(); append(el, children); }

// ── 保存（localStorage。使えない環境でも落ちない） ──
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ── トースト ──
export function toast(msg, ms = 2600) {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }); document.body.append(wrap); }
  const t = h('div', { class: 'toast' }, msg);
  wrap.append(t);
  setTimeout(() => t.remove(), ms);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
