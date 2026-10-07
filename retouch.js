// 修復（スポット修復）・モザイク・ぼかし。元写真の画素（ImageData）を直接書き換える。
// 編集内容としては操作の一覧（state.retouch）だけを保存し、開くたびに元写真から再現する（非破壊）。

const idx = (img, x, y) => (y * img.width + x) * 4;
const clampI = (v, a, b) => Math.max(a, Math.min(b, v | 0));

/** 円の縁（リング）の画素の平均色と、各画素 */
function ring(img, cx, cy, r) {
  const pts = []; const n = Math.max(16, Math.round(r * 4));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2; const x = clampI(cx + Math.cos(a) * r, 0, img.width - 1); const y = clampI(cy + Math.sin(a) * r, 0, img.height - 1);
    const k = idx(img, x, y); pts.push([img.data[k], img.data[k + 1], img.data[k + 2]]);
  }
  return pts;
}

/** 消したい場所のまわりから、縁がいちばん似ている場所を探す（px単位） */
export function findHealSource(img, cx, cy, r) {
  const target = ring(img, cx, cy, r * 1.1);
  let best = null; let bestScore = Infinity;
  for (const dist of [2.2, 3, 4]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const sx = cx + Math.cos(a) * r * dist; const sy = cy + Math.sin(a) * r * dist;
      if (sx - r < 0 || sy - r < 0 || sx + r >= img.width || sy + r >= img.height) continue;
      const cand = ring(img, sx, sy, r * 1.1);
      let score = 0; for (let j = 0; j < target.length; j++) for (let c = 0; c < 3; c++) score += (target[j][c] - cand[j][c]) ** 2;
      score *= 1 + dist * 0.05; // 近い場所を少し優先
      if (score < bestScore) { bestScore = score; best = [sx, sy]; }
    }
    if (best) break;
  }
  return best || [clampI(cx + r * 2.5, r, img.width - r - 1), cy];
}

/**
 * スポット修復: コピー元の円を、色の差を補正しながら、縁をぼかして重ねる
 * @returns {[number, number]} 使ったコピー元（px）
 */
export function heal(img, cx, cy, r, src) {
  const [sx, sy] = src || findHealSource(img, cx, cy, r);
  const R = Math.ceil(r * 1.25);
  // 縁の平均色の差（コピー元をまわりの色に合わせる）
  const t = ring(img, cx, cy, r * 1.15); const s = ring(img, sx, sy, r * 1.15);
  const diff = [0, 1, 2].map((c) => (t.reduce((a, p) => a + p[c], 0) - s.reduce((a, p) => a + p[c], 0)) / t.length);
  const copy = new Uint8ClampedArray((2 * R + 1) ** 2 * 4);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const x = clampI(sx + dx, 0, img.width - 1); const y = clampI(sy + dy, 0, img.height - 1); const k = idx(img, x, y); const o = ((dy + R) * (2 * R + 1) + dx + R) * 4;
    copy[o] = img.data[k]; copy[o + 1] = img.data[k + 1]; copy[o + 2] = img.data[k + 2];
  }
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const x = Math.round(cx + dx); const y = Math.round(cy + dy);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const d = Math.hypot(dx, dy) / r;
    const a = d <= 0.7 ? 1 : d >= 1.25 ? 0 : 1 - (d - 0.7) / 0.55; // 縁をなめらかに
    if (a <= 0) continue;
    const k = idx(img, x, y); const o = ((dy + R) * (2 * R + 1) + dx + R) * 4;
    for (let c = 0; c < 3; c++) img.data[k + c] = img.data[k + c] * (1 - a) + (copy[o + c] + diff[c] * a) * a;
  }
  return [sx, sy];
}

/** モザイク（px単位の四角、block はモザイクの1マスの大きさ） */
export function mosaic(img, x0, y0, w, h, block) {
  const x1 = clampI(x0 + w, 0, img.width); const y1 = clampI(y0 + h, 0, img.height);
  x0 = clampI(x0, 0, img.width); y0 = clampI(y0, 0, img.height); block = Math.max(2, block | 0);
  for (let by = y0; by < y1; by += block) for (let bx = x0; bx < x1; bx += block) {
    const ex = Math.min(bx + block, x1); const ey = Math.min(by + block, y1);
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const k = idx(img, x, y); r += img.data[k]; g += img.data[k + 1]; b += img.data[k + 2]; n++; }
    r /= n; g /= n; b /= n;
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const k = idx(img, x, y); img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; }
  }
}

/** ぼかし（箱型ぼかしを3回 ≒ ガウスぼかし）。顔やナンバープレートを隠す用 */
export function blurRect(img, x0, y0, w, h, radius) {
  const X0 = clampI(x0, 0, img.width); const Y0 = clampI(y0, 0, img.height);
  const X1 = clampI(x0 + w, 0, img.width); const Y1 = clampI(y0 + h, 0, img.height);
  const W = X1 - X0; const H = Y1 - Y0; const rad = Math.max(1, radius | 0);
  if (W < 2 || H < 2) return;
  let buf = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = idx(img, X0 + x, Y0 + y); const o = (y * W + x) * 3; buf[o] = img.data[k]; buf[o + 1] = img.data[k + 1]; buf[o + 2] = img.data[k + 2]; }
  const pass = (src, horiz) => {
    const out = new Float32Array(src.length); const len = horiz ? W : H; const lines = horiz ? H : W;
    for (let l = 0; l < lines; l++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0; const at = (i) => { const j = Math.max(0, Math.min(len - 1, i)); return src[((horiz ? l * W + j : j * W + l)) * 3 + c]; };
        for (let i = -rad; i <= rad; i++) sum += at(i);
        for (let i = 0; i < len; i++) { out[(horiz ? l * W + i : i * W + l) * 3 + c] = sum / (2 * rad + 1); sum += at(i + rad + 1) - at(i - rad); }
      }
    }
    return out;
  };
  for (let i = 0; i < 3; i++) buf = pass(pass(buf, true), false);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = idx(img, X0 + x, Y0 + y); const o = (y * W + x) * 3; img.data[k] = buf[o]; img.data[k + 1] = buf[o + 1]; img.data[k + 2] = buf[o + 2]; }
}

/** 操作の一覧を、元写真の画素に順番に当てる。修復で自動選択したコピー元は ops に書き戻す（次回も同じ結果になるように） */
export function applyRetouch(img, ops) {
  const W = img.width; const H = img.height; const S = Math.min(W, H);
  for (const op of ops) {
    if (op.type === 'heal') {
      const src = op.sx != null ? [op.sx * W, op.sy * H] : null;
      const [sx, sy] = heal(img, op.x * W, op.y * H, Math.max(2, op.r * S), src);
      if (op.sx == null) { op.sx = sx / W; op.sy = sy / H; }
    } else if (op.type === 'mosaic') {
      mosaic(img, op.x * W, op.y * H, op.w * W, op.h * H, Math.max(2, (op.size / 400) * Math.max(W, H)));
    } else if (op.type === 'blur') {
      blurRect(img, op.x * W, op.y * H, op.w * W, op.h * H, Math.max(1, (op.size / 600) * Math.max(W, H)));
    }
  }
}
