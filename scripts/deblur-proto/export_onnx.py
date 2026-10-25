# 値を止める処理を入れた NAFNet を ONNX にする（アプリで使う）。重みは半精度で持ち、読み込むときに単精度に戻す
# 使い方: python export_onnx.py 出力.onnx
import sys, torch, numpy as np, onnx
from onnx import numpy_helper, helper, TensorProto
sys.path.insert(0, '.')
import clampnet as C
from run import load
m = load(); C.setup(m); C.load_bounds('w/bounds.pt'); C.STATE['mode'] = 'clamp'
x = torch.rand(1, 3, 256, 256)
tmp = sys.argv[1] + '.fp32.onnx'
torch.onnx.export(m, x, tmp, input_names=['input'], output_names=['output'], opset_version=17,
                  dynamic_axes={'input': {0: 'n'}, 'output': {0: 'n'}}, dynamo=False)
g = onnx.load(tmp)
# 大きな重みだけ半精度に（小さなもの・整数はそのまま）
new_inits = []; casts = []
for init in g.graph.initializer:
    a = numpy_helper.to_array(init)
    if a.dtype == np.float32 and a.size >= 64 and init.name.endswith('.weight'):
        h = numpy_helper.from_array(a.astype(np.float16), init.name + '_h')
        new_inits.append(h)
        casts.append(helper.make_node('Cast', [init.name + '_h'], [init.name], to=TensorProto.FLOAT))
    else: new_inits.append(init)
del g.graph.initializer[:]; g.graph.initializer.extend(new_inits)
nodes = list(g.graph.node); del g.graph.node[:]; g.graph.node.extend(casts + nodes)
onnx.checker.check_model(g)
onnx.save(g, sys.argv[1])
import os; os.remove(tmp)
print('size MB', os.path.getsize(sys.argv[1]) / 1e6)
