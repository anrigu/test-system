// Child face geometry: blends the parents' landmark shapes per feature ("genes"), then applies
// sex differences (ramping through puberty), craniofacial growth from newborn proportions,
// and adult ageing (sagging, thinning lips, drooping lids). All maths in eye-normalised units.
import {
  N_LM, LM, FACE_OVAL, OVAL_SET, BROW_R, BROW_L, LIPS_OUTER, EYE_R, EYE_L,
  EYE_R_UPPER, EYE_L_UPPER, toNorm, fromNorm, centroid, smoothstep, clamp, curve,
} from './mesh.js';

const GROWTH_GIRL = [[0, 0], [0.5, 0.09], [1, 0.15], [2, 0.23], [3, 0.29], [5, 0.38], [7, 0.46], [9, 0.55], [11, 0.65], [13, 0.78], [15, 0.9], [17, 0.97], [19, 1]];
const GROWTH_BOY = [[0, 0], [0.5, 0.09], [1, 0.15], [2, 0.23], [3, 0.29], [5, 0.38], [7, 0.46], [9, 0.54], [11, 0.62], [13, 0.72], [15, 0.85], [17, 0.94], [19, 0.99], [21, 1]];
const SEX_BOY = [[0, 0.08], [9, 0.1], [11, 0.16], [13, 0.3], [15, 0.5], [17, 0.62], [20, 0.7]];
const SEX_GIRL = [[0, -0.08], [8, -0.1], [10, -0.18], [12, -0.34], [14, -0.46], [16, -0.54], [19, -0.58]];

export function growth(age, sex) { return curve(sex === 'boy' ? GROWTH_BOY : GROWTH_GIRL, age); }
export function agingAmount(age) { return Math.pow(Math.max(0, (age - 27) / 63), 1.2); }

const gauss = (dx, dy) => Math.exp(-0.5 * (dx * dx + dy * dy));

function centroidQ(q, idx) {
  let x = 0, y = 0;
  for (const i of idx) { x += q[2 * i]; y += q[2 * i + 1]; }
  return [x / idx.length, y / idx.length];
}

/** Per-landmark region influences computed once from the parents' average shape. */
export function buildInfluence(lmM, lmD) {
  const avg = new Float32Array(N_LM * 2);
  for (let i = 0; i < avg.length; i++) avg[i] = (lmM[i] + lmD[i]) / 2;
  const { q } = toNorm(avg);
  const eyeR = centroidQ(q, EYE_R), eyeL = centroidQ(q, EYE_L);
  const brR = centroidQ(q, BROW_R), brL = centroidQ(q, BROW_L);
  const mouth = centroidQ(q, LIPS_OUTER);
  const nose = [(q[2 * LM.noseTip] + q[2 * LM.noseBridge]) / 2, (q[2 * LM.noseTip + 1] * 0.65 + q[2 * LM.noseBridge + 1] * 0.35)];
  const inf = { eyes: new Float32Array(N_LM), brows: new Float32Array(N_LM), nose: new Float32Array(N_LM), mouth: new Float32Array(N_LM) };
  for (let i = 0; i < N_LM; i++) {
    const x = q[2 * i], y = q[2 * i + 1];
    inf.eyes[i] = Math.max(gauss((x - eyeR[0]) / 0.3, (y - eyeR[1]) / 0.19), gauss((x - eyeL[0]) / 0.3, (y - eyeL[1]) / 0.19));
    inf.brows[i] = Math.max(gauss((x - brR[0]) / 0.3, (y - brR[1]) / 0.1), gauss((x - brL[0]) / 0.3, (y - brL[1]) / 0.1));
    inf.nose[i] = gauss((x - nose[0]) / 0.21, (y - nose[1]) / 0.36);
    inf.mouth[i] = gauss((x - mouth[0]) / 0.4, (y - mouth[1]) / 0.2);
    if (OVAL_SET.has(i)) { inf.eyes[i] *= 0.2; inf.brows[i] *= 0.2; inf.nose[i] *= 0.2; inf.mouth[i] *= 0.2; }
  }
  return inf;
}

/** Dad weight per landmark (0 = mum's feature, 1 = dad's) from the gene sliders. */
export function geneWeights(inf, genes) {
  const w = new Float32Array(N_LM);
  const base = 0.3;
  for (let i = 0; i < N_LM; i++) {
    const e = inf.eyes[i], b = inf.brows[i], n = inf.nose[i], m = inf.mouth[i];
    w[i] = (e * genes.eyes + b * genes.brows + n * genes.nose + m * genes.mouth + base * genes.face) / (e + b + n + m + base);
  }
  return w;
}

/**
 * Compute the child's landmarks (canonical px) at a given age and sex.
 * cfg: { parentAge }
 */
export function childShape(lmM, lmD, inf, genes, age, sex, cfg = {}) {
  const w = geneWeights(inf, genes);
  const base = new Float32Array(N_LM * 2);
  for (let i = 0; i < N_LM; i++) {
    base[2 * i] = lmM[2 * i] + w[i] * (lmD[2 * i] - lmM[2 * i]);
    base[2 * i + 1] = lmM[2 * i + 1] + w[i] * (lmD[2 * i + 1] - lmM[2 * i + 1]);
  }
  const { q, ox, oy, u } = toNorm(base);
  const g = growth(age, sex);
  const J = 1 - g;
  const maturity = smoothstep(8, 18, age);
  const sTarget = curve(sex === 'boy' ? SEX_BOY : SEX_GIRL, age);
  const s = sTarget - (genes.face - 0.5) * 1.0 * (0.3 + 0.7 * maturity);
  const parentA = agingAmount(cfg.parentAge ?? 30);
  const A = Math.max(0, agingAmount(age) - parentA);

  const mouthC = centroidQ(q, LIPS_OUTER);
  const brR = centroidQ(q, BROW_R), brL = centroidQ(q, BROW_L);
  const eR = centroidQ(q, EYE_R), eL = centroidQ(q, EYE_L);
  const noseC = [(q[2 * LM.noseTip] + q[2 * LM.noseBridge]) / 2, q[2 * LM.noseTip + 1] * 0.65 + q[2 * LM.noseBridge + 1] * 0.35];
  const lipW = (x, y) => gauss((x - mouthC[0]) / 0.36, (y - mouthC[1]) / 0.13);
  const browW = (x, y) => Math.max(gauss((x - brR[0]) / 0.3, (y - brR[1]) / 0.09), gauss((x - brL[0]) / 0.3, (y - brL[1]) / 0.09));
  const eyeW = (x, y) => Math.max(gauss((x - eR[0]) / 0.26, (y - eR[1]) / 0.12), gauss((x - eL[0]) / 0.26, (y - eL[1]) / 0.12));
  const noseW = (x, y) => gauss((x - noseC[0]) / 0.22, (y - noseC[1]) / 0.4);

  // ---- 1. Sex differences (+ = masculine) ----
  if (Math.abs(s) > 1e-3) {
    for (let i = 0; i < N_LM; i++) {
      let x = q[2 * i], y = q[2 * i + 1];
      const ax = Math.abs(x);
      const jaw = smoothstep(0.75, 1.3, y) * smoothstep(0.25, 0.75, ax);
      const chinW = smoothstep(1.3, 1.75, y) * (1 - smoothstep(0.25, 0.7, ax));
      x *= 1 + 0.075 * s * jaw + 0.08 * s * chinW;
      y += 0.055 * s * smoothstep(0.8, 1.85, y);
      const nw = noseW(x, y);
      x *= 1 + 0.06 * s * nw;
      y += 0.03 * s * nw * smoothstep(0.3, 0.8, y);
      const lw = lipW(x, y);
      y = mouthC[1] + (y - mouthC[1]) * (1 - 0.13 * s * lw);
      const bw = browW(x, y);
      y += 0.04 * s * bw;
      const ew = eyeW(x, y);
      const ec = x < 0 ? eR : eL;
      y = ec[1] + (y - ec[1]) * (1 - 0.06 * s * ew);
      q[2 * i] = x; q[2 * i + 1] = y;
    }
  }

  // ---- 2. Growth: juvenile proportions ----
  if (J > 1e-3) {
    const yM = mouthC[1];
    const G = (x, y) => {
      let gy;
      if (y < 0) gy = y * (1 + 0.08 * J);
      else if (y <= yM) gy = y * (1 - 0.36 * J);
      else gy = yM * (1 - 0.36 * J) + (y - yM) * (1 - 0.46 * J);
      const gx = x * (1 + (y < 0 ? 0.03 * J : 0));
      return [gx, gy];
    };
    const feats = [
      { c: eR, sx: 1 + 0.08 * J, sy: 1 + 0.11 * J, dy: 0, sig: [0.3, 0.19] },
      { c: eL, sx: 1 + 0.08 * J, sy: 1 + 0.11 * J, dy: 0, sig: [0.3, 0.19] },
      { c: brR, sx: 1 - 0.06 * J, sy: 1 - 0.25 * J, dy: -0.05 * J, sig: [0.32, 0.11] },
      { c: brL, sx: 1 - 0.06 * J, sy: 1 - 0.25 * J, dy: -0.05 * J, sig: [0.32, 0.11] },
      { c: noseC, sx: 1 - 0.12 * J, sy: 1 - 0.34 * J, dy: 0, sig: [0.22, 0.36] },
      { c: mouthC, sx: 1 - 0.18 * J, sy: 1 - 0.1 * J, dy: 0, sig: [0.4, 0.2] },
    ];
    for (const f of feats) f.gc = G(f.c[0], f.c[1]);
    for (let i = 0; i < N_LM; i++) {
      const x = q[2 * i], y = q[2 * i + 1];
      let ws = 0, ax = 0, ay = 0;
      for (const f of feats) {
        let wf = gauss((x - f.c[0]) / f.sig[0], (y - f.c[1]) / f.sig[1]);
        if (OVAL_SET.has(i)) wf *= 0.15;
        ws += wf;
        ax += wf * (f.gc[0] + f.sx * (x - f.c[0]));
        ay += wf * (f.gc[1] + f.sy * (y - f.c[1]) + f.dy);
      }
      const gp = G(x, y);
      if (ws > 1) { ax /= ws; ay /= ws; ws = 1; }
      q[2 * i] = ax + (1 - ws) * gp[0];
      q[2 * i + 1] = ay + (1 - ws) * gp[1];
    }

    // Baby fat: pull the lower face outline toward a full superellipse, carry cheeks along.
    const R = 0.8 * J * J + 0.1 * J;
    if (R > 1e-3) {
      const xs = (q[2 * LM.sideL] - q[2 * LM.sideR]) / 2;
      const cy = (q[2 * LM.sideL + 1] + q[2 * LM.sideR + 1]) / 2;
      const cx = (q[2 * LM.sideL] + q[2 * LM.sideR]) / 2;
      const rx = xs * (1 + 0.05 * J);
      const ry = q[2 * LM.chin + 1] - cy;
      const n = 2 + 0.7 * J;
      const disp = new Map();
      for (const i of FACE_OVAL) {
        const x = q[2 * i], y = q[2 * i + 1];
        if (y <= cy) continue;
        const ang = Math.atan2((y - cy) / ry, (x - cx) / rx);
        const c = Math.cos(ang), sn = Math.sin(ang);
        const k = Math.pow(Math.pow(Math.abs(c), n) + Math.pow(Math.abs(sn), n), -1 / n);
        const tx = cx + rx * c * k, ty = cy + ry * sn * k;
        const wy = smoothstep(cy, cy + 0.25, y);
        disp.set(i, [(tx - x) * R * wy, (ty - y) * R * wy * 0.6]);
      }
      const ovalPts = [...disp.keys()];
      for (let i = 0; i < N_LM; i++) {
        if (disp.has(i)) continue;
        const x = q[2 * i], y = q[2 * i + 1];
        if (y < cy - 0.2) continue;
        let sw = 0, dx = 0, dy = 0, dmin = 1e9;
        for (const k of ovalPts) {
          const d2 = (x - q[2 * k]) ** 2 + (y - q[2 * k + 1]) ** 2 + 1e-4;
          dmin = Math.min(dmin, d2);
          const wk = 1 / (d2 * d2);
          sw += wk; dx += wk * disp.get(k)[0]; dy += wk * disp.get(k)[1];
        }
        const fall = Math.exp(-dmin / (0.3 * 0.3));
        q[2 * i] += (dx / sw) * fall; q[2 * i + 1] += (dy / sw) * fall;
      }
      for (const [i, d] of disp) { q[2 * i] += d[0]; q[2 * i + 1] += d[1]; }
    }
  }

  // ---- 3. Adult ageing ----
  if (A > 1e-3) {
    const mc = centroidQ(q, LIPS_OUTER);
    const cR = [q[2 * LM.mouthR], q[2 * LM.mouthR + 1]], cL = [q[2 * LM.mouthL], q[2 * LM.mouthL + 1]];
    const upper = new Set([...EYE_R_UPPER, ...EYE_L_UPPER]);
    const eyeROut = q[2 * LM.eyeROuter], eyeRIn = q[2 * LM.eyeRInner], eyeLOut = q[2 * LM.eyeLOuter], eyeLIn = q[2 * LM.eyeLInner];
    for (let i = 0; i < N_LM; i++) {
      let x = q[2 * i], y = q[2 * i + 1];
      const ax = Math.abs(x);
      y += 0.085 * A * smoothstep(0.5, 1.3, y) * (0.35 + 0.65 * smoothstep(0.3, 0.85, ax));
      x += 0.05 * A * Math.sign(x) * smoothstep(0.95, 1.35, y) * smoothstep(0.4, 0.8, ax) * (1 - smoothstep(1.55, 1.8, y));
      y += 0.028 * A * Math.max(gauss((x - cR[0]) / 0.12, (y - cR[1]) / 0.12), gauss((x - cL[0]) / 0.12, (y - cL[1]) / 0.12));
      const nw = noseW(x, y);
      y += 0.03 * A * nw * smoothstep(0.35, 0.75, y);
      x *= 1 + 0.05 * A * nw;
      const lw = lipW(x, y);
      y = mc[1] + (y - mc[1]) * (1 - 0.38 * A * lw) + 0.015 * A * lw;
      if (upper.has(i)) {
        const outer = x < 0 ? clamp((eyeRIn - x) / (eyeRIn - eyeROut)) : clamp((x - eyeLIn) / (eyeLOut - eyeLIn));
        y += 0.03 * A * (0.4 + 0.6 * outer);
      }
      y += 0.015 * A * browW(x, y);
      y += 0.025 * A * smoothstep(1.45, 1.8, y);
      if (OVAL_SET.has(i) && y > -0.8 && y < 0.6) x *= 1 - 0.02 * A;
      x *= 1 - 0.03 * A * Math.max(gauss((x + 0.65) / 0.2, (y - 0.8) / 0.25), gauss((x - 0.65) / 0.2, (y - 0.8) / 0.25));
      q[2 * i] = x; q[2 * i + 1] = y;
    }
  }

  const lm = fromNorm(q, ox, oy, u);
  return {
    lm, w, g, J, s, A, maturity,
    ring: { upperBoost: 0.36 * J, sideBoost: 0.12 * J, bodyScaleX: 0.55 + 0.45 * g },
  };
}

export { centroid };
