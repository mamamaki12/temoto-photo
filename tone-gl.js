// 明るさ補正のスライダーを動かしている間の見本を、GPU で描く（restoration-lowlight.js の applyTone と同じ計算。ディザと粒は省く）。
// ノイズを取った写真を縮めたもの（輝度・色差。enhancePhoto の cache.pv）を一度 GPU に送っておき、
// スライダーが動くたびに、新しい明るさの曲線（planTone）だけを送って描き直す（CPU では 1 回 0.5 秒以上かかり、動きについてこない）
import { glColorSpace } from './color.js';
import { KNEE } from './restoration-lowlight.js';

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uP; uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uM;
uniform ivec2 uG; uniform ivec2 uMG; uniform vec2 uFull; uniform int uH;
uniform int uTone; uniform int uPerson;
uniform float uGain; uniform float uWp2; uniform float uSat; uniform float uKnee;
uniform vec3 uWb; uniform vec3 uWbP;
out vec4 o;
// restoration-lowlight.js の sampleGrid と同じ（端はいちばん外の値）
float grid(sampler2D g, ivec2 n, vec2 f) {
  vec2 p = clamp(f, vec2(0.0), vec2(n - 1));
  ivec2 i0 = ivec2(floor(p)); ivec2 i1 = min(n - 1, i0 + 1); vec2 t = p - vec2(i0);
  float a = texelFetch(g, i0, 0).r; float b = texelFetch(g, ivec2(i1.x, i0.y), 0).r;
  float c = texelFetch(g, ivec2(i0.x, i1.y), 0).r; float d = texelFetch(g, i1, 0).r;
  return (a * (1.0 - t.x) + b * t.x) * (1.0 - t.y) + (c * (1.0 - t.x) + d * t.x) * t.y;
}
float lin(float v) { v = clamp(v, 0.0, 1.0); return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float srgb(float v) { v = clamp(v, 0.0, 1.0); return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
void main() {
  ivec2 q = ivec2(int(gl_FragCoord.x), uH - 1 - int(gl_FragCoord.y));
  vec3 P = texelFetch(uP, q, 0).rgb;
  float yy = P.r; float r0 = yy + P.b; float b0 = yy + P.g; float g0 = (yy - 0.299 * r0 - 0.114 * b0) / 0.587;
  vec3 c = vec3(lin(r0), lin(g0), lin(b0));
  if (uTone == 1) {
    vec2 xy = vec2(q) + 0.5;
    float p = uPerson == 1 ? grid(uM, uMG, xy * vec2(uMG) / uFull - 0.5) : 0.5;
    c *= uWb + (uWbP - uWb) * p;
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722)); float lg = log(L + 1e-4);
    vec2 gp = xy * vec2(uG) / uFull - 0.5;
    float base = grid(uA, uG, gp) * lg + grid(uB, uG, gp);
    float xb = max(0.0, exp(base) - 1e-4) * uGain;
    float yb = xb * (1.0 + xb / uWp2) / (1.0 + xb);
    float Lo = yb * exp(lg - base);
    float k = Lo / (L + 1e-4); float kc = k > 1.0 ? pow(k, uSat) : k;
    c = Lo + (c - L) * kc;
    float mx = max(c.r, max(c.g, c.b));
    if (mx > uKnee) c *= (uKnee + (1.0 - uKnee) * (1.0 - exp(-(mx - uKnee) / (1.0 - uKnee)))) / mx;
  }
  o = vec4(srgb(c.r), srgb(c.g), srgb(c.b), 1.0);
}`;

export class TonePreviewGL {
  /** 使えない端末（WebGL2 がない・小数のテクスチャを読めない）では例外 */
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('webgl2');
    glColorSpace(gl);
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p; this.loc = {};
    for (const n of ['uP', 'uA', 'uB', 'uM', 'uG', 'uMG', 'uFull', 'uH', 'uTone', 'uPerson', 'uGain', 'uWp2', 'uSat', 'uKnee', 'uWb', 'uWbP']) this.loc[n] = gl.getUniformLocation(p, n);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.tex = [0, 1, 2, 3].map(() => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    });
    this.pv = null; this.grids = null;
  }

  /** 縮めた輝度・色差（{ w, h, Y, Cb, Cr }）を GPU に送る（同じものなら送らない） */
  setPlanes(pv) {
    if (this.pv === pv) return;
    const gl = this.gl; const n = pv.w * pv.h; const d = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { d[i * 4] = pv.Y[i]; d[i * 4 + 1] = pv.Cb[i]; d[i * 4 + 2] = pv.Cr[i]; }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, pv.w, pv.h, 0, gl.RGBA, gl.FLOAT, d);
    this.canvas.width = pv.w; this.canvas.height = pv.h;
    this.pv = pv;
  }

  /** 明るさの曲線（planTone の結果。null なら明るさは変えない）を当てて描く。描いた Canvas を返す */
  draw(tone) {
    const gl = this.gl; const L = this.loc; const pv = this.pv;
    gl.useProgram(this.p);
    const one = (t, k, g) => { gl.bindTexture(gl.TEXTURE_2D, this.tex[k]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, g.w, g.h, 0, gl.RED, gl.FLOAT, t); };
    if (tone) {
      // 明るさの曲線の格子は、曲線が変わったときだけ送る
      if (this.grids !== tone) { one(tone.a, 1, tone); one(tone.b, 2, tone); if (tone.person) one(tone.person.m, 3, tone.person); this.grids = tone; }
      gl.uniform2i(L.uG, tone.w, tone.h); gl.uniform2i(L.uMG, tone.person?.w || 1, tone.person?.h || 1);
      gl.uniform1f(L.uGain, tone.gain); gl.uniform1f(L.uWp2, tone.white * tone.white); gl.uniform1f(L.uSat, tone.sat); gl.uniform1f(L.uKnee, KNEE);
      gl.uniform3fv(L.uWb, tone.wb); gl.uniform3fv(L.uWbP, tone.wbP);
    }
    gl.uniform1i(L.uTone, tone ? 1 : 0); gl.uniform1i(L.uPerson, tone?.person ? 1 : 0);
    gl.uniform2f(L.uFull, pv.w, pv.h); gl.uniform1i(L.uH, pv.h);
    [L.uP, L.uA, L.uB, L.uM].forEach((u, k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, this.tex[k]); gl.uniform1i(u, k); });
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, pv.w, pv.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  dispose() { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
