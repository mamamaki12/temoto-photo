// グリッド（コラージュ）のレイアウト計算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, cellRects, coverSource, gridSize, defaultGrid, hitCell, layoutById, MAX_GRID } from '../../grid.js';

test('grid: どのレイアウトも、マスが重ならず・はみ出さず・全体を埋める', () => {
  for (let n = 2; n <= MAX_GRID; n++) {
    assert.ok(LAYOUTS[n]?.length >= 2, `${n}枚のレイアウトが2つ以上`);
    for (const l of LAYOUTS[n]) {
      assert.equal(l.cells.length, n, l.id);
      const used = new Set(); let area = 0;
      for (const [x, y, w, h] of l.cells) {
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= l.cols && y + h <= l.rows, `${l.id}: 範囲外`);
        for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) { const k = `${i},${j}`; assert.ok(!used.has(k), `${l.id}: 重なり ${k}`); used.add(k); }
        area += w * h;
      }
      assert.equal(area, l.cols * l.rows, `${l.id}: すき間`);
    }
  }
  const ids = new Set(Object.values(LAYOUTS).flat().map((l) => l.id));
  assert.equal(ids.size, Object.values(LAYOUTS).flat().length, 'id が重複しない');
});

test('grid: すき間と余白（左右・上下が対称、すき間は同じ幅）', () => {
  const r = cellRects(layoutById(4, '4g'), 1000, 1000, { gap: 2, margin: 3 });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
  near(r[0].x, 30); near(r[0].y, 30); near(r[3].x + r[3].w, 970); near(r[3].y + r[3].h, 970);
  near(r[1].x - (r[0].x + r[0].w), 20); near(r[2].y - (r[0].y + r[0].h), 20);
  near(r[0].w, r[1].w);
  // 大きいマスと小さいマスでも、すき間はそろう
  const t = cellRects(layoutById(3, '3l'), 900, 600, { gap: 5, margin: 0 });
  near(t[1].x - (t[0].x + t[0].w), 30); near(t[2].y - (t[1].y + t[1].h), 30); near(t[0].h, 600);
});

test('grid: 写真をマスいっぱいに（はみ出さない範囲で、位置と拡大）', () => {
  const c = coverSource(4000, 3000, 500, 500);
  assert.equal(c.sh, 3000); assert.equal(c.sw, 3000); assert.equal(c.sx, 500); assert.equal(c.sy, 0);
  assert.equal(coverSource(4000, 3000, 500, 500, { ox: -1 }).sx, 0);
  assert.equal(coverSource(4000, 3000, 500, 500, { ox: 1 }).sx, 1000);
  assert.equal(coverSource(4000, 3000, 500, 500, { ox: 9 }).sx, 1000);
  const z = coverSource(4000, 3000, 500, 500, { zoom: 2 });
  assert.equal(z.sw, 1500); assert.equal(z.sx, 1250); assert.equal(z.sy, 750);
});

test('grid: 出力の大きさ・初期値・当たり判定', () => {
  assert.deepEqual(gridSize('1:1', 2048), { w: 2048, h: 2048 });
  assert.deepEqual(gridSize('9:16', 1080), { w: 608, h: 1080 });
  assert.deepEqual(gridSize('16:9', 1920), { w: 1920, h: 1080 });
  const g = defaultGrid(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  assert.equal(g.cells.length, 9); assert.equal(g.layout, '9a');
  const r = cellRects(layoutById(2, '2h'), 200, 100, {});
  assert.equal(hitCell(r, 150, 50), 1); assert.equal(hitCell(r, 50, 50), 0); assert.equal(hitCell(r, 300, 50), -1);
});

test('grid: 線（マスの境目）を動かすと、両側のマスの大きさが変わり、全体は埋まったまま', async () => {
  const { dividers, dividerRange, hitDivider } = await import('../../grid.js');
  for (let n = 2; n <= MAX_GRID; n++) {
    for (const l of LAYOUTS[n]) {
      const ds = dividers(l);
      assert.ok(ds.length >= 1, `${l.id}: 線がある`);
      for (const d of ds) {
        assert.ok(d.before.length && d.after.length, `${l.id} ${d.id}: 両側にマス`);
        // 動かせる範囲いっぱいまで動かしても、マスは重ならず最小の大きさを保つ
        for (const side of [0, 1]) {
          const lines = { [d.id]: dividerRange(l, {}, d)[side] };
          const rs = cellRects(l, 1000, 1000, { lines });
          assert.ok(rs.every((r) => r.w >= 50 && r.h >= 50), `${l.id} ${d.id}: 小さすぎるマス`);
          const area = rs.reduce((s, r) => s + r.w * r.h, 0);
          assert.ok(Math.abs(area - 1e6) < 1, `${l.id} ${d.id}: 全体を埋める (${area})`);
        }
      }
    }
  }
  // 2×2: 縦線を右へ動かすと、左の列が広くなる。横線は別に動かせる
  const g4 = layoutById(4, '4g');
  const v = dividers(g4).find((d) => d.axis === 'v');
  assert.deepEqual([v.before, v.after], [[0, 2], [1, 3]]);
  const rs = cellRects(g4, 1000, 1000, { lines: { [v.id]: 0.7 } });
  assert.equal(Math.round(rs[0].w), 700); assert.equal(Math.round(rs[1].x), 700); assert.equal(Math.round(rs[2].w), 700);
  // 上3・下4: 上の段と下の段の縦線はそれぞれ独立している
  const l7 = layoutById(7, '7a');
  assert.deepEqual(dividers(l7).filter((d) => d.axis === 'v').map((d) => d.id).sort(), ['v3_1', 'v4_0', 'v6_1', 'v8_0', 'v9_1']);
  // 大きく1つ＋5つ: 下の段の線は、上の大きいマスの右端を越えては動かせない
  const l6 = layoutById(6, '6c');
  const d6 = dividers(l6).find((d) => d.id === 'v1_2');
  assert.ok(dividerRange(l6, { v2_0: 0.4 }, d6)[1] <= 0.4 - 0.06 + 1e-9);
  // 線の近くを押すと、その線が見つかる（すき間ありでも）
  const r4 = cellRects(g4, 1000, 1000, { gap: 2, margin: 2 });
  assert.equal(hitDivider(g4, r4, 500, 200, 15)?.axis, 'v');
  assert.equal(hitDivider(g4, r4, 200, 500, 15)?.axis, 'h');
  assert.equal(hitDivider(g4, r4, 250, 250, 15), null);
  // 線を動かしていなければ、これまでと同じ位置
  assert.deepEqual(cellRects(g4, 800, 600, { gap: 2, margin: 2 }), cellRects(g4, 800, 600, { gap: 2, margin: 2, lines: {} }));
});
