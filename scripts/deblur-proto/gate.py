# AI の直した差分のうち、もっともらしい所だけを残して元の大きさに足す
# 使い方: gate.py 元.png 保存した前置き(SAVE_NPY) 出力.png [k] [floor] [nyq]
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, convolve1d
orig = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32) / 255
a = np.load(sys.argv[2] + '_in.npy'); o = np.load(sys.argv[2] + '_out.npy')
k = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
floor = float(sys.argv[5]) if len(sys.argv) > 5 else 0.006
nyq = int(sys.argv[6]) if len(sys.argv) > 6 else 1
R = o - a
import os
if os.environ.get('AGREE'):  # 左右反転して当てた結果と、向きが合う分だけ（小さい方）を残す
    R2 = np.load(os.environ['AGREE'] + '_out.npy') - a
    R = np.where(np.sign(R) == np.sign(R2), np.sign(R) * np.minimum(np.abs(R), np.abs(R2)), 0).astype(np.float32)
if nyq:  # 2 画素周期の格子（タイルのつなぎ・AI の癖）を消す
    for ax in (0, 1): R = convolve1d(R, [0.25, 0.5, 0.25], axis=ax, mode='reflect')
Y = a @ np.float32([0.299, 0.587, 0.114])
SG = float(sys.argv[7]) if len(sys.argv) > 7 else 2.5
m1 = gaussian_filter(Y, SG); m2 = gaussian_filter(Y * Y, SG)
E = np.sqrt(np.maximum(0, m2 - m1 * m1))
A = k * np.maximum(0, E - floor)
mag = np.abs(R).max(2) + 1e-6
s = np.minimum(1, A / mag)
s = np.minimum(s, gaussian_filter(s, 1.5))  # 境目でいきなり変わらないように
R = R * s[..., None]
H0, W0 = orig.shape[:2]
up = np.stack([np.asarray(Image.fromarray(R[..., c]).resize((W0, H0), Image.BICUBIC)) for c in range(3)], 2)
Image.fromarray((np.clip(orig + up, 0, 1) * 255 + 0.5).astype(np.uint8)).save(sys.argv[3])
np.save(sys.argv[3] + '.s.npy', s)
print('gate mean', s.mean())
