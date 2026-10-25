# FFTformer（GoPro）を ONNX にする（アプリで使う）。8×8 区画のフーリエ変換は行列の掛け算（fft_onnx.py）、入力は 1×3×128×128 に固定、重みは半精度
# 使い方: python fft_export.py 出力.onnx   （fftformer_arch.py・pretrain_model/fftformer_GoPro.pth は FFTformer のリポジトリから。setup.sh）
import sys, os, torch, numpy as np, onnx, onnxsim
from onnx import numpy_helper, helper, TensorProto
sys.path.insert(0, '.')
import fftformer_arch as A, fft_onnx
fft_onnx.patch()
m = A.fftformer(); m.load_state_dict(torch.load('w/fftformer_GoPro.pth', map_location='cpu')); m.eval()
for p in m.parameters(): p.requires_grad_(False)
tmp = sys.argv[1] + '.fp32.onnx'
with torch.no_grad():  # これがないと、書き出しの途中で 13GB を超えるメモリを使う
    torch.onnx.export(m, torch.rand(1, 3, 128, 128), tmp, input_names=['input'], output_names=['output'], opset_version=17, dynamo=False)
g, ok = onnxsim.simplify(onnx.load(tmp)); assert ok
new_inits = []; casts = []
for init in g.graph.initializer:
    a = numpy_helper.to_array(init)
    if a.dtype == np.float32 and a.size >= 64:
        new_inits.append(numpy_helper.from_array(a.astype(np.float16), init.name + '_h'))
        casts.append(helper.make_node('Cast', [init.name + '_h'], [init.name], to=TensorProto.FLOAT))
    else: new_inits.append(init)
del g.graph.initializer[:]; g.graph.initializer.extend(new_inits)
nodes = list(g.graph.node); del g.graph.node[:]; g.graph.node.extend(casts + nodes)
onnx.checker.check_model(g); onnx.save(g, sys.argv[1]); os.remove(tmp)
print('size MB', os.path.getsize(sys.argv[1]) / 1e6)
