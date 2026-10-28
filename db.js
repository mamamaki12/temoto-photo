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
export const deleteProject = (id) => tx(['projects', 'blobs'], 'readwrite', (p, b) => { p.delete(id); b.delete(id); b.delete(`hq:${id}`); b.delete(`stage:${id}`); });

/**
 * 暗所補正・ブレ補正・顔 AI の結果（編集用の大きさ）。開き直したとき、計算し直さずにすぐ見せるため
 * { key, W, H, space, data: Blob（画素。圧縮できる端末では deflate） , z: 圧縮したか }。写真 1 枚に 1 つだけ
 */
export const getHq = (id) => tx(['blobs'], 'readonly', (b) => req(b.get(`hq:${id}`)));
export const putHq = (id, v) => tx(['blobs'], 'readwrite', (b) => { b.put(v, `hq:${id}`); });
export const deleteHq = (id) => tx(['blobs'], 'readwrite', (b) => { b.delete(`hq:${id}`); });
/**
 * 仕上げの途中の結果（ノイズ除去と明るさ補正・ブレ補正・全体 AI の段ごと）。仕上げの途中で閉じた・アプリが落ちたとき、
 * 次に開いたら済んだ段から続ける。仕上げが終わって結果（hq）を保存したら消す
 */
export const getStage = (id) => tx(['blobs'], 'readonly', (b) => req(b.get(`stage:${id}`)));
export const putStage = (id, v) => tx(['blobs'], 'readwrite', (b) => { b.put(v, `stage:${id}`); });
export const deleteStage = (id) => tx(['blobs'], 'readwrite', (b) => { b.delete(`stage:${id}`); });
/** 補正の結果は大きい（1,670万画素で約 30MB）ので、新しく保存した keep 枚分だけ残す */
export const pruneHq = (keep, prefix = 'hq:') => tx(['blobs'], 'readwrite', (b) => new Promise((res) => {
  const list = []; const r = b.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
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
 * 顔の写真（crop）は 1 枚ずつ別の記録 faceai:ref:<id> に入れ、一覧（faceai:people）には入れない。
 * iPhone（WebKit）は、IndexedDB から読んだ Blob を同じ記録に書き直すと、元の記録の Blob が消えて読めなくなる
 * （1 枚外しただけで、ほかの写真が「?」になり、壊れた写真を読もうとして落ちていた）。顔の写真の記録は書き直さず、足す・消すだけにする
 */
const REF = 'faceai:ref:';
const refRange = () => IDBKeyRange.bound(REF, `${REF}\uffff`);
const stored = new WeakSet(); // 記録に入っている顔の写真（書き直さない）
/** Blob を、IndexedDB の記録と関係ないメモリの Blob にする。読めなければ null */
const detach = async (b) => { try { return new Blob([await b.arrayBuffer()], { type: b.type }); } catch { return null; } };
export async function getPeople() {
  const [list, keys, vals] = await tx(['blobs'], 'readonly', (b) => Promise.all([req(b.get('faceai:people')), req(b.getAllKeys(refRange())), req(b.getAll(refRange()))]));
  const crops = new Map(keys.map((k, i) => [k, vals[i]])); // getAll と getAllKeys は同じ鍵の順
  if (!Array.isArray(list)) return [];
  let old = false; // 前のバージョンの形（顔の写真が一覧の中）。読めた写真だけ、今の形で書き直す
  const out = [];
  for (const p of list) {
    const refs = [];
    for (const r of p.refs || []) {
      let crop = crops.get(REF + r.id);
      if (crop) stored.add(crop);
      else if (r.crop instanceof Blob) { old = true; crop = await detach(r.crop); }
      if (crop) refs.push({ ...r, crop });
    }
    out.push({ ...p, refs });
  }
  if (old) await putPeople(out);
  return out;
}
export async function putPeople(list) {
  const keep = new Set(); const added = [];
  const meta = list.map((p) => ({ ...p, refs: p.refs.map(({ crop, ...r }) => {
    keep.add(REF + r.id);
    if (crop && !stored.has(crop)) added.push([REF + r.id, crop]);
    return r;
  }) }));
  await tx(['blobs'], 'readwrite', async (b) => {
    for (const [k, crop] of added) b.put(crop, k);
    b.put(meta, 'faceai:people');
    for (const k of await req(b.getAllKeys(refRange()))) if (!keep.has(k)) b.delete(k); // 外した写真
  });
  for (const [, crop] of added) stored.add(crop);
}
/** 本人の写真を足している途中の記録（読み終えた写真の顔。途中でアプリが落ちても、次に開いたとき続きから足す）。null で消す */
export async function getPending() {
  const v = await tx(['blobs'], 'readonly', (b) => req(b.get('faceai:pending')));
  if (!v) return null;
  // 続きを足す前に「何回目か」を書き直すので、顔の写真は記録と切り離しておく（上と同じ WebKit の理由）
  for (const ph of v.photos || []) ph.cands = (await Promise.all(ph.cands.map(async (c) => ({ ...c, crop: await detach(c.crop) })))).filter((c) => c.crop);
  return v;
}
export const putPending = (v) => tx(['blobs'], 'readwrite', (b) => { if (v) b.put(v, 'faceai:pending'); else b.delete('faceai:pending'); });
