# 顔の見分け（SFace。OpenCV Zoo の face_recognition_sface_2021dec.onnx、Apache-2.0）の重みを、出力のチャンネルごとの 8bit（DequantizeLinear で単精度に戻す）にする
# 39MB → 10MB。単精度との差は、テスト写真の顔の特徴（128 次元）の向きで cos 0.999 以上
# 使い方: python quantize_sface.py face_recognition_sface_2021dec.onnx vendor/facerec/sface-int8.onnx
import sys, os
import onnx, numpy as np
from onnx import numpy_helper, helper
m = onnx.load(sys.argv[1]); g = m.graph
users = {}
for n in g.node:
    for x in n.input: users.setdefault(x, []).append(n)
new_inits = []; dq = []
for t in g.initializer:
    w = numpy_helper.to_array(t)
    if w.size < 4096 or w.dtype != np.float32 or any(n.op_type not in ('Conv', 'Gemm') for n in users.get(t.name, [])): new_inits.append(t); continue
    ax = w.reshape(w.shape[0], -1)
    s = np.maximum(np.abs(ax).max(1), 1e-8) / 127.0
    q = np.clip(np.round(ax / s[:, None]), -127, 127).astype(np.int8).reshape(w.shape)
    new_inits += [numpy_helper.from_array(q, t.name + '_q'), numpy_helper.from_array(s.astype(np.float32), t.name + '_s'), numpy_helper.from_array(np.zeros_like(s, dtype=np.int8), t.name + '_z')]
    dq.append(helper.make_node('DequantizeLinear', [t.name + '_q', t.name + '_s', t.name + '_z'], [t.name], axis=0, name=t.name + '_dq'))
# Dropout（opset 11 の ratio 属性は 13 にない。推論では何もしない）は Identity に
nodes = dq + [helper.make_node('Identity', [n.input[0]], [n.output[0]], name=n.name) if n.op_type == 'Dropout' else n for n in g.node]
del g.node[:]; g.node.extend(nodes); del g.initializer[:]; g.initializer.extend(new_inits)
for i in [i for i in g.input if i.name != 'data']: g.input.remove(i) # 重みは入力にしない（定数として扱わせる）
for o in m.opset_import:
    if o.domain in ('', 'ai.onnx'): o.version = 13
onnx.checker.check_model(m); onnx.save(m, sys.argv[2])
print(os.path.getsize(sys.argv[2]) / 1e6, 'MB')
