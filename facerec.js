// 顔の見分け（本人の写真に、何人も写った写真を入れたとき、どの顔が本人かを自動で選ぶ）の計算。DOM なし。
// 顔の特徴（128 個の数）は SFace（OpenCV Zoo、Apache-2.0。facerec-worker.js）で求める。同じ人ほど、特徴の向きが近い（cos が 1 に近い）。
// 本人の手がかりは、その人の本人の写真と、編集中の写真でその人を選んだ顔。
import { applyMatrix, fitMatrix, invertMatrix, sampleF } from './faceai.js';

/** SFace に渡す顔の大きさ */
export const REC = 112;
// 両目（黒目）・鼻先・口角の 5 点を、SFace が学んだ位置（ArcFace と同じ並べ方。112×112）に合わせる
const REC_IDX = [468, 473, 4, 61, 291];
const REC_TPL = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041];

/**
 * 512 に切り出した顔（RGB の Float32Array、0〜255）と、その上の顔の点 → SFace の入力（RGB の面ごと、0〜255、112×112）。
 * 縮めるときにざらつき（ノイズ）が残らないよう、1 画素を 4×4 点の平均にする
 */
export function recInput(crop, pts, size = 512) {
  const inv = invertMatrix(fitMatrix(pts, REC_IDX, REC_TPL)); const n = REC * REC; const out = new Float32Array(3 * n); const px = [0, 0, 0];
  for (let v = 0; v < REC; v++) {
    for (let u = 0; u < REC; u++) {
      let r = 0; let g = 0; let b = 0;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const [x, y] = applyMatrix(inv, u - 0.375 + i * 0.25, v - 0.375 + j * 0.25);
          sampleF(crop, size, size, 3, x, y, px, 0); r += px[0]; g += px[1]; b += px[2];
        }
      }
      const o = v * REC + u; out[o] = r / 16; out[n + o] = g / 16; out[2 * n + o] = b / 16;
    }
  }
  return out;
}

/** 長さ 1 にした特徴どうしの近さ（−1〜1） */
export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
export function normalize(e) { let s = 0; for (const v of e) s += v * v; s = Math.sqrt(s) || 1; return Float32Array.from(e, (v) => v / s); }

/**
 * 顔の特徴が、手がかり（同じ人の特徴の並び）にどれだけ近いか。近い順に 3 つの平均
 * （1 枚だけ似た別人に引っ張られにくく、本人の写真が増えるほど確かになる）
 */
export function personScore(e, seeds) {
  if (!seeds.length) return -1;
  const s = seeds.map((q) => cosine(e, q)).sort((a, b) => b - a);
  const k = Math.min(3, s.length); let t = 0; for (let i = 0; i < k; i++) t += s[i];
  return t / k;
}

/** まとまりの本人らしさがこれ以上なら本人（テスト写真 86 枚・6 人で調べた値。docs/faceai-handoff.md） */
export const SAME = 0.5;
/** 本人の顔と、同じ写真の次に本人らしい顔の差がこれより小さければ、見分けられない（使う人に選んでもらう） */
export const MARGIN = 0.05;
/** 入れた写真の顔どうしを、同じ人のまとまりにする近さ */
export const LINK = 0.4;

/**
 * 顔を、同じ人らしいまとまりに分ける（平均連結。まとまりどうしの全部の組の近さの平均が LINK より大きい間、いちばん近いものからつなぐ）。
 * 同じ写真に写った顔は、別の人なので同じまとまりにしない
 * @param {Float32Array[]} embs 顔の特徴
 * @param {number[]} photo 顔ごとの写真の番号
 * @returns {number[]} 顔ごとのまとまりの番号
 */
export function groupFaces(embs, photo) {
  const n = embs.length; const S = new Float64Array(n * n); const size = new Array(n).fill(1); const alive = new Array(n).fill(true);
  const ph = photo.map((p) => new Set([p])); const id = embs.map((_, i) => i);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i * n + j] = i === j || photo[i] === photo[j] ? -Infinity : cosine(embs[i], embs[j]);
  for (;;) {
    let best = LINK; let a = -1; let b = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) if (alive[j] && S[i * n + j] > best) { best = S[i * n + j]; a = i; b = j; }
    }
    if (a < 0) break;
    for (const p of ph[b]) ph[a].add(p);
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === a || k === b) continue;
      const v = [...ph[k]].some((p) => ph[a].has(p)) ? -Infinity : (S[a * n + k] * size[a] + S[b * n + k] * size[b]) / (size[a] + size[b]);
      S[a * n + k] = v; S[k * n + a] = v;
    }
    size[a] += size[b]; alive[b] = false;
    for (let i = 0; i < n; i++) if (id[i] === b) id[i] = a;
  }
  return id;
}

/**
 * 写真ごとの顔の特徴から、本人の顔を選ぶ。
 * 1 つの顔と手がかりの近さだけで決めると、暗い写真の顔が手がかりのときに間違えやすいので、入れた写真の顔を同じ人のまとまりに分け、
 * まとまりの顔の本人らしさの平均で決める（同じ人が何枚にも写っていれば、1 枚ずつのぶれが打ち消し合う）
 * @param {Float32Array[][]} photos 写真ごとの、写っている顔の特徴
 * @param {Float32Array[]} seeds 本人の手がかり
 * @param {Float32Array[][]} others ほかの人ごとの手がかり（ほかの人の方が近いまとまりの顔は選ばない）
 * @returns {{pick:number, guess:number, score:number}[]} 写真ごと。pick: 本人の顔の番号（決められなければ −1）、
 *   guess: いちばん本人らしい顔（選んでもらうときに先に選んでおく。なければ −1）、score: その本人らしさ
 */
export function findPerson(photos, seeds, others = []) {
  if (!seeds.length) return photos.map(() => ({ pick: -1, guess: -1, score: -1 }));
  const embs = photos.flat(); const photo = photos.flatMap((fs, i) => fs.map(() => i));
  const id = groupFaces(embs, photo);
  const mean = (vals) => { const sum = new Map(); const cnt = new Map(); id.forEach((g, i) => { sum.set(g, (sum.get(g) || 0) + vals[i]); cnt.set(g, (cnt.get(g) || 0) + 1); }); return (i) => sum.get(id[i]) / cnt.get(id[i]); };
  const own = mean(embs.map((e) => personScore(e, seeds)));
  const other = mean(embs.map((e) => Math.max(-1, ...others.map((o) => personScore(e, o)))));
  let o = 0;
  return photos.map((fs) => {
    const s = fs.map((_, k) => own(o + k)); const base = o; o += fs.length;
    if (!fs.length) return { pick: -1, guess: -1, score: -1 };
    const order = s.map((_, k) => k).sort((a, b) => s[b] - s[a]); const best = order[0]; const second = order.length > 1 ? s[order[1]] : -1;
    const ok = s[best] >= SAME && s[best] - second >= MARGIN && s[best] > other(base + best);
    return { pick: ok ? best : -1, guess: s[best] >= SAME * 0.7 ? best : -1, score: s[best] };
  });
}
