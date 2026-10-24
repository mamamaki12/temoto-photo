import sys,torch,numpy as np,time; sys.path.insert(0,'.')
from run import load; from PIL import Image
m=load()
im=Image.open(sys.argv[1]).convert('RGB')
for sc in [float(s) for s in sys.argv[2:]]:
  b=im.resize((round(im.width*sc),round(im.height*sc)),Image.BOX)
  a=np.asarray(b).astype(np.float32)/255
  bad=[];n=0;t=time.time()
  for y0 in range(0,a.shape[0]-255,224):
    for x0 in range(0,a.shape[1]-255,224):
      c=a[y0:y0+256,x0:x0+256]
      with torch.no_grad(): d=float((m(torch.from_numpy(c.copy()).permute(2,0,1)[None])[0].permute(1,2,0)-torch.from_numpy(c)).abs().max())
      n+=1
      if d>0.6: bad.append((y0,x0,round(d,1)))
  print(sc,n,'bad',len(bad),bad[:8],'%.0fs'%(time.time()-t))
