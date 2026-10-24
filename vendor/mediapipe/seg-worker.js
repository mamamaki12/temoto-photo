// 人物の肌（顔・体）を見分ける Worker（MediaPipe の「Selfie Multiclass」モデル。端末の中だけで動く）。
// 受け取る: { id, kind: 'skin' | 'lips', w, h, data: Uint8ClampedArray（RGBA） }
// 返す: skin → { id, w, h, skin: Float32Array（0〜1。顔の肌＋体の肌） }／lips → { id, lips: [{ outer, inner }]（顔ごとの唇の輪郭。0〜1 の座標） }
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
async function initFace() {
  if (landmarker) return landmarker;
  landmarker = await exports.FaceLandmarker.createFromOptions(fileset(), { baseOptions: { modelAssetBuffer: await load('face_landmarker.task'), delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 6 });
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
    const seg = await init();
    const res = seg.segment(new ImageData(data, w, h));
    // 0 背景・1 髪・2 体の肌・3 顔の肌・4 服・5 そのほか
    const body = res.confidenceMasks[2].getAsFloat32Array(); const face = res.confidenceMasks[3].getAsFloat32Array();
    const skin = new Float32Array(body.length); for (let i = 0; i < skin.length; i++) skin[i] = Math.min(1, body[i] + face[i]);
    res.close?.();
    self.postMessage({ id, w, h, skin }, [skin.buffer]);
  } catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};
