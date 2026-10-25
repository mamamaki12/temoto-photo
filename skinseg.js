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

const mouthStore = new Map(); // 指紋と切り出した所 → 唇の輪郭の一覧
/**
 * なぞった所（目印）のそばの口（唇の外側・内側の輪郭。写真全体に対する 0〜1 の座標）を AI で見つける。
 * 舞台や集合写真では顔が小さく、写真全体を縮めて AI に渡すと見つからないので、なぞった所のまわりを
 * 狭い方から順に切り出して渡す（顔がまるごと入る大きさになったところで見つかる）。最後に写真全体でも探す。
 * pts: なぞった線（0〜1）、r: ブラシの半径（短い辺に対する割合）
 * @returns {Promise<{outer:number[][],inner:number[][]}[]|null>} 見つからなければ []、AI を使えなければ null
 */
export async function findMouth(img, pts, r = 0) {
  const W = img.width; const H = img.height; const S = Math.min(W, H);
  const xs = pts.map((q) => q[0] * W); const ys = pts.map((q) => q[1] * H); const rp = r * S;
  const box = [Math.min(...xs) - rp, Math.min(...ys) - rp, Math.max(...xs) + rp, Math.max(...ys) + rp];
  const cx = (box[0] + box[2]) / 2; const cy = (box[1] + box[3]) / 2;
  const s = Math.max(box[2] - box[0], box[3] - box[1], S * 0.01);
  // 目印に重なる口のうち、目印の真ん中にいちばん近いもの
  const pick = (lips) => {
    let best = null; let bd = Infinity;
    for (const l of lips) {
      const lx = l.outer.map((q) => q[0] * W); const ly = l.outer.map((q) => q[1] * H);
      const mw = Math.max(...lx) - Math.min(...lx); const pad = mw * 0.25;
      if (Math.max(...lx) + pad < box[0] || Math.min(...lx) - pad > box[2] || Math.max(...ly) + pad < box[1] || Math.min(...ly) - pad > box[3]) continue;
      const d = Math.hypot((Math.max(...lx) + Math.min(...lx)) / 2 - cx, (Math.max(...ly) + Math.min(...ly)) / 2 - cy);
      if (d < bd) { bd = d; best = l; }
    }
    return best ? [best] : [];
  };
  let src = null; let ok = false;
  for (const k of [5, 10, 20, 40]) {
    const side = s * k; if (side > Math.max(W, H) * 1.2) break;
    const x0 = Math.max(0, Math.round(cx - side / 2)); const y0 = Math.max(0, Math.round(cy - side / 2));
    const cw = Math.min(W, Math.round(cx + side / 2)) - x0; const ch = Math.min(H, Math.round(cy + side / 2)) - y0;
    if (cw < 16 || ch < 16) continue;
    const key = `${fingerprint(img)}|${x0},${y0},${cw},${ch}`;
    let lips = mouthStore.get(key);
    if (!lips) {
      try {
        if (!src) { src = new OffscreenCanvas(W, H); src.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, W, H), 0, 0); }
        // AI に渡す大きさ: 長い辺 384〜768（小さく切り出したときは拡大する。顔の点は渡した大きさの中の割合で返る）
        const sc = Math.min(768, Math.max(384, Math.max(cw, ch))) / Math.max(cw, ch);
        const w = Math.max(1, Math.round(cw * sc)); const h = Math.max(1, Math.round(ch * sc));
        const c2 = new OffscreenCanvas(w, h); const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(src, x0, y0, cw, ch, 0, 0, w, h);
        const small = x2.getImageData(0, 0, w, h);
        const res = await call({ kind: 'lips', w, h, data: small.data }, [small.data.buffer]);
        const back = (q) => [(x0 + q[0] * cw) / W, (y0 + q[1] * ch) / H];
        lips = res.lips.map((l) => ({ outer: l.outer.map(back), inner: l.inner.map(back) }));
        mouthStore.set(key, lips); if (mouthStore.size > 32) mouthStore.delete(mouthStore.keys().next().value);
        ok = true;
      } catch (e) { console.warn('口を見つける AI を使えませんでした', e); return null; }
    } else ok = true;
    const got = pick(lips); if (got.length) return got;
  }
  const all = await findLips(img); if (!all) return ok ? [] : null;
  return pick(all);
}

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
