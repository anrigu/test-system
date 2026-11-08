// On-device face analysis with MediaPipe Tasks (WASM). Nothing leaves the phone.
// The runtime and models are served next to the page (artifact CSP blocks remote fetches).

const VENDOR = new URL('../vendor/', import.meta.url);
const vendorUrl = (p) => new URL(p, VENDOR).href;

let vision = null;
let loading = null;
const tasks = { face: null, selfie: null, hair: null };

async function fetchModel(name, onProgress) {
  // Static hosts that only serve web file types (like claude.ai Artifacts) get the models
  // with an extra .wasm suffix; the bytes are identical.
  let res = await fetch(vendorUrl('models/' + name)).catch(() => null);
  if (!res || !res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
    res = await fetch(vendorUrl('models/' + name + '.wasm'));
  }
  if (!res.ok) throw new Error(`Model ${name} failed to load (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) { // content-length lied (compression); fall back to growable concat
      const merged = new Uint8Array(got + value.length);
      merged.set(out.subarray(0, got)); merged.set(value, got);
      return finishGrow(reader, merged, got + value.length);
    }
    out.set(value, got); got += value.length;
    onProgress(got / total);
  }
  return out.subarray(0, got);
}

async function finishGrow(reader, buf, len) {
  const parts = [buf.subarray(0, len)];
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Loads the WASM runtime and the three models. `onStatus(text, fraction)` reports progress. */
export function loadModels(onStatus = () => {}) {
  if (loading) return loading;
  loading = (async () => {
    onStatus('Loading face engine', 0.02);
    vision = await import(vendorUrl('mediapipe/vision_bundle.mjs'));
    const fileset = {
      wasmLoaderPath: vendorUrl('mediapipe/vision_wasm_internal.js'),
      wasmBinaryPath: vendorUrl('mediapipe/vision_wasm_internal.wasm'),
    };
    const faceBuf = await fetchModel('face_landmarker.bin', (f) => onStatus('Loading face model', 0.05 + 0.45 * f));
    onStatus('Starting face engine', 0.55);
    tasks.face = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: faceBuf, delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4,
    });
    onStatus('Loading hair model', 0.7);
    const hairBuf = await fetchModel('hair_segmenter.bin');
    tasks.hair = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: hairBuf, delegate: 'CPU' },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    onStatus('Loading portrait model', 0.88);
    const selfieBuf = await fetchModel('selfie_segmenter.bin');
    tasks.selfie = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: selfieBuf, delegate: 'CPU' },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    onStatus('Ready', 1);
    return true;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** Returns {points:[{x,y,z}] in pixels, blend:{name:score}, matrix:Float32Array|null} or null if no face. */
export function detectFace(source, width, height) {
  const r = tasks.face.detect(source);
  if (!r.faceLandmarks || !r.faceLandmarks.length) return null;
  const lm = r.faceLandmarks[0];
  const points = lm.map((p) => ({ x: p.x * width, y: p.y * height, z: p.z * width }));
  const blend = {};
  if (r.faceBlendshapes && r.faceBlendshapes[0]) {
    for (const c of r.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;
  }
  const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
  return { points, blend, matrix: m ? Float32Array.from(m.data) : null };
}

function lastMask(task, source) {
  const r = task.segment(source);
  try {
    const masks = r.confidenceMasks || [];
    if (!masks.length) return null;
    const m = masks[masks.length - 1];
    return { data: m.getAsFloat32Array().slice(), width: m.width, height: m.height };
  } finally {
    if (r.close) r.close();
  }
}

/** Hair and person confidence masks for a canvas. */
export function segment(canvas) {
  return { hair: lastMask(tasks.hair, canvas), person: lastMask(tasks.selfie, canvas) };
}
