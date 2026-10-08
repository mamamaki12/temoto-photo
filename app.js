// てもとフォト: 写真を端末の外に出さずに編集する（読み込み・編集・保存・書き出しのすべてがこの端末の中）
import { h, add, render, $, toast, uid, download } from './lib.js';
import * as S from './state.js';
import { Engine } from './engine.js';
import { effective, LOOKS } from './presets.js';
import { geoParams, outToSrc, srcToOut, outputSize, orientedSize, aspectValue, fitCrop, dragCrop } from './geometry.js';
import { autoAdjust, histogram } from './auto.js';
import { readExif, readTiffExif } from './exif.js';
import { isRawName } from './raw.js';
import { LAYOUTS, GRID_ASPECTS, MAX_GRID, defaultGrid, layoutById, cellRects, coverSource, gridSize, drawGrid, hitCell, hitDivider, dividerRange, gridMetrics, cellEdges } from './grid.js';
import { applyRetouch } from './retouch.js';
import { applyPortrait, portraitActive, tintSkin, PORTRAIT } from './portrait.js';
import { compose, hitOverlay, overlayBox, layout } from './compose.js';
import { monotoneSpline } from './curves.js';
import * as db from './db.js';
import { slider, chips, colorPicker, toggle, fmtBytes } from './ui.js';

const app = $('#app');
const MAX_PIXELS = 16_700_000; // iPhone の Safari が扱える Canvas の上限（約1,670万画素）に合わせる
const MAX_SIDE = 8192;
const VERSION = '1.2.0'; // 画面の「情報」に出す（古い版が表示されていないかの確認用）
const PREVIEW_MAX = 2048;
const ZOOM_MAX = 4096; // 拡大表示のときに描く長辺の上限
const STICKERS = ['😀', '😂', '🥰', '😎', '🥺', '😭', '😡', '🤔', '👍', '👏', '🙏', '💪', '❤️', '💖', '💯', '✨', '⭐', '🌟', '🔥', '🎉', '🎂', '🎁', '🌸', '🌈', '☀️', '🌙', '⚡', '❄️', '🍀', '🍓', '🍰', '☕', '🍜', '🐶', '🐱', '🐻', '🐰', '🦄', '📷', '🎵', '🎤', '✈️', '🚗', '🏠', '📍', '✅', '❗', '❓'];
const TOOLS = [
  ['auto', '✦', '自動'], ['looks', '◐', 'フィルター'], ['light', '☀', 'ライト'], ['color', '◒', 'カラー'], ['hsl', '◍', 'HSL'], ['curves', '∿', 'カーブ'],
  ['grade', '◑', 'グレーディング'], ['detail', '◇', 'ディテール'], ['effects', '✧', '効果'], ['crop', '⌗', '切り抜き'], ['local', '◎', '部分補正'],
  ['skin', '❀', '美肌'], ['heal', '✚', '修復'], ['hide', '▦', 'モザイク'], ['text', 'A', '文字'], ['sticker', '☺', 'スタンプ'], ['draw', '✎', '描画'], ['frame', '▢', 'フレーム'], ['info', 'ⓘ', '情報'],
];
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`temoto:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`temoto:${k}`, JSON.stringify(v)); } catch { /* 保存できない環境 */ } },
};

let E = null; // 編集中の写真

// ───────────────────────── 読み込み ─────────────────────────
async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {
    // createImageBitmap が対応していない形式は <img> 経由で
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode();
      return await createImageBitmap(img);
    } finally { URL.revokeObjectURL(url); }
  }
}
/** 大きすぎる写真は、端末が扱える大きさに縮める */
function workSize(w, hgt, maxTex = MAX_SIDE) {
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (w * hgt)), Math.min(MAX_SIDE, maxTex) / Math.max(w, hgt));
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(hgt * s)), scaled: s < 1 }; // 切り捨てて、上限を超えないように
}
function toCanvas(src, w, hgt) {
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  c.getContext('2d').drawImage(src, 0, 0, w, hgt);
  return c;
}
/** 高画質で縮める（一度に半分より小さくすると細部がつぶれるので、半分ずつ段階的に） */
function shrink(src, w, hgt) {
  let cur = src; let cw = src.width; let ch = src.height;
  do {
    const nw = Math.max(w, Math.round(cw / 2)); const nh = Math.max(hgt, Math.round(ch / 2));
    const c = document.createElement('canvas'); c.width = nw; c.height = nh;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    if (cur !== src) { cur.width = 0; cur.height = 0; } // 途中の Canvas のメモリをすぐ返す
    cur = c; cw = nw; ch = nh;
  } while (cw !== w || ch !== hgt);
  return cur;
}
async function thumbBlob(src, side = 360) {
  const s = Math.min(1, side / Math.max(src.width, src.height));
  const c = toCanvas(src, Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
}
const isImage = (f) => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i.test(f.name || '') || isRawName(f.name));
const ACCEPT = 'image/*,.dng,.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.pef,.srw,.3fr,.fff,.iiq,.erf,.mef,.mos,.kdc,.dcr,.x3f,.tif,.tiff';

/** 向き（Exif の Orientation）に合わせて回した Canvas を作る */
function orientCanvas(img, o) {
  if (!o || o === 1) return img;
  const w = img.width; const hgt = img.height; const swap = o >= 5;
  const c = document.createElement('canvas'); c.width = swap ? hgt : w; c.height = swap ? w : hgt;
  const x = c.getContext('2d');
  const T = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, hgt], 4: [1, 0, 0, -1, 0, hgt], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, hgt, 0], 7: [0, -1, -1, 0, hgt, w], 8: [0, -1, 1, 0, 0, w] }[o];
  if (T) x.setTransform(...T);
  x.drawImage(img, 0, 0);
  img.close?.();
  return c;
}

/**
 * RAW を開く。DNG は RAW データから現像、ほかはファイルの中の JPEG を使う（重い処理は Worker で）
 * @returns {Promise<{image: ImageBitmap|HTMLCanvasElement, info: object}>}
 */
async function decodeRawBlob(blob, name) {
  const buffer = await blob.arrayBuffer();
  let r;
  let worker = null;
  try { worker = new Worker(new URL('./raw-worker.js', import.meta.url), { type: 'module' }); } catch { worker = null; }
  if (worker) {
    r = await new Promise((res, rej) => {
      worker.onmessage = (e) => { worker.terminate(); if (e.data.ok) res(e.data); else rej(new Error(e.data.error)); };
      worker.onerror = () => { worker.terminate(); rej(new Error('worker')); };
      worker.postMessage({ buffer, name, maxPixels: MAX_PIXELS }, [buffer]);
    });
  } else {
    const { decodeRaw } = await import('./raw.js');
    const d = decodeRaw(buffer, { name, maxPixels: MAX_PIXELS });
    r = d.kind === 'raw' ? d : { ...d, jpegs: d.previews.slice(0, 3).map((p) => ({ w: p.w, h: p.h, bytes: buffer.slice(p.offset, p.offset + p.length) })) };
  }
  if (r.kind === 'raw') {
    const img = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer, 0, r.width * r.height * 4), r.width, r.height));
    return { image: img, info: { kind: 'raw', format: r.format, scaled: !!r.scaled } };
  }
  for (const j of r.jpegs) {
    try {
      const own = readExif(j.bytes)?.orientation || 1; // プレビュー自身に向きの情報があれば、それを使う
      const bmp = await createImageBitmap(new Blob([j.bytes], { type: 'image/jpeg' }), { imageOrientation: own > 1 ? 'from-image' : 'none' });
      return { image: own > 1 ? bmp : orientCanvas(bmp, r.orientation), info: { kind: 'preview', format: r.format, previewW: j.w, previewH: j.h } };
    } catch { /* 次の候補へ */ }
  }
  throw new Error('no preview');
}
/** ふつうの画像も RAW も開ける */
async function decodeAny(blob, name, proj) {
  if (isRawName(name || proj?.fileName) || proj?.raw) return decodeRawBlob(blob, name || proj.fileName);
  return { image: await decode(blob), info: null };
}

async function importFiles(files) {
  const list = [...files].filter(isImage);
  if (!list.length) { toast('画像ファイルを選んでください'); return; }
  db.persist();
  let first = null; let ok = 0;
  for (const f of list) {
    try {
      const raw = isRawName(f.name);
      if (raw) toast(`${f.name} を読み込んでいます（RAW）…`);
      const { image: bmp, info } = await decodeAny(f, f.name);
      const id = uid();
      const exif = raw ? readTiffExif(await f.slice(0, 4 * 1024 * 1024).arrayBuffer()) : /jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name) ? readExif(await f.slice(0, 512 * 1024).arrayBuffer()) : null;
      await db.addProject({ id, name: (f.name || '写真').replace(/\.[^.]+$/, '').slice(0, 80) || '写真', fileName: (f.name || '').slice(0, 200), raw: info, created: Date.now(), updated: Date.now(), w: bmp.width, h: bmp.height, size: f.size, type: f.type || (raw ? 'image/x-raw' : ''), exif, state: S.defaultState(), thumb: await thumbBlob(bmp) }, f);
      bmp.close?.();
      first ??= id; ok++;
    } catch {
      toast(/heic|heif/i.test(f.type + f.name) ? 'HEIC はこのブラウザでは開けません（Safari なら開けます）' : isRawName(f.name) ? `${f.name} は開けませんでした（このRAWの形式には対応していません）` : `${f.name || '画像'} を読み込めませんでした`);
    }
  }
  if (ok === 1 && first) openEditor(first); else showLibrary();
  if (ok > 1) toast(`${ok}枚を追加しました`);
}

/** 写真と編集内容から、描画に必要なもの（元画像・修復後の画像・マスク）を用意する */
async function prepare(proj, blob, maxTex) {
  const { image: bmp } = await decodeAny(blob, proj.fileName, proj);
  const ws = workSize(bmp.width, bmp.height, maxTex);
  let base = bmp;
  if (ws.w !== bmp.width || ws.h !== bmp.height) {
    // createImageBitmap の縮小は、ブラウザによっては画質の指定が効かず粗くなるので、Canvas で高画質に縮める
    base = shrink(bmp, ws.w, ws.h);
    bmp.close?.();
  }
  return { base, W: ws.w, H: ws.h, scaled: ws.scaled, origW: proj.w, origH: proj.h };
}

/** 修復・モザイクと美肌を元写真の画素に当てる（美肌が先。あとから足す修復は、美肌の後の画素にそのまま重ねられる） */
function retouchCanvas(base, ops, portrait, cache) {
  const c = toCanvas(base, base.width, base.height);
  if (!ops.length && !portraitActive(portrait)) return { canvas: c, data: null };
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let data;
  if (!portraitActive(portrait)) data = ctx.getImageData(0, 0, c.width, c.height);
  else {
    // 美肌は重いので、同じ強さなら前の結果を使い回す（修復の取り消しなどで計算し直さない）
    const key = JSON.stringify(portrait);
    if (cache?.key !== key) {
      const pd = ctx.getImageData(0, 0, c.width, c.height); applyPortrait(pd, portrait);
      if (cache) { cache.key = key; cache.data = pd; }
      data = cache ? new ImageData(new Uint8ClampedArray(pd.data), pd.width, pd.height) : pd;
    } else data = new ImageData(new Uint8ClampedArray(cache.data.data), cache.data.width, cache.data.height);
  }
  applyRetouch(data, ops);
  ctx.putImageData(data, 0, 0);
  return { canvas: c, data };
}

/** ブラシの部分補正のマスク（RGBA 各チャンネルに1つずつ、元写真の座標で） */
function buildMask(state, W, H, cache = new Map()) {
  const brushes = state.locals.filter((l) => l.type === 'brush').slice(0, 4);
  const s = Math.min(1, 1024 / Math.max(W, H)); const mw = Math.max(1, Math.round(W * s)); const mh = Math.max(1, Math.round(H * s));
  // Canvas に入れると透明度で色が消える（乗算済みアルファ）ので、生の画素の配列のまま GPU に送る
  const out = { width: mw, height: mh, data: new Uint8Array(mw * mh * 4) };
  brushes.forEach((l, ch) => {
    const c = brushCanvas(l, mw, mh, cache);
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mw, mh).data;
    for (let i = 0; i < mw * mh; i++) out.data[i * 4 + ch] = d[i * 4 + 3];
  });
  return out;
}
function brushCanvas(l, mw, mh, cache) {
  const key = `${l.id}:${mw}x${mh}`;
  let ent = cache.get(key);
  if (!ent) { const c = document.createElement('canvas'); c.width = mw; c.height = mh; ent = { c, n: 0 }; cache.set(key, ent); }
  if (ent.n > l.strokes.length) { ent.c.getContext('2d').clearRect(0, 0, mw, mh); ent.n = 0; }
  const ctx = ent.c.getContext('2d');
  for (; ent.n < l.strokes.length; ent.n++) paintStroke(ctx, l.strokes[ent.n], mw, mh);
  return ent.c;
}
function paintStroke(ctx, st, mw, mh, from = 0) {
  const r = Math.max(1, st.size * Math.min(mw, mh));
  ctx.save();
  ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
  const dab = (x, y) => {
    const g = ctx.createRadialGradient(x, y, r * st.hard * 0.95, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${st.flow})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  let prev = null;
  for (let i = Math.max(0, from - 1); i < st.pts.length; i++) {
    const [x, y] = [st.pts[i][0] * mw, st.pts[i][1] * mh];
    if (prev) {
      const d = Math.hypot(x - prev[0], y - prev[1]); const n = Math.floor(d / (r * 0.3));
      for (let k = 1; k <= n; k++) dab(prev[0] + ((x - prev[0]) * k) / (n + 1), prev[1] + ((y - prev[1]) * k) / (n + 1));
    }
    if (i >= from || from === 0) dab(x, y);
    prev = [x, y];
  }
  ctx.restore();
}

// ───────────────────────── 写真一覧 ─────────────────────────
let libUrls = [];
let selecting = new Set();
async function showLibrary() {
  closeEditor();
  document.title = 'てもとフォト';
  libUrls.forEach((u) => URL.revokeObjectURL(u)); libUrls = [];
  const projects = await db.listProjects().catch(() => []);
  const fileIn = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'vh', id: 'open-file', onchange: () => { importFiles(fileIn.files); fileIn.value = ''; } });
  const sel = () => projects.filter((p) => selecting.has(p.id));
  const bar = h('div', { class: 'lib-actions' });
  const drawBar = () => {
    render(bar, selecting.size ? [
      h('span', { class: 'muted' }, `${selecting.size}枚を選択中`),
      h('button', { type: 'button', disabled: !prefs.get('clip', null), onclick: async () => { const clip = prefs.get('clip', null); for (const p of sel()) await db.putProject({ ...p, state: S.applyPreset(S.validateState(p.state), clip), updated: Date.now() }); toast('編集を貼り付けました'); selecting.clear(); showLibrary(); } }, '編集を貼り付け'),
      h('button', { type: 'button', class: 'primary', disabled: selecting.size < 2 || selecting.size > MAX_GRID, title: selecting.size > MAX_GRID ? `グリッドは${MAX_GRID}枚まで` : '', onclick: () => showGrid(sel()) }, `▦ グリッドを作る${selecting.size > MAX_GRID ? `（${MAX_GRID}枚まで）` : ''}`),
      h('button', { type: 'button', onclick: () => openExport({ batch: sel() }) }, 'まとめて書き出し'),
      h('button', { type: 'button', class: 'danger', onclick: () => confirmBox(`${selecting.size}枚の写真と編集内容を、この端末から削除します。元に戻せません。`, '削除する', async () => { for (const p of sel()) await db.deleteProject(p.id); selecting.clear(); showLibrary(); }) }, '削除'),
      h('button', { type: 'button', class: 'ghost', onclick: () => { selecting.clear(); showLibrary(); } }, '選択をやめる'),
    ] : null);
  };
  drawBar();
  const grid = h('ul', { class: 'lib-grid' }, projects.map((p) => {
    const url = p.thumb ? URL.createObjectURL(p.thumb) : ''; if (url) libUrls.push(url);
    const edited = S.isEdited(S.validateState(p.state));
    const check = h('input', { type: 'checkbox', class: 'lib-check', checked: selecting.has(p.id), 'aria-label': `${p.name}を選択`, onchange: (e) => { if (e.target.checked) selecting.add(p.id); else selecting.delete(p.id); drawBar(); grid.classList.toggle('selecting', selecting.size > 0); } });
    return h('li', { class: 'lib-item' },
      h('button', { type: 'button', class: 'lib-open', onclick: () => (selecting.size ? check.click() : openEditor(p.id)), 'aria-label': `${p.name}を編集` },
        url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'lib-noimg' }, '?'),
        edited ? h('span', { class: 'lib-badge' }, '編集済み') : null,
        p.raw ? h('span', { class: 'lib-badge raw' }, 'RAW') : null),
      h('div', { class: 'lib-meta' }, check, h('span', { class: 'lib-name' }, p.name), h('span', { class: 'muted small' }, `${p.w}×${p.h}`)));
  }));
  if (selecting.size) grid.classList.add('selecting');
  const usage = h('p', { class: 'muted small' });
  db.usage().then((u) => { if (u) usage.textContent = `この端末で使っている容量: ${fmtBytes(u.used)}${u.quota ? `（上限の目安 ${fmtBytes(u.quota)}）` : ''}`; });
  render(app,
    h('header', { class: 'lib-head' },
      h('h1', {}, h('span', { class: 'logo', 'aria-hidden': 'true' }), 'てもとフォト'),
      h('p', { class: 'lib-lead' }, '写真を端末の外に出さずに編集。アップロードもアカウントも不要で、オフラインでも動きます。')),
    h('main', { class: 'lib-main' },
      h('label', { class: 'drop', for: 'open-file', id: 'drop' },
        h('span', { class: 'drop-icon', 'aria-hidden': 'true' }, '＋'),
        h('b', {}, '写真を開く'),
        h('span', { class: 'muted small' }, 'タップして選ぶ・ドラッグ＆ドロップ・貼り付け（複数可）')),
      fileIn,
      projects.length ? h('div', { class: 'lib-bar' }, h('h2', {}, `写真（${projects.length}）`), h('button', { type: 'button', class: 'ghost small', onclick: () => { projects.forEach((p) => selecting.add(p.id)); showLibrary(); } }, 'すべて選択')) : null,
      bar,
      projects.length ? grid : h('div', { class: 'lib-empty' },
        h('h2', {}, 'できること'),
        h('ul', { class: 'feature-list' }, [
          'RAW（DNG は RAW データから現像。CR3・NEF・ARW・RAF などはカメラが作ったプレビュー）も開ける',
          '複数の写真を1枚にまとめるグリッド（2〜9枚）',
          'フィルター22種（フィルム風・モノクロなど）と強さの調整',
          '明るさ・色・トーンカーブ・HSL・カラーグレーディング',
          '部分補正（ブラシ・グラデーション・色域・明るさの範囲）',
          '切り抜き・傾き補正・遠近補正・反転',
          'スポット修復、顔やナンバーを隠すモザイク・ぼかし',
          '文字入れ（縦書きも）・スタンプ・手描き・フレーム',
          '編集はいつでもやり直せる（元の写真はそのまま）',
          '書き出すと位置情報などのメタデータは消える',
        ].map((t) => h('li', {}, t)))),
      h('section', { class: 'privacy' },
        h('h2', {}, '写真はこの端末から出ません'),
        h('p', {}, 'このページは外部への通信を一切しない設定（CSP: connect-src \'none\'）で動いています。写真と編集内容はこの端末のブラウザの中（IndexedDB）だけに保存されます。'),
        usage)));
  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); importFiles(e.dataTransfer.files); });
}

function confirmBox(msg, okLabel, onOk) {
  const dlg = h('dialog', { class: 'dlg' }, h('p', {}, msg), h('div', { class: 'dlg-actions' },
    h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'やめる'),
    h('button', { type: 'button', class: 'danger-fill', onclick: () => { dlg.close(); onOk(); } }, okLabel)));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

// ───────────────────────── 編集画面 ─────────────────────────
function closeEditor() {
  if (!E) return;
  flushSave();
  cancelAnimationFrame(E.raf);
  E.engine?.dispose(); E.thumbEngine?.dispose();
  E.base?.close?.();
  document.removeEventListener('pointerdown', E.closeMenu);
  removeEventListener('keydown', onKey); removeEventListener('keyup', onKeyUp); removeEventListener('resize', requestRender);
  E = null;
}

async function openEditor(id) {
  closeEditor();
  const proj = await db.getProject(id); const blob = await db.getBlob(id);
  if (!proj || !blob) { toast('写真が見つかりませんでした'); showLibrary(); return; }
  const glCanvas = document.createElement('canvas');
  let engine;
  try { engine = new Engine(glCanvas); } catch {
    render(app, h('div', { class: 'fatal' }, h('h1', {}, 'この端末・ブラウザでは編集できません'), h('p', {}, 'WebGL2 に対応したブラウザ（最新の Chrome・Safari・Edge・Firefox）でお試しください。'), h('button', { type: 'button', onclick: showLibrary }, '写真一覧に戻る')));
    return;
  }
  render(app, h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), proj.raw ? 'RAW を現像しています…' : '写真を開いています…'));
  let p;
  try { p = await prepare(proj, blob, engine.maxSize); } catch { engine.dispose(); toast('写真を開けませんでした'); showLibrary(); return; }
  const state = S.validateState(proj.state);
  E = {
    id, proj, engine, glCanvas, state, committed: S.clone(state), undo: [], redo: [], tool: prefs.get('tool', 'looks'),
    base: p.base, W: p.W, H: p.H, scaled: p.scaled, src: null, srcData: null, maskCache: new Map(), skinCache: {},
    sel: null, selOverlay: null, showOriginal: false, showMask: false, zoom: 1, pan: [0, 0], raf: 0, L: null, hist: null,
  };
  buildEditor();
  rebuildSource(); rebuildMask();
  addEventListener('keydown', onKey); addEventListener('keyup', onKeyUp); addEventListener('resize', requestRender);
  requestRender();
  if (p.scaled) toast(`写真が大きいので、この端末で扱える ${p.W}×${p.H}（約${Math.round(p.W * p.H / 10000)}万画素）で編集します。2L判・A4 のプリントにも十分な大きさです`, 5000);
}

const sourceKey = (st) => JSON.stringify([st.retouch, st.portrait]);
function rebuildSource() {
  const ops = E.state.retouch;
  if (!ops.length && !portraitActive(E.state.portrait)) { E.src = null; E.srcData = null; E.engine.setSource(E.base, E.W, E.H); }
  else { const r = retouchCanvas(E.base, ops, E.state.portrait, E.skinCache); E.src = r.canvas; E.srcData = r.data; E.engine.setSource(E.src, E.W, E.H); }
  E.retouchKey = sourceKey(E.state);
  if (E.showSkin && E.tool === 'skin') E.engine.setSource(skinOverlaySource(), E.W, E.H);
  E.small = null; E.thumbsKey = null;
}
/** 修復を1つ足す（全部やり直さず、その場所だけ書き換える） */
function addRetouch(op) {
  if (E.state.retouch.length >= S.MAX_RETOUCH) { toast('修復・モザイクは300個までです'); return; }
  E.state.retouch.push(op);
  if (!E.src) { const r = retouchCanvas(E.base, [], null); E.src = r.canvas; }
  const ctx = E.src.getContext('2d', { willReadFrequently: true });
  if (!E.srcData) E.srcData = ctx.getImageData(0, 0, E.W, E.H);
  applyRetouch(E.srcData, [op]);
  ctx.putImageData(E.srcData, 0, 0);
  E.engine.setSource(E.src, E.W, E.H);
  E.retouchKey = sourceKey(E.state);
  E.small = null;
}
function maskKey() { return JSON.stringify(E.state.locals.filter((l) => l.type === 'brush').map((l) => [l.id, l.strokes])); }
function rebuildMask() { E.mask = buildMask(E.state, E.W, E.H, E.maskCache); E.engine.setMask(E.mask); E.maskKey = maskKey(); }

/** 小さな元画像（自動補正・フィルターの見本・色の取得用） */
function smallSource() {
  if (!E.small) {
    const s = Math.min(1, 320 / Math.max(E.W, E.H));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(E.W * s)); c.height = Math.max(1, Math.round(E.H * s));
    c.getContext('2d', { willReadFrequently: true }).drawImage(E.src || E.base, 0, 0, c.width, c.height);
    E.small = c;
  }
  return E.small;
}
function sampleSource(s, t, rad = 2) {
  const c = smallSource(); const ctx = c.getContext('2d', { willReadFrequently: true });
  const x = Math.round(s * (c.width - 1)); const y = Math.round(t * (c.height - 1));
  const d = ctx.getImageData(Math.max(0, x - rad), Math.max(0, y - rad), rad * 2 + 1, rad * 2 + 1).data;
  let r = 0; let g = 0; let b = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return [r / n / 255, g / n / 255, b / n / 255];
}

// ── 履歴（元に戻す・やり直す）と保存 ──
function commit() {
  if (!E || S.sameState(E.state, E.committed)) return;
  E.undo.push(E.committed); if (E.undo.length > 100) E.undo.shift();
  E.committed = S.clone(E.state); E.redo = [];
  syncHistoryButtons(); scheduleSave();
}
function undo() { if (!E?.undo.length) return; commit(); E.redo.push(E.committed); E.committed = E.undo.pop(); replaceState(); }
function redo() { if (!E?.redo.length) return; E.undo.push(E.committed); E.committed = E.redo.pop(); replaceState(); }
function replaceState() {
  E.state = S.clone(E.committed);
  if (sourceKey(E.state) !== E.retouchKey) rebuildSource();
  if (maskKey() !== E.maskKey) { E.maskCache.clear(); rebuildMask(); }
  if (E.sel && !E.state.locals.some((l) => l.id === E.sel)) E.sel = null;
  if (E.selOverlay && !E.state.overlays.some((o) => o.id === E.selOverlay)) E.selOverlay = null;
  syncHistoryButtons(); buildPanel(); requestRender(); scheduleSave();
}
let saveTimer = 0; let thumbTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 400);
  clearTimeout(thumbTimer); thumbTimer = setTimeout(saveThumb, 2500);
}
function flushSave() {
  if (!E || !saveTimer) return;
  clearTimeout(saveTimer); saveTimer = 0;
  E.proj = { ...E.proj, state: S.clone(E.committed), updated: Date.now() };
  db.putProject(E.proj).catch(() => toast('保存できませんでした（容量不足の可能性があります）'));
}
async function saveThumb() {
  if (!E) return;
  const t = await thumbBlob(E.view);
  if (!E || !t) return;
  E.proj = { ...E.proj, thumb: t, state: S.clone(E.committed), updated: Date.now() };
  db.putProject(E.proj).catch(() => {});
}

// ── 描画 ──
function previewState() {
  const st = E.state;
  if (E.tool === 'crop') return { ...st, geo: { ...st.geo, crop: { x: 0, y: 0, w: 1, h: 1 } }, frame: S.defaultState().frame, overlays: [] };
  return st;
}
/** 拡大・移動の見た目だけを変える（写真の描き直しはしない） */
function applyZoom() { E.wrap.style.transform = `translate(${E.pan[0]}px, ${E.pan[1]}px) scale(${E.zoom})`; }
function requestRender() { if (!E || E.raf) return; E.raf = requestAnimationFrame(() => { E.raf = 0; renderNow(); }); }
/** 指で操作している間は、プレビューを小さく描いて軽くする（離したら元の細かさで描き直す） */
let interactTimer = 0;
function interacting() {
  if (!E) return;
  E.fast = true;
  clearTimeout(interactTimer);
  interactTimer = setTimeout(() => { if (E) { E.fast = false; requestRender(); } }, 220);
}
function renderNow() {
  if (!E) return;
  const orig = E.showOriginal;
  const st = orig ? { ...S.defaultState(), geo: S.defaultState().geo } : previewState();
  const out = outputSize(st.geo, E.W, E.H);
  const stage = E.stageEl.getBoundingClientRect();
  const dpr = Math.min(3, devicePixelRatio || 1);
  // 枠・余白を含めた大きさで画面に収める
  const f = st.frame; const m = Math.min(out.w, out.h); const b = (f.width / 100) * m * 2;
  let cw = out.w + b; let ch = out.h + b;
  if (f.pad !== 'none') { const [a, c] = f.pad.split(':').map(Number); if (cw / ch > a / c) ch = cw / (a / c); else cw = ch * (a / c); }
  const fit0 = Math.min((stage.width - 24) * dpr / cw, (stage.height - 24) * dpr / ch, PREVIEW_MAX / Math.max(cw, ch), 1);
  // 拡大中は、拡大したぶん細かく描く（引き伸ばすとぼやけるので）。元写真の画素数と GPU の上限まで
  const zk = Math.max(1, Math.min(E.zoom, 1 / fit0, Math.min(ZOOM_MAX, E.engine.maxSize) / (Math.max(cw, ch) * fit0)));
  const k = zk * (E.fast ? 0.5 : 1); // 画面上の大きさは変えず、描く細かさだけを変える
  const fit = fit0 * k;
  const pw = Math.max(1, Math.round(out.w * fit)); const ph = Math.max(1, Math.round(out.h * fit));
  const eff = effective(st);
  const showMask = E.tool === 'local' && E.showMask && E.sel ? st.locals.findIndex((l) => l.id === E.sel) : -1;
  if (E.maskDirty) { E.mask = buildMask(E.state, E.W, E.H, E.maskCache); E.engine.setMask(E.mask); E.maskDirty = false; }
  E.engine.render(eff, pw, ph, { bypass: orig, showMask });
  E.L = compose(E.view, E.glCanvas, st, {});
  E.view.style.width = `${E.view.width / dpr / k}px`; E.view.style.height = `${E.view.height / dpr / k}px`;
  applyZoom();
  E.origBadge.hidden = !orig;
  drawHandles();
  scheduleHistogram();
}
let histTimer = 0;
function scheduleHistogram() {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    if (!E) return;
    E.hist = histogram(E.engine.readSmall().data);
    for (const c of document.querySelectorAll('canvas.histo')) drawHistogram(c, E.hist);
    for (const c of document.querySelectorAll('canvas.curve-bg')) drawHistogram(c, E.hist, c.dataset.ch);
  }, 150);
}
function drawHistogram(c, hist, only) {
  const ctx = c.getContext('2d'); const w = c.width; const hh = c.height;
  ctx.clearRect(0, 0, w, hh);
  const max = Math.max(1, ...['r', 'g', 'b'].flatMap((k) => hist[k].slice(2, 254)));
  ctx.globalCompositeOperation = 'lighter';
  for (const [k, col] of only ? [[only, 'rgba(200,200,200,.5)']] : [['r', 'rgba(255,80,80,.55)'], ['g', 'rgba(80,220,120,.5)'], ['b', 'rgba(90,140,255,.6)']]) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, hh);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, hh - Math.min(1, hist[k][i] / max) * hh);
    ctx.lineTo(w, hh); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ── 編集画面の組み立て ──
function buildEditor() {
  document.title = `${E.proj.name} — てもとフォト`;
  E.view = h('canvas', { class: 'view', role: 'img', 'aria-label': `編集中の写真: ${E.proj.name}` });
  E.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); E.svg.classList.add('handles');
  E.wrap = h('div', { class: 'view-wrap' }, E.view, E.svg);
  E.origBadge = h('div', { class: 'orig-badge', hidden: true }, '編集前');
  E.stageEl = h('div', { class: 'stage', tabindex: '-1' }, E.wrap, E.origBadge);
  setupPointer(E.stageEl);
  E.undoBtn = h('button', { type: 'button', class: 'icon', 'aria-label': '元に戻す（Ctrl+Z）', title: '元に戻す（Ctrl+Z）', onclick: undo }, '↶');
  E.redoBtn = h('button', { type: 'button', class: 'icon', 'aria-label': 'やり直す（Ctrl+Shift+Z）', title: 'やり直す（Ctrl+Shift+Z）', onclick: redo }, '↷');
  const cmp = h('button', { type: 'button', class: 'icon', 'aria-label': '押している間、編集前を表示（\\ キー）', title: '押している間、編集前を表示（\\ キー）' }, '◧');
  const setOrig = (v) => { if (!E || E.showOriginal === v) return; E.showOriginal = v; cmp.setAttribute('aria-pressed', String(v)); requestRender(); };
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); setOrig(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => setOrig(false));
  cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setOrig(true); } });
  cmp.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setOrig(false); });
  E.setOrig = setOrig;
  const menu = h('details', { class: 'menu' }, h('summary', { 'aria-label': 'そのほかの操作', title: 'そのほかの操作' }, '⋯'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', onclick: (e) => { prefs.set('clip', S.presetPart(E.state)); toast('編集をコピーしました（写真一覧で別の写真に貼り付けられます）'); } }, '編集をコピー'),
      h('button', { type: 'button', onclick: (e) => { const c = prefs.get('clip', null); if (!c) { toast('コピーした編集がありません'); return; } E.state = S.applyPreset(E.state, c); commit(); buildPanel(); requestRender(); } }, '編集を貼り付け'),
      h('button', { type: 'button', onclick: async () => { const blob = await db.getBlob(E.id); const id = uid(); await db.addProject({ ...E.proj, id, name: `${E.proj.name}（コピー）`, created: Date.now(), updated: Date.now(), state: S.clone(E.committed) }, blob); toast('複製しました'); openEditor(id); } }, '複製して別の編集を作る'),
      h('button', { type: 'button', class: 'danger', onclick: () => confirmBox('すべての編集を消して、元の写真に戻します。', 'リセット', () => { E.state = S.defaultState(); E.sel = null; E.selOverlay = null; rebuildSource(); E.maskCache.clear(); rebuildMask(); commit(); buildPanel(); requestRender(); }) }, 'すべての編集をリセット')));
  // 項目を選んだら・外側を押したらメニューを閉じる
  menu.addEventListener('click', (e) => { if (e.target.closest('.menu-list button')) menu.open = false; });
  E.closeMenu = (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; };
  document.addEventListener('pointerdown', E.closeMenu);
  E.panel = h('div', { class: 'panel', role: 'tabpanel', id: 'panel' });
  E.tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'ツール' }, TOOLS.map(([k, icon, label]) => h('button', {
    type: 'button', role: 'tab', id: `tab-${k}`, 'aria-controls': 'panel', 'aria-selected': String(E.tool === k), tabindex: E.tool === k ? '0' : '-1',
    onclick: () => setTool(k), onkeydown: tabKeys,
  }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label))));
  render(app, h('div', { class: 'editor' },
    h('header', { class: 'ed-head' },
      h('button', { type: 'button', class: 'back', onclick: showLibrary }, '‹ 写真'),
      h('span', { class: 'ed-title' }, E.proj.name),
      h('div', { class: 'ed-tools' }, E.undoBtn, E.redoBtn, cmp, menu,
        h('button', { type: 'button', class: 'primary', onclick: () => openExport({}) }, '書き出し'))),
    E.stageEl,
    h('div', { class: 'dock' }, E.panel, E.tabs)));
  syncHistoryButtons(); buildPanel();
  E.tabs.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
}
function tabKeys(e) {
  const tabs = [...E.tabs.children]; const i = tabs.indexOf(e.currentTarget);
  const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
  if (j == null) return;
  e.preventDefault(); const t = tabs[(j + tabs.length) % tabs.length]; t.focus(); t.click();
}
function syncHistoryButtons() { if (!E) return; E.undoBtn.disabled = !E.undo.length && S.sameState(E.state, E.committed); E.redoBtn.disabled = !E.redo.length; }
function setTool(k) {
  if (E.tool === 'crop' && k !== 'crop') commit();
  if (E.tool === 'skin' && k !== 'skin' && E.showSkin) { E.showSkin = false; rebuildSource(); }
  E.tool = k; prefs.set('tool', k);
  for (const b of E.tabs.children) { const on = b.id === `tab-${k}`; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  E.wbPick = false; E.colorPick = false;
  buildPanel(); requestRender();
}

// ───────────────────────── 道具ごとのパネル ─────────────────────────
function live(fn) { return (v) => { fn(v); interacting(); syncHistoryButtons(); requestRender(); }; }
function adjSliders(group) {
  return S.ADJ.filter((a) => a[4] === group).map(([k, label, min, max]) => slider({
    label, min, max, value: E.state.adj[k], def: S.ADJ_DEFAULT[k] ?? 0,
    onInput: live((v) => { E.state.adj[k] = v; }), onChange: commit,
  }).el);
}
const histo = () => { const c = h('canvas', { class: 'histo', width: 256, height: 64, role: 'img', 'aria-label': 'ヒストグラム（明るさの分布）' }); if (E.hist) drawHistogram(c, E.hist); return c; };
const hint = (t) => h('p', { class: 'hint' }, t);
const row = (...k) => h('div', { class: 'btn-row' }, ...k);
const btn = (label, onclick, cls = '') => h('button', { type: 'button', class: cls, onclick }, label);

const PANELS = {
  auto() {
    return [
      histo(),
      row(btn('✦ 自動補正', () => {
        const c = smallSource(); const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
        Object.assign(E.state.adj, autoAdjust(histogram(d))); commit(); requestRender(); toast('自動補正しました（各スライダーで調整できます）');
      }, 'primary big'), btn('明るさ・色をリセット', () => { const d = S.defaultState(); Object.assign(E.state, { adj: d.adj, hsl: d.hsl, grade: d.grade, curves: d.curves, look: d.look }); commit(); requestRender(); })),
      hint('写真の明るさの分布から、露光・白黒レベル・ホワイトバランスを整えます。気に入らなければ「元に戻す」で戻せます。'),
    ];
  },
  looks() {
    const grid = h('div', { class: 'looks', role: 'group', 'aria-label': 'フィルター' });
    const amt = slider({ label: '強さ', min: 0, max: 100, value: E.state.look.amount, def: 100, unit: '%', onInput: live((v) => { E.state.look.amount = v; }), onChange: commit });
    const pick = (id) => { E.state.look = { id, amount: E.state.look.id === id ? E.state.look.amount : 100 }; amt.set(E.state.look.amount); commit(); requestRender(); for (const b of grid.children) b.setAttribute('aria-pressed', String(b.dataset.id === id)); };
    for (const l of LOOKS) {
      const c = h('canvas', { class: 'look-thumb', width: 96, height: 96 });
      grid.append(h('button', { type: 'button', class: 'look', dataset: { id: l.id }, 'aria-pressed': String(E.state.look.id === l.id), onclick: () => pick(l.id) }, c, h('span', {}, l.name)));
    }
    requestAnimationFrame(() => drawLookThumbs(grid));
    const presets = h('div', { class: 'presets' });
    const drawPresets = () => {
      const list = prefs.get('presets', []);
      render(presets, h('div', { class: 'sub-head' }, h('b', {}, 'マイプリセット'), h('span', { class: 'muted small' }, '今の明るさ・色の調整を保存して、ほかの写真にも使えます')),
        list.length ? h('div', { class: 'chips' }, list.map((p) => h('span', { class: 'preset' },
          h('button', { type: 'button', onclick: () => { E.state = S.applyPreset(E.state, p.p); commit(); buildPanel(); requestRender(); } }, p.name),
          h('button', { type: 'button', class: 'x', 'aria-label': `${p.name}を削除`, onclick: () => { prefs.set('presets', list.filter((q) => q.id !== p.id)); drawPresets(); } }, '×')))) : null,
        presetSaveRow(drawPresets));
    };
    drawPresets();
    return [grid, amt.el, presets];
  },
  light() { return [histo(), ...adjSliders('light')]; },
  color() {
    const pickBtn = btn(E.wbPick ? '写真の白・グレーの場所をタップ…' : '⊙ スポイトで白を合わせる', () => { E.wbPick = !E.wbPick; buildPanel(); }, E.wbPick ? 'active' : '');
    return [row(pickBtn), ...adjSliders('color'), hint('スポイト: 本来は白やグレーの場所（壁・紙・雲など）をタップすると、色かぶりを自動で直します。')];
  },
  hsl() {
    const band = E.hslBand || 'red';
    const sl = (c, label) => slider({ label, value: E.state.hsl[band][c], onInput: live((v) => { E.state.hsl[band][c] = v; }), onChange: commit }).el;
    return [
      chips(S.HSL_BANDS.map(([k, label, deg]) => [k, h('span', { class: 'dot', style: { background: `hsl(${deg} 85% 55%)` }, 'aria-hidden': 'true' }), { title: label }]).map(([k, dot, x], i) => [k, [dot, h('span', { class: 'vh' }, S.HSL_BANDS[i][1])], x]), band, (k) => { E.hslBand = k; buildPanel(); }, { label: '色を選ぶ', cls: 'bands' }).el,
      h('p', { class: 'sub-head' }, h('b', {}, S.HSL_BANDS.find((b) => b[0] === band)[1])),
      sl('h', '色相'), sl('s', '彩度'), sl('l', '輝度'),
      row(btn('HSL をすべてリセット', () => { E.state.hsl = S.defaultState().hsl; commit(); buildPanel(); requestRender(); }, 'ghost small')),
    ];
  },
  curves() { return curveEditor(); },
  grade() {
    const zone = (k, label) => {
      const g = E.state.grade[k];
      return h('div', { class: 'grade-zone' }, h('b', {}, label),
        slider({ label: '色相', min: 0, max: 360, value: g.h, def: g.h, unit: '°', track: 'hue', onInput: live((v) => { E.state.grade[k].h = v; }), onChange: commit }).el,
        slider({ label: '強さ', min: 0, max: 100, value: g.s, def: 0, onInput: live((v) => { E.state.grade[k].s = v; }), onChange: commit }).el);
    };
    return [zone('shadows', 'シャドウ'), zone('mids', '中間調'), zone('highs', 'ハイライト'),
      slider({ label: 'バランス', value: E.state.grade.balance, onInput: live((v) => { E.state.grade.balance = v; }), onChange: commit }).el];
  },
  detail() { return adjSliders('detail'); },
  effects() { return adjSliders('effect'); },
  crop() { return cropPanel(); },
  local() { return localPanel(); },
  skin() { return skinPanel(); },
  heal() {
    const size = prefs.get('healSize', 3);
    return [hint('消したいもの（ほこり・ニキビ・電線など）をタップするか、なぞってください。まわりの似た場所で自然に埋めます。'),
      slider({ label: 'ブラシの大きさ', min: 1, max: 12, value: size, def: 3, onChange: (v) => prefs.set('healSize', v) }).el,
      h('p', { class: 'muted small' }, `修復・モザイク: ${E.state.retouch.length}か所`),
      row(btn('修復とモザイクをすべて消す', () => { E.state.retouch = []; rebuildSource(); commit(); buildPanel(); requestRender(); }, 'ghost small'))];
  },
  hide() {
    const mode = prefs.get('hideMode', 'mosaic');
    return [hint('隠したい場所（顔・ナンバープレート・住所・名札など）を指でなぞって四角く囲んでください。SNSに載せる前のプライバシー対策に。'),
      chips([['mosaic', 'モザイク'], ['blur', 'ぼかし']], mode, (v) => prefs.set('hideMode', v), { label: '隠し方' }).el,
      slider({ label: '強さ', min: 4, max: 60, value: prefs.get('hideSize', 20), def: 20, onChange: (v) => prefs.set('hideSize', v) }).el,
      h('p', { class: 'muted small' }, `修復・モザイク: ${E.state.retouch.length}か所`)];
  },
  text() { return overlayPanel('text'); },
  sticker() { return overlayPanel('sticker'); },
  draw() {
    const d = prefs.get('draw', { color: '#ff3b30', width: 1, mode: 'pen' });
    const save = () => prefs.set('draw', d);
    return [hint('写真の上を指でなぞって描きます。消すときは「元に戻す」。'),
      chips([['pen', 'ペン'], ['marker', 'マーカー'], ['neon', 'ネオン']], d.mode, (v) => { d.mode = v; save(); }, { label: '描き方' }).el,
      colorPicker({ label: '色', value: d.color, onPick: (v) => { d.color = v; save(); } }).el,
      slider({ label: '太さ', min: 1, max: 10, value: d.width, def: 1, onChange: (v) => { d.width = v; save(); } }).el];
  },
  frame() {
    const f = E.state.frame;
    return [
      slider({ label: '枠の太さ', min: 0, max: 30, value: f.width, def: 0, onInput: live((v) => { f.width = v; }), onChange: commit }).el,
      colorPicker({ label: '枠の色', value: f.color, onPick: (v) => { f.color = v; commit(); requestRender(); } }).el,
      slider({ label: '角の丸み', min: 0, max: 50, value: f.radius, def: 0, onInput: live((v) => { f.radius = v; }), onChange: commit }).el,
      h('div', { class: 'sub-head' }, h('b', {}, '余白をつけて比率を合わせる'), h('span', { class: 'muted small' }, '切り抜かずにSNSの比率にできます')),
      chips(Object.entries(S.PADS), f.pad, (v) => { f.pad = v; commit(); requestRender(); }, { label: '余白の比率' }).el,
      chips([['blur', 'ぼかした写真'], ['color', '単色']], f.padFill, (v) => { f.padFill = v; commit(); requestRender(); }, { label: '余白の塗り方' }).el,
      colorPicker({ label: '余白の色', value: f.padColor, onPick: (v) => { f.padColor = v; commit(); requestRender(); } }).el,
    ];
  },
  info() { return infoPanel(); },
};

function buildPanel() {
  if (!E) return;
  E.panel.setAttribute('aria-labelledby', `tab-${E.tool}`);
  const top = E.panel.scrollTop;
  render(E.panel, h('div', { class: `panel-inner panel-${E.tool}` }, PANELS[E.tool]()));
  E.panel.scrollTop = top;
  E.stageEl.dataset.tool = E.tool;
}

function presetSaveRow(after) {
  const name = h('input', { id: 'preset-name', maxlength: 30, placeholder: 'プリセットの名前' });
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'vh', id: 'preset-file' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0]; file.value = '';
    if (!f || f.size > 200_000) { toast('読み込めませんでした'); return; }
    try {
      const j = JSON.parse(await f.text());
      if (j?.app !== 'temoto-photo' || !j.preset) throw new Error('format');
      const list = prefs.get('presets', []);
      list.push({ id: uid(), name: String(j.name || '読み込んだプリセット').slice(0, 30), p: S.presetPart(S.applyPreset(S.defaultState(), j.preset)) });
      prefs.set('presets', list.slice(-50)); after(); toast('プリセットを読み込みました');
    } catch { toast('てもとフォトのプリセットではありません'); }
  });
  return h('div', { class: 'preset-save' },
    h('label', { for: 'preset-name', class: 'vh' }, 'プリセットの名前'), name,
    btn('保存', () => {
      const list = prefs.get('presets', []);
      list.push({ id: uid(), name: name.value.trim().slice(0, 30) || `プリセット${list.length + 1}`, p: S.presetPart(E.state) });
      prefs.set('presets', list.slice(-50)); after(); toast('保存しました');
    }, 'small'),
    btn('ファイルに書き出す', () => download(new Blob([JSON.stringify({ app: 'temoto-photo', v: 1, name: name.value.trim() || 'preset', preset: S.presetPart(E.state) }, null, 1)], { type: 'application/json' }), `${(name.value.trim() || 'preset').replace(/[\\/:*?"<>|]/g, '_')}.json`), 'small ghost'),
    h('label', { for: 'preset-file', class: 'btn small ghost' }, '読み込む'), file);
}

function drawLookThumbs(grid) {
  if (!E) return;
  const key = `${E.retouchKey}|${JSON.stringify(E.state.adj)}|${E.state.geo.rot}${E.state.geo.flipH}${E.state.geo.flipV}`;
  if (!E.thumbEngine) { try { E.thumbEngine = new Engine(document.createElement('canvas')); } catch { return; } }
  if (E.thumbsKey !== key) { const s = smallSource(); E.thumbEngine.setSource(s, s.width, s.height); }
  const base = { ...S.clone(E.state), locals: [], geo: { ...S.defaultState().geo, rot: E.state.geo.rot, flipH: E.state.geo.flipH, flipV: E.state.geo.flipV } };
  const o = outputSize(base.geo, E.W, E.H); const sc = 96 / Math.min(o.w, o.h);
  const tw = Math.round(o.w * sc); const th = Math.round(o.h * sc);
  for (const b of grid.children) {
    const c = b.querySelector('canvas');
    E.thumbEngine.render(effective({ ...base, look: { id: b.dataset.id, amount: 100 } }), tw, th);
    c.getContext('2d').drawImage(E.thumbEngine.canvas, (tw - 96) / 2, (th - 96) / 2, 96, 96, 0, 0, 96, 96);
  }
  E.thumbsKey = key;
}

// ── トーンカーブ ──
function curveEditor() {
  const ch = E.curveCh || 'rgb';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-0.03 -0.03 1.06 1.06'); svg.classList.add('curve'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'トーンカーブ（点をドラッグして調整、タップで点を追加、上下の外に出すと削除）');
  const bg = h('canvas', { class: 'curve-bg', width: 256, height: 256, 'aria-hidden': 'true', dataset: { ch: ch === 'rgb' ? 'l' : ch } });
  const color = { rgb: '#e8e8e8', r: '#ff6b6b', g: '#5fd47e', b: '#6aa2ff' }[ch];
  const draw = () => {
    const pts = E.state.curves[ch]; const f = monotoneSpline(pts);
    svg.replaceChildren();
    const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
    for (let i = 1; i < 4; i++) { el('line', { x1: i / 4, y1: 0, x2: i / 4, y2: 1, class: 'grid' }); el('line', { x1: 0, y1: i / 4, x2: 1, y2: i / 4, class: 'grid' }); }
    el('line', { x1: 0, y1: 1, x2: 1, y2: 0, class: 'diag' });
    el('polyline', { points: Array.from({ length: 65 }, (_, i) => `${i / 64},${1 - Math.min(1, Math.max(0, f(i / 64)))}`).join(' '), class: 'line', stroke: color });
    pts.forEach(([x, y]) => el('circle', { cx: x, cy: 1 - y, r: 0.028, class: 'pt' }));
  };
  let drag = -1;
  const pos = (e) => { const r = svg.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 1.06 - 0.03, 1 - (((e.clientY - r.top) / r.height) * 1.06 - 0.03)]; };
  svg.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e); const pts = E.state.curves[ch];
    drag = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.06);
    if (drag < 0 && pts.length < 16) { pts.push([Math.min(0.99, Math.max(0.01, x)), Math.min(1, Math.max(0, y))]); pts.sort((a, b) => a[0] - b[0]); drag = pts.findIndex((p) => p[0] === Math.min(0.99, Math.max(0.01, x))); }
    svg.setPointerCapture(e.pointerId); draw(); requestRender();
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const pts = E.state.curves[ch]; let [x, y] = pos(e);
    const last = pts.length - 1;
    if (drag > 0 && drag < last && (y < -0.15 || y > 1.15)) { pts.splice(drag, 1); drag = -1; draw(); requestRender(); return; }
    y = Math.min(1, Math.max(0, y));
    if (drag === 0) x = Math.min(pts[1][0] - 0.02, Math.max(0, x));
    else if (drag === last) x = Math.max(pts[last - 1][0] + 0.02, Math.min(1, x));
    else x = Math.min(pts[drag + 1][0] - 0.02, Math.max(pts[drag - 1][0] + 0.02, x));
    pts[drag] = [x, y]; draw(); requestRender();
  });
  const end = () => { if (drag !== -2) { drag = -1; commit(); } };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  draw();
  requestAnimationFrame(() => { if (E?.hist) drawHistogram(bg, E.hist, ch === 'rgb' ? 'l' : ch); });
  const presets = [['リセット', [[0, 0], [1, 1]]], ['コントラスト', [[0, 0], [0.25, 0.18], [0.75, 0.82], [1, 1]]], ['フィルム（黒を浮かせる）', [[0, 0.08], [0.3, 0.28], [0.75, 0.78], [1, 0.96]]], ['明るく', [[0, 0], [0.45, 0.58], [1, 1]]]];
  return [
    chips([['rgb', 'RGB'], ['r', 'レッド'], ['g', 'グリーン'], ['b', 'ブルー']], ch, (k) => { E.curveCh = k; buildPanel(); }, { label: 'チャンネル' }).el,
    h('div', { class: 'curve-box' }, bg, svg),
    row(...presets.map(([n, p]) => btn(n, () => { E.state.curves[ch] = S.clone(p); commit(); buildPanel(); requestRender(); }, 'small ghost'))),
  ];
}

// ── 美肌（写真館の仕上げ） ──
const SKIN_LEVELS = [['off', 'なし', { smooth: 0, even: 0, bright: 0 }], ['light', 'ひかえめ', { smooth: 30, even: 25, bright: 10 }], ['natural', 'ナチュラル', { smooth: 50, even: 40, bright: 18 }], ['strong', 'しっかり', { smooth: 75, even: 55, bright: 28 }]];
/** 美肌は画素を全部計算し直すので、指を離したときだけ、画面に「仕上げ中」を出してから計算する */
function applySkin(next, after) {
  E.state.portrait = { ...E.state.portrait, ...next };
  E.stageEl.classList.add('busy');
  requestAnimationFrame(() => setTimeout(() => {
    if (!E) return;
    try { rebuildSource(); } finally { E.stageEl.classList.remove('busy'); }
    commit(); requestRender(); after?.();
  }, 0));
}
/** 肌の範囲の表示を切り替える（表示中は、肌と判定した場所を赤く重ねた画像を GPU に送る。保存はしない） */
function setShowSkin(on) {
  if (!!E.showSkin === on) return;
  E.showSkin = on; E.stageEl.classList.add('busy');
  requestAnimationFrame(() => setTimeout(() => { if (!E) return; try { rebuildSource(); } finally { E.stageEl.classList.remove('busy'); } requestRender(); }, 0));
}
function skinOverlaySource() {
  if (!E.baseData) E.baseData = toCanvas(E.base, E.W, E.H).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, E.W, E.H);
  const c = toCanvas(E.src || E.base, E.W, E.H); const ctx = c.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, E.W, E.H); tintSkin(d, E.baseData, E.state.portrait); ctx.putImageData(d, 0, 0);
  return c;
}
function skinPanel() {
  const p = E.state.portrait;
  const level = SKIN_LEVELS.find(([, , v]) => v.smooth === p.smooth && v.even === p.even && v.bright === p.bright)?.[0] ?? null;
  const n = p.seeds.length;
  return [
    hint(n ? 'タップした肌の色に近く、そこからつながっている場所だけを整えます。首・手など離れた肌は、そこもタップすると追加できます。'
      : '① まず顔の肌（ほお）をタップしてください。タップした肌の色を覚えて、肌に似た色の背景（壁・木・布）は変えないようにします。② 強さを選びます。'),
    h('div', { class: 'btn-row' },
      h('span', { class: n ? 'ok-note small' : 'muted small' }, n ? `✓ 肌として選んだ場所: ${n}か所` : '肌の場所: 未選択（自動で判定。背景も変わることがあります）'),
      n ? btn('選び直す', () => applySkin({ seeds: [] }, buildPanel), 'ghost small') : null),
    toggle('肌と判定した範囲を赤で表示', !!E.showSkin, (v) => setShowSkin(v)).el,
    chips(SKIN_LEVELS.map(([k, label]) => [k, label]), level, (k) => applySkin(SKIN_LEVELS.find((x) => x[0] === k)[2], buildPanel), { label: '美肌の強さ' }).el,
    ...PORTRAIT.map(([k, label]) => slider({ label, min: 0, max: 100, value: p[k], def: 0, onChange: (v) => applySkin({ [k]: v }, buildPanel) }).el),
    n ? slider({ label: '肌とみなす色の幅', min: 0, max: 100, value: p.tol, def: 50, onChange: (v) => applySkin({ tol: v }, buildPanel) }).el : null,
    n ? hint('背景や服まで赤くなるときは「色の幅」を下げ、肌の一部が赤くならないときは上げるか、その場所もタップしてください。') : null,
    row(btn('✦ 写真館風におまかせ仕上げ', () => {
      // 明るさ・色の自動補正 → 美肌（ナチュラル）→ フィルター「透明感」を少し
      const c = smallSource(); const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      Object.assign(E.state.adj, autoAdjust(histogram(d)));
      E.state.look = { id: 'studio-clear', amount: 60 };
      applySkin(SKIN_LEVELS[2][2], () => { buildPanel(); toast(E.state.portrait.seeds.length ? '仕上げました（各スライダー・フィルターで調整できます）' : '仕上げました。肌以外の色も変わっていたら、顔の肌をタップしてください', 4500); });
    }, 'primary')),
    hint('おすすめの流れ: ①顔をタップ → ②おまかせ仕上げ → ③「修復」でニキビ・後れ毛・背景のゴミを消す → ④「フィルター」の「透明感」「振袖あでやか」などで雰囲気を選ぶ → ⑤「切り抜き」の「L判」「2L判」でプリントの比率に。決まった仕上げは「フィルター」のマイプリセットに保存すると、他の写真にも一度で使えます（肌の場所は写真ごとにタップしてください）。'),
  ].filter(Boolean);
}
/** 美肌タブ: タップで肌の場所を追加（拡大中のドラッグは移動） */
function skinAction(e, o, p) {
  const start = [e.clientX, e.clientY]; const pan0 = [...E.pan]; let moved = false;
  return {
    move: (ev) => {
      if (Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) > 8) moved = true;
      if (moved && E.zoom > 1) { E.pan = [pan0[0] + ev.clientX - start[0], pan0[1] + ev.clientY - start[1]]; applyZoom(); }
    },
    end: () => {
      if (moved) return;
      const [s, t] = outToSrc(...o, p);
      if (!(s >= 0 && s <= 1 && t >= 0 && t <= 1)) return;
      const pt = E.state.portrait;
      if (pt.seeds.length >= S.MAX_SKIN_SEEDS) { toast(`肌の場所は${S.MAX_SKIN_SEEDS}か所までです`); return; }
      // 強さがまだ「なし」なら、ナチュラルで始める
      const strength = portraitActive(pt) ? {} : SKIN_LEVELS[2][2];
      applySkin({ ...strength, seeds: [...pt.seeds, [s, t]] }, buildPanel);
    },
  };
}

// ── 切り抜き ──
function cropPanel() {
  const g = E.state.geo;
  const o = orientedSize(g, E.W, E.H);
  const setAspect = (a) => { g.aspect = a; g.crop = fitCrop({ x: 0, y: 0, w: 1, h: 1 }, aspectValue(a, o.w, o.h), o.w, o.h); commit(); requestRender(); };
  const rotate = (d) => { g.rot = (g.rot + d + 4) % 4; const n = orientedSize(g, E.W, E.H); g.crop = fitCrop({ x: 0, y: 0, w: 1, h: 1 }, aspectValue(g.aspect, n.w, n.h), n.w, n.h); commit(); buildPanel(); requestRender(); };
  return [
    hint('枠の角や辺をドラッグして切り抜きます。枠の中をドラッグすると動かせます。'),
    chips(Object.entries(S.ASPECTS), g.aspect, setAspect, { label: '比率' }).el,
    row(btn('⟲ 左に回転', () => rotate(3), 'small'), btn('⟳ 右に回転', () => rotate(1), 'small'), btn('⇋ 左右反転', () => { g.flipH = !g.flipH; commit(); requestRender(); }, 'small'), btn('⇵ 上下反転', () => { g.flipV = !g.flipV; commit(); requestRender(); }, 'small')),
    slider({ label: '傾き補正', min: -45, max: 45, step: 0.1, value: g.angle, def: 0, unit: '°', onInput: live((v) => { g.angle = v; }), onChange: commit }).el,
    slider({ label: '縦の遠近補正', value: g.persV, def: 0, onInput: live((v) => { g.persV = v; }), onChange: commit }).el,
    slider({ label: '横の遠近補正', value: g.persH, def: 0, onInput: live((v) => { g.persH = v; }), onChange: commit }).el,
    row(btn('切り抜き・回転をリセット', () => { E.state.geo = S.defaultState().geo; commit(); buildPanel(); requestRender(); }, 'ghost small')),
  ];
}

// ── 部分補正 ──
function localPanel() {
  const locals = E.state.locals;
  const cur = locals.find((l) => l.id === E.sel);
  const add = (type) => {
    if (locals.length >= S.MAX_LOCALS) { toast('部分補正は8つまでです'); return; }
    if (type === 'brush' && locals.filter((l) => l.type === 'brush').length >= S.MAX_BRUSH_LOCALS) { toast('ブラシは4つまでです'); return; }
    const l = S.newLocal(type, uid());
    if (type === 'radial') { const [s, t] = outToSrc(0.5, 0.5, geoParams(E.state.geo, E.W, E.H)); l.cx = s; l.cy = t; l.rx = 0.25; l.ry = 0.25 * E.W / E.H; }
    if (type === 'linear') { const p = geoParams(E.state.geo, E.W, E.H); [l.x1, l.y1] = outToSrc(0.5, 0.15, p); [l.x2, l.y2] = outToSrc(0.5, 0.55, p); }
    l.adj.exposure = type === 'linear' ? -30 : type === 'radial' ? 20 : 0;
    locals.push(l); E.sel = l.id; E.showMask = type === 'brush' || type === 'color' || type === 'luma'; commit(); buildPanel(); requestRender();
  };
  const list = h('div', { class: 'chips locals' }, locals.map((l, i) => h('button', { type: 'button', 'aria-pressed': String(l.id === E.sel), onclick: () => { E.sel = l.id; buildPanel(); requestRender(); } }, `${i + 1}. ${S.LOCAL_TYPES[l.type]}`)));
  const adders = h('div', { class: 'chips' }, h('span', { class: 'muted small' }, '追加:'), Object.entries(S.LOCAL_TYPES).map(([k, n]) => btn(`＋ ${n}`, () => add(k), 'small')));
  if (!cur) return [hint('写真の一部だけを明るくしたり、空だけ青くしたりできます。下から種類を選んで追加してください。'), list, adders];
  const ctrl = [];
  if (cur.type === 'brush') {
    const b = prefs.get('brush', { size: 8, hard: 50, flow: 100, erase: false });
    const sv = () => prefs.set('brush', b);
    ctrl.push(hint('補正したい場所を指でなぞって塗ります。'),
      chips([[false, '塗る'], [true, '消す']], b.erase, (v) => { b.erase = v; sv(); }, { label: 'ブラシ' }).el,
      slider({ label: '大きさ', min: 1, max: 40, value: b.size, def: 8, onChange: (v) => { b.size = v; sv(); } }).el,
      slider({ label: '硬さ', min: 0, max: 100, value: b.hard, def: 50, onChange: (v) => { b.hard = v; sv(); } }).el,
      slider({ label: '流量', min: 5, max: 100, value: b.flow, def: 100, onChange: (v) => { b.flow = v; sv(); } }).el);
  } else if (cur.type === 'linear') ctrl.push(hint('2本の線の丸をドラッグ。1本目の側に効果がかかり、2本目に向かって弱まります。'));
  else if (cur.type === 'radial') {
    ctrl.push(hint('円の中心や縁の丸をドラッグします。'), slider({ label: 'ぼかし幅', min: 0, max: 100, value: cur.feather, def: 50, onInput: live((v) => { cur.feather = v; }), onChange: commit }).el);
  } else if (cur.type === 'color') {
    ctrl.push(row(btn(E.colorPick ? '写真の中の色をタップ…' : '⊙ 写真から色を選ぶ', () => { E.colorPick = !E.colorPick; buildPanel(); }, E.colorPick ? 'active' : '')),
      slider({ label: '色相', min: 0, max: 360, value: cur.hue, def: cur.hue, unit: '°', track: 'hue', onInput: live((v) => { cur.hue = v; }), onChange: commit }).el,
      slider({ label: '範囲', min: 5, max: 90, value: cur.range, def: 30, onInput: live((v) => { cur.range = v; }), onChange: commit }).el,
      slider({ label: '最低の彩度', min: 0, max: 100, value: cur.minSat, def: 15, onInput: live((v) => { cur.minSat = v; }), onChange: commit }).el);
  } else {
    ctrl.push(slider({ label: '暗い側', min: 0, max: 100, value: Math.round(cur.lo * 100), def: 0, onInput: live((v) => { cur.lo = v / 100; }), onChange: commit }).el,
      slider({ label: '明るい側', min: 0, max: 100, value: Math.round(cur.hi * 100), def: 35, onInput: live((v) => { cur.hi = v / 100; }), onChange: commit }).el,
      slider({ label: 'なめらかさ', min: 0, max: 50, value: Math.round(cur.soft * 100), def: 15, onInput: live((v) => { cur.soft = v / 100; }), onChange: commit }).el);
  }
  return [list, adders,
    h('div', { class: 'local-opts' },
      toggle('範囲を赤く表示', E.showMask, (v) => { E.showMask = v; requestRender(); }).el,
      toggle('範囲を反転', cur.invert, (v) => { cur.invert = v; commit(); requestRender(); }).el,
      btn('この補正を削除', () => { E.state.locals = locals.filter((l) => l.id !== cur.id); E.sel = null; E.maskCache.clear(); rebuildMask(); commit(); buildPanel(); requestRender(); }, 'small danger')),
    ...ctrl,
    h('div', { class: 'sub-head' }, h('b', {}, 'この範囲の調整')),
    ...S.LOCAL_ADJ.map(([k, label]) => slider({ label, min: k === 'blur' ? 0 : -100, value: cur.adj[k], def: 0, onInput: live((v) => { cur.adj[k] = v; }), onChange: commit }).el),
  ];
}

// ── 文字・スタンプ ──
function overlayPanel(kind) {
  const o = E.state.overlays.find((x) => x.id === E.selOverlay && x.type === kind);
  const addOverlay = (extra) => {
    if (E.state.overlays.length >= S.MAX_OVERLAYS) { toast('文字・スタンプ・描画は60個までです'); return; }
    const v = S.validateState({ overlays: [{ type: kind, id: uid(), x: 0.5, y: 0.5, ...extra }] }).overlays[0];
    E.state.overlays.push(v); E.selOverlay = v.id; commit(); buildPanel(); requestRender();
  };
  const top = [];
  if (kind === 'text') top.push(row(btn('＋ 文字を追加', () => addOverlay({ text: 'テキスト', size: 0.08, color: '#ffffff', shadow: true }), 'primary')));
  else top.push(h('div', { class: 'stickers', role: 'group', 'aria-label': 'スタンプを追加' }, STICKERS.map((s) => h('button', { type: 'button', 'aria-label': `${s} を追加`, onclick: () => addOverlay({ emoji: s }) }, s))));
  if (!o) return [...top, hint(kind === 'text' ? '追加した文字はドラッグで動かせます。タップで選ぶと編集できます。' : 'スタンプはドラッグで動かせます。タップで選ぶと大きさや向きを変えられます。')];
  const set = (k) => live((v) => { o[k] = v; });
  const common = [
    slider({ label: '大きさ', min: kind === 'text' ? 1 : 2, max: kind === 'text' ? 40 : 60, value: Math.round(o.size * 100), def: kind === 'text' ? 8 : 15, onInput: live((v) => { o.size = v / 100; }), onChange: commit }).el,
    slider({ label: '回転', min: -180, max: 180, value: Math.round(o.rot), def: 0, unit: '°', onInput: set('rot'), onChange: commit }).el,
    slider({ label: '不透明度', min: 5, max: 100, value: Math.round(o.opacity * 100), def: 100, unit: '%', onInput: live((v) => { o.opacity = v / 100; }), onChange: commit }).el,
    row(btn('前面へ', () => { E.state.overlays = [...E.state.overlays.filter((x) => x !== o), o]; commit(); requestRender(); }, 'small'),
      btn('複製', () => { const c = { ...S.clone(o), id: uid(), x: Math.min(1, o.x + 0.05), y: Math.min(1, o.y + 0.05) }; E.state.overlays.push(c); E.selOverlay = c.id; commit(); buildPanel(); requestRender(); }, 'small'),
      btn('削除', () => { E.state.overlays = E.state.overlays.filter((x) => x !== o); E.selOverlay = null; commit(); buildPanel(); requestRender(); }, 'small danger'),
      btn('選択をやめる', () => { E.selOverlay = null; buildPanel(); requestRender(); }, 'small ghost')),
  ];
  if (kind === 'sticker') return [...top, ...common];
  const ta = h('textarea', { id: 'ov-text', rows: 2, maxlength: 500, value: o.text });
  ta.addEventListener('input', () => { o.text = ta.value || ' '; requestRender(); });
  ta.addEventListener('change', commit);
  return [...top,
    h('div', { class: 'field' }, h('label', { for: 'ov-text' }, '文字（改行できます）'), ta),
    chips(Object.entries(S.FONTS), o.font, (v) => { o.font = v; commit(); requestRender(); }, { label: '書体' }).el,
    colorPicker({ label: '文字の色', value: o.color, onPick: (v) => { o.color = v; commit(); requestRender(); } }).el,
    h('div', { class: 'local-opts' },
      toggle('太字', o.bold, (v) => { o.bold = v; commit(); requestRender(); }).el,
      toggle('縦書き', o.vertical, (v) => { o.vertical = v; commit(); requestRender(); }).el,
      toggle('影', o.shadow, (v) => { o.shadow = v; commit(); requestRender(); }).el,
      toggle('背景', o.bg, (v) => { o.bg = v; commit(); requestRender(); }).el),
    chips([['left', '左寄せ'], ['center', '中央'], ['right', '右寄せ']], o.align, (v) => { o.align = v; commit(); requestRender(); }, { label: '揃え' }).el,
    slider({ label: '縁取り', min: 0, max: 30, value: Math.round(o.stroke * 100), def: 0, onInput: live((v) => { o.stroke = v / 100; }), onChange: commit }).el,
    colorPicker({ label: '縁取りの色', value: o.strokeColor, onPick: (v) => { o.strokeColor = v; commit(); requestRender(); } }).el,
    colorPicker({ label: '背景の色', value: o.bgColor, onPick: (v) => { o.bgColor = v; commit(); requestRender(); } }).el,
    ...common];
}

// ── 情報 ──
function infoPanel() {
  const p = E.proj; const x = p.exif;
  const name = h('input', { id: 'proj-name', maxlength: 80, value: p.name });
  name.addEventListener('change', () => { E.proj.name = name.value.trim().slice(0, 80) || '写真'; db.putProject(E.proj); $('.ed-title').textContent = E.proj.name; });
  const rows = [['元の大きさ', `${p.w}×${p.h}${E.scaled ? `（編集は ${E.W}×${E.H}）` : ''}`], ['ファイルの大きさ', fmtBytes(p.size || 0)], ['アプリの版', VERSION], ['形式', p.raw ? `RAW（${p.raw.format}）` : p.type || '不明'],
    ...(p.raw ? [['RAWの読み込み', p.raw.kind === 'raw' ? `RAW データから現像${p.raw.scaled ? '（大きいので2×2をまとめて半分の大きさに）' : ''}` : `カメラが作ったプレビュー画像（${p.raw.previewW}×${p.raw.previewH}）を使用。この形式の RAW データの現像には対応していません`]] : []),
    ['書き出す大きさ（元の大きさのとき）', (() => {
      const o = outputSize(E.state.geo, E.W, E.H); const L0 = layout(o.w, o.h, E.state.frame);
      const k = Math.min(1, Math.sqrt((MAX_PIXELS * 0.99) / (L0.cw * L0.ch))); // 丸めで上限を超えないよう少し余裕を持たせる
      return `${Math.round(L0.cw * k)}×${Math.round(L0.ch * k)}${k < 1 ? '（端末の上限に合わせて縮小）' : ''}`;
    })()]];
  if (x) {
    if (x.make || x.model) rows.push(['カメラ', `${x.make} ${x.model}`.trim()]);
    if (x.lens) rows.push(['レンズ', x.lens]);
    if (x.date) rows.push(['撮影日時', x.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1/$2/$3')]);
    const ex = [x.fNumber && `F${x.fNumber.toFixed(1)}`, x.exposureTime && (x.exposureTime < 1 ? `1/${Math.round(1 / x.exposureTime)}秒` : `${x.exposureTime}秒`), x.iso && `ISO${x.iso}`, x.focalLength && `${Math.round(x.focalLength)}mm`].filter(Boolean).join(' ・ ');
    if (ex) rows.push(['撮影設定', ex]);
  }
  return [
    h('div', { class: 'field' }, h('label', { for: 'proj-name' }, '名前'), name),
    x?.gps ? h('div', { class: 'gps-warn', role: 'note' }, h('b', {}, '📍 この写真には撮影場所（位置情報）が入っています'), h('span', {}, `緯度 ${x.gps.lat.toFixed(4)}・経度 ${x.gps.lon.toFixed(4)}。書き出した画像には入りません（安心してSNSに載せられます）。元の写真ファイルにはそのまま残っています。`))
      : h('p', { class: 'ok-note' }, '✓ 書き出した画像には、位置情報・カメラ情報などのメタデータは入りません。'),
    h('dl', { class: 'info' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    histo(),
    h('details', { class: 'keys' }, h('summary', {}, 'キーボードショートカット'), h('ul', {}, [['Ctrl/⌘ + Z', '元に戻す'], ['Ctrl/⌘ + Shift + Z / Ctrl + Y', 'やり直す'], ['\\（押している間）', '編集前を表示'], ['Delete', '選んだ文字・スタンプを削除'], ['Esc', '選択をやめる'], ['0', '表示を画面に合わせる']].map(([k, v]) => h('li', {}, h('kbd', {}, k), ` ${v}`)))),
  ];
}

// ───────────────────────── 写真の上での操作 ─────────────────────────
function canvasPoint(e) {
  const r = E.view.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * E.view.width, ((e.clientY - r.top) / r.height) * E.view.height];
}
const toOut = ([cx, cy]) => [(cx - E.L.ix) / E.L.iw, (cy - E.L.iy) / E.L.ih];
const gp = () => geoParams(E.state.geo, E.W, E.H);
const outToCanvas = ([x, y]) => [E.L.ix + x * E.L.iw, E.L.iy + y * E.L.ih];

function setupPointer(stage) {
  const pts = new Map(); let action = null; let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!E || e.button > 0) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (pts.size === 2) { action?.cancel?.(); action = null; const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: E.zoom, pan: [...E.pan], mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; return; }
    action = startAction(e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!E || !pts.has(e.pointerId)) { if (E) hoverCursor(e); return; }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      interacting(); E.zoom = Math.min(8, Math.max(1, pinch.zoom * (d / pinch.d)));
      E.pan = E.zoom === 1 ? [0, 0] : [pinch.pan[0] + mid[0] - pinch.mid[0], pinch.pan[1] + mid[1] - pinch.mid[1]];
      requestRender(); return;
    }
    if (action?.move) { interacting(); action.move(e); }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; return; }
    action?.end?.(e); action = null;
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', (e) => { action?.cancel?.(); action = null; pts.delete(e.pointerId); pinch = null; });
  stage.addEventListener('wheel', (e) => {
    if (!E) return; e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    const z = Math.min(8, Math.max(1, E.zoom * f));
    const r = stage.getBoundingClientRect(); const cx = e.clientX - r.left - r.width / 2; const cy = e.clientY - r.top - r.height / 2;
    E.pan = z === 1 ? [0, 0] : [cx - (cx - E.pan[0]) * (z / E.zoom), cy - (cy - E.pan[1]) * (z / E.zoom)];
    E.zoom = z; interacting(); requestRender();
  }, { passive: false });
  stage.addEventListener('dblclick', () => { if (!E || ['crop', 'local', 'heal', 'hide', 'draw'].includes(E.tool)) return; E.zoom = E.zoom > 1 ? 1 : 2.5; E.pan = [0, 0]; requestRender(); });
}

function hoverCursor(e) {
  const brush = (E.tool === 'heal') || (E.tool === 'local' && E.state.locals.find((l) => l.id === E.sel)?.type === 'brush');
  if (!brush || !E.L) { if (E.cursor) { E.cursor = null; drawHandles(); } return; }
  E.cursor = canvasPoint(e); drawHandles();
}

/** 押した場所と道具に応じた操作を始める */
function startAction(e) {
  if (!E.L) return null;
  const c = canvasPoint(e); const o = toOut(c); const p = gp();
  const tool = E.tool;
  // スポイト（ホワイトバランス）
  if (tool === 'color' && E.wbPick) {
    const [s, t] = outToSrc(...o, p); const lin = sampleSource(s, t).map((v) => v ** 2.2);
    const [r, g, b] = lin.map((v) => Math.max(v, 1e-4));
    const temp = (b - r) / (0.18 * r + 0.22 * b); const avg = (r * (1 + 0.18 * temp) + b * (1 - 0.22 * temp)) / 2; const tint = (1 - avg / g) / 0.12;
    E.state.adj.temp = Math.round(Math.max(-1, Math.min(1, temp)) * 100); E.state.adj.tint = Math.round(Math.max(-1, Math.min(1, tint)) * 100);
    E.wbPick = false; commit(); buildPanel(); requestRender(); toast('ホワイトバランスを合わせました');
    return null;
  }
  if (tool === 'crop') return cropAction(c);
  if (tool === 'local') return localAction(e, c, o, p);
  if (tool === 'heal') return healAction(c, o, p);
  if (tool === 'skin') return skinAction(e, o, p);
  if (tool === 'hide') return hideAction(c, o, p);
  if (tool === 'draw') return drawAction(o);
  if (tool === 'text' || tool === 'sticker') return overlayAction(c, o, tool);
  if (E.zoom > 1) { const start = [e.clientX, e.clientY]; const pan0 = [...E.pan]; return { move: (ev) => { E.pan = [pan0[0] + ev.clientX - start[0], pan0[1] + ev.clientY - start[1]]; applyZoom(); } }; }
  return null;
}

function cropAction(c) {
  const g = E.state.geo; const L = E.L;
  const box = [L.ix + g.crop.x * L.iw, L.iy + g.crop.y * L.ih, g.crop.w * L.iw, g.crop.h * L.ih];
  const tol = 28 * (E.view.width / E.view.getBoundingClientRect().width);
  const inX = c[0] > box[0] - tol && c[0] < box[0] + box[2] + tol; const inY = c[1] > box[1] - tol && c[1] < box[1] + box[3] + tol;
  if (!inX || !inY) return null;
  let handle = '';
  if (Math.abs(c[1] - box[1]) < tol) handle += 't'; else if (Math.abs(c[1] - box[1] - box[3]) < tol) handle += 'b';
  if (Math.abs(c[0] - box[0]) < tol) handle += 'l'; else if (Math.abs(c[0] - box[0] - box[2]) < tol) handle += 'r';
  const start = c; const crop0 = { ...g.crop }; const o = orientedSize(g, E.W, E.H);
  const ratio = aspectValue(g.aspect, o.w, o.h);
  return {
    move: (e) => { const p = canvasPoint(e); g.crop = dragCrop(crop0, handle || 'move', (p[0] - start[0]) / L.iw, (p[1] - start[1]) / L.ih, ratio, o.w, o.h); requestRender(); },
    end: commit,
  };
}

function localAction(e, c, o, p) {
  const cur = E.state.locals.find((l) => l.id === E.sel);
  if (!cur) return null;
  const toSrc = (pt) => outToSrc(...toOut(pt), p);
  if (cur.type === 'color' && E.colorPick) {
    const [r, g, b] = sampleSource(...toSrc(c)); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
    let hue = 0; if (d > 0) hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    cur.hue = Math.round(((hue * 60) + 360) % 360); cur.minSat = Math.min(cur.minSat, Math.round((d / (mx || 1)) * 50));
    E.colorPick = false; commit(); buildPanel(); requestRender(); return null;
  }
  if (cur.type === 'brush') {
    const b = prefs.get('brush', { size: 8, hard: 50, flow: 100, erase: false });
    if (cur.strokes.length >= S.MAX_STROKES) { toast('これ以上塗れません。新しいブラシを追加してください'); return null; }
    const st = { erase: b.erase, size: b.size / 200, hard: b.hard / 100, flow: b.flow / 100, pts: [toSrc(c)] };
    cur.strokes.push(st);
    const refresh = () => { E.maskDirty = true; requestRender(); }; // マスクの作り直しは次の描画で1回だけ
    refresh(); // 最初の点を塗る（このブラシのキャンバスに足される）
    return {
      move: (ev) => {
        const q = toSrc(canvasPoint(ev)); const last = st.pts.at(-1);
        if (Math.hypot((q[0] - last[0]) * E.W, (q[1] - last[1]) * E.H) < st.size * Math.min(E.W, E.H) * 0.2 || st.pts.length >= 2000) return;
        st.pts.push(q);
        // 新しく伸びた部分だけを塗り足す
        const ent = [...E.maskCache.entries()].find(([k]) => k.startsWith(`${cur.id}:`))?.[1];
        if (ent) paintStroke(ent.c.getContext('2d'), st, ent.c.width, ent.c.height, st.pts.length - 1);
        refresh();
      },
      end: () => { E.maskKey = maskKey(); commit(); },
      cancel: () => { cur.strokes.pop(); E.maskCache.clear(); rebuildMask(); requestRender(); },
    };
  }
  // 線形・円形: 一番近い操作点をドラッグ
  const handles = localHandles(cur);
  const tol = 30 * (E.view.width / E.view.getBoundingClientRect().width);
  let best = null; let bd = tol;
  for (const hd of handles) { const d = Math.hypot(hd.at[0] - c[0], hd.at[1] - c[1]); if (d < bd) { bd = d; best = hd; } }
  if (!best) return null;
  const start = toSrc(c); const snap = S.clone(cur);
  return { move: (ev) => { best.drag(toSrc(canvasPoint(ev)), start, snap); requestRender(); }, end: commit };
}
function localHandles(l) {
  const p = gp(); const at = (s, t) => outToCanvas(srcToOut(s, t, p));
  if (l.type === 'linear') {
    return [
      { at: at(l.x1, l.y1), drag: (q, s0, o) => { l.x1 = o.x1 + q[0] - s0[0]; l.y1 = o.y1 + q[1] - s0[1]; } },
      { at: at(l.x2, l.y2), drag: (q, s0, o) => { l.x2 = o.x2 + q[0] - s0[0]; l.y2 = o.y2 + q[1] - s0[1]; } },
      { at: at((l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2), drag: (q, s0, o) => { const dx = q[0] - s0[0]; const dy = q[1] - s0[1]; Object.assign(l, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }); } },
    ];
  }
  if (l.type === 'radial') {
    return [
      { at: at(l.cx, l.cy), drag: (q, s0, o) => { l.cx = o.cx + q[0] - s0[0]; l.cy = o.cy + q[1] - s0[1]; } },
      { at: at(l.cx + l.rx, l.cy), drag: (q) => { l.rx = Math.max(0.01, Math.hypot((q[0] - l.cx) * E.W, (q[1] - l.cy) * E.H) / E.W); } },
      { at: at(l.cx, l.cy + l.ry), drag: (q) => { l.ry = Math.max(0.01, Math.hypot((q[0] - l.cx) * E.W, (q[1] - l.cy) * E.H) / E.H); } },
    ];
  }
  return [];
}

function healAction(c, o, p) {
  const size = prefs.get('healSize', 3) / 100 * 0.6; // 短い辺に対する半径の割合
  const path = [c];
  return {
    move: (e) => { path.push(canvasPoint(e)); E.healPath = path; drawHandles(); },
    end: () => {
      E.healPath = null;
      // なぞった線に沿って、半径ごとに修復点を置く
      const rCanvas = size * Math.min(E.L.iw, E.L.ih); const spots = [path[0]];
      for (const q of path) if (Math.hypot(q[0] - spots.at(-1)[0], q[1] - spots.at(-1)[1]) > rCanvas * 1.2) spots.push(q);
      const srcR = size * outputScaleToSrc();
      for (const q of spots.slice(0, 40)) { const [s, t] = outToSrc(...toOut(q), p); if (s >= 0 && s <= 1 && t >= 0 && t <= 1) addRetouch({ type: 'heal', x: s, y: t, r: Math.min(0.2, Math.max(0.002, srcR)), sx: null, sy: null }); }
      commit(); buildPanel(); requestRender();
    },
    cancel: () => { E.healPath = null; drawHandles(); },
  };
}
/** 出力画像の短い辺に対する割合 → 元写真の短い辺に対する割合 */
function outputScaleToSrc() { const o = outputSize(E.state.geo, E.W, E.H); return Math.min(o.w, o.h) / Math.min(E.W, E.H) / gp().zoom; }

function hideAction(c, o, p) {
  const start = c;
  return {
    move: (e) => { E.rect = [start, canvasPoint(e)]; drawHandles(); },
    end: () => {
      const r = E.rect; E.rect = null;
      if (!r || Math.abs(r[0][0] - r[1][0]) < 6 || Math.abs(r[0][1] - r[1][1]) < 6) { drawHandles(); toast('隠したい場所を四角く囲むようにドラッグしてください'); return; }
      const corners = [[r[0][0], r[0][1]], [r[1][0], r[0][1]], [r[0][0], r[1][1]], [r[1][0], r[1][1]]].map((q) => outToSrc(...toOut(q), p));
      const xs = corners.map((q) => Math.min(1, Math.max(0, q[0]))); const ys = corners.map((q) => Math.min(1, Math.max(0, q[1])));
      const x = Math.min(...xs); const y = Math.min(...ys);
      addRetouch({ type: prefs.get('hideMode', 'mosaic'), x, y, w: Math.max(0.001, Math.max(...xs) - x), h: Math.max(0.001, Math.max(...ys) - y), size: prefs.get('hideSize', 20) });
      commit(); buildPanel(); requestRender();
    },
    cancel: () => { E.rect = null; drawHandles(); },
  };
}

function drawAction(o) {
  if (E.state.overlays.length >= S.MAX_OVERLAYS) { toast('文字・スタンプ・描画は60個までです'); return null; }
  const d = prefs.get('draw', { color: '#ff3b30', width: 1, mode: 'pen' });
  const ov = S.validateState({ overlays: [{ type: 'draw', id: uid(), color: d.color, width: d.width / 200, mode: d.mode, pts: [o] }] }).overlays[0];
  E.state.overlays.push(ov); requestRender();
  return {
    move: (e) => { const q = toOut(canvasPoint(e)); const l = ov.pts.at(-1); if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.003 && ov.pts.length < 4000) { ov.pts.push(q); requestRender(); } },
    end: commit,
    cancel: () => { E.state.overlays = E.state.overlays.filter((x) => x !== ov); requestRender(); },
  };
}

function overlayAction(c, o, tool) {
  const kind = tool === 'text' ? 'text' : 'sticker';
  const hit = hitOverlay(E.view.getContext('2d'), E.state.overlays.filter((x) => x.type === kind), c[0], c[1], E.L);
  if (!hit) { if (E.selOverlay) { E.selOverlay = null; buildPanel(); drawHandles(); } return null; }
  if (E.selOverlay !== hit.id) { E.selOverlay = hit.id; buildPanel(); }
  const start = o; const p0 = [hit.x, hit.y];
  return {
    move: (e) => { const q = toOut(canvasPoint(e)); hit.x = Math.min(1.2, Math.max(-0.2, p0[0] + q[0] - start[0])); hit.y = Math.min(1.2, Math.max(-0.2, p0[1] + q[1] - start[1])); requestRender(); },
    end: commit,
  };
}

/** 切り抜き枠・操作点・選択枠などを SVG で重ねて描く */
function drawHandles() {
  if (!E?.L) return;
  const svg = E.svg; const NS = 'http://www.w3.org/2000/svg';
  svg.setAttribute('viewBox', `0 0 ${E.view.width} ${E.view.height}`);
  svg.replaceChildren();
  const k = E.view.width / Math.max(1, E.view.getBoundingClientRect().width || E.view.width);
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v); svg.append(e); return e; };
  const dot = (x, y, r = 9) => { el('circle', { cx: x, cy: y, r: r * k, class: 'hd' }); };
  const L = E.L;
  if (E.showOriginal) return;
  if (E.tool === 'crop') {
    const g = E.state.geo.crop; const x = L.ix + g.x * L.iw; const y = L.iy + g.y * L.ih; const w = g.w * L.iw; const hh = g.h * L.ih;
    el('path', { d: `M0 0H${E.view.width}V${E.view.height}H0Z M${x} ${y}v${hh}h${w}v${-hh}Z`, class: 'shade', 'fill-rule': 'evenodd' });
    el('rect', { x, y, width: w, height: hh, class: 'crop-box', 'stroke-width': 2 * k });
    for (let i = 1; i < 3; i++) { el('line', { x1: x + (w * i) / 3, y1: y, x2: x + (w * i) / 3, y2: y + hh, class: 'thirds', 'stroke-width': k }); el('line', { x1: x, y1: y + (hh * i) / 3, x2: x + w, y2: y + (hh * i) / 3, class: 'thirds', 'stroke-width': k }); }
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + hh], [x + w, y + hh]]) el('rect', { x: cx - 7 * k, y: cy - 7 * k, width: 14 * k, height: 14 * k, class: 'hd-sq' });
    return;
  }
  if (E.tool === 'local') {
    const cur = E.state.locals.find((l) => l.id === E.sel);
    if (cur?.type === 'linear') {
      const [a, b, m] = localHandles(cur).map((x) => x.at);
      const dx = b[0] - a[0]; const dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1; const nx = (-dy / len) * 2000; const ny = (dx / len) * 2000;
      for (const q of [a, b]) el('line', { x1: q[0] - nx, y1: q[1] - ny, x2: q[0] + nx, y2: q[1] + ny, class: 'guide', 'stroke-width': 2 * k });
      el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'guide dashed', 'stroke-width': 1.5 * k });
      dot(...a); dot(...b); dot(...m, 7);
    } else if (cur?.type === 'radial') {
      const [c, rx, ry] = localHandles(cur).map((x) => x.at);
      const a = Math.atan2(rx[1] - c[1], rx[0] - c[0]) * 180 / Math.PI;
      el('ellipse', { cx: c[0], cy: c[1], rx: Math.hypot(rx[0] - c[0], rx[1] - c[1]), ry: Math.hypot(ry[0] - c[0], ry[1] - c[1]), transform: `rotate(${a} ${c[0]} ${c[1]})`, class: 'guide', 'stroke-width': 2 * k });
      dot(...c); dot(...rx, 7); dot(...ry, 7);
    }
  }
  if (E.tool === 'skin') {
    // 肌として選んだ場所
    const p = gp();
    for (const [sx, sy] of E.state.portrait.seeds) { const [x, y] = outToCanvas(srcToOut(sx, sy, p)); el('circle', { cx: x, cy: y, r: 7 * k, class: 'skin-seed' }); }
  }
  if (E.healPath) el('polyline', { points: E.healPath.map((q) => q.join(',')).join(' '), class: 'heal-path', 'stroke-width': prefs.get('healSize', 3) / 100 * 0.6 * Math.min(L.iw, L.ih) * 2 });
  if (E.rect) { const [a, b] = E.rect; el('rect', { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), class: 'sel-rect', 'stroke-width': 2 * k }); }
  if (E.cursor && (E.tool === 'heal' || E.tool === 'local')) {
    const r = E.tool === 'heal' ? prefs.get('healSize', 3) / 100 * 0.6 * Math.min(L.iw, L.ih) : (prefs.get('brush', { size: 8 }).size / 200) * Math.min(L.iw, L.ih) / outputScaleToSrc();
    el('circle', { cx: E.cursor[0], cy: E.cursor[1], r, class: 'cursor', 'stroke-width': 1.5 * k });
  }
  if ((E.tool === 'text' || E.tool === 'sticker') && E.selOverlay) {
    const o = E.state.overlays.find((x) => x.id === E.selOverlay);
    if (o && o.type !== 'draw') {
      const b = overlayBox(E.view.getContext('2d'), o, L); const w = b.w; const hh = b.h; const fs = b.fs;
      const [cx, cy] = outToCanvas([o.x, o.y]); const pad = fs * 0.3;
      el('rect', { x: cx - w / 2 - pad, y: cy - hh / 2 - pad, width: w + pad * 2, height: hh + pad * 2, transform: `rotate(${o.rot} ${cx} ${cy})`, class: 'sel-box', 'stroke-width': 2 * k });
    }
  }
}

// ───────────────────────── キーボード ─────────────────────────
function onKey(e) {
  if (!E) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (typing) return;
  if (e.key === '\\') { E.setOrig(true); return; }
  if (e.key === 'Escape') { E.selOverlay = null; E.wbPick = false; E.colorPick = false; buildPanel(); requestRender(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && E.selOverlay) { E.state.overlays = E.state.overlays.filter((o) => o.id !== E.selOverlay); E.selOverlay = null; commit(); buildPanel(); requestRender(); }
  if (e.key === '0') { E.zoom = 1; E.pan = [0, 0]; requestRender(); }
}
function onKeyUp(e) { if (E && e.key === '\\') E.setOrig(false); }

// ───────────────────────── 書き出し ─────────────────────────
const canWebp = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').startsWith('data:image/webp'); } catch { return false; } })();

/** 1枚を書き出す（元の大きさで描き直す） */
/** 編集内容を当てた画像を、Canvas に描く（書き出し・グリッドで使う） */
function renderToCanvas({ base, W, H, state }, { maxSide } = {}) {
  const glc = document.createElement('canvas'); const eng = new Engine(glc);
  try {
    const st = S.validateState(state);
    let src = base;
    if (st.retouch.length || portraitActive(st.portrait)) src = retouchCanvas(base, st.retouch, st.portrait).canvas;
    eng.setSource(src, W, H);
    eng.setMask(buildMask(st, W, H));
    const o = outputSize(st.geo, W, H);
    // 枠・余白を含めた最終的な大きさで、長辺の指定と端末の上限（iPhone の Canvas は約1,670万画素まで）を守る
    const L0 = layout(o.w, o.h, st.frame);
    const s = Math.min(1, (maxSide || Infinity) / Math.max(L0.cw, L0.ch), eng.maxSize / Math.max(o.w, o.h), Math.sqrt((MAX_PIXELS * 0.99) / (L0.cw * L0.ch))); // 丸めで上限を超えないよう少し余裕を持たせる
    const w = Math.max(1, Math.round(o.w * s)); const hgt = Math.max(1, Math.round(o.h * s));
    eng.render(effective(st), w, hgt);
    const out = document.createElement('canvas');
    compose(out, glc, st);
    return out;
  } finally { eng.dispose(); }
}
async function canvasToBlob(canvas, format, quality) {
  let out = canvas;
  if (format === 'image/jpeg') { const f = document.createElement('canvas'); f.width = out.width; f.height = out.height; const ctx = f.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, f.width, f.height); ctx.drawImage(out, 0, 0); out = f; }
  const blob = await new Promise((r) => out.toBlob(r, format, quality));
  if (!blob) throw new Error('toBlob');
  return { blob, w: out.width, h: out.height };
}
/** 1枚を書き出す（元の大きさで描き直す） */
async function renderToBlob(src, { format, quality, maxSide }) {
  return canvasToBlob(renderToCanvas(src, { maxSide }), format, quality);
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'photo';

function openExport({ batch }) {
  const opt = prefs.get('export', { format: 'image/jpeg', quality: 92, maxSide: 0 });
  if (opt.format === 'image/webp' && !canWebp) opt.format = 'image/jpeg';
  const save = () => prefs.set('export', opt);
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const name = h('input', { id: 'exp-name', maxlength: 80, value: batch ? '' : `${E.proj.name}_edit`, placeholder: batch ? '（元の名前 + _edit）' : '' });
  const q = slider({ label: '画質', min: 50, max: 100, value: opt.quality, def: 92, unit: '%', onChange: (v) => { opt.quality = v; save(); } });
  const qWrap = h('div', { hidden: opt.format === 'image/png' }, q.el);
  const go = h('button', { type: 'button', class: 'primary' }, batch ? `${batch.length}枚を書き出す` : '書き出す');
  const shareBtn = h('button', { type: 'button', hidden: !(navigator.canShare && !batch) }, '共有…');
  const dlg = h('dialog', { class: 'dlg export', 'aria-labelledby': 'exp-h' },
    h('h2', { id: 'exp-h' }, batch ? `まとめて書き出し（${batch.length}枚）` : '書き出し'),
    h('div', { class: 'sub-head' }, h('b', {}, '形式')),
    chips([['image/jpeg', 'JPEG'], ['image/png', 'PNG（劣化なし）'], ...(canWebp ? [['image/webp', 'WebP（小さい）']] : [])], opt.format, (v) => { opt.format = v; qWrap.hidden = v === 'image/png'; save(); }, { label: '形式' }).el,
    qWrap,
    h('div', { class: 'sub-head' }, h('b', {}, '大きさ（長い辺）')),
    chips([[0, '元の大きさ'], [4096, '4096px'], [2048, '2048px'], [1080, '1080px（SNS）']], opt.maxSide, (v) => { opt.maxSide = v; save(); }, { label: '大きさ' }).el,
    h('div', { class: 'field' }, h('label', { for: 'exp-name' }, 'ファイル名'), name),
    h('p', { class: 'ok-note' }, '✓ 位置情報・撮影日時・カメラ情報などのメタデータは、書き出した画像には入りません。'),
    status,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, '閉じる'), shareBtn, go));
  dlg.addEventListener('close', () => dlg.remove());
  const one = async () => {
    flushSave();
    const st = S.clone(E.state);
    status.textContent = '書き出しています…';
    const r = await renderToBlob({ base: E.base, W: E.W, H: E.H, state: st }, { format: opt.format, quality: opt.quality / 100, maxSide: opt.maxSide });
    status.textContent = `${r.w}×${r.h}・${fmtBytes(r.blob.size)}`;
    return { ...r, file: `${safeName(name.value.trim() || `${E.proj.name}_edit`)}.${EXT[opt.format]}` };
  };
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      if (!batch) { const r = await one(); download(r.blob, r.file); toast('書き出しました'); }
      else {
        let i = 0;
        for (const p of batch) {
          status.textContent = `書き出しています… ${++i}/${batch.length}`;
          const blob = await db.getBlob(p.id); const prep = await prepare(p, blob);
          const r = await renderToBlob({ base: prep.base, W: prep.W, H: prep.H, state: p.state }, { format: opt.format, quality: opt.quality / 100, maxSide: opt.maxSide });
          prep.base.close?.();
          download(r.blob, `${safeName(name.value.trim() ? `${name.value.trim()}_${i}` : `${p.name}_edit`)}.${EXT[opt.format]}`);
          await new Promise((res) => setTimeout(res, 400));
        }
        status.textContent = `${batch.length}枚を書き出しました`;
      }
    } catch { status.textContent = '書き出せませんでした。大きさを小さくしてお試しください。'; } finally { go.disabled = false; }
  });
  shareBtn.addEventListener('click', async () => {
    shareBtn.disabled = true;
    try {
      const r = await one(); const file = new File([r.blob], r.file, { type: opt.format });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] }); else { download(r.blob, r.file); toast('共有できないので保存しました'); }
    } catch (e) { if (e?.name !== 'AbortError') status.textContent = '共有できませんでした'; } finally { shareBtn.disabled = false; }
  });
  document.body.append(dlg); dlg.showModal();
}

// ───────────────────────── グリッド（複数の写真を1枚に） ─────────────────────────
let GR = null;
async function showGrid(projects) {
  closeEditor();
  const ps = projects.slice(0, MAX_GRID);
  if (ps.length < 2) { toast('グリッドには2枚以上の写真を選んでください'); return; }
  render(app, h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `グリッドを準備しています…（${ps.length}枚）`));
  const imgs = {};
  try {
    for (const p of ps) {
      const prep = await prepare(p, await db.getBlob(p.id));
      imgs[p.id] = renderToCanvas({ base: prep.base, W: prep.W, H: prep.H, state: p.state }, { maxSide: 1400 }); // 各写真の編集を当てたもの
      prep.base.close?.();
    }
  } catch { toast('写真を準備できませんでした'); showLibrary(); return; }
  GR = { ps, imgs, grid: { ...defaultGrid(ps.map((p) => p.id)), ...prefs.get('gridStyle', {}) }, sel: -1, swap: false, tab: 'layout' };
  if (!LAYOUTS[ps.length].some((l) => l.id === GR.grid.layout)) GR.grid.layout = LAYOUTS[ps.length][0].id;
  buildGrid();
}
const gridImages = () => GR.grid.cells.map((c) => GR.imgs[c.id]);

function buildGrid() {
  document.title = 'グリッド — てもとフォト';
  GR.view = h('canvas', { class: 'view grid-view', role: 'img', 'aria-label': `${GR.ps.length}枚の写真のグリッド` });
  GR.stage = h('div', { class: 'stage', 'data-tool': 'grid' }, GR.view);
  GR.panel = h('div', { class: 'panel', role: 'tabpanel', id: 'grid-panel' });
  const TABS = [['layout', '▦', 'レイアウト'], ['style', '▢', '余白・色'], ['photo', '☐', '写真']];
  GR.tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'グリッドの設定' }, TABS.map(([k, icon, label]) => h('button', {
    type: 'button', role: 'tab', id: `gtab-${k}`, 'aria-controls': 'grid-panel', 'aria-selected': String(GR.tab === k), tabindex: GR.tab === k ? '0' : '-1',
    onclick: () => { GR.tab = k; for (const b of GR.tabs.children) { const on = b.id === `gtab-${k}`; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; } gridPanel(); },
  }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label))));
  render(app, h('div', { class: 'editor grid-editor' },
    h('header', { class: 'ed-head' },
      h('button', { type: 'button', class: 'back', onclick: () => { GR = null; showLibrary(); } }, '‹ 写真'),
      h('span', { class: 'ed-title' }, `グリッド（${GR.ps.length}枚）`),
      h('div', { class: 'ed-tools' }, h('button', { type: 'button', class: 'primary', onclick: openGridExport }, '書き出し'))),
    GR.stage, h('div', { class: 'dock' }, GR.panel, GR.tabs)));
  gridPointer(GR.stage);
  gridPanel(); drawGridView();
  addEventListener('resize', drawGridView);
}

function drawGridView() {
  if (!GR?.view?.isConnected) { removeEventListener('resize', drawGridView); return; }
  const st = GR.stage.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
  const base = gridSize(GR.grid.aspect, 1000);
  const fit = Math.min((st.width - 24) * dpr / base.w, (st.height - 24) * dpr / base.h, 2);
  const W = Math.max(1, Math.round(base.w * fit)); const H = Math.max(1, Math.round(base.h * fit));
  if (GR.view.width !== W || GR.view.height !== H) { GR.view.width = W; GR.view.height = H; }
  GR.rects = drawGrid(GR.view.getContext('2d'), W, H, GR.grid, gridImages(), { selected: GR.sel, handles: true, active: GR.line });
  GR.view.style.width = `${W / dpr}px`; GR.view.style.height = `${H / dpr}px`;
}
function saveGridStyle() { const { aspect, gap, margin, radius, bg } = GR.grid; prefs.set('gridStyle', { aspect, gap, margin, radius, bg }); }

function gridPanel() {
  const G = GR.grid; const n = G.cells.length;
  let body;
  if (GR.tab === 'layout') {
    const thumbs = h('div', { class: 'grid-layouts', role: 'group', 'aria-label': 'レイアウト' }, LAYOUTS[n].map((l) => {
      const c = h('canvas', { width: 64, height: 64, 'aria-hidden': 'true' });
      const ctx = c.getContext('2d'); ctx.fillStyle = '#1c1d20'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = '#8b8e95';
      for (const r of cellRects(l, 64, 64, { gap: 6, margin: 6 })) ctx.fillRect(r.x, r.y, r.w, r.h);
      return h('button', { type: 'button', class: 'grid-layout', 'aria-pressed': String(G.layout === l.id), onclick: () => { G.layout = l.id; G.lines = {}; gridPanel(); drawGridView(); } }, c, h('span', {}, l.name));
    }));
    body = [h('div', { class: 'sub-head' }, h('b', {}, '比率')),
      chips(Object.keys(GRID_ASPECTS).map((k) => [k, k]), G.aspect, (v) => { G.aspect = v; saveGridStyle(); drawGridView(); }, { label: '比率' }).el,
      h('div', { class: 'sub-head' }, h('b', {}, 'レイアウト')), thumbs,
      hint('写真の間の線（白いつまみ）をドラッグすると、写真の大きさの割合を変えられます。'),
      Object.keys(G.lines || {}).length ? btn('線の位置を元に戻す', () => { G.lines = {}; gridPanel(); drawGridView(); }, 'ghost small') : null];
  } else if (GR.tab === 'style') {
    const upd = (k, f = (v) => v) => (v) => { G[k] = f(v); saveGridStyle(); drawGridView(); };
    body = [
      slider({ label: '写真のすき間', min: 0, max: 10, step: 0.5, value: G.gap, def: 2, onInput: upd('gap') }).el,
      slider({ label: '外側の余白', min: 0, max: 10, step: 0.5, value: G.margin, def: 2, onInput: upd('margin') }).el,
      slider({ label: '角の丸み', min: 0, max: 100, value: G.radius, def: 0, onInput: upd('radius') }).el,
      colorPicker({ label: '背景の色', value: G.bg, onPick: upd('bg') }).el,
    ];
  } else {
    const i = GR.sel; const cell = G.cells[i];
    body = cell ? [
      hint(GR.swap ? '入れ替える相手の写真をタップしてください。' : 'ドラッグで写真の見える位置を動かせます。ほかの写真と入れ替えることもできます。'),
      slider({ label: '拡大', min: 100, max: 400, value: Math.round(cell.zoom * 100), def: 100, unit: '%', onInput: (v) => { cell.zoom = v / 100; drawGridView(); } }).el,
      row(btn(GR.swap ? '入れ替えをやめる' : '⇄ ほかの写真と入れ替え', () => { GR.swap = !GR.swap; gridPanel(); }, GR.swap ? 'active' : ''),
        btn('位置と拡大をリセット', () => { Object.assign(cell, { zoom: 1, ox: 0, oy: 0 }); gridPanel(); drawGridView(); }, 'ghost small')),
    ] : [hint('写真をタップして選ぶと、見える位置・拡大・入れ替えを変えられます。')];
  }
  GR.panel.setAttribute('aria-labelledby', `gtab-${GR.tab}`);
  render(GR.panel, h('div', { class: 'panel-inner' }, body));
}

function gridPointer(stage) {
  const pts = new Map(); let drag = null; let pinch = null; let line = null;
  const pos = (e) => { const r = GR.view.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * GR.view.width, ((e.clientY - r.top) / r.height) * GR.view.height]; };
  const layout = () => layoutById(GR.grid.cells.length, GR.grid.layout);
  // 線の近く（指で押しやすいよう、画面上で 14px 以内）なら線をつかむ
  const lineAt = (e) => { const r = GR.view.getBoundingClientRect(); return hitDivider(layout(), GR.rects, ...pos(e), 14 * (GR.view.width / r.width)); };
  const overflow = (i) => {
    const img = gridImages()[i]; const rc = GR.rects[i]; const c = GR.grid.cells[i];
    const sc = Math.max(rc.w / img.width, rc.h / img.height) * c.zoom;
    return [(img.width * sc - rc.w) / 2, (img.height * sc - rc.h) / 2];
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!GR) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]); stage.setPointerCapture(e.pointerId);
    if (line) return; // 線を動かしている間は、ほかの指は使わない
    if (pts.size === 2 && GR.sel >= 0) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: GR.grid.cells[GR.sel].zoom }; drag = null; return; }
    const d = pts.size === 1 && lineAt(e);
    if (d) {
      const G = GR.grid; G.lines ||= {};
      const e0 = cellEdges(layout(), G.lines)[d.after[0]][d.axis === 'v' ? 0 : 1];
      line = { d, id: e.pointerId, start: pos(e), v0: e0, range: dividerRange(layout(), G.lines, d) };
      GR.line = d.id; drawGridView(); return;
    }
    const i = hitCell(GR.rects, ...pos(e));
    if (i < 0) { GR.sel = -1; GR.swap = false; gridPanel(); drawGridView(); return; }
    if (GR.swap && GR.sel >= 0 && i !== GR.sel) {
      const c = GR.grid.cells; [c[GR.sel], c[i]] = [c[i], c[GR.sel]];
      GR.sel = i; GR.swap = false; gridPanel(); drawGridView(); toast('入れ替えました'); return;
    }
    if (GR.sel !== i) { GR.sel = i; if (GR.tab !== 'photo') { GR.tab = 'photo'; for (const b of GR.tabs.children) { const on = b.id === 'gtab-photo'; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; } } gridPanel(); drawGridView(); }
    const c = GR.grid.cells[i];
    drag = { i, start: pos(e), ox: c.ox, oy: c.oy, ov: overflow(i) };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!GR) return;
    if (!pts.size && e.pointerType === 'mouse') { const d = lineAt(e); stage.style.cursor = d ? (d.axis === 'v' ? 'col-resize' : 'row-resize') : ''; }
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (line) {
      if (e.pointerId !== line.id) return;
      const p = pos(e); const m = gridMetrics(GR.view.width, GR.view.height, GR.grid);
      const v = line.d.axis === 'v' ? line.v0 + (p[0] - line.start[0]) / m.iw : line.v0 + (p[1] - line.start[1]) / m.ih;
      GR.grid.lines[line.d.id] = Math.max(line.range[0], Math.min(line.range[1], v));
      drawGridView(); return;
    }
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; GR.grid.cells[GR.sel].zoom = Math.min(4, Math.max(1, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); drawGridView(); return; }
    if (!drag) return;
    const p = pos(e); const c = GR.grid.cells[drag.i];
    if (drag.ov[0] > 0.5) c.ox = Math.max(-1, Math.min(1, drag.ox - (p[0] - drag.start[0]) / drag.ov[0]));
    if (drag.ov[1] > 0.5) c.oy = Math.max(-1, Math.min(1, drag.oy - (p[1] - drag.start[1]) / drag.ov[1]));
    drawGridView();
  });
  const end = (e) => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (line && e.pointerId === line.id) { line = null; if (GR) { GR.line = null; drawGridView(); if (GR.tab === 'layout') gridPanel(); } }
    if (!pts.size) { drag = null; if (GR?.tab === 'photo') gridPanel(); }
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    if (!GR || GR.sel < 0) return; e.preventDefault();
    const c = GR.grid.cells[GR.sel]; c.zoom = Math.min(4, Math.max(1, c.zoom * Math.exp(-e.deltaY * 0.002))); drawGridView();
  }, { passive: false });
}

/** 書き出し用に、元の画質で描く（各写真は、そのマスに必要な大きさで描き直す） */
async function renderGridFull(longSide) {
  let { w, h: hh } = gridSize(GR.grid.aspect, longSide);
  const k = Math.min(1, Math.sqrt((MAX_PIXELS * 0.99) / (w * hh))); w = Math.round(w * k); hh = Math.round(hh * k);
  const n = GR.grid.cells.length;
  const rects = cellRects(layoutById(n, GR.grid.layout), w, hh, GR.grid);
  const images = [];
  for (let i = 0; i < n; i++) {
    const c = GR.grid.cells[i]; const p = GR.ps.find((q) => q.id === c.id);
    const need = Math.min(4096, Math.ceil(Math.max(rects[i].w, rects[i].h) * c.zoom * 1.6));
    const prep = await prepare(p, await db.getBlob(p.id));
    images.push(renderToCanvas({ base: prep.base, W: prep.W, H: prep.H, state: p.state }, { maxSide: need }));
    prep.base.close?.();
  }
  const out = document.createElement('canvas'); out.width = w; out.height = hh;
  drawGrid(out.getContext('2d'), w, hh, GR.grid, images);
  return out;
}

function openGridExport() {
  const opt = prefs.get('gridExport', { format: 'image/jpeg', size: 2048 });
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const name = h('input', { id: 'grid-name', maxlength: 80, value: `grid_${new Date().toISOString().slice(0, 10)}` });
  const busy = (on) => { for (const b of dlg.querySelectorAll('.dlg-actions button')) b.disabled = on; };
  // 同じ設定でもう一度作るとき（書き出した後に一覧へ保存など）は、前の結果を使う
  let last = null;
  const make = async () => {
    const key = JSON.stringify([GR.grid, opt.size, opt.format]);
    if (last?.key === key) return last.r;
    busy(true); status.textContent = '作っています…';
    try { const c = await renderGridFull(opt.size); const r = await canvasToBlob(c, opt.format, 0.92); status.textContent = `${r.w}×${r.h}・${fmtBytes(r.blob.size)}`; last = { key, r }; return r; } finally { busy(false); }
  };
  const fileName = () => `${safeName(name.value.trim() || 'grid')}.${EXT[opt.format]}`;
  const dlg = h('dialog', { class: 'dlg export', 'aria-labelledby': 'gexp-h' },
    h('h2', { id: 'gexp-h' }, 'グリッドを書き出し'),
    h('div', { class: 'sub-head' }, h('b', {}, '形式')),
    chips([['image/jpeg', 'JPEG'], ['image/png', 'PNG（劣化なし）'], ...(canWebp ? [['image/webp', 'WebP（小さい）']] : [])], opt.format, (v) => { opt.format = v; prefs.set('gridExport', opt); }, { label: '形式' }).el,
    h('div', { class: 'sub-head' }, h('b', {}, '大きさ（長い辺）')),
    chips([[1080, '1080px（SNS）'], [2048, '2048px'], [4096, '4096px']], opt.size, (v) => { opt.size = v; prefs.set('gridExport', opt); }, { label: '大きさ' }).el,
    h('div', { class: 'field' }, h('label', { for: 'grid-name' }, 'ファイル名'), name),
    h('p', { class: 'ok-note' }, '✓ 書き出した画像には、位置情報などのメタデータは入りません。'),
    status,
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, '閉じる'),
      h('button', { type: 'button', onclick: async () => {
        try {
          const r = await make(); const id = uid(); const bmp = await createImageBitmap(r.blob);
          await db.addProject({ id, name: name.value.trim().slice(0, 80) || 'グリッド', fileName: fileName(), created: Date.now(), updated: Date.now(), w: r.w, h: r.h, size: r.blob.size, type: opt.format, exif: null, state: S.defaultState(), thumb: await thumbBlob(bmp) }, r.blob);
          bmp.close?.(); status.textContent = '写真一覧に保存しました。文字やフレームを足すなど、続けて編集できます。'; toast('写真一覧に保存しました');
        } catch { status.textContent = '保存できませんでした'; }
      } }, '写真一覧に保存'),
      h('button', { type: 'button', hidden: !navigator.canShare, onclick: async () => {
        try { const r = await make(); const f = new File([r.blob], fileName(), { type: opt.format }); if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else download(r.blob, fileName()); } catch (e) { if (e?.name !== 'AbortError') status.textContent = '共有できませんでした'; }
      } }, '共有…'),
      h('button', { type: 'button', class: 'primary', onclick: async () => { try { const r = await make(); download(r.blob, fileName()); toast('書き出しました'); } catch { status.textContent = '書き出せませんでした。大きさを小さくしてお試しください。'; } } }, '書き出す')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

// ───────────────────────── はじまり ─────────────────────────
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter(isImage);
  if (files.length && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); importFiles(files); }
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length && !e.target.closest?.('#drop')) { e.preventDefault(); importFiles(e.dataTransfer.files); } });
addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
// ホーム画面のアプリとして「ファイルを開く」から起動されたとき
if ('launchQueue' in window) window.launchQueue.setConsumer(async (p) => { const files = await Promise.all((p.files || []).map((f) => f.getFile())); if (files.length) importFiles(files); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: new URL('./', import.meta.url).pathname }).catch(() => {});
showLibrary();
// テスト・デバッグ用（中身の確認だけ。外部には何も送らない）
window.__temoto = { get state() { return E && S.clone(E.state); }, get editor() { return E; }, get grid() { return GR; } };
