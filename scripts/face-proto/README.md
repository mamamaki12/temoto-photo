# 顔専用 AI の試作・変換（アプリには入らない。写真・学習済みデータはリポジトリに入れない）

- `export_gfpgan.py`：GFPGAN v1.4 を ONNX にする（重みは半精度）。`split -n 2 -d -a 1` で 2 つに分けて `vendor/faceai/gfpgan-v1.4.onnx.1`・`.2` に置く。
  - 準備: `pip install torch onnx onnxscript`、GFPGAN のソース（`git clone https://github.com/TencentARC/GFPGAN`）、`GFPGANv1.4.pth`（GFPGAN の GitHub のリリース）。
  - basicsr は入れずに、登録の部分だけの代わり（`stub/`）を使う。
- `align_template.py`：`faceai.js` の `ALIGN_TPL`（MediaPipe の点で、FFHQ と同じ並べ方にするための目標の位置）を作る。
  RetinaFace の 5 点（facexlib）で 512 に並べた顔の上で MediaPipe の点を測り、中央値をとる。
