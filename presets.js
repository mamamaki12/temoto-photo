// フィルター（ルック）。ユーザーの調整に「足し算」で重ね、強さ（0〜100%）で効き具合を変える。
// 値は state.js の ADJ と同じ単位（-100〜100）。grade は色かぶり（h: 色相、s: 強さ）
export const LOOKS = [
  { id: 'none', name: 'オリジナル', group: 'basic' },
  { id: 'natural', name: 'ナチュラル', group: 'basic', adj: { contrast: 8, vibrance: 18, clarity: 6 } },
  { id: 'vivid', name: 'ビビッド', group: 'basic', adj: { contrast: 18, vibrance: 35, saturation: 12, clarity: 10 } },
  { id: 'bright', name: 'あかるく', group: 'basic', adj: { exposure: 18, shadows: 25, highlights: -15, vibrance: 10 } },
  { id: 'warm', name: 'あたたか', group: 'basic', adj: { temp: 28, vibrance: 10 } },
  { id: 'cool', name: 'すずしげ', group: 'basic', adj: { temp: -26, tint: 4, vibrance: 8 } },
  { id: 'film-portra', name: 'フィルム・ポートレート', group: 'film', adj: { contrast: -12, temp: 12, saturation: -10, fade: 18, grain: 18, highlights: -12 }, grade: { shadows: { h: 200, s: 12 }, highs: { h: 40, s: 14 } }, hsl: { orange: { s: -8, l: 6 } } },
  { id: 'film-fuji', name: 'フィルム・グリーン', group: 'film', adj: { contrast: 10, temp: -6, fade: 10, grain: 20, saturation: -6 }, grade: { shadows: { h: 160, s: 18 }, highs: { h: 50, s: 8 } }, hsl: { green: { h: 12, s: -15 }, blue: { s: 10 } } },
  { id: 'film-gold', name: 'ゴールド', group: 'film', adj: { temp: 32, contrast: 8, vibrance: 10, fade: 8, grain: 15, halation: 25 }, grade: { highs: { h: 42, s: 22 } } },
  { id: 'film-cine', name: 'シネマ（ティール＆オレンジ）', group: 'film', adj: { contrast: 15, saturation: -8, fade: 6, vignette: -18 }, grade: { shadows: { h: 190, s: 30 }, highs: { h: 32, s: 26 } } },
  { id: 'film-halation', name: 'ハレーション', group: 'film', adj: { halation: 60, bloom: 25, grain: 25, contrast: 6, fade: 10 } },
  { id: 'retro', name: 'レトロ70s', group: 'film', adj: { temp: 22, saturation: -15, fade: 30, grain: 30, contrast: -6, vignette: -22 }, grade: { shadows: { h: 30, s: 18 } } },
  { id: 'pastel', name: 'パステル', group: 'mood', adj: { exposure: 10, contrast: -22, saturation: -18, fade: 25, highlights: -10 }, grade: { shadows: { h: 280, s: 10 }, highs: { h: 330, s: 10 } } },
  { id: 'moody', name: 'ムーディー', group: 'mood', adj: { exposure: -12, contrast: 18, saturation: -22, clarity: 12, vignette: -30, blacks: -10 }, grade: { shadows: { h: 210, s: 20 } } },
  { id: 'night', name: 'ナイト', group: 'mood', adj: { temp: -20, contrast: 12, shadows: 15, dehaze: 15, bloom: 20 }, grade: { shadows: { h: 230, s: 25 }, highs: { h: 300, s: 10 } } },
  { id: 'food', name: 'ごはん', group: 'scene', adj: { exposure: 8, temp: 15, vibrance: 28, clarity: 10, shadows: 15 }, hsl: { orange: { s: 12 }, red: { s: 8 } } },
  { id: 'sky', name: '青空', group: 'scene', adj: { dehaze: 18, vibrance: 15, highlights: -20 }, hsl: { blue: { s: 25, l: -12 }, aqua: { s: 15 } } },
  { id: 'portrait', name: 'ポートレート', group: 'scene', adj: { clarity: -15, exposure: 5, highlights: -10, vibrance: 8 }, hsl: { orange: { s: -10, l: 10 }, red: { s: -6 } } },
  { id: 'mono', name: 'モノクロ', group: 'mono', adj: { saturation: -100, contrast: 10 } },
  { id: 'mono-hard', name: 'モノクロ（硬調）', group: 'mono', adj: { saturation: -100, contrast: 40, clarity: 25, blacks: -20, grain: 20 } },
  { id: 'mono-soft', name: 'モノクロ（軟調）', group: 'mono', adj: { saturation: -100, contrast: -18, fade: 22, grain: 12 } },
  { id: 'sepia', name: 'セピア', group: 'mono', adj: { saturation: -100, fade: 15, grain: 10 }, grade: { mids: { h: 35, s: 40 }, shadows: { h: 25, s: 20 } } },
];
export const LOOK_BY_ID = Object.fromEntries(LOOKS.map((l) => [l.id, l]));

/** ユーザーの調整にルックを重ねた「実際に使う値」を作る */
export function effective(state) {
  const look = LOOK_BY_ID[state.look.id];
  const k = (state.look.amount ?? 100) / 100;
  const out = structuredClone(state);
  if (!look || look.id === 'none' || k === 0) return out;
  for (const [key, v] of Object.entries(look.adj || {})) out.adj[key] = Math.max(-100, Math.min(100, (out.adj[key] || 0) + v * k));
  for (const [band, o] of Object.entries(look.hsl || {})) for (const [c, v] of Object.entries(o)) out.hsl[band][c] = Math.max(-100, Math.min(100, out.hsl[band][c] + v * k));
  for (const [zone, g] of Object.entries(look.grade || {})) {
    // ユーザーが色をつけていない場所はルックの色、つけている場所は強さだけ足す
    const cur = out.grade[zone];
    if (cur.s === 0) out.grade[zone] = { h: g.h, s: g.s * k }; else cur.s = Math.min(100, cur.s + g.s * k * 0.5);
  }
  return out;
}
