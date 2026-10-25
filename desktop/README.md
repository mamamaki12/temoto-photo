# てもとフォト PC 版（Windows・試作）

Web 版とまったく同じファイルを、Windows のアプリ（.exe）として動かす。写真は PC の外に出ない。
違うのは **ブレ補正の AI** だけで、ブラウザの WebAssembly ではなく PC 用の ONNX Runtime で動かす。
GPU があれば DirectML（Windows の GPU の仕組み。NVIDIA・AMD・Intel のどれでも）で、なければ CPU の全部のコアで。
仕上がりは Web 版と同じ（IMG_9345 の原寸書き出しで、違いは最大 3/255・全体の 0.0002% の画素）。
暗所補正などほかの計算は Web 版と同じ JavaScript なので、速さも Web 版（Chrome・Edge）と同じ。

| クラウド 4 コア・GPU なしで測った | ブラウザ版 | PC 版 |
|---|---|---|
| AI 1 区画（256×256）、1 コアあたり | 3.0 秒 | 1.1 秒 |
| AI 1 区画、4 コア全部で | 1.14 秒 | 0.54 秒 |
| IMG_9345 ノイズ50・明るさ50・ブレ50 の補正 | 324 秒 | 224 秒 |
| 同 原寸 JPEG 書き出し | 75 秒 | 77 秒 |

## 使い方

1. `TemotoPhoto-win-x64.zip` を展開する
2. `TemotoPhoto\TemotoPhoto.exe` を開く（署名がないので、初回は「Windows によって PC が保護されました」→「詳細情報」→「実行」）

## 作り方

```
bash desktop/build-win.sh   # → desktop/dist/TemotoPhoto-win-x64.zip（Linux・Mac でも作れる）
```

GitHub Actions（`.github/workflows/desktop.yml`）でも作り、Windows の機械で実際に起動して、暗所補正・ブレ補正・書き出しができるかを確かめている（`desktop/smoke.cjs`）。

## しくみ

- `main.cjs`: Electron の起動。アプリのファイルを `app://temoto/` から出す（住所が毎回同じなので、保存した編集・設定が残る）
- ブレ補正の Worker（`deblur-worker.js`）は、PC 版のときだけ区画を `app://temoto/__native/deblur` に送り、`main.cjs` が ONNX Runtime で計算して返す
- GPU の計算がおかしいとき（小さな絵で確かめる）は、自動で CPU に切り替える。`TEMOTO_EP=cpu` で CPU だけにできる
