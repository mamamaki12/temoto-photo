// 画面部品（スライダー・選択チップ・色選び）
import { h } from './lib.js';

let seq = 0;
/**
 * スライダー。ドラッグ中は onInput（プレビューだけ更新）、離したら onChange（履歴に残す）。
 * ラベルをダブルクリック（ダブルタップ）すると初期値に戻る
 */
export function slider({ label, min = -100, max = 100, step = 1, value = 0, def = 0, unit = '', format, onInput, onChange, track }) {
  const id = `sl-${++seq}`;
  const out = h('output', { for: id, class: 'sl-val' });
  const input = h('input', { type: 'range', id, min, max, step, value, class: track ? `track-${track}` : null });
  const show = () => { const v = Number(input.value); out.textContent = format ? format(v) : `${v > 0 && min < 0 ? '+' : ''}${Number.isInteger(step) ? v : v.toFixed(1)}${unit}`; out.classList.toggle('changed', v !== def); };
  input.addEventListener('input', () => { show(); onInput?.(Number(input.value)); });
  input.addEventListener('change', () => onChange?.(Number(input.value)));
  const reset = () => { input.value = def; show(); onInput?.(def); onChange?.(def); };
  const lab = h('label', { for: id, title: 'ダブルクリックで元に戻す', ondblclick: reset }, label);
  show();
  const el = h('div', { class: 'sl' }, h('div', { class: 'sl-head' }, lab, out), input);
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
