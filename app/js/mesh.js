// MediaPipe Face Mesh topology helpers: landmark groups, canonical frame, triangulation.

export const CW = 1024;         // canonical frame width (px)
export const CH = 1280;         // canonical frame height (px)
export const IPD = 200;         // distance between eye centres in the canonical frame
export const EYE_Y = 538;       // eye line in the canonical frame
export const CX = CW / 2;

export const N_LM = 478;

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
// "R" = the eye on the image's left (subject's right). "L" = image right.
export const EYE_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
export const EYE_L = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
export const EYE_R_UPPER = [246, 161, 160, 159, 158, 157, 173];
export const EYE_L_UPPER = [466, 388, 387, 386, 385, 384, 398];
export const EYE_R_LOWER = [7, 163, 144, 145, 153, 154, 155];
export const EYE_L_LOWER = [249, 390, 373, 374, 380, 381, 382];
export const IRIS_R = [468, 469, 470, 471, 472];
export const IRIS_L = [473, 474, 475, 476, 477];
export const BROW_R = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const BROW_L = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
export const BROW_R_UPPER = [70, 63, 105, 66, 107];
export const BROW_L_UPPER = [300, 293, 334, 296, 336];
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
export const UPPER_LIP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
export const LOWER_LIP = [375, 321, 405, 314, 17, 84, 181, 91, 146, 324, 318, 402, 317, 14, 87, 178, 88, 95];

export const LM = {
  noseTip: 1, noseBridge: 6, glabella: 168, subnasale: 2, chin: 152, foreheadTop: 10,
  mouthR: 61, mouthL: 291, upperLipTop: 0, lowerLipBottom: 17, upperLipIn: 13, lowerLipIn: 14,
  eyeROuter: 33, eyeRInner: 133, eyeLOuter: 263, eyeLInner: 362, sideR: 234, sideL: 454,
  irisR: 468, irisL: 473,
};

// Landmarks used in the warp mesh: everything except the iris rings (they can sit under the
// eyelids and would fold the mesh). Iris centres stay so gaze lines up between parents.
export const MESH_LM = [];
for (let i = 0; i < N_LM; i++) if (!((i >= 469 && i <= 472) || (i >= 474 && i <= 477))) MESH_LM.push(i);

export const OVAL_SET = new Set(FACE_OVAL);
export const LIP_SET = new Set([...LIPS_OUTER, ...LIPS_INNER]);
export const BROW_SET = new Set([...BROW_R, ...BROW_L]);

export function eyeCenters(pts) {
  // pts: Float32Array [x0,y0,x1,y1,...] or array of {x,y}
  const g = (i) => (pts.length && typeof pts[0] === 'object') ? pts[i] : { x: pts[2 * i], y: pts[2 * i + 1] };
  const a = g(LM.eyeROuter), b = g(LM.eyeRInner), c = g(LM.eyeLOuter), d = g(LM.eyeLInner);
  return { r: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, l: { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 } };
}

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Piecewise-linear interpolation over [[x, y], ...] sorted by x. */
export function curve(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** Normalised face coordinates: origin at eye midpoint, unit = eye distance, y down. */
export function toNorm(pts) {
  const e = eyeCenters(pts);
  const ox = (e.r.x + e.l.x) / 2, oy = (e.r.y + e.l.y) / 2;
  const u = Math.hypot(e.l.x - e.r.x, e.l.y - e.r.y);
  const q = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) { q[i] = (pts[i] - ox) / u; q[i + 1] = (pts[i + 1] - oy) / u; }
  return { q, ox, oy, u };
}

export function fromNorm(q, ox, oy, u) {
  const p = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 2) { p[i] = ox + q[i] * u; p[i + 1] = oy + q[i + 1] * u; }
  return p;
}

export function centroid(pts, idx) {
  let x = 0, y = 0;
  for (const i of idx) { x += pts[2 * i]; y += pts[2 * i + 1]; }
  return { x: x / idx.length, y: y / idx.length };
}

// Extra control points outside the face so hair, ears, neck and shoulders warp smoothly.
export const RING1_SCALE = 1.42;
export const RING2_IDX = FACE_OVAL.filter((_, k) => k % 3 === 0); // 12 points
export const RING2_SCALE = 2.35;
export const BORDER_N = 7;

/** Build the full control point list: mesh landmarks + ring1 + ring2 + border. Returns Float32Array. */
export function buildControlPoints(lm, opts = {}) {
  const { upperBoost = 0, sideBoost = 0, bodyScaleX = 1, frame = null } = opts;
  const c = centroid(lm, FACE_OVAL);
  const eyeY = (lm[2 * LM.eyeROuter + 1] + lm[2 * LM.eyeLOuter + 1]) / 2;
  const out = [];
  for (const i of MESH_LM) out.push(lm[2 * i], lm[2 * i + 1]);
  const faceH = Math.max(1, lm[2 * LM.chin + 1] - lm[2 * LM.foreheadTop + 1]);
  for (const i of FACE_OVAL) {
    const ox = lm[2 * i], oy = lm[2 * i + 1];
    const upper = smoothstep(0.1, -0.35, (oy - eyeY) / faceH); // 1 above the eyes
    const s = RING1_SCALE + upperBoost * upper;
    const sx = s * (1 + sideBoost * upper);
    out.push(c.x + (ox - c.x) * sx, c.y + (oy - c.y) * s);
  }
  for (const i of RING2_IDX) {
    const ox = lm[2 * i], oy = lm[2 * i + 1];
    const lower = smoothstep(-0.1, 0.3, (oy - c.y) / faceH);
    const sx = RING2_SCALE * (1 + (bodyScaleX - 1) * lower);
    out.push(c.x + (ox - c.x) * sx, c.y + (oy - c.y) * RING2_SCALE);
  }
  const m = 0.35; // border sits outside the canvas so edges never pin the warp
  const x0 = -m * CW, x1 = CW * (1 + m), y0 = -m * CH, y1 = CH * (1 + m);
  for (let k = 0; k < BORDER_N; k++) {
    const t = k / (BORDER_N - 1);
    out.push(lerp(x0, x1, t), y0); out.push(lerp(x0, x1, t), y1);
    if (k > 0 && k < BORDER_N - 1) { out.push(x0, lerp(y0, y1, t)); out.push(x1, lerp(y0, y1, t)); }
  }
  // Narrow the body for children: pull the lower border in toward the face centre.
  if (bodyScaleX !== 1) {
    for (let k = out.length - 2 * (BORDER_N * 2 + (BORDER_N - 2) * 2); k < out.length; k += 2) {
      const lower = smoothstep(c.y, CH, out[k + 1]);
      out[k] = c.x + (out[k] - c.x) * (1 + (bodyScaleX - 1) * lower);
    }
  }
  const arr = Float32Array.from(out);
  if (frame) applyFrame(arr, frame);
  return arr;
}

export function applyFrame(arr, f) {
  for (let i = 0; i < arr.length; i += 2) {
    arr[i] = f.s * (arr[i] - f.ax) + f.bx;
    arr[i + 1] = f.s * (arr[i + 1] - f.ay) + f.by;
  }
  return arr;
}

export const N_CTRL = MESH_LM.length + FACE_OVAL.length + RING2_IDX.length + (BORDER_N * 2 + (BORDER_N - 2) * 2);
export const RING1_START = MESH_LM.length;
export const RING2_START = RING1_START + FACE_OVAL.length;
export const BORDER_START = RING2_START + RING2_IDX.length;

/** Index of landmark i inside the control point array (or -1 if not in the mesh). */
export const CTRL_OF_LM = (() => {
  const m = new Int32Array(N_LM).fill(-1);
  MESH_LM.forEach((lmIdx, k) => { m[lmIdx] = k; });
  return m;
})();

