import { restoreLinear } from './restoration.js';

self.onmessage = async ({ data: { image, options } }) => {
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
