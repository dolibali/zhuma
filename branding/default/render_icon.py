#!/usr/bin/env python3
"""Render the Zhuma ribbon-Z mark as reproducible, high-resolution raster assets.
Requires Pillow; no downloaded logo assets or third-party artwork.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math

ROOT=Path(__file__).resolve().parent
W=1024
S=2
N=W*S

def rgba_gradient(a,b,top=(4,11,30),bottom=(7,29,76)):
    img=Image.new('RGBA',(N,N)); p=img.load()
    for y in range(N):
        yy=y/N
        for x in range(N):
            xx=x/N
            cyan=math.exp(-((xx-.88)**2/.09+(yy-.12)**2/.16))*0.48
            blue=math.exp(-((xx-.86)**2/.18+(yy-.85)**2/.16))*0.33
            v=yy*.7+xx*.3
            c=tuple(round(top[i]*(1-v)+bottom[i]*v+cyan*(7,177,181)[i]+blue*(2,35,191)[i]) for i in range(3))
            p[x,y]=(*[min(255,q) for q in c],255)
    return img

def bezier(a,b,c,d,steps=100):
    for i in range(steps+1):
        t=i/steps;u=1-t
        yield ((u**3*a[0]+3*u*u*t*b[0]+3*u*t*t*c[0]+t**3*d[0])*S,
               (u**3*a[1]+3*u*u*t*b[1]+3*u*t*t*c[1]+t**3*d[1])*S)

def pathmask(segments,width):
    m=Image.new('L',(N,N));d=ImageDraw.Draw(m)
    pts=[]
    for seg in segments: pts.extend(bezier(*seg))
    d.line(pts,fill=255,width=width*S,joint='curve')
    r=width*S//2
    for x,y in (pts[0],pts[-1]):d.ellipse((int(x-r),int(y-r),int(x+r),int(y+r)),fill=255)
    return m

def grad(shades,direction='y'):
    out=Image.new('RGBA',(N,N)); p=out.load()
    def interp(v):
        v=max(0,min(1,v)); n=len(shades)-1;i=min(n-1,int(v*n));t=v*n-i
        return tuple(round(shades[i][k]*(1-t)+shades[i+1][k]*t) for k in range(3))+(255,)
    for y in range(N):
        yy=y/N
        for x in range(N):
            xx=x/N
            val=(xx*.65+yy*.35) if direction=='diag' else (xx if direction=='x' else yy)
            p[x,y]=interp(val)
    return out

def layer(canvas,mask,colors,direction='diag',shadow=25):
    if shadow:
        sh=Image.new('RGBA',(N,N),(0,0,0,0));alpha=mask.filter(ImageFilter.GaussianBlur(shadow*S)).point(lambda v:int(v*.49))
        black=Image.new('RGBA',(N,N),(0,1,19,255));sh.paste(black,(0,12*S),alpha.crop((0,0,N,N-12*S))) if False else None
        shadowed=Image.new('RGBA',(N,N),(1,6,27,255));shadowed.putalpha(alpha)
        canvas.alpha_composite(shadowed)
    fill=grad(colors,direction);fill.putalpha(mask);canvas.alpha_composite(fill)

# The first image is an independent high-definition derivation of the approved glowing ribbon-Z concept.
canvas=rgba_gradient(None,None)
shape=Image.new('L',(N,N));ImageDraw.Draw(shape).rounded_rectangle((82*S,76*S,947*S,949*S),radius=220*S,fill=255)
# Luminous colored edge follows the dark square, leaving black outside.
edge=Image.new('RGBA',(N,N),(0,0,0,0));edge_draw=ImageDraw.Draw(edge)
edge_draw.rounded_rectangle((80*S,74*S,949*S,951*S),radius=223*S,fill=(4,171,238,190))
edge_draw.rounded_rectangle((91*S,85*S,938*S,940*S),radius=216*S,fill=(0,0,0,0))
edge=edge.filter(ImageFilter.GaussianBlur(8*S))
background=Image.new('RGBA',(N,N),(2,8,21,255))
background.alpha_composite(edge)
canvas.putalpha(shape);background.alpha_composite(canvas)
canvas=background
# Inner shape and upper crossbar; darker lower side gives a folded-satin effect.
back=pathmask([((301,338),(462,315),(669,331),(749,341))],151)
layer(canvas,back,[(8,223,245),(0,115,241),(1,53,152)],'x',shadow=30)
# The diagonal cyan band crosses in front with rounded graceful ends.
diagonal=pathmask([((780,368),(722,470),(418,636),(325,764))],175)
layer(canvas,diagonal,[(19,230,250),(1,143,242),(64,245,201)],'diag',shadow=21)
# Polished face / specular shine on the top-left of the diagonal.
shine=pathmask([((774,354),(713,467),(463,606),(333,737))],42)
sh=grad([(140,255,237),(4,218,241),(1,113,224)],'diag');sh.putalpha(shine.point(lambda v:int(v*.4)));canvas.alpha_composite(sh)
# Lower folded ribbon, shaded to a royal-blue edge.
lower=pathmask([((336,781),(462,793),(672,791),(740,782))],153)
layer(canvas,lower,[(19,203,248),(5,113,251),(45,68,231)],'diag',shadow=12)
# Soft inner glow and barely visible glass bloom around the upper rim.
upper=Image.new('RGBA',(N,N),(1,193,232,0));gd=ImageDraw.Draw(upper)
gd.arc((82*S,74*S,949*S,951*S),186,335,fill=(11,205,255,170),width=7*S)
upper=upper.filter(ImageFilter.GaussianBlur(13*S));canvas.alpha_composite(upper)
canvas=canvas.resize((W,W),Image.Resampling.LANCZOS).convert('RGB')
canvas.save(ROOT/'icon-source.jpg',quality=92,optimize=True,subsampling=0)
canvas.save(ROOT/'icon.png',optimize=True)
print('Zhuma icon generated:',ROOT/'icon.png')
