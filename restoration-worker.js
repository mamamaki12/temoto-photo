import { restoreLinear } from './restoration.js';
import { denoiseBand, finishBand, keepBand, previewPlanes, tonePreview } from './restoration-lowlight.js';
import { deconvResidual } from './deblur.js';
import { personAlpha, computeBokeh, autoRadius } from './bokeh.js';

self.onmessage = async ({ data }) => {
  // ブレ補正の逆畳み込み（deblur-worker.js から。AI の計算と同時に、別の CPU で）
  if (data.type === 'deconv') {
    try {
      const res = deconvResidual(data.small);
      self.postMessage({ type: 'result', res }, [res.data.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
    return;
  }
  // 暗所補正の帯（restoration-photo.js の enhancePhoto から。1 つの Worker が何本も続けて受け取る）
  // cached: 前に取っておいたノイズ除去の結果（明るさ補正だけを変えたとき。仕上げだけをやり直して、そのまま返す）。
  // keep: ノイズ除去の結果を取っておくために返す。pv: スライダーを動かしている間の見本の縮める倍率
  if (data.type === 'lowlight') {
    try {
      const prog = (t) => self.postMessage({ type: 'progress', id: data.id, t });
      const c = data.cached;
      const d = c ? { ...c, Y: Float32Array.from(c.Y) } : denoiseBand(data.band, data.at, data.options, prog);
      const at = c ? c.at : data.at;
      const keep = c || (data.keep && d.Y0 ? keepBand(d, at) : null);
      const out = finishBand(d, at, data.options, prog);
      const pv = data.pv ? previewPlanes(d, at, data.pv) : null;
      const list = [out.buffer];
      if (keep) list.push(keep.Y.buffer, keep.Y0.buffer, keep.Cb.buffer, keep.Cr.buffer);
      if (pv) list.push(pv.Y.buffer, pv.Cb.buffer, pv.Cr.buffer);
      self.postMessage({ type: 'result', id: data.id, data: out, keep, pv }, list);
    } catch (error) {
      self.postMessage({ type: 'error', id: data.id, message: error.message });
    }
    return;
  }
  // スライダーを動かしている間の見本（縮めた絵に、明るさの曲線だけを当てる）
  if (data.type === 'tone') {
    const out = tonePreview(data.pv, data.tone);
    self.postMessage({ type: 'tone', id: data.id, data: out }, [out.buffer]);
    return;
  }
  // 背景のぼかし（bokeh-photo.js から。4 分の 1 に縮めた写真と人物・奥行きの地図）
  if (data.type === 'bokeh') {
    try {
      const alpha = personAlpha(data.rgba, data.w, data.h, data.person, data.depth); self.postMessage({ type: 'progress', t: 0.2 });
      const auto = autoRadius(Math.max(data.w, data.h), data.face, data.person);
      const bokeh = computeBokeh(data.rgba, data.w, data.h, alpha, auto.r, (t) => self.postMessage({ type: 'progress', t: 0.2 + 0.8 * t }));
      bokeh.auto = auto;
      self.postMessage({ type: 'result', bokeh }, [bokeh.bg.buffer, bokeh.alpha.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
    return;
  }
  // 人物の割合の地図だけ（crisp-photo.js から。髪・服をくっきりの重みに使う）
  if (data.type === 'alpha') {
    try {
      const alpha = personAlpha(data.rgba, data.w, data.h, data.person, data.depth);
      self.postMessage({ type: 'result', alpha }, [alpha.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
    return;
  }
  const { image, options } = data;
  try {
    const result = await restoreLinear(image, options, {
      onProgress: (progress) => self.postMessage({ type: 'progress', progress }),
      yieldTask: () => Promise.resolve(),
    });
    self.postMessage({ type: 'result', result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
