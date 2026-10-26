// 顔の見分け（facerec.js）のテスト。AI の代わりに、決まった特徴を使う。
// 本人を見分けられるかは、テスト写真で確かめる（docs/faceai-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REC, SAME, recInput, normalize, cosine, personScore, findPerson, groupFaces, faceFloor } from '../../facerec.js';
import { FACE_PTS } from './face-fixture.js';

/** 人ごとの向き（dim 番目）に、少しずれ（jitter）を足した特徴 */
const face = (dim, jitter = 0, k = 1) => { const e = new Float32Array(16); e[dim] = 1; e[(dim + k) % 16] += jitter; return normalize(e); };

test('切り出し: 112×112 の RGB の面ごとで、色の順はそのまま', () => {
  const crop = new Float32Array(512 * 512 * 3); for (let i = 0; i < 512 * 512; i++) crop.set([200, 100, 50], i * 3);
  const x = recInput(crop, FACE_PTS);
  const n = REC * REC; assert.equal(x.length, 3 * n);
  assert.ok(Math.abs(x[n / 2] - 200) < 1e-3 && Math.abs(x[n + n / 2] - 100) < 1e-3 && Math.abs(x[2 * n + n / 2] - 50) < 1e-3);
});

test('近さ: 似た顔ほど高い。手がかりの近い 3 つの平均', () => {
  assert.ok(Math.abs(cosine(face(0), face(0)) - 1) < 1e-6);
  assert.ok(personScore(face(0, 0.3), [face(0), face(0, 0.1)]) > personScore(face(1), [face(0), face(0, 0.1)]));
  assert.equal(personScore(face(0), []), -1);
});

test('何人も写った写真から本人を選ぶ。ほかの人の方が似ている顔は選ばない', () => {
  const seeds = [face(0, 0.4)];
  const photos = [[face(1), face(0, 0.2), face(2)], [face(3)], [face(0, 0.3, 2), face(4)], [face(5), face(6)]];
  const r = findPerson(photos, seeds);
  assert.deepEqual(r.map((q) => q.pick), [1, -1, 0, -1]);
  // 1 人だけの写真でも、本人と違う顔なら選ばない
  assert.ok(r[1].score < SAME);
  // ほかの人（人 2）の方が似ていれば、選ばない
  const r2 = findPerson([[face(0, 0.9), face(7)]], [face(0, 0.4)], [[face(0, 1.0)]]);
  assert.equal(r2[0].pick, -1);
});

test('似た顔が 2 つあって見分けられなければ、選ばずに、いちばん似た顔を候補にする', () => {
  const r = findPerson([[face(0, 0.25), face(0, 0.3)]], [face(0, 0.2)]);
  assert.equal(r[0].pick, -1); assert.equal(r[0].guess, 0);
});

test('同じ人のまとまりで決める（1 枚だけ本人より手がかりに似た別人がいても、ほかの写真のその人で見分ける）', () => {
  const v = (m) => normalize(Float32Array.from({ length: 16 }, (_, i) => m[i] || 0));
  const seed = v({ 0: 1 });
  const P = [v({ 0: 1, 1: 0.5 }), v({ 1: 1, 0: 0.6 }), v({ 0: 1, 1: 0.5 })]; // 本人（2 枚目は手がかりに少し似ていない）
  const X = [v({ 2: 1, 0: 0.3 }), v({ 2: 1, 0: 0.9 }), v({ 2: 1 })]; // 別人（2 枚目だけ手がかりによく似ている）
  assert.ok(cosine(X[1], seed) > cosine(P[1], seed));
  const r = findPerson([[X[0], P[0]], [X[1], P[1]], [P[2], X[2]]], [seed]);
  assert.deepEqual(r.map((q) => q.pick), [1, 1, 0]);
  assert.deepEqual(groupFaces([P[0], X[0], P[1], X[1]], [0, 0, 1, 1]).map((g, _, a) => g === a[0]), [true, false, true, false]);
});

test('よく似た別人: 1 つの顔として本人から遠い顔や、覚えた別人により近い顔は、まとまりが本人らしくても選ばない', () => {
  const v = (m) => normalize(Float32Array.from({ length: 16 }, (_, i) => m[i] || 0));
  const seeds = [v({ 0: 1, 1: 0.1 }), v({ 0: 1, 2: 0.1 }), v({ 0: 1, 3: 0.1 })];
  assert.ok(faceFloor(seeds) > 0.7); // 本人の写真どうしはとても近いので、下限も上がる
  const look = v({ 0: 1, 4: 0.9 }); // よく似た別人（手がかりとの近さ 0.74 前後）
  assert.equal(findPerson([[look]], seeds)[0].pick, -1);
  const me = v({ 0: 1, 4: 0.3 });
  assert.equal(findPerson([[me]], seeds)[0].pick, 0);
  assert.equal(findPerson([[me]], seeds, [[v({ 0: 1, 4: 0.35 })]])[0].pick, -1); // 外された顔（別人）にもっと近い
});

test('手がかりがなければ、何も選ばない', () => {
  assert.deepEqual(findPerson([[face(0), face(1)]], []).map((q) => q.pick), [-1]);
});
