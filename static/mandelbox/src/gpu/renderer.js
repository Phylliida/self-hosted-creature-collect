// renderer.js — WebGL2 progressive Mandelbox perturbation renderer.
//
// Owns a hidden canvas + GL context, the reference-orbit textures, and the
// ping-pong march state. Usage:
//   const gpu = new MbGpu();                    // .supported tells you
//   gpu.uploadRef(refPlain);
//   gpu.begin(scene);                           // scene = genMeta-shaped
//   gpu.step(K);                                // advance K DE evals/pixel
//   const r = gpu.read(basis);                  // → renderRows-shaped buffers
//   ... until r.unresolved === 0, then gpu.normals(); gpu.read(basis) again.
//
// read() returns {hit, nx, ny, nz, steps, tlog, unresolved} with rows already
// flipped to the CPU convention (row 0 = top), so the app's existing shading
// and blitting consume GPU frames unchanged.

import { VS, MARCH_FS, NORMAL_FS } from './shaders.js';

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}
function link(gl, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

const REF_TEX = ['texZ', 'texS1', 'texS2', 'texS3', 'texI1', 'texI2', 'texI3'];

export class MbGpu {
  constructor() {
    this.supported = false;
    try {
      const canvas = typeof document !== 'undefined'
        ? document.createElement('canvas')
        : new OffscreenCanvas(4, 4);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false });
      if (!gl) return;
      if (!gl.getExtension('EXT_color_buffer_float')) return;
      this.gl = gl;
      this.canvas = canvas;
      this.march = link(gl, MARCH_FS);
      this.normal = link(gl, NORMAL_FS);
      this.u = { march: this._locs(this.march), normal: this._locs(this.normal) };
      this.vao = gl.createVertexArray();
      this.W = 0; this.H = 0;
      this.state = [null, null]; this.stateFb = [null, null]; this.cur = 0;
      this.normTex = null; this.normFb = null;
      this.refTex = {};
      this.supported = true;
    } catch (e) {
      this.supported = false;
      this.error = String(e && e.message || e);
    }
  }

  _locs(prog) {
    const gl = this.gl, out = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      out[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
    }
    return out;
  }

  _tex(name, w, h, internal, format, type, data) {
    const gl = this.gl;
    let t = this.refTex[name];
    if (!t) { t = this.refTex[name] = gl.createTexture(); }
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    return t;
  }

  uploadRef(ref) {
    const gl = this.gl, len = ref.len;
    this.refLen = len;
    const z = new Float32Array((len + 1) * 4);
    for (let m = 0; m <= len; m++) { z[m * 4] = ref.zx[m]; z[m * 4 + 1] = ref.zy[m]; z[m * 4 + 2] = ref.zz[m]; }
    this._tex('texZ', 1, len + 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, z);
    const s1 = new Float32Array(len * 4), s2 = new Float32Array(len * 4), s3 = new Float32Array(len * 4);
    const i1 = new Int32Array(len * 4), i2 = new Int32Array(len * 4), i3 = new Int32Array(len * 4);
    for (let m = 0; m < len; m++) {
      s1[m * 4] = ref.bx[m]; s1[m * 4 + 1] = ref.by[m]; s1[m * 4 + 2] = ref.bz[m]; s1[m * 4 + 3] = ref.rho2[m];
      for (let c = 0; c < 3; c++) {
        s2[m * 4 + c] = ref.uM[3 * m + c]; i1[m * 4 + c] = ref.uE[3 * m + c];
        s3[m * 4 + c] = ref.wM[3 * m + c]; i2[m * 4 + c] = ref.wE[3 * m + c];
        i3[m * 4 + c] = ref.boxReg[3 * m + c];
      }
      s2[m * 4 + 3] = ref.rMM[m]; i1[m * 4 + 3] = ref.rME[m];
      s3[m * 4 + 3] = ref.rFM[m]; i2[m * 4 + 3] = ref.rFE[m];
      i3[m * 4 + 3] = ref.sphReg[m];
    }
    this._tex('texS1', 1, len, gl.RGBA32F, gl.RGBA, gl.FLOAT, s1);
    this._tex('texS2', 1, len, gl.RGBA32F, gl.RGBA, gl.FLOAT, s2);
    this._tex('texS3', 1, len, gl.RGBA32F, gl.RGBA, gl.FLOAT, s3);
    this._tex('texI1', 1, len, gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, i1);
    this._tex('texI2', 1, len, gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, i2);
    this._tex('texI3', 1, len, gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, i3);
  }

  _stateTex(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb };
  }

  // scene: { W, H, cam: {o: [{m,e}×3], fwd, right, up, planeScale}, opts }
  begin(scene) {
    const gl = this.gl;
    const { W, H } = scene;
    if (W !== this.W || H !== this.H) {
      this.W = W; this.H = H;
      this.canvas.width = W; this.canvas.height = H;
      for (const s of this.state) if (s) { gl.deleteTexture(s.t); gl.deleteFramebuffer(s.fb); }
      this.state = [this._stateTex(W, H), this._stateTex(W, H)];
      if (this.normTex) { gl.deleteTexture(this.normTex.t); gl.deleteFramebuffer(this.normTex.fb); }
      this.normTex = this._stateTex(W, H);
    }
    // clear both state buffers to zero (t=0, steps=0, status=marching)
    for (const s of this.state) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.cur = 0;
    this.scene = scene;
    this.normalsDone = false;
    this._stateArr = new Float32Array(W * H * 4);
    this._normArr = null;
  }

  _sceneUniforms(u) {
    const gl = this.gl, sc = this.scene;
    const { cam, opts } = sc;
    gl.uniform1i(u.uRefLen, this.refLen);
    gl.uniform1i(u.uMaxIter, opts.maxIter);
    gl.uniform3f(u.uFwd, cam.fwd[0], cam.fwd[1], cam.fwd[2]);
    gl.uniform3f(u.uRight, cam.right[0], cam.right[1], cam.right[2]);
    gl.uniform3f(u.uUp, cam.up[0], cam.up[1], cam.up[2]);
    gl.uniform1f(u.uPlaneScale, cam.planeScale);
    gl.uniform2f(u.uRes, sc.W, sc.H);
    gl.uniform3f(u.uCamM, cam.o[0].m, cam.o[1].m, cam.o[2].m);
    gl.uniform3f(u.uCamE, cam.o[0].e, cam.o[1].e, cam.o[2].e);
    gl.uniform1f(u.uPixFactor, opts.pixFactor);
    gl.uniform2f(u.uEpsAbs, opts.epsAbs.m, opts.epsAbs.e);
    gl.uniform2f(u.uTMax, opts.tMax.m, opts.tMax.e);
    for (let i = 0; i < REF_TEX.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.refTex[REF_TEX[i]]);
      gl.uniform1i(u[REF_TEX[i]], i);
    }
  }

  step(K) {
    const gl = this.gl, sc = this.scene;
    const src = this.state[this.cur], dst = this.state[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.march);
    gl.bindVertexArray(this.vao);
    this._sceneUniforms(this.u.march);
    const u = this.u.march;
    gl.uniform1i(u.uK, K);
    gl.uniform1i(u.uMaxSteps, sc.opts.maxSteps);
    gl.uniform1f(u.uRelax, sc.opts.relax);
    gl.activeTexture(gl.TEXTURE0 + REF_TEX.length);
    gl.bindTexture(gl.TEXTURE_2D, src.t);
    gl.uniform1i(u.uState, REF_TEX.length);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
  }

  normals() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normTex.fb);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.normal);
    gl.bindVertexArray(this.vao);
    this._sceneUniforms(this.u.normal);
    gl.activeTexture(gl.TEXTURE0 + REF_TEX.length);
    gl.bindTexture(gl.TEXTURE_2D, this.state[this.cur].t);
    gl.uniform1i(this.u.normal.uState, REF_TEX.length);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this._normArr = this._normArr || new Float32Array(this.W * this.H * 4);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, this._normArr);
    this.normalsDone = true;
  }

  // Read current state into renderRows-shaped buffers (row 0 = top). Hit
  // pixels get real normals after normals(); before that a −dir fallback.
  read() {
    const gl = this.gl, W = this.W, H = this.H, sc = this.scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[this.cur].fb);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, this._stateArr);
    const st = this._stateArr, nm = this._normArr;
    const hit = new Uint8Array(W * H);
    const nx = new Float32Array(W * H), ny = new Float32Array(W * H), nz = new Float32Array(W * H);
    const steps = new Uint16Array(W * H);
    const tlog = new Float32Array(W * H);
    const { fwd, right, up, planeScale } = sc.cam;
    const aspect = W / H;
    let unresolved = 0;
    for (let j = 0; j < H; j++) {
      const g = H - 1 - j; // GL row → CPU row
      const sy = (1 - 2 * (j + 0.5) / H) * planeScale;
      for (let i = 0; i < W; i++) {
        const si = (g * W + i) * 4, di = j * W + i;
        const status = st[si + 3];
        steps[di] = st[si + 2];
        if (status === 0) unresolved++;
        if (status !== 1) continue;
        hit[di] = 1;
        tlog[di] = st[si] === 0 ? -1e9 : Math.log2(Math.abs(st[si])) + st[si + 1];
        if (nm && this.normalsDone) {
          nx[di] = nm[si]; ny[di] = nm[si + 1]; nz[di] = nm[si + 2];
        } else {
          const sx = (2 * (i + 0.5) / W - 1) * planeScale * aspect;
          const dx = fwd[0] + sx * right[0] + sy * up[0], dy = fwd[1] + sx * right[1] + sy * up[1], dz = fwd[2] + sx * right[2] + sy * up[2];
          const l = Math.hypot(dx, dy, dz) || 1;
          nx[di] = -dx / l; ny[di] = -dy / l; nz[di] = -dz / l;
        }
      }
    }
    return { hit, nx, ny, nz, steps, tlog, unresolved };
  }
}
