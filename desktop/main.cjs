// てもとフォトの PC 版（Windows の .exe）。Web 版と同じファイルをそのまま、この PC の中だけで動かす。
//  - アプリのファイルは app://temoto/ という、この窓の中だけの住所から出す（Web 版と同じ動き・同じ仕上がり。
//    住所が毎回同じなので、保存した編集・設定もそのまま残る）
//  - ブレ補正の AI だけは、ブラウザの WebAssembly ではなく、PC 用の ONNX Runtime で動かす（GPU があれば DirectML で）。
//    deblur-worker.js が、PC 版のときだけ app://temoto/__native/deblur に区画を送ってくる。写真は PC の外に出ない
const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// アプリのファイルの場所（開発中はリポジトリ、.exe では resources/web）
const WEB = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
const MODEL = path.join(WEB, 'vendor', 'deblur', 'nafnet-gopro-w32.onnx');
const ORIGIN = 'app://temoto';
const TILE = 256;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
};

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true, codeCache: true,
} }]);

// ── ブレ補正の AI（PC 用の ONNX Runtime）──
let ai = null; // Promise<{ session, ort, ep }>
function loadAI() {
  if (ai) return ai;
  ai = (async () => {
    const ort = require('onnxruntime-node');
    const model = fs.readFileSync(MODEL);
    // TEMOTO_EP=cpu にすると GPU を使わない（比べるとき用）
    if (process.platform === 'win32' && process.env.TEMOTO_EP !== 'cpu') {
      try {
        const session = await ort.InferenceSession.create(model, { executionProviders: ['dml'], graphOptimizationLevel: 'all' });
        // GPU の計算が正しく動くか、小さな絵で確かめる（Web 版の WebGPU と同じ確かめ方。おかしければ CPU で）
        const x = new Float32Array(3 * TILE * TILE).map((_, i) => 0.3 + 0.4 * ((i * 7919) % 97) / 97);
        const y = (await session.run({ input: new ort.Tensor('float32', x, [1, 3, TILE, TILE]) })).output.data;
        let bad = false; for (let i = 0; i < y.length; i += 101) if (!Number.isFinite(y[i]) || Math.abs(y[i] - x[i]) > 0.6) { bad = true; break; }
        if (!bad) return { session, ort, ep: 'gpu' };
        await session.release();
      } catch (e) { console.warn('GPU（DirectML）でブレ補正を動かせないので CPU で動かします', e); }
    }
    const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', interOpNumThreads: 1 });
    return { session, ort, ep: 'cpu' };
  })();
  ai.catch(() => { ai = null; });
  return ai;
}

async function nativeDeblur(req, url) {
  if (url.pathname === '/__native/deblur/info') return Response.json({ ep: (await loadAI()).ep });
  const n = +url.searchParams.get('n'); const bytes = n * 3 * TILE * TILE * 4;
  if (req.method !== 'POST' || !(n >= 1 && n <= 16)) return new Response(null, { status: 400 });
  const body = await req.arrayBuffer();
  if (body.byteLength !== bytes) return new Response(null, { status: 400 });
  const { session, ort, ep } = await loadAI();
  const t0 = performance.now();
  const out = (await session.run({ input: new ort.Tensor('float32', new Float32Array(body), [n, 3, TILE, TILE]) })).output.data;
  if (process.env.TEMOTO_LOG) console.log(`deblur ${n} tiles ${ep} ${(performance.now() - t0).toFixed(0)}ms`);
  return new Response(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), { headers: { 'Content-Type': 'application/octet-stream' } });
}

async function handle(req) {
  try {
    const url = new URL(req.url);
    if (url.host !== 'temoto') return new Response(null, { status: 404 });
    if (url.pathname.startsWith('/__native/deblur')) return await nativeDeblur(req, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB + path.sep) || rel.includes('/.') || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return new Response(null, { status: 404 });
    const data = await fs.promises.readFile(file);
    return new Response(req.method === 'HEAD' ? null : data, { headers: { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch (e) {
    return new Response(String(e?.message || e), { status: 500 });
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', handle);
  const win = new BrowserWindow({ width: 1400, height: 900, backgroundColor: '#111111', title: 'てもとフォト',
    icon: path.join(__dirname, 'icon.png'), webPreferences: { contextIsolation: true, sandbox: true } });
  // 外へのリンクは、いつものブラウザで開く（この窓は PC の中のファイルだけを見せる）
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault(); });
  win.loadURL(`${ORIGIN}/index.html`);
  loadAI().catch(() => {}); // 先に AI を読み込んでおく（ブレ補正を押したときに待たない）
});
app.on('window-all-closed', () => app.quit());
