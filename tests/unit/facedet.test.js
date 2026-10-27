// 顔を見つける（skinseg.js の findAllFaces）で、同じ顔を 1 つにまとめる重なりの計算のテスト。
// 顔でないもの（肩・手・服）を除く確かめは、実際の写真で見て確かめた（docs/faceai-handoff.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlap } from '../../skinseg.js';

test('overlap: 同じ顔を少しずれた位置で見つけたものは大きく重なる', () => {
  assert.equal(overlap([0, 0, 10, 10], [20, 20, 30, 30]), 0);
  assert.equal(overlap([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.ok(overlap([0, 0, 100, 120], [10, 30, 105, 150]) > 0.4); // スクリーンショットの 1 番と 2 番のようなずれ
  assert.equal(overlap([0, 0, 100, 100], [25, 25, 75, 75]), 1); // 小さい方が大きい方の中
  assert.ok(overlap([0, 0, 100, 100], [90, 0, 190, 100]) < 0.4); // 隣り合う顔は別
});
