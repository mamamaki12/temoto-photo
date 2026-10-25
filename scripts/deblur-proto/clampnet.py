# NAFNet の途中の値を、普通の写真で出る範囲に止める（ある種の入力で値が暴走して砂嵐になるのを防ぐ）
# 範囲は calib.py で普通の写真から測る（w/bounds.pt）
import torch, NAFNet_arch as A
POINTS = ['g1', 's', 'xs', 'y', 'g2', 'out']
STATE = {'mode': None, 'margin': 0.25}  # mode: None / 'calib' / 'clamp'
def _id(blk):
    return blk._cid
def setup(m):
    i = 0
    for mod in m.modules():
        if isinstance(mod, A.NAFBlock): mod._cid = i; i += 1
    STATE['n'] = i; STATE['lo'] = {}; STATE['hi'] = {}
def _pt(blk, name, v):
    k = (blk._cid, name)
    if STATE['mode'] == 'calib':
        lo = v.amin((0, 2, 3)); hi = v.amax((0, 2, 3))
        if k in STATE['lo']: STATE['lo'][k] = torch.minimum(STATE['lo'][k], lo); STATE['hi'][k] = torch.maximum(STATE['hi'][k], hi)
        else: STATE['lo'][k] = lo; STATE['hi'][k] = hi
        return v
    if STATE['mode'] == 'clamp' and k in STATE['lo'] and name in STATE.get('points', POINTS):
        lo = STATE['lo'][k]; hi = STATE['hi'][k]; r = (hi - lo) * STATE['margin']
        return torch.maximum(torch.minimum(v, (hi + r)[None, :, None, None]), (lo - r)[None, :, None, None])
    return v
def fwd(self, inp):
    x = self.norm1(inp); x = self.conv1(x); x = self.conv2(x); x = _pt(self, 'g1', self.sg(x))
    s = _pt(self, 's', self.sca(x)); x = _pt(self, 'xs', x * s)
    x = self.conv3(x); y = _pt(self, 'y', inp + x * self.beta)
    x = _pt(self, 'g2', self.sg(self.conv4(self.norm2(y)))); x = self.conv5(x)
    return _pt(self, 'out', y + x * self.gamma)
A.NAFBlock.forward = fwd
def save(path): torch.save({'lo': STATE['lo'], 'hi': STATE['hi']}, path)
def load_bounds(path):
    d = torch.load(path); STATE['lo'] = d['lo']; STATE['hi'] = d['hi']
