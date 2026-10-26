# 全体 AI のモデル（vendor/wholeai/realesr-general-x4v3.onnx）を作る。
# 準備: pip install torch onnx、realesr-general-x4v3.pth（Real-ESRGAN の GitHub のリリース v0.2.5.0）をこのフォルダーに。
# 使い方: python3 export_realesrgan.py realesr-general-x4v3.pth ../../vendor/wholeai/realesr-general-x4v3.onnx
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F


class SRVGGNetCompact(nn.Module):
    """Real-ESRGAN の小さい網（basicsr を入れずに使えるよう、同じ形をここに書いたもの）"""

    def __init__(self, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList([nn.Conv2d(3, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)])
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for m in self.body:
            out = m(out)
        return self.upsampler(out) + F.interpolate(x, scale_factor=self.upscale, mode='nearest')


src, dst = sys.argv[1], sys.argv[2]
m = SRVGGNetCompact()
m.load_state_dict(torch.load(src, map_location='cpu')['params'])
m.eval()
# 入力・出力の名前はブレ補正の AI と同じ（deblur-infer-worker.js を使い回す）
torch.onnx.export(m, torch.rand(1, 3, 64, 64), dst, input_names=['input'], output_names=['output'],
                  dynamic_axes={'input': {0: 'n', 2: 'h', 3: 'w'}, 'output': {0: 'n', 2: 'h4', 3: 'w4'}}, opset_version=17, dynamo=False)
print('saved', dst)
