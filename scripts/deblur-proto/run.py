import sys, torch, numpy as np, time
sys.path.insert(0,'.')
from NAFNet_arch import NAFNet
from PIL import Image
import os, NAFNet_arch as A
CL=float(os.environ.get('SCA_CLAMP','0'))
if CL>0:
    def fwd(self,inp):
        x=self.norm1(inp); x=self.conv1(x); x=self.conv2(x); x=self.sg(x)
        x=x*self.sca(x).clamp(-CL,CL)
        x=self.conv3(x); y=inp+x*self.beta
        x=self.conv4(self.norm2(y)); x=self.sg(x); x=self.conv5(x)
        return y+x*self.gamma
    A.NAFBlock.forward=fwd
def load():
    m=NAFNet(img_channel=3,width=32,middle_blk_num=1,enc_blk_nums=[1,1,1,28],dec_blk_nums=[1,1,1,1])
    sd=torch.load('w/NAFNet-GoPro-width32.pth',map_location='cpu'); sd=sd.get('params',sd)
    m.load_state_dict(sd); m.eval(); return m
if __name__=='__main__':
    m=load()
    a=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)/255
    x=torch.from_numpy(a).permute(2,0,1)[None]
    t=time.time()
    with torch.no_grad(): y=m(x)
    print('sec',time.time()-t)
    Image.fromarray((y[0].permute(1,2,0).clamp(0,1).numpy()*255+0.5).astype(np.uint8)).save(sys.argv[2])
