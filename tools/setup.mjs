// Copies the on-device ML runtime into app/vendor and downloads the face models.
// Run once after `npm install`:  npm run setup
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'app', 'vendor');
const mp = join(root, 'node_modules', '@mediapipe', 'tasks-vision');

const copies = [
  [join(mp, 'vision_bundle.mjs'), join(vendor, 'mediapipe', 'vision_bundle.mjs')],
  [join(mp, 'wasm', 'vision_wasm_internal.js'), join(vendor, 'mediapipe', 'vision_wasm_internal.js')],
  [join(mp, 'wasm', 'vision_wasm_internal.wasm'), join(vendor, 'mediapipe', 'vision_wasm_internal.wasm')],
  [join(root, 'node_modules', 'delaunator', 'delaunator.min.js'), join(vendor, 'delaunator.min.js')],
];

// Models are saved with a neutral .bin extension so any static host serves them.
const models = [
  ['https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', 'face_landmarker.bin'],
  ['https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', 'selfie_segmenter.bin'],
  ['https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite', 'hair_segmenter.bin'],
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

for (const [from, to] of copies) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log('copied', to.replace(root + '/', ''));
}

await mkdir(join(vendor, 'models'), { recursive: true });
for (const [url, name] of models) {
  const out = join(vendor, 'models', name);
  if (await exists(out)) { console.log('have  ', name); continue; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  console.log('fetched', name);
}
console.log('Vendor files ready in app/vendor');
