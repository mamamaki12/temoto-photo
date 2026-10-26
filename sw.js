// Service Worker: 一度開いたら、オフラインでも開けるようにする（ネットワーク優先・失敗したらキャッシュ）
const CACHE = 'temoto-photo-v66';
const VERSION = '1.30.1'; // app.js の VERSION と同じにする（アプリの「更新」が、これと画面の版を比べる）

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 顔専用 AI（87MB）は face-worker.js が自分で区切って保存している（temoto-faceai-…）。版を上げるたびにダウンロードし直さないよう残す
    for (const k of await caches.keys()) if (k !== CACHE && !k.startsWith('temoto-faceai-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 画面から「今の版は？」と聞かれたら答える（新しい sw.js が入ったのに、画面が古いままかを確かめる）
self.addEventListener('message', (e) => {
  if (e.data?.type === 'version') e.ports[0]?.postMessage({ version: VERSION, cache: CACHE });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // 一部だけの読み込み（顔専用 AI のダウンロード）は、そのままネットワークへ（ここで丸ごと保存すると、87MB をメモリに抱えてしまう）
  if (req.headers.has('range')) return;
  // vendor/ の大きなファイル（AI のモデル・WebAssembly）は、キャッシュにあればそれを使う（毎回ダウンロードしない。更新は CACHE の名前を変えて入れ替える）
  if (new URL(req.url).pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })());
    return;
  }
  e.respondWith((async () => {
    try {
      // ブラウザの HTTP キャッシュ（GitHub Pages は10分）を使わず、毎回サーバーに確かめる（変わっていなければ 304 で軽い）。
      // こうしないと、更新したあと一部のファイルだけ古い版が混ざることがある
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
