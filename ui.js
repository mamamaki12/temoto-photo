// 画面部品（スライダー・選択チップ・色選び）
import { h } from './lib.js';

let seq = 0;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** 元に戻す（↺）の線の絵 */
function resetIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3', 'M4.5 4.5v4h4']) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
/**
 * スライダー。ドラッグ中は onInput（プレビューだけ更新）、離したら onChange（履歴に残す）。
 * 初期値から動かしたときだけ、右に「元に戻す」ボタン（↺）が出る。ラベルのダブルクリック（ダブルタップ）でも戻る。
 * ボタンの列はいつも空けておく（出たり消えたりしても、スライダーの幅が変わってつまみが指の下からずれないように）
 */
export function slider({ label, min = -100, max = 100, step = 1, value = 0, def = 0, unit = '', format, onInput, onChange, track }) {
  const id = `sl-${++seq}`;
  const out = h('output', { for: id, class: 'sl-val' });
  const input = h('input', { type: 'range', id, min, max, step, value, class: track ? `track-${track}` : null });
  // 溝は、0（両側に動かせるものは真ん中）からつまみまでを差し色で塗る（今どれだけ動かしたかが一目で分かる）
  const zero = min < 0 && max > 0 ? (0 - min) / (max - min) * 100 : 0;
  const show = () => {
    const v = Number(input.value); out.textContent = format ? format(v) : `${v > 0 && min < 0 ? '+' : ''}${Number.isInteger(step) ? v : v.toFixed(1)}${unit}`; out.classList.toggle('changed', v !== def);
    const p = (v - min) / (max - min) * 100; input.style.setProperty('--a', `${Math.min(p, zero)}%`); input.style.setProperty('--b', `${Math.max(p, zero)}%`);
    resetBtn.hidden = v === Number(def);
  };
  input.addEventListener('input', () => { show(); onInput?.(Number(input.value)); });
  input.addEventListener('change', () => onChange?.(Number(input.value)));
  const reset = () => { input.value = def; show(); onInput?.(def); onChange?.(def); };
  // 「暗い写真を明るく」のように、ひらがなで終わる名前は「」でくくる（「明るくを元に戻す」と読まないように）
  const resetName = `${/[\u3041-\u309f]$/.test(label) ? `「${label}」` : label}を元に戻す`;
  const resetBtn = h('button', { type: 'button', class: 'sl-reset', 'aria-label': resetName, title: resetName, onclick: reset }, resetIcon());
  const lab = h('label', { for: id, title: 'ダブルクリックで元に戻す', ondblclick: reset }, label);
  show();
  const el = h('div', { class: 'sl' }, h('div', { class: 'sl-head' }, lab, out), input, resetBtn);
  return { el, input, set(v) { input.value = v; show(); }, reset };
}

/** 1つを選ぶボタンの列 */
export function chips(items, value, onPick, { label, cls = '' } = {}) {
  const el = h('div', { class: `chips ${cls}`, role: 'group', 'aria-label': label });
  const draw = (v) => {
    el.replaceChildren(...items.map(([k, text, extra]) => h('button', {
      type: 'button', 'aria-pressed': String(k === v), title: extra?.title, style: extra?.style,
      onclick: () => { draw(k); onPick(k); },
    }, text)));
  };
  draw(value);
  return { el, set: draw };
}

export const SWATCHES = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#ff2d55', '#a2845e', '#8e8e93'];
/** 色を選ぶ（よく使う色 + 自由に選ぶ） */
export function colorPicker({ label, value, onPick }) {
  const id = `cp-${++seq}`;
  const free = h('input', { type: 'color', id, value, 'aria-label': `${label}（自由に選ぶ）` });
  free.addEventListener('input', () => { onPick(free.value); mark(free.value); });
  const btns = SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch', style: { background: c }, 'aria-label': `${label}: ${c}`, onclick: () => { free.value = c; onPick(c); mark(c); } }));
  const mark = (v) => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(SWATCHES[i] === v)));
  mark(value);
  return { el: h('div', { class: 'color-row' }, h('span', { class: 'cp-label' }, label), ...btns, free), set(v) { free.value = v; mark(v); } };
}

/** 小さなトグル（チェックボックス） */
export function toggle(label, checked, onChange) {
  const id = `tg-${++seq}`;
  const input = h('input', { type: 'checkbox', id, checked, onchange: () => onChange(input.checked) });
  return { el: h('label', { class: 'tg', for: id }, input, h('span', {}, label)), input };
}

export const fmtBytes = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
