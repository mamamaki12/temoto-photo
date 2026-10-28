// Service Worker: 一度開いたら、オフラインでも開けるようにする（ネットワーク優先・失敗したらキャッシュ）
const CACHE = 'temoto-photo-v101';
const VERSION = '1.35.10'; // app.js の VERSION と同じにする（アプリの「更新」が、これと画面の版を比べる）
// vendor/ の大きなファイル（AI のモデル・WebAssembly。全部で 100MB ほど）は、版を上げても残す別のキャッシュに入れる
// （前は版を上げるたびに消していたので、更新のたびに数十 MB をダウンロードし直し、電波の悪い所では AI の読み込みで止まって見えた）。
// 名前の後ろは vendor/ の中身の指紋（tests/unit/version.test.js が確かめる。vendor/ を変えたら、テストが出す値に書き換える）
const VENDOR_CACHE = 'temoto-vendor-100b527c';
const NET_WAIT = 5000; // サーバーの返事をこれだけ待って来なければ、キャッシュを使う（下の fetch）

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 顔専用 AI（87MB）は face-worker.js が自分で区切って保存している（temoto-faceai-…）。版を上げるたびにダウンロードし直さないよう残す
    for (const k of await caches.keys()) if (k !== CACHE && k !== VENDOR_CACHE && !k.startsWith('temoto-faceai-')) await caches.delete(k);
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
  // vendor/ の大きなファイル（AI のモデル・WebAssembly）は、キャッシュにあればそれを使う（毎回ダウンロードしない。vendor/ を変えたら VENDOR_CACHE の名前が変わって入れ替わる）
  if (new URL(req.url).pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      const hit = await (await caches.open(VENDOR_CACHE)).match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VENDOR_CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    })());
    return;
  }
  e.respondWith((async () => {
    // ブラウザの HTTP キャッシュ（GitHub Pages は10分）を使わず、毎回サーバーに確かめる（変わっていなければ 304 で軽い）。
    // こうしないと、更新したあと一部のファイルだけ古い版が混ざることがある
    const net = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    });
    net.catch(() => {}); // キャッシュを返したあとで失敗しても、何もしない
    const fromCache = async () => (await caches.open(CACHE)).match(req, { ignoreSearch: true });
    try {
      // 電波が悪いと、サーバーへの確かめが失敗もせずに止まったままになる（画面の部品や計算の Worker が読み込めず、進捗バーが止まる）。
      // NET_WAIT ミリ秒待っても返事がなく、今の版のキャッシュにあれば、それを使う（今の版のキャッシュなので、版は混ざらない）
      const slow = new Promise((r) => setTimeout(r, NET_WAIT)).then(fromCache);
      const first = await Promise.race([net, slow]);
      return first || await net;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
