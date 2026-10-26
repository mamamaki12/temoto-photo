// 人物の肌（顔・体）を見分ける Worker（MediaPipe の「Selfie Multiclass」モデル。端末の中だけで動く）。
// 受け取る: { id, kind: 'skin' | 'person' | 'parts' | 'lips' | 'eyes' | 'face', w, h, data: Uint8ClampedArray（RGBA） }
// 返す: skin → { id, w, h, skin: Float32Array（0〜1。顔の肌＋体の肌） }／person → { id, w, h, skin: Float32Array（0〜1。背景でない＝人物） }／parts → { id, w, h, parts: Float32Array（部位ごとの 0〜1 を 6 つ並べたもの） }／lips → { id, lips: [{ outer, inner }]（顔ごとの唇の輪郭。0〜1 の座標） }／face → { id, faces: [[[x, y, z], …478 点], …] }
//       eyes → { id, eyes: [[{ lid, iris, pose }, { lid, iris, pose }]]（顔ごとに右目・左目。lid: まぶたのふち 16 点、iris: 黒目の中心と上右下左の 4 点。0〜1 の座標。pose: 顔の向き [yaw, pitch]） }
// クラシックな Worker にしているのは、MediaPipe が読み込み用のスクリプトを importScripts で読むため
/* eslint-disable no-undef */
var exports = {};
importScripts('vision_bundle.js'); // CommonJS 形式（exports に入る）。拡張子は、どのサーバーでも JavaScript として送られる .js に
let segmenter = null; let landmarker = null;
// 通信が途中で止まったとき（電波の悪い所など）、fetch は失敗もせずにずっと待つことがある。
// STALL ミリ秒のあいだ 1 バイトも届かなければあきらめる（ゆっくりでも届いていれば待つ）。あきらめたら、画面は AI なしで続ける
const STALL = 15000;
async function load(name) {
  const ctrl = new AbortController(); let timer = 0;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL); };
  kick();
  try {
    const res = await fetch(new URL(name, self.location), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    let told = 0;
    for (;;) {
      kick(); const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length;
      if (Date.now() - told > 1000) { told = Date.now(); self.postMessage({ alive: true }); } // 画面に「ダウンロード中で、止まってはいない」と知らせる
    }
    const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } catch (e) { throw new Error(`ダウンロードできませんでした（${name}: ${ctrl.signal.aborted ? '通信が止まっています' : e?.message || e}）`); }
  finally { clearTimeout(timer); }
}
// WebAssembly 本体も自分で読み込んで（止まったらあきらめる）、MediaPipe には読み込んだものを渡す
let wasmUrl = null;
async function fileset() {
  wasmUrl ||= URL.createObjectURL(new Blob([await load('wasm/vision_wasm_internal.wasm')], { type: 'application/wasm' }));
  return { wasmLoaderPath: new URL('wasm/vision_wasm_internal.js', self.location).href, wasmBinaryPath: wasmUrl };
}
// 唇の外側・内側の輪郭（MediaPipe の顔の 478 点のうち）
const OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
// 目のふち（まぶたの内側の輪郭。目頭から下まぶた・目尻・上まぶたの順）と黒目（中心・上・右・下・左）。写真の左側の目（本人の右目）から
const LID = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]];
const IRIS = [[468, 469, 470, 471, 472], [473, 474, 475, 476, 477]];
async function initFace() {
  if (landmarker) return landmarker;
  landmarker = await exports.FaceLandmarker.createFromOptions(await fileset(), { baseOptions: { modelAssetBuffer: await load('face_landmarker.task'), delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 6, outputFacialTransformationMatrixes: true });
  return landmarker;
}
async function init() {
  if (segmenter) return segmenter;
  segmenter = await exports.ImageSegmenter.createFromOptions(await fileset(), {
    baseOptions: { modelAssetBuffer: await load('selfie_multiclass_256x256.tflite'), delegate: 'CPU' },
    runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
  });
  return segmenter;
}
self.onmessage = async (e) => {
  const { id, kind, w, h, data } = e.data;
  try {
    if (kind === 'lips') {
      const fl = await initFace(); const r = fl.detect(new ImageData(data, w, h));
      const lips = (r.faceLandmarks || []).map((f) => ({ outer: OUTER.map((i) => [f[i].x, f[i].y]), inner: INNER.map((i) => [f[i].x, f[i].y]) }));
      self.postMessage({ id, lips }); return;
    }
    if (kind === 'eyes') {
      const fl = await initFace(); const r = fl.detect(new ImageData(data, w, h));
      // 顔の向き: 顔の変換行列（列優先の 4×4）の 3 列目 = 顔の正面の向き（カメラの座標。x 右・y 上・z 手前）。[yaw, pitch]（ラジアン。右向き・上向きが正）
      const pose = (r.facialTransformationMatrixes || []).map((m) => { const d = m.data; return [Math.atan2(d[8], d[10]), Math.atan2(d[9], Math.hypot(d[8], d[10]))]; });
      const eyes = (r.faceLandmarks || []).map((f, fi) => [0, 1].map((e) => ({ lid: LID[e].map((i) => [f[i].x, f[i].y]), iris: IRIS[e].map((i) => [f[i].x, f[i].y]), pose: pose[fi] || [0, 0] })));
      self.postMessage({ id, eyes }); return;
    }
    if (kind === 'face') {
      // 顔ごとの 478 点（x, y は 0〜1、z は顔の幅くらいを 1 とした奥行き）。鼻筋など、唇のほかの部位に使う
      const fl = await initFace(); const r = fl.detect(new ImageData(data, w, h));
      const faces = (r.faceLandmarks || []).map((f) => f.map((q) => [q.x, q.y, q.z]));
      self.postMessage({ id, faces }); return;
    }
    const seg = await init();
    const res = seg.segment(new ImageData(data, w, h));
    // 0 背景・1 髪・2 体の肌・3 顔の肌・4 服・5 そのほか
    if (kind === 'parts') {
      // 部位ごと（0 背景・1 髪・2 体の肌・3 顔の肌・4 服・5 そのほか）を 1 つの配列に並べる（部位 k は k·w·h から）
      const n = w * h; const parts = new Float32Array(n * 6);
      for (let k = 0; k < 6; k++) parts.set(res.confidenceMasks[k].getAsFloat32Array().subarray(0, n), k * n);
      res.close?.();
      self.postMessage({ id, w, h, parts }, [parts.buffer]); return;
    }
    if (kind === 'person') {
      const bg = res.confidenceMasks[0].getAsFloat32Array(); const person = new Float32Array(bg.length);
      for (let i = 0; i < bg.length; i++) person[i] = 1 - bg[i];
      res.close?.();
      self.postMessage({ id, w, h, skin: person }, [person.buffer]); return;
    }
    const body = res.confidenceMasks[2].getAsFloat32Array(); const face = res.confidenceMasks[3].getAsFloat32Array();
    const skin = new Float32Array(body.length); for (let i = 0; i < skin.length; i++) skin[i] = Math.min(1, body[i] + face[i]);
    res.close?.();
    self.postMessage({ id, w, h, skin }, [skin.buffer]);
  } catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};
