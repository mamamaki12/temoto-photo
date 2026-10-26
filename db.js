// 写真と編集内容の保存（IndexedDB）。すべて端末の中だけ。サーバーには送らない。
const DB = 'temoto-photo';
let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('projects', { keyPath: 'id' }); d.createObjectStore('blobs'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode); let out;
    Promise.resolve(fn(...stores.map((s) => t.objectStore(s)))).then((v) => { out = v; });
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const listProjects = () => tx(['projects'], 'readonly', (p) => req(p.getAll())).then((a) => a.sort((x, y) => y.updated - x.updated));
export const getProject = (id) => tx(['projects'], 'readonly', (p) => req(p.get(id)));
export const getBlob = (id) => tx(['blobs'], 'readonly', (b) => req(b.get(id)));
export const putProject = (proj) => tx(['projects'], 'readwrite', (p) => { p.put(proj); });
export const addProject = (proj, blob) => tx(['projects', 'blobs'], 'readwrite', (p, b) => { p.put(proj); b.put(blob, proj.id); });
export const deleteProject = (id) => tx(['projects', 'blobs'], 'readwrite', (p, b) => { p.delete(id); b.delete(id); b.delete(`hq:${id}`); });

/**
 * 暗所補正・ブレ補正・顔 AI の結果（編集用の大きさ）。開き直したとき、計算し直さずにすぐ見せるため
 * { key, W, H, space, data: Blob（画素。圧縮できる端末では deflate） , z: 圧縮したか }。写真 1 枚に 1 つだけ
 */
export const getHq = (id) => tx(['blobs'], 'readonly', (b) => req(b.get(`hq:${id}`)));
export const putHq = (id, v) => tx(['blobs'], 'readwrite', (b) => { b.put(v, `hq:${id}`); });
export const deleteHq = (id) => tx(['blobs'], 'readwrite', (b) => { b.delete(`hq:${id}`); });
/** 補正の結果は大きい（1,670万画素で約 30MB）ので、新しく保存した keep 枚分だけ残す */
export const pruneHq = (keep) => tx(['blobs'], 'readwrite', (b) => new Promise((res) => {
  const list = []; const r = b.openCursor(IDBKeyRange.bound('hq:', 'hq:\uffff'));
  r.onsuccess = () => {
    const c = r.result;
    if (c) { list.push([c.key, c.value?.at || 0]); c.continue(); return; }
    list.sort((x, y) => y[1] - x[1]).slice(keep).forEach(([k]) => b.delete(k)); res();
  };
  r.onerror = () => res();
}));

/** 使っている容量（ブラウザが教えてくれる範囲で） */
export async function usage() {
  try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage || 0, quota: e.quota || 0 } : null; } catch { return null; }
}
/** ブラウザに「勝手に消さないで」と頼む（iPhone などで容量が足りないと消されることがあるため） */
export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }

/**
 * 顔専用 AI に使う「本人の写真」（人ごとに、明るい所で撮った写真から切り出した顔）。写真をまたいで使う
 * [{ id, name, refs: [{ id, crop: Blob（512×512 の PNG）, pts: number[]（顔の 478 点。x, y の順。512 の座標） }] }]
 */
export const getPeople = () => tx(['blobs'], 'readonly', (b) => req(b.get('faceai:people'))).then((v) => (Array.isArray(v) ? v : []));
export const putPeople = (list) => tx(['blobs'], 'readwrite', (b) => { b.put(list, 'faceai:people'); });
