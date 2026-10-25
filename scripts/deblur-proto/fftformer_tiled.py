import sys,torch,numpy as np,time,os; sys.path.insert(0,'.')
from fftformer_arch import fftformer
from PIL import Image
W=os.environ.get('W','realblur/net_g_Realblur_J.pth')
m=fftformer(); sd=torch.load(W,map_location='cpu'); m.load_state_dict(sd.get('params',sd)); m.eval()
torch.set_num_threads(os.cpu_count())
def run(x):
  with torch.no_grad(): return m(torch.from_numpy(np.ascontiguousarray(x,dtype=np.float32)).permute(2,0,1)[None])[0].permute(1,2,0).numpy()
def tiled(a,T=256,O=32):
  H,W_,_=a.shape; out=np.zeros_like(a); ws=np.zeros((H,W_,1),np.float32)
  ramp=np.minimum(1,(np.arange(T)+0.5)/O); ramp=np.minimum(ramp,ramp[::-1]); win=np.outer(ramp,ramp)[...,None].astype(np.float32)
  ys=sorted(set(list(range(0,max(1,H-T),T-O))+[max(0,H-T)])); xs=sorted(set(list(range(0,max(1,W_-T),T-O))+[max(0,W_-T)]))
  bad=0
  for y in ys:
    for x in xs:
      c=a[y:y+T,x:x+T]; r=run(c)
      if np.abs(r-c).max()>0.6: bad+=1
      out[y:y+T,x:x+T]+=r*win; ws[y:y+T,x:x+T]+=win
  return out/ws,bad,len(ys)*len(xs)
if __name__=='__main__':
  im=Image.open(sys.argv[1]).convert('RGB'); sc=float(sys.argv[3]); W0,H0=im.size
  small=im.resize((round(W0*sc),round(H0*sc)),Image.BOX) if sc!=1 else im
  a=np.asarray(small).astype(np.float32)/255
  t=time.time(); o,bad,n=tiled(a); print(sys.argv[1][-14:],sc,'bad',bad,'/',n,'%.0fs'%(time.time()-t))
  if sc!=1:
    up=np.asarray(Image.fromarray((np.clip(o,0,1)*255+.5).astype(np.uint8)).resize((W0,H0),Image.BICUBIC)).astype(np.float32)
    dn=np.asarray(small.resize((W0,H0),Image.BICUBIC)).astype(np.float32)
    res=np.clip(np.asarray(im).astype(np.float32)+up-dn,0,255).astype(np.uint8)
  else: res=(np.clip(o,0,1)*255+.5).astype(np.uint8)
  Image.fromarray(res).save(sys.argv[2])
