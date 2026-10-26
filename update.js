// アプリの更新: 新しい版が公開されたら知らせ、ボタンで入れ替えて読み込み直す
// ホーム画面のアプリ（特に iPhone）は、閉じても裏で残っていて読み込み直されないため、古い版のまま使い続けてしまう。
// 版の確認は Service Worker の更新（sw.js の取得）だけで行う。ページからは通信しない（CSP は connect-src 'none' のまま）
import { h } from './lib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHECK_EVERY = 5 * 60 * 1000; // アプリに戻ってきたときの確認は、5分に1回まで

let reg = null;
let pageVersion = '';
let ready = false; // 新しい版が入っていて、読み込み直せば使える
let lastCheck = 0;
let beforeReload = () => {};
const subs = new Set();

function setReady() {
  if (ready) return;
  ready = true;
  for (const f of subs) f();
  showBanner();
}

/** 動いている Service Worker の版を聞く（古い sw.js は答えないので、少し待って諦める） */
function swVersion(sw) {
  if (!sw) return Promise.resolve(null);
  return new Promise((res) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => res(null), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data?.version || null); };
    try { sw.postMessage({ type: 'version' }, [ch.port2]); } catch { clearTimeout(t); res(null); }
  });
}

/** 新しい Service Worker の入れ替え（インストール → 有効化）が終わるまで待つ */
function settle(sw, ms = 20000) {
  if (!sw || sw.state === 'activated' || sw.state === 'redundant') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    sw.addEventListener('statechange', () => { if (sw.state === 'activated' || sw.state === 'redundant') { clearTimeout(t); res(); } });
  });
}

/** このページより新しい版が入っているか */
async function compare() {
  await settle(reg?.installing || reg?.waiting);
  const v = await swVersion(navigator.serviceWorker.controller || reg?.active);
  if (v && v !== pageVersion) setReady();
  return v;
}

/**
 * 新しい版がないか確かめる。'ready'（新しい版がある）・'latest'（最新）・'offline'（確認できない）・'unsupported'
 * @param {{ force?: boolean }} [opt] force でないときは、前の確認から5分たつまで何もしない
 */
export async function checkUpdate({ force = false } = {}) {
  if (!reg) return 'unsupported';
  if (ready) return 'ready';
  if (!force && Date.now() - lastCheck < CHECK_EVERY) return 'latest';
  lastCheck = Date.now();
  try { await reg.update(); } catch { return 'offline'; }
  await compare();
  return ready ? 'ready' : 'latest';
}

/** 新しい版で読み込み直す（編集は保存してから） */
export function applyUpdate() {
  try { beforeReload(); } catch {}
  location.reload();
}

export const updateReady = () => ready;

/** 起動時に一度だけ呼ぶ: Service Worker を登録し、アプリに戻ってきたときにも新しい版を確かめる */
export function initUpdate(version, { flush } = {}) {
  pageVersion = version;
  if (flush) beforeReload = flush;
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  // 新しい sw.js が有効になった（このページは古い版のまま）。初めて開いたとき（前の Service Worker がない）は除く
  sw.addEventListener('controllerchange', () => { if (hadController) compare(); });
  sw.register(new URL('./sw.js', import.meta.url), { scope: new URL('./', import.meta.url).pathname, updateViaCache: 'none' })
    .then((r) => { reg = r; lastCheck = Date.now(); return compare(); })
    .catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate().catch(() => {}); });
}

function updateSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'update-svg');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5');
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

/**
 * 「アプリを更新」ボタン。押すと新しい版を確かめ、あれば読み込み直す
 * @param {(msg: string) => void} toast
 * @param {{ withLabel?: boolean }} [opt] withLabel: メニューの中に置く（文字つき）
 */
export function updateButton(toast, { withLabel = false } = {}) {
  const label = h('span', { class: 'update-label' });
  const b = h('button', { type: 'button', class: withLabel ? 'app-update labeled' : 'app-update' }, h('span', { class: 'update-icon' }, updateSvg()), h('span', { class: 'update-dot', 'aria-hidden': 'true' }), withLabel ? label : null);
  const sync = () => {
    const tip = ready ? '新しい版があります（押すと更新）' : `アプリの更新を確認（今の版 ${pageVersion}）`;
    label.textContent = ready ? '新しい版に更新' : `アプリの更新を確認（${pageVersion}）`;
    b.setAttribute('aria-label', tip); b.title = tip; b.classList.toggle('has-update', ready);
  };
  sync();
  // 画面から消えたボタンは、知らせる先から外す
  for (const f of subs) if (f.button && !f.button.isConnected) subs.delete(f);
  sync.button = b; subs.add(sync);
  b.addEventListener('click', async () => {
    if (ready) { applyUpdate(); return; }
    if (!reg) { toast(location.protocol === 'file:' ? 'ファイルから開いているので、更新はありません' : 'このブラウザでは更新を確認できません'); return; }
    b.disabled = true; b.classList.add('checking');
    toast('新しい版を確認しています…');
    const r = await checkUpdate({ force: true }).catch(() => 'offline');
    b.disabled = false; b.classList.remove('checking');
    if (r === 'ready') { toast('新しい版に更新します'); setTimeout(applyUpdate, 400); }
    else if (r === 'offline') toast('確認できませんでした（インターネットにつながっているか確かめてください）');
    else toast(`最新の版です（${pageVersion}）`);
  });
  return b;
}

/** 新しい版が入ったら、画面の下に「更新」を出す（どの画面でも） */
function showBanner() {
  if (document.querySelector('.update-bar')) return;
  const bar = h('div', { class: 'update-bar', role: 'status' },
    h('span', {}, '新しい版があります'),
    h('button', { type: 'button', class: 'primary', onclick: applyUpdate }, '更新'),
    h('button', { type: 'button', class: 'update-later', 'aria-label': 'あとで', title: 'あとで', onclick: () => bar.remove() }, '×'));
  document.body.append(bar);
}
