// 仕上げの段ごとの計算の版（calc-version.js の CALC）の上げ忘れを防ぐ。
// 保存しておいた結果（hq:<id>・stage:<id>）は CALC を鍵にして使い回すので、段の計算を直したのに数を上げないと、前に開いた写真が古い計算の結果のまま見える。
// 段の計算に使うファイルが変わったら、結果が変わるなら CALC のその段の数を上げ、`npm run calc-hashes` で記録（calc-hashes.json）を更新する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CALC } from '../../calc-version.js';
import { stageHashes, RECORD } from '../../scripts/calc-hashes.mjs';

test('段の計算のファイルを変えたら、CALC を見直して calc-hashes.json を更新してある', async () => {
  const rec = JSON.parse(await readFile(RECORD, 'utf8'));
  const now = await stageHashes();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(CALC).sort(), 'scripts/calc-hashes.mjs の STAGES と calc-version.js の CALC の段が合っていません');
  for (const [stage, cur] of Object.entries(now)) {
    const old = rec[stage];
    assert.ok(old, `${stage} の記録がありません。npm run calc-hashes を実行してください`);
    if (old.hash !== cur.hash) {
      const changed = cur.files.filter((f) => !old.files.includes(f)).concat(old.files.filter((f) => !cur.files.includes(f)));
      assert.fail(`${stage} の計算に使うファイルが変わりました${changed.length ? `（${changed.join(', ')} など）` : ''}。` +
        `結果が変わる直しなら calc-version.js の CALC.${stage} を ${old.calc + 1} に上げてから、変わらない直しならそのまま、npm run calc-hashes で記録を更新してください`);
    }
    assert.equal(CALC[stage], old.calc, `CALC.${stage} を変えたら npm run calc-hashes で記録を更新してください`);
  }
});

test('CALC は 1 以上の整数', () => {
  for (const [k, v] of Object.entries(CALC)) assert.ok(Number.isInteger(v) && v >= 1, `CALC.${k}`);
});
