// テスト用（tests/e2e/photo-update.spec.js）: Worker の中から、渡された URL を読めるかを返す。
// 写真を処理する AI などの Worker には画面の CSP（connect-src 'none'）が効かないので、Service Worker が外への通信を止めていることを確かめる
self.onmessage = async ({ data: url }) => {
  try { const r = await fetch(url); self.postMessage(`ok ${r.status}`); } catch { self.postMessage('blocked'); }
};
