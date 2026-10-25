import sys, torch, numpy as np, time
sys.path.insert(0,'.')
from run import load
import os, clampnet as C
from PIL import Image
T=int(sys.argv[3]) if len(sys.argv)>3 else 256; O=32
scale=float(sys.argv[4]) if len(sys.argv)>4 else 1
m=load()
if os.environ.get('CLAMP'):
  C.setup(m); C.load_bounds('w/bounds.pt'); C.STATE['mode']='clamp'
im=Image.open(sys.argv[1]).convert('RGB'); W0,H0=im.size
if scale!=1: im=im.resize((round(W0*scale),round(H0*scale)),Image.BOX)
a=np.asarray(im).astype(np.float32)/255; H,W,_=a.shape
FLIP=os.environ.get('FLIP')
if FLIP: a=np.ascontiguousarray(a[:,::-1])
out=np.zeros_like(a); wsum=np.zeros((H,W,1),np.float32)
ramp=np.minimum(1,(np.arange(T)+0.5)/O); ramp=np.minimum(ramp,ramp[::-1]); win=np.outer(ramp,ramp)[...,None].astype(np.float32)
ys=list(range(0,max(1,H-T),T-O))+[max(0,H-T)]; xs=list(range(0,max(1,W-T),T-O))+[max(0,W-T)]
t=time.time()
pa=np.pad(a,((0,max(0,T-H)),(0,max(0,T-W)),(0,0)),mode='reflect')
for y in sorted(set(ys)):
  for x in sorted(set(xs)):
    tile=pa[y:y+T,x:x+T]
    with torch.no_grad(): r=m(torch.from_numpy(tile).permute(2,0,1)[None].contiguous())[0].permute(1,2,0).numpy()
    h=min(T,H-y); w=min(T,W-x)
    out[y:y+h,x:x+w]+=r[:h,:w]*win[:h,:w]; wsum[y:y+h,x:x+w]+=win[:h,:w]
out/=wsum
if FLIP: a=np.ascontiguousarray(a[:,::-1]); out=np.ascontiguousarray(out[:,::-1])
print('sec',time.time()-t)
if os.environ.get('SAVE_NPY'): np.save(os.environ['SAVE_NPY']+'_in.npy',a); np.save(os.environ['SAVE_NPY']+'_out.npy',out)
o=Image.fromarray((np.clip(out,0,1)*255+0.5).astype(np.uint8))
if scale!=1:
  # 縮めた段で直した差分だけを、元の大きさに足す
  up=np.asarray(o.resize((W0,H0),Image.BICUBIC)).astype(np.float32); dn=np.asarray(im.resize((W0,H0),Image.BICUBIC)).astype(np.float32)
  orig=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
  o=Image.fromarray(np.clip(orig+up-dn,0,255).astype(np.uint8))
o.save(sys.argv[2])
