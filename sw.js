// Service Worker: 一度開いたら、オフラインでも開けるようにする（ネットワーク優先・失敗したらキャッシュ）
const CACHE = 'temoto-photo-v57';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 顔専用 AI（87MB）は face-worker.js が自分で区切って保存している（temoto-faceai-…）。版を上げるたびにダウンロードし直さないよう残す
    for (const k of await caches.keys()) if (k !== CACHE && !k.startsWith('temoto-faceai-')) await caches.delete(k);
    await self.clients.claim();
  })());
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
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
