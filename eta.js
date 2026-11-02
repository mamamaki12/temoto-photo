/**
 * 進み具合（0〜1）の進む速さから、残り時間を見積もる（仕上げ・書き出しの「あと約◯分」）。
 * 段ごとに速さが違う（ノイズ除去は速く、iPhone のブレ補正は 1% に 30 秒かかることもある）ので、最近（window ミリ秒）の進みから見積もり、
 * 急に変わらないように少しならす。進みが少なすぎる間（minSpan 未満）は出さない（開いてすぐの見積もりは当てにならない）
 */
export function makeEta({ now = () => Date.now(), window = 45_000, minSpan = 5_000 } = {}) {
  let hist = []; let est = null;
  return {
    reset() { hist = []; est = null; },
    /** t: 進み具合 0〜1。返り値: 残りの秒数（まだ分からないときは null） */
    update(t) {
      const at = now();
      if (hist.length && t < hist[hist.length - 1].t) this.reset(); // 戻った（別の計算が始まった）
      hist.push({ t, at });
      const cut = at - window; let i = 0; while (i < hist.length - 2 && hist[i + 1].at <= cut) i++; // window の中のいちばん古い点（1 つ前まで残す）
      hist = hist.slice(i);
      const a = hist[0]; const span = at - a.at; const dt = t - a.t;
      if (span < minSpan || dt <= 0) return est;
      const left = (1 - t) * span / dt / 1000;
      est = est == null ? left : est * 0.6 + left * 0.4;
      return est;
    },
    get value() { return est; },
  };
}
/** 残りの秒数を「あと約◯分」の形に（分からないときは ''） */
export function fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 8) return 'まもなく';
  if (sec < 60) return `あと約${Math.ceil(sec / 10) * 10}秒`;
  if (sec < 3600) return `あと約${Math.ceil(sec / 60)}分`;
  return 'あと 1 時間以上';
}
