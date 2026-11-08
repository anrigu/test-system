// Local-only persistence: parent photos in IndexedDB, settings in localStorage.
// Everything is wrapped so the app still works in private windows or previews.
const DB_NAME = 'baby-face-forecast';
const STORE = 'photos';
const SETTINGS_KEY = 'bff-settings-v1';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function savePhoto(who, blob) {
  try { await tx('readwrite', (s) => s.put(blob, who)); } catch { /* storage unavailable */ }
}
export async function loadPhoto(who) {
  try { return await tx('readonly', (s) => s.get(who)); } catch { return null; }
}
export async function clearPhotos() {
  try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ }
}

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { return null; }
}
export function saveSettings(obj) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}
export function clearSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
}
