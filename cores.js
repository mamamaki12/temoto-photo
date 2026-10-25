// 重い計算（暗所補正・ブレ補正の AI）に使う Worker の数。端末の CPU の数とメモリに合わせる
// iPhone・iPad はメモリが少ないので 2 つまで。スマホ（Android）は 4 つまで。
// パソコンは CPU の数 − 1 まで（12 まで）使う（前は 4 つまでだったので、CPU の多い PC ほど速くなる）。
// 区画の分け方は Worker の数によらないので、数を変えても結果は同じ。
// max: ブレ補正の AI は 1 つの Worker が 300MB ほど使うので、呼ぶ側で 6 つまでにする
export function workerCount(nav = globalThis.navigator || {}, { max = 12 } = {}) {
  const ua = nav.userAgent || '';
  const ios = /iP(hone|ad|od)/.test(ua) || (nav.maxTouchPoints > 1 && /Mac/.test(ua));
  const mobile = ios || /Android|Mobile/.test(ua);
  const cpus = (nav.hardwareConcurrency || 2) - 1;
  // メモリが少ない PC（deviceMemory は Chrome・Edge だけ。GB 単位で 8 が上限）は 4 つまで
  const cap = ios ? 2 : mobile || (nav.deviceMemory && nav.deviceMemory < 8) ? 4 : 12;
  return Math.max(1, Math.min(cap, max, cpus));
}
