'use strict';
/* ==========================================================================
   WeelSpin — roue de la fortune 100 % statique
   Sections :
     1. Constantes & état
     2. Utilitaires
     3. Persistance (localStorage)
     4. Moteur audio (Web Audio)
     5. Fond animé (particules d'ambiance)
     6. Rendu de la roue (canvas + cache offscreen)
     7. Effets plein écran (confettis, étincelles, ondes, rayons)
     8. Tirage & animation du spin
     9. Éditeur de segments
    10. Export / Import JSON
    11. Interactions globales & démarrage
   ========================================================================== */

/* ============================ 1. Constantes & état ======================== */

const TAU = Math.PI * 2;
const POINTER_ANGLE = -Math.PI / 2;            // le pointeur est en haut
const STORAGE_KEY = 'weelspin.segments.v1';
const MUTE_KEY = 'weelspin.muted.v1';

const $ = (id) => document.getElementById(id);
const els = {
  bg: $('bg'), fx: $('fx'), wheel: $('wheel'), wheelWrap: $('wheel-wrap'),
  stage: $('stage'), halo: $('halo'), rays: $('rays'),
  dim: $('dim'), flash: $('flash'),
  btnSpin: $('btn-spin'), btnMute: $('btn-mute'), btnPresent: $('btn-present'),
  btnExitPresent: $('btn-exit-present'), btnEditor: $('btn-editor'),
  editor: $('editor'), editorFields: $('editor-fields'),
  segList: $('seg-list'), segCount: $('seg-count'),
  btnAdd: $('btn-add'), bulk: $('bulk'), btnBulk: $('btn-bulk'),
  btnShuffle: $('btn-shuffle'), btnClear: $('btn-clear'),
  btnExport: $('btn-export'), btnImport: $('btn-import'), fileImport: $('file-import'),
  result: $('result'), resultLabel: $('result-label'),
  btnAgain: $('btn-again'), btnClose: $('btn-close'),
  dropOverlay: $('drop-overlay'), toast: $('toast'), live: $('live'),
};

const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  segments: [],        // [{id, label, color, weight}]
  rot: 0,              // rotation courante de la roue (radians)
  vel: 0,              // vitesse angulaire (rad/s), pour le son et le motion blur
  spinning: false,
  winner: null,        // index du gagnant glorifié (null si aucun)
  winTime: 0,
  muted: false,
  reduced: reducedQuery.matches,
  suspense: 0,         // 0..1, intensité du suspense de fin de course
};

/* Qualité du rendu. Passe en "low" automatiquement si la machine ne tient pas
   60 fps (rendu logiciel, machine sans GPU) : on coupe alors les effets les
   plus coûteux en remplissage plutôt que de laisser ramer. */
const Q = { low: false };

function setLowQuality() {
  if (Q.low) return;
  Q.low = true;
  document.body.classList.add('low-fx');
  layoutWheel();                       // redessine la roue à la résolution réduite
  asteroids = [];
  initMotes();
  toast('Effets allégés pour rester fluide.');
}

let perfWindow = 0, perfFrames = 0, perfBad = 0, perfStart = 0;
function monitorPerf(now) {
  if (Q.low || state.reduced) return;
  if (!perfStart) { perfStart = now; perfWindow = now; return; }
  if (now - perfStart < 3000) { perfWindow = now; perfFrames = 0; return; }  // on ignore le démarrage
  perfFrames++;
  if (now - perfWindow < 1000) return;
  const fps = perfFrames * 1000 / (now - perfWindow);
  perfWindow = now; perfFrames = 0;
  // On exige un problème SOUTENU : un creux isolé (rafale de confettis, GC)
  // ne doit pas dégrader définitivement une machine par ailleurs capable.
  if (fps < 28) perfBad += 2;
  else if (fps < 45) perfBad += 1;
  else perfBad = 0;
  if (perfBad >= 4) setLowQuality();
}

let spin = null;       // animation en cours : {t0, rot0, delta, TA, TM, recoil, winner}
let arcs = [];         // géométrie des segments : [{a0, a1, mid, span}]

/* ============================ 2. Utilitaires ============================== */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const norm = (a) => ((a % TAU) + TAU) % TAU;
const easeOutQuint = (x) => 1 - Math.pow(1 - x, 5);
const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;

/** Flottant aléatoire [0,1) de qualité cryptographique. */
function randFloat() {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0] / 4294967296;
}

function uid() {
  const u = new Uint32Array(2);
  crypto.getRandomValues(u);
  return 's' + u[0].toString(36) + u[1].toString(36);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Éclaircit (amt > 0) ou assombrit (amt < 0) une couleur hex. */
function shade(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => clamp(Math.round(c + amt * 255 / 100), 0, 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** Noir ou blanc selon la luminance du fond. */
function textColorFor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#141625' : '#ffffff';
}

/** Palette auto : angle d'or en HSL, couleurs bien réparties. */
function autoColor(i) {
  const h = (i * 137.508 + 8) % 360;
  return hslToHex(h, 72, 55);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}

/** Normalise "#abc" ou "#aabbcc" en "#aabbcc" minuscule, sinon null. */
function normalizeColor(c) {
  if (typeof c !== 'string') return null;
  const m = c.trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const h = m[1];
  return '#' + (h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h);
}

function totalWeight() {
  return state.segments.reduce((s, x) => s + x.weight, 0);
}

/** Recalcule la géométrie angulaire des segments (proportionnelle aux poids). */
function computeArcs() {
  arcs = [];
  const total = totalWeight();
  let a = 0;
  for (const seg of state.segments) {
    const span = (seg.weight / total) * TAU;
    arcs.push({ a0: a, a1: a + span, mid: a + span / 2, span });
    a += span;
  }
}

/** Index du segment actuellement sous le pointeur pour une rotation donnée. */
function indexAt(rot) {
  const a = norm(POINTER_ANGLE - rot);
  for (let i = 0; i < arcs.length; i++) {
    if (a >= arcs[i].a0 && a < arcs[i].a1) return i;
  }
  return arcs.length - 1;
}

/** Tirage pondéré honnête : index du gagnant. */
function pickWeighted() {
  let r = randFloat() * totalWeight();
  for (let i = 0; i < state.segments.length; i++) {
    r -= state.segments[i].weight;
    if (r < 0) return i;
  }
  return state.segments.length - 1;
}

function vibrate(pattern) {
  if (!state.reduced && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* ignoré */ }
  }
}

function announce(msg) { els.live.textContent = msg; }

let toastTimer = 0;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 4000);
}

/* ============================ 3. Persistance ============================== */

function saveSegments() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      app: 'weelspin', version: 1,
      segments: state.segments.map(({ id, label, color, weight }) => ({ id, label, color, weight })),
    }));
  } catch { /* stockage indisponible : on continue sans persister */ }
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSegments, 300);
}

/**
 * Valide une structure importée / chargée.
 * Retourne { ok:true, segments } ou { ok:false, error }.
 */
function validateData(data) {
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'Le fichier ne contient pas un objet JSON.' };
  if (data.app !== 'weelspin') return { ok: false, error: 'Ce fichier n’est pas une configuration WeelSpin.' };
  if (data.version !== 1) return { ok: false, error: `Version « ${data.version} » non prise en charge (attendu : 1).` };
  if (!Array.isArray(data.segments)) return { ok: false, error: 'La liste des segments est manquante ou invalide.' };
  const segments = [];
  for (let i = 0; i < data.segments.length; i++) {
    const s = data.segments[i];
    if (typeof s !== 'object' || s === null) return { ok: false, error: `Segment n°${i + 1} invalide.` };
    if (typeof s.label !== 'string') return { ok: false, error: `Segment n°${i + 1} : libellé manquant.` };
    const color = normalizeColor(s.color);
    if (!color) return { ok: false, error: `Segment n°${i + 1} : couleur malformée (« ${s.color} »).` };
    if (typeof s.weight !== 'number' || !Number.isFinite(s.weight) || s.weight <= 0) {
      return { ok: false, error: `Segment n°${i + 1} : le poids doit être un nombre > 0.` };
    }
    segments.push({ id: typeof s.id === 'string' && s.id ? s.id : uid(), label: s.label, color, weight: s.weight });
  }
  return { ok: true, segments };
}

function defaultSegments() {
  const labels = ['Pizza 🍕', 'Bon d’achat 🎁', 'Jour de télétravail 🏠', 'Café offert ☕', 'Rejouer 🔁', 'Jackpot 💰'];
  return labels.map((label, i) => ({ id: uid(), label, color: autoColor(i), weight: 1 }));
}

function loadSegments() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const res = validateData(JSON.parse(raw));
      if (res.ok) { state.segments = res.segments; return; }
    }
  } catch { /* données corrompues : on repart sur l'exemple */ }
  state.segments = defaultSegments();
  saveSegments();
}

/* ============================ 4. Moteur audio ============================= */

const audio = { ctx: null, master: null, noiseBuf: null, riser: null };

/** Crée l'AudioContext après un geste utilisateur (politique d'autoplay). */
function ensureAudio() {
  if (audio.ctx) {
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio.ctx = new AC();
  audio.master = audio.ctx.createGain();
  audio.master.gain.value = state.muted ? 0 : 1;
  audio.master.connect(audio.ctx.destination);
  // Buffer de bruit blanc réutilisé (whoosh)
  const len = audio.ctx.sampleRate;
  audio.noiseBuf = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
  const d = audio.noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  droneStart();
}

/** Drone spatial d'ambiance, très discret (passe par le master : muet = silence). */
function droneStart() {
  if (!audio.ctx || state.reduced) return;
  const t = audio.ctx.currentTime;
  const g = audio.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.035, t + 4);
  const lp = audio.ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 2;
  const lfo = audio.ctx.createOscillator();
  const lfoG = audio.ctx.createGain();
  lfo.frequency.value = 0.07; lfoG.gain.value = 120;
  lfo.connect(lfoG).connect(lp.frequency);
  for (const [f, type] of [[55, 'sine'], [55.6, 'sine'], [110, 'sawtooth'], [164.8, 'triangle']]) {
    const o = audio.ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    o.connect(lp);
    o.start(t);
  }
  lp.connect(g).connect(audio.master);
  lfo.start(t);
}

/** Bip de verrouillage (HUD). */
function sndLock(final) {
  if (!audio.ctx || state.muted) return;
  const t = audio.ctx.currentTime;
  const seq = final ? [1046, 1318, 1568] : [880];
  seq.forEach((f, i) => {
    const o = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t0 = t + i * 0.07;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.08, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    o.connect(g).connect(audio.master);
    o.start(t0); o.stop(t0 + 0.14);
  });
}

function setMuted(muted) {
  state.muted = muted;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* ignoré */ }
  if (audio.master) audio.master.gain.setTargetAtTime(muted ? 0 : 1, audio.ctx.currentTime, 0.02);
  els.btnMute.setAttribute('aria-pressed', String(muted));
  els.btnMute.setAttribute('aria-label', muted ? 'Réactiver le son' : 'Couper le son');
  els.btnMute.querySelector('.ico-sound-on').hidden = muted;
  els.btnMute.querySelector('.ico-sound-off').hidden = !muted;
}

/** Tick de segment : pitch et volume suivent la vitesse angulaire. */
function sndTick(vel) {
  if (!audio.ctx || state.muted) return;
  const t = audio.ctx.currentTime;
  const osc = audio.ctx.createOscillator();
  const g = audio.ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 500 + clamp(Math.abs(vel) * 80, 0, 1400);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.11, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  osc.connect(g).connect(audio.master);
  osc.start(t); osc.stop(t + 0.09);
}

/** Whoosh de départ : bruit filtré qui monte. */
function sndWhoosh() {
  if (!audio.ctx || state.muted) return;
  const t = audio.ctx.currentTime;
  const src = audio.ctx.createBufferSource();
  src.buffer = audio.noiseBuf;
  const bp = audio.ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(180, t);
  bp.frequency.exponentialRampToValueAtTime(2800, t + 0.7);
  const g = audio.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.28, t + 0.15);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  src.connect(bp).connect(g).connect(audio.master);
  src.start(t); src.stop(t + 1);
}

/** Montée de tension : nappe dont la hauteur suit le suspense. */
function riserStart() {
  if (!audio.ctx || state.muted || audio.riser) return;
  const t = audio.ctx.currentTime;
  const osc = audio.ctx.createOscillator();
  const g = audio.ctx.createGain();
  const lfo = audio.ctx.createOscillator();
  const lfoGain = audio.ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 160;
  lfo.type = 'sine'; lfo.frequency.value = 9;
  lfoGain.gain.value = 0.015;
  lfo.connect(lfoGain).connect(g.gain);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.05, t + 0.4);
  osc.connect(g).connect(audio.master);
  osc.start(t); lfo.start(t);
  audio.riser = { osc, g, lfo };
}

function riserUpdate(f) {
  if (audio.riser) audio.riser.osc.frequency.value = 160 + f * 520;
}

function riserStop() {
  if (!audio.riser) return;
  const { osc, g, lfo } = audio.riser;
  audio.riser = null;
  const t = audio.ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setTargetAtTime(0.0001, t, 0.05);
  osc.stop(t + 0.3); lfo.stop(t + 0.3);
}

/** Jingle de victoire : accord arpégé + basse + étincelle aiguë. */
function sndVictory() {
  if (!audio.ctx || state.muted) return;
  const t = audio.ctx.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
  notes.forEach((f, i) => {
    const osc = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const t0 = t + i * 0.085;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
    osc.connect(g).connect(audio.master);
    osc.start(t0); osc.stop(t0 + 0.8);
  });
  const bass = audio.ctx.createOscillator();
  const bg = audio.ctx.createGain();
  bass.type = 'sine'; bass.frequency.value = 130.81;
  bg.gain.setValueAtTime(0.2, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  bass.connect(bg).connect(audio.master);
  bass.start(t); bass.stop(t + 0.7);
}

/** Petits sons d'interface : blip montant (ajout) ou descendant (suppression). */
function sndUi(kind) {
  if (!audio.ctx || state.muted) return;
  const t = audio.ctx.currentTime;
  const osc = audio.ctx.createOscillator();
  const g = audio.ctx.createGain();
  osc.type = 'sine';
  if (kind === 'add') {
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.exponentialRampToValueAtTime(920, t + 0.09);
  } else {
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.11);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.09, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  osc.connect(g).connect(audio.master);
  osc.start(t); osc.stop(t + 0.15);
}

/* ============================ 5. Fond animé : champ d'étoiles ============ */

const bgCtx = els.bg.getContext('2d', { alpha: true });
let starGroups = [];     // étoiles regroupées par couleur : un seul fillStyle par groupe
let shooting = [];       // étoiles filantes
let nextShooting = 0;
let planet = null;       // { r, cx, cy }
let bgCache = {};        // dégradés recalculés seulement au redimensionnement

/** Facteur d'échelle des traits fil de fer selon la taille d'écran. */
const wireScale = () => clamp(Math.min(innerWidth, innerHeight) / 800, 1, 2.2);

/** Dégradés du décor, coûteux à créer : construits une fois par taille d'écran. */
function rebuildBgCache() {
  const H = innerHeight, hy = H * 0.58;
  const fade = bgCtx.createLinearGradient(0, hy, 0, H);
  fade.addColorStop(0, 'rgba(0,0,0,0.92)');
  fade.addColorStop(0.35, 'rgba(0,0,0,0.45)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  const glow = bgCtx.createLinearGradient(0, hy, 0, hy + H * 0.25);
  glow.addColorStop(0, 'rgba(76,240,255,0.16)');
  glow.addColorStop(1, 'rgba(76,240,255,0)');
  bgCache = { hy, fade, glow };
}

function buildPlanet() {
  const r = Math.max(70, Math.min(innerWidth, innerHeight) * 0.17);
  planet = { r, cx: innerWidth * 0.06 + r * 0.3, cy: innerHeight * 0.1 };
  initAsteroids();
  rebuildBgCache();
}

function drawPlanet(now) {
  if (!planet || Q.low) return;
  const { r, cx, cy } = planet;
  wireSphere(bgCtx, cx, cy, r, 0.42, now / 14000 * TAU, {
    col: '170,140,255', lats: 4, lons: 8, rings: [1.45, 1.75],
    aBack: 0.1, aFront: 0.5, width: 1.2 * wireScale(),
  });
  // Petite lune en orbite (passe derrière puis devant)
  const a = now / 9000 * TAU;
  if (Math.sin(a) > 0) {
    bgCtx.beginPath();
    bgCtx.arc(cx + Math.cos(a) * r * 1.75, cy + Math.sin(a) * r * 0.5 + r * 0.15, r * 0.09, 0, TAU);
    bgCtx.fillStyle = '#dfe8ff';
    bgCtx.fill();
  }
}

/** Champ d'étoiles : regroupées par couleur pour limiter les changements d'état. */
function initMotes() {
  starGroups = [];
  if (state.reduced) return;
  const div = Q.low ? 22000 : 11000;
  const n = Math.min(Q.low ? 90 : 190, Math.round(innerWidth * innerHeight / div));
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const z = 0.25 + Math.random() * 0.75;          // profondeur : petit/lent -> gros/rapide
    const hue = Math.random() < 0.15 ? 300 : Math.random() < 0.5 ? 195 : 45;
    const sat = Math.random() < 0.6 ? 0 : 70;
    const key = hue + '/' + sat;
    if (!groups.has(key)) groups.set(key, { css: `hsl(${hue},${sat}%,92%)`, list: [] });
    groups.get(key).list.push({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight, z,
      r: 0.8 + z * 1.8,
      ph: Math.random() * TAU, tw: 0.6 + Math.random() * 2.2,
    });
  }
  starGroups = [...groups.values()];
}

function spawnShooting() {
  const fromLeft = Math.random() < 0.5;
  shooting.push({
    x: fromLeft ? -40 : innerWidth + 40, y: Math.random() * innerHeight * 0.5,
    vx: (fromLeft ? 1 : -1) * (700 + Math.random() * 500), vy: 250 + Math.random() * 250,
    life: 0, ttl: 1.1 + Math.random() * 0.5,
  });
}

function drawBg(now, dt) {
  const dpr = els.bg._dpr || 1;
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgCtx.clearRect(0, 0, innerWidth, innerHeight);
  if (state.reduced) return;

  drawGrid();

  // Warp : les étoiles s'étirent depuis le centre de la roue selon sa vitesse
  const warp = clamp(Math.abs(state.vel) / 30, 0, 1);
  const wc = warp > 0.05 ? wheelCenter() : null;
  const t = now / 1000;

  for (const g of starGroups) {
    bgCtx.fillStyle = bgCtx.strokeStyle = g.css;
    if (wc) {
      // Traînées : un seul chemin et un seul stroke pour tout le groupe
      const len = warp * warp * 0.3;
      bgCtx.globalAlpha = clamp(0.35 + warp * 0.4, 0, 1);
      bgCtx.lineWidth = 1.3;
      bgCtx.beginPath();
      for (const s of g.list) {
        s.y += s.z * 3 * dt;
        if (s.y > innerHeight + 4) { s.y = -4; s.x = Math.random() * innerWidth; }
        bgCtx.moveTo(s.x, s.y);
        bgCtx.lineTo(s.x + (s.x - wc.x) * len * s.z, s.y + (s.y - wc.y) * len * s.z);
      }
      bgCtx.stroke();
    } else {
      for (const s of g.list) {
        s.y += s.z * 3 * dt;
        if (s.y > innerHeight + 4) { s.y = -4; s.x = Math.random() * innerWidth; }
        bgCtx.globalAlpha = clamp((0.3 + 0.6 * s.z) * (0.55 + 0.45 * Math.sin(t * s.tw + s.ph)), 0, 1);
        bgCtx.fillRect(s.x, s.y, s.r, s.r);      // carré : bien moins cher qu'un arc
      }
    }
  }
  bgCtx.globalAlpha = 1;

  drawPlanet(now);
  drawAsteroids(now, dt);
  if (!Q.low) drawCage(bgCtx, now, false);
  drawReticle(now);

  // Étoiles filantes, de temps en temps
  if (now > nextShooting) { spawnShooting(); nextShooting = now + 3500 + Math.random() * 6000; }
  for (let i = shooting.length - 1; i >= 0; i--) {
    const m = shooting[i];
    m.life += dt;
    if (m.life > m.ttl) { shooting.splice(i, 1); continue; }
    m.x += m.vx * dt; m.y += m.vy * dt;
    const tail = 0.12;
    bgCtx.globalAlpha = Math.sin(Math.PI * m.life / m.ttl);
    bgCtx.strokeStyle = '#cfefff';
    bgCtx.lineWidth = 2;
    bgCtx.beginPath();
    bgCtx.moveTo(m.x, m.y);
    bgCtx.lineTo(m.x - m.vx * tail, m.y - m.vy * tail);
    bgCtx.stroke();
  }
  bgCtx.globalAlpha = 1;
}

/* ============================ 5b. Wireframe 3D ========================== */
/* Moteur fil de fer minimal : rotation 3D, projection perspective, et tracé
   groupé (un seul stroke pour l'avant, un seul pour l'arrière) — c'est ce
   groupage qui rend l'ensemble tenable sans GPU. */

function rot3(p, ax, ay) {
  let [x, y, z] = p;
  let c = Math.cos(ax), s = Math.sin(ax);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(ay); s = Math.sin(ay);
  [x, z] = [x * c + z * s, -x * s + z * c];
  return [x, y, z];
}

/**
 * Trace une liste de polylignes 3D en DEUX passes seulement (arrière puis avant),
 * au lieu d'un stroke par segment.
 */
function wireStroke(ctx, paths, cx, cy, f, col, aBack, aFront, width, onlyFront, onlyBack) {
  for (const front of [false, true]) {
    if (front ? onlyBack : onlyFront) continue;
    const alpha = front ? aFront : aBack;
    if (alpha <= 0.01) continue;
    ctx.strokeStyle = 'rgba(' + col + ',' + alpha + ')';
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const pts of paths) {
      let pen = false;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        if ((p[2] + q[2] > 0) !== front) { pen = false; continue; }
        const sp = f / (f - p[2]), sq = f / (f - q[2]);
        if (!pen) { ctx.moveTo(cx + p[0] * sp, cy + p[1] * sp); pen = true; }
        ctx.lineTo(cx + q[0] * sq, cy + q[1] * sq);
      }
    }
    ctx.stroke();
  }
}

/** Cercle 3D dans un plan donné (lat = parallèle, lon = méridien). */
function circle3(r, n, kind, k) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n * TAU;
    if (kind === 'lat') pts.push([Math.cos(t) * r * Math.cos(k), Math.sin(k) * r, Math.sin(t) * r * Math.cos(k)]);
    else pts.push(rot3([Math.cos(t) * r, Math.sin(t) * r, 0], 0, k));
  }
  return pts;
}

/** Sphère fil de fer (parallèles + méridiens), éventuellement avec anneaux. */
function wireSphere(ctx, cx, cy, r, ax, ay, opts) {
  const { col = '76,240,255', aBack = 0.12, aFront = 0.45, lats = 4, lons = 8,
          rings = [], onlyFront = false, onlyBack = false, width = 1 } = opts;
  const SEG = 20;                                   // 20 segments suffisent visuellement
  const paths = [];
  for (let i = 1; i <= lats; i++) paths.push(circle3(r, SEG, 'lat', -Math.PI / 2 + i * Math.PI / (lats + 1)));
  for (let i = 0; i < lons; i++) paths.push(circle3(r, SEG, 'lon', i * Math.PI / lons));
  for (const rr of rings) paths.push(circle3(r * rr, SEG + 8, 'lat', 0));
  const rot = paths.map((p) => p.map((q) => rot3(q, ax, ay)));
  wireStroke(ctx, rot, cx, cy, r * 4.5, col, aBack, aFront, width, onlyFront, onlyBack);
}

/* Icosaèdre : sommets + arêtes (astéroïdes) */
const ICO_V = (() => {
  const t = (1 + Math.sqrt(5)) / 2, v = [];
  for (const s of [-1, 1]) for (const u of [-1, 1]) { v.push([0, s, u * t]); v.push([s, u * t, 0]); v.push([u * t, 0, s]); }
  const n = Math.hypot(1, t);
  return v.map((p) => p.map((x) => x / n));
})();
const ICO_E = (() => {
  const e = [];
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    const d = Math.hypot(ICO_V[i][0] - ICO_V[j][0], ICO_V[i][1] - ICO_V[j][1], ICO_V[i][2] - ICO_V[j][2]);
    if (d < 1.1) e.push([i, j]);
  }
  return e;
})();

let asteroids = [];
function initAsteroids() {
  asteroids = [];
  if (state.reduced || Q.low) return;
  const n = innerWidth < 900 ? 2 : 3;
  for (let i = 0; i < n; i++) {
    asteroids.push({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: (16 + Math.random() * 24) * wireScale(),
      vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 8,
      ax: Math.random() * TAU, ay: Math.random() * TAU,
      sx: (Math.random() - 0.5) * 0.6, sy: (Math.random() - 0.5) * 0.8,
      col: Math.random() < 0.5 ? '76,240,255' : '255,77,224',
    });
  }
}

function drawAsteroids(now, dt) {
  const lw = wireScale();
  for (const a of asteroids) {
    a.x += a.vx * dt; a.y += a.vy * dt;
    if (a.x < -60) a.x = innerWidth + 60; if (a.x > innerWidth + 60) a.x = -60;
    if (a.y < -60) a.y = innerHeight + 60; if (a.y > innerHeight + 60) a.y = -60;
    const ax = a.ax + now / 1000 * a.sx, ay = a.ay + now / 1000 * a.sy;
    const f = a.r * 5;
    const pts = ICO_V.map((p) => rot3([p[0] * a.r, p[1] * a.r, p[2] * a.r], ax, ay));
    // Toutes les arêtes en un seul chemin, un seul stroke
    bgCtx.strokeStyle = 'rgba(' + a.col + ',0.34)';
    bgCtx.lineWidth = lw;
    bgCtx.beginPath();
    for (const [i, j] of ICO_E) {
      const p = pts[i], q = pts[j];
      const sp = f / (f - p[2]), sq = f / (f - q[2]);
      bgCtx.moveTo(a.x + p[0] * sp, a.y + p[1] * sp);
      bgCtx.lineTo(a.x + q[0] * sq, a.y + q[1] * sq);
    }
    bgCtx.stroke();
  }
}

/** Sol en grille perspective. Deux strokes + un fondu : plus de dégradé par colonne. */
let gridPhase = 0;
function drawGrid() {
  if (Q.low) return;
  const W = innerWidth, H = innerHeight, hy = bgCache.hy || H * 0.58;
  const speed = 0.35 + clamp(Math.abs(state.vel) / 30, 0, 1) * 3;
  gridPhase = (gridPhase + 0.016 * speed) % 1;
  bgCtx.save();
  bgCtx.beginPath(); bgCtx.rect(0, hy, W, H - hy); bgCtx.clip();
  bgCtx.lineWidth = 1;

  // Lignes horizontales : espacement en t^3 pour l'effet de fuite
  bgCtx.strokeStyle = 'rgba(76,240,255,0.3)';
  bgCtx.beginPath();
  for (let i = 0; i < 14; i++) {
    const y = hy + (H - hy) * Math.pow((i + gridPhase) / 14, 3);
    bgCtx.moveTo(0, y); bgCtx.lineTo(W, y);
  }
  bgCtx.stroke();

  // Lignes verticales convergeant vers le point de fuite
  const vx = W / 2 + (parseFloat(document.documentElement.style.getPropertyValue('--px')) || 0) * -W * 0.05;
  bgCtx.strokeStyle = 'rgba(255,77,224,0.26)';
  bgCtx.beginPath();
  for (let i = -14; i <= 14; i++) {
    bgCtx.moveTo(vx, hy);
    bgCtx.lineTo(W / 2 + i * (W * 1.6 / 14), H);
  }
  bgCtx.stroke();

  // Fondu vers l'horizon : on efface au lieu de dégrader chaque ligne
  if (bgCache.fade) {
    bgCtx.globalCompositeOperation = 'destination-out';
    bgCtx.fillStyle = bgCache.fade;
    bgCtx.fillRect(0, hy, W, H - hy);
    bgCtx.globalCompositeOperation = 'source-over';
  }
  if (bgCache.glow) {
    bgCtx.fillStyle = bgCache.glow;
    bgCtx.fillRect(0, hy, W, H * 0.25);
  }
  bgCtx.restore();
}

/** Cage holographique autour de la roue (moitié arrière sur le fond, avant sur les FX). */
function drawCage(ctx, now, front) {
  if (!cssSize || !state.segments.length || Q.low) return;
  const wc = wheelCenter();
  wireSphere(ctx, wc.x, wc.y, wc.R * 1.24, 0.35 + Math.sin(now / 6000) * 0.15, now / 9000 * TAU + state.rot * 0.2, {
    col: '120,220,255', lats: 3, lons: 6, width: wireScale(),
    aBack: 0.26, aFront: 0.12,
    onlyFront: front, onlyBack: !front,
  });
}

/** Réticule de visée : couronne graduée, arcs tournants, crochets. */
function drawReticle(now) {
  if (!cssSize || !state.segments.length) return;
  const wc = wheelCenter();
  const lock = state.suspense;
  const col = lock > 0.3 ? '255,77,224' : '76,240,255';
  const ws = wireScale();
  const ctx = bgCtx;

  ctx.save();
  ctx.translate(wc.x, wc.y);
  ctx.rotate(-state.rot * 0.5 - now / 30000 * TAU);
  ctx.lineWidth = ws;
  // Graduations : deux chemins (majeures / mineures) au lieu d'un stroke par trait
  const r1 = wc.R * 1.33;
  for (const major of [false, true]) {
    ctx.strokeStyle = 'rgba(' + col + ',' + (major ? 0.55 : 0.26) + ')';
    ctx.beginPath();
    for (let i = 0; i < 36; i++) {
      if ((i % 3 === 0) !== major) continue;
      const a = i / 36 * TAU, len = (i % 9 === 0 ? 13 : major ? 8 : 4) * ws;
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.moveTo(ca * r1, sa * r1);
      ctx.lineTo(ca * (r1 + len), sa * (r1 + len));
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(wc.x, wc.y);
  ctx.strokeStyle = 'rgba(' + col + ',0.45)';
  ctx.lineWidth = (1.5 + lock * 1.5) * ws;
  ctx.beginPath();
  for (const [rr, sp, span] of [[1.38, 1 / 7000, 2.1], [1.42, -1 / 11000, 1.1], [1.29, 1 / 4000, 0.5]]) {
    const a0 = now * sp * TAU + state.rot * 0.2;
    ctx.arc(0, 0, wc.R * rr, a0, a0 + span);
    ctx.moveTo(0, 0);                                // coupe le trait entre deux arcs
  }
  ctx.stroke();

  // Crochets d'angle (se resserrent au verrouillage)
  const d = wc.R * (1.55 - 0.08 * lock);
  const L = 18 * ws;
  ctx.strokeStyle = 'rgba(' + col + ',' + (0.5 + 0.4 * lock) + ')';
  ctx.lineWidth = 2 * ws;
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.moveTo(sx * d, sy * d - sy * L); ctx.lineTo(sx * d, sy * d); ctx.lineTo(sx * d - sx * L, sy * d);
  }
  ctx.stroke();
  ctx.restore();
}

/** Tunnel hyperespace : anneaux qui foncent vers la caméra au départ du spin. */
let tunnel = { t0: -1e9, rings: [] };
function tunnelStart(now) {
  tunnel.t0 = now;
  tunnel.rings = Array.from({ length: 10 }, (_, i) => ({ z: i / 10 }));
}
function drawTunnel(now, dt) {
  const age = (now - tunnel.t0) / 1000;
  if (age < 0 || age > 2.2 || state.reduced || Q.low) return;
  const I = age < 0.3 ? age / 0.3 : age > 1.5 ? 1 - (age - 1.5) / 0.7 : 1;
  const wc = wheelCenter();
  const spin = state.rot * 0.6;
  const maxR = Math.max(innerWidth, innerHeight) * 1.6;
  fctx.save();
  fctx.lineWidth = 1.5 * wireScale();
  for (const ring of tunnel.rings) {
    ring.z += 1.6 * dt;
    if (ring.z > 1) ring.z -= 1;
    const r = wc.R * 0.25 / (1.05 - ring.z);
    if (r > maxR) continue;
    fctx.strokeStyle = ((ring.z * 5 | 0) % 2 ? 'rgba(255,77,224,' : 'rgba(76,240,255,') + (I * 0.55 * ring.z) + ')';
    fctx.beginPath();
    for (let k = 0; k <= 10; k++) {
      const ang = k / 10 * TAU + spin;
      const x = wc.x + Math.cos(ang) * r, y = wc.y + Math.sin(ang) * r;
      k ? fctx.lineTo(x, y) : fctx.moveTo(x, y);
    }
    fctx.stroke();
  }
  // Longerons : un seul chemin
  fctx.strokeStyle = 'rgba(160,230,255,' + (I * 0.16) + ')';
  fctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const ang = k / 8 * TAU + spin;
    fctx.moveTo(wc.x + Math.cos(ang) * wc.R * 0.25, wc.y + Math.sin(ang) * wc.R * 0.25);
    fctx.lineTo(wc.x + Math.cos(ang) * maxR, wc.y + Math.sin(ang) * maxR);
  }
  fctx.stroke();
  fctx.restore();
}

/* ============================ 6. Rendu de la roue ========================= */

const wctx = els.wheel.getContext('2d');
let cssSize = 0;      // côté du canvas roue en px CSS
let R = 0;            // rayon total (anneau compris)
let Rw = 0;           // rayon du disque des segments
let wheelCache = null;
let cacheDirty = true;

// Ressort du pointeur (claquement élastique)
let pk = 0, pv = 0;
let raysNext = 0;
let wheelGfx = null;   // dégradés de la roue, reconstruits au redimensionnement seulement

/** (Re)construit les dégradés statiques de la roue. Les coordonnées d'un dégradé
 *  sont interprétées au moment du tracé : on peut donc les créer une fois. */
function ensureWheelGfx(c) {
  if (wheelGfx) return;
  const ring = c.createLinearGradient(0, -R, 0, R);
  ring.addColorStop(0, '#d6e8ff'); ring.addColorStop(0.4, '#5f6f9a');
  ring.addColorStop(0.6, '#b3c6ea'); ring.addColorStop(1, '#3f4a70');
  const dome = c.createLinearGradient(0, -Rw, 0, Rw * 0.1);
  dome.addColorStop(0, 'rgba(255,255,255,0.2)');
  dome.addColorStop(1, 'rgba(255,255,255,0)');
  wheelGfx = { ring, dome };
}

function layoutWheel() {
  // clientWidth/Height : boîte de layout, insensible aux transformations CSS (tilt, boot)
  const s = Math.floor(Math.min(els.wheelWrap.clientWidth, els.wheelWrap.clientHeight));
  if (s < 40) return;
  cssSize = s;
  const dpr = Math.min(devicePixelRatio || 1, Q.low ? 1 : 2);
  els.wheel.style.width = s + 'px';
  els.wheel.style.height = s + 'px';
  els.wheel.width = Math.round(s * dpr);
  els.wheel.height = Math.round(s * dpr);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  R = s / 2 * 0.86;      // marge pour le pointeur et la lueur de l'anneau
  Rw = R * 0.94;
  // Taille posée une fois : ensuite on n'anime que transform/opacity (composités)
  els.halo.style.width = els.halo.style.height = Math.round(R * 2.9) + 'px';
  els.rays.style.width = els.rays.style.height = Math.round(R * 2.7) + 'px';
  wheelGfx = null;
  cacheDirty = true;
}

/**
 * Redessine la roue (segments, séparateurs, libellés, biseaux) dans un canvas
 * offscreen. Le rendu par image devient alors un simple drawImage tourné,
 * ce qui garantit 60 fps même avec 200 segments.
 */
function rebuildWheelCache() {
  cacheDirty = false;
  computeArcs();
  const dpr = Math.min(devicePixelRatio || 1, Q.low ? 1 : 2);
  wheelCache = document.createElement('canvas');
  wheelCache.width = wheelCache.height = Math.round(cssSize * dpr);
  const c = wheelCache.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.translate(cssSize / 2, cssSize / 2);
  if (!state.segments.length) return;

  for (let i = 0; i < state.segments.length; i++) {
    const seg = state.segments[i];
    const { a0, a1 } = arcs[i];
    // Matière : dégradé radial clair au bord, sombre au centre
    const grad = c.createRadialGradient(0, 0, Rw * 0.12, 0, 0, Rw);
    grad.addColorStop(0, shade(seg.color, -22));
    grad.addColorStop(0.55, seg.color);
    grad.addColorStop(0.92, shade(seg.color, 14));
    grad.addColorStop(1, shade(seg.color, -8));
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, Rw, a0, a1);
    c.closePath();
    c.fillStyle = grad;
    c.fill();
    // Séparateur biseauté
    if (state.segments.length > 1) {
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 1.6;
      c.stroke();
      c.save();
      c.rotate(a0);
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(Rw * 0.1, 0); c.lineTo(Rw * 0.99, 0);
      c.stroke();
      c.restore();
    }
  }

  // Libellés radiaux, taille auto, masqués si trop petits, ellipse si trop longs
  for (let i = 0; i < state.segments.length; i++) {
    const seg = state.segments[i];
    const { mid, span } = arcs[i];
    const fontSize = clamp(Math.min(Rw * 0.075, span * Rw * 0.62 * 0.55), 0, 40);
    if (fontSize < 8.5) continue;
    c.save();
    c.rotate(mid);
    c.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.fillStyle = textColorFor(seg.color);
    const maxW = Rw * 0.64;
    let label = seg.label || '—';
    if (c.measureText(label).width > maxW) {
      while (label.length > 1 && c.measureText(label + '…').width > maxW) label = label.slice(0, -1);
      label += '…';
    }
    c.shadowColor = 'rgba(0,0,0,0.35)';
    c.shadowBlur = 3;
    c.fillText(label, Rw * 0.92, 0);
    c.restore();
  }

  // Liseré intérieur clair (biseau global)
  c.beginPath();
  c.arc(0, 0, Rw - 1, 0, TAU);
  c.strokeStyle = 'rgba(255,255,255,0.1)';
  c.lineWidth = 2;
  c.stroke();
}

/** Trace le chemin d'un secteur (repère : centre de la roue, espace tourné). */
function wedgePath(c, i, r) {
  const { a0, a1 } = arcs[i];
  c.moveTo(0, 0);
  c.arc(0, 0, r, a0, a1);
  c.closePath();
}

function drawWheel(now) {
  if (!cssSize) return;
  if (cacheDirty) rebuildWheelCache();
  const c = wctx;
  const half = cssSize / 2;
  c.clearRect(0, 0, cssSize, cssSize);

  // État vide élégant
  if (!state.segments.length) {
    c.save();
    c.translate(half, half);
    c.rotate(now / 6000);
    c.setLineDash([12, 14]);
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 3;
    c.beginPath(); c.arc(0, 0, Rw, 0, TAU); c.stroke();
    c.restore();
    c.save();
    c.translate(half, half);
    c.fillStyle = 'rgba(238,241,251,0.9)';
    c.textAlign = 'center';
    c.font = `700 ${Math.max(16, Rw * 0.09)}px system-ui, sans-serif`;
    c.fillText('Roue vide', 0, -Rw * 0.06);
    c.fillStyle = 'rgba(154,163,192,0.9)';
    c.font = `500 ${Math.max(12, Rw * 0.055)}px system-ui, sans-serif`;
    c.fillText('Ajoutez des segments dans l’éditeur →', 0, Rw * 0.08);
    c.restore();
    return;
  }

  // Flottement + respiration au repos (désactivés en reduced motion)
  ensureWheelGfx(c);
  const floatY = state.reduced ? 0 : Math.sin(now / 1400) * cssSize * 0.006;
  const breath = state.reduced ? 1 : 1 + Math.sin(now / 2100) * 0.006;
  const zoom = 1 + 0.05 * state.suspense + (state.winner !== null ? 0.02 : 0);

  c.save();
  c.translate(half, half + floatY);
  c.scale(breath * zoom, breath * zoom);

  // Halo derrière la roue (élément DOM #halo, hors canvas pour ne pas être rogné)
  const haloI = Math.max(state.suspense, state.winner !== null ? 0.7 : 0);
  if (haloI > 0.02 && !state.reduced) {
    const pulse = 0.6 + 0.4 * Math.sin(now / (110 - 60 * state.suspense));
    const col = state.winner !== null ? state.segments[state.winner].color : '#ffd75e';
    els.halo.style.setProperty('--halo-color', col);
    els.halo.style.transform = `translate(-50%,-50%) translateY(${floatY.toFixed(1)}px) scale(${(breath * zoom).toFixed(3)})`;
    els.halo.style.opacity = (0.55 * haloI * pulse).toFixed(3);
  } else if (els.halo.style.opacity !== '0') {
    els.halo.style.opacity = '0';
  }

  // Rayons divins derrière la roue : tournent lentement, s'entraînent avec la roue,
  // s'intensifient avec la vitesse et le suspense
  if (!state.reduced && !Q.low && now > raysNext) {
    raysNext = now + 50;                            // ~20 Hz suffit pour une rotation lente
    const speedF = clamp(Math.abs(state.vel) / 30, 0, 1);
    els.rays.style.transform = 'translate(-50%,-50%) translateY(' + floatY.toFixed(1) + 'px) scale(' + (breath * zoom).toFixed(3) + ') rotate(' + (now / 45000 * TAU + state.rot * 0.3).toFixed(3) + 'rad)';
    els.rays.style.opacity = (0.4 + 0.5 * Math.max(speedF, state.suspense, state.winner !== null ? 0.6 : 0)).toFixed(2);
  }

  // Anneaux orbitaux et lunes qui gravitent autour du portail
  if (!state.reduced) {
    const orbits = [
      { r: R * 1.06, speed: 1 / 5200, moon: 3.2, col: '76,240,255' },
      { r: R * 1.13, speed: -1 / 8300, moon: 2.4, col: '255,77,224' },
    ];
    for (const o of orbits) {
      c.beginPath(); c.arc(0, 0, o.r, 0, TAU);
      c.strokeStyle = 'rgba(' + o.col + ',0.16)';
      c.lineWidth = 1;
      c.setLineDash([2, 6]);
      c.stroke();
      c.setLineDash([]);
      const a = now * o.speed * TAU + state.rot * 0.15;
      const dir = Math.sign(o.speed);
      for (let k = 6; k >= 1; k--) {                     // traînée de la lune
        const ak = a - dir * k * 0.06;
        c.beginPath(); c.arc(Math.cos(ak) * o.r, Math.sin(ak) * o.r, o.moon * (1 - k / 8), 0, TAU);
        c.fillStyle = 'rgba(' + o.col + ',' + (0.5 * (1 - k / 7)) + ')';
        c.fill();
      }
      const mx = Math.cos(a) * o.r, my = Math.sin(a) * o.r;
      c.beginPath(); c.arc(mx, my, o.moon, 0, TAU);
      c.fillStyle = '#fff';
      c.fill();
    }
  }

  const drawCache = (rot, alpha) => {
    c.save();
    c.rotate(rot);
    c.globalAlpha = alpha;
    c.drawImage(wheelCache, -half, -half, cssSize, cssSize);
    c.restore();
  };

  // Traînée / motion blur à haute vitesse : fantômes décalés
  if (!state.reduced && !Q.low && Math.abs(state.vel) > 7) {
    drawCache(state.rot - state.vel * 0.02, 0.28);
  }
  drawCache(state.rot, 1);

  // Surcouches dans l'espace tourné de la roue
  c.save();
  c.rotate(state.rot);

  // Flash du segment survolé pendant le suspense
  if (state.suspense > 0.25 && state.spinning) {
    const cur = indexAt(state.rot);
    c.beginPath();
    wedgePath(c, cur, Rw);
    c.fillStyle = `rgba(255,255,255,${0.08 + 0.1 * (0.5 + 0.5 * Math.sin(now / 55))})`;
    c.fill();
  }

  // Glorification du gagnant : le reste s'assombrit, lui rayonne
  if (state.winner !== null) {
    const g = clamp((now - state.winTime) / 400, 0, 1);
    c.beginPath();
    for (let i = 0; i < arcs.length; i++) {
      if (i !== state.winner) wedgePath(c, i, Rw);
    }
    c.fillStyle = `rgba(5,7,18,${0.55 * g})`;
    c.fill();
    // Contour lumineux animé du gagnant
    const seg = state.segments[state.winner];
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    c.beginPath();
    wedgePath(c, state.winner, Rw);
    const { r: gr, g: gg, b: gb } = hexToRgb(seg.color);
    c.strokeStyle = `rgba(${gr},${gg},${gb},${0.3 + 0.25 * pulse})`;
    c.lineWidth = 14 + 8 * pulse;
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.95)';
    c.lineWidth = 3 + 2 * pulse;
    c.stroke();
  }
  c.restore(); // fin espace tourné

  // Reflet spéculaire qui glisse (suit lentement le temps et la rotation)
  if (!state.reduced && !Q.low && c.createConicGradient) {
    const glossA = now / 4000 + state.rot * 0.35;
    const cg = c.createConicGradient(glossA, 0, 0);
    cg.addColorStop(0, 'rgba(255,255,255,0)');
    cg.addColorStop(0.04, 'rgba(255,255,255,0.14)');
    cg.addColorStop(0.1, 'rgba(255,255,255,0)');
    cg.addColorStop(0.5, 'rgba(255,255,255,0)');
    cg.addColorStop(0.55, 'rgba(255,255,255,0.08)');
    cg.addColorStop(0.61, 'rgba(255,255,255,0)');
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    c.globalCompositeOperation = 'screen';
    c.fillStyle = cg;
    c.beginPath(); c.arc(0, 0, Rw, 0, TAU); c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  // Dôme de verre : reflet fixe en haut du disque (espace non tourné)
  if (!state.reduced) {
    c.globalCompositeOperation = 'screen';
    c.fillStyle = wheelGfx.dome;
    c.beginPath(); c.arc(0, 0, Rw, 0, TAU); c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  // Anneau d'énergie plasma : n'apparaît qu'en vitesse, tourne avec la roue
  const plasma = state.reduced || Q.low ? 0 : clamp(Math.abs(state.vel) / 28, 0, 1);
  if (plasma > 0.02 && c.createConicGradient) {
    const eg = c.createConicGradient(state.rot * 1.6, 0, 0);
    for (let k = 0; k < 6; k++) {
      eg.addColorStop(k / 6, k % 2 ? 'rgba(255,77,224,0)' : 'rgba(76,240,255,0)');
      eg.addColorStop(k / 6 + 0.08, k % 2 ? 'rgba(255,77,224,0.9)' : 'rgba(76,240,255,0.9)');
      eg.addColorStop(k / 6 + 0.16, 'rgba(255,255,255,0)');
    }
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = plasma * 0.85;
    c.beginPath(); c.arc(0, 0, R * 1.01, 0, TAU);
    c.strokeStyle = eg;
    c.lineWidth = (R - Rw) * 1.9;
    c.stroke();
    c.restore();
  }

  // Anneau métallique + néon dont la teinte tourne
  const ringR = (Rw + R) / 2;
  c.beginPath(); c.arc(0, 0, ringR, 0, TAU);
  c.strokeStyle = wheelGfx.ring;
  c.lineWidth = R - Rw;
  c.stroke();
  if (!state.reduced) {
    // Néon : trois passes concentriques — bien moins cher qu'un shadowBlur
    const hue = (185 + 120 * (0.5 + 0.5 * Math.sin(now / 1800))).toFixed(0);
    for (const [w, al] of (Q.low ? [[0.008, 0.7]] : [[0.05, 0.1], [0.024, 0.22], [0.008, 0.7]])) {
      c.beginPath(); c.arc(0, 0, R, 0, TAU);
      c.strokeStyle = `hsla(${hue},95%,62%,${al})`;
      c.lineWidth = Math.max(1, R * w);
      c.stroke();
    }
  }

  // Moyeu central « SPIN » qui pulse pour appeler le clic
  const hubPulse = state.spinning || state.reduced ? 1 : 1 + 0.045 * Math.sin(now / 380);
  const Rh = Math.max(Rw * 0.16, 26) * hubPulse;
  const hubG = c.createRadialGradient(-Rh * 0.3, -Rh * 0.3, Rh * 0.05, 0, 0, Rh);
  hubG.addColorStop(0, '#5a2d9a'); hubG.addColorStop(0.5, '#1c0f3d'); hubG.addColorStop(1, '#07091a');
  c.beginPath(); c.arc(0, 0, Rh, 0, TAU);
  c.fillStyle = hubG;
  c.fill();
  if (!state.reduced) {                              // lueur du moyeu : un anneau, pas un flou
    c.beginPath(); c.arc(0, 0, Rh * 1.06, 0, TAU);
    c.strokeStyle = 'rgba(76,240,255,' + (0.18 + 0.14 * Math.sin(now / 380)).toFixed(3) + ')';
    c.lineWidth = Rh * 0.16;
    c.stroke();
  }
  if (!state.reduced && !Q.low && c.createConicGradient) {   // vortex d'accrétion
    const vg = c.createConicGradient(now / 600 + state.rot * 2.2, 0, 0);
    vg.addColorStop(0, 'rgba(76,240,255,0)'); vg.addColorStop(0.12, 'rgba(76,240,255,0.6)');
    vg.addColorStop(0.3, 'rgba(0,0,0,0)'); vg.addColorStop(0.5, 'rgba(255,77,224,0.55)');
    vg.addColorStop(0.65, 'rgba(0,0,0,0)'); vg.addColorStop(0.85, 'rgba(123,44,255,0.6)');
    vg.addColorStop(1, 'rgba(76,240,255,0)');
    c.save();
    c.beginPath(); c.arc(0, 0, Rh * 0.9, 0, TAU); c.clip();
    c.globalCompositeOperation = 'screen';
    c.fillStyle = vg;
    c.fillRect(-Rh, -Rh, Rh * 2, Rh * 2);
    const core = c.createRadialGradient(0, 0, 0, 0, 0, Rh * 0.5);
    core.addColorStop(0, 'rgba(5,4,20,1)'); core.addColorStop(1, 'rgba(5,4,20,0)');
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = core;
    c.fillRect(-Rh, -Rh, Rh * 2, Rh * 2);
    c.restore();
  }
  c.beginPath(); c.arc(0, 0, Rh, 0, TAU);
  c.strokeStyle = 'rgba(120,230,255,0.75)';
  c.lineWidth = 2;
  c.stroke();
  c.beginPath(); c.arc(0, 0, Rh * 0.86, 0, TAU);
  c.strokeStyle = 'rgba(255,77,224,0.35)';
  c.lineWidth = 1;
  c.stroke();
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `800 ${Rh * 0.4}px system-ui, sans-serif`;
  c.fillText('SPIN', 0, Rh * 0.03);

  // Laser de visée : du pointeur au moyeu, s'intensifie avec le suspense
  if (state.suspense > 0.05 && !state.reduced) {
    const la = state.suspense * (0.5 + 0.5 * Math.sin(now / 40));
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = 'rgba(255,77,224,' + la.toFixed(3) + ')';
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(0, -R); c.lineTo(0, -Rh); c.stroke();
    c.restore();
  }

  // Pointeur en haut, avec claquement élastique (ressort pk/pv)
  c.save();
  c.translate(0, -R + 2);
  c.rotate(pk);
  const pw = Math.max(R * 0.075, 10), ph = Math.max(R * 0.15, 22);
  const pg = c.createLinearGradient(-pw, 0, pw, 0);
  pg.addColorStop(0, '#7c8cb5'); pg.addColorStop(0.5, '#f4f9ff'); pg.addColorStop(1, '#5d6a92');
  c.beginPath();
  c.moveTo(-pw, -ph * 0.55);
  c.lineTo(pw, -ph * 0.55);
  c.lineTo(0, ph * 0.75);
  c.closePath();
  c.fillStyle = pg;
  c.fill();
  c.strokeStyle = 'rgba(20,22,37,0.7)';
  c.lineWidth = 1.5;
  c.stroke();
  c.beginPath(); c.arc(0, -ph * 0.3, pw * 0.32, 0, TAU);
  c.fillStyle = '#4cf0ff';
  c.fill();
  c.restore();

  c.restore(); // fin translate/scale global
}

/* ============================ 7. Effets plein écran ======================= */

const fctx = els.fx.getContext('2d');
const confetti = [];   // gros morceaux qui volent
const sparks = [];     // étincelles du pointeur
const waves = [];      // ondes de choc circulaires
const rays = [];       // rayons lumineux depuis le gagnant

const CONFETTI_COLORS = ['#ff4de0', '#4cf0ff', '#ffd75e', '#7b2cff', '#ffffff', '#3ddc97', '#ff9a3d'];

function layoutFxCanvas(canvas, maxDpr) {
  const dpr = Math.min(devicePixelRatio || 1, maxDpr);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas._dpr = dpr;
}

/** Centre de la roue en coordonnées de page (pour viser les effets). */
function wheelCenter() {
  const r = els.wheel.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, R: r.width / 2 * 0.86 };
}

function burst(x, y, n, opts = {}) {
  const speed = opts.speed || 700;
  const spread = opts.spread ?? TAU;
  const base = opts.angle ?? -Math.PI / 2;
  for (let i = 0; i < n && confetti.length < 700; i++) {
    const a = base + (Math.random() - 0.5) * spread;
    const v = speed * (0.35 + Math.random() * 0.75);
    const shapes = opts.shapes || ['rect', 'rect', 'circle', 'tri', 'streamer', 'star'];
    confetti.push({
      x, y,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 14,
      size: 5 + Math.random() * 8,
      color: opts.colors ? opts.colors[i % opts.colors.length] : CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      shape: shapes[(Math.random() * shapes.length) | 0],
      ttl: 2.6 + Math.random() * 1.6, life: 0,
      wob: Math.random() * TAU,
    });
  }
}

function goldRain(n) {
  for (let i = 0; i < n && confetti.length < 700; i++) {
    confetti.push({
      x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.4,
      vx: (Math.random() - 0.5) * 60, vy: 60 + Math.random() * 140,
      rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8,
      size: 3 + Math.random() * 5,
      color: ['#ffd75e', '#ffedb0', '#f5b93c'][(Math.random() * 3) | 0],
      shape: 'circle', ttl: 4 + Math.random() * 2, life: 0,
      wob: Math.random() * TAU, gold: true,
    });
  }
}

function spawnSparks(n, vel) {
  const wc = wheelCenter();
  for (let i = 0; i < n && sparks.length < 200; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
    const v = 120 + Math.random() * 240 + Math.abs(vel) * 12;
    sparks.push({
      x: wc.x + (Math.random() - 0.5) * 8, y: wc.y - wc.R,
      vx: Math.cos(a) * v * -Math.sign(vel || 1), vy: Math.sin(a) * v,
      ttl: 0.3 + Math.random() * 0.35, life: 0,
      color: Math.random() < 0.6 ? '#4cf0ff' : '#ffffff',
    });
  }
}

function spawnWave(col = '255,255,255') {
  const wc = wheelCenter();
  waves.push({ x: wc.x, y: wc.y, r: wc.R * 0.3, vr: innerWidth * 1.1, alpha: 0.75, col });
}

function spawnRays(color, angle) {
  const wc = wheelCenter();
  rays.push({ x: wc.x, y: wc.y, base: angle, color, t0: performance.now(), len: Math.max(innerWidth, innerHeight) });
}

let fxPainted = false;
function drawFx(now, dt) {
  const hasWork = confetti.length || sparks.length || waves.length || rays.length;
  const extras = !state.reduced && !Q.low;
  if (!hasWork && !extras) {                       // rien à dessiner : on n'efface qu'une fois
    if (fxPainted) { fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, els.fx.width, els.fx.height); fxPainted = false; }
    return;
  }
  fxPainted = true;
  const dpr = els.fx._dpr || 1;
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.clearRect(0, 0, innerWidth, innerHeight);
  if (extras) { drawCage(fctx, now, true); drawTunnel(now, dt); }
  if (!hasWork) return;

  // Rayons lumineux (additifs) qui partent du segment gagnant
  fctx.globalCompositeOperation = 'lighter';
  for (let i = rays.length - 1; i >= 0; i--) {
    const ry = rays[i];
    const t = (now - ry.t0) / 1400;
    if (t >= 1) { rays.splice(i, 1); continue; }
    const alpha = 0.35 * (1 - t);
    fctx.save();
    fctx.translate(ry.x, ry.y);
    for (let k = 0; k < 9; k++) {
      const a = ry.base + (k - 4) * 0.09 + Math.sin(now / 300 + k) * 0.02;
      const g = fctx.createLinearGradient(0, 0, Math.cos(a) * ry.len, Math.sin(a) * ry.len);
      g.addColorStop(0, ry.color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      fctx.globalAlpha = alpha * (1 - Math.abs(k - 4) / 6);
      fctx.strokeStyle = g;
      fctx.lineWidth = 6 - Math.abs(k - 4);
      fctx.beginPath();
      fctx.moveTo(0, 0);
      fctx.lineTo(Math.cos(a) * ry.len, Math.sin(a) * ry.len);
      fctx.stroke();
    }
    fctx.restore();
  }
  fctx.globalAlpha = 1;

  // Étincelles
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life += dt;
    if (s.life >= s.ttl) { sparks.splice(i, 1); continue; }
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.vy += 500 * dt;
    fctx.globalAlpha = 1 - s.life / s.ttl;
    fctx.strokeStyle = s.color;
    fctx.lineWidth = 2;
    fctx.beginPath();
    fctx.moveTo(s.x, s.y);
    fctx.lineTo(s.x - s.vx * 0.02, s.y - s.vy * 0.02);
    fctx.stroke();
  }
  fctx.globalAlpha = 1;
  fctx.globalCompositeOperation = 'source-over';

  // Ondes de choc
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.r += w.vr * dt;
    w.alpha -= dt * 1.1;
    if (w.alpha <= 0) { waves.splice(i, 1); continue; }
    fctx.strokeStyle = `rgba(${w.col},${w.alpha})`;
    fctx.lineWidth = 5 * w.alpha + 1;
    fctx.beginPath();
    fctx.arc(w.x, w.y, w.r, 0, TAU);
    fctx.stroke();
  }

  // Confettis : gravité, frottement, flottement, rotation
  for (let i = confetti.length - 1; i >= 0; i--) {
    const p = confetti[i];
    p.life += dt;
    if (p.life >= p.ttl || p.y > innerHeight + 40) { confetti.splice(i, 1); continue; }
    p.vy += 850 * dt;
    p.vx *= 0.99; p.vy *= 0.992;
    p.x += p.vx * dt + Math.sin(now / 250 + p.wob) * 40 * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    const fade = p.life > p.ttl - 0.5 ? (p.ttl - p.life) / 0.5 : 1;
    fctx.globalAlpha = fade;
    fctx.fillStyle = p.color;
    fctx.save();
    fctx.translate(p.x, p.y);
    fctx.rotate(p.rot);
    // Effet 3D : la largeur oscille comme un papier qui tournoie
    const flip = Math.sin(now / 120 + p.wob * 5);
    if (p.shape === 'circle') {
      fctx.beginPath(); fctx.arc(0, 0, p.size * 0.5, 0, TAU); fctx.fill();
    } else if (p.shape === 'tri') {
      fctx.beginPath();
      fctx.moveTo(0, -p.size * 0.6);
      fctx.lineTo(p.size * 0.55, p.size * 0.4);
      fctx.lineTo(-p.size * 0.55, p.size * 0.4);
      fctx.closePath(); fctx.fill();
    } else if (p.shape === 'star') {
      fctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const rr = k % 2 ? p.size * 0.28 : p.size * 0.8;
        const ang = k * Math.PI / 4;
        fctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
      }
      fctx.closePath(); fctx.fill();
    } else if (p.shape === 'streamer') {
      fctx.fillRect(-p.size * 0.15, -p.size * 1.4, p.size * 0.3 * Math.abs(flip) + 0.5, p.size * 2.8);
    } else {
      fctx.fillRect(-p.size * 0.5, -p.size * 0.35 * Math.abs(flip) - 0.5, p.size, p.size * 0.7 * Math.abs(flip) + 1);
    }
    fctx.restore();
  }
  fctx.globalAlpha = 1;
}

/* ============================ 8. Tirage & spin ============================ */

function startSpin() {
  if (state.spinning || !state.segments.length || !els.result.hidden) return;
  ensureAudio();
  state.winner = null;

  const wIdx = pickWeighted();
  const arc = arcs[wIdx];
  // Offset aléatoire à l'intérieur du segment (jamais pile au centre ni au bord)
  const margin = arc.span * 0.12;
  const target = arc.a0 + margin + randFloat() * (arc.span - 2 * margin);
  // Rotation finale telle que le pointeur tombe sur `target`
  let delta = norm(POINTER_ANGLE - target - norm(state.rot));
  const turns = state.reduced ? 2 : 5 + Math.floor(randFloat() * 3);
  delta += turns * TAU;

  spin = {
    t0: performance.now(),
    rot0: state.rot,
    delta,
    TA: state.reduced ? 0 : 0.45,      // anticipation (micro-recul)
    TM: state.reduced ? 1.3 : 5.3,     // décélération easeOutQuint
    recoil: state.reduced ? 0 : 0.3,
    winner: wIdx,
  };
  state.spinning = true;
  lockUI(true);
  tunnelStart(performance.now() + (state.reduced ? 0 : 450));   // après le micro-recul
  sndWhoosh();
  vibrate(15);
  announce('La roue tourne…');
}

function updateSpin(now, dt) {
  if (!spin) {
    // Ressort du pointeur même hors spin (retour à l'équilibre)
    pv += (-260 * pk - 14 * pv) * dt;
    pk += pv * dt;
    if (state.suspense > 0) state.suspense = Math.max(0, state.suspense - dt * 2);
    els.dim.style.opacity = state.suspense * 0.45;
    return;
  }

  const t = (now - spin.t0) / 1000;
  const prevRot = state.rot;
  const prevIdx = indexAt(prevRot);
  let done = false;

  if (t < spin.TA) {
    state.rot = spin.rot0 - spin.recoil * easeInOutSine(t / spin.TA);
  } else {
    const x = clamp((t - spin.TA) / spin.TM, 0, 1);
    state.rot = spin.rot0 - spin.recoil + (spin.delta + spin.recoil) * easeOutQuint(x);
    done = x >= 1;
  }
  state.vel = dt > 0 ? (state.rot - prevRot) / dt : 0;

  // Suspense : les tout derniers degrés
  const remaining = spin.rot0 + spin.delta - state.rot;
  const f = state.reduced ? 0 : clamp(1 - remaining / 0.9, 0, 1);
  if (f > 0 && state.suspense === 0) { riserStart(); sndLock(false); }
  state.suspense = f;
  riserUpdate(f);
  els.dim.style.opacity = f * 0.45;

  // Tick à chaque passage de segment sous le pointeur
  const idx = indexAt(state.rot);
  if (idx !== prevIdx) {
    sndTick(state.vel);
    pv += clamp(Math.abs(state.vel) * 1.6, 3, 16) * -Math.sign(state.vel || 1);
    if (!state.reduced) spawnSparks(Math.abs(state.vel) > 8 ? 4 : 2, state.vel);
    if (Math.abs(state.vel) < 3) vibrate(8);   // ticks lents = suspense = plus fort
  }

  // Ressort du pointeur
  pv += (-260 * pk - 14 * pv) * dt;
  pk += pv * dt;

  if (done) finishSpin(now);
}

function finishSpin(now) {
  const winner = spin.winner;
  state.rot = norm(spin.rot0 + spin.delta);
  spin = null;
  state.spinning = false;
  state.vel = 0;
  state.suspense = 0;
  els.dim.style.opacity = 0;
  riserStop();
  lockUI(false);

  state.winner = winner;
  state.winTime = now;
  const seg = state.segments[winner];
  announce(`Résultat : ${seg.label}`);

  sndVictory();
  sndLock(true);
  vibrate([60, 40, 60, 40, 140]);

  if (!state.reduced) {
    // La fanfare : shake, flash, ondes, rayons, vagues de confettis
    els.stage.classList.remove('shake');
    void els.stage.offsetWidth;               // relance l'animation CSS
    els.stage.classList.add('shake');
    els.flash.classList.remove('active');
    void els.flash.offsetWidth;
    els.flash.classList.add('active');
    const { r: wr, g: wg, b: wb } = hexToRgb(seg.color);
    spawnWave();
    setTimeout(() => spawnWave(wr + ',' + wg + ',' + wb), 180);
    setTimeout(() => spawnWave('76,240,255'), 360);

    const screenAngle = norm(arcs[winner].mid + state.rot);
    spawnRays(seg.color, screenAngle);
    // Supernova d'étoiles à la couleur du segment
    burst(wheelCenter().x, wheelCenter().y, 60, { speed: 600, colors: [seg.color, '#ffffff', '#ffd75e'], shapes: ['star', 'star', 'circle'] });

    const wc = wheelCenter();
    const px = wc.x + Math.cos(screenAngle) * wc.R * 0.8;
    const py = wc.y + Math.sin(screenAngle) * wc.R * 0.8;
    burst(px, py, 120, { angle: screenAngle, spread: 2.2, speed: 850 });
    setTimeout(() => {
      burst(innerWidth * 0.08, innerHeight, 70, { angle: -Math.PI / 2.6, spread: 0.9, speed: 1000 });
      burst(innerWidth * 0.92, innerHeight, 70, { angle: -Math.PI + Math.PI / 2.6, spread: 0.9, speed: 1000 });
    }, 280);
    setTimeout(() => goldRain(110), 650);
  }

  setTimeout(showResult, state.reduced ? 150 : 700);
}

function showResult() {
  if (state.winner === null) return;
  const seg = state.segments[state.winner];
  els.resultLabel.textContent = seg.label || '—';
  document.querySelector('.result-card').style.setProperty('--win-color', seg.color);
  els.result.hidden = false;
  els.btnAgain.focus();
}

function hideResult() {
  els.result.hidden = true;
}

function lockUI(locked) {
  document.body.classList.toggle('spinning', locked);
  els.editorFields.disabled = locked;
  els.btnSpin.disabled = locked || !state.segments.length;
}

/* ============================ 9. Éditeur ================================== */

function segmentsChanged({ structural = false, rerender = true } = {}) {
  state.winner = null;
  cacheDirty = true;
  computeArcs();
  if (structural) { saveSegments(); } else { saveSoon(); }
  if (rerender) renderEditor();
  updatePercents();
  els.segCount.textContent = state.segments.length;
  els.btnSpin.disabled = state.spinning || !state.segments.length;
}

function renderEditor() {
  els.segList.textContent = '';
  if (!state.segments.length) {
    const empty = document.createElement('div');
    empty.className = 'seg-empty';
    empty.textContent = 'Aucun segment. Cliquez sur « ＋ Ajouter » ou utilisez la saisie rapide.';
    els.segList.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  state.segments.forEach((seg, i) => frag.appendChild(buildRow(seg, i)));
  els.segList.appendChild(frag);
}

function buildRow(seg) {
  const row = document.createElement('div');
  row.className = 'seg-row';
  row.dataset.id = seg.id;
  row.innerHTML = `
    <input type="color" class="seg-color" value="${seg.color}" aria-label="Couleur du segment">
    <input type="text" class="seg-label" value="" aria-label="Libellé du segment" placeholder="Libellé…">
    <div class="seg-weight">
      <input type="range" class="seg-wrange" min="0.5" max="10" step="0.5" aria-label="Poids (curseur)">
      <input type="number" class="seg-wnum" min="0.1" step="0.5" aria-label="Poids (valeur)">
      <span class="seg-pct">—</span>
    </div>
    <div class="row-btns">
      <button class="mini up" aria-label="Monter" title="Monter">▲</button>
      <button class="mini down" aria-label="Descendre" title="Descendre">▼</button>
      <button class="mini dup" aria-label="Dupliquer" title="Dupliquer">⧉</button>
      <button class="mini del" aria-label="Supprimer" title="Supprimer">✕</button>
    </div>`;
  // Valeurs injectées via .value pour éviter tout échappement HTML
  row.querySelector('.seg-label').value = seg.label;
  row.querySelector('.seg-wrange').value = clamp(seg.weight, 0.5, 10);
  row.querySelector('.seg-wnum').value = seg.weight;
  return row;
}

function updatePercents() {
  const total = totalWeight();
  const rows = els.segList.querySelectorAll('.seg-row');
  rows.forEach((row) => {
    const seg = state.segments.find((s) => s.id === row.dataset.id);
    if (!seg) return;
    row.querySelector('.seg-pct').textContent = total > 0 ? (seg.weight / total * 100).toFixed(1) + ' %' : '—';
  });
}

function segFromRow(row) {
  return state.segments.find((s) => s.id === row.dataset.id);
}

function addSegment(label, color) {
  const n = state.segments.length;
  state.segments.push({
    id: uid(),
    label: label ?? `Option ${n + 1}`,
    color: color ?? autoColor(n),
    weight: 1,
  });
  sndUi('add');
  segmentsChanged({ structural: true });
  // Amener le nouveau segment en vue
  const rows = els.segList.querySelectorAll('.seg-row');
  rows[rows.length - 1]?.scrollIntoView({ block: 'nearest', behavior: state.reduced ? 'auto' : 'smooth' });
}

function removeSegment(row) {
  const seg = segFromRow(row);
  if (!seg) return;
  sndUi('del');
  row.classList.add('removing');
  row.addEventListener('animationend', () => {
    state.segments = state.segments.filter((s) => s.id !== seg.id);
    segmentsChanged({ structural: true });
  }, { once: true });
}

function bindEditor() {
  // Modifications de champs (délégation)
  els.segList.addEventListener('input', (e) => {
    const row = e.target.closest('.seg-row');
    if (!row) return;
    const seg = segFromRow(row);
    if (!seg) return;
    if (e.target.classList.contains('seg-label')) {
      seg.label = e.target.value;
    } else if (e.target.classList.contains('seg-color')) {
      seg.color = e.target.value;
    } else if (e.target.classList.contains('seg-wrange')) {
      seg.weight = parseFloat(e.target.value);
      row.querySelector('.seg-wnum').value = seg.weight;
    } else if (e.target.classList.contains('seg-wnum')) {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v > 0) {
        seg.weight = v;
        row.querySelector('.seg-wrange').value = clamp(v, 0.5, 10);
      } else {
        return; // valeur invalide : on n'applique rien
      }
    } else {
      return;
    }
    segmentsChanged({ rerender: false });
  });

  // Boutons de ligne (délégation)
  els.segList.addEventListener('click', (e) => {
    const btn = e.target.closest('button.mini');
    const row = e.target.closest('.seg-row');
    if (!btn || !row) return;
    const seg = segFromRow(row);
    if (!seg) return;
    const i = state.segments.indexOf(seg);
    if (btn.classList.contains('up') && i > 0) {
      [state.segments[i - 1], state.segments[i]] = [state.segments[i], state.segments[i - 1]];
      segmentsChanged({ structural: true });
    } else if (btn.classList.contains('down') && i < state.segments.length - 1) {
      [state.segments[i + 1], state.segments[i]] = [state.segments[i], state.segments[i + 1]];
      segmentsChanged({ structural: true });
    } else if (btn.classList.contains('dup')) {
      state.segments.splice(i + 1, 0, { ...seg, id: uid() });
      sndUi('add');
      segmentsChanged({ structural: true });
    } else if (btn.classList.contains('del')) {
      removeSegment(row);
    }
  });

  els.btnAdd.addEventListener('click', () => addSegment());

  // Saisie rapide en masse
  els.btnBulk.addEventListener('click', () => {
    const lines = els.bulk.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast('Aucune ligne à importer.', true); return; }
    const base = state.segments.length;
    lines.forEach((label, i) => {
      state.segments.push({ id: uid(), label, color: autoColor(base + i), weight: 1 });
    });
    els.bulk.value = '';
    sndUi('add');
    segmentsChanged({ structural: true });
    toast(`${lines.length} segment${lines.length > 1 ? 's' : ''} créé${lines.length > 1 ? 's' : ''} ✓`);
  });

  // Mélanger (Fisher-Yates, aléa crypto)
  els.btnShuffle.addEventListener('click', () => {
    for (let i = state.segments.length - 1; i > 0; i--) {
      const j = Math.floor(randFloat() * (i + 1));
      [state.segments[i], state.segments[j]] = [state.segments[j], state.segments[i]];
    }
    sndUi('add');
    segmentsChanged({ structural: true });
  });

  // Tout supprimer (confirmation)
  els.btnClear.addEventListener('click', () => {
    if (!state.segments.length) return;
    if (!confirm(`Supprimer les ${state.segments.length} segments ?`)) return;
    state.segments = [];
    sndUi('del');
    segmentsChanged({ structural: true });
  });
}

/* ============================ 10. Export / Import ========================= */

function exportJson() {
  const data = {
    app: 'weelspin', version: 1,
    segments: state.segments.map(({ id, label, color, weight }) => ({ id, label, color, weight })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `weelspin-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Configuration exportée ✓');
}

function importFile(file) {
  if (state.spinning) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      toast('Import impossible : le fichier n’est pas du JSON valide.', true);
      return;
    }
    const res = validateData(data);
    if (!res.ok) {
      toast('Import impossible : ' + res.error, true);
      return;
    }
    const n = res.segments.length;
    if (!confirm(`Remplacer la configuration actuelle par « ${file.name} » (${n} segment${n > 1 ? 's' : ''}) ?`)) return;
    state.segments = res.segments;
    sndUi('add');
    segmentsChanged({ structural: true });
    toast(`Import réussi : ${n} segment${n > 1 ? 's' : ''} ✓`);
  };
  reader.onerror = () => toast('Import impossible : lecture du fichier échouée.', true);
  reader.readAsText(file);
}

function bindImportExport() {
  els.btnExport.addEventListener('click', exportJson);
  els.btnImport.addEventListener('click', () => els.fileImport.click());
  els.fileImport.addEventListener('change', () => {
    const f = els.fileImport.files[0];
    if (f) importFile(f);
    els.fileImport.value = '';
  });

  // Glisser-déposer d'un .json n'importe où sur la page
  let dragDepth = 0;
  addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    els.dropOverlay.classList.add('active');
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; els.dropOverlay.classList.remove('active'); }
  });
  addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.classList.remove('active');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.json$/i.test(f.name) && f.type !== 'application/json') {
      toast('Seuls les fichiers .json sont acceptés.', true);
      return;
    }
    importFile(f);
  });
}

/* ============================ 11. Interactions & démarrage ================ */

function bindGlobal() {
  // Lancer : roue, moyeu, bouton, Espace
  els.wheel.addEventListener('click', startSpin);
  els.btnSpin.addEventListener('click', startSpin);
  addEventListener('keydown', (e) => {
    if (e.key === ' ' && !e.repeat) {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'SUMMARY') return;
      e.preventDefault();
      startSpin();
    }
    if (e.key === 'Escape' && document.body.classList.contains('presentation')) {
      setPresentation(false);
    }
  });

  // Résultat
  els.btnAgain.addEventListener('click', () => { hideResult(); startSpin(); });
  els.btnClose.addEventListener('click', hideResult);
  els.result.addEventListener('click', (e) => { if (e.target === els.result) hideResult(); });

  // Mute
  els.btnMute.addEventListener('click', () => { ensureAudio(); setMuted(!state.muted); });

  // Éditeur : afficher / masquer (topbar, bouton fermer du panneau, fond cliquable)
  const setEditorOpen = (open) => {
    document.body.classList.toggle('editor-open', open);
    els.btnEditor.setAttribute('aria-expanded', String(open));
  };
  els.btnEditor.addEventListener('click', () => setEditorOpen(!document.body.classList.contains('editor-open')));
  $('btn-editor-close').addEventListener('click', () => setEditorOpen(false));
  $('editor-scrim').addEventListener('click', () => setEditorOpen(false));

  // Mode présentation / plein écran
  els.btnPresent.addEventListener('click', () => setPresentation(true));
  els.btnExitPresent.addEventListener('click', () => setPresentation(false));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('presentation')) {
      setPresentation(false, /* skipExitFs */ true);
    }
  });

  // AudioContext : créé au premier geste utilisateur (politique d'autoplay)
  const primeAudio = () => ensureAudio();
  addEventListener('pointerdown', primeAudio, { once: true });
  addEventListener('keydown', primeAudio, { once: true });

  // Ripple sur tous les boutons
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn || state.reduced) return;
    const r = btn.getBoundingClientRect();
    const span = document.createElement('span');
    span.className = 'ripple';
    const size = Math.max(r.width, r.height) * 0.9;
    span.style.width = span.style.height = size + 'px';
    span.style.left = (e.clientX - r.left - size / 2) + 'px';
    span.style.top = (e.clientY - r.top - size / 2) + 'px';
    btn.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
  });

  // Redimensionnements
  new ResizeObserver(() => layoutWheel()).observe(els.wheelWrap);
  addEventListener('resize', () => {
    layoutFxCanvas(els.fx, 1.5);
    layoutFxCanvas(els.bg, 1);
    initMotes();
    buildPlanet();
  });

  // Parallaxe & lueur qui suivent la souris
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || state.reduced) return;
    const root = document.documentElement.style;
    root.setProperty('--px', ((e.clientX / innerWidth) - 0.5) * 2);
    root.setProperty('--py', ((e.clientY / innerHeight) - 0.5) * 2);
    root.setProperty('--mx', e.clientX + 'px');
    root.setProperty('--my', e.clientY + 'px');
  }, { passive: true });

  // Préférence "moins d'animations" changée à chaud
  reducedQuery.addEventListener?.('change', (e) => {
    state.reduced = e.matches;
    initMotes();
  });
}

function setPresentation(on, skipExitFs = false) {
  document.body.classList.toggle('presentation', on);
  els.btnExitPresent.hidden = !on;
  if (on) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (!skipExitFs && document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}

/* Boucle principale : une seule rAF pour tout (fond, roue, effets) */
let lastFrame = performance.now();
let skipFrame = false;
let dtBg = 0;
function frame(now) {
  const dt = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;
  monitorPerf(now);
  updateSpin(now, dt);              // physique, ticks et sons : toujours à pleine cadence
  // En mode allégé, seul le décor passe à 30 fps : la roue, elle, reste fluide
  dtBg += dt;
  skipFrame = Q.low && !skipFrame;
  if (!skipFrame) { drawBg(now, dtBg); dtBg = 0; }
  drawWheel(now);
  drawFx(now, dt);
  requestAnimationFrame(frame);
}

function init() {
  try { state.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* ignoré */ }
  setMuted(state.muted);

  loadSegments();
  computeArcs();
  renderEditor();
  updatePercents();
  els.segCount.textContent = state.segments.length;
  els.btnSpin.disabled = !state.segments.length;

  // Éditeur ouvert par défaut sur desktop, fermé sur mobile
  if (innerWidth >= 900) document.body.classList.add('editor-open');
  els.btnEditor.setAttribute('aria-expanded', String(document.body.classList.contains('editor-open')));

  layoutFxCanvas(els.fx, 1.5);
  layoutFxCanvas(els.bg, 1);
  initMotes();
  buildPlanet();
  layoutWheel();

  bindEditor();
  bindImportExport();
  bindGlobal();

  requestAnimationFrame(frame);

  // Séquence de démarrage : la roue se matérialise
  if (!state.reduced) {
    document.body.classList.add('boot');
    setTimeout(() => { document.body.classList.remove('boot'); layoutWheel(); }, 1600);
  }
}

init();
