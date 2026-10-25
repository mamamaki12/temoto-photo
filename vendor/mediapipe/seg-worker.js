// 人物の肌（顔・体）を見分ける Worker（MediaPipe の「Selfie Multiclass」モデル。端末の中だけで動く）。
// 受け取る: { id, kind: 'skin' | 'person' | 'lips' | 'eyes', w, h, data: Uint8ClampedArray（RGBA） }
// 返す: skin → { id, w, h, skin: Float32Array（0〜1。顔の肌＋体の肌） }／person → { id, w, h, skin: Float32Array（0〜1。背景でない＝人物） }／lips → { id, lips: [{ outer, inner }]（顔ごとの唇の輪郭。0〜1 の座標） }
//       eyes → { id, eyes: [[{ lid, iris }, { lid, iris }]]（顔ごとに右目・左目。lid: まぶたのふち 16 点、iris: 黒目の中心と上右下左の 4 点。0〜1 の座標） }
// クラシックな Worker にしているのは、MediaPipe が読み込み用のスクリプトを importScripts で読むため
/* eslint-disable no-undef */
var exports = {};
importScripts('vision_bundle.js'); // CommonJS 形式（exports に入る）。拡張子は、どのサーバーでも JavaScript として送られる .js に
let segmenter = null; let landmarker = null;
const fileset = () => ({ wasmLoaderPath: new URL('wasm/vision_wasm_internal.js', self.location).href, wasmBinaryPath: new URL('wasm/vision_wasm_internal.wasm', self.location).href });
const load = async (name) => new Uint8Array(await (await fetch(new URL(name, self.location))).arrayBuffer());
// 唇の外側・内側の輪郭（MediaPipe の顔の 478 点のうち）
const OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
// 目のふち（まぶたの内側の輪郭。目頭から下まぶた・目尻・上まぶたの順）と黒目（中心・上・右・下・左）。写真の左側の目（本人の右目）から
const LID = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]];
const IRIS = [[468, 469, 470, 471, 472], [473, 474, 475, 476, 477]];
async function initFace() {
  if (landmarker) return landmarker;
  landmarker = await exports.FaceLandmarker.createFromOptions(fileset(), { baseOptions: { modelAssetBuffer: await load('face_landmarker.task'), delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 6, outputFacialTransformationMatrixes: true });
  return landmarker;
}
async function init() {
  if (segmenter) return segmenter;
  segmenter = await exports.ImageSegmenter.createFromOptions(fileset(), {
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
    const seg = await init();
    const res = seg.segment(new ImageData(data, w, h));
    // 0 背景・1 髪・2 体の肌・3 顔の肌・4 服・5 そのほか
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
