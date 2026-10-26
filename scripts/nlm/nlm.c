// Non-Local Means の重み付き平均の 1 つのずれ分（restoration-lowlight.js の nlmJS と、1 ビットも変わらない計算）。
// JavaScript と同じく、倍精度で計算して 32bit に丸める（順番も同じ）。exp は V8 の Math.exp と同じ fdlibm の手順。
// scripts/nlm/build.sh で nlm.wasm.js にする。SIMD を使うより、使わない方が速かった（V8、x86）
#include <stdint.h>

// fdlibm e_exp.c のしきい値（上位 32bit 0x3fd62e43・0x3ff0a2b2・0x3e300000）と係数
static const double HALF_LN2 = 0.34657359123229980469, THREEHALF_LN2 = 1.03972053527832031250, TINY = 3.7252902984619140625e-09;
static const double ln2HI = 6.93147180369123816490e-01, ln2LO = 1.90821492927058770002e-10, invln2 = 1.44269504088896338700e+00;
static const double P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;

// exp(-a)（0 <= a < 6）。分かれ道をなくして（どちらも計算して選ぶ）、予測の外れで遅くならないように
static inline double exp_neg(double a) {
  double x = -a;
  int small = a < HALF_LN2; int mid = a < THREEHALF_LN2;
  int kg = (int)(invln2 * x - 0.5);
  int k = small ? 0 : mid ? -1 : kg;
  double hi = mid ? x + ln2HI : x - k * ln2HI; double lo = mid ? -ln2LO : k * ln2LO;
  double xr = small ? x : hi - lo;
  double t = xr * xr; double c = xr - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  // fdlibm の (x*c)/(c-2) は -(x*c)/(2-c) とまったく同じ値（割り算は符号について対称）なので、割り算は 1 回
  double qd = (xr * c) / (2.0 - c);
  double y0 = 1.0 - (-qd - xr);
  double yk = 1.0 - ((lo - qd) - hi);
  union { double d; int64_t i; } u = { .d = yk }; u.i += (int64_t)k << 52;
  double y = small ? y0 : u.d;
  return a < TINY ? 1.0 + x : y;
}

// boxBlur の横の 1 行（端は、範囲に入る画素だけで平均する）
static void hsum(const float* src, float* tmp, int w, int r) {
  int hr = r < w - 1 ? r : w - 1; double s = 0;
  for (int x = 0; x <= hr; x++) s += src[x];
  tmp[0] = (float)(s / (double)(hr + 1));
  int a = r < w - 1 ? r : w - 1; int b = r + 1 > w - r ? r + 1 : w - r; double k = 2 * r + 1;
  for (int x = 1; x <= a; x++) { int x1 = x + r; if (x1 < w) s += src[x1]; int m = x1 < w - 1 ? x1 : w - 1; tmp[x] = (float)(s / (double)(m + 1)); }
  for (int x = r + 1; x < w - r; x++) { s += src[x + r]; s -= src[x - r - 1]; tmp[x] = (float)(s / k); }
  for (int x = b; x < w; x++) { int x1 = x + r, x0 = x - r - 1; if (x1 < w) s += src[x1]; if (x0 >= 0) s -= src[x0]; int m = x1 < w - 1 ? x1 : w - 1; tmp[x] = (float)(s / (double)(m - (x - r) + 1)); }
}
// 1 つのずれ (dx, dy) 分。差の 2 乗の平均（boxBlur と同じ）を求めて、似ている画素どうしを重み付きで足し込む。
// acc・src は画素ごとに 4 つ（輝度・色差 2 つ・重みの和／ノイズの量の 2 乗）
void nlm_offset(int w, int h, int r, double h2, int dx, int dy, const float* Y, const float* src, float* acc, float* tmp, float* d2, double* col, float* box) {
  for (int y = 0; y < h; y++) {
    int qy = y + dy < h - 1 ? y + dy : h - 1; const float* a = Y + y * w; const float* b = Y + qy * w;
    for (int x = 0; x < w; x++) { int qx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx; double d = (double)a[x] - (double)b[qx]; d2[x] = (float)(d * d); }
    hsum(d2, tmp + y * w, w, r);
  }
  for (int x = 0; x < w; x++) col[x] = 0;
  int rr = r < h - 1 ? r : h - 1;
  for (int y = 0; y <= rr; y++) for (int x = 0; x < w; x++) col[x] += tmp[y * w + x];
  int x0 = dx < 0 ? -dx : 0; int x1 = dx > 0 ? w - dx : w;
  for (int y = 0; y < h - dy; y++) {
    int y1 = y + r, y0 = y - r - 1;
    int cnt = (y + r < h - 1 ? y + r : h - 1) - (y - r > 0 ? y - r : 0) + 1; double dc = cnt;
    const float* ta = (y > 0 && y1 < h) ? tmp + y1 * w : 0; const float* tb = (y > 0 && y0 >= 0) ? tmp + y0 * w : 0;
    if (ta && tb) for (int x = 0; x < w; x++) { double c = col[x] + ta[x] - tb[x]; col[x] = c; box[x] = (float)(c / dc); }
    else if (ta) for (int x = 0; x < w; x++) { double c = col[x] + ta[x]; col[x] = c; box[x] = (float)(c / dc); }
    else if (tb) for (int x = 0; x < w; x++) { double c = col[x] - tb[x]; col[x] = c; box[x] = (float)(c / dc); }
    else for (int x = 0; x < w; x++) box[x] = (float)(col[x] / dc);
    int o = y * w, oq = (y + dy) * w + dx;
    for (int x = x0; x < x1; x++) {
      int p = 4 * (o + x), q = 4 * (oq + x);
      double D = (double)box[x] / (0.5 * ((double)src[p + 3] + (double)src[q + 3])) - 2;
      if (h2 != 1.0) D /= h2; // 1 で割っても値は変わらない
      if (D >= 6) continue;
      double wt = exp_neg(D > 0 ? D : 0);
      acc[p + 3] = (float)((double)acc[p + 3] + wt); acc[q + 3] = (float)((double)acc[q + 3] + wt);
      acc[p] = (float)((double)acc[p] + wt * src[q]); acc[q] = (float)((double)acc[q] + wt * src[p]);
      acc[p + 1] = (float)((double)acc[p + 1] + wt * src[q + 1]); acc[q + 1] = (float)((double)acc[q + 1] + wt * src[p + 1]);
      acc[p + 2] = (float)((double)acc[p + 2] + wt * src[q + 2]); acc[q + 2] = (float)((double)acc[q + 2] + wt * src[p + 2]);
    }
  }
}
