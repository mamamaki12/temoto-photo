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
export const deleteProject = (id) => tx(['projects', 'blobs'], 'readwrite', (p, b) => { p.delete(id); b.delete(id); });

/** 使っている容量（ブラウザが教えてくれる範囲で） */
export async function usage() {
  try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage || 0, quota: e.quota || 0 } : null; } catch { return null; }
}
/** ブラウザに「勝手に消さないで」と頼む（iPhone などで容量が足りないと消されることがあるため） */
export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
