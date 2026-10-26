/** メモリの少ない端末（iPhone・iPad）か */
export function lowMemory(nav = globalThis.navigator || {}) {
  const ua = nav.userAgent || '';
  return /iP(hone|ad|od)/.test(ua) || (nav.maxTouchPoints > 1 && /Mac/.test(ua));
}

/**
 * ONNX Runtime（WebAssembly）がはじめに予約するメモリの上限を、この AI が使う量にする（iPhone・iPad だけ。AI の Worker の最初で呼ぶ）。
 * 元のままだと AI 1 つにつき 4GB を予約するので、iPhone では AI を何個か起動すると「RangeError: Out of memory」になる。
 * vendor/ort/ort-wasm-simd-threaded.asyncify.mjs に手を入れて、ORT_WASM_MAX_PAGES を読ませている（ORT を入れ替えたら、入れ直す）
 * @param {number} mb この AI が使う量（測った値に余裕を足したもの。足りないと AI が失敗する）
 */
export function limitOrtMemory(mb, scope = globalThis) {
  if (lowMemory(scope.navigator)) scope.ORT_WASM_MAX_PAGES = Math.ceil(mb * 16); // 1 ページ 64KB
}
/** AI の失敗が、メモリ不足によるものか */
export const outOfMemory = (e) => /memory|bad_alloc|no available backend/i.test(String(e?.message || e));

// 重い計算（暗所補正・ブレ補正の AI）に使う Worker の数。端末の CPU の数とメモリに合わせる
// iPhone・iPad はメモリが少ないので 2 つまで。スマホ（Android）は 4 つまで。
// パソコンは CPU の数 − 1 まで（12 まで）使う（前は 4 つまでだったので、CPU の多い PC ほど速くなる）。
// 区画の分け方は Worker の数によらないので、数を変えても結果は同じ。
// max: ブレ補正の AI は 1 つの Worker が 300MB ほど使うので、呼ぶ側で 6 つまでにする
export function workerCount(nav = globalThis.navigator || {}, { max = 12 } = {}) {
  const ua = nav.userAgent || '';
  const ios = lowMemory(nav);
  const mobile = ios || /Android|Mobile/.test(ua);
  const cpus = (nav.hardwareConcurrency || 2) - 1;
  // メモリが少ない PC（deviceMemory は Chrome・Edge だけ。GB 単位で 8 が上限）は 4 つまで
  const cap = ios ? 2 : mobile || (nav.deviceMemory && nav.deviceMemory < 8) ? 4 : 12;
  return Math.max(1, Math.min(cap, max, cpus));
}
