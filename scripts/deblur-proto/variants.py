import sys,torch,numpy as np; sys.path.insert(0,'.')
from run import load; from PIL import Image
m=load()
def run(x):
  with torch.no_grad(): return m(torch.from_numpy(np.ascontiguousarray(x,dtype=np.float32)).permute(2,0,1)[None])[0].permute(1,2,0).numpy()
V={'id':(lambda x:x,lambda x:x),'lr':(lambda x:x[:,::-1],lambda x:x[:,::-1]),'ud':(lambda x:x[::-1],lambda x:x[::-1]),
   'tr':(lambda x:x.transpose(1,0,2),lambda x:x.transpose(1,0,2)),'s.85':(lambda x:x*0.85,lambda x:x/0.85),'s.6':(lambda x:x*0.6,lambda x:x/0.6)}
im=Image.open(sys.argv[1]).convert('RGB'); sc=float(sys.argv[2]); im=im.resize((round(im.width*sc),round(im.height*sc)),Image.BOX)
a=np.asarray(im).astype(np.float32)/255
tot=0;nostable=0;fails={k:0 for k in V}; spread=[]
for y0 in range(0,a.shape[0]-255,224):
  for x0 in range(0,a.shape[1]-255,224):
    c=a[y0:y0+256,x0:x0+256]; outs=[]
    for k,(f,g) in V.items():
      o=g(run(f(c))); d=np.abs(o-c).max()
      if d>0.6: fails[k]+=1
      else: outs.append(o)
    tot+=1
    if not outs: nostable+=1
    elif len(outs)>1: spread.append(np.abs(outs[0]-outs[1]).mean())
print('tiles',tot,'fails',fails,'none stable',nostable,'mean diff between stable variants %.4f'%np.mean(spread))
