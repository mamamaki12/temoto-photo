import { restorationOptions } from './restoration.js';

// 入力はコピーして転送し、元画像の配列を切り離さない。キャンセルは計算途中でも終了できる。
export function restoreInWorker(image, options = {}, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('処理を中止しました', 'AbortError')); return; }
    const opts = restorationOptions(image, options);
    const worker = new Worker(new URL('./restoration-worker.js', import.meta.url), { type: 'module' });
    const finish = (err, result) => {
      worker.terminate(); signal?.removeEventListener('abort', cancel);
      if (err) reject(err); else resolve(result);
    };
    const cancel = () => finish(new DOMException('処理を中止しました', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        try { onProgress(data.progress); } catch (error) { finish(error); }
      } else if (data.type === 'result') finish(null, data.result);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    worker.onerror = () => finish(new Error('写真復元の処理を開始・実行できませんでした'));
    worker.onmessageerror = () => finish(new Error('写真復元の結果を読み取れませんでした'));
    try {
      const copy = { width: image.width, height: image.height, data: new Float32Array(image.data) };
      worker.postMessage({ image: copy, options: opts }, [copy.data.buffer]);
    } catch (error) { finish(error); }
  });
}
