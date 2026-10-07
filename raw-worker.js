// RAW の現像は重いので、画面が固まらないよう別スレッドで行う
import { decodeRaw } from './raw.js';

self.onmessage = (e) => {
  const { buffer, name, maxPixels } = e.data;
  try {
    const r = decodeRaw(buffer, { name, maxPixels });
    if (r.kind === 'raw') {
      self.postMessage({ ok: true, ...r }, [r.rgba.buffer]);
    } else {
      // 大きい順に3つまで、JPEG の部分だけを切り出して返す
      const jpegs = r.previews.slice(0, 3).map((p) => ({ w: p.w, h: p.h, bytes: buffer.slice(p.offset, p.offset + p.length) }));
      self.postMessage({ ok: true, kind: 'preview', jpegs, orientation: r.orientation, format: r.format, reason: r.reason }, jpegs.map((j) => j.bytes));
    }
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
