import numpy as np
from PIL import Image
def line_psf(L,ang,w=1.0,size=None):
    size=size or int(L+6)|1; c=size//2
    yy,xx=np.mgrid[-c:c+1,-c:c+1].astype(float)
    t=np.radians(ang); ux,uy=np.cos(t),np.sin(t)
    along=xx*ux+yy*uy; perp=-xx*uy+yy*ux
    k=np.exp(-0.5*(perp/w)**2)*np.clip(L/2+0.5-np.abs(along),0,1)
    return k/k.sum()
def psf2otf(k,shape):
    p=np.zeros(shape); h,w=k.shape; p[:h,:w]=k
    p=np.roll(p,(-(h//2),-(w//2)),(0,1)); return np.fft.fft2(p)
def deconv(y,k,lam=0.003,iters=8,pad=None):
    # y: HxW linear channel. TV-L1 half quadratic.
    pad=pad or k.shape[0]*2
    yp=np.pad(y,pad,mode='reflect'); H,W=yp.shape
    K=psf2otf(k,(H,W)); Dx=psf2otf(np.array([[0,0,0],[0,-1,1],[0,0,0]]),(H,W)); Dy=psf2otf(np.array([[0,0,0],[0,-1,0],[0,1,0]]),(H,W))
    KtY=np.conj(K)*np.fft.fft2(yp); den1=np.abs(K)**2; den2=np.abs(Dx)**2+np.abs(Dy)**2
    x=yp.copy(); beta=lam*4
    for i in range(iters):
        X=np.fft.fft2(x); gx=np.real(np.fft.ifft2(Dx*X)); gy=np.real(np.fft.ifft2(Dy*X))
        th=lam/beta
        wx=np.sign(gx)*np.maximum(np.abs(gx)-th,0); wy=np.sign(gy)*np.maximum(np.abs(gy)-th,0)
        num=KtY + beta*(np.conj(Dx)*np.fft.fft2(wx)+np.conj(Dy)*np.fft.fft2(wy))
        x=np.real(np.fft.ifft2(num/(den1+beta*den2)))
        beta*=2.5
    return x[pad:-pad,pad:-pad]
