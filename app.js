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
import { warpStroke, warpProtect, warpProtectBox, WARP_MAP_N, WARP_SHAPE, LIP_COLORS, NOSE_POINTS } from './brushfx.js';
import { applyPortrait, portraitActive, tintSkin, PORTRAIT } from './portrait.js';
import { ensureSkinSeg, skinSegFor, findMouth, findEyes, findFaceAt, personMap, warmPersonSeg } from './skinseg.js';
import { compose, layout } from './compose.js';
import { monotoneSpline } from './curves.js';
import * as db from './db.js';
import { slider, chips, colorPicker, toggle, fmtBytes } from './ui.js';
import { ctx2d, imageData, COLOR_SPACE } from './color.js';
import { exportFull } from './fullres.js';
import { lowlightActive, lowlightOptions, withoutLowlight, enhanceCanvas } from './restoration-photo.js';
import { deblurActive, deblurAmount, deblurDenoise, deblurResidualFor, finishCanvas } from './deblur-photo.js';
import { applyFaceAI, detectFaces, faceaiActive, faceaiAmount, faceaiKey, faceThumb, facesFromPhoto, loadPeople, matchFace, savePeople } from './face-photo.js';
import { LIBRAW_RE, decodeLibRaw, developToCanvas, pixelSource } from './rawlib.js';
import { prepareLin } from './rawdev.js';

const app = $('#app');
const MAX_PIXELS = 16_700_000; // iPhone の Safari が扱える Canvas の上限（約1,670万画素）に合わせる
const MAX_SIDE = 8192;
const VERSION = '1.26.0'; // 画面の「情報」に出す（古い版が表示されていないかの確認用）
const PREVIEW_MAX = 2048;
const ZOOM_MAX = 4096; // 拡大表示のときに描く長辺の上限
// 道具は、Canva のように左（スマホでは下）の列でグループを選び、グループの中が複数ならパネルの上のタブで切り替える
const GROUPS = [
  ['raw', '◈', 'RAW', ['raw']], // RAW を開いたときだけ
  ['quick', '✦', 'おまかせ', ['looks', 'auto', 'faceai']],
  ['adjust', '☀', '調整', ['light', 'color', 'hsl', 'curves', 'grade', 'detail', 'effects']],
  ['crop', '⌗', '切り抜き', ['crop']],
  ['local', '◎', '部分補正', ['local']],
  ['retouch', '❀', 'レタッチ', ['skin', 'eyes', 'shape', 'dodge', 'wrinkle', 'heal', 'hide']], // 顔（目元・歯・リップ・鼻筋・目線）は美肌の次に（よく使うので）
  ['frame', '▢', 'フレーム', ['frame']],
  ['info', 'ⓘ', '情報', ['info']],
];
const TOOL_LABEL = { raw: 'RAW', looks: 'フィルター', auto: '自動補正', faceai: '顔 AI', light: 'ライト', color: 'カラー', hsl: 'HSL', curves: 'カーブ', grade: 'グレーディング', detail: 'ディテール', effects: '効果', crop: '切り抜き', local: '部分補正', skin: '美肌', shape: '形', eyes: '顔', dodge: '明暗', wrinkle: 'しわ取り', heal: '修復', hide: 'モザイク', frame: 'フレーム', info: '情報' };
/** 1 人あたりの本人の写真の上限（多いほど目元・歯並びが本人に近づく。1 枚あたり顔 1 つに約 0.3 秒） */
const MAX_REFS = 40;
const TOOLS = Object.keys(TOOL_LABEL);
const groupOf = (tool) => GROUPS.find((g) => g[3].includes(tool));
/** 最初から隠しておく道具（「⋯」メニューの「表示する道具を選ぶ」で出せる。隠しても、写真に当てた編集はそのまま） */
const DEFAULT_HIDDEN = ['light', 'color', 'hsl', 'curves', 'grade', 'detail', 'effects', 'local']; // 切り抜きは、プリントの比率（L判など）に使うので最初から出す
const hiddenTools = () => { const v = prefs.get('hiddenTools', DEFAULT_HIDDEN); return Array.isArray(v) ? v : DEFAULT_HIDDEN; };
/** スペシャリストモード: 隠した道具も全部出す */
const specialist = () => prefs.get('specialist', false) === true;
/** 今見せる道具（RAW は RAW を開いたときだけ）。全部隠されていたら、フィルターだけは見せる */
function shownTools(raw) {
  const hid = specialist() ? [] : hiddenTools(); const list = TOOLS.filter((t) => !hid.includes(t) && (t !== 'raw' || raw));
  return list.length ? list : ['looks'];
}
const shownGroups = (raw) => { const sh = shownTools(raw); return GROUPS.map(([g, icon, label, tools]) => [g, icon, label, tools.filter((t) => sh.includes(t))]).filter((x) => x[3].length); };
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`temoto:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`temoto:${k}`, JSON.stringify(v)); } catch { /* 保存できない環境 */ } },
};

// ── 画面の色（自動＝端末の設定に合わせる／ライト／ダーク） ──
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const THEMES = [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']];
function applyTheme() {
  const t = prefs.get('theme', 'auto');
  const dark = t === 'dark' || (t === 'auto' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1e1f23' : '#7d2ae8');
}
const isDark = () => document.documentElement.dataset.theme === 'dark';
function setTheme(t) {
  prefs.set('theme', t); applyTheme();
  if (E) { buildPanel(); requestRender(); } else if (GR) gridPanel();
}
darkMQ.addEventListener?.('change', () => { if (prefs.get('theme', 'auto') === 'auto') setTheme('auto'); });
/** 画面の色のアイコン（押すたびに 自動 → ライト → ダーク → 自動 … と切り替える） */
// アイコンは絵で描く（文字の記号は端末によって小さかったり絵文字になったりする）
const SVG_NS = 'http://www.w3.org/2000/svg';
const THEME_SVG = {
  auto: [['circle', { cx: 12, cy: 12, r: 8, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }], ['path', { d: 'M12 4a8 8 0 0 1 0 16z', fill: 'currentColor' }]],
  light: [['circle', { cx: 12, cy: 12, r: 4, fill: 'currentColor' }], ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  dark: [['path', { d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', fill: 'currentColor' }]],
};
function themeSvg(t) {
  const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'theme-svg');
  for (const [tag, attrs] of THEME_SVG[t]) { const e = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); }
  return svg;
}
const themeName = (t) => THEMES.find(([k]) => k === t)[1];
const nextTheme = (t) => THEMES[(THEMES.findIndex(([k]) => k === t) + 1) % THEMES.length][0];
function themeButton({ withLabel = false } = {}) {
  const icon = h('span', { class: 'theme-icon', 'aria-hidden': 'true' }); const label = h('span', { class: 'theme-label' });
  const b = h('button', { type: 'button', class: withLabel ? 'theme-cycle labeled' : 'theme-cycle', onclick: () => { const t = nextTheme(prefs.get('theme', 'auto')); setTheme(t); sync(); toast(`画面の色: ${themeName(t)}${t === 'auto' ? '（端末の設定に合わせる）' : ''}`); } }, icon, withLabel ? label : null);
  function sync() {
    const t = prefs.get('theme', 'auto'); icon.replaceChildren(themeSvg(t)); label.textContent = `画面の色: ${themeName(t)}`;
    const tip = `画面の色: ${themeName(t)}（押すと${themeName(nextTheme(t))}に）`; b.setAttribute('aria-label', tip); b.title = tip; b.dataset.theme = t;
  }
  sync(); return b;
}

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
  ctx2d(c).drawImage(src, 0, 0, w, hgt);
  return c;
}
/** 高画質で縮める（一度に半分より小さくすると細部がつぶれるので、半分ずつ段階的に） */
function shrink(src, w, hgt) {
  let cur = src; let cw = src.width; let ch = src.height;
  do {
    const nw = Math.max(w, Math.round(cw / 2)); const nh = Math.max(hgt, Math.round(ch / 2));
    const c = document.createElement('canvas'); c.width = nw; c.height = nh;
    const ctx = ctx2d(c); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    if (cur !== src) { cur.width = 0; cur.height = 0; } // 途中の Canvas のメモリをすぐ返す
    cur = c; cw = nw; ch = nh;
  } while (cw !== w || ch !== hgt);
  return cur;
}
/**
 * 写真一覧の見本。一覧は正方形に切り取って大きく（スマホの 1 列なら画面の幅いっぱい）出すので、
 * 短い辺を 1080px にして、高解像度の画面でもぼやけないように
 */
const THUMB_SHORT = 720; const THUMB_LONG = 1440; const THUMB_V = 2;
const thumbScale = (w, hgt) => Math.min(1, THUMB_SHORT / Math.min(w, hgt), THUMB_LONG / Math.max(w, hgt));
async function thumbBlob(src) {
  const s = thumbScale(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * s)); const hgt = Math.max(1, Math.round(src.height * s));
  const c = s < 1 ? shrink(src, w, hgt) : toCanvas(src, w, hgt);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}
const isImage = (f) => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i.test(f.name || '') || isRawName(f.name));
const ACCEPT = 'image/*,.dng,.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.pef,.srw,.3fr,.fff,.iiq,.erf,.mef,.mos,.kdc,.dcr,.x3f,.tif,.tiff';

/** 向き（Exif の Orientation）に合わせて回した Canvas を作る */
function orientCanvas(img, o) {
  if (!o || o === 1) return img;
  const w = img.width; const hgt = img.height; const swap = o >= 5;
  const c = document.createElement('canvas'); c.width = swap ? hgt : w; c.height = swap ? w : hgt;
  const x = ctx2d(c);
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
  // キヤノン・ニコン・ソニーなどは LibRaw で RAW データから現像する（編集中は半分の大きさ。書き出しで元の大きさに）。
  // 現像できないとき（対応していない機種・メモリ不足など）は、これまでどおりカメラが入れた JPEG を使う
  if (LIBRAW_RE.test(name || '')) {
    try {
      const r = await decodeLibRaw(buffer, { half: true });
      prepareLin(r.lin, r.fullW);
      return { image: developToCanvas(r.lin, S.defaultState().raw), lin: r.lin, info: { kind: 'libraw', format: (name.match(/\.([^.]+)$/)?.[1] || '').toUpperCase(), model: r.model, fullW: r.fullW, fullH: r.fullH } };
    } catch (e) { console.warn('LibRaw で現像できなかったので、カメラの JPEG を使います', e); }
  }
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
      const { image: bmp, info } = await decodeAny(f, f.name); // RAW（LibRaw）は半分の大きさで現像したもの
      const id = uid();
      const exif = raw ? readTiffExif(await f.slice(0, 4 * 1024 * 1024).arrayBuffer()) : /jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name) ? readExif(await f.slice(0, 512 * 1024).arrayBuffer()) : null;
      await db.addProject({ id, name: (f.name || '写真').replace(/\.[^.]+$/, '').slice(0, 80) || '写真', fileName: (f.name || '').slice(0, 200), raw: info, created: Date.now(), updated: Date.now(), w: info?.fullW || bmp.width, h: info?.fullH || bmp.height, size: f.size, type: f.type || (raw ? 'image/x-raw' : ''), exif, state: S.defaultState(), thumb: await thumbBlob(bmp), thumbV: THUMB_V }, f);
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
async function prepare(proj, blob, maxTex, { keepFull = false } = {}) {
  const d = await decodeAny(blob, proj.fileName, proj);
  let bmp = d.image;
  // RAW（LibRaw）: 保存してある「RAW の露出」で現像し直す。16bit のデータは、露出を変えたときのために残す
  if (d.lin) bmp = developToCanvas(d.lin, S.validateState(proj.state).raw, bmp);
  const ws = workSize(bmp.width, bmp.height, maxTex);
  let base = bmp;
  if (ws.w !== bmp.width || ws.h !== bmp.height) {
    // createImageBitmap の縮小は、ブラウザによっては画質の指定が効かず粗くなるので、Canvas で高画質に縮める
    base = shrink(bmp, ws.w, ws.h);
    if (!keepFull) bmp.close?.();
  }
  // keepFull: 元の大きさで書き出すために、縮める前の写真も返す
  return { base, W: ws.w, H: ws.h, scaled: ws.scaled || !!d.lin, origW: proj.w, origH: proj.h, lin: d.lin && ws.w === bmp.width ? d.lin : null, full: keepFull && !d.lin ? bmp : null };
}

/** 修復・モザイクと美肌を元写真の画素に当てる（美肌が先。あとから足す修復は、美肌の後の画素にそのまま重ねられる） */
function retouchCanvas(base, ops, portrait, cache) {
  const c = toCanvas(base, base.width, base.height);
  if (!ops.length && !portraitActive(portrait)) return { canvas: c, data: null };
  const ctx = ctx2d(c, { willReadFrequently: true });
  let data;
  if (!portraitActive(portrait)) data = ctx.getImageData(0, 0, c.width, c.height);
  else {
    // 美肌は重いので、同じ強さなら前の結果を使い回す（修復の取り消しなどで計算し直さない）
    const key = JSON.stringify(portrait);
    if (cache?.key !== key) {
      const pd = ctx.getImageData(0, 0, c.width, c.height); applyPortrait(pd, portrait);
      if (cache) { cache.key = key; cache.data = pd; }
      data = cache ? imageData(new Uint8ClampedArray(pd.data), pd.width, pd.height) : pd;
    } else data = imageData(new Uint8ClampedArray(cache.data.data), cache.data.width, cache.data.height);
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
    const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, mw, mh).data;
    for (let i = 0; i < mw * mh; i++) out.data[i * 4 + ch] = d[i * 4 + 3];
  });
  return out;
}
function brushCanvas(l, mw, mh, cache) {
  const key = `${l.id}:${mw}x${mh}`;
  let ent = cache.get(key);
  if (!ent) { const c = document.createElement('canvas'); c.width = mw; c.height = mh; ent = { c, n: 0 }; cache.set(key, ent); }
  if (ent.n > l.strokes.length) { ctx2d(ent.c).clearRect(0, 0, mw, mh); ent.n = 0; }
  const ctx = ctx2d(ent.c);
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
let libGen = 0; // 一覧を作り直すたびに増やす（裏の見本の作り直しを止める目印）
async function showLibrary() {
  closeEditor();
  document.title = 'てもとフォト';
  libUrls.forEach((u) => URL.revokeObjectURL(u)); libUrls = [];
  const projects = await db.listProjects().catch(() => []);
  const fileIn = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'vh', id: 'open-file', onchange: () => { importFiles(fileIn.files); fileIn.value = ''; } });
  const gen = ++libGen; const thumbImgs = new Map();
  const sel = () => projects.filter((p) => selecting.has(p.id));
  const bar = h('div', { class: 'lib-actions', role: 'toolbar', 'aria-label': '選んだ写真の操作' });
  const drawBar = () => {
    render(bar, selecting.size ? [
      h('span', { class: 'muted' }, `${selecting.size}枚を選択中`),
      h('button', { type: 'button', class: 'primary', disabled: selecting.size < 2 || selecting.size > MAX_GRID, title: selecting.size > MAX_GRID ? `グリッドは${MAX_GRID}枚まで` : '', onclick: () => showGrid(sel()) }, `▦ グリッドを作る${selecting.size > MAX_GRID ? `（${MAX_GRID}枚まで）` : ''}`),
      h('button', { type: 'button', onclick: () => openExport({ batch: sel() }) }, 'まとめて書き出し'),
      h('button', { type: 'button', disabled: !prefs.get('clip', null), onclick: async () => { const clip = prefs.get('clip', null); for (const p of sel()) await db.putProject({ ...p, state: S.applyPreset(S.validateState(p.state), clip), updated: Date.now() }); toast('編集を貼り付けました'); selecting.clear(); showLibrary(); } }, '編集を貼り付け'),
      h('button', { type: 'button', class: 'danger', onclick: () => confirmBox(`${selecting.size}枚の写真と編集内容を、この端末から削除します。元に戻せません。`, '削除する', async () => { for (const p of sel()) await db.deleteProject(p.id); selecting.clear(); showLibrary(); }) }, '削除'),
      h('button', { type: 'button', class: 'ghost', onclick: () => { selecting.clear(); showLibrary(); } }, '選択をやめる'),] : null);
  };
  drawBar();
  const grid = h('ul', { class: 'lib-grid' }, projects.map((p) => {
    const url = p.thumb ? URL.createObjectURL(p.thumb) : ''; if (url) libUrls.push(url);
    const img = url ? h('img', { src: url, alt: '', loading: 'lazy' }) : null; if (img) thumbImgs.set(p.id, img);
    const edited = S.isEdited(S.validateState(p.state));
    let li;
    const check = h('input', { type: 'checkbox', class: 'lib-check', checked: selecting.has(p.id), 'aria-label': `${p.name}を選択`, onchange: (e) => { if (e.target.checked) selecting.add(p.id); else selecting.delete(p.id); li.classList.toggle('selected', e.target.checked); drawBar(); grid.classList.toggle('selecting', selecting.size > 0); } });
    // 写真を小さく敷き詰める。選ぶ丸は写真の右上（写真の中で選べる）。名前と大きさは、長押しの説明と読み上げに
    li = h('li', { class: `lib-item${selecting.has(p.id) ? ' selected' : ''}`, title: `${p.name}（${p.w}×${p.h}）` },
      h('button', { type: 'button', class: 'lib-open', onclick: () => (selecting.size ? check.click() : openEditor(p.id)), 'aria-label': `${p.name}を編集` },
        img || h('span', { class: 'lib-noimg' }, '?'),
        edited ? h('span', { class: 'lib-badge', title: '編集済み' }, h('span', { 'aria-hidden': 'true' }, '✎'), h('span', { class: 'vh' }, '編集済み')) : null,
        p.raw ? h('span', { class: 'lib-badge raw' }, 'RAW') : null,
        h('span', { class: 'lib-name vh' }, p.name)),
      h('label', { class: 'lib-pick' }, check));
    return li;
  }));
  if (selecting.size) grid.classList.add('selecting');
  const usage = h('p', { class: 'muted small' });
  db.usage().then((u) => { if (u) usage.textContent = `この端末で使っている容量: ${fmtBytes(u.used)}${u.quota ? `（上限の目安 ${fmtBytes(u.quota)}）` : ''}`; });
  render(app,
    h('header', { class: `lib-head${projects.length ? ' compact' : ''}` },
      h('h1', {}, h('span', { class: 'logo', 'aria-hidden': 'true' }), 'てもとフォト'),
      h('p', { class: 'lib-lead' }, '写真を端末の外に出さずに編集。アップロードもアカウントも不要で、オフラインでも動きます。'),
      themeButton()),
    h('main', { class: 'lib-main' },
      h('label', { class: `drop${projects.length ? ' compact' : ''}`, for: 'open-file', id: 'drop' },
        h('span', { class: 'drop-icon', 'aria-hidden': 'true' }, '＋'),
        h('b', {}, '写真を開く'),
        h('span', { class: 'muted small' }, 'タップして選ぶ・ドラッグ＆ドロップ・貼り付け（複数可）')),
      fileIn,
      h('div', { id: 'install-slot' }, installCard()),
      projects.length ? h('div', { class: 'lib-bar' }, h('h2', {}, `写真（${projects.length}）`), h('button', { type: 'button', class: 'ghost small', onclick: () => { projects.forEach((p) => selecting.add(p.id)); showLibrary(); } }, 'すべて選択')) : null,
      bar,
      projects.length ? grid : h('div', { class: 'lib-empty' },
        h('h2', {}, 'できること'),
        h('ul', { class: 'feature-list' }, [
          '暗い舞台の写真を、ノイズを取ってから明るく（開くと自動でおすすめします）',
          '動いた手・髪のブレを AI でくっきり（端末の中で計算）',
          '美肌、顔の仕上げ（歯を白く・リップ・鼻筋・目線をカメラへ）はタップするだけ',
          'キヤノンなどの RAW を、RAW データから高画質に現像',
          'フィルター27種（成人式・振袖向け、フィルム風・モノクロなど）と強さの調整、自動補正',
          'スポット修復、顔やナンバーを隠すモザイク・ぼかし、L判・2L判の切り抜き',
          'フレーム・余白（SNS の比率に合わせる）',
          '複数の写真を1枚にまとめるグリッド（2〜9枚）',
          '編集はいつでもやり直せる（元の写真はそのまま）',
          '書き出すと位置情報などのメタデータは消える。写真アプリにも直接保存できる',
        ].map((t) => h('li', {}, t))),
        h('h3', {}, 'スペシャリストモードで使える道具'),
        h('p', { class: 'muted small' }, '編集画面の「⋯」メニューでオンにすると出てきます。'),
        h('ul', { class: 'feature-list' }, [
          '明るさ・色・トーンカーブ・HSL・カラーグレーディング・ディテール・効果',
          '部分補正（ブラシ・グラデーション・色域・明るさの範囲）',
        ].map((t) => h('li', {}, t)))),
      h('section', { class: 'privacy' },
        h('h2', {}, '写真はこの端末から出ません'),
        h('p', {}, 'このページは外部への通信を一切しない設定（CSP: connect-src \'none\'）で動いています。写真と編集内容はこの端末のブラウザの中（IndexedDB）だけに保存されます。'),
        usage)));
  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); importFiles(e.dataTransfer.files); });
  upgradeThumbs(projects.filter((p) => (p.thumbV || 1) < THUMB_V), thumbImgs, gen);
}
/** 前の版で作った小さい見本を、編集を当てたまま高画質に作り直す（一覧を開いている間に、1 枚ずつ裏で） */
async function upgradeThumbs(list, imgs, gen) {
  for (const p of list) {
    await new Promise((r) => setTimeout(r, 120));
    if (gen !== libGen || E || GR) return; // 一覧を離れたらやめる
    try {
      const blob = await db.getBlob(p.id); if (!blob) continue;
      const prep = await prepare(p, blob, THUMB_LONG);
      if (gen !== libGen || E || GR) { prep.base.close?.(); return; }
      const state = S.validateState(p.state);
      const c = renderToCanvas({ base: prep.base, W: prep.W, H: prep.H, state }, { maxSide: 0 });
      prep.base.close?.();
      const thumb = await thumbBlob(c); c.width = 0; c.height = 0;
      if (!thumb) continue;
      const cur = await db.getProject(p.id); if (!cur) continue;
      await db.putProject({ ...cur, thumb, thumbV: THUMB_V });
      const img = imgs.get(p.id);
      if (img && gen === libGen) { const url = URL.createObjectURL(thumb); libUrls.push(url); img.src = url; }
    } catch (e) { console.warn('見本を作り直せませんでした', p.name, e); }
  }
}

// ── アプリとして入れる（パソコンの Chrome・Edge、Android）。入れると自分の窓で開き、写真を右クリック →「プログラムから開く」でも開ける ──
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; const slot = $('#install-slot'); if (slot) render(slot, installCard()); });
addEventListener('appinstalled', () => { installEvt = null; const slot = $('#install-slot'); if (slot) render(slot, null); toast('アプリとして入れました。デスクトップ・スタートメニューのアイコンから開けます', 5000); });
function installCard() {
  if (!installEvt || prefs.get('installHidden', false)) return null;
  return h('div', { class: 'install-card' },
    h('div', {}, h('b', {}, 'アプリとして入れる'), h('p', { class: 'muted small' }, 'デスクトップ・スタートメニュー（スマホはホーム画面）から、自分の窓で開けます。オフラインでも使え、写真を右クリック →「プログラムから開く」でも開けます。')),
    h('button', { type: 'button', class: 'primary', onclick: async () => { const e = installEvt; if (!e) return; installEvt = null; render($('#install-slot'), null); await e.prompt().catch(() => {}); } }, '入れる'),
    h('button', { type: 'button', class: 'ghost icon', 'aria-label': 'このお知らせを出さない', title: 'このお知らせを出さない（ブラウザのメニューからも入れられます）', onclick: () => { prefs.set('installHidden', true); render($('#install-slot'), null); } }, '✕'));
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
  E.hq?.ctrl?.abort(); clearTimeout(hqTimer);
  E.engine?.dispose(); E.thumbEngine?.dispose();
  E.base?.close?.();
  document.removeEventListener('pointerdown', E.closeMenu); E.offPointer?.();
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
    id, proj, engine, glCanvas, state, committed: S.clone(state), undo: [], redo: [], tool: ((t) => (shownTools(!!p.lin).includes(t) ? t : shownTools(!!p.lin)[0]))(prefs.get('tool', 'looks')), // 前に選んでいたタブ（なくなった・隠したタブ、RAW 以外での RAW タブは、見せている最初の道具に）
    base: p.base, W: p.W, H: p.H, scaled: p.scaled, rawLin: p.lin, src: null, srcData: null, maskCache: new Map(), skinCache: {},
    sel: null, showOriginal: false, showMask: false, zoom: 1, pan: [0, 0], raf: 0, L: null, hist: null,
  };
  buildEditor();
  rebuildSource(); rebuildMask();
  addEventListener('keydown', onKey); addEventListener('keyup', onKeyUp); addEventListener('resize', requestRender);
  requestRender();
  suggestDark();
  if (p.lin) toast(`RAW データから現像しました。編集中は ${p.W}×${p.H} で表示し、書き出しで元の大きさ（${p.origW}×${p.origH}）に現像し直します`, 5000);
  // 大きな写真のお知らせは、はじめての 1 回だけ（毎回出ると、道具の列を 5 秒ふさぐ。「情報」でいつでも見られる）
  else if (p.scaled && !prefs.get('scaledNote', false)) { prefs.set('scaledNote', true); toast(`写真が大きいので、編集中は ${p.W}×${p.H} に縮めて表示します。書き出しは元の大きさ（${p.origW}×${p.origH}）のままできます`, 5000); }
}

const sourceKey = (st) => JSON.stringify([st.retouch, st.portrait, st.raw]);
function rebuildSource() {
  const ops = E.state.retouch;
  // RAW の露出が変わったら、16bit のデータから現像し直す
  const rk = JSON.stringify({ ...E.state.raw, ca: null }); // 色にじみの補正は書き出しのときだけ
  if (E.rawLin && rk !== E.rawKey) {
    if (E.rawKey != null) { developToCanvas(E.rawLin, E.state.raw, E.base); E.baseData = null; E.skinCache = {}; E.hqCache = {}; }
    E.rawKey = rk;
  }
  const base = srcBase();
  // 元の写真と暗所補正したものを切り替えたら、美肌の計算と肌の判定に使う画素も作り直す（暗いままの写真で計算した美肌を残さない）
  if (E.srcBaseUsed !== base) { E.srcBaseUsed = base; E.baseData = null; E.skinCache = {}; }
  E.srcHQ = base !== E.base;
  if (!ops.length && !portraitActive(E.state.portrait)) { E.src = null; E.srcData = null; E.engine.setSource(base, E.W, E.H); }
  else { const r = retouchCanvas(base, ops, E.state.portrait, E.skinCache); E.src = r.canvas; E.srcData = r.data; E.engine.setSource(E.src, E.W, E.H); }
  E.engine.setResidual(E.srcHQ ? null : E.base.residual || null); // RAW は 16bit の細かさで（暗所補正を当てたものは 8bit）
  E.retouchKey = sourceKey(E.state);
  if (E.showSkin && E.tool === 'skin') E.engine.setSource(skinOverlaySource(), E.W, E.H);
  E.small = null; E.thumbsKey = null;
  if (portraitActive(E.state.portrait)) maybeSkinSeg();
}
// ───── 暗所補正（ノイズを取ってから明るくする）とブレ補正を、編集用の大きさの写真に裏で当てる ─────
// スライダーを動かしている間は GPU の簡易版で見せ、手を止めたら Worker で計算する（進捗は写真の上のバーに）。
// できたら、それを修復・美肌・GPU の調整の元にする（GPU の簡易版は二重にかけない）。
// 順番は「ノイズ除去 → 明るさ → ブレ補正 → 細かい粒」。途中の結果は取っておき、ブレ補正の強さだけを変えたときは AI を動かし直さない
const hqKey = (st) => (lowlightActive(st.adj) || deblurActive(st.adj) || faceaiActive(st) ? JSON.stringify([st.adj.noise, st.adj.lowlight, st.adj.deblur, E.rawKey, faceaiKey(st), st.faceai.amount]) : null);
function hqReady() { return !!E.hq?.canvas && E.hq.key === hqKey(E.state); }
/**
 * いま見せる、暗所補正・ブレ補正をした写真。ブレ補正の強さだけを変えて計算し直している間は、前にできたものを見せる
 * （暗所補正の値が同じなら、元の写真＋GPU の簡易版に戻さない）
 */
function hqView() {
  if (hqReady()) return E.hq.canvas;
  const key = hqKey(E.state); const last = E.hqLast;
  if (!key || !last) return null;
  const a = JSON.parse(key); const b = JSON.parse(last.key);
  return a[0] === b[0] && a[1] === b[1] && a[3] === b[3] ? last.canvas : null;
}
/** 修復・美肌・GPU の元にする写真 */
function srcBase() { return hqView() || E.base; }
/** ブレ補正の差分（AI の結果）。書き出しでも使う */
function hqResidual() { return hqReady() ? E.hq.res || null : null; }
/** 顔 AI の結果（顔ごと）。書き出しでも使う */
function hqFaces() { return hqReady() ? E.hq.faces || null : null; }
let hqTimer = 0;
function scheduleLowlight() {
  if (!E || (E.hq?.key ?? null) === hqKey(E.state)) return; // 済み・計算中
  clearTimeout(hqTimer); hqTimer = setTimeout(runLowlight, 400);
}
/**
 * 暗所補正・ブレ補正・顔 AI をした写真を作る（編集画面と、書き出しで編集中の結果がないときに使う）
 * @param {object} src { base, W, H, origW, origH, cache? }。cache に途中の結果を取っておく（{ ll: {key, canvas}, db: {key, res}, fa: {key, canvas, faces} }）
 * @returns {Promise<{canvas, res, faces}>} res: ブレ補正の差分（なければ null）、faces: 顔 AI の結果（なければ null）
 */
async function enhanceSource(src, adj, { signal, onProgress = () => {}, state = null } = {}) {
  const ll = lowlightActive(adj) ? lowlightOptions(adj) : null; const db = deblurActive(adj); const fa = !!state && faceaiActive(state);
  const cache = src.cache || {};
  // 粒はブレ補正の後に足す（ブレ補正があるときは、暗所補正では足さない）
  const llKey = ll ? JSON.stringify([adj.noise, adj.lowlight, db]) : null;
  const dbKey = JSON.stringify([adj.noise, adj.lowlight]);
  const faKey = fa ? JSON.stringify([llKey, db && dbKey, db && adj.deblur, faceaiKey(state), state.faceai.amount]) : null;
  if (fa && cache.fa?.key === faKey) { onProgress(1); return { canvas: cache.fa.canvas, res: db ? cache.db?.res || null : null, faces: cache.fa.faces }; }
  // 進捗の割合（暗所補正・ブレ補正・顔 AI）。済んでいるものは 0
  const w = [ll && cache.ll?.key !== llKey ? 0.3 : 0, db && cache.db?.key !== dbKey ? 0.6 : (db ? 0.05 : 0), fa ? 0.4 : 0];
  const tot = w[0] + w[1] + w[2] || 1; const at = (k, t) => onProgress((w.slice(0, k).reduce((a, b) => a + b, 0) + w[k] * t) / tot);
  let canvas = src.base;
  if (ll) {
    if (cache.ll?.key !== llKey) {
      cache.ll = null;
      let grain = 0;
      const c = await enhanceCanvas(src.base, src.W, src.H, { ...ll, grain: !db, fine: !db }, { signal, onProgress: (t) => at(0, t), onGrain: (g) => { grain = g; } });
      cache.ll = { key: llKey, canvas: c, grain };
    }
    canvas = cache.ll.canvas;
  }
  let res = null;
  if (db) {
    if (cache.db?.key !== dbKey) {
      cache.db = null;
      const r = await deblurResidualFor(canvas, src.W, src.H, src.origW, src.origH, { denoise: deblurDenoise(adj), signal, onProgress: (t) => at(1, t) });
      cache.db = { key: dbKey, res: r };
    }
    res = cache.db.res;
    canvas = await finishCanvas(canvas, src.W, src.H, { res, amount: deblurAmount(adj), grain: ll ? cache.ll.grain : 0 }, { signal });
  }
  if (!fa) { onProgress(1); return { canvas, res, faces: null }; }
  // 顔 AI（選んだ顔だけ。大まかな形と色・粒は変えない）
  const r = await applyFaceAI(canvas, src.W, src.H, state.faceai, { signal, onProgress: (t) => at(2, t) });
  cache.fa = { key: faKey, canvas: r.canvas, faces: r.faces };
  onProgress(1);
  return { canvas: r.canvas, res, faces: r.faces };
}
async function runLowlight() {
  if (!E) return;
  const key = hqKey(E.state);
  if ((E.hq?.key ?? null) === key) return;
  E.hq?.ctrl?.abort();
  if (!key) { E.hq = null; E.hqLast = null; hqBar(null); if (E.srcHQ) { rebuildSource(); requestRender(); } return; }
  const e0 = E; const ctrl = new AbortController();
  E.hq = { key, canvas: null, ctrl };
  E.hqCache ||= {};
  hqBar(0);
  try {
    const { canvas, res, faces } = await enhanceSource({ base: E.base, W: E.W, H: E.H, origW: E.proj.w || E.W, origH: E.proj.h || E.H, cache: E.hqCache }, E.state.adj, {
      state: E.state, signal: ctrl.signal, onProgress: (t) => { if (E === e0 && E.hq?.ctrl === ctrl) hqBar(t); },
    });
    if (E !== e0 || E.hq?.ctrl !== ctrl) return;
    E.hq = { key, canvas, res, faces, ctrl: null }; E.hqLast = { key, canvas }; hqBar(null);
    rebuildSource(); requestRender();
  } catch (err) {
    if (E !== e0 || E.hq?.ctrl !== ctrl) return;
    E.hq = { key, canvas: null, ctrl: null }; hqBar(null);
    if (err.name !== 'AbortError') { console.warn('暗所補正・ブレ補正・顔 AI', err); toast(faceaiActive(E.state) ? `顔 AI をできませんでした（${err.message}）` : deblurActive(E.state.adj) ? 'ブレ補正・ノイズ除去・明るさ補正をできませんでした' : 'ノイズ除去・明るさ補正をできませんでした。簡易版で表示しています'); }
  }
}
/** 写真の上の進捗バー（t: 0〜1、null で隠す） */
function hqBar(t) {
  if (!E?.hqEl) return;
  E.hqEl.hidden = t == null; if (t == null) return;
  const p = Math.min(99, Math.floor(t * 100));
  E.hqEl.querySelector('progress').value = p;
  E.hqEl.querySelector('span').textContent = `${[lowlightActive(E.state.adj) && 'ノイズ除去と明るさ補正', deblurActive(E.state.adj) && 'ブレ補正', faceaiActive(E.state) && '顔 AI'].filter(Boolean).join('・')}… 残り${100 - p}%`;
}
/** 編集用の大きさの元写真の画素（美肌の判定と、AI の肌の地図の指紋に使う） */
function baseImageData() {
  // 暗所補正ができていれば、補正したもの（美肌・リップの AI は、明るくした写真の方がよく見分ける）
  if (!E.baseData) E.baseData = ctx2d(toCanvas(srcBase(), E.W, E.H), { willReadFrequently: true }).getImageData(0, 0, E.W, E.H);
  return E.baseData;
}
/**
 * 美肌を使うとき、AI で人物の肌（顔・首・腕）を見分ける（はじめての 1 回は、AI の読み込みに少し時間がかかる）。
 * できたら美肌を計算し直す。使えない端末では、今までどおり色だけで判定する
 */
function maybeSkinSeg() {
  if (E.segBusy || E.segFailed) return;
  const bd = baseImageData(); if (skinSegFor(bd)) return;
  E.segBusy = true; E.stageEl.classList.add('busy', 'seg');
  const e0 = E;
  ensureSkinSeg(bd).then((ok) => {
    if (E !== e0) return;
    E.segBusy = false; E.stageEl.classList.remove('busy', 'seg');
    if (!ok) { E.segFailed = true; return; }
    E.skinCache = {}; rebuildSource(); requestRender();
  });
}
/** 修復を1つ足す（全部やり直さず、その場所だけ書き換える） */
function addRetouch(op) {
  if (E.state.retouch.length >= S.MAX_RETOUCH) { toast('修復・モザイクは300個までです'); return; }
  E.state.retouch.push(op);
  if (!E.src) { const r = retouchCanvas(srcBase(), [], null); E.src = r.canvas; }
  const ctx = ctx2d(E.src, { willReadFrequently: true });
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
    ctx2d(c, { willReadFrequently: true }).drawImage(E.src || E.base, 0, 0, c.width, c.height);
    E.small = c;
  }
  return E.small;
}
function sampleSource(s, t, rad = 2) {
  const c = smallSource(); const ctx = ctx2d(c, { willReadFrequently: true });
  const x = Math.round(s * (c.width - 1)); const y = Math.round(t * (c.height - 1));
  const d = ctx.getImageData(Math.max(0, x - rad), Math.max(0, y - rad), rad * 2 + 1, rad * 2 + 1).data;
  let r = 0; let g = 0; let b = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return [r / n / 255, g / n / 255, b / n / 255];
}

/**
 * 暗い写真か（舞台・夜の室内など）。編集用の小さな写真で、明るさの真ん中と上の方（9 割の所）を見る。
 * 実写で: 舞台の写真（ISO1600）は真ん中 27〜68・9 割 33〜121、日中・日陰の写真は真ん中 78 以上か 9 割 151 以上
 */
function looksDark() {
  const c = smallSource(); const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const hist = new Uint32Array(256); const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++;
  const at = (q) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * q) return v; } return 255; };
  return at(0.5) < 72 && at(0.9) < 140;
}
/** 暗い写真のおすすめ（テスト写真 21 枚で確かめた値。ノイズ軽減 50・明るさ補正 50 が標準の強さ） */
const DARK_RECIPE = { lowlight: 50, noise: 50 };
function applyDarkRecipe() {
  Object.assign(E.state.adj, DARK_RECIPE); commit(); syncHistoryButtons(); requestRender();
  if (E.tool === 'auto') buildPanel();
  toast('ノイズを取ってから明るくしています。写真の上のバーが消えるまでお待ちください（「自動補正」のスライダーで強さを変えられます）', 5000);
}
/** 開いた写真が暗くて、まだ編集していなければ、写真の上に「明るくする」を出す */
function suggestDark() {
  if (S.isEdited(E.state) || !looksDark()) return;
  const close = () => box.remove();
  const box = h('div', { class: 'suggest', role: 'region', 'aria-label': 'おすすめ' },
    h('p', {}, h('b', {}, '暗い写真です。'), 'ノイズを取ってから明るくできます。'),
    h('div', { class: 'suggest-actions' },
      btn('✦ 明るくする', () => { close(); setTool('auto'); applyDarkRecipe(); }, 'primary small'),
      btn('そのまま', close, 'ghost small')));
  for (const ev of ['pointerdown', 'dblclick', 'wheel']) box.addEventListener(ev, (e) => e.stopPropagation()); // 写真の上の操作にしない
  E.suggestEl = box; E.stageEl.append(box);
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
  if (E.showOriginal) { clearTimeout(thumbTimer); thumbTimer = setTimeout(saveThumb, 2500); return; } // 編集前を表示中は、編集後に戻ってから
  const t = await thumbBlob(E.view);
  if (!E || !t) return;
  E.proj = { ...E.proj, thumb: t, thumbV: THUMB_V, state: S.clone(E.committed), updated: Date.now() };
  db.putProject(E.proj).catch(() => {});
}

// ── 描画 ──
function previewState() {
  const st = E.state;
  if (E.tool === 'crop') return { ...st, geo: { ...st.geo, crop: { x: 0, y: 0, w: 1, h: 1 } }, frame: S.defaultState().frame };
  return st;
}
/** 拡大・移動の見た目だけを変える（写真の描き直しはしない） */
function applyZoom() { E.wrap.style.transform = `translate(${E.pan[0]}px, ${E.pan[1]}px) scale(${E.zoom})`; if (E.zoomLabel) E.zoomLabel.textContent = `${Math.round(E.zoom * 100)}%`; }
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
  const pad = stage.width >= 700 ? 80 : 20; // スマホは余白を少なく、写真を大きく（切り抜きの角の印が収まるぶんだけ） // 広い画面では、Canva のように写真のまわりに余白をとる
  const fit0 = Math.min((stage.width - pad) * dpr / cw, (stage.height - pad) * dpr / ch, PREVIEW_MAX / Math.max(cw, ch), 1);
  // 拡大中は、拡大したぶん細かく描く（引き伸ばすとぼやけるので）。元写真の画素数と GPU の上限まで
  const zk = Math.max(1, Math.min(E.zoom, 1 / fit0, Math.min(ZOOM_MAX, E.engine.maxSize) / (Math.max(cw, ch) * fit0)));
  const k = zk * (E.fast ? 0.5 : 1); // 画面上の大きさは変えず、描く細かさだけを変える
  const fit = fit0 * k;
  const pw = Math.max(1, Math.round(out.w * fit)); const ph = Math.max(1, Math.round(out.h * fit));
  if (!orig && srcBase() !== E.srcBaseUsed) rebuildSource(); // 暗所補正の値が変わったら、計算し直すまで元の写真＋簡易版で
  const eff = effective(!orig && hqView() ? withoutLowlight(st) : st);
  const showMask = E.tool === 'local' && E.showMask && E.sel ? st.locals.findIndex((l) => l.id === E.sel) : -1;
  if (E.maskDirty) { E.mask = buildMask(E.state, E.W, E.H, E.maskCache); E.engine.setMask(E.mask); E.maskDirty = false; }
  E.engine.render(eff, pw, ph, { bypass: orig, showMask });
  E.L = compose(E.view, E.glCanvas, st);
  E.view.style.width = `${E.view.width / dpr / k}px`; E.view.style.height = `${E.view.height / dpr / k}px`;
  applyZoom();
  E.origBadge.hidden = !orig;
  drawHandles();
  scheduleHistogram();
  scheduleLowlight();
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
  const ctx = ctx2d(c); const w = c.width; const hh = c.height;
  ctx.clearRect(0, 0, w, hh);
  const max = Math.max(1, ...['r', 'g', 'b'].flatMap((k) => hist[k].slice(2, 254)));
  const dark = isDark();
  ctx.globalCompositeOperation = dark ? 'lighter' : 'multiply'; // 重なった所が、暗い画面では明るく・明るい画面では濃く
  for (const [k, col] of only ? [[only, dark ? 'rgba(200,200,210,.45)' : 'rgba(70,72,90,.35)']] : dark ? [['r', 'rgba(255,80,80,.55)'], ['g', 'rgba(80,220,120,.5)'], ['b', 'rgba(90,140,255,.6)']] : [['r', 'rgba(229,72,77,.45)'], ['g', 'rgba(47,158,91,.45)'], ['b', 'rgba(59,111,224,.5)']]) {
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
  E.hqEl = h('div', { class: 'hq-status', role: 'status', hidden: true }, h('span', {}), h('progress', { max: 100, value: 0, 'aria-label': '暗い写真の補正の進捗' }));
  E.stageEl = h('div', { class: 'stage', tabindex: '-1' }, E.wrap, E.origBadge, E.hqEl);
  setupPointer(E.stageEl);
  E.undoBtn = h('button', { type: 'button', class: 'icon', 'aria-label': '元に戻す（Ctrl+Z）', title: '元に戻す（Ctrl+Z）', onclick: undo }, '↶');
  E.redoBtn = h('button', { type: 'button', class: 'icon', 'aria-label': 'やり直す（Ctrl+Shift+Z）', title: 'やり直す（Ctrl+Shift+Z）', onclick: redo }, '↷');
  const CMP_LABEL = '編集前を表示（タップで切り替え・押している間だけでも・\\ キー）';
  const cmp = h('button', { type: 'button', class: 'icon', 'aria-label': CMP_LABEL, title: CMP_LABEL, 'aria-pressed': 'false' }, '◧');
  const setOrig = (v) => { if (!E || E.showOriginal === v) return; E.showOriginal = v; cmp.setAttribute('aria-pressed', String(v)); requestRender(); };
  // さっとタップしたら、編集前の表示を切り替える（もう一度タップで戻る）。長押しは、押している間だけ編集前
  let press = null;
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); press = { t: performance.now(), was: !!E?.showOriginal }; setOrig(true); });
  cmp.addEventListener('pointerup', () => { if (!press) return; const tap = performance.now() - press.t < 350; setOrig(tap ? !press.was : false); press = null; });
  for (const ev of ['pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => { if (press) { setOrig(press.was); press = null; } });
  cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setOrig(true); } });
  cmp.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setOrig(false); });
  E.setOrig = setOrig;
  const menu = h('details', { class: 'menu' }, h('summary', { 'aria-label': 'そのほかの操作', title: 'そのほかの操作' }, '⋯'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', onclick: (e) => { prefs.set('clip', S.presetPart(E.state)); toast('編集をコピーしました（写真一覧で別の写真に貼り付けられます）'); } }, '編集をコピー'),
      h('button', { type: 'button', onclick: (e) => { const c = prefs.get('clip', null); if (!c) { toast('コピーした編集がありません'); return; } E.state = S.applyPreset(E.state, c); commit(); buildPanel(); requestRender(); } }, '編集を貼り付け'),
      h('button', { type: 'button', onclick: async () => { const blob = await db.getBlob(E.id); const id = uid(); await db.addProject({ ...E.proj, id, name: `${E.proj.name}（コピー）`, created: Date.now(), updated: Date.now(), state: S.clone(E.committed) }, blob); toast('複製しました'); openEditor(id); } }, '複製して別の編集を作る'),
      h('div', { class: 'menu-mode' }, toggle('スペシャリストモード（隠した道具も全部出す）', specialist(), (v) => {
        prefs.set('specialist', v); menu.open = false; buildRail(); const sh = shownTools(!!E.rawLin); setTool(sh.includes(E.tool) ? E.tool : sh[0], { keepSide: true });
        toast(v ? 'スペシャリストモード: すべての道具を表示します' : 'スペシャリストモードを終了しました');
      }).el),
      h('button', { type: 'button', onclick: openToolPicker }, '表示する道具を選ぶ…'),
      themeButton({ withLabel: true }),
      h('button', { type: 'button', class: 'danger', onclick: () => confirmBox('すべての編集を消して、元の写真に戻します。', 'リセット', () => { E.state = S.defaultState(); E.sel = null; rebuildSource(); E.maskCache.clear(); rebuildMask(); commit(); buildPanel(); requestRender(); }) }, 'すべての編集をリセット')));
  // 項目を選んだら・外側を押したらメニューを閉じる
  menu.addEventListener('click', (e) => { if (e.target.closest('.menu-list button')) menu.open = false; });
  E.closeMenu = (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; };
  document.addEventListener('pointerdown', E.closeMenu);
  E.panel = h('div', { class: 'panel', role: 'tabpanel', id: 'panel' });
  E.sideHead = h('div', { class: 'side-head' });
  E.side = h('aside', { class: 'side', id: 'side', 'aria-label': '道具の設定' }, E.sideHead, E.panel);
  E.tabs = h('nav', { class: 'tabs rail', role: 'tablist', 'aria-label': 'ツール', 'aria-orientation': 'vertical' });
  buildRail();
  // 表示の拡大・縮小（Canva の右下のように）
  E.zoomLabel = h('button', { type: 'button', class: 'zoom-val', title: '画面に合わせる（0 キー）', 'aria-label': '表示の大きさ（押すと画面に合わせる）', onclick: () => setZoom(1) }, '100%');
  const zoomBar = h('div', { class: 'zoom', role: 'group', 'aria-label': '表示の大きさ' },
    h('button', { type: 'button', 'aria-label': '縮小', title: '縮小', onclick: () => setZoom(E.zoom / 1.25) }, '−'), E.zoomLabel,
    h('button', { type: 'button', 'aria-label': '拡大', title: '拡大', onclick: () => setZoom(E.zoom * 1.25) }, '＋'));
  for (const ev of ['pointerdown', 'dblclick', 'wheel']) zoomBar.addEventListener(ev, (e) => e.stopPropagation()); // 写真の上の操作（切り抜き・修復など）にしない
  E.stageEl.append(zoomBar);
  E.root = h('div', { class: 'editor' },
    h('header', { class: 'ed-head' },
      h('button', { type: 'button', class: 'back', 'aria-label': '‹ 写真', title: '写真の一覧に戻る', onclick: showLibrary }, '‹'),
      h('div', { class: 'ed-hist' }, E.undoBtn, E.redoBtn),
      h('span', { class: 'ed-title' }, E.proj.name),
      h('div', { class: 'ed-tools' }, cmp, menu,
        h('button', { type: 'button', class: 'primary export', onclick: () => openExport({}) }, '書き出し'))),
    E.tabs, E.side, E.stageEl);
  // 編集前を表示したまま、ほかの所（写真・パネル・道具）を触ったら、編集後の表示に戻す
  E.root.addEventListener('pointerdown', (e) => { if (E?.showOriginal && !press && !cmp.contains(e.target)) setOrig(false); }, true);
  E.root.addEventListener('input', () => { if (E?.showOriginal) setOrig(false); }, true);
  render(app, E.root);
  syncHistoryButtons(); setTool(E.tool, { keepSide: true });
}
function tabKeys(e) {
  const tabs = [...e.currentTarget.parentElement.children]; const i = tabs.indexOf(e.currentTarget);
  const next = ['ArrowRight', 'ArrowDown'].includes(e.key); const prev = ['ArrowLeft', 'ArrowUp'].includes(e.key);
  const j = next ? i + 1 : prev ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
  if (j == null) return;
  e.preventDefault(); const t = tabs[(j + tabs.length) % tabs.length]; t.focus(); t.click();
}
/** 道具の列（見せている道具のグループだけ） */
function buildRail() {
  render(E.tabs, shownGroups(!!E.rawLin).map(([g, icon, label]) => h('button', {
    type: 'button', role: 'tab', id: `tab-${g}`, 'aria-controls': 'side', 'aria-selected': 'false', tabindex: '-1',
    onclick: () => pickGroup(g), onkeydown: tabKeys,
  }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'tab-label' }, label))));
}
/** 左の列でグループを選ぶ。選んでいるグループをもう一度押すと、パネルを閉じて写真を広く見せる */
function pickGroup(g) {
  if (groupOf(E.tool)[0] === g && E.sideOpen) { setSide(false); return; }
  const tools = shownGroups(!!E.rawLin).find((x) => x[0] === g)[3];
  setTool(E.lastTool?.[g] && tools.includes(E.lastTool[g]) ? E.lastTool[g] : tools[0]);
}
function setSide(open) {
  E.sideOpen = open; E.root.classList.toggle('side-closed', !open);
  for (const b of E.tabs.children) b.setAttribute('aria-expanded', String(open && b.getAttribute('aria-selected') === 'true'));
  requestRender();
}
function setZoom(z) {
  E.zoom = Math.min(8, Math.max(1, z)); if (E.zoom === 1) E.pan = [0, 0];
  requestRender();
}
/** 表示する道具を選ぶ（チェックを外した道具は列・タブから隠す。編集はそのまま残る） */
function openToolPicker() {
  const hid = new Set(hiddenTools());
  const boxes = [];
  const save = () => {
    const next = TOOLS.filter((t) => hid.has(t));
    if (TOOLS.filter((t) => t !== 'raw').every((t) => hid.has(t))) { toast('道具を1つは表示してください'); return false; }
    prefs.set('hiddenTools', next); return true;
  };
  const dlg = h('dialog', { class: 'dlg tool-picker', 'aria-labelledby': 'tp-h' },
    h('h2', { id: 'tp-h' }, '表示する道具を選ぶ'),
    h('p', { class: 'hint' }, 'チェックを外した道具は、道具の列とタブに出しません。隠しても、写真に当てた編集はそのまま残ります。スペシャリストモードの間は、すべての道具を出します。'),
    h('div', { class: 'tp-groups' }, GROUPS.map(([g, icon, label, tools]) => h('fieldset', { class: 'tp-group' },
      h('legend', {}, h('span', { 'aria-hidden': 'true' }, `${icon} `), label, g === 'raw' ? h('span', { class: 'muted small' }, '（RAW を開いたとき）') : null),
      h('div', { class: 'tp-tools' }, tools.map((t) => { const tg = toggle(TOOL_LABEL[t], !hid.has(t), (v) => { if (v) hid.delete(t); else hid.add(t); }); boxes.push(tg); return tg.el; }))))),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'ghost', onclick: () => { hid.clear(); for (const b of boxes) b.input.checked = true; } }, 'すべて表示'),
      h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'やめる'),
      h('button', { type: 'button', class: 'primary', onclick: () => { if (!save()) return; dlg.close(); if (!E) return; buildRail(); setTool(shownTools(!!E.rawLin).includes(E.tool) ? E.tool : shownTools(!!E.rawLin)[0], { keepSide: true }); } }, '決定')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
function syncHistoryButtons() { if (!E) return; E.undoBtn.disabled = !E.undo.length && S.sameState(E.state, E.committed); E.redoBtn.disabled = !E.redo.length; }
function setTool(k, { keepSide = false } = {}) {
  if (E.tool === 'crop' && k !== 'crop') commit();
  if (E.tool === 'skin' && k !== 'skin' && E.showSkin) { E.showSkin = false; rebuildSource(); }
  E.tool = k; prefs.set('tool', k);
  const [g, , glabel] = groupOf(k); const tools = shownGroups(!!E.rawLin).find((x) => x[0] === g)?.[3] || [k];
  (E.lastTool ||= {})[g] = k;
  for (const b of E.tabs.children) { const on = b.id === `tab-${g}`; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  // パネルの見出し（グループ名・中の道具のタブ・閉じるボタン）
  render(E.sideHead,
    h('div', { class: 'side-title' }, h('h2', {}, glabel),
      h('button', { type: 'button', class: 'side-close', 'aria-label': 'パネルを閉じる', title: 'パネルを閉じる（写真を広く表示）', onclick: () => setSide(false) }, '✕')),
    tools.length > 1 ? h('div', { class: 'subtabs', role: 'tablist', 'aria-label': `${glabel}の道具` }, tools.map((t) => h('button', {
      type: 'button', role: 'tab', id: `tab-${t}`, 'aria-controls': 'panel', 'aria-selected': String(t === k), tabindex: t === k ? '0' : '-1',
      onclick: () => setTool(t), onkeydown: tabKeys,
    }, TOOL_LABEL[t]))) : null);
  E.panel.setAttribute('aria-label', TOOL_LABEL[k]);
  if (!keepSide || E.sideOpen === undefined) setSide(true);
  E.wbPick = false; E.colorPick = false;
  buildPanel(); requestRender();
  E.tabs.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  E.sideHead.querySelector('.subtabs [aria-selected="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  scrollHint(E.sideHead.querySelector('.subtabs')); scrollHint(E.tabs);
}
/** 横にはみ出した列（スマホのタブ・道具の列）は、続きがあることがわかるように右端を薄くする */
function scrollHint(el) {
  if (!el) return;
  const upd = () => el.classList.toggle('more', el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  if (!el.dataset.hint) { el.dataset.hint = '1'; el.addEventListener('scroll', upd, { passive: true }); globalThis.ResizeObserver && new ResizeObserver(upd).observe(el); }
  requestAnimationFrame(upd);
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
/**
 * 説明文。スマホでは写真の下のパネルが低いので、長い説明は最初の 1 文だけ見せて、残りは「続き」で開く
 * （開いたかどうかは覚えておき、ほかの説明も同じにする）。パソコンの幅では全部見せる
 */
const narrow = matchMedia('(max-width: 599px)');
const hint = (t) => {
  const cut = t.indexOf('。') + 1;
  if (!narrow.matches || cut <= 0 || cut >= t.length - 8 || t.length < 70) return h('p', { class: 'hint' }, t);
  const d = h('details', { class: 'hint more-hint', open: prefs.get('hintsOpen', false) }, h('summary', {}, t.slice(0, cut), h('span', { class: 'hint-more' }, '続き')), h('span', {}, t.slice(cut)));
  d.addEventListener('toggle', () => prefs.set('hintsOpen', d.open));
  return d;
};
const row = (...k) => h('div', { class: 'btn-row' }, ...k);
const btn = (label, onclick, cls = '', title = null) => h('button', { type: 'button', class: cls, onclick, ...(title ? { title, 'aria-label': title } : {}) }, label);

const PANELS = {
  auto() {
    return [
      histo(),
      h('h3', {}, '暗い写真を明るく'),
      E.state.adj.lowlight === DARK_RECIPE.lowlight && E.state.adj.noise === DARK_RECIPE.noise ? null
        : row(btn('✦ おすすめの強さで明るくする', () => { E.suggestEl?.remove(); applyDarkRecipe(); }, 'primary')),
      slider({ label: '写真全体の明るさ補正', min: 0, max: 100, value: E.state.adj.lowlight, def: 0,
        onInput: live((v) => { E.state.adj.lowlight = v; }), onChange: commit }).el,
      slider({ label: 'ノイズ軽減', min: 0, max: 100, value: E.state.adj.noise, def: 0,
        onInput: live((v) => { E.state.adj.noise = v; }), onChange: commit }).el,
      hint('ノイズを先に取ってから、顔・腕・衣装・背景を一緒に明るくします。明るい部分と細かい模様は保ち、照明のオレンジは少しだけ白に戻します。スライダーから手を離すと、写真の上のバーの「残り○%」が 0 になるまで計算します（大きな写真は時間がかかります）。'),
      h('h3', {}, '動いた手・髪のブレを直す'),
      slider({ label: '被写体ブレの補正', min: 0, max: 100, value: E.state.adj.deblur, def: 0,
        onInput: live((v) => { E.state.adj.deblur = v; }), onChange: commit }).el,
      hint('シャッターが間に合わずにぶれた手・髪・顔を、端末の中の AI がくっきりさせます（写真は外に送りません）。平らな所（背景・肌）はそのままです。50 が標準の強さです。はじめて使うときに AI（約 65MB）を読み込み、大きな写真では計算に数分かかることがあります。暗くてざらついた写真は、ノイズ軽減も一緒に使うときれいに直ります。'),
      row(btn('✦ 自動補正', () => {
        const c = smallSource(); const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
        Object.assign(E.state.adj, autoAdjust(histogram(d), d)); commit(); requestRender(); toast('自動補正しました（各スライダーで調整できます）');
      }, 'primary big'), btn('明るさ・色をリセット', () => { const d = S.defaultState(); Object.assign(E.state, { adj: d.adj, hsl: d.hsl, grade: d.grade, curves: d.curves, look: d.look }); commit(); buildPanel(); requestRender(); })),
      hint('写真の明るさの分布と、白・灰色らしい所の色から、露光・白黒レベル・ホワイトバランスを整えます（電球の部屋の暖かさは残します）。気に入らなければ「元に戻す」で戻せます。'),
    ];
  },
  faceai() {
    const fa = E.state.faceai;
    const facesBox = h('div', { class: 'faceai-faces', 'aria-live': 'polite' }, h('p', { class: 'muted small' }, '写真の中の顔を探しています…'));
    const peopleBox = h('div', { class: 'faceai-people' });
    // 見つけた顔のうち、編集内容に入っているもの（なければ作る）
    const entry = (g, make) => {
      let f = fa.faces.find((q) => Math.hypot(q.x - g.x, q.y - g.y) < Math.max(g.w * 0.4, 0.01));
      if (!f && make) { f = { x: g.x, y: g.y, on: false, person: '' }; fa.faces.push(f); }
      return f;
    };
    const drawFaces = async () => {
      let dets;
      try { dets = await detectFaces(baseImageData()); } catch (e) { console.warn(e); render(facesBox, hint('顔を見つける AI を使えませんでした。')); return; }
      if (!E || E.tool !== 'faceai') return;
      const people = await loadPeople();
      if (!dets.length) { render(facesBox, hint('顔が見つかりませんでした（小さすぎる顔・横を向いた顔には使えません）。')); return; }
      const src = srcBase();
      render(facesBox, dets.slice(0, S.MAX_FACEAI).map((g, i) => {
        const f = entry(g, false);
        const on = h('input', { type: 'checkbox', id: `fa-on-${i}`, checked: !!f?.on, onchange: () => { entry(g, true).on = on.checked; commit(); requestRender(); } });
        const sel = h('select', { id: `fa-p-${i}`, 'aria-label': '本人の写真', onchange: async () => {
          if (sel.value === '+') {
            const list = await loadPeople(); const p = { id: uid(), name: `人${list.length + 1}`, refs: [] };
            await savePeople([...list, p]); Object.assign(entry(g, true), { person: p.id }); commit(); buildPanel(); return;
          }
          entry(g, true).person = sel.value; commit(); requestRender();
        } }, h('option', { value: '' }, '本人の写真なし'), people.map((p) => h('option', { value: p.id }, `${p.name}（${p.refs.length}枚）`)), h('option', { value: '+' }, '＋ 新しい人'));
        sel.value = f?.person && people.some((p) => p.id === f.person) ? f.person : '';
        return h('div', { class: 'faceai-face' }, faceThumb(src, E.W, E.H, g),
          h('div', { class: 'faceai-face-ctl' }, h('label', { for: `fa-on-${i}` }, on, ' 顔 AI を使う'), sel));
      }));
    };
    const drawPeople = async () => {
      const list = await loadPeople();
      if (!E || E.tool !== 'faceai') return;
      const save = async (next) => { await savePeople(next); commit(); requestRender(); drawPeople(); drawFaces(); };
      render(peopleBox, list.length ? list.map((p) => {
        const file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'vh', id: `fa-file-${p.id}` });
        file.addEventListener('change', async () => {
          const files = [...file.files]; file.value = ''; if (!files.length) return;
          E.stageEl.classList.add('busy');
          const add = [];
          try {
            for (const fl of files) {
              let cands; try { cands = await facesFromPhoto(fl); } catch (e) { console.warn(e); toast(`${fl.name} を読み込めませんでした`); continue; }
              if (!cands.length) { toast(`${fl.name} に顔が見つかりませんでした`); continue; }
              const pick = cands.length === 1 ? cands : await pickFaces(cands, fl.name);
              for (const c of pick) add.push({ id: uid(), crop: c.crop, pts: c.pts });
              for (const c of cands) URL.revokeObjectURL(c.url);
            }
          } finally { E?.stageEl.classList.remove('busy'); }
          // 読み込み中に別の写真を足したときも消えないよう、保存の直前の一覧に足す
          if (add.length) { await save((await loadPeople()).map((q) => (q.id === p.id ? { ...q, refs: [...q.refs, ...add].slice(-MAX_REFS) } : q))); toast(`${add.length}枚の顔を追加しました`); }
        });
        const name = h('input', { value: p.name, maxlength: 20, 'aria-label': '人の名前', onchange: () => save(list.map((q) => (q.id === p.id ? { ...q, name: name.value.trim().slice(0, 20) || q.name } : q))) });
        return h('div', { class: 'faceai-person' },
          h('div', { class: 'faceai-person-head' }, name, btn('この人を消す', (ev) => {
            const b = ev.currentTarget; if (b.dataset.armed) { save(list.filter((q) => q.id !== p.id)); return; }
            b.dataset.armed = '1'; b.textContent = 'もう一度押すと消えます'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'この人を消す'; }, 3000);
          }, 'small ghost')),
          h('div', { class: 'faceai-refs' }, p.refs.map((r) => {
            const url = URL.createObjectURL(r.crop);
            return h('span', { class: 'faceai-ref' }, h('img', { src: url, alt: '本人の写真', width: 64, height: 64, onload: () => URL.revokeObjectURL(url) }),
              h('button', { type: 'button', class: 'x', 'aria-label': 'この写真を外す', onclick: () => save(list.map((q) => (q.id === p.id ? { ...q, refs: q.refs.filter((x) => x.id !== r.id) } : q))) }, '×'));
          }),
          h('label', { for: `fa-file-${p.id}`, class: 'btn small' }, '＋ 写真を追加'), file));
      }) : hint('まだいません。上の顔の「本人の写真」で「＋ 新しい人」を選ぶと作れます。'));
    };
    drawFaces(); drawPeople();
    return [
      h('h3', {}, '暗い写真・ブレの大きい写真の顔を、明るい所で撮ったように'),
      hint('選んだ顔だけを、端末の中の顔専用 AI がくっきりさせます（目・まつげ・歯・鼻・輪郭）。顔の形と色は元の写真のまま、ティアラや背景には当てません。明るくはっきり写った写真には使わなくて大丈夫です（歯・目元の道具で十分です）。はじめて使うときに AI（約 170MB）を読み込みます。'),
      facesBox,
      slider({ label: '顔 AI の強さ', min: 0, max: 100, value: fa.amount, def: 100, unit: '%', onInput: live((v) => { fa.amount = v; }), onChange: commit }).el,
      h('h3', {}, '本人の写真'),
      hint(`その人が明るい所ではっきり写った写真を、できれば 10 枚以上（${MAX_REFS} 枚まで）追加してください。枚数が多いほど、表情や目線が合う写真が見つかりやすく、目元・歯並びが本人らしくなります（いろいろな表情・笑顔の写真があると効きます）。写真は端末の中に保存され、ほかの写真の顔にも選べます。`),
      peopleBox,
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
  raw() {
    // RAW（LibRaw）の現像。どれも 16bit のデータから現像し直す（少し時間がかかる）
    if (!E.rawLin) return [hint('RAW ファイルを開いたときに使えます。')];
    const redevelop = () => {
      E.stageEl.classList.add('busy');
      requestAnimationFrame(() => setTimeout(() => { if (!E) return; try { rebuildSource(); } finally { E.stageEl.classList.remove('busy'); } commit(); requestRender(); }, 0));
    };
    const sl = (k, label, o = {}) => slider({ label, value: E.state.raw[k], def: S.defaultState().raw[k], ...o, onChange: (v) => { E.state.raw[k] = o.toState ? o.toState(v) : v; redevelop(); } }).el;
    const signed = (v) => `${v > 0 ? '+' : ''}${v}`;
    return [
      histo(),
      sl('exposure', 'RAW の露出（白飛び・黒つぶれを戻す）', { min: -3, max: 3, step: 0.1, value: E.state.raw.exposure / 100, def: 0, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, toState: (v) => Math.round(v * 100) }),
      hint('RAW データから現像し直すので、「ライト」の露光量より画質が落ちません。白飛びした空や、暗く沈んだ髪の階調を戻したいときに。'),
      h('p', { class: 'sub-head' }, h('b', {}, 'ノイズとシャープ')),
      sl('nr', 'ノイズ除去', { min: 0, max: 100 }),
      sl('sharpen', 'シャープ（くっきり）', { min: 0, max: 100 }),
      hint('ノイズは写真ごとに量を測って、平らな所だけをならします（肌のきめ・髪・布の模様は残します）。暗い所は強めに。'),
      h('p', { class: 'sub-head' }, h('b', {}, 'レンズの補正')),
      toggle('色にじみを自動で直す（書き出しのとき）', E.state.raw.ca, (v) => { E.state.raw.ca = v; commit(); }).el,
      sl('vignette', '周辺の暗さを明るく', { min: -100, max: 100, format: signed }),
      sl('distortion', 'ゆがみ（＋で樽型・−で糸巻き型を直す）', { min: -100, max: 100, format: signed }),
      hint('色にじみ（輪郭の赤・青・紫の縁）は、元の大きさで書き出すときに写真から測って直します。広角で撮った建物の線がふくらむときは「ゆがみ」を＋に。'),
    ];
  },
  light() {
    return [histo(), ...adjSliders('light')];
  },
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
  shape() { return fxPanel('shape'); },
  eyes() { return fxPanel('eyes'); },
  dodge() { return fxPanel('dodge'); },
  wrinkle() { return fxPanel('wrinkle'); },
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
  const top = E.panel.scrollTop;
  render(E.panel, h('div', { class: `panel-inner panel-${E.tool}` }, PANELS[E.tool]()));
  E.panel.scrollTop = top;
  E.stageEl.dataset.tool = E.tool;
}

/** 本人の写真に顔が複数写っているとき、どれが本人かを選んでもらう。選んだものを返す */
function pickFaces(cands, name) {
  return new Promise((resolve) => {
    const chosen = new Set();
    const dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'pick-h' },
      h('h2', { id: 'pick-h' }, '本人の顔を選んでください'),
      h('p', { class: 'muted small' }, `${name} に ${cands.length} 人写っています。本人の顔を押してください（複数でも）。`),
      h('div', { class: 'faceai-pick' }, cands.map((c, i) => {
        const b = h('button', { type: 'button', class: 'faceai-pick-face', 'aria-pressed': 'false', 'aria-label': `${i + 1}人目`, onclick: () => { if (chosen.has(i)) chosen.delete(i); else chosen.add(i); b.setAttribute('aria-pressed', String(chosen.has(i))); } },
          h('img', { src: c.url, alt: '', width: 96, height: 96 }));
        return b;
      })),
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'この写真は使わない'),
        h('button', { type: 'button', class: 'primary', onclick: () => { dlg.returnValue = 'ok'; dlg.close(); } }, '決定')));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'ok' ? cands.filter((_, i) => chosen.has(i)) : []); });
    document.body.append(dlg); dlg.showModal();
  });
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
    ctx2d(c).drawImage(E.thumbEngine.canvas, (tw - 96) / 2, (th - 96) / 2, 96, 96, 0, 0, 96, 96);
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
  const color = (isDark() ? { rgb: '#e8e8e8', r: '#ff6b6b', g: '#5fd47e', b: '#6aa2ff' } : { rgb: '#30333a', r: '#e5484d', g: '#2f9e5b', b: '#3b6fe0' })[ch];
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
  baseImageData();
  const c = toCanvas(E.src || E.base, E.W, E.H); const ctx = ctx2d(c, { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, E.W, E.H); tintSkin(d, E.baseData, E.state.portrait); ctx.putImageData(d, 0, 0);
  return c;
}
/** 顔をタップする前に強さを選んだとき: 背景まで変わらないよう、タップを待ってからかける */
function askSkinTap(levelValues) {
  E.skinPending = levelValues;
  toast('顔の肌（ほお）をタップしてください。タップした肌の色を覚えて、肌だけを整えます', 4500);
  buildPanel();
}
function skinPanel() {
  const p = E.state.portrait;
  const level = SKIN_LEVELS.find(([, , v]) => v.smooth === p.smooth && v.even === p.even && v.bright === p.bright)?.[0] ?? null;
  const n = p.seeds.length; const autoOn = !n && portraitActive(p);
  const pick = (k) => {
    const v = SKIN_LEVELS.find((x) => x[0] === k)[2];
    // AI（MediaPipe）で肌を見分けられる端末では、タップしなくてもすぐかける（タップしたときと仕上がりはほぼ同じ。実写 4 枚で差は 1/255 以下）。
    // AI を使えないときだけ、背景まで変わらないよう顔のタップを待つ
    if (n || k === 'off' || !E.segFailed) applySkin(v, buildPanel); else askSkinTap(v);
  };
  return [
    hint(n ? 'タップした肌の色に近く、そこからつながっている場所だけを整えます。首・手など離れた肌は、そこもタップすると追加できます。'
      : E.segFailed ? '① 顔の肌（ほお）をタップしてください。タップした肌の色を覚えて、髪・服・背景は変えずに肌だけを整えます。② 強さを選びます。'
        : '強さを選ぶだけで、AI が顔・首・腕の肌を見つけて、肌だけを整えます（髪・服・背景は変えません）。肌でない所まで変わるときは、顔の肌（ほお）をタップしてください。'),
    h('div', { class: 'btn-row' },
      h('span', { class: n ? 'ok-note small' : 'muted small' }, n ? `✓ 肌として選んだ場所: ${n}か所`
        : autoOn ? (E.segFailed ? '肌の場所: 色で自動判定（髪や背景も変わることがあります。顔をタップすると正確になります）' : '✓ 肌の場所: AI が自動で判定')
          : E.skinPending ? '👆 写真の、顔の肌をタップしてください' : '肌の場所: 未選択'),
      n ? btn('選び直す', () => applySkin({ seeds: [] }, buildPanel), 'ghost small') : null),
    n || autoOn ? toggle('肌と判定した範囲を赤で表示', !!E.showSkin, (v) => setShowSkin(v)).el : null,
    chips(SKIN_LEVELS.map(([k, label]) => [k, label]), level ?? (E.skinPending ? SKIN_LEVELS.find(([, , v]) => v === E.skinPending)?.[0] : null), pick, { label: '美肌の強さ' }).el,
    ...(n || autoOn ? PORTRAIT.map(([k, label]) => slider({ label, min: 0, max: 100, value: p[k], def: 0, onChange: (v) => applySkin({ [k]: v }, buildPanel) }).el) : []),
    n ? slider({ label: '肌とみなす色の幅', min: 0, max: 100, value: p.tol, def: 50, onChange: (v) => applySkin({ tol: v }, buildPanel) }).el : null,
    n ? hint('背景や服まで赤くなるときは「色の幅」を下げ、肌の一部が赤くならないときは上げるか、その場所もタップしてください。') : null,
    row(btn('✦ 写真館風におまかせ仕上げ', () => {
      // 明るさ・色の自動補正 → フィルター「透明感」を少し → 美肌（ナチュラル。顔のタップがまだなら、タップを待つ）
      const c = smallSource(); const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      Object.assign(E.state.adj, autoAdjust(histogram(d), d));
      E.state.look = { id: 'studio-clear', amount: 60 };
      if (n || !E.segFailed) applySkin(SKIN_LEVELS[2][2], () => { buildPanel(); toast('仕上げました（各スライダー・フィルターで調整できます）'); });
      else { commit(); requestRender(); askSkinTap(SKIN_LEVELS[2][2]); }
    }, 'primary')),
    hint('おすすめの流れ: ①おまかせ仕上げ → ②「顔」で歯を白く・リップ → ③「修復」でニキビ・後れ毛・背景のゴミを消す → ④「フィルター」の「透明感」「振袖あでやか」などで雰囲気を選ぶ → ⑤「切り抜き」の「L判」「2L判」でプリントの比率に。決まった仕上げは「フィルター」のマイプリセットに保存すると、他の写真にも一度で使えます。'),
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
      // 強さがまだ「なし」なら、先に選んだ強さ（なければナチュラル）で始める
      const strength = portraitActive(pt) ? {} : (E.skinPending || SKIN_LEVELS[2][2]);
      E.skinPending = null;
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

// ── 情報 ──
function infoPanel() {
  const p = E.proj; const x = p.exif;
  const name = h('input', { id: 'proj-name', maxlength: 80, value: p.name });
  name.addEventListener('change', () => { E.proj.name = name.value.trim().slice(0, 80) || '写真'; db.putProject(E.proj); $('.ed-title').textContent = E.proj.name; });
  const rows = [['元の大きさ', `${p.w}×${p.h}${E.scaled ? `（編集は ${E.W}×${E.H}）` : ''}`], ['ファイルの大きさ', fmtBytes(p.size || 0)], ['アプリの版', VERSION], ['形式', p.raw ? `RAW（${p.raw.format}）` : p.type || '不明'],
    ...(p.raw?.kind === 'libraw' ? [['RAWの読み込み', `RAW データから現像（LibRaw・16bit）${p.raw.model ? `・${p.raw.model}` : ''}。編集中は半分の大きさ、書き出しは元の大きさで現像し直します`]] : []),
    ...(p.raw && p.raw.kind !== 'libraw' ? [['RAWの読み込み', p.raw.kind === 'raw' ? `RAW データから現像${p.raw.scaled ? '（大きいので2×2をまとめて半分の大きさに）' : ''}` : `カメラが作ったプレビュー画像（${p.raw.previewW}×${p.raw.previewH}）を使用。この形式の RAW データの現像には対応していません`]] : []),
    ['書き出す大きさ（元の大きさのとき）', (() => {
      if (E.scaled && p.w) { const o = outputSize(E.state.geo, p.w, p.h); const L0 = layout(o.w, o.h, E.state.frame); return `${L0.cw}×${L0.ch}（JPEG・PNG は元の写真から描き直します）`; }
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
    h('details', { class: 'keys' }, h('summary', {}, 'キーボードショートカット'), h('ul', {}, [['Ctrl/⌘ + Z', '元に戻す'], ['Ctrl/⌘ + Shift + Z / Ctrl + Y', 'やり直す'], ['\\（押している間）', '編集前を表示'], ['Esc', '選択をやめる'], ['0', '表示を画面に合わせる']].map(([k, v]) => h('li', {}, h('kbd', {}, k), ` ${v}`)))),
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
  // 2本指になったら（写真の外・拡大縮小のボタンの上に置いた指も数える）、なぞっていた線は取り消して、
  // 指を全部離すまでブラシなどを当てない（2本指の拡大・移動が、リップなどの範囲にならないように）
  let multi = false;
  const toMulti = () => { if (action) { action.cancel?.(); action = null; } multi = true; };
  // 写真の外の指も数えるため document で受ける（編集画面を閉じたら外す。E.offPointer）
  const ac = new AbortController(); E.offPointer = () => ac.abort();
  const on = (ev, f) => document.addEventListener(ev, f, { capture: true, passive: true, signal: ac.signal });
  on('pointerdown', (e) => { if (e.pointerType === 'touch' && pts.size && !pts.has(e.pointerId) && !stage.contains(e.target)) toMulti(); });
  stage.addEventListener('pointerdown', (e) => {
    if (!E || e.button > 0) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (pts.size === 2) { toMulti(); const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: E.zoom, pan: [...E.pan], mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; return; }
    if (pts.size > 2 || multi) return;
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
    if (pts.size < 2) pinch = null;
    if (!pts.size && !touching()) multi = false;
    if (multi) { action?.cancel?.(); action = null; return; }
    action?.end?.(e); action = null;
  };
  let fingers = 0; // 画面に触れている指の数（写真の外も含む）
  const touching = () => fingers > 0;
  on('touchstart', (e) => { fingers = e.touches.length; if (fingers >= 2) toMulti(); });
  for (const ev of ['touchend', 'touchcancel']) on(ev, (e) => { fingers = e.touches.length; if (!fingers && !pts.size) multi = false; });
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', (e) => { action?.cancel?.(); action = null; pts.delete(e.pointerId); pinch = null; if (!pts.size && !touching()) multi = false; });
  stage.addEventListener('wheel', (e) => {
    if (!E) return; e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    const z = Math.min(8, Math.max(1, E.zoom * f));
    const r = stage.getBoundingClientRect(); const cx = e.clientX - r.left - r.width / 2; const cy = e.clientY - r.top - r.height / 2;
    E.pan = z === 1 ? [0, 0] : [cx - (cx - E.pan[0]) * (z / E.zoom), cy - (cy - E.pan[1]) * (z / E.zoom)];
    E.zoom = z; interacting(); requestRender();
  }, { passive: false });
  stage.addEventListener('dblclick', () => { if (!E || ['crop', 'local', 'heal', 'hide'].includes(E.tool) || FX[E.tool]) return; E.zoom = E.zoom > 1 ? 1 : 2.5; E.pan = [0, 0]; requestRender(); });
}

function hoverCursor(e) {
  const brush = (E.tool === 'heal') || !!FX[E.tool] || (E.tool === 'local' && E.state.locals.find((l) => l.id === E.sel)?.type === 'brush');
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
  if (FX[tool]) return fxAction(tool, c, p);
  if (tool === 'skin') return skinAction(e, o, p);
  if (tool === 'hide') return hideAction(c, o, p);
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
        if (ent) paintStroke(ctx2d(ent.c), st, ent.c.width, ent.c.height, st.pts.length - 1);
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

// ── 写真館の仕上げのブラシ（形を整える・目元と歯・明るく／暗く・しわ取り） ──
// size: ブラシの半径（写真の短い辺に対する %）、amt: 強さ（%）。mode: 道具の中の種類
// 初期値は、前撮りに多い全身・上半身の写真（顔の幅が写真の短い辺の 1〜2 割）に合わせる。種類ごとに覚える
const FX = {
  shape: { modes: null, type: () => 'warp', def: { size: 6, amt: 50 },
    hint: '動かしたい所（輪郭・あご・肩・腕など）に指を置いて、動かしたい向きへゆっくりなぞってください。ブラシは動かしたい所が丸ごと入るくらいにして、少しずつ何回かに分けると自然です（小さすぎると、へこみができます）。' },
  eyes: { modes: [['eyes', '目元'], ['teeth', '歯'], ['lip', 'リップ'], ['nose', '鼻筋'], ['gaze', '目線']], type: (m) => m, def: { eyes: { size: 1.5, amt: 45 }, teeth: { size: 1, amt: 70 }, lip: { size: 1.2, amt: 50 }, nose: { size: 1, amt: 50 }, gaze: { size: 1, amt: 100 } },
    hint: { gaze: '目線をカメラに向けたい人の顔（目のあたり）をタップしてください。AI がその人の両目を見つけて、黒目をカメラの方へ動かします（まぶた・まつげは変えません）。集合写真で 1 人だけ目線がそれているときに。動かしたあとは、下の矢印で少しずつ直せます。小さく写った顔は、2 本指で拡大してからタップすると確実です。', eyes: '目のまわりをなぞってください。白目の赤みを減らして明るく、黒目・まつげをくっきりさせ、くまを少し薄くします。', teeth: '歯をタップするか、口のあたりを軽くなぞってください。AI が口を見つけて、歯の範囲を自動で決め、黄ばみを減らして白くします（唇・歯ぐきは変えません）。小さく写った顔は、2 本指で拡大してからタップすると確実です。', lip: '色を選んで、唇をタップするか、口のあたりを軽くなぞってください。AI が唇を見つけて、唇の範囲（歯は除く）を自動で決めて色をのせます。元の唇の明暗・つや・しわは残ります。小さく写った顔は、2 本指で拡大してからタップすると確実です。', nose: '鼻をタップするか、鼻筋を軽くなぞってください。AI が顔を見つけて、鼻筋にほそいハイライト、両脇に影を入れ、鼻を高く見せます（メイクのノーズシャドウと同じ）。幅・長さは顔に合わせて自動で決まり、横向きの顔は奥側を控えめにします。強さは 50% くらいが自然です。小さく写った顔は、2 本指で拡大してからタップすると確実です。' } },
  dodge: { modes: [['dodge', '明るく'], ['burn', '暗く']], type: (m) => m, def: { dodge: { size: 3, amt: 20 }, burn: { size: 3, amt: 20 } },
    hint: { dodge: '明るくしたい所（鼻筋・頬の高い所・目の下など）をなぞってください。重ねてなぞるほど明るくなります。', burn: '暗くしたい所（輪郭のきわ・頬の下・あごの下など）をなぞると、顔が立体的に見えます。重ねるほど暗くなります。' } },
  wrinkle: { modes: null, type: () => 'wrinkle', def: { size: 4, amt: 85 },
    hint: '着物・服のしわや、ほうれい線などをなぞってください。ブラシはしわの幅くらいに。布目・柄・肌のきめと、服と肌の境目は残して、しわの陰だけをならします。取りきれないときは、もう一度なぞってください。' },
};
const fxMode = (tool) => prefs.get(`fx2:${tool}:mode`, FX[tool].modes?.[0][0] ?? null);
function fxPrefs(tool) {
  const d = FX[tool]; const mode = fxMode(tool); const def = mode ? d.def[mode] : d.def;
  const v = prefs.get(`fx2:${tool}:${mode ?? ''}`, {});
  return { size: v.size ?? def.size, amt: v.amt ?? def.amt, mode, def };
}
const setFxPrefs = (tool, patch) => { const f = fxPrefs(tool); prefs.set(`fx2:${tool}:${f.mode ?? ''}`, { size: patch.size ?? f.size, amt: patch.amt ?? f.amt }); };
/** ブラシの半径（画面の Canvas の画素） */
function fxRadiusCanvas(tool) { return fxPrefs(tool).size / 100 * Math.min(E.L.iw, E.L.ih); }
/** ブラシの大きさを変えたとき、写真の真ん中にブラシの丸を少しの間だけ出す（スマホでは指を置くまで丸が見えないので） */
let fxPreviewTimer = 0;
function showBrushPreview() {
  if (!E?.L) return;
  E.cursor = [E.L.ix + E.L.iw / 2, E.L.iy + E.L.ih / 2]; drawHandles();
  clearTimeout(fxPreviewTimer); fxPreviewTimer = setTimeout(() => { if (E) { E.cursor = null; drawHandles(); } }, 1500);
}
function fxPanel(tool) {
  const d = FX[tool]; const f = fxPrefs(tool);
  if (tool === 'shape') warmPersonSeg(); // 背景を動かさないための AI を先に読み込んでおく
  const types = d.modes ? d.modes.map(([m]) => d.type(m)) : [d.type()];
  const n = E.state.retouch.filter((o) => types.includes(o.type)).length;
  return [
    // 種類を先に（説明の長さが種類で違うので、説明の下に置くと、切り替えるたびにボタンの位置がずれる）
    d.modes ? chips(d.modes, f.mode, (v) => { prefs.set(`fx2:${tool}:mode`, v); buildPanel(); }, { label: '種類' }).el : null,
    hint(typeof d.hint === 'string' ? d.hint : d.hint[f.mode]),
    f.mode === 'lip' ? lipColorPicker() : null,
    // 鼻筋・目線はタップした所の顔を AI で見つけて当てるので、ブラシの大きさは使わない（出すと迷う）
    ['nose', 'gaze'].includes(f.mode) ? null : slider({ label: 'ブラシの大きさ', min: 0.5, max: 30, step: 0.5, value: f.size, def: f.def.size, onInput: (v) => { setFxPrefs(tool, { size: v }); showBrushPreview(); }, onChange: (v) => { setFxPrefs(tool, { size: v }); showBrushPreview(); } }).el,
    slider({ label: f.mode === 'gaze' ? 'カメラへ寄せる量' : '強さ', min: 5, max: 100, value: f.amt, def: f.def.amt, unit: '%', onChange: (v) => setFxPrefs(tool, { amt: v }) }).el,
    f.mode === 'gaze' ? gazeTuner() : null,
    h('p', { class: 'muted small' }, `なぞった回数: ${n}`),
    n ? row(btn(`${TOOL_LABEL[tool]}をすべて消す`, () => { E.state.retouch = E.state.retouch.filter((o) => !types.includes(o.type)); rebuildSource(); commit(); buildPanel(); requestRender(); }, 'ghost small')) : null,
    hint('うまくいかなかったら「元に戻す」で 1 回ずつ戻せます。2 本指で広げると、拡大して細かい所をなぞれます（ブラシの大きさは写真に対する大きさなので、拡大しても変わりません）。'),
  ];
}
/** 目線の微調整: 最後に直した人の黒目を、矢印で少しずつ（黒目の半径の 1 割ずつ）動かす */
function gazeTuner() {
  const op = E.state.retouch.findLast?.((o) => o.type === 'gaze') ?? [...E.state.retouch].reverse().find((o) => o.type === 'gaze');
  if (!op) return null;
  const nudge = (dx, dy) => {
    const t = op.tune || [0, 0]; op.tune = [+(t[0] + dx).toFixed(2), +(t[1] + dy).toFixed(2)];
    rebuildSource(); commit(); buildPanel(); requestRender();
  };
  const arrow = (label, dx, dy, title) => btn(label, () => nudge(dx, dy), 'ghost small gaze-arrow', title);
  const t = op.tune || [0, 0];
  return h('div', { class: 'gaze-tune' },
    h('p', { class: 'muted small' }, `黒目の微調整（最後にタップした人）${t[0] || t[1] ? `: 横 ${t[0] > 0 ? '+' : ''}${t[0]}・縦 ${t[1] > 0 ? '+' : ''}${t[1]}` : ''}`),
    h('div', { class: 'gaze-pad', role: 'group', 'aria-label': '黒目を動かす' },
      h('span'), arrow('↑', 0, -0.1, '黒目を上へ'), h('span'),
      arrow('←', -0.1, 0, '黒目を左へ'), btn('戻す', () => { if (op.tune) { delete op.tune; rebuildSource(); commit(); buildPanel(); requestRender(); } }, 'ghost small'), arrow('→', 0.1, 0, '黒目を右へ'),
      h('span'), arrow('↓', 0, 0.1, '黒目を下へ'), h('span')));
}
/** リップの色（選んだもの） */
// 色は「色合い（色相）・濃さ（彩度）・明るさ」で持つ。見本の色を選ぶと 3 つがその色になり、スライダーで好みに調整できる
const rgbToHsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2; const d = mx - mn; if (!d) return [0, 0, Math.round(l * 100)]; const s = d / (1 - Math.abs(2 * l - 1)); let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh = (hh * 60 + 360) % 360; return [Math.round(hh), Math.round(s * 100), Math.round(l * 100)]; };
const hslToRgb = ([hh, s, l]) => { s /= 100; l /= 100; const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((hh / 60) % 2) - 1)); const m = l - c / 2; const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x]; return [r, g, b].map((v) => Math.round((v + m) * 255)); };
const lipHsl = () => { const v = prefs.get('lipHsl', null); return Array.isArray(v) && v.length === 3 ? v : rgbToHsl(LIP_COLORS[0][2]); };
const lipColor = () => hslToRgb(lipHsl());
/** リップの色: 見本の色と、色合い・濃さ・明るさのスライダー（いまの色の見本つき） */
function lipColorPicker() {
  const cur = lipHsl(); const set = (v) => { prefs.set('lipHsl', v); };
  const sw = h('span', { class: 'lip-dot big', 'aria-hidden': 'true', style: { background: `rgb(${lipColor().join(' ')})` } });
  const upd = (i) => (v) => { const x = lipHsl(); x[i] = v; set(x); sw.style.background = `rgb(${lipColor().join(' ')})`; };
  return h('div', { class: 'lip-picker' },
    h('div', { class: 'chips lip-colors', role: 'group', 'aria-label': 'リップの色の見本' }, LIP_COLORS.map(([k, label, rgb]) => {
      const hsl = rgbToHsl(rgb); const on = hsl.every((v, i) => Math.abs(v - cur[i]) <= 1);
      return h('button', { type: 'button', 'aria-pressed': String(on), onclick: () => { set(hsl); buildPanel(); } }, h('span', { class: 'lip-dot', 'aria-hidden': 'true', style: { background: `rgb(${rgb.join(' ')})` } }), label);
    })),
    h('div', { class: 'lip-now' }, sw, h('span', { class: 'muted small' }, 'いまの色（スライダーで調整）')),
    slider({ label: '色合い', min: 0, max: 360, value: cur[0], def: cur[0], unit: '°', track: 'hue', onInput: upd(0), onChange: upd(0) }).el,
    slider({ label: '色の濃さ', min: 10, max: 100, value: cur[1], def: cur[1], unit: '%', onInput: upd(1), onChange: upd(1) }).el,
    slider({ label: '色の明るさ', min: 15, max: 75, value: cur[2], def: cur[2], unit: '%', onInput: upd(2), onChange: upd(2) }).el);
}
/** AI で見つけた口の輪郭を、保存する形に（座標は 5 桁まで） */
const round5 = (pts) => pts.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
const roundLips = (lips) => lips.map((l) => ({ outer: round5(l.outer), inner: round5(l.inner) }));
/** AI で見つけた両目を、保存する形に */
const roundEyes = (faces) => faces.map((f) => f.map((e) => ({ lid: round5(e.lid), iris: round5(e.iris), pose: (e.pose || [0, 0]).map((v) => +v.toFixed(4)) })));
/** なぞる操作。形を整えるは、なぞりながらその場で動かす。ほかは指を離したときに当てる */
function fxAction(tool, c, p) {
  const f = fxPrefs(tool); const type = FX[tool].type(f.mode);
  const r = Math.min(0.3, Math.max(0.002, f.size / 100 * outputScaleToSrc())); // 元写真の短い辺に対する割合
  const amt = f.amt / 100;
  const toSrc = (q) => outToSrc(...toOut(q), p);
  const pts = [toSrc(c)]; const path = [c];
  E.cursor = c; drawHandles(); // 指を置いた所にブラシの丸を出す
  if (E.state.retouch.length >= S.MAX_RETOUCH) { toast('修復・仕上げは300回までです'); return null; }
  const step = r * Math.min(E.W, E.H) * (type === 'warp' ? 0.15 : 0.3); // 点の間隔（元写真の画素）
  const far = (a, b) => Math.hypot((a[0] - b[0]) * E.W, (a[1] - b[1]) * E.H) >= step;
  let live = null; let raf = 0;
  if (type === 'warp') {
    // なぞりながら動かす: 編集用の画素に 1 区間ずつ当てて、画面に反映する
    if (!E.src) { const rr = retouchCanvas(srcBase(), E.state.retouch, E.state.portrait, E.skinCache); E.src = rr.canvas; E.srcData = rr.data; }
    const ctx = ctx2d(E.src, { willReadFrequently: true });
    if (!E.srcData) E.srcData = ctx.getImageData(0, 0, E.W, E.H);
    // 背景を動かさないために、なぞり始めのまわりの人物の地図を AI に頼む。届くまでの区間はためておき、届いたらまとめて当てる
    // （保存した線から作り直すときと同じ順になる）。AI を使えなければ地図なし（背景も動く）
    const rp = Math.max(1.5, r * Math.min(E.W, E.H)); const p0 = [pts[0][0] * E.W, pts[0][1] * E.H];
    live = { ctx, dirty: null, rad: rp, stroke: null, done: 1, pm: undefined };
    const e0 = E;
    live.ready = personMap(E.srcData, warpProtectBox(pts[0], r, E.W, E.H), WARP_MAP_N).then((pm) => {
      if (E !== e0) return; live.pm = pm || undefined;
      live.stroke = warpStroke(E.srcData, rp, warpProtect(live.pm, rp, { W: E.W, H: E.H, ox: 0, oy: 0 }, p0), WARP_SHAPE);
      live.apply();
    });
    live.apply = () => {
      if (!live.stroke) return;
      for (; live.done < pts.length; live.done++) {
        const a0 = [pts[live.done - 1][0] * E.W, pts[live.done - 1][1] * E.H]; const a1 = [pts[live.done][0] * E.W, pts[live.done][1] * E.H];
        const box = live.stroke.seg(a0, a1, amt);
        if (box) { const d = live.dirty; live.dirty = d ? [Math.min(d[0], box[0]), Math.min(d[1], box[1]), Math.max(d[0] + d[2], box[0] + box[2]) - Math.min(d[0], box[0]), Math.max(d[1] + d[3], box[1] + box[3]) - Math.min(d[1], box[1])] : box; }
      }
      if (live.dirty && !raf) raf = requestAnimationFrame(flush);
    };
  }
  const flush = () => { raf = 0; if (!live?.dirty) return; const [x, y, w, hh] = live.dirty; live.ctx.putImageData(E.srcData, 0, 0, x, y, w, hh); live.dirty = null; E.engine.setSource(E.src, E.W, E.H); requestRender(); };
  return {
    move: (e) => {
      const q = canvasPoint(e); const s = toSrc(q);
      if (!far(s, pts.at(-1)) || pts.length >= S.MAX_BRUSH_POINTS) return;
      pts.push(s); path.push(q);
      if (live) { live.apply(); E.cursor = q; drawHandles(); } else { E.fxPath = path; E.cursor = q; drawHandles(); }
    },
    end: (e) => {
      E.fxPath = null; if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (e?.pointerType !== 'mouse') E.cursor = null; // 指で描いたときは、離したら丸を消す
      const op = { type, pts, r, amt, ...(type === 'lip' ? { col: lipColor() } : {}) };
      if (live) {
        if (pts.length < 2) { drawHandles(); return; }
        op.v = 5;
        const e0 = E;
        const finish = () => {
          if (E !== e0) return; E.stageEl.classList.remove('busy', 'warp');
          if (live.pm) op.pm = live.pm;
          live.apply(); if (raf) { cancelAnimationFrame(raf); raf = 0; }
          flush(); E.state.retouch.push(op); E.retouchKey = sourceKey(E.state); E.small = null;
          commit(); buildPanel(); requestRender();
        };
        if (live.stroke) finish();
        else { E.stageEl.classList.add('busy', 'warp'); live.ready.then(finish); } // 人物の地図がまだなら、届いてから当てる
        return;
      } else if (type === 'gaze') {
        // タップした所は目印。そのそばの顔の両目を AI で見つけ、黒目をカメラの方へ動かす（見つからなければ何もしない）
        drawHandles(); E.stageEl.classList.add('busy', 'lips');
        const e0 = E;
        findEyes(baseImageData(), pts, r).then((eyes) => {
          if (E !== e0) return; E.stageEl.classList.remove('busy', 'lips');
          if (!eyes?.length) { toast(eyes ? '顔が見つかりませんでした。目のあたりをタップしてください（横顔・顔が隠れているときは見つかりません）' : '顔を見つける AI を使えないので、目線は直せません'); return; }
          op.eyes = roundEyes(eyes);
          addRetouch(op); commit(); buildPanel(); requestRender();
        });
        return;
      } else if (type === 'lip' || type === 'teeth') {
        // なぞった所・タップした所は目印。そのそばの口を AI で見つけ、唇・歯の範囲はアプリが決める（はじめての 1 回は少し時間がかかる）
        drawHandles(); // なぞった線は、AI を待たずにすぐ消す
        E.stageEl.classList.add('busy', 'lips');
        const e0 = E;
        findMouth(baseImageData(), pts, r).then((lips) => {
          if (E !== e0) return; E.stageEl.classList.remove('busy', 'lips');
          if (lips?.length) { op.lips = roundLips(lips); op.whole = true; }
          else {
            // 口が見つからないときは、今までどおり、なぞった所の唇・歯の色の所だけ
            const what = type === 'lip' ? '唇' : '歯';
            toast(lips ? `口が見つからなかったので、なぞった所の${what}の色の所だけを補正しました（横顔・顔が隠れているときは見つかりません）` : `口を見つける AI を使えないので、なぞった所の${what}の色の所だけを補正しました`);
          }
          addRetouch(op); commit(); buildPanel(); requestRender();
        });
        return;
      } else if (type === 'nose') {
        // タップした所の顔を AI で見つけ、鼻の点（鼻筋のまん中・ふち・頬の境目）から範囲をアプリが決める。顔が見つからなければ何もしない
        drawHandles();
        E.stageEl.classList.add('busy', 'face');
        const e0 = E;
        findFaceAt(baseImageData(), pts, r).then((face) => {
          if (E !== e0) return; E.stageEl.classList.remove('busy', 'face');
          if (!face) { toast(face === null ? '顔を見つける AI を使えないので、鼻筋は補正できませんでした' : '顔が見つからなかったので、鼻筋は補正できませんでした（横顔・顔が隠れているときは見つかりません。小さい顔は 2 本指で拡大してからタップしてください）'); return; }
          op.nose = {}; for (const [k, ids] of Object.entries(NOSE_POINTS)) op.nose[k] = ids.map((i) => [+face[i][0].toFixed(5), +face[i][1].toFixed(5)]);
          addRetouch(op); commit(); buildPanel(); requestRender();
        });
        return;
      } else addRetouch(op);
      commit(); buildPanel(); requestRender();
    },
    cancel: () => {
      E.fxPath = null; E.cursor = null; if (raf) cancelAnimationFrame(raf);
      if (live && pts.length > 1) { const e0 = E; live.ready.then(() => { if (E !== e0) return; E.state.retouch.push({ type, pts, r, amt, v: 5, ...(live.pm ? { pm: live.pm } : {}) }); E.retouchKey = sourceKey(E.state); rebuildSource(); }); }
      drawHandles();
    },
  };
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
  if (E.fxPath) el('polyline', { points: E.fxPath.map((q) => q.join(',')).join(' '), class: 'heal-path', 'stroke-width': fxRadiusCanvas(E.tool) * 2 });
  if (E.cursor && FX[E.tool]) el('circle', { cx: E.cursor[0], cy: E.cursor[1], r: fxRadiusCanvas(E.tool), class: 'cursor', 'stroke-width': 1.5 * k });
  if (E.cursor && (E.tool === 'heal' || E.tool === 'local')) {
    const r = E.tool === 'heal' ? prefs.get('healSize', 3) / 100 * 0.6 * Math.min(L.iw, L.ih) : (prefs.get('brush', { size: 8 }).size / 200) * Math.min(L.iw, L.ih) / outputScaleToSrc();
    el('circle', { cx: E.cursor[0], cy: E.cursor[1], r, class: 'cursor', 'stroke-width': 1.5 * k });
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
  if (e.key === 'Escape') { E.wbPick = false; E.colorPick = false; buildPanel(); requestRender(); }
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
async function canvasToBlob(canvas, format, quality, space = COLOR_SPACE) {
  let out = canvas;
  // JPEG は透明にできないので白で埋める。sRGB で書き出すときは、sRGB の Canvas に描き写す（ブラウザが色を変換する）
  if (format === 'image/jpeg' || space !== COLOR_SPACE) {
    const f = document.createElement('canvas'); f.width = out.width; f.height = out.height; const ctx = f.getContext('2d', { colorSpace: space });
    if (format === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, f.width, f.height); }
    ctx.drawImage(out, 0, 0); out = f;
  }
  const blob = await new Promise((r) => out.toBlob(r, format, quality));
  if (!blob) throw new Error('toBlob');
  return { blob, w: out.width, h: out.height };
}
/**
 * 1枚を書き出す。編集用に縮めた写真（約1,670万画素まで）より大きく書き出すときは、元の写真から帯ごとに描き直す（fullres.js）
 * @param {object} src { base, W, H, state, full?（元の大きさの写真）, origW, origH, hqCanvas?・hqRes?（編集中に作った、暗所補正・ブレ補正をした写真とブレ補正の差分） }
 */
async function renderToBlob(src, { format, quality, maxSide, space = COLOR_SPACE, onProgress }) {
  const st0 = S.validateState(src.state);
  const ll = lowlightActive(st0.adj) ? lowlightOptions(st0.adj) : null; // 暗所補正（ノイズ除去 → 明るさ）
  const db = deblurActive(st0.adj); // ブレ補正（明るさの後、粒の前）
  const fa = faceaiActive(st0); // 顔 AI（いちばん後）
  // 暗所補正・ブレ補正をするときは、美肌の肌の判定・修復のコピー元も、補正した写真（編集用の大きさ）で決める。編集中と同じになる
  let work = src.base; let pre = 0; let res = null; let faces = null; // pre: 進捗のうち、ここで使った割合
  if (ll || db || fa) {
    if (!src.hqCanvas) pre = db || fa ? 0.6 : 0.3;
    if (src.hqCanvas) { work = src.hqCanvas; res = src.hqRes || null; faces = src.hqFaces || null; } else {
      ({ canvas: work, res, faces } = await enhanceSource({ base: src.base, W: src.W, H: src.H, origW: src.origW || src.W, origH: src.origH || src.H }, st0.adj, { state: st0, onProgress: (t) => onProgress?.(t * pre) }));
    }
    if (portraitActive(st0.portrait)) await ensureSkinSeg(ctx2d(toCanvas(work, src.W, src.H), { willReadFrequently: true }).getImageData(0, 0, src.W, src.H));
  }
  if (useFull(src, format, maxSide)) {
    const st = st0;
    // 修復で自動で選んだコピー元は、編集用の大きさで決めておく（プレビューと同じ場所になる）
    if (st.retouch.some((o) => o.type === 'heal' && o.sx == null)) retouchCanvas(work, st.retouch, null);
    try {
      return await exportFull({ full: src.full, work, lowlightFrom: src.base, state: st, mask: buildMask(st, src.full.width, src.full.height), format, quality, space, maxSide, lowlight: ll,
        deblur: db ? { res, amount: deblurAmount(st0.adj), grain: 0 } : null, // 暗所補正があるときの粒は、書き出しで測ったノイズの量で決まる
        faces: fa && faces?.length ? { list: faces, editW: src.W, amount: faceaiAmount(st0) } : null,
        onProgress: onProgress && ((t) => onProgress(pre + (1 - pre) * t)) });
    } catch (e) { console.warn('元の大きさで書き出せなかったので、編集用の大きさで書き出します', e); }
  }
  if (ll || db || fa) src = { ...src, base: work, state: withoutLowlight(st0) };
  return canvasToBlob(renderToCanvas(src, { maxSide }), format, quality, space);
}
/**
 * 書き出し用に、元の大きさの写真を読み込む。RAW（LibRaw）は元の大きさで現像し直す（時間がかかる）。
 * gain: 編集中と同じ明るさになるよう、編集中の現像で決めた倍率を使う
 */
async function loadFull(proj, blob, state, gain) {
  if (proj.raw?.kind === 'libraw') {
    const r = await decodeLibRaw(await blob.arrayBuffer(), { half: false });
    return pixelSource(prepareLin(r.lin, r.fullW, gain), state.raw);
  }
  return (await decodeAny(blob, proj.fileName, proj)).image;
}
/** 元の写真から描き直すか（編集用に縮めていて、それより大きく書き出すとき。WebP は帯ごとに作れないので縮めたまま） */
function useFull(src, format, maxSide) {
  return !!src.full && format !== 'image/webp' && (src.full.width > src.W || src.full.height > src.H) && (!maxSide || maxSide > Math.max(src.W, src.H));
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'photo';

function openExport({ batch }) {
  const opt = prefs.get('export', { format: 'image/jpeg', quality: 92, maxSide: 0 });
  if (opt.format === 'image/webp' && !canWebp) opt.format = 'image/jpeg';
  if (opt.space !== 'srgb' || COLOR_SPACE === 'srgb') opt.space = COLOR_SPACE;
  let ready = null; // 写真アプリへの保存で、用意できた画像（iPhone は時間がたつと共有を開けないので、もう一度押してもらう）
  const save = () => { prefs.set('export', opt); ready = null; };
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const exportProgress = h('progress', { max: 100, hidden: true, 'aria-label': '画像の書き出し進捗' });
  const name = h('input', { id: 'exp-name', maxlength: 80, value: batch ? '' : `${E.proj.name}_edit`, placeholder: batch ? '（元の名前 + _edit）' : '' });
  const q = slider({ label: '画質', min: 50, max: 100, value: opt.quality, def: 92, unit: '%', onChange: (v) => { opt.quality = v; save(); } });
  const qWrap = h('div', { hidden: opt.format === 'image/png' }, q.el);
  const go = h('button', { type: 'button', class: 'primary' }, batch ? `${batch.length}枚を書き出す` : '書き出す');
  const SHARE_LABEL = '写真アプリに保存';
  const shareBtn = h('button', { type: 'button', class: 'primary', hidden: !(navigator.canShare && !batch) }, SHARE_LABEL);
  if (!shareBtn.hidden) go.classList.remove('primary');
  name.addEventListener('input', () => { ready = null; shareBtn.textContent = SHARE_LABEL; });
  const dlg = h('dialog', { class: 'dlg export', 'aria-labelledby': 'exp-h' },
    h('h2', { id: 'exp-h' }, batch ? `まとめて書き出し（${batch.length}枚）` : '書き出し'),
    h('div', { class: 'sub-head' }, h('b', {}, '形式')),
    chips([['image/jpeg', 'JPEG'], ['image/png', 'PNG（劣化なし）'], ...(canWebp ? [['image/webp', 'WebP（小さい）']] : [])], opt.format, (v) => { opt.format = v; qWrap.hidden = v === 'image/png'; save(); }, { label: '形式' }).el,
    qWrap,
    h('div', { class: 'sub-head' }, h('b', {}, '大きさ（長い辺）')),
    chips([[0, batch || !E.proj.w ? '元の大きさ' : `元の大きさ（${E.proj.w}×${E.proj.h}）`], [4096, '4096px'], [2048, '2048px'], [1080, '1080px（SNS）']], opt.maxSide, (v) => { opt.maxSide = v; save(); }, { label: '大きさ' }).el,
    ...(COLOR_SPACE === 'display-p3' ? [h('div', { class: 'sub-head' }, h('b', {}, '色')),
      chips([['display-p3', 'Display P3（鮮やかなまま）'], ['srgb', 'sRGB（プリント店・古い機器向け）']], opt.space, (v) => { opt.space = v; save(); }, { label: '色' }).el,
      h('p', { class: 'muted small' }, 'iPhone で撮った写真の鮮やかな赤や緑は、Display P3 でそのまま残ります。プリント店で色が変わるときは sRGB を選んでください。')] : []),
    h('div', { class: 'field' }, h('label', { for: 'exp-name' }, 'ファイル名'), name),
    ...(navigator.canShare && !batch ? [h('p', { class: 'muted small' }, '「写真アプリに保存」→ 出てきたメニューの「画像を保存」で、写真アプリに入ります。「書き出す」はファイルアプリ（ダウンロード）に保存します。')] : []),
    h('p', { class: 'ok-note' }, '✓ 位置情報・撮影日時・カメラ情報などのメタデータは、書き出した画像には入りません。'),
    status, exportProgress,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, '閉じる'), shareBtn, go));
  dlg.addEventListener('close', () => dlg.remove());
  const one = async () => {
    flushSave();
    const st = S.clone(E.state);
    status.textContent = '書き出しています…';
    exportProgress.hidden = false; exportProgress.removeAttribute('value');
    let full = null;
    if (useFull({ full: { width: E.proj.w || 0, height: E.proj.h || 0 }, W: E.W, H: E.H }, opt.format, opt.maxSide)) {
      status.textContent = E.rawLin ? 'RAW を元の大きさで現像しています…（しばらくかかります）' : '元の大きさの写真を読み込んでいます…';
      try { full = await loadFull(E.proj, await db.getBlob(E.id), st, E.rawLin?.gain); } catch (e) { console.warn('元の大きさの写真を読み込めませんでした', e); full = null; }
    }
    const progress = (t) => { const p = Math.min(99, Math.max(0, Math.floor(t * 100))); exportProgress.value = p; status.textContent = `画像を生成しています… 残り${100 - p}%`; };
    let r;
    try { r = await renderToBlob({ base: E.base, W: E.W, H: E.H, state: st, full, hqCanvas: hqReady() ? E.hq.canvas : null, hqRes: hqResidual(), hqFaces: hqFaces(), origW: E.proj.w || E.W, origH: E.proj.h || E.H }, { format: opt.format, quality: opt.quality / 100, maxSide: opt.maxSide, space: opt.space, onProgress: progress }); } finally { full?.close?.(); }
    exportProgress.value = 100;
    status.textContent = `✓ できました（${r.w}×${r.h}・${fmtBytes(r.blob.size)}）`;
    return { ...r, file: `${safeName(name.value.trim() || `${E.proj.name}_edit`)}.${EXT[opt.format]}` };
  };
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      if (!batch) { const r = await one(); download(r.blob, r.file); toast('書き出しました'); }
      else {
        let i = 0;
        // まとめて書き出すときも、全体の進み具合をバーに出す（暗所補正・ブレ補正のある写真は 1 枚に数分かかる）
        exportProgress.hidden = false; exportProgress.value = 0;
        const step = (t) => { exportProgress.value = Math.min(99, Math.floor(100 * (i - 1 + t) / batch.length)); };
        for (const p of batch) {
          status.textContent = `書き出しています… ${++i}/${batch.length}`; step(0);
          const blob = await db.getBlob(p.id); const prep = await prepare(p, blob, undefined, { keepFull: true });
          if (portraitActive(S.validateState(p.state).portrait)) await ensureSkinSeg(ctx2d(toCanvas(prep.base, prep.W, prep.H), { willReadFrequently: true }).getImageData(0, 0, prep.W, prep.H)); // 美肌の肌を AI で見分ける
          if (!prep.full && prep.lin && useFull({ full: { width: p.w, height: p.h }, W: prep.W, H: prep.H }, opt.format, opt.maxSide)) {
            status.textContent = `RAW を元の大きさで現像しています… ${i}/${batch.length}`;
            try { prep.full = await loadFull(p, blob, S.validateState(p.state), prep.lin.gain); } catch { prep.full = null; }
          }
          let r;
          try { r = await renderToBlob({ base: prep.base, W: prep.W, H: prep.H, state: p.state, full: prep.full, origW: p.w, origH: p.h }, { format: opt.format, quality: opt.quality / 100, maxSide: opt.maxSide, space: opt.space, onProgress: step }); } finally { prep.base.close?.(); if (prep.full !== prep.base) prep.full?.close?.(); }
          download(r.blob, `${safeName(name.value.trim() ? `${name.value.trim()}_${i}` : `${p.name}_edit`)}.${EXT[opt.format]}`);
          await new Promise((res) => setTimeout(res, 400));
        }
        exportProgress.value = 100; status.textContent = `✓ ${batch.length}枚を書き出しました`;
      }
    } catch { exportProgress.hidden = true; status.textContent = '書き出せませんでした。大きさを小さくしてお試しください。'; } finally { go.disabled = false; }
  });
  shareBtn.addEventListener('click', async () => {
    shareBtn.disabled = true;
    let file = ready;
    try {
      if (!file) { const r = await one(); file = new File([r.blob], r.file, { type: opt.format }); }
      if (!navigator.canShare({ files: [file] })) { download(file, file.name); toast('写真アプリに渡せないので、ファイルに保存しました'); return; }
      await navigator.share({ files: [file] }); ready = null; shareBtn.textContent = SHARE_LABEL;
    } catch (e) {
      if (e?.name === 'NotAllowedError' && file) { // 書き出しに時間がかかって、押したことが切れた。用意はできたので、もう一度押してもらう
        ready = file; shareBtn.textContent = 'もう一度押して保存'; status.textContent = '用意ができました。もう一度「もう一度押して保存」を押してください。';
      } else if (e?.name !== 'AbortError') status.textContent = '写真アプリに保存できませんでした';
    } finally { shareBtn.disabled = false; }
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
  GR.tabs = h('nav', { class: 'tabs rail', role: 'tablist', 'aria-label': 'グリッドの設定', 'aria-orientation': 'vertical' }, TABS.map(([k, icon, label]) => h('button', {
    type: 'button', role: 'tab', id: `gtab-${k}`, 'aria-controls': 'grid-panel', 'aria-selected': String(GR.tab === k), tabindex: GR.tab === k ? '0' : '-1',
    onclick: () => { GR.tab = k; for (const b of GR.tabs.children) { const on = b.id === `gtab-${k}`; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; } gridPanel(); },
  }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label))));
  render(app, h('div', { class: 'editor grid-editor' },
    h('header', { class: 'ed-head' },
      h('button', { type: 'button', class: 'back', 'aria-label': '‹ 写真', title: '写真の一覧に戻る', onclick: () => { GR = null; showLibrary(); } }, '‹'),
      h('span', { class: 'ed-title' }, `グリッド（${GR.ps.length}枚）`),
      h('div', { class: 'ed-tools' }, h('button', { type: 'button', class: 'primary', onclick: openGridExport }, '書き出し'))),
    GR.tabs, h('aside', { class: 'side' }, GR.panel), GR.stage));
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
  GR.rects = drawGrid(ctx2d(GR.view), W, H, GR.grid, gridImages(), { selected: GR.sel, handles: true, active: GR.line });
  GR.view.style.width = `${W / dpr}px`; GR.view.style.height = `${H / dpr}px`;
}
function saveGridStyle() { const { aspect, gap, margin, radius, bg } = GR.grid; prefs.set('gridStyle', { aspect, gap, margin, radius, bg }); }

function gridPanel() {
  const G = GR.grid; const n = G.cells.length;
  let body;
  if (GR.tab === 'layout') {
    const thumbs = h('div', { class: 'grid-layouts', role: 'group', 'aria-label': 'レイアウト' }, LAYOUTS[n].map((l) => {
      const c = h('canvas', { width: 64, height: 64, 'aria-hidden': 'true' });
      const ctx = ctx2d(c); ctx.fillStyle = isDark() ? '#2a2c31' : '#eceef2'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = isDark() ? '#8b8e95' : '#9a9db0';
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
  drawGrid(ctx2d(out), w, hh, GR.grid, images);
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
          await db.addProject({ id, name: name.value.trim().slice(0, 80) || 'グリッド', fileName: fileName(), created: Date.now(), updated: Date.now(), w: r.w, h: r.h, size: r.blob.size, type: opt.format, exif: null, state: S.defaultState(), thumb: await thumbBlob(bmp), thumbV: THUMB_V }, r.blob);
          bmp.close?.(); status.textContent = '写真一覧に保存しました。文字やフレームを足すなど、続けて編集できます。'; toast('写真一覧に保存しました');
        } catch { status.textContent = '保存できませんでした'; }
      } }, '写真一覧に保存'),
      h('button', { type: 'button', hidden: !navigator.canShare, onclick: async () => {
        try { const r = await make(); const f = new File([r.blob], fileName(), { type: opt.format }); if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else download(r.blob, fileName()); } catch (e) { if (e?.name !== 'AbortError') status.textContent = e?.name === 'NotAllowedError' ? '用意ができました。もう一度押してください。' : '写真アプリに保存できませんでした'; }
      } }, '写真アプリに保存'),
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
applyTheme();
showLibrary();
// テスト・デバッグ用（中身の確認だけ。外部には何も送らない）
window.__temoto = { get state() { return E && S.clone(E.state); }, get editor() { return E; }, get grid() { return GR; } };
