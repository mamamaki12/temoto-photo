# 奥行きの AI（Depth Anything V2 Small、Apache-2.0）を、アプリで使う ONNX にする（vendor/depth/）。
#   元: https://github.com/fabio-sim/Depth-Anything-ONNX の v2.0.0 のリリースの depth_anything_v2_vits.onnx（Apache-2.0。入力 1×3×518×518）
#   ① PyTorch の書き出しが作った部品（関数）を展開し、onnxsim で整える（ONNX Runtime Web の標準の演算だけにする）
#   ② 重みを半精度で持ち、読み込むときに単精度へ戻す（Cast。計算は単精度のまま。100MB → 50MB、結果の差は 0.003 以下）
#      int8 にすると 35MB になるが、結果が最大 0.33 ずれる（使わない）
# 使い方: pip install onnx onnxsim numpy && python convert_depth.py depth_anything_v2_vits.onnx ../../vendor/depth/depth-anything-v2-small.onnx
import sys
import numpy as np
import onnx
import onnx.inliner
from onnx import helper, numpy_helper, TensorProto
from onnxsim import simplify

m = onnx.inliner.inline_local_functions(onnx.load(sys.argv[1]))
m, ok = simplify(m)
assert ok
g = m.graph
casts = []
for init in list(g.initializer):
    a = numpy_helper.to_array(init)
    if a.dtype == np.float32 and a.size >= 1024:
        half = init.name + '_f16'
        g.initializer.remove(init)
        g.initializer.append(numpy_helper.from_array(a.astype(np.float16), half))
        casts.append(helper.make_node('Cast', [half], [init.name], to=TensorProto.FLOAT))
for c in reversed(casts):
    g.node.insert(0, c)
onnx.save(m, sys.argv[2])
