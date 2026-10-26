import { restoreLinear } from './restoration.js';
import { enhanceBand } from './restoration-lowlight.js';
import { deconvResidual } from './deblur.js';

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
