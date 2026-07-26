// shaders.js — GLSL ES 3.00 sources for the GPU Mandelbox perturbation
// marcher (WebGL2).
//
// Deep zoom on GPU needs extended-range floats: a floatexp type is
// implemented as vec2(mantissa, exponent) — mantissa a float32 normalized to
// ±[1,2), exponent an integer carried in a float (exact to 2^24, far beyond
// any zoom we reach). Normalization and exact powers of two use
// floatBitsToInt/intBitsToFloat (no transcendental error). 24-bit mantissas
// are ample for rendering: perturbation keeps errors RELATIVE to the pixel
// scale, so the image is exact-for-a-point-within-2^-20-pixels — the same
// argument as the CPU engine's, with a shorter mantissa (the CPU path stays
// the oracle; see fractals2's validate.js philosophy).
//
// The perturbation iteration is a line-for-line port of math/perturb.js
// (exact fold-difference identities + Zhuoran rebasing + dr cap) reading the
// reference orbit + fold residuals from textures:
//   texZ  (RGBA32F, len+1 rows): Z_m = (zx, zy, zz, 0)
//   texS1 (RGBA32F, len rows):   (bx, by, bz, rho2B)
//   texS2 (RGBA32F): u mantissas + rM mantissa   (uMx, uMy, uMz, rMM)
//   texS3 (RGBA32F): w mantissas + rF mantissa   (wMx, wMy, wMz, rFM)
//   texI1 (RGBA32I): u exponents + rM exponent
//   texI2 (RGBA32I): w exponents + rF exponent
//   texI3 (RGBA32I): (boxRegX, boxRegY, boxRegZ, sphReg)
//
// Marching is PROGRESSIVE: per-pixel state (t as floatexp, step count,
// status) lives in a ping-pong RGBA32F texture; each frame advances
// unresolved pixels by uK DE evaluations. A second program computes
// tetrahedron normals for hit pixels. Status codes: 0 marching, 1 hit,
// 2 miss.

export const VS = `#version 300 es
void main() {
  // Fullscreen triangle from gl_VertexID.
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Shared floatexp library + perturbation DE.
const LIB = `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp isampler2D;

uniform sampler2D texZ;
uniform sampler2D texS1;
uniform sampler2D texS2;
uniform sampler2D texS3;
uniform isampler2D texI1;
uniform isampler2D texI2;
uniform isampler2D texI3;
uniform int uRefLen;
uniform int uMaxIter;

// ---- floatexp: vec2(m, e), m in ±[1,2) or 0 ----
vec2 feN(float m, float e) {
  if (m == 0.0) return vec2(0.0, 0.0);
  int b = floatBitsToInt(abs(m));
  int ex = (b >> 23) & 255;
  if (ex == 0) return vec2(0.0, 0.0); // subnormal mantissa: below our care
  float mm = intBitsToFloat((b & 8388607) | 1065353216); // [1,2)
  return vec2(m < 0.0 ? -mm : mm, e + float(ex - 127));
}
float p2(float e) { // exact 2^e for e in [-126, 127]
  return intBitsToFloat((int(e) + 127) << 23);
}
vec2 feAdd(vec2 a, vec2 b) {
  if (a.x == 0.0) return b;
  if (b.x == 0.0) return a;
  float d = a.y - b.y;
  if (d > 26.0) return a;
  if (d < -26.0) return b;
  if (d >= 0.0) return feN(a.x + b.x * p2(-d), a.y);
  return feN(b.x + a.x * p2(d), b.y);
}
vec2 feNeg(vec2 a) { return vec2(-a.x, a.y); }
vec2 feSub(vec2 a, vec2 b) { return feAdd(a, vec2(-b.x, b.y)); }
vec2 feMul(vec2 a, vec2 b) { return feN(a.x * b.x, a.y + b.y); }
vec2 feMulF(vec2 a, float f) { return feN(a.x * f, a.y); }
vec2 feDiv(vec2 a, vec2 b) { return feN(a.x / b.x, a.y - b.y); }
vec2 feAddF(vec2 a, float f) { return feAdd(a, feN(f, 0.0)); }
bool feLt(vec2 a, vec2 b) { return feSub(a, b).x < 0.0; }
vec2 feMax(vec2 a, vec2 b) { return feLt(a, b) ? b : a; }
vec2 feSqrt(vec2 a) {
  if (a.x <= 0.0) return vec2(0.0, 0.0);
  float m = a.x, e = a.y;
  if (mod(e, 2.0) != 0.0) { m *= 2.0; e -= 1.0; }
  return feN(sqrt(m), e * 0.5);
}
float feToF(vec2 a) { // O(1)-scale values only
  return a.x * p2(clamp(a.y, -126.0, 127.0));
}
float feLog2(vec2 a) { return a.x == 0.0 ? -1.0e9 : log2(abs(a.x)) + a.y; }

// ---- fold differences (port of perturb.js) ----
vec2 boxDiff(vec2 di, vec2 u, vec2 w, int rReg) {
  vec2 eUp = feSub(di, u);
  vec2 eDn = feAdd(di, w);
  int zReg = eUp.x > 0.0 ? 1 : (eDn.x < 0.0 ? -1 : 0);
  if (rReg == 0) {
    if (zReg == 0) return di;
    if (zReg == 1) return feSub(feMulF(u, 2.0), di);
    return feSub(feMulF(w, -2.0), di);
  } else if (rReg == 1) {
    if (zReg == 1) return feNeg(di);
    if (zReg == 0) return feSub(di, feMulF(u, 2.0));
    return feAddF(feNeg(feAdd(eDn, u)), -2.0);
  }
  if (zReg == -1) return feNeg(di);
  if (zReg == 0) return feAdd(di, feMulF(w, 2.0));
  return feAddF(feSub(w, eUp), 2.0);
}
vec2 sphDiff(vec2 bi, float Bi, float r2B, int rS, int zS,
             vec2 drho, vec2 eM, vec2 eF, vec2 rM, vec2 rF, vec2 rhoz) {
  if (rS == zS) {
    if (rS == 0) return feMulF(bi, 4.0);
    if (rS == 2) return bi;
    return feDiv(feSub(feMulF(bi, r2B), feMulF(drho, Bi)), feMulF(rhoz, r2B));
  }
  if (rS == 0 && zS == 1) return feDiv(feSub(bi, feMulF(eM, 4.0 * Bi)), rhoz);
  if (rS == 1 && zS == 0) return feAdd(feMulF(bi, 4.0), feMulF(rM, 4.0 * Bi / r2B));
  if (rS == 1 && zS == 2) return feAdd(bi, feMulF(rF, Bi / r2B));
  if (rS == 2 && zS == 1) return feDiv(feSub(bi, feMulF(eF, Bi)), rhoz);
  if (rS == 0 && zS == 2) return feAddF(bi, -3.0 * Bi);
  return feAddF(feMulF(bi, 4.0), 3.0 * Bi);
}

// Perturbed DE. Returns status in .x (0 escaped, 1 interior, 2 dr-capped)
// and DE as floatexp in .yz (valid when status == 0).
vec3 perturbDE(vec2 dcx, vec2 dcy, vec2 dcz, float drCap) {
  vec2 dx = vec2(0.0), dy = vec2(0.0), dz = vec2(0.0);
  vec2 dr = vec2(1.0, 0.0);
  int m = 0;
  for (int n = 1; n <= 4096; n++) {
    if (n > uMaxIter) break;
    vec4 s1 = texelFetch(texS1, ivec2(0, m), 0);
    vec4 s2 = texelFetch(texS2, ivec2(0, m), 0);
    vec4 s3 = texelFetch(texS3, ivec2(0, m), 0);
    ivec4 i1 = texelFetch(texI1, ivec2(0, m), 0);
    ivec4 i2 = texelFetch(texI2, ivec2(0, m), 0);
    ivec4 i3 = texelFetch(texI3, ivec2(0, m), 0);

    vec2 bx = boxDiff(dx, vec2(s2.x, float(i1.x)), vec2(s3.x, float(i2.x)), i3.x);
    vec2 by = boxDiff(dy, vec2(s2.y, float(i1.y)), vec2(s3.y, float(i2.y)), i3.y);
    vec2 bz = boxDiff(dz, vec2(s2.z, float(i1.z)), vec2(s3.z, float(i2.z)), i3.z);

    float r2B = s1.w;
    vec2 drho = feAdd(feAdd(feMulF(bx, 2.0 * s1.x), feMulF(by, 2.0 * s1.y)), feMulF(bz, 2.0 * s1.z));
    drho = feAdd(drho, feAdd(feAdd(feMul(bx, bx), feMul(by, by)), feMul(bz, bz)));
    vec2 rM = vec2(s2.w, float(i1.w));
    vec2 rF = vec2(s3.w, float(i2.w));
    vec2 eM = feAdd(rM, drho);
    vec2 eF = feAdd(rF, drho);
    int zS = eM.x < 0.0 ? 0 : (eF.x < 0.0 ? 1 : 2);
    int rS = i3.w;
    vec2 rhoz = feAdd(feN(r2B, 0.0), drho);

    vec2 sx = sphDiff(bx, s1.x, r2B, rS, zS, drho, eM, eF, rM, rF, rhoz);
    vec2 sy = sphDiff(by, s1.y, r2B, rS, zS, drho, eM, eF, rM, rF, rhoz);
    vec2 sz = sphDiff(bz, s1.z, r2B, rS, zS, drho, eM, eF, rM, rF, rhoz);

    float kz = zS == 0 ? 4.0 : (zS == 2 ? 1.0 : 1.0 / feToF(rhoz));
    dr = feAddF(feMulF(dr, 2.0 * kz), 1.0);
    if (dr.y >= drCap) return vec3(2.0, 0.0, 0.0);

    dx = feAdd(feMulF(sx, 2.0), dcx);
    dy = feAdd(feMulF(sy, 2.0), dcy);
    dz = feAdd(feMulF(sz, 2.0), dcz);

    vec4 Zn = texelFetch(texZ, ivec2(0, m + 1), 0);
    vec2 zfx = feAddF(dx, Zn.x);
    vec2 zfy = feAddF(dy, Zn.y);
    vec2 zfz = feAddF(dz, Zn.z);
    vec2 z2 = feAdd(feAdd(feMul(zfx, zfx), feMul(zfy, zfy)), feMul(zfz, zfz));

    if (z2.x > 0.0 && (z2.y > 16.0 || (z2.y == 16.0 && z2.x > 1.0))) { // |z|^2 > 65536 = 2^16
      vec2 de = feDiv(feSqrt(z2), dr);
      return vec3(0.0, de.x, de.y);
    }
    m++;
    vec2 d2 = feAdd(feAdd(feMul(dx, dx), feMul(dy, dy)), feMul(dz, dz));
    if (m == uRefLen || feLt(z2, d2)) {
      dx = zfx; dy = zfy; dz = zfz;
      m = 0;
    }
  }
  return vec3(1.0, 0.0, 0.0);
}

// Ray direction for a fragment (matches renderSpan: CPU row j = GL row H-1-j,
// gl_FragCoord already carries the +0.5 pixel center).
uniform vec3 uFwd; uniform vec3 uRight; uniform vec3 uUp;
uniform float uPlaneScale;
uniform vec2 uRes;
vec3 rayDir(vec2 frag) {
  float sx = (2.0 * frag.x / uRes.x - 1.0) * uPlaneScale * (uRes.x / uRes.y);
  float sy = (2.0 * frag.y / uRes.y - 1.0) * uPlaneScale;
  return normalize(uFwd + sx * uRight + sy * uUp);
}

uniform vec3 uCamM; uniform vec3 uCamE;   // camera offset (floatexp vec3)
uniform float uPixFactor;
uniform vec2 uEpsAbs;   // fe
uniform vec2 uTMax;     // fe
`;

export const MARCH_FS = `#version 300 es
${LIB}
uniform sampler2D uState;
uniform int uK;
uniform int uMaxSteps;
uniform float uRelax;
out vec4 outState;

void main() {
  ivec2 pc = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uState, pc, 0);
  if (st.w != 0.0) { outState = st; return; }
  vec2 t = vec2(st.x, st.y);
  float steps = st.z;
  vec3 dir = rayDir(gl_FragCoord.xy);
  for (int k = 0; k < 64; k++) {
    if (k >= uK) break;
    vec2 dcx = feAdd(vec2(uCamM.x, uCamE.x), feMulF(t, dir.x));
    vec2 dcy = feAdd(vec2(uCamM.y, uCamE.y), feMulF(t, dir.y));
    vec2 dcz = feAdd(vec2(uCamM.z, uCamE.z), feMulF(t, dir.z));
    vec2 heps = feMax(feMulF(t, uPixFactor), uEpsAbs);
    vec3 r = perturbDE(dcx, dcy, dcz, 12.0 - heps.y);
    steps += 1.0;
    if (r.x != 0.0 || !feLt(heps, vec2(r.y, r.z))) { st.w = 1.0; break; }  // interior/capped/de<=eps
    t = feAdd(t, feMulF(vec2(r.y, r.z), uRelax));
    if (feLt(uTMax, t)) { st.w = 2.0; break; }
    if (steps >= float(uMaxSteps)) { st.w = 1.0; break; }                  // fog crust
  }
  outState = vec4(t.x, t.y, steps, st.w);
}`;

export const NORMAL_FS = `#version 300 es
${LIB}
uniform sampler2D uState;
out vec4 outN;

void main() {
  ivec2 pc = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uState, pc, 0);
  if (st.w != 1.0) { outN = vec4(0.0); return; }
  vec2 t = vec2(st.x, st.y);
  vec3 dir = rayDir(gl_FragCoord.xy);
  vec2 px = feAdd(vec2(uCamM.x, uCamE.x), feMulF(t, dir.x));
  vec2 py = feAdd(vec2(uCamM.y, uCamE.y), feMulF(t, dir.y));
  vec2 pz = feAdd(vec2(uCamM.z, uCamE.z), feMulF(t, dir.z));
  vec2 h = feMax(feMulF(t, uPixFactor * 0.5), uEpsAbs);
  float drCap = 22.0 - h.y;
  // Tetrahedron probes k = (1,-1,-1), (-1,-1,1), (-1,1,-1), (1,1,1)
  vec2 nx = vec2(0.0), ny = vec2(0.0), nz = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 kv = k == 0 ? vec3(1, -1, -1) : (k == 1 ? vec3(-1, -1, 1) : (k == 2 ? vec3(-1, 1, -1) : vec3(1, 1, 1)));
    vec3 r = perturbDE(feAdd(px, feMulF(h, kv.x)), feAdd(py, feMulF(h, kv.y)), feAdd(pz, feMulF(h, kv.z)), drCap);
    vec2 de = r.x == 0.0 ? vec2(r.y, r.z) : vec2(0.0);
    nx = feAdd(nx, feMulF(de, kv.x));
    ny = feAdd(ny, feMulF(de, kv.y));
    nz = feAdd(nz, feMulF(de, kv.z));
  }
  float emax = max(nx.x == 0.0 ? -1.0e9 : nx.y, max(ny.x == 0.0 ? -1.0e9 : ny.y, nz.x == 0.0 ? -1.0e9 : nz.y));
  vec3 n;
  if (emax < -1.0e8) n = -dir;
  else {
    n = vec3(
      nx.x == 0.0 ? 0.0 : nx.x * p2(clamp(nx.y - emax, -126.0, 0.0)),
      ny.x == 0.0 ? 0.0 : ny.x * p2(clamp(ny.y - emax, -126.0, 0.0)),
      nz.x == 0.0 ? 0.0 : nz.x * p2(clamp(nz.y - emax, -126.0, 0.0)));
    float l = length(n);
    n = l < 1.0e-12 ? -dir : n / l;
  }
  // A primary hit's surface must face the camera; gradient noise across the
  // thin escape-time shells (worst at high iteration counts) occasionally
  // inverts the tetrahedron normal — flip it back.
  if (dot(n, dir) > 0.0) n = -n;
  outN = vec4(n, feLog2(t));
}`;
