// Baby Face Forecast: UI controller.
import { loadModels } from './detect.js';
import { loadImageFile, analyzePhoto } from './analyze.js';
import { Renderer } from './render.js';
import { CW, CH, curve, clamp } from './mesh.js';
import { eyeOdds, hairOdds, EYE_LABEL, HAIR_LABEL, adultHeight, heightAt, cmToFtIn, stageNote, ageLabel } from './genetics.js';
import { savePhoto, loadPhoto, clearPhotos, loadSettings, saveSettings, clearSettings } from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Slider position (0-1) <-> age. Childhood gets more room than adulthood.
const AGE_MAP = [[0, 0], [0.06, 0.5], [0.11, 1], [0.17, 2], [0.23, 3], [0.31, 6], [0.4, 10], [0.47, 13], [0.54, 16], [0.6, 20], [0.68, 30], [0.77, 45], [0.86, 60], [0.93, 75], [1, 90]];
const posToAge = (p) => curve(AGE_MAP, p);
const ageToPos = (a) => curve(AGE_MAP.map(([p, x]) => [x, p]), a);
const RULER_MARKS = [[0, 'birth'], [1, '1'], [3, '3'], [6, '6'], [10, '10'], [13, '13'], [16, '16'], [20, '20'], [30, '30'], [45, '45'], [60, '60'], [75, '75'], [90, '90']];
const GALLERY_AGES = [0, 0.5, 1, 3, 6, 10, 13, 16, 20, 30, 45, 60, 75, 90];
const GENE_KEYS = [['eyes', 'Eyes'], ['brows', 'Brows'], ['nose', 'Nose'], ['mouth', 'Mouth'], ['face', 'Face shape'], ['skin', 'Skin tone'], ['texture', 'Skin detail']];

const defaults = () => ({
  view: 'both', pos: 0,
  genes: { eyes: 0.5, brows: 0.5, nose: 0.5, mouth: 0.5, face: 0.5, skin: 0.5, texture: 0.5 },
  eye: 'auto', hair: 'auto',
  parentEye: { mom: null, dad: null }, parentHair: { mom: null, dad: null },
  opts: { hairFrom: 'auto', backdrop: 'studio', newbornWrap: true, babyColor: 'cream', facialHair: 'stubble', freckles: false, teenSkin: true, parentAge: 30, grayRate: 1, seed: 1 },
  heights: { mom: '', dad: '' },
});

const saved = loadSettings();
const S = Object.assign(defaults(), saved || {});
S.genes = { ...defaults().genes, ...(saved?.genes || {}) };
S.opts = { ...defaults().opts, ...(saved?.opts || {}) };
const P = { mom: null, dad: null }; // analysis results
let renderer = null;
let playing = false;

function persist() {
  saveSettings({ view: S.view, pos: S.pos, genes: S.genes, eye: S.eye, hair: S.hair, parentEye: S.parentEye, parentHair: S.parentHair, opts: S.opts, heights: S.heights });
}

// ---------- Toasts & overlays ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- Capabilities (only inside the claude.ai viewer) ----------
const capCache = {};
function useCap(name) {
  if (!(name in capCache)) {
    capCache[name] = (window.claude && typeof window.claude.use === 'function')
      ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
  }
  return capCache[name];
}

async function saveBlob(blob, filename, kind = 'image') {
  const dl = await useCap('downloads');
  if (dl) {
    try {
      await dl.save({ filename, data: blob });
      toast('Saved');
      return;
    } catch (e) {
      if (e && e.code === 'declined') return;
      if (e && e.code === 'rate_limited') { toast('Another save is still open. Try again in a moment.'); return; }
    }
  }
  // Fallback: show it so the viewer can press and hold to save.
  const ov = $('#preview');
  const box = $('#previewMedia');
  box.replaceChildren();
  const url = URL.createObjectURL(blob);
  const el = kind === 'video' ? Object.assign(document.createElement('video'), { src: url, controls: true, playsInline: true, loop: true, muted: true, autoplay: true }) : Object.assign(document.createElement('img'), { src: url, alt: filename });
  box.append(el);
  if (kind === 'video') el.addEventListener('error', () => {
    box.replaceChildren();
    $('#previewHint').textContent = 'This browser cannot show the video here. Open the page in the Claude app to save it.';
  });
  $('#previewHint').textContent = kind === 'video' ? 'Use the video controls or press and hold to save it.' : 'Press and hold the image to save it to your photos.';
  ov.hidden = false;
}
$('#previewClose').addEventListener('click', () => { $('#preview').hidden = true; });

// ---------- Engine loading ----------
const engineEl = $('#engine');
const enginePromise = loadModels((text, f) => {
  engineEl.textContent = f >= 1 ? 'Face engine ready. Runs entirely on this phone.' : `${text}… ${Math.round(f * 100)}%`;
  engineEl.dataset.state = f >= 1 ? 'ready' : 'loading';
}).catch((e) => {
  engineEl.dataset.state = 'error';
  engineEl.textContent = `The face engine could not start: ${e.message || e}. Reload the page to try again.`;
  throw e;
});

// ---------- Parent capture ----------
function setCardState(who, state, message = '') {
  const card = $(`.parent[data-who="${who}"]`);
  card.dataset.state = state;
  $('.status', card).textContent = message;
}

function renderCard(who) {
  const card = $(`.parent[data-who="${who}"]`);
  const res = P[who];
  const slot = $('.slot', card);
  const traits = $('.traits', card);
  const warn = $('.warn', card);
  if (!res) {
    slot.querySelector('canvas')?.remove();
    traits.replaceChildren(); warn.replaceChildren();
    $('.add-label', card).textContent = 'Add photo';
    return;
  }
  slot.querySelector('canvas')?.remove();
  const c = document.createElement('canvas');
  c.width = res.thumb.width; c.height = res.thumb.height;
  c.getContext('2d').drawImage(res.thumb, 0, 0);
  c.setAttribute('aria-label', `${who === 'mom' ? 'Mom' : 'Dad'}'s photo, aligned`);
  slot.append(c);
  $('.add-label', card).textContent = 'Retake';
  const eye = S.parentEye[who] || res.stats.eyeGuess;
  const hair = S.parentHair[who] || res.stats.hairGuess;
  traits.replaceChildren(
    chip(`${EYE_LABEL[eye]} eyes`),
    chip(hair ? `${HAIR_LABEL[hair]} hair` : 'Hair hidden'),
  );
  warn.replaceChildren(...res.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
}

function chip(text) { return Object.assign(document.createElement('span'), { className: 'chip', textContent: text }); }

async function blobFromImage(img) {
  const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
}

async function handlePhoto(who, file, { store = true } = {}) {
  if (!file) return;
  setCardState(who, 'busy', 'Reading face…');
  try {
    await enginePromise;
    const { img, url } = await loadImageFile(file);
    const res = await analyzePhoto(img);
    URL.revokeObjectURL(url);
    P[who] = res;
    if (store) {
      S.parentEye[who] = null; S.parentHair[who] = null;
      const blob = await blobFromImage(img);
      if (blob) savePhoto(who, blob);
    }
    if (S.parentEye[who]) res.stats.eyeGuess = S.parentEye[who];
    if (S.parentHair[who]) res.stats.hairGuess = S.parentHair[who];
    setCardState(who, 'ready', res.warnings.length ? '' : 'Looks good');
    renderCard(who);
    onParentsChanged();
  } catch (e) {
    console.error(e);
    setCardState(who, 'error', e.message || 'That photo could not be read.');
  }
}

for (const who of ['mom', 'dad']) {
  for (const input of $$(`.parent[data-who="${who}"] input[type=file]`)) {
    input.addEventListener('change', () => { handlePhoto(who, input.files[0]); input.value = ''; });
  }
}

$('#swap').addEventListener('click', async () => {
  [P.mom, P.dad] = [P.dad, P.mom];
  [S.parentEye.mom, S.parentEye.dad] = [S.parentEye.dad, S.parentEye.mom];
  [S.parentHair.mom, S.parentHair.dad] = [S.parentHair.dad, S.parentHair.mom];
  const [a, b] = await Promise.all([loadPhoto('mom'), loadPhoto('dad')]);
  if (b) savePhoto('mom', b);
  if (a) savePhoto('dad', a);
  renderCard('mom'); renderCard('dad');
  for (const w of ['mom', 'dad']) setCardState(w, P[w] ? 'ready' : 'empty', '');
  onParentsChanged();
});

// ---------- Results ----------
function onParentsChanged() {
  persist();
  const ready = P.mom && P.dad;
  $('#results').hidden = !ready;
  $('#emptyState').hidden = !!ready;
  $('#swap').hidden = !(P.mom || P.dad);
  if (!ready) return;
  if (!renderer) {
    try { renderer = new Renderer(); } catch (e) { toast(e.message); return; }
  }
  renderer.setParents(P.mom, P.dad);
  buildTraits();
  buildHeights();
  scheduleRender(true);
  setTimeout(drawSiblings, 400);
}

function parentEye(who) { return S.parentEye[who] || P[who].stats.eyeGuess; }
function parentHair(who) { return S.parentHair[who] || P[who].stats.hairGuess || 'brown'; }
function childEye() { return S.eye !== 'auto' ? S.eye : eyeOdds(parentEye('mom'), parentEye('dad'))[0].key; }
function childHair() { return S.hair !== 'auto' ? S.hair : hairOdds(parentHair('mom'), parentHair('dad'))[0].key; }

function renderParams(sex, age, genes = S.genes, seed = S.opts.seed) {
  return { age, sex, genes, eye: childEye(), hair: childHair(), opts: { ...S.opts, seed } };
}

function sexes() { return S.view === 'both' ? ['girl', 'boy'] : [S.view]; }

let rafPending = false, galleryDirty = true;
function scheduleRender(all = false) {
  if (all) galleryDirty = true;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; drawMain(); if (galleryDirty && !playing) queueGallery(); });
}

function drawMain() {
  if (!renderer || !renderer.ready) return;
  const age = posToAge(S.pos);
  $('#pGirl').hidden = !sexes().includes('girl');
  $('#pBoy').hidden = !sexes().includes('boy');
  $('#stage').dataset.view = S.view;
  for (const sex of sexes()) {
    const res = renderer.render(renderParams(sex, age));
    const c = $(sex === 'girl' ? '#pGirl canvas' : '#pBoy canvas');
    c.getContext('2d').drawImage(res.canvas, 0, 0);
  }
  updateReadout(age);
}

function updateReadout(age) {
  $('#ageLabel').textContent = ageLabel(age);
  $('#stageNote').textContent = stageNote(age, S.view === 'boy' ? 'boy' : S.view === 'girl' ? 'girl' : (age >= 11 && age < 24 ? 'both' : 'girl'));
  if (S.view === 'both' && age >= 11 && age < 24) {
    $('#stageNote').textContent = `Girl: ${stageNote(age, 'girl')} Boy: ${stageNote(age, 'boy')}`;
  }
  const h = heightsCm();
  const el = $('#heightLabel');
  if (h) {
    el.textContent = sexes().map((sex) => {
      const t = adultHeight(h.mom, h.dad, sex).target;
      const v = heightAt(age, sex, t);
      return `${sexes().length > 1 ? (sex === 'girl' ? 'Girl ' : 'Boy ') : ''}${cmToFtIn(v)} · ${Math.round(v)} cm`;
    }).join('   ');
  } else el.textContent = '';
  $('#age').value = Math.round(S.pos * 1000);
  $('#age').setAttribute('aria-valuetext', ageLabel(age));
  updateChartMarker(age);
}

// ---------- Age ruler ----------
const ageInput = $('#age');
ageInput.addEventListener('input', () => { S.pos = ageInput.value / 1000; stopPlay(); scheduleRender(); });
ageInput.addEventListener('change', persist);

function layoutRuler() {
  const marks = $('#marks');
  marks.replaceChildren();
  const width = marks.clientWidth || 320;
  let lastX = -99;
  for (const [age, label] of RULER_MARKS) {
    const pos = ageToPos(age);
    const x = pos * width;
    const tick = document.createElement('span');
    tick.className = 'tick'; tick.style.left = `${pos * 100}%`;
    marks.append(tick);
    if (x - lastX >= 26 && (age === 90 || width - x >= 30)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `mark${age === 0 ? ' first' : age === 90 ? ' last' : ''}`; b.textContent = label; b.style.left = `${pos * 100}%`;
      b.setAttribute('aria-label', `Jump to ${age === 0 ? 'birth' : age + ' years'}`);
      b.addEventListener('click', () => { S.pos = pos; stopPlay(); persist(); scheduleRender(); });
      marks.append(b);
      lastX = age === 0 ? x + 22 : x;
    }
  }
}
new ResizeObserver(layoutRuler).observe($('#marks'));

// ---------- Play a lifetime ----------
let playStart = 0, playFrom = 0;
const PLAY_MS = 16000;
function stopPlay() {
  if (!playing) return;
  playing = false;
  $('#play').textContent = 'Play a lifetime';
  $('#play').setAttribute('aria-pressed', 'false');
  persist();
  scheduleRender(true);
}
function tick(now) {
  if (!playing) return;
  const t = (now - playStart) / PLAY_MS + playFrom;
  S.pos = Math.min(1, t);
  drawMain();
  if (S.pos >= 1) { stopPlay(); return; }
  requestAnimationFrame(tick);
}
$('#play').addEventListener('click', () => {
  if (playing) { stopPlay(); return; }
  playing = true;
  $('#play').textContent = 'Pause';
  $('#play').setAttribute('aria-pressed', 'true');
  playFrom = S.pos >= 0.999 ? 0 : S.pos;
  playStart = performance.now();
  requestAnimationFrame(tick);
});

$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  S.view = b.dataset.view;
  $$('#viewSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  persist();
  scheduleRender(true);
  drawChart();
}));

// ---------- Gallery ----------
let galleryJob = 0;
function queueGallery() {
  galleryDirty = false;
  const job = ++galleryJob;
  const host = $('#gallery');
  host.replaceChildren();
  const items = [];
  for (const sex of sexes()) {
    const row = document.createElement('div');
    row.className = 'grow';
    const h = document.createElement('h4');
    h.textContent = sex === 'girl' ? 'Girl' : 'Boy';
    const strip = document.createElement('div');
    strip.className = 'strip';
    row.append(h, strip);
    host.append(row);
    for (const age of GALLERY_AGES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'thumb';
      const c = document.createElement('canvas'); c.width = 192; c.height = 240;
      const l = document.createElement('span'); l.textContent = age === 0 ? 'birth' : age < 1 ? '6 mo' : String(age);
      b.append(c, l);
      b.setAttribute('aria-label', `${sex}, ${ageLabel(age)}`);
      b.addEventListener('click', () => { S.pos = ageToPos(age); if (S.view !== 'both') S.view = sex; persist(); scheduleRender(); $('#stage').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      strip.append(b);
      items.push({ c, sex, age });
    }
  }
  const step = () => {
    if (job !== galleryJob || playing) return;
    const it = items.shift();
    if (!it) return;
    const res = renderer.render(renderParams(it.sex, it.age));
    it.c.getContext('2d').drawImage(res.canvas, 0, 0, 192, 240);
    setTimeout(step, 0);
  };
  setTimeout(step, 30);
}

// ---------- Genes ----------
function buildGenes() {
  const host = $('#genes');
  host.replaceChildren();
  for (const [key, label] of GENE_KEYS) {
    const row = document.createElement('div');
    row.className = 'gene';
    const id = `gene-${key}`;
    row.innerHTML = `<label for="${id}">${label}</label><input type="range" id="${id}" min="0" max="100" step="1"><output for="${id}"></output>`;
    const input = $('input', row), out = $('output', row);
    const show = () => {
      const v = Math.round(S.genes[key] * 100);
      out.textContent = v === 50 ? 'Even' : v < 50 ? `Mom ${100 - v}%` : `Dad ${v}%`;
    };
    input.value = Math.round(S.genes[key] * 100);
    show();
    input.addEventListener('input', () => { S.genes[key] = input.value / 100; show(); scheduleRender(); });
    input.addEventListener('change', () => { persist(); scheduleRender(true); });
    host.append(row);
  }
}
$('#geneShuffle').addEventListener('click', () => {
  for (const [k] of GENE_KEYS) S.genes[k] = randomGene();
  S.opts.seed = Math.floor(Math.random() * 1000) + 1;
  buildGenes(); persist(); scheduleRender(true);
});
$('#geneEven').addEventListener('click', () => {
  for (const [k] of GENE_KEYS) S.genes[k] = 0.5;
  buildGenes(); persist(); scheduleRender(true);
});
function randomGene() {
  // Bell-shaped around an even mix, occasionally strongly one-sided.
  const u = (Math.random() + Math.random() + Math.random()) / 3;
  return clamp(0.5 + (u - 0.5) * 2.2, 0.05, 0.95);
}

// ---------- Traits ----------
function selectFor(id, options, value, onChange) {
  const sel = $(id);
  sel.replaceChildren(...Object.entries(options).map(([k, v]) => Object.assign(document.createElement('option'), { value: k, textContent: v })));
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
}

function buildTraits() {
  const eyeOpts = { darkbrown: 'Dark brown', brown: 'Brown', hazel: 'Hazel', green: 'Green', blue: 'Blue', gray: 'Grey' };
  const hairOpts = { black: 'Black', darkbrown: 'Dark brown', brown: 'Brown', lightbrown: 'Light brown', blonde: 'Blonde', red: 'Red' };
  for (const who of ['mom', 'dad']) {
    selectFor(`#${who}Eye`, eyeOpts, parentEye(who), (v) => { S.parentEye[who] = v; P[who].stats.eyeGuess = v; renderCard(who); buildTraits(); persist(); scheduleRender(true); });
    const h = parentHair(who);
    selectFor(`#${who}Hair`, hairOpts, hairOpts[h] ? h : 'brown', (v) => { S.parentHair[who] = v; P[who].stats.hairGuess = v; renderCard(who); buildTraits(); persist(); scheduleRender(true); });
  }
  oddsChips('#eyeOdds', eyeOdds(parentEye('mom'), parentEye('dad')), EYE_LABEL, () => childEye(), (k) => { S.eye = k; });
  oddsChips('#hairOdds', hairOdds(parentHair('mom'), parentHair('dad')), HAIR_LABEL, () => childHair(), (k) => { S.hair = k; });
}

function oddsChips(sel, odds, labels, current, set) {
  const host = $(sel);
  host.replaceChildren();
  for (const o of odds) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'odds';
    b.setAttribute('aria-pressed', String(current() === o.key));
    b.innerHTML = `<span class="swatch" data-c="${o.key}"></span><span>${labels[o.key]}</span><b>${Math.round(o.p * 100)}%</b>`;
    b.addEventListener('click', () => { set(o.key); persist(); buildTraits(); scheduleRender(true); });
    host.append(b);
  }
}

// ---------- Style options ----------
function bindOption(id, key, parse = (v) => v) {
  const el = $(id);
  const isCheck = el.type === 'checkbox';
  if (isCheck) el.checked = !!S.opts[key]; else el.value = String(S.opts[key]);
  el.addEventListener('change', () => {
    S.opts[key] = isCheck ? el.checked : parse(el.value);
    persist(); scheduleRender(true);
  });
}
bindOption('#optHairFrom', 'hairFrom');
bindOption('#optBackdrop', 'backdrop');
bindOption('#optWrap', 'newbornWrap');
bindOption('#optBabyColor', 'babyColor');
bindOption('#optFacialHair', 'facialHair');
bindOption('#optFreckles', 'freckles');
bindOption('#optTeen', 'teenSkin');
bindOption('#optGray', 'grayRate', Number);
bindOption('#optParentAge', 'parentAge', Number);

// ---------- Siblings ----------
function drawSiblings() {
  if (!renderer || !renderer.ready) return;
  const host = $('#siblings');
  host.replaceChildren();
  const now = posToAge(S.pos);
  const age = now < 2.5 ? 6 : now;
  $('#sibAge').textContent = now < 2.5 ? 'Shown at age 6, when faces differ most clearly.' : `Shown at ${ageLabel(age).toLowerCase()}.`;
  const list = sexes().length === 2 ? ['girl', 'boy', 'girl', 'boy'] : [S.view, S.view, S.view, S.view];
  list.forEach((sex, i) => {
    const genes = {}; for (const [k] of GENE_KEYS) genes[k] = randomGene();
    const seed = Math.floor(Math.random() * 1000) + 1;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sib';
    const c = document.createElement('canvas'); c.width = 288; c.height = 360;
    const res = renderer.render({ ...renderParams(sex, age, genes, seed) });
    c.getContext('2d').drawImage(res.canvas, 0, 0, 288, 360);
    const l = document.createElement('span');
    l.textContent = `${sex === 'girl' ? 'Sister' : 'Brother'} ${i + 1}`;
    b.append(c, l);
    b.setAttribute('aria-label', `Use ${l.textContent}'s gene mix`);
    b.addEventListener('click', () => { S.genes = genes; S.opts.seed = seed; buildGenes(); persist(); scheduleRender(true); toast('Gene mix applied'); });
    host.append(b);
  });
}
$('#sibShuffle').addEventListener('click', drawSiblings);

// ---------- Heights ----------
function parseHeight(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  const ft = t.match(/^(\d)\s*(?:'|′|ft|feet|\s)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:"|″|in)?$/);
  if (ft) { const cm = (Number(ft[1]) * 12 + Number(ft[2] || 0)) * 2.54; return cm > 120 && cm < 230 ? cm : null; }
  const n = parseFloat(t);
  if (!isFinite(n)) return null;
  if (n > 120 && n < 230) return n;
  if (n > 1.2 && n < 2.3) return n * 100;
  return null;
}
function heightsCm() {
  const m = parseHeight(S.heights.mom), d = parseHeight(S.heights.dad);
  return m && d ? { mom: m, dad: d } : null;
}
function buildHeights() {
  for (const who of ['mom', 'dad']) {
    const el = $(`#${who}Height`);
    el.value = S.heights[who] || '';
    el.oninput = () => {
      S.heights[who] = el.value;
      const ok = !el.value || parseHeight(el.value);
      el.setAttribute('aria-invalid', String(!ok));
      persist(); drawChart(); updateReadout(posToAge(S.pos));
    };
  }
  drawChart();
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
let chartGeom = null;
function drawChart() {
  const host = $('#chart');
  const h = heightsCm();
  $('#heightEmpty').hidden = !!h;
  $('#heightSummary').hidden = !h;
  host.hidden = !h;
  if (!h) { chartGeom = null; return; }
  const list = ['girl', 'boy'];
  const targets = Object.fromEntries(list.map((s) => [s, adultHeight(h.mom, h.dad, s)]));
  $('#heightSummary').textContent = list.map((s) => `${s === 'girl' ? 'Girl' : 'Boy'}: about ${cmToFtIn(targets[s].target)} (${Math.round(targets[s].target)} cm), usual range ${cmToFtIn(targets[s].low)}–${cmToFtIn(targets[s].high)}`).join('. ') + '.';
  const W = 340, H = 210, m = { l: 50, r: 74, t: 12, b: 28 };
  const xMax = 20, yMin = 40, yMax = Math.max(200, Math.ceil(Math.max(targets.boy.high, targets.girl.high) / 10) * 10);
  const x = (a) => m.l + (a / xMax) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Predicted height from birth to age 20 for a girl and a boy' });
  for (let v = 50; v <= yMax; v += 50) {
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }));
    svg.append(svgEl('text', { x: m.l - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, v + 50 > yMax ? `${v} cm` : String(v)));
  }
  for (const a of [0, 5, 10, 15, 20]) svg.append(svgEl('text', { x: x(a), y: H - 8, class: 'axis', 'text-anchor': 'middle' }, a === 0 ? 'birth' : String(a)));
  const active = sexes();
  for (const sex of list) {
    let d = '';
    for (let a = 0; a <= xMax + 1e-6; a += 0.25) d += `${a ? 'L' : 'M'}${x(a).toFixed(1)},${y(heightAt(a, sex, targets[sex].target)).toFixed(1)}`;
    svg.append(svgEl('path', { d, class: `series ${sex}${active.includes(sex) ? '' : ' dim'}` }));
    const endV = heightAt(xMax, sex, targets[sex].target);
    svg.append(svgEl('text', { x: W - m.r + 6, y: y(endV) + (sex === 'boy' ? -2 : 12), class: 'dlabel' }, `${sex === 'girl' ? 'Girl' : 'Boy'} ${cmToFtIn(endV)}`));
  }
  const marker = svgEl('g', { class: 'marker' });
  marker.append(svgEl('line', { y1: m.t, y2: H - m.b, class: 'mline' }));
  for (const sex of list) marker.append(svgEl('circle', { r: 4.5, class: `dot ${sex}`, 'data-sex': sex }));
  svg.append(marker);
  const hit = svgEl('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, class: 'hit' });
  svg.append(hit);
  host.replaceChildren(svg);
  chartGeom = { x, y, targets, xMax, svg, marker, m, W };
  const pick = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const a = clamp((px - m.l) / (W - m.l - m.r), 0, 1) * xMax;
    S.pos = ageToPos(a); stopPlay(); scheduleRender();
  };
  hit.addEventListener('pointerdown', (ev) => { hit.setPointerCapture(ev.pointerId); pick(ev); });
  hit.addEventListener('pointermove', (ev) => { if (ev.buttons) pick(ev); });
  hit.addEventListener('pointerup', () => { persist(); scheduleRender(true); });
  updateChartMarker(posToAge(S.pos));
}
function updateChartMarker(age) {
  if (!chartGeom) return;
  const { x, y, targets, xMax, marker } = chartGeom;
  const tip = $('#chartTip');
  if (age > xMax) { marker.style.display = 'none'; tip.textContent = `At ${Math.round(age)}: adult height reached.`; return; }
  marker.style.display = '';
  const xx = x(age);
  marker.querySelector('line').setAttribute('x1', xx); marker.querySelector('line').setAttribute('x2', xx);
  const parts = [];
  for (const c of marker.querySelectorAll('circle')) {
    const sex = c.dataset.sex;
    const v = heightAt(age, sex, targets[sex].target);
    c.setAttribute('cx', xx); c.setAttribute('cy', y(v));
    parts.push(`${sex === 'girl' ? 'Girl' : 'Boy'} ${cmToFtIn(v)} (${Math.round(v)} cm)`);
  }
  tip.textContent = `${ageLabel(age)}: ${parts.join(' · ')}`;
}

// ---------- Saving: image, poster, video ----------
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

$('#saveImg').addEventListener('click', async () => {
  const age = posToAge(S.pos);
  const list = sexes();
  const c = document.createElement('canvas');
  c.width = CW * list.length; c.height = CH;
  const ctx = c.getContext('2d');
  list.forEach((sex, i) => ctx.drawImage(renderer.render(renderParams(sex, age)).canvas, i * CW, 0));
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.93));
  saveBlob(blob, `${list.join('-and-')}-${slug(ageLabel(age))}.jpg`);
});

$('#savePoster').addEventListener('click', async () => {
  const ages = [0, 1, 3, 6, 10, 16, 25, 45, 70];
  const tw = 240, th = 300, pad = 40, head = 380;
  const c = document.createElement('canvas');
  c.width = pad * 2 + tw * ages.length; c.height = head + (th + 60) * 2 + pad;
  const ctx = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = '#f4f6f4'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#1b2422';
  ctx.font = `64px ${css.getPropertyValue('--font-display')}`;
  ctx.fillText('Our future kids', pad, 100);
  ctx.font = `28px ${css.getPropertyValue('--font-body')}`;
  ctx.fillStyle = '#5a6763';
  ctx.fillText('A forecast from two photos. For fun: real children are always a surprise.', pad, 150);
  [['Mom', P.mom], ['Dad', P.dad]].forEach(([name, p], i) => {
    const x = c.width - pad - (2 - i) * 210;
    ctx.drawImage(p.thumb, x, 40, 190, 190);
    ctx.fillStyle = '#1b2422'; ctx.font = `30px ${css.getPropertyValue('--font-hand')}`;
    ctx.fillText(name, x + 6, 270);
  });
  ['girl', 'boy'].forEach((sex, row) => {
    const y0 = head + row * (th + 60);
    ctx.fillStyle = '#1b2422'; ctx.font = `34px ${css.getPropertyValue('--font-display')}`;
    ctx.fillText(sex === 'girl' ? 'Girl' : 'Boy', pad, y0 - 14);
    ages.forEach((age, k) => {
      const res = renderer.render(renderParams(sex, age));
      ctx.drawImage(res.canvas, pad + k * tw + 4, y0, tw - 8, th);
      ctx.fillStyle = '#5a6763'; ctx.font = `26px ${css.getPropertyValue('--font-hand')}`;
      ctx.fillText(age === 0 ? 'birth' : `${age}`, pad + k * tw + 10, y0 + th + 34);
    });
  });
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  saveBlob(blob, 'future-kids-poster.jpg');
  scheduleRender(true);
});

function pickVideoType() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || null;
}
const videoType = pickVideoType();
$('#saveVideo').hidden = !videoType;
let recording = false;
$('#saveVideo').addEventListener('click', async () => {
  if (recording || !renderer) return;
  recording = true; stopPlay();
  const btn = $('#saveVideo');
  btn.disabled = true;
  const list = sexes();
  const scale = list.length === 2 ? 0.5 : 0.75;
  const w = Math.round(CW * scale), h = Math.round(CH * scale);
  const c = document.createElement('canvas');
  c.width = w * list.length; c.height = h + 70;
  const ctx = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: videoType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  const draw = (pos) => {
    const age = posToAge(pos);
    ctx.fillStyle = '#121716'; ctx.fillRect(0, 0, c.width, c.height);
    list.forEach((sex, i) => ctx.drawImage(renderer.render(renderParams(sex, age)).canvas, i * w, 0, w, h));
    ctx.fillStyle = '#f2f5f3'; ctx.font = `34px ${css.getPropertyValue('--font-display')}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(ageLabel(age), 20, h + 35);
  };
  draw(0);
  rec.start(250);
  const total = 14000;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      const f = Math.min(1, (now - t0) / total);
      draw(f);
      btn.textContent = `Recording… ${Math.round(f * 100)}%`;
      if (f < 1) requestAnimationFrame(step); else setTimeout(resolve, 600);
    };
    requestAnimationFrame(step);
  });
  rec.stop();
  await done;
  btn.textContent = 'Save aging video'; btn.disabled = false; recording = false;
  const ext = videoType.includes('mp4') ? 'mp4' : 'webm';
  saveBlob(new Blob(chunks, { type: videoType.split(';')[0] }), `lifetime.${ext}`, 'video');
  scheduleRender(true);
});

// ---------- Ask Claude to read the photos (optional) ----------
async function setupClaude() {
  const sample = await useCap('sample');
  const lim = sample ? await sample.limits().catch(() => null) : null;
  $('#claudeBox').hidden = !(lim && lim.images);
}
function cropBlob(res) {
  const c = document.createElement('canvas');
  c.width = 448; c.height = 448;
  const side = 150 * 3.3;
  c.getContext('2d').drawImage(res.aligned, CW / 2 - side / 2, 404 - side * 0.46, side, side, 0, 0, 448, 448);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
}
$('#askClaude').addEventListener('click', async () => {
  const sample = await useCap('sample');
  if (!sample || !P.mom || !P.dad) return;
  const btn = $('#askClaude'); const out = $('#claudeOut');
  btn.disabled = true; out.textContent = 'Asking Claude…';
  try {
    const images = [await cropBlob(P.mom), await cropBlob(P.dad)];
    const prompt = 'Image 1 is the mother and image 2 is the father of a future child. For each parent, estimate from the photo: ' +
      'eye colour (one of "darkbrown","brown","hazel","green","blue","gray"), natural hair colour (one of "black","darkbrown","brown","lightbrown","blonde","red","gray"), ' +
      'whether freckles are visible (true/false), and approximate age in years (number). Then write "note": two or three warm, plain sentences about which visible features ' +
      'a child might plausibly inherit from each parent. No medical or ethnicity claims. Reply with only JSON like ' +
      '{"mom":{"eye":"brown","hair":"darkbrown","freckles":false,"age":31},"dad":{"eye":"blue","hair":"brown","freckles":true,"age":33},"note":"..."}';
    const r = await sample.json(prompt, { images, modelTier: 'default' });
    const eyes = Object.keys(EYE_LABEL), hairs = Object.keys(HAIR_LABEL);
    for (const who of ['mom', 'dad']) {
      const v = r && r[who];
      if (!v) continue;
      if (eyes.includes(v.eye)) { S.parentEye[who] = v.eye; P[who].stats.eyeGuess = v.eye; }
      if (hairs.includes(v.hair) && v.hair !== 'gray') { S.parentHair[who] = v.hair; P[who].stats.hairGuess = v.hair; }
      renderCard(who);
    }
    if (r?.mom?.freckles || r?.dad?.freckles) { S.opts.freckles = true; $('#optFreckles').checked = true; }
    const ages = [r?.mom?.age, r?.dad?.age].filter((a) => typeof a === 'number' && a > 15 && a < 90);
    if (ages.length) { S.opts.parentAge = Math.round(ages.reduce((a, b) => a + b, 0) / ages.length); $('#optParentAge').value = String(nearestParentAge(S.opts.parentAge)); }
    out.textContent = typeof r?.note === 'string' ? r.note : 'Traits updated.';
    S.eye = 'auto'; S.hair = 'auto';
    persist(); buildTraits(); scheduleRender(true);
  } catch (e) {
    const code = e && e.code;
    out.textContent = code === 'not_granted' ? 'Claude was not allowed for this page, so nothing was sent.'
      : code === 'rate_limited' ? 'Claude is busy right now. Try again in a minute.'
        : 'Claude could not read the photos this time. Your own trait picks still work.';
  } finally { btn.disabled = false; }
});
function nearestParentAge(a) {
  const opts = $$('#optParentAge option').map((o) => Number(o.value));
  return opts.reduce((best, v) => Math.abs(v - a) < Math.abs(best - a) ? v : best, opts[0]);
}

// ---------- Forget ----------
let forgetArmed = false;
$('#forget').addEventListener('click', async () => {
  const b = $('#forget');
  if (!forgetArmed) { forgetArmed = true; b.textContent = 'Tap again to delete the photos'; setTimeout(() => { forgetArmed = false; b.textContent = 'Forget saved photos'; }, 4000); return; }
  forgetArmed = false;
  await clearPhotos(); clearSettings();
  P.mom = null; P.dad = null;
  Object.assign(S, defaults());
  for (const w of ['mom', 'dad']) { renderCard(w); setCardState(w, 'empty', ''); }
  buildGenes();
  onParentsChanged();
  b.textContent = 'Forget saved photos';
  toast('Photos and settings deleted from this phone');
});

// ---------- Boot ----------
buildGenes();
$$('#viewSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === S.view)));
setupClaude();
(async () => {
  const [m, d] = await Promise.all([loadPhoto('mom'), loadPhoto('dad')]);
  if (m) handlePhoto('mom', m, { store: false });
  if (d) handlePhoto('dad', d, { store: false });
})();

// Test hook for automated checks (no effect for viewers).
window.__bff = { S, P, handlePhoto, drawSiblings, posToAge, ageToPos };
