import sys,torch,numpy as np; sys.path.insert(0,'.')
from run import load; from PIL import Image
m=load()
def run(x):
  with torch.no_grad(): return m(torch.from_numpy(np.ascontiguousarray(x,dtype=np.float32)).permute(2,0,1)[None])[0].permute(1,2,0).numpy()
for f in ['../ll_lhand.png','../ll_face.png','../in_chand.png']:
  a=np.asarray(Image.open(f).convert('RGB')).astype(np.float32)/255
  for y0 in range(0,a.shape[0]-255,128):
    for x0 in range(0,a.shape[1]-255,128):
      c=a[y0:y0+256,x0:x0+256]; d=np.abs(run(c)-c).max()
      if d<2: continue
      mu=c.mean((0,1)); sd=c.std()
      r={}
      r['noise']=np.abs(run(c+np.random.randn(*c.shape)*0.01)-c).max()
      r['x0.5']=np.abs(run(c*0.5)*2-c).max()
      r['x0.7']=np.abs(run(c*0.7)/0.7-c).max()
      k=0.12/max(sd,1e-3); r['norm']=np.abs((run((c-mu)*k+0.45)-0.45)/k+mu-c).max()
      r['gamma']=np.abs(run(c**1.5)**(1/1.5)-c).max()
      print(f[-12:],y0,x0,'mean',mu.round(2),'sd',round(float(sd),3),{k:round(float(v),2) for k,v in r.items()})
