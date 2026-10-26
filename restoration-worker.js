import { restoreLinear } from './restoration.js';
import { enhanceBand } from './restoration-lowlight.js';
import { deconvResidual } from './deblur.js';
import { personAlpha, computeBokeh } from './bokeh.js';

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
  if (data.type === 'lowlight') {
    try {
      const out = enhanceBand(data.band, data.at, data.options, (t) => self.postMessage({ type: 'progress', id: data.id, t }));
      self.postMessage({ type: 'result', id: data.id, data: out }, [out.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', id: data.id, message: error.message });
    }
    return;
  }
  // 背景のぼかし（bokeh-photo.js から。4 分の 1 に縮めた写真と人物の地図）
  if (data.type === 'bokeh') {
    try {
      const alpha = personAlpha(data.rgba, data.w, data.h, data.person); self.postMessage({ type: 'progress', t: 0.2 });
      const bokeh = computeBokeh(data.rgba, data.w, data.h, alpha, data.r, (t) => self.postMessage({ type: 'progress', t: 0.2 + 0.8 * t }));
      self.postMessage({ type: 'result', bokeh }, [bokeh.bg.buffer, bokeh.alpha.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
    return;
  }
  // 人物の割合の地図だけ（crisp-photo.js から。髪・服をくっきりの重みに使う）
  if (data.type === 'alpha') {
    try {
      const alpha = personAlpha(data.rgba, data.w, data.h, data.person);
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
