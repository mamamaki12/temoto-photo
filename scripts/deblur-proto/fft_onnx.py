# FFTformer（kkkls/FFTformer、MIT）の 8×8 区画の rfft2 / irfft2 を、行列の掛け算に置き換える（ONNX・WebGPU で動かすため。結果は同じ）
import torch, torch.nn as nn, sys
sys.path.insert(0, '.')
import fftformer_arch as A
P=8
def mats():
    eye=torch.eye(P*P).reshape(P*P,P,P)
    F=torch.fft.rfft2(eye)                       # (64,8,5) complex
    Fr=F.real.reshape(P*P,-1); Fi=F.imag.reshape(P*P,-1)   # x(64) @ Fr -> Re (40)
    n=P*(P//2+1); e=torch.eye(n).reshape(n,P,P//2+1)
    Gr=torch.fft.irfft2(torch.complex(e,torch.zeros_like(e)),s=(P,P)).reshape(n,P*P)
    Gi=torch.fft.irfft2(torch.complex(torch.zeros_like(e),e),s=(P,P)).reshape(n,P*P)
    return Fr,Fi,Gr,Gi
Fr,Fi,Gr,Gi=mats()
def to_p(x):
    b,c,h,w=x.shape
    return x.reshape(b,c,h//P,P,w//P,P).permute(0,1,2,4,3,5).reshape(b,c,h//P,w//P,P*P)
def from_p(x,h,w):
    b,c=x.shape[:2]
    return x.reshape(b,c,h//P,w//P,P,P).permute(0,1,2,4,3,5).reshape(b,c,h,w)
def dffn_fwd(self,x):
    x=self.project_in(x); h,w=x.shape[-2:]
    p=to_p(x); wt=self.fft.reshape(1,-1,1,1,P*(P//2+1))
    re=(p@Fr)*wt; im=(p@Fi)*wt
    x=from_p(re@Gr+im@Gi,h,w)
    x1,x2=self.dwconv(x).chunk(2,dim=1)
    return self.project_out(torch.nn.functional.gelu(x1)*x2)
def fsas_fwd(self,x):
    hidden=self.to_hidden(x); q,k,v=self.to_hidden_dw(hidden).chunk(3,dim=1); h,w=q.shape[-2:]
    qp=to_p(q); kp=to_p(k)
    qr,qi=qp@Fr,qp@Fi; kr,ki=kp@Fr,kp@Fi
    out=from_p((qr*kr-qi*ki)@Gr+(qr*ki+qi*kr)@Gi,h,w)
    out=self.norm(out)
    return self.project_out(v*out)
def patch():
    A.DFFN.forward=dffn_fwd; A.FSAS.forward=fsas_fwd
