# 顔専用 AI の試作・変換（アプリには入らない。写真・学習済みデータはリポジトリに入れない）

- `export_gfpgan.py`：GFPGAN v1.4 を ONNX にする（重みは半精度、170MB）。
- `quantize_int8.py`：その重みを 8bit にして `vendor/faceai/gfpgan-v1.4-int8.onnx`（87MB）を作る。ダウンロードも、動かすときのメモリも減る（iPhone で落ちないように）。半精度との差は 1 画素あたり平均 0.15/255 で、目元を 100% で見ても区別できない。
  - 準備: `pip install torch onnx onnxscript`、GFPGAN のソース（`git clone https://github.com/TencentARC/GFPGAN`）、`GFPGANv1.4.pth`（GFPGAN の GitHub のリリース）。
  - basicsr は入れずに、登録の部分だけの代わり（`stub/`）を使う。
- `align_template.py`：`faceai.js` の `ALIGN_TPL`（MediaPipe の点で、FFHQ と同じ並べ方にするための目標の位置）を作る。
  RetinaFace の 5 点（facexlib）で 512 に並べた顔の上で MediaPipe の点を測り、中央値をとる。
