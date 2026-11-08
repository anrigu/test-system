// WebGL2 portrait renderer: warps both parents onto the child's geometry and applies
// age-dependent appearance (skin, hair, eyes, facial hair, wrinkles) in a few GPU passes.
import * as S from './shaders.js';
import {
  CW, CH, N_LM, LM, FACE_OVAL, OVAL_SET, LIP_SET, BROW_SET, MESH_LM, CTRL_OF_LM, EYE_R, EYE_L,
  EYE_R_LOWER, EYE_L_LOWER, LIPS_OUTER, BROW_R_UPPER, BROW_L_UPPER, IRIS_R, IRIS_L, RING1_START, N_CTRL,
  buildControlPoints, applyFrame, toNorm, smoothstep, clamp, curve, lerp, eyeCenters,
} from './mesh.js';
import { childShape, buildInfluence, agingAmount } from './shape.js';
import { rgbToLab, labToRgb } from './analyze.js';

export const HAIR_LAB = {
  black: [13, 1, 1], darkbrown: [21, 4, 8], brown: [31, 7, 14], lightbrown: [43, 8, 18],
  blonde: [62, 5, 26], red: [37, 23, 27], gray: [70, 0, 3],
};
export const EYE_RGB = {
  darkbrown: [58, 36, 22], brown: [92, 60, 38], hazel: [122, 96, 54], green: [88, 118, 78],
  blue: [88, 128, 168], gray: [122, 134, 142],
};
const BACKDROPS = {
  studio: [[0.86, 0.85, 0.83], [0.6, 0.6, 0.61], 1],
  warm: [[0.93, 0.87, 0.8], [0.68, 0.58, 0.5], 1],
  sky: [[0.8, 0.86, 0.92], [0.46, 0.53, 0.63], 1],
  charcoal: [[0.34, 0.34, 0.36], [0.12, 0.12, 0.14], 1],
  original: [[0, 0, 0], [0, 0, 0], 0],
};
const FABRICS = {
  cream: [[0.97, 0.94, 0.88], [0.9, 0.84, 0.76]],
  sage: [[0.73, 0.8, 0.7], [0.62, 0.7, 0.6]],
  blush: [[0.94, 0.8, 0.8], [0.86, 0.68, 0.7]],
  sky: [[0.74, 0.83, 0.93], [0.6, 0.72, 0.86]],
};

const t = (tab, x) => curve(tab, x);

/** Age-dependent appearance schedule. */
export function ageLook(age, sex, o) {
  const boy = sex === 'boy';
  const parentAge = o.parentAge ?? 30;
  const youngerThanParents = age >= 18 ? clamp((parentAge - age) / 25) : 0;
  const look = {
    smooth: t([[0, 0.95], [1, 0.93], [3, 0.9], [6, 0.85], [10, 0.76], [13, 0.64], [16, 0.52], [20, 0.4], [25, 0.3], [32, 0.15], [45, 0.05], [90, 0]], age) + 0.35 * youngerThanParents,
    smoothBig: t([[0, 0.9], [1, 0.82], [3, 0.68], [6, 0.52], [10, 0.36], [13, 0.24], [16, 0.14], [20, 0.06], [25, 0]], age),
    browFade: t([[0, 0.88], [0.5, 0.78], [1, 0.66], [2, 0.5], [4, 0.32], [7, 0.15], [11, 0.05], [14, 0]], age),
    rosy: t([[0, 0.65], [1, 0.58], [3, 0.48], [6, 0.34], [10, 0.22], [14, 0.12], [20, 0.06], [30, 0.03]], age),
    babySkin: t([[0, 1], [1, 0.8], [3, 0.5], [6, 0.22], [10, 0]], age),
    lipNat: boy ? 0.92 : t([[0, 0.9], [13, 0.88], [16, 0.6], [20, 0.4]], age),
    mustache: 0, stubble: 0, beard: 0,
    freckles: o.freckles ? t([[0, 0], [2, 0.3], [5, 0.8], [12, 1], [25, 0.8], [50, 0.5], [90, 0.4]], age) : 0,
    ageSpots: t([[45, 0], [60, 0.4], [75, 0.8], [90, 1]], age),
    acne: o.teenSkin ? t([[11, 0], [13, 0.5], [15, 0.8], [17, 0.6], [19, 0.25], [22, 0]], age) : 0,
    skinAge: t([[40, 0], [55, 0.2], [70, 0.55], [85, 0.9]], age),
    underEye: t([[28, 0], [40, 0.25], [55, 0.5], [75, 0.8]], age),
    gray: Math.max(0, t([[30, 0], [38, 0.08], [45, 0.2], [55, 0.45], [65, 0.7], [75, 0.86], [85, 0.95]], age) * (o.grayRate ?? 1)),
    baby: age <= 2 ? 1 : age >= 2.6 ? 0 : smoothstep(2.6, 2.0, age),
    fuzz: t([[0, 0.3], [0.5, 0.5], [1, 0.72], [2, 0.9]], age),
    newborn: !!o.newbornWrap && age < 0.35,
    hairLight: t([[0, 0.35], [2, 0.3], [5, 0.22], [9, 0.12], [14, 0.04], [18, 0]], age),
    eyeBaby: t([[0, 0.5], [0.5, 0.35], [1, 0.22], [2, 0.07], [3, 0]], age),
    hairClip: age >= 2 && age < 5.5 ? lerp(0.9, 3.4, (age - 2) / 3.5) : 0,
  };
  if (boy) {
    look.mustache = t([[12, 0], [13.5, 0.3], [15, 0.55], [16.5, 0.7], [18, 0.2], [20, 0]], age);
    const style = o.facialHair || 'stubble';
    if (style === 'clean') look.stubble = t([[15, 0], [17, 0.15], [20, 0.25]], age);
    else if (style === 'stubble') look.stubble = t([[15, 0], [17, 0.35], [20, 0.65], [30, 0.75]], age);
    else { look.stubble = t([[15, 0], [17, 0.35], [20, 0.5]], age); look.beard = t([[16, 0], [19, 0.55], [25, 0.85]], age); }
  }
  return look;
}

function wrinkleSchedule(age, parentAge, boy) {
  const sch = (tab) => Math.max(0, t(tab, age) - 0.75 * t(tab, parentAge));
  const m = boy ? 1.15 : 1;
  return {
    forehead: sch([[25, 0], [35, 0.2], [45, 0.45], [60, 0.75], [75, 0.95]]) * m,
    glabella: sch([[35, 0], [45, 0.25], [60, 0.55], [75, 0.8]]) * m,
    crow: sch([[30, 0], [40, 0.3], [55, 0.6], [70, 0.9]]),
    under: sch([[30, 0], [40, 0.25], [55, 0.55], [75, 0.85]]),
    naso: sch([[25, 0], [35, 0.25], [50, 0.55], [65, 0.8], [80, 1]]),
    marionette: sch([[40, 0], [55, 0.4], [70, 0.75], [85, 1]]),
    lip: sch([[50, 0], [65, 0.45], [80, 0.85]]),
    chin: sch([[40, 0], [55, 0.3], [75, 0.6]]),
    cheek: sch([[60, 0], [75, 0.5], [90, 0.85]]),
  };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  return { p, u, a: (name) => gl.getAttribLocation(p, name) };
}

const mixRgb = (a, b, w) => [lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)];
const n255 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
const lumOf = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

export class Renderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW; this.canvas.height = CH;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('This browser has WebGL 2 turned off, which the portrait renderer needs.');
    this.gl = gl;
    this.progs = {
      warp: program(gl, S.WARP_VS, S.WARP_FS),
      attr: program(gl, S.ATTR_VS, S.ATTR_FS),
      compose: program(gl, S.FULL_VS, S.COMPOSE_FS),
      blur: program(gl, S.FULL_VS, S.BLUR_FS),
      final: program(gl, S.FULL_VS, S.FINAL_FS),
    };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.buf = { tgt: gl.createBuffer(), srcM: gl.createBuffer(), srcD: gl.createBuffer(), a0: gl.createBuffer(), a1: gl.createBuffer(), a2: gl.createBuffer() };
    this.ibo = gl.createBuffer(); this.fanIbo = gl.createBuffer(); this.lipIbo = gl.createBuffer(); this.faceIbo = gl.createBuffer();
    const T = (w, h) => this.tex(w, h);
    this.fb = {
      warpM: this.fbo([T(CW, CH), T(CW, CH)]), warpD: this.fbo([T(CW, CH), T(CW, CH)]),
      attr: this.fbo([T(CW, CH), T(CW, CH), T(CW, CH)]),
      comp: this.fbo([T(CW, CH)]),
      b1a: this.fbo([T(CW / 2, CH / 2)]), b1b: this.fbo([T(CW / 2, CH / 2)]),
      b2a: this.fbo([T(CW / 4, CH / 4)]), b2b: this.fbo([T(CW / 4, CH / 4)]),
    };
    this.wrinkleCanvas = document.createElement('canvas');
    this.wrinkleCanvas.width = CW / 2; this.wrinkleCanvas.height = CH / 2;
    this.wctx = this.wrinkleCanvas.getContext('2d', { willReadFrequently: true });
    this.wrinkleTex = T(CW / 2, CH / 2);
    this.src = { colM: T(CW, CH), maskM: T(CW, CH), colD: T(CW, CH), maskD: T(CW, CH) };
    this.ready = false;
  }

  tex(w, h) {
    const gl = this.gl;
    const tx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    tx.w = w; tx.h = h;
    return tx;
  }

  fbo(texs) {
    const gl = this.gl;
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((tx, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tx, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { f, texs, w: texs[0].w, h: texs[0].h };
  }

  upload(tx, canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }

  /** mom/dad: results of analyzePhoto. */
  setParents(mom, dad) {
    const gl = this.gl;
    this.mom = mom; this.dad = dad;
    this.upload(this.src.colM, mom.aligned); this.upload(this.src.maskM, mom.mask);
    this.upload(this.src.colD, dad.aligned); this.upload(this.src.maskD, dad.mask);
    const ctrlM = buildControlPoints(mom.lm), ctrlD = buildControlPoints(dad.lm);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.srcM); gl.bufferData(gl.ARRAY_BUFFER, ctrlM, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.srcD); gl.bufferData(gl.ARRAY_BUFFER, ctrlD, gl.STATIC_DRAW);
    const avg = new Float32Array(N_LM * 2);
    for (let i = 0; i < avg.length; i++) avg[i] = (mom.lm[i] + dad.lm[i]) / 2;
    this.avgLm = avg;
    const tri = new globalThis.Delaunator(buildControlPoints(avg)).triangles;
    this.nTri = tri.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(tri), gl.STATIC_DRAW);
    const fan = [];
    for (const [eye, center] of [[EYE_R, 468], [EYE_L, 473]]) {
      for (let k = 0; k < eye.length; k++) fan.push(CTRL_OF_LM[center], CTRL_OF_LM[eye[k]], CTRL_OF_LM[eye[(k + 1) % eye.length]]);
    }
    this.nFan = fan.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fanIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(fan), gl.STATIC_DRAW);
    const lipFan = [];
    for (let k = 0; k < LIPS_OUTER.length; k++) lipFan.push(CTRL_OF_LM[LM.upperLipIn], CTRL_OF_LM[LIPS_OUTER[k]], CTRL_OF_LM[LIPS_OUTER[(k + 1) % LIPS_OUTER.length]]);
    this.nLip = lipFan.length;
    const faceFan = [];
    for (let k = 0; k < FACE_OVAL.length; k++) faceFan.push(CTRL_OF_LM[LM.noseBridge], CTRL_OF_LM[FACE_OVAL[k]], CTRL_OF_LM[FACE_OVAL[(k + 1) % FACE_OVAL.length]]);
    this.nFace = faceFan.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.faceIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(faceFan), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lipIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(lipFan), gl.STATIC_DRAW);
    this.inf = buildInfluence(mom.lm, dad.lm);
    this.staticAttrs(avg);
    this.ready = true;
  }

  staticAttrs(avg) {
    const { q } = toNorm(avg);
    const a1 = new Float32Array(N_CTRL * 4), a2 = new Float32Array(N_CTRL * 4);
    this.beardZone = new Float32Array(N_LM);
    const gauss = (dx, dy) => Math.exp(-0.5 * (dx * dx + dy * dy));
    MESH_LM.forEach((i, k) => {
      const x = q[2 * i], y = q[2 * i + 1], ax = Math.abs(x);
      const lip = LIP_SET.has(i) ? 1 : 0;
      const beard = smoothstep(0.6, 0.85, y) * (1 - lip);
      this.beardZone[i] = beard;
      const cheek = gauss((ax - 0.62) / 0.2, (y - 0.52) / 0.17);
      const forehead = OVAL_SET.has(i) ? 0 : smoothstep(-0.2, -0.5, y);
      const freck = Math.max(gauss(x / 0.2, (y - 0.42) / 0.28), gauss((ax - 0.5) / 0.28, (y - 0.38) / 0.2));
      a1.set([beard, cheek, forehead, freck], k * 4);
      const under = gauss((ax - 0.5) / 0.22, (y - 0.25) / 0.07);
      const must = (1 - lip) * gauss(x / 0.32, (y - 0.86) / 0.075);
      a2.set([0, under, must, 0], k * 4);
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.a1); gl.bufferData(gl.ARRAY_BUFFER, a1, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.a2); gl.bufferData(gl.ARRAY_BUFFER, a2, gl.STATIC_DRAW);
  }

  /**
   * Render a portrait. p = { age, sex, genes, eye, hair, opts }
   * opts: { hairFrom:'auto'|'mom'|'dad', backdrop, newbornWrap, babyColor, facialHair, freckles,
   *         teenSkin, parentAge, seed, grayRate }
   */
  render(p) {
    if (!this.ready) return null;
    const gl = this.gl;
    const { mom, dad } = this;
    const o = p.opts || {};
    const boy = p.sex === 'boy';
    const shape = childShape(mom.lm, dad.lm, this.inf, p.genes, p.age, p.sex, { parentAge: o.parentAge ?? 30 });
    const look = ageLook(p.age, p.sex, o);
    const lm = shape.lm;

    // Geometry + framing.
    const ctrl = buildControlPoints(lm, shape.ring);
    const e0 = eyeCenters(lm);
    const eyeMidX = (e0.r.x + e0.l.x) / 2;
    const topY = ctrl[2 * RING1_START + 1];
    const chinY0 = lm[2 * LM.chin + 1];
    const s = (0.585 * CH) / (chinY0 - topY);
    const frame = { s, ax: eyeMidX, ay: topY, bx: CW / 2, by: 0.095 * CH };
    applyFrame(ctrl, frame);
    const T = applyFrame(Float32Array.from(lm), frame);
    const P = (i) => ({ x: T[2 * i], y: T[2 * i + 1] });
    const ec = eyeCenters(T);
    const u = Math.hypot(ec.l.x - ec.r.x, ec.l.y - ec.r.y);
    const eyeY = (ec.r.y + ec.l.y) / 2;
    const cx = (ec.r.x + ec.l.x) / 2;

    // Which parent provides hair, ears, neck and clothes.
    const hairFrom = o.hairFrom && o.hairFrom !== 'auto' ? o.hairFrom : (boy ? 'dad' : 'mom');
    const baseW = hairFrom === 'dad' ? 1 : 0;
    const dadBeard = clamp(dad.stats.beard * 1.4);

    // Per-vertex attributes that change per render.
    const a0 = new Float32Array(N_CTRL * 4);
    MESH_LM.forEach((i, k) => {
      const oval = OVAL_SET.has(i);
      let w = clamp(lerp(0.5, shape.w[i], 0.9) + (p.genes.texture ?? 0.5) - 0.5);
      w *= 1 - dadBeard * this.beardZone[i];
      if (oval) w = lerp(w, baseW, 0.85);
      a0.set([oval ? 0 : 1, w, BROW_SET.has(i) ? 1 : 0, 0], k * 4);
    });
    for (let k = MESH_LM.length; k < N_CTRL; k++) a0.set([0, baseW, 0, 0], k * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.a0); gl.bufferData(gl.ARRAY_BUFFER, a0, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.tgt); gl.bufferData(gl.ARRAY_BUFFER, ctrl, gl.DYNAMIC_DRAW);

    gl.disable(gl.DEPTH_TEST);
    // Pass 1: warp each parent.
    const warp = this.progs.warp;
    gl.useProgram(warp.p);
    gl.uniform2f(warp.u.uSize, CW, CH);
    for (const [fb, srcBuf, col, mask] of [[this.fb.warpM, this.buf.srcM, this.src.colM, this.src.maskM], [this.fb.warpD, this.buf.srcD, this.src.colD, this.src.maskD]]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.f);
      gl.viewport(0, 0, CW, CH);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      this.bindAttr(warp.a('aPos'), this.buf.tgt, 2);
      this.bindAttr(warp.a('aSrc'), srcBuf, 2);
      this.bindTex(warp.u.uCol, col, 0); this.bindTex(warp.u.uMask, mask, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.drawElements(gl.TRIANGLES, this.nTri, gl.UNSIGNED_SHORT, 0);
    }
    // Pass 2: attribute maps (max-blended).
    const at = this.progs.attr;
    gl.useProgram(at.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb.attr.f);
    gl.viewport(0, 0, CW, CH);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform2f(at.u.uSize, CW, CH);
    this.bindAttr(at.a('aPos'), this.buf.tgt, 2);
    this.bindAttr(at.a('aA0'), this.buf.a0, 4);
    this.bindAttr(at.a('aA1'), this.buf.a1, 4);
    this.bindAttr(at.a('aA2'), this.buf.a2, 4);
    gl.uniform1f(at.u.uFan, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.drawElements(gl.TRIANGLES, this.nTri, gl.UNSIGNED_SHORT, 0);
    gl.uniform1f(at.u.uFan, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fanIbo);
    gl.drawElements(gl.TRIANGLES, this.nFan, gl.UNSIGNED_SHORT, 0);
    gl.uniform1f(at.u.uFan, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lipIbo);
    gl.drawElements(gl.TRIANGLES, this.nLip, gl.UNSIGNED_SHORT, 0);
    gl.uniform1f(at.u.uFan, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.faceIbo);
    gl.drawElements(gl.TRIANGLES, this.nFace, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);

    // Colours.
    const skinT = mixRgb(mom.stats.skin, dad.stats.skin, p.genes.skin ?? 0.5);
    const gain = (c) => [0, 1, 2].map((k) => clamp(skinT[k] / Math.max(8, c[k]), 0.45, 2.2));
    const gM = gain(mom.stats.skin), gD = gain(dad.stats.skin);
    const base = baseW ? dad : mom, gB = baseW ? gD : gM;
    const hairSrc = base.stats.hairRgb ? base.stats.hairRgb.map((c, k) => c * gB[k]) : skinT.map((c) => c * 0.35);
    const hairLab = this.hairLab(p.hair, look.hairLight);
    const hairT = labToRgb(...hairLab);
    // Keep the parent's real hair untouched when the chosen colour is that parent's own.
    const dE = base.stats.hairLab ? Math.hypot(...hairLab.map((v, k) => v - base.stats.hairLab[k])) : 99;
    const recolor = base.stats.hairRgb ? smoothstep(3, 10, dE) : 0;
    const fab = FABRICS[o.babyColor] || FABRICS.cream;
    const bd = BACKDROPS[o.backdrop] || BACKDROPS.studio;

    // Baby head geometry (output px).
    const J = shape.J;
    const sideHalf = Math.max(Math.abs(P(LM.sideR).x - cx), Math.abs(P(LM.sideL).x - cx));
    const headTop = P(LM.foreheadTop).y - (1.0 + 0.2 * J) * u;
    const headCy = eyeY - 0.3 * u;
    const ry = headCy - headTop;
    const ySide = (P(LM.sideR).y + P(LM.sideL).y) / 2;
    const rx = (sideHalf * 1.1) / Math.sqrt(Math.max(0.25, 1 - ((ySide - headCy) / ry) ** 2));
    const earY = eyeY + 0.36 * u;
    const earHalf = rx * Math.sqrt(Math.max(0.05, 1 - ((earY - headCy) / ry) ** 2));
    const earW = 0.17 * u, earH = 0.34 * u;
    const chinY = P(LM.chin).y;
    const brimY = lerp(P(LM.foreheadTop).y, Math.min(P(105).y, P(334).y), 0.45);
    const fc = { x: cx, y: lerp(P(LM.glabella).y, P(LM.foreheadTop).y, 0.45) };
    const fh = new Float32Array([fc.x, fc.y, fc.x - 0.22 * u, fc.y, fc.x + 0.22 * u, fc.y, fc.x - 0.12 * u, fc.y + 0.12 * u, fc.x + 0.12 * u, fc.y + 0.12 * u]);

    // Pass 3: compose.
    const c = this.progs.compose;
    gl.useProgram(c.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb.comp.f);
    gl.viewport(0, 0, CW, CH);
    this.bindAttr(c.a('aPos'), this.quad, 2);
    gl.uniform1f(c.u.uFlip, 0);
    this.bindTex(c.u.uColM, this.fb.warpM.texs[0], 0); this.bindTex(c.u.uMaskM, this.fb.warpM.texs[1], 1);
    this.bindTex(c.u.uColD, this.fb.warpD.texs[0], 2); this.bindTex(c.u.uMaskD, this.fb.warpD.texs[1], 3);
    this.bindTex(c.u.uAttr0, this.fb.attr.texs[0], 4); this.bindTex(c.u.uAttr1, this.fb.attr.texs[1], 5); this.bindTex(c.u.uAttr2, this.fb.attr.texs[2], 6);
    gl.uniform2f(c.u.uSize, CW, CH); gl.uniform1f(c.u.uU, u);
    gl.uniform3fv(c.u.uGainM, gM); gl.uniform3fv(c.u.uGainD, gD); gl.uniform3fv(c.u.uSkinT, n255(skinT));
    gl.uniform1f(c.u.uBaseW, baseW); gl.uniform3fv(c.u.uBgSrc, n255(base.stats.bgRgb.map((v, k) => v * gB[k])));
    gl.uniform1f(c.u.uEyeY, eyeY);
    const cl = base.stats.clothRgb ? base.stats.clothRgb.map((v, k) => v * gB[k]) : [90, 90, 90];
    gl.uniform1f(c.u.uClothesL, lumOf(cl) / 255);
    gl.uniform2fv(c.u.uFh, fh);
    gl.uniform2f(c.u.uEarProc, base.stats.earVisible[0] ? 0 : 1, base.stats.earVisible[1] ? 0 : 1);
    gl.uniform3fv(c.u.uHairSrc, n255(hairSrc)); gl.uniform3fv(c.u.uHairT, n255(hairT));
    gl.uniform1f(c.u.uHairRecolor, recolor); gl.uniform1f(c.u.uGray, look.gray); gl.uniform1f(c.u.uSeed, (o.seed ?? 1) * 7.13);
    gl.uniform3fv(c.u.uBg1, bd[0]); gl.uniform3fv(c.u.uBg2, bd[1]); gl.uniform1f(c.u.uBgMode, bd[2]);
    gl.uniform1f(c.u.uBaby, look.baby); gl.uniform1f(c.u.uFuzz, look.fuzz);
    gl.uniform1f(c.u.uWrap, look.newborn ? 1 : 0);
    gl.uniform1f(c.u.uHatBrim, brimY); gl.uniform1f(c.u.uHatCurve, 0.45 * u);
    gl.uniform4f(c.u.uHead, cx, headCy, rx, ry);
    gl.uniform4f(c.u.uEarR, cx - earHalf + earW * 0.15, earY, earW, earH);
    gl.uniform4f(c.u.uEarL, cx + earHalf - earW * 0.15, earY, earW, earH);
    gl.uniform1f(c.u.uChinY, chinY); gl.uniform1f(c.u.uCX, cx);
    gl.uniform3fv(c.u.uFabric, fab[0]); gl.uniform3fv(c.u.uFabric2, fab[1]);
    gl.uniform3fv(c.u.uStripe1, [0.9, 0.55, 0.64]); gl.uniform3fv(c.u.uStripe2, [0.5, 0.66, 0.86]);
    gl.uniform1f(c.u.uHairClipY, look.hairClip > 0 && o.hairClip !== false ? chinY + (look.hairClip - 1) * u : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 4: blur pyramid for smoothing.
    this.blur(this.fb.comp.texs[0], this.fb.b1a, this.fb.b1b);
    this.blur(this.fb.b1b.texs[0], this.fb.b2a, this.fb.b2b);

    // Wrinkle layer.
    this.drawWrinkles(P, u, cx, eyeY, wrinkleSchedule(p.age, o.parentAge ?? 30, boy), o.seed ?? 1);
    this.upload(this.wrinkleTex, this.wrinkleCanvas);

    // Pass 5: final look to the canvas.
    const f = this.progs.final;
    gl.useProgram(f.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, CW, CH);
    this.bindAttr(f.a('aPos'), this.quad, 2);
    gl.uniform1f(f.u.uFlip, 1);
    this.bindTex(f.u.uComp, this.fb.comp.texs[0], 0);
    this.bindTex(f.u.uBlur1, this.fb.b1b.texs[0], 1);
    this.bindTex(f.u.uBlur2, this.fb.b2b.texs[0], 2);
    this.bindTex(f.u.uAttr0, this.fb.attr.texs[0], 3); this.bindTex(f.u.uAttr1, this.fb.attr.texs[1], 4); this.bindTex(f.u.uAttr2, this.fb.attr.texs[2], 5);
    this.bindTex(f.u.uWrinkle, this.wrinkleTex, 6);
    gl.uniform2f(f.u.uSize, CW, CH); gl.uniform1f(f.u.uU, u); gl.uniform1f(f.u.uSeed, (o.seed ?? 1) * 3.7);
    gl.uniform1f(f.u.uSmooth, clamp(look.smooth)); gl.uniform1f(f.u.uSmoothBig, look.smoothBig);
    gl.uniform1f(f.u.uBrowFade, look.browFade); gl.uniform1f(f.u.uBrowOff, 0.13 * u);
    gl.uniform1f(f.u.uRosy, look.rosy); gl.uniform1f(f.u.uBabySkin, look.babySkin);
    gl.uniform1f(f.u.uLipNat, look.lipNat * (0.55 + 0.45 * Math.max(mom.stats.lipstick, boy ? 0.6 : 0)));
    gl.uniform3fv(f.u.uSkinT, n255(skinT));
    const lipSrc = mixRgb(mom.stats.lipRgb.map((v, k) => v * gM[k]), dad.stats.lipRgb.map((v, k) => v * gD[k]), 0.5);
    gl.uniform3fv(f.u.uLipSrc, n255(lipSrc));
    // Eyes.
    const irisR = this.irisTarget(T, IRIS_R), irisL = this.irisTarget(T, IRIS_L);
    gl.uniform4f(f.u.uIrisR, irisR.x, irisR.y, irisR.r, 0); gl.uniform4f(f.u.uIrisL, irisL.x, irisL.y, irisL.r, 0);
    gl.uniform1f(f.u.uIrisMag, 1 + 0.2 * J);
    const eyeInfo = this.eyeColor(p.eye, look.eyeBaby);
    gl.uniform3fv(f.u.uEyeColor, n255(eyeInfo.rgb)); gl.uniform1f(f.u.uEyeRecolor, eyeInfo.strength);
    const irisSrc = mixRgb((mom.stats.irisRgb || [80, 60, 45]).map((v, k) => v * gM[k]), (dad.stats.irisRgb || [80, 60, 45]).map((v, k) => v * gD[k]), 0.5);
    gl.uniform1f(f.u.uIrisSrcL, lumOf(irisSrc) / 255);
    // Facial hair.
    const beardRgb = labToRgb(...this.hairLab(p.hair, 0)).map((v) => v * 0.8);
    gl.uniform1f(f.u.uStubble, look.stubble); gl.uniform1f(f.u.uBeard, look.beard); gl.uniform1f(f.u.uMustache, look.mustache);
    gl.uniform3fv(f.u.uBeardColor, n255(look.gray > 0.3 ? mixRgb(beardRgb, [200, 198, 195], clamp(look.gray * 1.1)) : beardRgb));
    gl.uniform1f(f.u.uWrinkleAmt, 1);
    gl.uniform1f(f.u.uFreckles, look.freckles); gl.uniform1f(f.u.uAgeSpots, look.ageSpots); gl.uniform1f(f.u.uAcne, look.acne);
    gl.uniform1f(f.u.uSkinAge, look.skinAge); gl.uniform1f(f.u.uUnderEye, look.underEye);
    gl.uniform1f(f.u.uVignette, o.backdrop === 'original' ? 0.12 : 0.18); gl.uniform1f(f.u.uGrain, 0.022);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { canvas: this.canvas, shape, look, frame };
  }

  irisTarget(T, ring) {
    const c = { x: T[2 * ring[0]], y: T[2 * ring[0] + 1] };
    let r = 0;
    for (let k = 1; k < 5; k++) r += Math.hypot(T[2 * ring[k]] - c.x, T[2 * ring[k] + 1] - c.y);
    return { ...c, r: r / 4 };
  }

  hairLab(choice, lighten) {
    const { mom, dad } = this;
    let lab = null;
    if (choice === 'mom' && mom.stats.hairLab) lab = mom.stats.hairLab;
    else if (choice === 'dad' && dad.stats.hairLab) lab = dad.stats.hairLab;
    else if (choice === mom.stats.hairGuess && mom.stats.hairLab) lab = mom.stats.hairLab;
    else if (choice === dad.stats.hairGuess && dad.stats.hairLab) lab = dad.stats.hairLab;
    else lab = HAIR_LAB[choice] || HAIR_LAB.brown;
    lab = [...lab];
    if (lighten > 0 && lab[0] > 16) { lab[0] += lighten * (lab[0] < 26 ? 10 : 20); lab[2] += lighten * 7; }
    return lab;
  }

  eyeColor(choice, babyShift) {
    const { mom, dad } = this;
    let rgb = EYE_RGB[choice] || EYE_RGB.brown;
    const same = [mom.stats.eyeGuess, dad.stats.eyeGuess].filter((g) => g === choice || (choice === 'darkbrown' && g === 'brown')).length;
    let strength = same === 2 ? 0.3 : same === 1 ? 0.6 : 0.88;
    if (babyShift > 0 && !['brown', 'darkbrown'].includes(choice)) {
      rgb = mixRgb(rgb, [96, 112, 130], babyShift);
      strength = Math.max(strength, 0.6 * babyShift + strength * (1 - babyShift));
    }
    return { rgb, strength };
  }

  bindAttr(loc, buf, size) {
    if (loc < 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  bindTex(loc, tx, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.uniform1i(loc, unit);
  }

  blur(srcTex, fa, fb) {
    const gl = this.gl, b = this.progs.blur;
    gl.useProgram(b.p);
    this.bindAttr(b.a('aPos'), this.quad, 2);
    gl.uniform1f(b.u.uFlip, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fa.f); gl.viewport(0, 0, fa.w, fa.h);
    this.bindTex(b.u.uTex, srcTex, 0); gl.uniform2f(b.u.uDir, 1 / fa.w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.f); gl.viewport(0, 0, fb.w, fb.h);
    this.bindTex(b.u.uTex, fa.texs[0], 0); gl.uniform2f(b.u.uDir, 0, 1 / fb.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawWrinkles(P, u, cx, eyeY, W, seed) {
    const ctx = this.wctx;
    const k = 0.5; // canvas is half resolution
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.wrinkleCanvas.width, this.wrinkleCanvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let rs = seed * 9301 + 49297;
    const rnd = () => { rs = (rs * 9301 + 49297) % 233280; return rs / 233280; };
    const stroke = (pts, width, amt, hl = { x: 0, y: -0.03 }) => {
      if (amt <= 0.01 || pts.length < 2) return;
      for (const [chan, off, a] of [['255,0,0', { x: 0, y: 0 }, amt], ['0,255,0', hl, amt * 0.7]]) {
        for (const [wm, am] of [[3, 0.12], [1.8, 0.25], [1, 0.55]]) {
          for (let s = 0; s < pts.length - 1; s++) {
            const segA = a * am * (0.55 + 0.45 * rnd());
            ctx.strokeStyle = `rgba(${chan},${Math.min(1, segA)})`;
            ctx.lineWidth = Math.max(0.6, width * u * wm * k);
            ctx.beginPath();
            ctx.moveTo((pts[s].x + off.x * u) * k, (pts[s].y + off.y * u) * k);
            ctx.lineTo((pts[s + 1].x + off.x * u) * k, (pts[s + 1].y + off.y * u) * k);
            ctx.stroke();
          }
        }
      }
    };
    const curvePts = (a, b, ctrl, n = 8) => {
      const out = [];
      for (let i = 0; i <= n; i++) {
        const tt = i / n, it = 1 - tt;
        out.push({ x: it * it * a.x + 2 * it * tt * ctrl.x + tt * tt * b.x + (rnd() - 0.5) * 0.012 * u, y: it * it * a.y + 2 * it * tt * ctrl.y + tt * tt * b.y + (rnd() - 0.5) * 0.012 * u });
      }
      return out;
    };
    // Forehead lines.
    const browTop = Math.min(...[...BROW_R_UPPER, ...BROW_L_UPPER].map((i) => P(i).y));
    const hairline = P(LM.foreheadTop).y + 0.12 * u;
    for (let j = 0; j < 3; j++) {
      const y = browTop - u * (0.2 + 0.16 * j);
      if (y < hairline) break;
      const half = (0.62 - 0.08 * j) * u;
      const pts = [];
      for (let i = 0; i <= 10; i++) {
        const x = cx - half + (2 * half * i) / 10;
        const r = (x - cx) / half;
        pts.push({ x, y: y + 0.07 * u * r * r + (rnd() - 0.5) * 0.015 * u });
      }
      stroke(pts, 0.03, W.forehead * (1 - 0.15 * j));
    }
    // Frown lines between the brows.
    const gb = (P(107).y + P(336).y) / 2;
    for (const sgn of [-1, 1]) stroke(curvePts({ x: cx + sgn * 0.09 * u, y: gb - 0.02 * u }, { x: cx + sgn * 0.12 * u, y: gb - 0.24 * u }, { x: cx + sgn * 0.1 * u, y: gb - 0.13 * u }, 4), 0.025, W.glabella, { x: sgn * 0.02, y: 0 });
    // Crow's feet.
    for (const [corner, sgn] of [[P(LM.eyeROuter), -1], [P(LM.eyeLOuter), 1]]) {
      for (const ang of [-0.5, -0.12, 0.25, 0.6]) {
        const sx = corner.x + sgn * 0.08 * u, sy = corner.y;
        const len = (0.15 + 0.06 * rnd()) * u;
        const ex = sx + sgn * Math.cos(ang) * len, ey = sy + Math.sin(ang) * len;
        stroke(curvePts({ x: sx, y: sy }, { x: ex, y: ey }, { x: (sx + ex) / 2, y: (sy + ey) / 2 + 0.02 * u }, 3), 0.02, W.crow * (0.7 + 0.3 * rnd()), { x: 0, y: -0.02 });
      }
    }
    // Under-eye lines.
    for (const lower of [EYE_R_LOWER, EYE_L_LOWER]) {
      for (const [off, amt] of [[0.12, 1], [0.21, 0.55]]) {
        const pts = lower.map((i) => ({ x: P(i).x, y: P(i).y + off * u }));
        stroke(pts, 0.022, W.under * amt, { x: 0, y: 0.025 });
      }
    }
    // Nasolabial folds and marionette lines.
    const sub = P(LM.subnasale);
    for (const [corner, sgn] of [[P(LM.mouthR), -1], [P(LM.mouthL), 1]]) {
      const a = { x: sub.x + sgn * 0.3 * u, y: sub.y - 0.07 * u };
      const b = { x: corner.x + sgn * 0.1 * u, y: corner.y + 0.14 * u };
      const ctrl = { x: (a.x + b.x) / 2 + sgn * 0.12 * u, y: (a.y + b.y) / 2 };
      stroke(curvePts(a, b, ctrl, 10), 0.05, W.naso, { x: sgn * 0.045, y: -0.02 });
      const m0 = { x: corner.x + sgn * 0.03 * u, y: corner.y + 0.05 * u };
      const m1 = { x: corner.x + sgn * 0.11 * u, y: corner.y + 0.42 * u };
      stroke(curvePts(m0, m1, { x: m0.x + sgn * 0.03 * u, y: (m0.y + m1.y) / 2 }, 6), 0.04, W.marionette, { x: sgn * 0.035, y: 0 });
    }
    // Lip lines.
    const top = P(LM.upperLipTop);
    for (let j = 0; j < 6; j++) {
      const x = cx + (j - 2.5) * 0.075 * u;
      const y0 = top.y + Math.abs(j - 2.5) * 0.012 * u;
      stroke([{ x, y: y0 - 0.01 * u }, { x: x + (rnd() - 0.5) * 0.02 * u, y: y0 - (0.06 + 0.04 * rnd()) * u }], 0.014, W.lip * (0.6 + 0.4 * rnd()), { x: 0.012, y: 0 });
    }
    // Chin crease.
    const lb = P(LM.lowerLipBottom);
    stroke(curvePts({ x: cx - 0.22 * u, y: lb.y + 0.06 * u }, { x: cx + 0.22 * u, y: lb.y + 0.06 * u }, { x: cx, y: lb.y + 0.2 * u }, 8), 0.04, W.chin, { x: 0, y: -0.03 });
    // Cheek lines.
    for (const sgn of [-1, 1]) {
      const x = cx + sgn * 0.72 * u;
      stroke(curvePts({ x, y: eyeY + 0.55 * u }, { x: x - sgn * 0.05 * u, y: eyeY + 1.0 * u }, { x: x + sgn * 0.03 * u, y: eyeY + 0.78 * u }, 6), 0.025, W.cheek, { x: sgn * 0.02, y: 0 });
    }
  }
}
