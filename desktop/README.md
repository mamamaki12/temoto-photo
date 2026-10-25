# てもとフォト PC 版（Windows・試作）

Web 版とまったく同じファイルを、Windows のアプリ（.exe）として動かす。写真は PC の外に出ない。
違うのは次の 2 つだけで、仕上がりは Web 版と同じ（IMG_9345 の原寸書き出しで、違いは最大 3/255・全体の 0.0002% の画素）。

- **ブレ補正の AI** を、ブラウザの WebAssembly ではなく PC 用の ONNX Runtime で動かす。GPU があれば DirectML（Windows の GPU の仕組み。NVIDIA・AMD・Intel のどれでも）で、なければ CPU の全部のコアで
- **暗所補正** を、CPU の数に合わせて最大 12 本の Worker で同時に動かす（ブラウザ版は 4 本まで）

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
