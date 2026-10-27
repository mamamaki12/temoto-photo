// 被写体ブレの補正（編集画面の「被写体ブレの補正」）を、写真（Canvas）に当てる。AI の計算は deblur-worker.js で。
// 順番は「ノイズ除去 → 明るさ → ブレ補正 → 細かい粒」（粒の後にブレ補正を当てると、粒が筋になる）。
// AI は元の写真の大きさで決めた大きさ（deblurSize）で 1 回だけ動かし、直した差分を、編集用の写真にも書き出す元の大きさの写真にも足す。
import { deblurSize, applyResidual } from './deblur.js';
import { addGrain } from './restoration-lowlight.js';
import { COLOR_SPACE, ctx2d, imageData } from './color.js';
import { lowMemory } from './cores.js';

/** この編集で、ブレ補正を使うか */
export const deblurActive = (adj) => adj.deblur > 0;
/** 編集の値（0〜100）→ 強さ。50 で標準 */
export const deblurAmount = (adj) => adj.deblur / 50;
/** AI に渡す前にノイズを取るか（ノイズ軽減を標準の強さより弱くしているとき） */
export const deblurDenoise = (adj) => adj.noise < 50;

const abortError = () => new DOMException('処理を中止しました', 'AbortError');
let worker = null; // AI を読み込んだ Worker は使い回す（読み込みに時間がかかる）

/**
 * 写真（Canvas・ImageBitmap）を縮めて AI に通し、直した差分を返す
 * @param {CanvasImageSource} image ブレ補正の元にする写真（暗所補正をするなら、した後のもの）
 * @param {number} W image の幅 @param {number} H image の高さ
 * @param {number} origW 元の写真の幅 @param {number} origH 元の写真の高さ（AI に通す大きさを決める）
 * @param {{onProgress?:(t:number)=>void, onHint?:(s:string)=>void, signal?:AbortSignal, denoise?:boolean}} hooks onProgress は 0〜1。onHint: いま何をしているかの補足（'' で消す）。
 *   denoise: AI に渡す前に、縮めた絵のノイズを取る（ノイズ軽減を使っていない写真。ざらつきを AI がブレと見て格子を作るのを防ぐ）
 */
/** ブレ補正の AI を片付けて、メモリを空ける（顔専用 AI のような大きな AI を動かす前に。次に使うときは読み込み直す） */
export function releaseDeblur() { worker?.terminate(); worker = null; }

export async function deblurResidualFor(image, W, H, origW, origH, { onProgress = () => {}, onHint = () => {}, signal, denoise = false } = {}) {
  if (signal?.aborted) throw abortError();
  const { width: w, height: h } = deblurSize(origW || W, origH || H);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = ctx2d(c, { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(image, 0, 0, W, H, 0, 0, w, h);
  const px = x.getImageData(0, 0, w, h, { colorSpace: COLOR_SPACE }).data; c.width = 0; c.height = 0;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = px[i * 4] / 255; rgb[i * 3 + 1] = px[i * 4 + 1] / 255; rgb[i * 3 + 2] = px[i * 4 + 2] / 255; }
  if (!worker) worker = new Worker(new URL('./deblur-worker.js', import.meta.url), { type: 'module' });
  const wk = worker;
  return new Promise((resolve, reject) => {
    const done = (err, res) => {
      wk.onmessage = null; wk.onerror = null; signal?.removeEventListener('abort', onAbort);
      // iPhone・iPad では、終わったら AI を片付ける（次の段の計算・顔 AI とメモリを取り合わないように。次に使うときは読み込み直す）
      if (err || lowMemory()) { wk.terminate(); if (worker === wk) worker = null; }
      onHint('');
      if (err) reject(err); else resolve(res);
    };
    const onAbort = () => done(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    // 進捗: AI の読み込み（はじめての 1 回だけ時間がかかる）に 1 割、ノイズ除去に 1 割、計算に残り
    const d = denoise ? 0.1 : 0;
    wk.onmessage = ({ data: m }) => {
      if (m.type === 'progress') {
        // AI の準備（読み込んだ後の、GPU・CPU の起動。iPhone では 1 分近くかかることがある）の間は、そう伝える
        if (m.phase === 'init') onHint('ブレ補正の AI を準備しています');
        else if (m.phase === 'run' && m.t > 0) onHint('');
        onProgress(m.phase === 'load' ? 0.1 * m.t : m.phase === 'init' ? 0.1 : m.phase === 'denoise' ? 0.1 + d * m.t : 0.1 + d + (0.9 - d) * m.t);
      }
      else if (m.type === 'result') done(null, m.res);
      else if (m.type === 'error') done(new Error(m.message));
    };
    wk.onerror = () => done(new Error('ブレ補正の AI を開始・実行できませんでした（端末のメモリが足りない可能性があります）'));
    wk.postMessage({ type: 'run', small: { width: w, height: h, data: rgb }, denoise }, [rgb.buffer]);
  });
}

/**
 * 8bit の RGBA（横幅いっぱいの何行か）に、ブレ補正の差分と細かい粒を足す
 * @param {{y0:number,fullW:number,fullH:number}} at
 */
export function finishBand(data, rows, at, { res, amount, grain }) {
  if (res) applyResidual(data, rows, at, res, amount);
  if (grain > 0) addGrain(data, at.fullW, rows, at, grain);
  return data;
}

/** 写真（Canvas）にブレ補正の差分と細かい粒を足して、新しい Canvas を返す */
export async function finishCanvas(image, W, H, opts, { signal } = {}) {
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const x = ctx2d(out, { willReadFrequently: true }); x.drawImage(image, 0, 0, W, H);
  const rows = Math.max(16, Math.floor(2_000_000 / W));
  for (let y = 0; y < H; y += rows) {
    if (signal?.aborted) throw abortError();
    const n = Math.min(rows, H - y);
    const d = x.getImageData(0, y, W, n, { colorSpace: COLOR_SPACE }).data;
    finishBand(d, n, { y0: y, fullW: W, fullH: H }, opts);
    x.putImageData(imageData(d, W, n), 0, y);
    await new Promise((r) => setTimeout(r, 0)); // 画面を止めない
  }
  return out;
}
