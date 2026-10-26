// 保存した編集を開き直したとき、アプリが作る編集がそのまま戻ること（validateState が何も落とさない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, validateState, newLocal } from '../../state.js';

const lid = Array.from({ length: 16 }, (_, i) => [0.4 + 0.01 * Math.cos(i / 16 * 6.283), 0.3 + 0.004 * Math.sin(i / 16 * 6.283)]);
const iris = [[0.4, 0.3], [0.4, 0.297], [0.403, 0.3], [0.4, 0.303], [0.397, 0.3]];

/** 道具をひととおり使った編集（アプリが保存する形） */
function fullState() {
  const s = defaultState();
  Object.assign(s.adj, { lowlight: 50, noise: 50, deblur: 40, exposure: 20, saturation: -10 });
  s.look = { id: 'film', amount: 70 };
  s.portrait = { smooth: 50, even: 40, bright: 18, tol: 50, seeds: [[0.5, 0.4]] };
  const brush = newLocal('brush', 'l1'); brush.adj.exposure = 30; brush.strokes = [{ erase: false, size: 0.05, hard: 0.5, flow: 1, pts: [[0.1, 0.1], [0.2, 0.2]] }];
  s.locals = [brush, Object.assign(newLocal('radial', 'l2'), { cx: 0.4 })];
  s.retouch = [
    { type: 'heal', x: 0.5, y: 0.5, r: 0.02, sx: null, sy: null },
    { type: 'mosaic', x: 0.1, y: 0.1, w: 0.1, h: 0.1, size: 20 },
    { type: 'eyes', pts: [[0.4, 0.3], [0.45, 0.3]], r: 0.03, amt: 0.5 },
    { type: 'lip', pts: [[0.5, 0.6]], r: 0.03, amt: 0.5, col: [214, 92, 120], lips: [{ outer: [[0.48, 0.6], [0.5, 0.59], [0.52, 0.6]], inner: [[0.49, 0.6], [0.51, 0.6]] }], whole: true },
    { type: 'gaze', pts: [[0.4, 0.3]], r: 0.03, amt: 1, eyes: [[{ lid, iris, pose: [0.12, -0.03] }, { lid, iris, pose: [0.12, -0.03] }]], tune: [-0.2, 0.1] },
    { type: 'nose', pts: [[0.5, 0.5]], r: 0.03, amt: 0.5, nose: { mid: [[0.5, 0.4], [0.5, 0.45], [0.5, 0.5]], li: [[0.49, 0.5]], ri: [[0.51, 0.5]], lo: [[0.47, 0.5]], ro: [[0.53, 0.5]] } },
  ];
  s.faceai = { faces: [{ x: 0.5, y: 0.4, on: true, person: 'p1' }], amount: 80, whole: true };
  return s;
}

test('保存した編集は、開き直しても同じ（目線の補正も消えない）', () => {
  const s = fullState();
  const back = validateState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(back, s);
});

test('目線: 壊れた目のデータは捨てる', () => {
  const back = validateState({ retouch: [{ type: 'gaze', pts: [[0.4, 0.3]], r: 0.03, amt: 1, eyes: [[{ lid: [[0, 0]], iris }], 'x'], tune: ['a', 1, 2] }] });
  assert.deepEqual(back.retouch[0].eyes, []);
  assert.equal(back.retouch[0].tune, undefined);
});
