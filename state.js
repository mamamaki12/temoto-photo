// 編集内容（非破壊）の形。写真そのものは変えず、この「レシピ」だけを保存する。
// 読み込んだプロジェクト・プリセットのファイルは信用せず、validateState() で型と範囲を直してから使う。

/** 調整スライダーの定義: [キー, 表示名, 最小, 最大, グループ] */
export const ADJ = [
  ['exposure', '露光量', -100, 100, 'light'],
  ['brightness', '明るさ', -100, 100, 'light'],
  ['contrast', 'コントラスト', -100, 100, 'light'],
  ['highlights', 'ハイライト', -100, 100, 'light'],
  ['shadows', 'シャドウ', -100, 100, 'light'],
  ['whites', '白レベル', -100, 100, 'light'],
  ['blacks', '黒レベル', -100, 100, 'light'],
  ['temp', '色温度', -100, 100, 'color'],
  ['tint', '色かぶり補正', -100, 100, 'color'],
  ['vibrance', '自然な彩度', -100, 100, 'color'],
  ['saturation', '彩度', -100, 100, 'color'],
  ['clarity', '明瞭度', -100, 100, 'detail'],
  ['dehaze', 'かすみの除去', -100, 100, 'detail'],
  ['sharpen', 'シャープ', 0, 100, 'detail'],
  ['noise', 'ノイズ軽減', 0, 100, 'detail'],
  ['vignette', '周辺光量', -100, 100, 'effect'],
  ['vignetteMid', '周辺光量の範囲', 0, 100, 'effect'],
  ['grain', '粒子', 0, 100, 'effect'],
  ['grainSize', '粒子の大きさ', 0, 100, 'effect'],
  ['fade', 'フェード', 0, 100, 'effect'],
  ['bloom', 'ブルーム（光のにじみ）', 0, 100, 'effect'],
  ['halation', 'ハレーション（フィルム風）', 0, 100, 'effect'],
];
export const ADJ_DEFAULT = { vignetteMid: 50, grainSize: 30 };

export const HSL_BANDS = [['red', 'レッド', 0], ['orange', 'オレンジ', 30], ['yellow', 'イエロー', 60], ['green', 'グリーン', 120], ['aqua', 'アクア', 180], ['blue', 'ブルー', 225], ['purple', 'パープル', 270], ['magenta', 'マゼンタ', 315]];

/** 部分補正で使える調整 */
export const LOCAL_ADJ = [['exposure', '露光量'], ['contrast', 'コントラスト'], ['highlights', 'ハイライト'], ['shadows', 'シャドウ'], ['temp', '色温度'], ['tint', '色かぶり'], ['saturation', '彩度'], ['clarity', '明瞭度'], ['dehaze', 'かすみの除去'], ['blur', 'ぼかし']];
export const LOCAL_TYPES = { brush: 'ブラシ', linear: '線形グラデーション', radial: '円形グラデーション', color: '色域', luma: '明るさの範囲' };
export const MAX_LOCALS = 8;
export const MAX_BRUSH_LOCALS = 4;
export const MAX_STROKES = 400;
export const MAX_RETOUCH = 300;
export const MAX_SKIN_SEEDS = 12;
export const MAX_OVERLAYS = 60;
export const ASPECTS = { free: '自由', original: '元の比率', '1:1': '1:1', '4:5': '4:5', '3:4': '3:4', '2:3': '2:3', '9:16': '9:16', '16:9': '16:9', '3:2': '3:2', '4:3': '4:3', 'print-L': 'L判', 'print-2L': '2L判', 'print-6': '六つ切り', 'print-A4': 'A4' };
/** プリントの大きさ（短い辺:長い辺）。写真の向き（縦・横）に合わせて使う */
export const PRINT_ASPECTS = { 'print-L': [89, 127], 'print-2L': [127, 178], 'print-6': [203, 254], 'print-A4': [210, 297] };
export const FONTS = { gothic: 'ゴシック', mincho: '明朝', round: '丸ゴシック', mono: '等幅', hand: '手書き風' };
export const FONT_CSS = {
  gothic: '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif',
  mincho: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", serif',
  round: '"Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", "Noto Sans JP", sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
  hand: '"Klee One", "Yomogi", "Comic Sans MS", cursive',
};
export const PADS = { none: 'なし', '1:1': '正方形 1:1', '4:5': '縦 4:5', '9:16': 'ストーリー 9:16', '16:9': '横 16:9' };

const zeroAdj = () => Object.fromEntries(ADJ.map(([k]) => [k, ADJ_DEFAULT[k] ?? 0]));
const zeroHsl = () => Object.fromEntries(HSL_BANDS.map(([k]) => [k, { h: 0, s: 0, l: 0 }]));
const zeroLocalAdj = () => Object.fromEntries(LOCAL_ADJ.map(([k]) => [k, 0]));
export const identityCurve = () => [[0, 0], [1, 1]];

export function defaultState() {
  return {
    v: 1,
    adj: zeroAdj(),
    hsl: zeroHsl(),
    grade: { shadows: { h: 220, s: 0 }, mids: { h: 30, s: 0 }, highs: { h: 45, s: 0 }, balance: 0 },
    curves: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    look: { id: 'none', amount: 100 },
    geo: { rot: 0, flipH: false, flipV: false, angle: 0, persV: 0, persH: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' },
    locals: [],
    retouch: [],
    portrait: { smooth: 0, even: 0, bright: 0, tol: 50, seeds: [] }, // seeds: 肌として選んだ場所（元写真の 0〜1）
    // RAW の現像（RAW 以外の写真では使わない）。exposure: RAW の露出（EV×100）、nr: ノイズ除去、sharpen: シャープ、
    // ca: 色にじみの自動補正、vignette: 周辺の暗さの補正、distortion: ゆがみの補正（＋で樽型・－で糸巻き型を直す）
    raw: { exposure: 0, nr: 50, sharpen: 50, ca: true, vignette: 0, distortion: 0 },
    overlays: [],
    frame: { width: 0, color: '#ffffff', radius: 0, pad: 'none', padFill: 'blur', padColor: '#ffffff' },
  };
}

export function newLocal(type, id) {
  const base = { id, type, invert: false, adj: zeroLocalAdj() };
  if (type === 'brush') return { ...base, strokes: [] };
  if (type === 'linear') return { ...base, x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.55 };
  if (type === 'radial') return { ...base, cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, feather: 50 };
  if (type === 'color') return { ...base, hue: 210, range: 30, minSat: 15 };
  return { ...base, lo: 0, hi: 0.35, soft: 0.15 }; // luma
}

// ── 検証（外から来たデータを安全な形にする） ──
const num = (v, min, max, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const int = (v, min, max, d = 0) => Math.round(num(v, min, max, d));
const bool = (v) => v === true;
const color = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const str = (v, max, d = '') => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : d);
const oneOf = (v, obj, d) => (typeof v === 'string' && Object.hasOwn(obj, v) ? v : d);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

export function validCurve(pts) {
  const p = arr(pts, 16).filter((q) => Array.isArray(q) && q.length === 2).map(([x, y]) => [num(x, 0, 1), num(y, 0, 1)]).sort((a, b) => a[0] - b[0]);
  const uniq = p.filter((q, i) => i === 0 || q[0] - p[i - 1][0] > 0.005);
  return uniq.length >= 2 ? uniq : identityCurve();
}

function validLocal(l, i) {
  if (!l || typeof l !== 'object') return null;
  const type = oneOf(l.type, LOCAL_TYPES, null);
  if (!type) return null;
  const out = newLocal(type, str(l.id, 40) || `l${i}`);
  out.invert = bool(l.invert);
  for (const [k] of LOCAL_ADJ) out.adj[k] = int(l.adj?.[k], -100, 100);
  if (type === 'brush') {
    out.strokes = arr(l.strokes, MAX_STROKES).map((s) => ({
      erase: bool(s?.erase), size: num(s?.size, 0.002, 0.5, 0.05), hard: num(s?.hard, 0, 1, 0.5), flow: num(s?.flow, 0.05, 1, 1),
      pts: arr(s?.pts, 2000).filter((p) => Array.isArray(p)).map(([x, y]) => [num(x, -0.5, 1.5), num(y, -0.5, 1.5)]),
    })).filter((s) => s.pts.length);
  } else if (type === 'linear') Object.assign(out, { x1: num(l.x1, -1, 2, 0.5), y1: num(l.y1, -1, 2, 0.2), x2: num(l.x2, -1, 2, 0.5), y2: num(l.y2, -1, 2, 0.55) });
  else if (type === 'radial') Object.assign(out, { cx: num(l.cx, -1, 2, 0.5), cy: num(l.cy, -1, 2, 0.5), rx: num(l.rx, 0.01, 2, 0.3), ry: num(l.ry, 0.01, 2, 0.3), feather: int(l.feather, 0, 100, 50) });
  else if (type === 'color') Object.assign(out, { hue: num(l.hue, 0, 360, 210), range: num(l.range, 5, 90, 30), minSat: num(l.minSat, 0, 100, 15) });
  else Object.assign(out, { lo: num(l.lo, 0, 1, 0), hi: num(l.hi, 0, 1, 0.35), soft: num(l.soft, 0, 0.5, 0.15) });
  return out;
}

function validRetouch(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.type === 'heal') {
    // sx/sy（コピー元）は省略可。省略時は周りから自動で選ぶ
    const auto = !Number.isFinite(Number(r.sx)) || !Number.isFinite(Number(r.sy));
    return { type: 'heal', x: num(r.x, 0, 1), y: num(r.y, 0, 1), r: num(r.r, 0.002, 0.2, 0.02), sx: auto ? null : num(r.sx, 0, 1), sy: auto ? null : num(r.sy, 0, 1) };
  }
  if (r.type === 'mosaic' || r.type === 'blur') return { type: r.type, x: num(r.x, 0, 1), y: num(r.y, 0, 1), w: num(r.w, 0.001, 1, 0.1), h: num(r.h, 0.001, 1, 0.1), size: int(r.size, 2, 100, 20) };
  return null;
}

function validOverlay(o) {
  if (!o || typeof o !== 'object') return null;
  const base = { id: str(o.id, 40) || Math.random().toString(36).slice(2), x: num(o.x, -0.5, 1.5, 0.5), y: num(o.y, -0.5, 1.5, 0.5), rot: num(o.rot, -180, 180), opacity: num(o.opacity, 0, 1, 1) };
  if (o.type === 'text') {
    return { ...base, type: 'text', text: str(o.text, 500, 'テキスト'), size: num(o.size, 0.01, 0.5, 0.08), font: oneOf(o.font, FONTS, 'gothic'), bold: bool(o.bold), color: color(o.color, '#ffffff'), align: ['left', 'center', 'right'].includes(o.align) ? o.align : 'center', stroke: num(o.stroke, 0, 0.3), strokeColor: color(o.strokeColor, '#000000'), shadow: bool(o.shadow), bg: bool(o.bg), bgColor: color(o.bgColor, '#000000'), vertical: bool(o.vertical) };
  }
  if (o.type === 'sticker') return { ...base, type: 'sticker', emoji: str(o.emoji, 16, '⭐') || '⭐', size: num(o.size, 0.02, 0.8, 0.15) };
  if (o.type === 'draw') {
    return { ...base, type: 'draw', color: color(o.color, '#ff3b30'), width: num(o.width, 0.001, 0.1, 0.01), mode: ['pen', 'marker', 'neon'].includes(o.mode) ? o.mode : 'pen', pts: arr(o.pts, 4000).filter((p) => Array.isArray(p)).map(([x, y]) => [num(x, -0.5, 1.5), num(y, -0.5, 1.5)]) };
  }
  return null;
}

/** どんな値が来ても、正しい形の編集内容を返す */
export function validateState(s) {
  const d = defaultState();
  if (!s || typeof s !== 'object') return d;
  for (const [k, , min, max] of ADJ) d.adj[k] = int(s.adj?.[k], min, max, d.adj[k]);
  for (const [k] of HSL_BANDS) for (const c of ['h', 's', 'l']) d.hsl[k][c] = int(s.hsl?.[k]?.[c], -100, 100);
  for (const k of ['shadows', 'mids', 'highs']) d.grade[k] = { h: int(s.grade?.[k]?.h, 0, 360, d.grade[k].h), s: int(s.grade?.[k]?.s, 0, 100) };
  d.grade.balance = int(s.grade?.balance, -100, 100);
  for (const k of ['rgb', 'r', 'g', 'b']) d.curves[k] = validCurve(s.curves?.[k]);
  d.look = { id: str(s.look?.id, 40, 'none') || 'none', amount: int(s.look?.amount, 0, 100, 100) };
  const g = s.geo || {};
  d.geo = {
    rot: [0, 1, 2, 3].includes(g.rot) ? g.rot : 0, flipH: bool(g.flipH), flipV: bool(g.flipV), angle: num(g.angle, -45, 45),
    persV: int(g.persV, -100, 100), persH: int(g.persH, -100, 100), aspect: oneOf(g.aspect, ASPECTS, 'free'),
    crop: (() => { const x = num(g.crop?.x, 0, 0.99); const y = num(g.crop?.y, 0, 0.99); return { x, y, w: num(g.crop?.w, 0.01, 1 - x, 1 - x), h: num(g.crop?.h, 0.01, 1 - y, 1 - y) }; })(),
  };
  let brushes = 0;
  d.locals = arr(s.locals, MAX_LOCALS).map(validLocal).filter((l) => l && (l.type !== 'brush' || ++brushes <= MAX_BRUSH_LOCALS));
  d.retouch = arr(s.retouch, MAX_RETOUCH).map(validRetouch).filter(Boolean);
  for (const k of ['smooth', 'even', 'bright']) d.portrait[k] = int(s.portrait?.[k], 0, 100);
  d.portrait.tol = int(s.portrait?.tol, 0, 100, 50);
  d.raw.exposure = int(s.raw?.exposure, -300, 300);
  d.raw.nr = int(s.raw?.nr, 0, 100, 50); d.raw.sharpen = int(s.raw?.sharpen, 0, 100, 50); d.raw.ca = s.raw?.ca !== false;
  d.raw.vignette = int(s.raw?.vignette, -100, 100); d.raw.distortion = int(s.raw?.distortion, -100, 100);
  d.portrait.seeds = arr(s.portrait?.seeds, MAX_SKIN_SEEDS).filter((q) => Array.isArray(q)).map(([x, y]) => [num(x, 0, 1), num(y, 0, 1)]);
  d.overlays = arr(s.overlays, MAX_OVERLAYS).map(validOverlay).filter(Boolean);
  const f = s.frame || {};
  d.frame = { width: int(f.width, 0, 30), color: color(f.color, '#ffffff'), radius: int(f.radius, 0, 50), pad: oneOf(f.pad, PADS, 'none'), padFill: f.padFill === 'color' ? 'color' : 'blur', padColor: color(f.padColor, '#ffffff') };
  return d;
}

export const clone = (s) => structuredClone(s);
/** キーの順番に関係なく同じ内容か */
export function sameState(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameState(a[k], b[k]));
}

/** 「プリセット」として保存・共有する部分（写真ごとに違う切り抜き・修復・文字・部分補正は含めない。美肌の強さは含め、肌として選んだ場所は含めない） */
export function presetPart(s) {
  const { seeds, ...portrait } = s.portrait;
  return { adj: clone(s.adj), hsl: clone(s.hsl), grade: clone(s.grade), curves: clone(s.curves), look: clone(s.look), portrait: clone(portrait) };
}
export function applyPreset(s, p) {
  const v = validateState({ ...p });
  // 美肌を含まない古いプリセットでは、今の美肌をそのまま残す
  const cur = validateState(s).portrait;
  return { ...clone(s), adj: v.adj, hsl: v.hsl, grade: v.grade, curves: v.curves, look: v.look, portrait: p && typeof p.portrait === 'object' ? { ...v.portrait, seeds: cur.seeds } : cur };
}

/** 何か編集されているか（ボタンの状態や保存の判断に使う） */
export function isEdited(s) { return !sameState(validateState(s), defaultState()); }
