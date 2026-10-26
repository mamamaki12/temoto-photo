# export_gfpgan.py で作った半精度のモデルの大きな重みを、出力のチャンネルごとの 8bit（DequantizeLinear で単精度に戻す）にする
# 使い方: python quantize_int8.py gfpgan-fp16.onnx vendor/faceai/gfpgan-v1.4-int8.onnx
import sys
import onnx, numpy as np
from onnx import numpy_helper, helper, TensorProto
m = onnx.load(sys.argv[1]); g = m.graph
inits = {i.name: i for i in g.initializer}
cast_of = {}
for n in g.node:
    if n.op_type == 'Cast' and n.input[0] in inits: cast_of[n.input[0]] = n
users = {}
for n in g.node:
    for x in n.input: users.setdefault(x, []).append(n)
new_inits = []; drop = set(); new_nodes = {}
for name, t in inits.items():
    w = numpy_helper.to_array(t)
    if w.size <= 100000 or name not in cast_of or len(users[name]) != 1: new_inits.append(t); continue
    wf = w.astype(np.float32); ax = wf.reshape(wf.shape[0], -1)
    s = np.maximum(np.abs(ax).max(1), 1e-8) / 127.0
    q = np.clip(np.round(ax / s[:, None]), -127, 127).astype(np.int8).reshape(wf.shape)
    new_inits += [numpy_helper.from_array(q, name + '_q'), numpy_helper.from_array(s.astype(np.float32), name + '_s'), numpy_helper.from_array(np.zeros_like(s, dtype=np.int8), name + '_z')]
    c = cast_of[name]; drop.add(id(c))
    new_nodes[id(c)] = helper.make_node('DequantizeLinear', [name + '_q', name + '_s', name + '_z'], [c.output[0]], axis=0, name=name + '_dq')
nodes = [new_nodes.get(id(n), n) for n in g.node]
del g.node[:]; g.node.extend(nodes); del g.initializer[:]; g.initializer.extend(new_inits)
onnx.checker.check_model(m); onnx.save(m, sys.argv[2])
import os; print(os.path.getsize(sys.argv[2]) / 1e6, 'MB')
