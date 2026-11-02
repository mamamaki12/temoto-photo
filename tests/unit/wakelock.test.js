import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeScreenHold } from '../../wakelock.js';

function fakeNav(log) {
  return { wakeLock: { request: async (kind) => { log.push('request ' + kind); const l = { released: false, release: async () => { l.released = true; log.push('release'); }, addEventListener() {} }; return l; } } };
}
const fakeDoc = (state = 'visible') => { const ls = {}; return { visibilityState: state, addEventListener: (k, f) => { ls[k] = f; }, fire: (k) => ls[k]?.(), set(s) { this.visibilityState = s; } }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('計算の間は画面を消さない。終わったら戻す（複数で持っているときは、全部終わってから）', async () => {
  const log = []; const doc = fakeDoc(); const s = makeScreenHold({ nav: fakeNav(log), doc });
  const a = s.hold(); await tick(); assert.equal(s.held, true); assert.deepEqual(log, ['request screen']);
  const b = s.hold(); await tick(); assert.deepEqual(log, ['request screen']); // 2 つ目は取り直さない
  a(); a(); await tick(); assert.equal(s.held, true); // 1 つ目が終わっても（2 度呼んでも）まだ持つ
  b(); await tick(); assert.equal(s.held, false); assert.deepEqual(log, ['request screen', 'release']);
});

test('画面が隠れている間は取らず、戻ったら取り直す。終わっていれば取らない', async () => {
  const log = []; const doc = fakeDoc('hidden'); const s = makeScreenHold({ nav: fakeNav(log), doc });
  const end = s.hold(); await tick(); assert.deepEqual(log, []);
  doc.set('visible'); doc.fire('visibilitychange'); await tick(); assert.deepEqual(log, ['request screen']);
  end(); await tick(); assert.deepEqual(log, ['request screen', 'release']);
  doc.fire('visibilitychange'); await tick(); assert.deepEqual(log, ['request screen', 'release']);
});

test('対応していない端末・取れなかったときは何もしない', async () => {
  const s = makeScreenHold({ nav: {}, doc: fakeDoc() }); const end = s.hold(); await tick(); assert.equal(s.held, false); end();
  const s2 = makeScreenHold({ nav: { wakeLock: { request: async () => { throw new Error('NotAllowedError'); } } }, doc: fakeDoc() });
  const end2 = s2.hold(); await tick(); assert.equal(s2.held, false); end2();
});

test('取っている途中で終わったら、取れたあとすぐ戻す', async () => {
  const log = []; const s = makeScreenHold({ nav: fakeNav(log), doc: fakeDoc() });
  const end = s.hold(); end(); await tick(); await tick();
  assert.equal(s.held, false); assert.deepEqual(log, ['request screen', 'release']);
});
