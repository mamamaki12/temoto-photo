/**
 * 計算している間、画面が消えないようにする（Screen Wake Lock。iPhone は Safari 16.4 から、Android の Chrome も使える）。
 * スマホは画面が消えると計算が止まり（タブが眠る）、iPhone では戻ったときにアプリが読み込み直されて、仕上げ・書き出しが一からになることがあった。
 * 画面が消えている間・隠れている間は取れないので、戻ったときに取り直す。対応していない端末では何もしない
 */
export function makeScreenHold({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  let lock = null; let holders = 0; let busy = null;
  const drop = () => { const l = lock; lock = null; l?.release().catch(() => {}); };
  const acquire = () => {
    if (lock || busy || !holders || !nav?.wakeLock || (doc && doc.visibilityState !== 'visible')) return;
    busy = nav.wakeLock.request('screen').then((l) => {
      lock = l; l.addEventListener?.('release', () => { if (lock === l) lock = null; });
    }, () => {}).finally(() => { busy = null; if (!holders) drop(); });
  };
  doc?.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'visible') acquire(); });
  return {
    /** 画面を消さないでおく。返す関数を呼ぶと終わる（何度呼んでもよい。ほかに使っている所があれば、そちらが終わるまで持つ） */
    hold() {
      holders++; acquire(); let done = false;
      return () => { if (done) return; done = true; if (--holders <= 0) { holders = 0; drop(); } };
    },
    /** 今、画面を消さないでいるか（テスト用） */
    get held() { return !!lock; },
    get holders() { return holders; },
  };
}
const screen = makeScreenHold();
/** 画面を消さないでおく（計算・書き出しの間）。返す関数で終わる */
export const holdScreen = () => screen.hold();
