# 顔専用 AI（GFPGAN v1.4、Apache-2.0）を ONNX にする（アプリで使う）。重みは半精度で持ち、読み込むときに単精度に戻す
# 使い方: python export_gfpgan.py GFPGANのソース GFPGANv1.4.pth 出力.onnx
# 入力 input: [1,3,512,512]（RGB、-1〜1、FFHQ と同じ位置合わせの顔）→ 出力 output: 同じ形
import sys, os, torch, numpy as np, onnx, importlib.util
from onnx import numpy_helper, helper, TensorProto
src, pth, out = sys.argv[1:4]
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'stub'))  # basicsr の登録だけの代わり
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m
load('gfpgan.archs.stylegan2_clean_arch', f'{src}/gfpgan/archs/stylegan2_clean_arch.py')
A = load('gfpgan.archs.gfpganv1_clean_arch', f'{src}/gfpgan/archs/gfpganv1_clean_arch.py')
net = A.GFPGANv1Clean(out_size=512, num_style_feat=512, channel_multiplier=2, decoder_load_path=None, fix_decoder=False, num_mlp=8,
                      input_is_latent=True, different_w=True, narrow=1, sft_half=True)
sd = torch.load(pth, map_location='cpu'); net.load_state_dict(sd['params_ema'], strict=True); net.eval()
class Wrap(torch.nn.Module):
    def __init__(s, n): super().__init__(); s.n = n
    def forward(s, x): return s.n(x, return_rgb=False, randomize_noise=False)[0].clamp(-1, 1)
tmp = out + '.fp32.onnx'
torch.onnx.export(Wrap(net), torch.rand(1, 3, 512, 512) * 2 - 1, tmp, input_names=['input'], output_names=['output'], opset_version=17, dynamo=False)
g = onnx.load(tmp)
new_inits = []; casts = []
for init in g.graph.initializer:
    a = numpy_helper.to_array(init)
    if a.dtype == np.float32 and a.size >= 4096:
        new_inits.append(numpy_helper.from_array(a.astype(np.float16), init.name + '_h'))
        casts.append(helper.make_node('Cast', [init.name + '_h'], [init.name], to=TensorProto.FLOAT))
    else: new_inits.append(init)
del g.graph.initializer[:]; g.graph.initializer.extend(new_inits)
nodes = list(g.graph.node); del g.graph.node[:]; g.graph.node.extend(casts + nodes)
onnx.checker.check_model(g); onnx.save(g, out); os.remove(tmp)
print('size MB', os.path.getsize(out) / 1e6)
