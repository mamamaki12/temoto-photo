# ブレ補正AIの試作環境（写真・学習済みデータはリポジトリに入れない）。このフォルダーで実行する
set -e
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install gdown onnx onnxruntime einops numpy pillow
# NAFNet（MIT）の構造と GoPro width32 の学習済みデータ（公式 Google Drive。sha256 19394e61…d5d1a5c）
for f in NAFNet_arch.py arch_util.py local_arch.py; do curl -sfLO https://raw.githubusercontent.com/megvii-research/NAFNet/main/basicsr/models/archs/$f; done
sed -i 's/from basicsr.models.archs.arch_util/from arch_util/; s/from basicsr.models.archs.local_arch/from local_arch/' NAFNet_arch.py
sed -i 's/^from basicsr.utils import get_root_logger/import logging; get_root_logger=logging.getLogger/' arch_util.py
mkdir -p w && python -m gdown 1Fr2QadtDCEXg6iwWX8OzeZLbHOx2t5Bj -O w/NAFNet-GoPro-width32.pth
# FFTformer（MIT）: 構造と RealBlur の学習済みデータ
curl -sfLO https://raw.githubusercontent.com/kkkls/FFTformer/main/basicsr/models/archs/fftformer_arch.py
python -m gdown --folder https://drive.google.com/drive/folders/1l_R8_2UKfiQP_BYrgcQrmCBSe_ogwL41 -O realblur
