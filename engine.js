// 描画エンジン（WebGL2）。すべて端末の中（GPU）で計算する。
// 1. 幾何パス: 元写真 → 切り抜き・回転・傾き・遠近補正した画像
// 2. ぼかしパス: 小さく縮めてぼかす（明瞭度・ハイライト/シャドウ・かすみ除去・ブルーム用。画像の大きさに比例するので、プレビューと書き出しで見た目が同じ）
// 3. 色パス: 明るさ・色・カーブ・HSL・カラーグレーディング・部分補正・効果
// 途中の画像は 16bit（半精度の浮動小数点）で持ち、最後に 8bit にするときは細かいディザ（ごく弱いノイズ）を混ぜる。
// 強く編集しても、空や背景・肌のなめらかなグラデーションに縞（トーンジャンプ）が出ない。
// RAW は 8bit に丸めた残り（residual）も GPU に送り、幾何パスで足し戻す（16bit の現像の細かさのまま編集する）
import { geoParams } from './geometry.js';
import { curvesLut } from './curves.js';
import { HSL_BANDS, LOCAL_TYPES } from './state.js';
import { glColorSpace } from './color.js';

const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// 出力の座標 → 元写真の座標（geometry.js の outToSrc と同じ式）
const GEO_FN = `
uniform vec4 uCrop; uniform vec2 uOSize; uniform float uCos, uSin, uZoom, uPa, uPb, uPk; uniform int uRot; uniform int uFlipH, uFlipV;
vec2 outToSrc(vec2 o) {
  vec2 q = uCrop.xy + o * uCrop.zw;
  vec2 p = (q - 0.5) * uOSize;
  vec2 r = vec2(p.x * uCos - p.y * uSin, p.x * uSin + p.y * uCos) / uZoom / uPk;
  vec2 k = vec2(r.x * (1.0 + uPa * (r.y / uOSize.y)), r.y * (1.0 + uPb * (r.x / uOSize.x)));
  vec2 uv = k / uOSize + 0.5;
  if (uFlipH == 1) uv.x = 1.0 - uv.x;
  if (uFlipV == 1) uv.y = 1.0 - uv.y;
  if (uRot == 1) return vec2(uv.y, 1.0 - uv.x);
  if (uRot == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (uRot == 3) return vec2(1.0 - uv.y, uv.x);
  return uv;
}`;

const GEO_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor; uniform sampler2D uSrc, uRes; uniform vec4 uRegion; uniform int uUseRes;
${GEO_FN}
void main() {
  // uRegion: 出力全体のうち、描く範囲（帯ごとに描くとき）。画面の上が y=0 になるように反転
  vec2 g = uRegion.xy + vUv * uRegion.zw;
  vec2 s = clamp(outToSrc(vec2(g.x, 1.0 - g.y)), 0.0, 1.0);
  vec3 c = texture(uSrc, s).rgb;
  // 8bit に丸めた残り（0〜1 に入れてある -0.5〜0.5）を足して、元の細かさに戻す
  if (uUseRes == 1) c += (texture(uRes, s).rgb - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor; uniform sampler2D uTex; uniform vec2 uDir;
void main() {
  // 9タップのガウスぼかし（縮小した画像の上で使うので、実際の半径は大きい）
  vec3 c = texture(uTex, vUv).rgb * 0.2270270;
  c += texture(uTex, vUv + uDir * 1.3846153).rgb * 0.3162162;
  c += texture(uTex, vUv - uDir * 1.3846153).rgb * 0.3162162;
  c += texture(uTex, vUv + uDir * 3.2307692).rgb * 0.0702702;
  c += texture(uTex, vUv - uDir * 3.2307692).rgb * 0.0702702;
  outColor = vec4(c, 1.0);
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor; uniform sampler2D uTex; uniform vec4 uRect;
void main() { outColor = vec4(texture(uTex, uRect.xy + vUv * uRect.zw).rgb, 1.0); }`;

const MAIN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uGeo, uBlur, uBlurMid, uLut, uMask;
uniform vec2 uTexel; uniform float uDetailStep; uniform vec2 uOutSize; uniform vec2 uSrcSize;
uniform float uExposure, uBrightness, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uVibrance, uSaturation, uClarity, uDehaze, uSharpen, uNoise;
uniform float uVignette, uVignetteMid, uGrain, uGrainSize, uFade, uBloom, uHalation;
uniform int uUseLut; uniform vec3 uHsl[8]; uniform float uHslHue[8];
uniform vec3 uGradeSh, uGradeMid, uGradeHi; uniform float uGradeBal;
uniform int uLocalCount; uniform vec4 uLocA[8]; uniform vec4 uLocB[8]; uniform vec4 uLocAdj0[8]; uniform vec4 uLocAdj1[8]; uniform vec4 uLocAdj2[8];
uniform int uBypass; uniform int uShowMask; uniform int uUseNbr; uniform int uUseHsl; uniform int uDither;
uniform vec4 uRegion, uGeoRegion; // 帯ごとに描くとき: 出力全体のうちこの帯の範囲と、幾何パスの画像（少し上下に広い）の範囲
${GEO_FN}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float hueDist(float a, float b) { float d = abs(a - b); return min(d, 1.0 - d); }
vec3 wbGain(float temp, float tint) { return vec3(1.0 + temp * 0.18, 1.0 - tint * 0.12, 1.0 - temp * 0.22) * vec3(1.0 + tint * 0.05, 1.0, 1.0 + tint * 0.05); }
// 明るさだけを変えて色を保つ
vec3 setLuma(vec3 c, float l0, float l1) { return l0 > 1e-4 ? c * (l1 / l0) : vec3(l1); }
// ディザ用の乱数（画素の位置で決まる。帯ごとに描いても同じ）
float dither(vec2 p) {
  uvec2 v = uvec2(p); uint h = v.x * 1664525u + v.y * 1013904223u; h ^= h >> 16; h *= 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16;
  return float(h) / 4294967295.0 - 0.5;
}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

// 明るさの調整（全体と部分補正で共通）。lb はぼかした明るさ（局所的なトーン調整に使う）
vec3 tone(vec3 c, float lb, float lm, float hl, float sh, float contrast, float clarity, float dehaze) {
  float l = luma(c); float l1 = l;
  // 輪郭（周りと明るさが大きく違う所）では、ぼかした明るさでなく自分の明るさを使う → ハロー（縁の光・影）を防ぐ
  // 自分の明るさを主に使い、まわりの明るさ（中・大の半径）は少しだけ混ぜる
  float le = mix(l, lm, 0.15 * (1.0 - smoothstep(0.03, 0.2, abs(l - lm))));
  float sm = 1.0 - smoothstep(0.0, 0.6, le); float hm = smoothstep(0.4, 1.0, le);
  l1 += sh > 0.0 ? sh * 0.45 * sm * (1.0 - l1) : sh * 0.5 * sm * l1;
  // ハイライトを下げるときは、明るいほど強く・でも中間より暗くはしない（白飛びの階調を取り戻す）
  l1 += hl > 0.0 ? hl * 0.3 * hm * (1.0 - l1) : hl * 0.3 * hm * max(l1 - 0.35, 0.0);
  float sc = l1 < 0.5 ? 2.0 * l1 * l1 : 1.0 - 2.0 * (1.0 - l1) * (1.0 - l1);
  l1 = contrast >= 0.0 ? mix(l1, sc, contrast * 0.85) : mix(l1, 0.5, -contrast * 0.45);
  // 明瞭度: 中くらいの半径の細部を強める。大きな差（輪郭）は弱めてハローを防ぐ
  float d = l - lm; d = d / (1.0 + abs(d) * 20.0);
  l1 += d * clarity * (clarity > 0.0 ? 2.2 : 1.0) * (1.0 - pow(2.0 * l - 1.0, 2.0));
  c = setLuma(c, l, max(l1, 0.0));
  if (dehaze > 0.0) { float t = dehaze * 0.35 * lb; c = (c - t * 0.85) / max(1.0 - t * 0.85, 0.2); float g = luma(c); c = mix(vec3(g), c, 1.0 + dehaze * 0.25); }
  else if (dehaze < 0.0) { c = mix(c, vec3(0.85), -dehaze * 0.35); }
  return c;
}

float localMask(int i, vec2 sp, vec3 orig) {
  vec4 a = uLocA[i]; vec4 b = uLocB[i]; int type = int(a.x); float w = 0.0;
  vec2 px = sp * uSrcSize;
  if (type == 0) { int ch = int(a.z); vec4 m = texture(uMask, sp); w = ch == 0 ? m.r : ch == 1 ? m.g : ch == 2 ? m.b : m.a; }
  else if (type == 1) { vec2 p1 = b.xy * uSrcSize; vec2 p2 = b.zw * uSrcSize; vec2 d = p2 - p1; float t = dot(px - p1, d) / max(dot(d, d), 1e-6); w = 1.0 - smoothstep(0.0, 1.0, t); }
  else if (type == 2) { vec2 r = b.zw * uSrcSize.yy; float d = length((px - b.xy * uSrcSize) / max(r, vec2(1e-3))); w = 1.0 - smoothstep(1.0 - a.z, 1.0, d); }
  else if (type == 3) { vec3 hsv = rgb2hsv(orig); w = (1.0 - smoothstep(b.y * 0.5, b.y, hueDist(hsv.x, b.x))) * smoothstep(b.z * 0.5, max(b.z, 1e-3), hsv.y); }
  else { float l = luma(orig); w = smoothstep(b.x - b.z, b.x, l) * (1.0 - smoothstep(b.y, b.y + b.z, l)); }
  if (a.y > 0.5) w = 1.0 - w;
  return clamp(w, 0.0, 1.0);
}

void main() {
  vec2 G = uRegion.xy + vUv * uRegion.zw; // 出力全体での位置
  vec2 gv = (G - uGeoRegion.xy) / uGeoRegion.zw; // 幾何パスの画像での位置
  vec2 uv = vec2(G.x, 1.0 - G.y);
  vec3 orig = texture(uGeo, gv).rgb;
  if (uBypass == 1) { outColor = vec4(orig, 1.0); return; }
  vec3 blur = texture(uBlur, G).rgb;
  vec3 blurMid = texture(uBlurMid, G).rgb;
  vec3 c = orig;

  // ノイズ軽減（明るさが近い近傍だけを混ぜる）とシャープ用の近傍
  // 使わないときは近傍を読まない（遅い端末で9倍の読み込みを省く）
  vec3 avg = orig;
  if (uUseNbr == 1) {
    vec3 sum = vec3(0.0); float wsum = 0.0; avg = vec3(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 n = texture(uGeo, gv + vec2(float(x), float(y)) * uTexel * uDetailStep).rgb;
      avg += n;
      float w = exp(-pow(luma(n) - luma(orig), 2.0) * 200.0);
      sum += n * w; wsum += w;
    }
    avg /= 9.0;
    if (uNoise > 0.0) c = mix(c, sum / wsum, uNoise * 0.9);
  }

  // 色温度・色かぶり・露光（リニアで計算）
  float gain = exp2(uExposure * 4.0);
  c = toSrgb(toLin(c) * wbGain(uTemp, uTint) * gain);
  float lb = luma(toSrgb(toLin(blur) * gain));

  // 白・黒レベル・明るさ（中間調）
  float bp = -uBlacks * 0.12; float wp = 1.0 - uWhites * 0.15;
  float l0 = luma(c); float l1 = clamp((l0 - bp) / max(wp - bp, 0.05), 0.0, 1.5);
  l1 = pow(max(l1, 0.0), exp2(-uBrightness * 0.9));
  c = setLuma(c, l0, l1); lb = clamp((lb - bp) / max(wp - bp, 0.05), 0.0, 1.5);

  float lm = clamp((luma(toSrgb(toLin(blurMid) * gain)) - bp) / max(wp - bp, 0.05), 0.0, 1.5);
  c = tone(c, lb, lm, uHighlights, uShadows, uContrast, uClarity, uDehaze);
  c += (orig - avg) * uSharpen * 2.5;

  // 部分補正
  vec2 sp = outToSrc(uv);
  for (int i = 0; i < 8; i++) {
    if (i >= uLocalCount) break;
    float w = localMask(i, sp, orig);
    if (w <= 0.001) continue;
    vec4 a0 = uLocAdj0[i]; vec4 a1 = uLocAdj1[i]; vec4 a2 = uLocAdj2[i];
    vec3 lc = mix(c, blur, a2.y);
    lc = toSrgb(toLin(lc) * wbGain(a1.x, a1.y) * exp2(a0.x * 2.0));
    lc = tone(lc, lb, lm, a0.z, a0.w, a0.y, a1.w, a2.x);
    float g = luma(lc); lc = mix(vec3(g), lc, 1.0 + a1.z);
    c = mix(c, lc, w);
  }
  float shown = 0.0;
  if (uShowMask >= 0 && uShowMask < uLocalCount) shown = localMask(uShowMask, sp, orig);

  // トーンカーブ
  if (uUseLut == 1) {
    vec3 k = clamp(c, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    c = vec3(texture(uLut, vec2(k.r, 0.5)).r, texture(uLut, vec2(k.g, 0.5)).g, texture(uLut, vec2(k.b, 0.5)).b);
  }

  // HSL（色ごとの色相・彩度・輝度）
  vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
  float dh = 0.0; float ds = 0.0; float dl = 0.0;
  if (uUseHsl == 1) for (int i = 0; i < 8; i++) {
    // 隣の色との間をなめらかに分け合う（どの色相でも重みの合計が1になる）
    float cc = uHslHue[i]; float dp = fract(cc - uHslHue[(i + 7) % 8] + 1.0); float dn = fract(uHslHue[(i + 1) % 8] - cc + 1.0);
    float dd = hsv.x - cc; dd -= floor(dd + 0.5);
    float w = dd >= 0.0 ? max(0.0, 1.0 - dd / dn) : max(0.0, 1.0 + dd / dp);
    dh += uHsl[i].x * w; ds += uHsl[i].y * w; dl += uHsl[i].z * w;
  }
  if (dh != 0.0 || ds != 0.0 || dl != 0.0) {
    float l = luma(c);
    hsv.x = fract(hsv.x + dh * 0.08); hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
    c = hsv2rgb(hsv); c = setLuma(c, luma(c), max(l * (1.0 + dl * 0.5 * hsv.y), 0.0));
  }

  // 自然な彩度（彩度の低い色・肌色を守りながら）と彩度
  vec3 hv = (uUseHsl == 1) ? rgb2hsv(clamp(c, 0.0, 1.0)) : hsv;
  float g = luma(c); float sat = hv.y;
  float skin = 1.0 - smoothstep(0.02, 0.09, hueDist(hv.x, 0.07));
  c = mix(vec3(g), c, 1.0 + uVibrance * (1.0 - sat) * (1.0 - skin * 0.5));
  g = luma(c); c = mix(vec3(g), c, 1.0 + uSaturation);

  // カラーグレーディング（シャドウ・中間・ハイライトに色をのせる）
  float L = clamp(luma(c), 0.0, 1.0); float bal = uGradeBal * 0.25;
  float wsh = 1.0 - smoothstep(0.0, 0.5 + bal, L); float whi = smoothstep(0.5 + bal, 1.0, L); float wmid = 1.0 - wsh - whi;
  c += uGradeSh * wsh + uGradeMid * max(wmid, 0.0) + uGradeHi * whi;

  // フェード・ブルーム・ハレーション
  c = c * (1.0 - uFade * 0.2) + uFade * 0.1;
  vec3 bloom = max(blur * gain - 0.55, 0.0) * uBloom * 1.6;
  vec3 hal = vec3(1.0, 0.32, 0.12) * max(lb - 0.6, 0.0) * uHalation * 2.2;
  c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(bloom + hal, 0.0, 1.0));

  // 周辺光量
  vec2 d = (uv - 0.5) * vec2(uOutSize.x / max(uOutSize.x, uOutSize.y), uOutSize.y / max(uOutSize.x, uOutSize.y)) * 1.41421;
  float r = length(d); float mid = mix(0.25, 0.95, uVignetteMid);
  float v = smoothstep(mid - 0.35, mid + 0.45, r);
  c = uVignette < 0.0 ? c * (1.0 + uVignette * v * 0.85) : mix(c, vec3(1.0), uVignette * v * 0.7);

  // 粒子（画像の大きさに対する割合で決めるので、書き出しの大きさが変わっても同じ見た目）
  if (uGrain > 0.0) {
    vec2 gp = uv * uOutSize / max(uOutSize.x, uOutSize.y) * mix(900.0, 220.0, uGrainSize);
    float n = vnoise(gp) + vnoise(gp * 2.1 + 17.0) * 0.5 - 0.75;
    float lw = 1.0 - abs(2.0 * luma(c) - 1.0) * 0.6;
    c += n * uGrain * 0.28 * lw;
  }
  c = mix(c, vec3(1.0, 0.15, 0.2), shown * 0.55);
  // 8bit にするときの縞を防ぐ（±0.5 段階のディザ）
  if (uDither == 1) c += dither(G * uOutSize) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function hueToRgbOffset(h, s) {
  // 色相 h（度）の色を、平均0のずれとして返す（明るさを変えずに色だけのせる）
  const k = (n) => { const x = (n + h / 30) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(x - 3, 9 - x, 1)); };
  const rgb = [k(0), k(8), k(4)]; const m = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return rgb.map((v) => (v - m) * (s / 100) * 0.35);
}

const FULL = [0, 0, 1, 1];
/** シャープ・ノイズ軽減で近くの画素を読む間隔（画像の大きさに比例させて、どの大きさでも同じ見た目に） */
const detailStep = (w, h) => Math.max(1, Math.max(w, h) / 2000);

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('webgl2');
    glColorSpace(gl); // Display P3 の写真を、くすませずに読み込み・描く
    this.gl = gl;
    // 途中の画像を 16bit（半精度）で持てるか（ほとんどの端末で使える。使えなければ 8bit）
    this.hi = !!gl.getExtension('EXT_color_buffer_float');
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.progs = { geo: this.program(GEO_FRAG), blur: this.program(BLUR_FRAG), copy: this.program(COPY_FRAG), main: this.program(MAIN_FRAG) };
    this.src = this.texture(); this.res = this.texture(); this.lut = this.texture(); this.mask = this.texture(); this.useRes = false;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.fbs = {};
    this.lutKey = '';
    this.srcW = 1; this.srcH = 1;
  }

  program(frag) {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); const name = u.name.replace(/\[0\]$/, ''); loc[name] = gl.getUniformLocation(p, u.name); }
    return { p, loc };
  }

  texture() {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** 描き込み先。bytes: 8bit（画素を読み出すもの）。それ以外は 16bit で持つ */
  fb(name, w, h, bytes = false) {
    const gl = this.gl; let f = this.fbs[name];
    if (f && f.w === w && f.h === h) return f;
    if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
    const tex = this.texture();
    if (this.hi && !bytes) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    f = { tex, fb, w, h }; this.fbs[name] = f;
    return f;
  }

  /** 元写真（修復を当てたもの）を GPU に送る */
  setSource(image, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // 画面に小さく表示するときに画素を飛ばして読むと、輪郭がギザギザ・ザラザラになるので、縮小版（ミップマップ）をなめらかにつなぐ
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.srcW = w; this.srcH = h;
  }

  /**
   * RAW の 8bit に丸めた残り { width, height, data: Uint8Array（RGBA。0〜255 が -0.5〜0.5） }。null なら使わない。
   * 元写真（setSource）と同じ大きさ。修復・美肌をしても、残りはそのまま足してよい（±0.5 段階より小さいので）
   */
  setResidual(res) {
    const gl = this.gl;
    this.useRes = !!res;
    if (!res) return;
    gl.bindTexture(gl.TEXTURE_2D, this.res); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res.width, res.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, res.data);
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  /** ブラシの部分補正のマスク { width, height, data: Uint8Array }（RGBA の各チャンネルが1つのブラシ。元写真の座標） */
  setMask(mask) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, mask.width, mask.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask.data);
  }

  draw(prog, target, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  bindTex(prog, name, tex, unit) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.loc[name], unit);
  }

  setGeo(prog, geo) {
    const gl = this.gl; const p = geoParams(geo, this.srcW, this.srcH); const L = prog.loc;
    gl.uniform4f(L.uCrop, ...p.crop); gl.uniform2f(L.uOSize, ...p.size);
    gl.uniform1f(L.uCos, p.cos); gl.uniform1f(L.uSin, p.sin); gl.uniform1f(L.uZoom, p.zoom);
    gl.uniform1f(L.uPa, p.pa); gl.uniform1f(L.uPb, p.pb); gl.uniform1f(L.uPk, p.pk);
    gl.uniform1i(L.uRot, p.rot); gl.uniform1i(L.uFlipH, p.flipH); gl.uniform1i(L.uFlipV, p.flipV);
  }

  /**
   * 描画する。state は effective()（フィルターを重ねた後）の値
   * @param {{bypass?: boolean, showMask?: number}} opts bypass: 色の調整をせずに表示（比較用）／showMask: 部分補正の範囲を赤く表示
   */
  render(state, outW, outH, { bypass = false, showMask = -1 } = {}) {
    if (this.canvas.width !== outW || this.canvas.height !== outH) { this.canvas.width = outW; this.canvas.height = outH; }
    const geo = this.fb('geo', outW, outH);
    this.drawGeo(state, geo, outW, outH, FULL);
    const blurs = this.blurs(geo, outW, outH);
    this.drawMain(state, null, outW, outH, { geo, blurs, region: FULL, geoRegion: FULL, texel: [1 / outW, 1 / outH], bypass, showMask });
  }

  /** 1. 幾何（region: 出力全体のうち描く範囲。GL の座標で [x, y, 幅, 高さ]） */
  drawGeo(state, target, w, h, region) {
    const gl = this.gl; const pg = this.progs.geo; gl.useProgram(pg.p);
    this.bindTex(pg, 'uSrc', this.src, 0); this.bindTex(pg, 'uRes', this.res, 1); gl.uniform1i(pg.loc.uUseRes, this.useRes ? 1 : 0);
    this.setGeo(pg, state.geo); gl.uniform4f(pg.loc.uRegion, ...region);
    this.draw(pg, target, w, h);
  }

  /** 2. ぼかし（長辺 192px に縮小 → 縦横にぼかす ×2）。geo は出力全体の幾何画像（縮小したものでもよい） */
  blurs(geo, outW, outH) {
    const gl = this.gl; const pc = this.progs.copy;
    const copy = (src, dst, w, h) => { gl.useProgram(pc.p); this.bindTex(pc, 'uTex', src.tex, 0); gl.uniform4f(pc.loc.uRect, 0, 0, 1, 1); this.draw(pc, dst, w, h); };
    const s = 192 / Math.max(outW, outH);
    const bw = Math.max(4, Math.round(outW * Math.min(1, s))); const bh = Math.max(4, Math.round(outH * Math.min(1, s)));
    // 段階的に縮小してちらつき（エイリアス）を防ぐ
    let prev = geo; let lw = outW; let lh = outH; let step = 0;
    let mid = Math.max(outW, outH) <= 720 ? geo : null; // 明瞭度用（長辺720px前後）
    while (lw / 2 > bw && lh / 2 > bh && step < 6) {
      lw = Math.max(bw, Math.round(lw / 2)); lh = Math.max(bh, Math.round(lh / 2));
      const f = this.fb(`down${step}`, lw, lh); copy(prev, f, lw, lh); prev = f; step++;
      if (!mid && Math.max(lw, lh) <= 720) mid = f;
    }
    if (!mid) mid = prev;
    const m1 = this.fb('mid1', mid.w, mid.h); const m2 = this.fb('mid2', mid.w, mid.h);
    const pb = this.progs.blur;
    const pass = (src, dst, w, h, dx, dy) => { gl.useProgram(pb.p); this.bindTex(pb, 'uTex', src.tex, 0); gl.uniform2f(pb.loc.uDir, dx, dy); this.draw(pb, dst, w, h); };
    pass(mid, m2, mid.w, mid.h, 1 / mid.w, 0); pass(m2, m1, mid.w, mid.h, 0, 1 / mid.h);
    const b1 = this.fb('blur1', bw, bh); const b2 = this.fb('blur2', bw, bh);
    copy(prev, b1, bw, bh);
    for (let i = 0; i < 2; i++) { pass(b1, b2, bw, bh, 1.5 / bw, 0); pass(b2, b1, bw, bh, 0, 1.5 / bh); }
    return { b1, m1 };
  }

  /** 3. 色。target が null なら画面（canvas）に描く */
  drawMain(state, target, outW, outH, { geo, blurs, region, geoRegion, texel, bypass = false, showMask = -1, w = outW, h = outH }) {
    const gl = this.gl;
    const pm = this.progs.main; const L = pm.loc; gl.useProgram(pm.p);
    this.bindTex(pm, 'uGeo', geo.tex, 0); this.bindTex(pm, 'uBlur', blurs.b1.tex, 1); this.bindTex(pm, 'uBlurMid', blurs.m1.tex, 4);
    gl.uniform4f(L.uRegion, ...region); gl.uniform4f(L.uGeoRegion, ...geoRegion);
    const key = JSON.stringify(state.curves);
    if (key !== this.lutKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, curvesLut(state.curves));
      this.lutKey = key;
    }
    this.bindTex(pm, 'uLut', this.lut, 2); this.bindTex(pm, 'uMask', this.mask, 3);
    gl.uniform1i(L.uUseLut, key === '{"rgb":[[0,0],[1,1]],"r":[[0,0],[1,1]],"g":[[0,0],[1,1]],"b":[[0,0],[1,1]]}' ? 0 : 1);
    gl.uniform1i(L.uBypass, bypass ? 1 : 0); gl.uniform1i(L.uShowMask, showMask); gl.uniform1i(L.uDither, 1);
    gl.uniform1i(L.uUseNbr, state.adj.sharpen > 0 || state.adj.noise > 0 ? 1 : 0);
    gl.uniform1i(L.uUseHsl, HSL_BANDS.some(([k]) => state.hsl[k].h || state.hsl[k].s || state.hsl[k].l) ? 1 : 0);
    gl.uniform2f(L.uTexel, ...texel); gl.uniform1f(L.uDetailStep, detailStep(outW, outH));
    gl.uniform2f(L.uOutSize, outW, outH); gl.uniform2f(L.uSrcSize, this.srcW, this.srcH);
    this.setGeo(pm, state.geo);
    const a = state.adj; const f = (k) => (a[k] || 0) / 100;
    for (const k of ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'clarity', 'dehaze', 'sharpen', 'noise', 'vignette', 'vignetteMid', 'grain', 'grainSize', 'fade', 'bloom', 'halation']) {
      gl.uniform1f(L[`u${k[0].toUpperCase()}${k.slice(1)}`], f(k));
    }
    gl.uniform3fv(L.uHsl, HSL_BANDS.flatMap(([k]) => [state.hsl[k].h / 100, state.hsl[k].s / 100, state.hsl[k].l / 100]));
    gl.uniform1fv(L.uHslHue, HSL_BANDS.map(([, , deg]) => deg / 360));
    gl.uniform3fv(L.uGradeSh, hueToRgbOffset(state.grade.shadows.h, state.grade.shadows.s));
    gl.uniform3fv(L.uGradeMid, hueToRgbOffset(state.grade.mids.h, state.grade.mids.s));
    gl.uniform3fv(L.uGradeHi, hueToRgbOffset(state.grade.highs.h, state.grade.highs.s));
    gl.uniform1f(L.uGradeBal, state.grade.balance / 100);
    // 部分補正
    const types = Object.keys(LOCAL_TYPES);
    const locs = state.locals.slice(0, 8); let brush = 0;
    const A = new Float32Array(32); const B = new Float32Array(32); const J0 = new Float32Array(32); const J1 = new Float32Array(32); const J2 = new Float32Array(32);
    locs.forEach((l, i) => {
      const t = types.indexOf(l.type);
      A.set([t, l.invert ? 1 : 0, l.type === 'brush' ? brush++ : l.type === 'radial' ? l.feather / 100 : 0, 0], i * 4);
      if (l.type === 'linear') B.set([l.x1, l.y1, l.x2, l.y2], i * 4);
      if (l.type === 'radial') B.set([l.cx, l.cy, l.rx * this.srcW / this.srcH, l.ry], i * 4);
      if (l.type === 'color') B.set([l.hue / 360, l.range / 360, l.minSat / 100, 0], i * 4);
      if (l.type === 'luma') B.set([l.lo, l.hi, Math.max(0.01, l.soft), 0], i * 4);
      const j = l.adj; const q = (k) => (j[k] || 0) / 100;
      J0.set([q('exposure'), q('contrast'), q('highlights'), q('shadows')], i * 4);
      J1.set([q('temp'), q('tint'), q('saturation'), q('clarity')], i * 4);
      J2.set([q('dehaze'), Math.max(0, q('blur')), 0, 0], i * 4);
    });
    gl.uniform1i(L.uLocalCount, locs.length);
    gl.uniform4fv(L.uLocA, A); gl.uniform4fv(L.uLocB, B); gl.uniform4fv(L.uLocAdj0, J0); gl.uniform4fv(L.uLocAdj1, J1); gl.uniform4fv(L.uLocAdj2, J2);
    this.draw(pm, target, w, h);
  }

  // ── 元の大きさで書き出すとき: 大きな画像を、横長の帯に分けて描く（大きな Canvas を作らない） ──

  /** 帯で描く準備（ぼかしは、全体を縮めて描いた画像から先に作っておく） */
  beginStrips(state, outW, outH) {
    const s = Math.min(1, 2048 / Math.max(outW, outH));
    const pw = Math.max(4, Math.round(outW * s)); const ph = Math.max(4, Math.round(outH * s));
    const small = this.fb('pgeo', pw, ph);
    this.drawGeo(state, small, pw, ph, FULL);
    this.strip = { state, outW, outH, blurs: this.blurs(small, pw, ph) };
  }

  /** 出力の y0 行目から rows 行を描いて、画素（RGBA、上の行から）を返す */
  renderStrip(y0, rows) {
    const gl = this.gl; const { state, outW, outH, blurs } = this.strip;
    const m = Math.ceil(detailStep(outW, outH)) + 2; // シャープ・ノイズ軽減が近くの画素を読むぶん、上下に広く
    const gy0 = Math.max(0, y0 - m); const gy1 = Math.min(outH, y0 + rows + m); const gh = gy1 - gy0;
    const geoRegion = [0, 1 - gy1 / outH, 1, gh / outH];
    const geo = this.fb('sgeo', outW, gh); this.drawGeo(state, geo, outW, gh, geoRegion);
    const out = this.fb('sout', outW, rows, true);
    this.drawMain(state, out, outW, outH, { geo, blurs, region: [0, 1 - (y0 + rows) / outH, 1, rows / outH], geoRegion, texel: [1 / outW, 1 / gh], w: outW, h: rows });
    const px = new Uint8Array(outW * rows * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb); gl.readPixels(0, 0, outW, rows, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // GL は下の行から並ぶので、上下を入れ替える
    const flip = new Uint8ClampedArray(px.length); const stride = outW * 4;
    for (let y = 0; y < rows; y++) flip.set(px.subarray((rows - 1 - y) * stride, (rows - y) * stride), y * stride);
    return flip;
  }

  endStrips() { this.strip = null; for (const k of ['sgeo', 'sout', 'pgeo']) { const f = this.fbs[k]; if (f) { this.gl.deleteTexture(f.tex); this.gl.deleteFramebuffer(f.fb); delete this.fbs[k]; } } }

  /** 元の大きさの写真を、分けて GPU に送る（allocSource → putSource… → finishSource） */
  allocSource(w, h) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.srcW = w; this.srcH = h;
    if (this.srcFb) gl.deleteFramebuffer(this.srcFb);
    this.srcFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.src, 0);
  }
  /** 画像（Canvas・ImageBitmap）を (x, y) に置く。色空間はそろえて読み込まれる */
  putSource(x, y, image) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.src); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }
  /** 画素（RGBA の配列。色空間は変換しない）を置く */
  putSourcePixels(x, y, w, h, data) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.src); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.length));
  }
  /** 置いた画像の一部を読み出す（修復・モザイクを元の大きさで当てるため） */
  readSource(x, y, w, h) {
    const gl = this.gl; const px = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFb); gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px.buffer));
    return px;
  }
  /** 置いた画像の一部を、縮めて読み出す（大きなぼかしは縮めた画像の上で計算する） */
  readSourceScaled(x, y, w, h, sw, sh) {
    const gl = this.gl; const pc = this.progs.copy; const f = this.fb('tmpA', sw, sh, true);
    gl.useProgram(pc.p); this.bindTex(pc, 'uTex', this.src, 0); gl.uniform4f(pc.loc.uRect, x / this.srcW, y / this.srcH, w / this.srcW, h / this.srcH); this.draw(pc, f, sw, sh);
    const px = new Uint8ClampedArray(sw * sh * 4); gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px.buffer));
    return px;
  }
  /** 小さな画素を、引き伸ばして (x, y, w, h) に描く */
  putSourceScaled(x, y, w, h, sw, sh, data) {
    const gl = this.gl; const pc = this.progs.copy;
    if (!this.tmpTex) this.tmpTex = this.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.tmpTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.length));
    gl.useProgram(pc.p); this.bindTex(pc, 'uTex', this.tmpTex, 0); gl.uniform4f(pc.loc.uRect, 0, 0, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFb); gl.viewport(x, y, w, h);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** RAW の丸めた残りも、分けて送る（allocResidual → putResidualPixels… → finishSource） */
  allocResidual(w, h) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.res);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.useRes = true;
  }
  putResidualPixels(x, y, w, h, data) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.res); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  finishSource() {
    const gl = this.gl;
    for (const t of this.useRes ? [this.src, this.res] : [this.src]) {
      gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
  }

  /** 表示中の画像を小さく読み出す（ヒストグラム用） */
  readSmall(maxSide = 160) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const s = Math.min(1, maxSide / Math.max(this.canvas.width, this.canvas.height));
    c.width = Math.max(1, Math.round(this.canvas.width * s)); c.height = Math.max(1, Math.round(this.canvas.height * s));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  dispose() {
    const gl = this.gl;
    for (const f of Object.values(this.fbs)) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
    for (const t of [this.src, this.res, this.lut, this.mask, this.tmpTex]) if (t) gl.deleteTexture(t);
    if (this.srcFb) gl.deleteFramebuffer(this.srcFb);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
