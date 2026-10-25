# 普通の写真（屋外・明るい舞台）のタイルで、NAFNet の途中の値の範囲を測る
import sys, numpy as np, torch; sys.path.insert(0, '.')
import clampnet as C
from run import load
from PIL import Image, ImageOps
m = load(); C.setup(m)
def run(c):
    with torch.no_grad(): return m(torch.from_numpy(np.ascontiguousarray(c)).permute(2, 0, 1)[None])[0].permute(1, 2, 0).numpy()
n = 0; skipped = 0
for spec in sys.argv[2:]:
    path, sc = spec.split('@'); sc = float(sc)
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB'); im = im.resize((round(im.width * sc), round(im.height * sc)), Image.BOX)
    a = np.asarray(im).astype(np.float32) / 255
    for y in range(0, a.shape[0] - 255, 256):
        for x in range(0, a.shape[1] - 255, 256):
            c = a[y:y + 256, x:x + 256]
            C.STATE['mode'] = None
            if np.abs(run(c) - c).max() > 0.4: skipped += 1; continue  # 壊れるタイルは範囲に入れない
            C.STATE['mode'] = 'calib'; run(c); n += 1
print('tiles', n, 'skipped', skipped)
C.save(sys.argv[1])
