// 人物の肌（顔・首・腕・手）を、AI（MediaPipe の人物の部位分け）で見分ける。端末の中だけで動く（vendor/mediapipe/）。
// 美肌は、色で決めた肌らしさにこの結果を掛けて、髪・服・背景（肌に似た色の壁・カーディガンなど）を外す。
// 結果は、写真（編集用の大きさの画素）の指紋ごとに覚えておき、美肌の計算（同期）から取り出す。
const MAX_SIDE = 768; // AI に渡す大きさ（モデルの中は 256×256。輪郭は渡した大きさで返る）
let worker = null; let seq = 0; const waiting = new Map();
const store = new Map(); // 指紋 → { m, w, h }

/** 画像の指紋（大きさと、まばらに選んだ画素） */
export function fingerprint(img) {
  const { width: W, height: H, data: d } = img; let h = (W * 73856093) ^ (H * 19349663);
  for (let i = 0; i < 97; i++) { const x = Math.floor(((i * 37) % 97) / 97 * W); const y = Math.floor(i / 97 * H); const k = (y * W + x) * 4; h = Math.imul(h ^ (d[k] | (d[k + 1] << 8) | (d[k + 2] << 16)), 16777619); }
  return `${W}x${H}:${h >>> 0}`;
}
/** 覚えている肌の地図（なければ null） */
export const skinSegFor = (img) => store.get(fingerprint(img)) || null;

const TIMEOUT = 90000; // これより長く返事がなければ、AI をあきらめる（端末のメモリが足りず Worker が止まったときなど。色で判定する）
function stopWorker(why) {
  worker?.terminate(); worker = null;
  for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error(why)); }
  waiting.clear();
}
/** 顔・肌を見つける AI を片付けて、メモリを空ける（使っていないときだけ。次に使うときは読み込み直す） */
export function releaseSkinSeg() { if (!waiting.size) stopWorker('release'); }
function call(msg, transfer) {
  if (!worker) {
    worker = new Worker(new URL('vendor/mediapipe/seg-worker.js', import.meta.url));
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); clearTimeout(w.timer); if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data); };
    worker.onerror = (e) => stopWorker(e.message || 'worker error');
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, timer: setTimeout(() => stopWorker('AI の返事がありません'), TIMEOUT) });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

/**
 * 写真の肌の地図を作って覚える（すでにあれば何もしない）。img: 編集用の大きさの画素（ImageData など）
 * @returns {Promise<boolean>} 使えるようになったか（読み込めない端末では false。そのときは色だけで判定する）
 */
export async function ensureSkinSeg(img) {
  const key = fingerprint(img); if (store.has(key)) return true;
  try {
    const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
    const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, w, h);
    const small = x2.getImageData(0, 0, w, h);
    const r = await call({ kind: 'skin', w, h, data: small.data }, [small.data.buffer]);
    store.set(key, { m: r.skin, w: r.w, h: r.h });
    if (store.size > 8) store.delete(store.keys().next().value);
    return true;
  } catch (e) { console.warn('人物の肌を見分ける AI を使えませんでした（色だけで判定します）', e); return false; }
}

/**
 * 人物（背景でない所。髪・肌・服）の地図。暗い写真の補正で、人物と背景の色の直し方を変えるのに使う。
 * img: 小さく縮めた写真の画素（長い辺 512 くらい）。使えない端末では null
 * @returns {Promise<{m:Float32Array,w:number,h:number}|null>}
 */
const personStore = new Map();
export async function personSeg(img) {
  const key = fingerprint(img); if (personStore.has(key)) return personStore.get(key);
  try {
    const { width: w, height: h, data } = img;
    const run = async (ox, oy, cw, ch) => {
      const c = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) c.set(data.subarray(((oy + y) * w + ox) * 4, ((oy + y) * w + ox + cw) * 4), y * cw * 4);
      return call({ kind: 'person', w: cw, h: ch, data: c }, [c.buffer]);
    };
    // AI は正方形の 256×256 で見るので、全身の縦長の写真だと、スカートや脚・広がった髪を見落とす。
    // 写真全体と、正方形に近い一部ずつ（半分ずつ重ねて）にも当てて、大きい方をとる。一部の内側の端は、なだらかに弱める
    const full = await run(0, 0, w, h); const m = new Float32Array(w * h);
    const at = (r, x, y, cw, ch) => r.skin[Math.min(r.h - 1, Math.floor(y * r.h / ch)) * r.w + Math.min(r.w - 1, Math.floor(x * r.w / cw))];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = at(full, x, y, w, h);
    const S = Math.min(w, h); const L = Math.max(w, h); const steps = Math.ceil((L - S) / (S / 2));
    for (let k = 0; k <= steps && L > S * 1.1; k++) {
      const off = Math.round((L - S) * k / steps); const tall = h > w;
      const ox = tall ? 0 : off; const oy = tall ? off : 0; const cw = tall ? w : S; const ch = tall ? S : h;
      const r = await run(ox, oy, cw, ch); const fe = S * 0.12;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const t = tall ? y : x; // 一部の端からの距離（写真の端と重なる側は弱めない）
        const ramp = Math.min(1, off > 0 ? t / fe : 1, off + S < L ? (S - 1 - t) / fe : 1);
        const i = (oy + y) * w + ox + x; m[i] = Math.max(m[i], at(r, x, y, cw, ch) * ramp);
      }
    }
    const v = { m, w, h };
    personStore.set(key, v); if (personStore.size > 8) personStore.delete(personStore.keys().next().value);
    return v;
  } catch (e) { console.warn('人物を見分ける AI を使えませんでした', e); return null; }
}

/**
 * 写真の一部（box: 写真全体に対する 0〜1 の [x0, y0, x1, y1]）の人物の地図を、n×n に縮めて保存できる形にする
 * （形を整えるブラシが、背景を動かさないために使う。{ b: box, n, d: base64 の n×n（0〜255 = 人物らしさ） }）。
 * 切り出して AI に渡すので、写真全体を渡すより顔のまわりの輪郭が細かく出る。使えない端末では null
 */
const personMapStore = new Map();
export async function personMap(img, box, n = 64) {
  const W = img.width; const H = img.height;
  const x0 = Math.max(0, Math.round(box[0] * W)); const y0 = Math.max(0, Math.round(box[1] * H));
  const cw = Math.min(W, Math.round(box[2] * W)) - x0; const ch = Math.min(H, Math.round(box[3] * H)) - y0;
  if (cw < 4 || ch < 4) return null;
  const key = `${fingerprint(img)}|${x0},${y0},${cw},${ch},${n}`; if (personMapStore.has(key)) return personMapStore.get(key);
  try {
    const src = new OffscreenCanvas(W, H); src.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, W, H), 0, 0);
    const sc = Math.min(1, 512 / Math.max(cw, ch)); const w = Math.max(1, Math.round(cw * sc)); const h = Math.max(1, Math.round(ch * sc));
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(src, x0, y0, cw, ch, 0, 0, w, h);
    const small = x2.getImageData(0, 0, w, h);
    const r = await call({ kind: 'person', w, h, data: small.data }, [small.data.buffer]);
    // n×n に縮める（升目の平均）
    const sum = new Float32Array(n * n); const cnt = new Float32Array(n * n);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const i = Math.min(n - 1, Math.floor(y * n / r.h)) * n + Math.min(n - 1, Math.floor(x * n / r.w)); sum[i] += r.skin[y * r.w + x]; cnt[i]++; }
    let bin = ''; for (let i = 0; i < n * n; i++) bin += String.fromCharCode(Math.round(255 * (cnt[i] ? sum[i] / cnt[i] : 0)));
    const v = { b: [x0 / W, y0 / H, (x0 + cw) / W, (y0 + ch) / H], n, d: btoa(bin) };
    personMapStore.set(key, v); if (personMapStore.size > 32) personMapStore.delete(personMapStore.keys().next().value);
    return v;
  } catch (e) { console.warn('人物を見分ける AI を使えませんでした（背景も動きます）', e); return null; }
}
/**
 * 写真（小さめの画素。AI の中は 256×256）の部位ごとの地図。0 背景・1 髪・2 体の肌・3 顔の肌・4 服・5 そのほか（ティアラなどの飾りも入る）。
 * 返すのは { w, h, parts }（部位 k の値は parts[k·w·h + y·w + x]）。使えない端末では null
 */
export async function segParts(img) {
  try { const r = await call({ kind: 'parts', w: img.width, h: img.height, data: new Uint8ClampedArray(img.data) }); return { w: r.w, h: r.h, parts: r.parts }; }
  catch (e) { console.warn('部位を見分ける AI を使えませんでした', e); return null; }
}
/**
 * 顔の肌の地図（segParts の「顔の肌」）。暗い写真の自動の明るさで、顔の明るさを測るのに使う。
 * img: 小さく縮めた写真の画素（長い辺 512 くらい）。使えない端末では null
 * @returns {Promise<{m:Float32Array,w:number,h:number}|null>}
 */
const faceSkinStore = new Map();
export async function faceSeg(img) {
  const key = fingerprint(img); if (faceSkinStore.has(key)) return faceSkinStore.get(key);
  const r = await segParts(img);
  const v = r && { m: r.parts.slice(3 * r.w * r.h, 4 * r.w * r.h), w: r.w, h: r.h };
  if (v) { faceSkinStore.set(key, v); if (faceSkinStore.size > 8) faceSkinStore.delete(faceSkinStore.keys().next().value); }
  return v;
}
/** 人物を見分ける AI を先に読み込んでおく（形を整えるブラシを開いたとき。なぞり始めで待たないように） */
let warmed = null;
export function warmPersonSeg() {
  if (!warmed) warmed = call({ kind: 'person', w: 8, h: 8, data: new Uint8ClampedArray(8 * 8 * 4) }).catch(() => { warmed = null; });
  return warmed;
}

/** 地図の値（双一次補間）。u, v は写真全体に対する 0〜1 */
export function segAt(seg, u, v) {
  const fx = Math.min(seg.w - 1, Math.max(0, u * seg.w - 0.5)); const fy = Math.min(seg.h - 1, Math.max(0, v * seg.h - 0.5));
  const x0 = fx | 0; const y0 = fy | 0; const x1 = Math.min(seg.w - 1, x0 + 1); const y1 = Math.min(seg.h - 1, y0 + 1); const tx = fx - x0; const ty = fy - y0; const m = seg.m;
  const a = m[y0 * seg.w + x0] + (m[y0 * seg.w + x1] - m[y0 * seg.w + x0]) * tx; const b = m[y1 * seg.w + x0] + (m[y1 * seg.w + x1] - m[y1 * seg.w + x0]) * tx;
  return a + (b - a) * ty;
}

const lipStore = new Map(); // 指紋 → 唇の輪郭の一覧
/**
 * 写真の中の顔ごとの唇の輪郭（外側・内側。写真全体に対する 0〜1 の座標）を AI で見つける。見つからなければ []、使えなければ null
 */
export async function findLips(img) {
  const key = fingerprint(img); if (lipStore.has(key)) return lipStore.get(key);
  try {
    const s = Math.min(1, 1280 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
    const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, w, h);
    const small = x2.getImageData(0, 0, w, h);
    const r = await call({ kind: 'lips', w, h, data: small.data }, [small.data.buffer]);
    lipStore.set(key, r.lips); if (lipStore.size > 8) lipStore.delete(lipStore.keys().next().value);
    return r.lips;
  } catch (e) { console.warn('唇を見つける AI を使えませんでした（色で判定します）', e); return null; }
}

const partStore = new Map(); // 種類と指紋と切り出した所 → 見つけたものの一覧
/**
 * なぞった所（目印）のそばの顔の部位を AI で見つける（findMouth・findEyes の中身）。
 * 舞台や集合写真では顔が小さく、写真全体を縮めて AI に渡すと見つからないので、なぞった所のまわりを
 * 狭い方から順に切り出して渡す（顔がまるごと入る大きさになったところで見つかる）。最後に写真全体でも探す。
 * kind: Worker に頼む種類、key: 返事の中の一覧の名前、back(item, fn): 座標を写真全体の 0〜1 に戻す、
 * bbox(item): 部位を囲む四角 [x0, y0, x1, y1]（0〜1）
 */
async function findPart(img, pts, r, { kind, key, back, bbox, whole }) {
  const W = img.width; const H = img.height; const S = Math.min(W, H);
  const xs = pts.map((q) => q[0] * W); const ys = pts.map((q) => q[1] * H); const rp = r * S;
  const box = [Math.min(...xs) - rp, Math.min(...ys) - rp, Math.max(...xs) + rp, Math.max(...ys) + rp];
  const cx = (box[0] + box[2]) / 2; const cy = (box[1] + box[3]) / 2;
  const s = Math.max(box[2] - box[0], box[3] - box[1], S * 0.01);
  // 目印に重なるもののうち、目印の真ん中にいちばん近いもの
  const pick = (items) => {
    let best = null; let bd = Infinity;
    for (const it of items) {
      const [bx0, by0, bx1, by1] = bbox(it); const x0 = bx0 * W; const x1 = bx1 * W; const y0 = by0 * H; const y1 = by1 * H; const pad = (x1 - x0) * 0.25;
      if (x1 + pad < box[0] || x0 - pad > box[2] || y1 + pad < box[1] || y0 - pad > box[3]) continue;
      const d = Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy);
      if (d < bd) { bd = d; best = it; }
    }
    return best ? [best] : [];
  };
  let src = null; let ok = false;
  for (const k of [5, 10, 20, 40]) {
    const side = s * k; if (side > Math.max(W, H) * 1.2) break;
    const x0 = Math.max(0, Math.round(cx - side / 2)); const y0 = Math.max(0, Math.round(cy - side / 2));
    const cw = Math.min(W, Math.round(cx + side / 2)) - x0; const ch = Math.min(H, Math.round(cy + side / 2)) - y0;
    if (cw < 16 || ch < 16) continue;
    const sk = `${kind}|${fingerprint(img)}|${x0},${y0},${cw},${ch}`;
    let items = partStore.get(sk);
    if (!items) {
      try {
        if (!src) { src = new OffscreenCanvas(W, H); src.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, W, H), 0, 0); }
        // AI に渡す大きさ: 長い辺 384〜768（小さく切り出したときは拡大する。顔の点は渡した大きさの中の割合で返る）
        const sc = Math.min(768, Math.max(384, Math.max(cw, ch))) / Math.max(cw, ch);
        const w = Math.max(1, Math.round(cw * sc)); const h = Math.max(1, Math.round(ch * sc));
        const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(src, x0, y0, cw, ch, 0, 0, w, h);
        const small = x2.getImageData(0, 0, w, h);
        const res = await call({ kind, w, h, data: small.data }, [small.data.buffer]);
        const fn = (q) => [(x0 + q[0] * cw) / W, (y0 + q[1] * ch) / H];
        items = res[key].map((it) => back(it, fn));
        partStore.set(sk, items); if (partStore.size > 64) partStore.delete(partStore.keys().next().value);
        ok = true;
      } catch (e) { console.warn('顔を見つける AI を使えませんでした', e); return null; }
    } else ok = true;
    const got = pick(items); if (got.length) return got;
  }
  const all = await whole(img); if (!all) return ok ? [] : null;
  return pick(all);
}
const lipsBack = (l, fn) => ({ outer: l.outer.map(fn), inner: l.inner.map(fn) });
const polyBox = (polys) => { let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0; for (const p of polys) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
/**
 * なぞった所（目印）のそばの口（唇の外側・内側の輪郭。写真全体に対する 0〜1 の座標）を AI で見つける。
 * pts: なぞった線（0〜1）、r: ブラシの半径（短い辺に対する割合）
 * @returns {Promise<{outer:number[][],inner:number[][]}[]|null>} 見つからなければ []、AI を使えなければ null
 */
export const findMouth = (img, pts, r = 0) => findPart(img, pts, r, { kind: 'lips', key: 'lips', back: lipsBack, bbox: (l) => polyBox([l.outer]), whole: findLips });

const eyesBack = (f, fn) => f.map((e) => ({ lid: e.lid.map(fn), iris: e.iris.map(fn), pose: e.pose }));
/** 写真全体の中の、顔ごとの両目（findEyes の最後の手段） */
async function findAllEyes(img) {
  try {
    const s = Math.min(1, 1280 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
    const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, w, h);
    const small = x2.getImageData(0, 0, w, h);
    return (await call({ kind: 'eyes', w, h, data: small.data }, [small.data.buffer])).eyes;
  } catch (e) { console.warn('目を見つける AI を使えませんでした', e); return null; }
}
/**
 * なぞった所（目印）のそばの顔の両目（まぶたのふち 16 点と、黒目の中心と上右下左の 4 点。写真全体に対する 0〜1 の座標）を AI で見つける。
 * 目印は顔のどこでもよい（目のあたりが確実）。
 * 各目に pose: 顔の向き [yaw, pitch]（ラジアン。写真の右・上を向いていると正）
 * @returns {Promise<{lid:number[][],iris:number[][],pose:number[]}[][]|null>} [[右目, 左目]]。見つからなければ []、AI を使えなければ null
 */
export const findEyes = (img, pts, r = 0) => findPart(img, pts, r, { kind: 'eyes', key: 'eyes', back: eyesBack, bbox: (f) => { const b = polyBox(f.map((e) => e.lid)); const w = b[2] - b[0]; return [b[0] - w * 0.3, b[1] - w * 0.6, b[2] + w * 0.3, b[3] + w * 0.9]; }, whole: findAllEyes });

const faceStore = new Map(); // 指紋と切り出した所 → 顔の点の一覧
/**
 * なぞった所（目印）に重なる顔の 478 点（写真全体に対する 0〜1 の座標。z は奥行き）を AI で見つける。
 * findMouth と同じく、なぞった所のまわりを狭い方から順に切り出して渡す（集合写真の小さな顔でも見つかる）。
 * pts: なぞった線（0〜1）、r: ブラシの半径（短い辺に対する割合）
 * @returns {Promise<number[][]|null|undefined>} 見つかった顔の点。見つからなければ undefined、AI を使えなければ null
 */
export async function findFaceAt(img, pts, r = 0) {
  const W = img.width; const H = img.height; const S = Math.min(W, H);
  const xs = pts.map((q) => q[0] * W); const ys = pts.map((q) => q[1] * H); const rp = r * S;
  const box = [Math.min(...xs) - rp, Math.min(...ys) - rp, Math.max(...xs) + rp, Math.max(...ys) + rp];
  const cx = (box[0] + box[2]) / 2; const cy = (box[1] + box[3]) / 2;
  const s = Math.max(box[2] - box[0], box[3] - box[1], S * 0.01);
  // 目印を含む顔（顔の点を囲む四角に入る）のうち、鼻先（4 番）が目印の真ん中にいちばん近いもの
  const pick = (faces) => {
    let best; let bd = Infinity;
    for (const f of faces) {
      const fx = f.map((q) => q[0] * W); const fy = f.map((q) => q[1] * H);
      if (cx < Math.min(...fx) || cx > Math.max(...fx) || cy < Math.min(...fy) || cy > Math.max(...fy)) continue;
      const d = Math.hypot(f[4][0] * W - cx, f[4][1] * H - cy); if (d < bd) { bd = d; best = f; }
    }
    return best;
  };
  let src = null;
  for (const k of [6, 12, 24, 48]) {
    const side = Math.min(s * k, Math.max(W, H));
    const x0 = Math.max(0, Math.round(cx - side / 2)); const y0 = Math.max(0, Math.round(cy - side / 2));
    const cw = Math.min(W, Math.round(cx + side / 2)) - x0; const ch = Math.min(H, Math.round(cy + side / 2)) - y0;
    if (cw < 16 || ch < 16) continue;
    const key = `${fingerprint(img)}|${x0},${y0},${cw},${ch}`;
    let faces = faceStore.get(key);
    if (!faces) {
      try {
        if (!src) { src = new OffscreenCanvas(W, H); src.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, W, H), 0, 0); }
        const sc = Math.min(768, Math.max(384, Math.max(cw, ch))) / Math.max(cw, ch);
        const w = Math.max(1, Math.round(cw * sc)); const h = Math.max(1, Math.round(ch * sc));
        const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(src, x0, y0, cw, ch, 0, 0, w, h);
        const small = x2.getImageData(0, 0, w, h);
        const res = await call({ kind: 'face', w, h, data: small.data }, [small.data.buffer]);
        // z は切り出した幅に対する値なので、写真の短い辺に対する値に直す
        faces = res.faces.map((f) => f.map((q) => [(x0 + q[0] * cw) / W, (y0 + q[1] * ch) / H, q[2] * cw / S]));
        faceStore.set(key, faces); if (faceStore.size > 32) faceStore.delete(faceStore.keys().next().value);
      } catch (e) { console.warn('顔を見つける AI を使えませんでした', e); return null; }
    }
    const got = pick(faces); if (got) return got;
    if (side >= Math.max(W, H)) break;
  }
  return undefined;
}

/**
 * 画像（ImageData。512×512 の顔の切り出しなど、顔が大きく写っているもの）の顔の 478 点を、画像の画素の座標で返す。
 * 顔が見つからなければ []。AI を使えなければ例外
 */
export async function faceMeshes(img) {
  const data = new Uint8ClampedArray(img.data);
  const r = await call({ kind: 'face', w: img.width, h: img.height, data }, [data.buffer]);
  return r.faces.map((f) => f.map((q) => [q[0] * img.width, q[1] * img.height]));
}
/**
 * 写真の中の顔を全部見つける（顔専用 AI・本人の写真に使う）。顔の 478 点を、写真の画素の座標で返す（大きい順）。
 * AI は渡した絵に対して大きく写った顔しか見つけないので、写真全体と、半分・4 分の 1 の大きさの区画（半分ずつ重ねる）を順に渡し、
 * 同じ顔は 1 つにまとめる。顔の幅が minFace 画素より小さいものは除く
 * @param {ImageData|{width,height,data}} img
 */
export async function findAllFaces(img, { minFace = 96, onProgress = () => {} } = {}) {
  const W = img.width; const H = img.height; const S = Math.min(W, H);
  const src = new OffscreenCanvas(W, H); src.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, W, H), 0, 0);
  const wins = [[0, 0, W, H]];
  for (const side of [S / 2, S / 4]) {
    if (side < minFace * 2) break;
    const st = side / 2;
    for (let y = 0; y < H - st * 0.999; y += st) for (let x = 0; x < W - st * 0.999; x += st) wins.push([Math.round(x), Math.round(y), Math.round(Math.min(side, W - x)), Math.round(Math.min(side, H - y))]);
  }
  const found = [];
  const width = (f) => Math.hypot(f[454][0] - f[234][0], f[454][1] - f[234][1]); // 顔の幅（左右のこめかみ）
  for (let k = 0; k < wins.length; k++) {
    const [x0, y0, cw, ch] = wins[k];
    const sc = Math.min(768, Math.max(384, Math.max(cw, ch))) / Math.max(cw, ch);
    const w = Math.max(1, Math.round(cw * sc)); const h = Math.max(1, Math.round(ch * sc));
    const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(src, x0, y0, cw, ch, 0, 0, w, h);
    const faces = (await faceMeshes(x2.getImageData(0, 0, w, h))).map((f) => f.map(([x, y]) => [x0 + x / sc, y0 + y / sc]));
    for (const f of faces) {
      const fw = width(f); if (fw < minFace) continue;
      // 区画の端で切れた顔は、もっと広い区画で見つかったものを使う
      const xs = f.map((q) => q[0]); const ys = f.map((q) => q[1]);
      const cut = (Math.min(...xs) < x0 + 2 && x0 > 0) || (Math.min(...ys) < y0 + 2 && y0 > 0) || (Math.max(...xs) > x0 + cw - 2 && x0 + cw < W) || (Math.max(...ys) > y0 + ch - 2 && y0 + ch < H);
      const same = found.find((g) => Math.hypot(g.pts[4][0] - f[4][0], g.pts[4][1] - f[4][1]) < Math.max(fw, g.w) * 0.3);
      if (same) { if (same.cut && !cut) Object.assign(same, { pts: f, w: fw, cut }); continue; }
      found.push({ pts: f, w: fw, cut });
    }
    onProgress((k + 1) / wins.length);
  }
  return found.sort((a, b) => b.w - a.w).map((f) => f.pts);
}
