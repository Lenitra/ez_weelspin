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
  stage: $('stage'), halo: $('halo'), rays: $('rays'), dim: $('dim'), flash: $('flash'),
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

const bgCtx = els.bg.getContext('2d');
let stars = [];          // trois profondeurs (z) pour la parallaxe
let shooting = [];       // étoiles filantes
let nextShooting = 0;
let planet = null;       // { canvas, cx, cy, r, size }

/** Planète à anneaux rendue une fois dans un canvas offscreen. */
function buildPlanet() {
  const r = Math.max(70, Math.min(innerWidth, innerHeight) * 0.17);
  planet = { r, cx: innerWidth * 0.06 + r * 0.3, cy: innerHeight * 0.1 };
  initAsteroids();
}

function drawPlanet(now) {
  if (!planet) return;
  const { r, cx, cy } = planet;
  // Sphère fil de fer + anneaux, en vraie rotation 3D
  wireSphere(bgCtx, cx, cy, r, 0.42, now / 14000 * TAU, {
    col: '170,140,255', lats: 6, lons: 12, rings: [1.45, 1.6, 1.85],
    aBack: 0.1, aFront: 0.55, width: 1.2 * wireScale(),
  });
  // Cœur lumineux
  const cg = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
  cg.addColorStop(0, 'rgba(123,44,255,0.35)'); cg.addColorStop(1, 'rgba(123,44,255,0)');
  bgCtx.fillStyle = cg; bgCtx.beginPath(); bgCtx.arc(cx, cy, r, 0, TAU); bgCtx.fill();
  // Halo atmosphérique qui respire
  const pulse = 0.5 + 0.5 * Math.sin(now / 2600);
  const hg = bgCtx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.9);
  hg.addColorStop(0, 'rgba(110,80,255,' + (0.16 + 0.1 * pulse) + ')');
  hg.addColorStop(1, 'rgba(110,80,255,0)');
  bgCtx.fillStyle = hg;
  bgCtx.beginPath(); bgCtx.arc(cx, cy, r * 1.9, 0, TAU); bgCtx.fill();
  // Petite lune en orbite (passe derrière puis devant)
  const a = now / 9000 * TAU;
  const mx = cx + Math.cos(a) * r * 1.75, my = cy + Math.sin(a) * r * 0.5 + r * 0.15;
  if (Math.sin(a) > 0) {
    bgCtx.beginPath(); bgCtx.arc(mx, my, r * 0.09, 0, TAU);
    bgCtx.fillStyle = '#dfe8ff'; bgCtx.shadowColor = '#bcd3ff'; bgCtx.shadowBlur = 12; bgCtx.fill(); bgCtx.shadowBlur = 0;
  }
}

function initMotes() {
  stars = [];
  if (state.reduced) return;
  const n = Math.min(320, Math.round(innerWidth * innerHeight / 6500));
  for (let i = 0; i < n; i++) {
    const z = 0.25 + Math.random() * 0.75;          // profondeur : petit/lent -> gros/rapide
    stars.push({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight, z,
      r: 0.4 + z * 1.6,
      ph: Math.random() * TAU, tw: 0.6 + Math.random() * 2.2,
      hue: Math.random() < 0.15 ? 300 : Math.random() < 0.5 ? 195 : 45, // magenta / cyan / or
      sat: Math.random() < 0.6 ? 0 : 70,
    });
  }
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
  const dpr = Math.min(devicePixelRatio || 1, 2);
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgCtx.clearRect(0, 0, innerWidth, innerHeight);
  if (state.reduced) return;

  drawGrid(now, dt);

  // Warp : les étoiles s'étirent depuis le centre de la roue selon sa vitesse
  const warp = clamp(Math.abs(state.vel) / 30, 0, 1);
  const wc = warp > 0.02 ? wheelCenter() : null;

  for (const s of stars) {
    s.y += s.z * 3 * dt;                                     // dérive lente vers le bas
    if (s.y > innerHeight + 4) { s.y = -4; s.x = Math.random() * innerWidth; }
    const twinkle = 0.55 + 0.45 * Math.sin(now / 1000 * s.tw + s.ph);
    const a = clamp((0.25 + 0.6 * s.z) * twinkle + warp * 0.3, 0, 1);
    bgCtx.fillStyle = bgCtx.strokeStyle = 'hsla(' + s.hue + ',' + s.sat + '%,' + (85 + s.z * 10) + '%,' + a + ')';
    if (wc) {
      const dx = s.x - wc.x, dy = s.y - wc.y;
      const len = warp * warp * s.z * 0.35;
      bgCtx.lineWidth = s.r * 1.2;
      bgCtx.beginPath();
      bgCtx.moveTo(s.x, s.y);
      bgCtx.lineTo(s.x + dx * len, s.y + dy * len);
      bgCtx.stroke();
    } else {
      bgCtx.beginPath();
      bgCtx.arc(s.x, s.y, s.r, 0, TAU);
      bgCtx.fill();
      if (s.z > 0.85) {                                      // éclat en croix sur les grosses
        bgCtx.globalAlpha = a * 0.5;
        bgCtx.fillRect(s.x - s.r * 4, s.y - 0.4, s.r * 8, 0.8);
        bgCtx.fillRect(s.x - 0.4, s.y - s.r * 4, 0.8, s.r * 8);
        bgCtx.globalAlpha = 1;
      }
    }
  }

  drawPlanet(now);
  drawAsteroids(now, dt);
  drawCage(bgCtx, now, false);

  // Étoiles filantes, de temps en temps
  if (now > nextShooting) { spawnShooting(); nextShooting = now + 3500 + Math.random() * 6000; }
  for (let i = shooting.length - 1; i >= 0; i--) {
    const m = shooting[i];
    m.life += dt;
    if (m.life > m.ttl) { shooting.splice(i, 1); continue; }
    m.x += m.vx * dt; m.y += m.vy * dt;
    const tail = 0.12;
    const fade = Math.sin(Math.PI * m.life / m.ttl);
    const g = bgCtx.createLinearGradient(m.x, m.y, m.x - m.vx * tail, m.y - m.vy * tail);
    g.addColorStop(0, 'rgba(255,255,255,' + 0.95 * fade + ')');
    g.addColorStop(1, 'rgba(120,220,255,0)');
    bgCtx.strokeStyle = g;
    bgCtx.lineWidth = 2;
    bgCtx.beginPath();
    bgCtx.moveTo(m.x, m.y);
    bgCtx.lineTo(m.x - m.vx * tail, m.y - m.vy * tail);
    bgCtx.stroke();
  }
}

/* ============================ 5b. Wireframe 3D ========================== */
/* Petit moteur fil de fer : rotation 3D, projection perspective, alpha selon
   la profondeur. Tout est dessiné en lignes fines lumineuses (hologramme). */

/** Facteur d'échelle des traits/objets fil de fer selon la taille d'écran (TV 4K). */
const wireScale = () => clamp(Math.min(innerWidth, innerHeight) / 800, 1, 2.6);

function rot3(p, ax, ay, az) {
  let [x, y, z] = p;
  let c = Math.cos(ax), s = Math.sin(ax);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(ay); s = Math.sin(ay);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(az); s = Math.sin(az);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

/** Projette un point 3D (z vers le spectateur) : retourne [sx, sy, depth -1..1]. */
function project(p, cx, cy, f, radius) {
  const s = f / (f - p[2]);
  return [cx + p[0] * s, cy + p[1] * s, p[2] / radius];
}

/** Trace une polyligne 3D en découpant par profondeur (avant / arrière). */
function wirePath(ctx, pts, cx, cy, f, radius, col, aBack, aFront, onlyFront, onlyBack, width = 1) {
  let prev = project(pts[0], cx, cy, f, radius);
  ctx.lineWidth = width;
  for (let i = 1; i < pts.length; i++) {
    const cur = project(pts[i], cx, cy, f, radius);
    const d = (prev[2] + cur[2]) / 2;
    const front = d > 0;
    if ((onlyFront && !front) || (onlyBack && front)) { prev = cur; continue; }
    const a = front ? aFront * (0.55 + 0.45 * d) : aBack * (0.35 + 0.65 * (1 + d));
    ctx.strokeStyle = 'rgba(' + col + ',' + a.toFixed(3) + ')';
    ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
    prev = cur;
  }
}

/** Cercle 3D dans un plan donné (lat = parallèle, lon = méridien). */
function circle3(r, n, kind, k) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n * TAU;
    if (kind === 'lat') pts.push([Math.cos(t) * r * Math.cos(k), Math.sin(k) * r, Math.sin(t) * r * Math.cos(k)]);
    else pts.push(rot3([Math.cos(t) * r, Math.sin(t) * r, 0], 0, k, 0));
  }
  return pts;
}

/** Sphère fil de fer (parallèles + méridiens), éventuellement avec anneaux. */
function wireSphere(ctx, cx, cy, r, ax, ay, opts) {
  const { col = '76,240,255', aBack = 0.12, aFront = 0.45, lats = 5, lons = 10, rings = [], onlyFront = false, onlyBack = false, width = 1 } = opts;
  const f = r * 4.5;
  const paths = [];
  for (let i = 1; i <= lats; i++) paths.push(circle3(r, 40, 'lat', -Math.PI / 2 + i * Math.PI / (lats + 1)));
  for (let i = 0; i < lons; i++) paths.push(circle3(r, 40, 'lon', i * Math.PI / lons));
  for (const rr of rings) paths.push(circle3(r * rr, 64, 'lat', 0));
  for (const path of paths) {
    const pts = path.map((p) => rot3(p, ax, ay, 0));
    wirePath(ctx, pts, cx, cy, f, r, col, aBack, aFront, onlyFront, onlyBack, width);
  }
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
  if (state.reduced) return;
  const n = innerWidth < 900 ? 3 : 5;
  for (let i = 0; i < n; i++) {
    asteroids.push({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: (14 + Math.random() * 26) * wireScale(),
      vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 8,
      ax: Math.random() * TAU, ay: Math.random() * TAU,
      sx: (Math.random() - 0.5) * 0.6, sy: (Math.random() - 0.5) * 0.8,
      col: Math.random() < 0.5 ? '76,240,255' : '255,77,224',
    });
  }
}

function drawAsteroids(now, dt) {
  for (const a of asteroids) {
    a.x += a.vx * dt; a.y += a.vy * dt;
    if (a.x < -60) a.x = innerWidth + 60; if (a.x > innerWidth + 60) a.x = -60;
    if (a.y < -60) a.y = innerHeight + 60; if (a.y > innerHeight + 60) a.y = -60;
    const ax = a.ax + now / 1000 * a.sx, ay = a.ay + now / 1000 * a.sy;
    const pts = ICO_V.map((p) => rot3([p[0] * a.r, p[1] * a.r, p[2] * a.r], ax, ay, 0));
    const f = a.r * 5;
    bgCtx.lineWidth = wireScale();
    for (const [i, j] of ICO_E) {
      const p = project(pts[i], a.x, a.y, f, a.r), q = project(pts[j], a.x, a.y, f, a.r);
      const d = (p[2] + q[2]) / 2;
      bgCtx.strokeStyle = 'rgba(' + a.col + ',' + (0.18 + 0.32 * (d + 1) / 2).toFixed(3) + ')';
      bgCtx.beginPath(); bgCtx.moveTo(p[0], p[1]); bgCtx.lineTo(q[0], q[1]); bgCtx.stroke();
    }
    // Sommets lumineux
    bgCtx.fillStyle = 'rgba(' + a.col + ',0.9)';
    for (const p of pts) { if (p[2] > 0) { const s = project(p, a.x, a.y, f, a.r); bgCtx.fillRect(s[0] - 1, s[1] - 1, 2, 2); } }
  }
}

/** Sol en grille perspective (synthwave) qui défile ; accélère avec la roue. */
let gridPhase = 0;
function drawGrid(now, dt) {
  const W = innerWidth, H = innerHeight;
  const hy = H * 0.58;                                  // horizon
  const speed = 0.35 + clamp(Math.abs(state.vel) / 30, 0, 1) * 3;
  gridPhase = (gridPhase + dt * speed) % 1;
  bgCtx.save();
  bgCtx.beginPath(); bgCtx.rect(0, hy, W, H - hy); bgCtx.clip();
  bgCtx.lineWidth = wireScale();
  // Lignes horizontales : profondeur t (0 = horizon, 1 = bord bas), espacement en t^3
  const rows = 14;
  for (let i = 0; i < rows; i++) {
    const t = Math.pow((i + gridPhase) / rows, 3);
    const y = hy + (H - hy) * t;
    bgCtx.strokeStyle = 'rgba(76,240,255,' + (0.05 + 0.3 * t).toFixed(3) + ')';
    bgCtx.beginPath(); bgCtx.moveTo(0, y); bgCtx.lineTo(W, y); bgCtx.stroke();
  }
  // Lignes verticales convergeant vers le point de fuite
  const cols = 18;
  const vx = W / 2 + (parseFloat(document.documentElement.style.getPropertyValue('--px')) || 0) * -W * 0.05;
  for (let i = -cols; i <= cols; i++) {
    const xb = W / 2 + i * (W * 1.6 / cols);
    const g = bgCtx.createLinearGradient(vx, hy, xb, H);
    g.addColorStop(0, 'rgba(255,77,224,0)');
    g.addColorStop(1, 'rgba(255,77,224,0.28)');
    bgCtx.strokeStyle = g;
    bgCtx.beginPath(); bgCtx.moveTo(vx, hy); bgCtx.lineTo(xb, H); bgCtx.stroke();
  }
  // Lueur d'horizon
  const hg = bgCtx.createLinearGradient(0, hy, 0, hy + H * 0.25);
  hg.addColorStop(0, 'rgba(76,240,255,0.16)'); hg.addColorStop(1, 'rgba(76,240,255,0)');
  bgCtx.fillStyle = hg; bgCtx.fillRect(0, hy, W, H * 0.25);
  bgCtx.restore();
}

/** Cage holographique autour de la roue : sphère fil de fer en rotation.
    Moitié arrière sur le fond, moitié avant (discrète) sur le canvas d'effets. */
function drawCage(ctx, now, front) {
  if (!cssSize || !state.segments.length) return;
  const wc = wheelCenter();
  const r = wc.R * 1.24;
  const ay = now / 9000 * TAU + state.rot * 0.2;
  const ax = 0.35 + Math.sin(now / 6000) * 0.15;
  wireSphere(ctx, wc.x, wc.y, r, ax, ay, {
    col: '120,220,255', lats: 4, lons: 8, width: wireScale(),
    aBack: 0.28, aFront: 0.13,
    onlyFront: front, onlyBack: !front,
  });
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

function layoutWheel() {
  const rect = els.wheelWrap.getBoundingClientRect();
  const s = Math.floor(Math.min(rect.width, rect.height));
  if (s < 40) return;
  cssSize = s;
  const dpr = Math.min(devicePixelRatio || 1, 3);
  els.wheel.style.width = s + 'px';
  els.wheel.style.height = s + 'px';
  els.wheel.width = Math.round(s * dpr);
  els.wheel.height = Math.round(s * dpr);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  R = s / 2 * 0.86;      // marge pour le pointeur et la lueur de l'anneau
  Rw = R * 0.94;
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
  const dpr = Math.min(devicePixelRatio || 1, 3);
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
    const d = Math.round(R * 2.9 * breath * zoom);
    els.halo.style.width = els.halo.style.height = d + 'px';
    els.halo.style.setProperty('--halo-color', col);
    els.halo.style.transform = `translate(-50%, calc(-50% + ${floatY.toFixed(1)}px))`;
    els.halo.style.opacity = (0.55 * haloI * pulse).toFixed(3);
  } else if (els.halo.style.opacity !== '0') {
    els.halo.style.opacity = '0';
  }

  // Rayons divins derrière la roue : tournent lentement, s'entraînent avec la roue,
  // s'intensifient avec la vitesse et le suspense
  if (!state.reduced) {
    const speedF = clamp(Math.abs(state.vel) / 30, 0, 1);
    const d = Math.round(R * 2.7 * breath * zoom);
    els.rays.style.width = els.rays.style.height = d + 'px';
    els.rays.style.transform = 'translate(-50%, calc(-50% + ' + floatY.toFixed(1) + 'px)) rotate(' + (now / 45000 * TAU + state.rot * 0.3).toFixed(3) + 'rad)';
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
      c.shadowColor = 'rgb(' + o.col + ')';
      c.shadowBlur = 14;
      c.fill();
      c.shadowBlur = 0;
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
  if (!state.reduced && Math.abs(state.vel) > 7) {
    drawCache(state.rot - state.vel * 0.014, 0.22);
    drawCache(state.rot - state.vel * 0.028, 0.1);
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
    c.strokeStyle = 'rgba(255,255,255,0.95)';
    c.lineWidth = 3 + 2 * pulse;
    c.shadowColor = seg.color;
    c.shadowBlur = 22 + 18 * pulse;
    c.stroke();
    c.shadowBlur = 0;
  }
  c.restore(); // fin espace tourné

  // Reflet spéculaire qui glisse (suit lentement le temps et la rotation)
  if (!state.reduced && c.createConicGradient) {
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
    const dome = c.createLinearGradient(0, -Rw, 0, Rw * 0.1);
    dome.addColorStop(0, 'rgba(255,255,255,0.2)');
    dome.addColorStop(1, 'rgba(255,255,255,0)');
    c.globalCompositeOperation = 'screen';
    c.fillStyle = dome;
    c.beginPath(); c.arc(0, 0, Rw, 0, TAU); c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  // Anneau d'énergie plasma : n'apparaît qu'en vitesse, tourne avec la roue
  const plasma = state.reduced ? 0 : clamp(Math.abs(state.vel) / 28, 0, 1);
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
    c.shadowColor = 'rgba(120,230,255,0.8)';
    c.shadowBlur = R * 0.05;
    c.stroke();
    c.restore();
  }

  // Anneau métallique + néon dont la teinte tourne
  const ringR = (Rw + R) / 2;
  const mg = c.createLinearGradient(0, -R, 0, R);
  mg.addColorStop(0, '#d6e8ff'); mg.addColorStop(0.4, '#5f6f9a');
  mg.addColorStop(0.6, '#b3c6ea'); mg.addColorStop(1, '#3f4a70');
  c.beginPath(); c.arc(0, 0, ringR, 0, TAU);
  c.strokeStyle = mg;
  c.lineWidth = R - Rw;
  c.stroke();
  if (!state.reduced) {
    const hue = 185 + 120 * (0.5 + 0.5 * Math.sin(now / 1800)); // oscille cyan <-> magenta
    c.beginPath(); c.arc(0, 0, R, 0, TAU);
    c.strokeStyle = `hsla(${hue},95%,62%,0.6)`;
    c.lineWidth = 2.5;
    c.shadowColor = `hsla(${hue},95%,62%,0.9)`;
    c.shadowBlur = R * 0.07;
    c.stroke();
    c.shadowBlur = 0;
  }

  // Moyeu central « SPIN » qui pulse pour appeler le clic
  const hubPulse = state.spinning || state.reduced ? 1 : 1 + 0.045 * Math.sin(now / 380);
  const Rh = Math.max(Rw * 0.16, 26) * hubPulse;
  const hubG = c.createRadialGradient(-Rh * 0.3, -Rh * 0.3, Rh * 0.05, 0, 0, Rh);
  hubG.addColorStop(0, '#5a2d9a'); hubG.addColorStop(0.5, '#1c0f3d'); hubG.addColorStop(1, '#07091a');
  c.beginPath(); c.arc(0, 0, Rh, 0, TAU);
  c.fillStyle = hubG;
  c.shadowColor = state.reduced ? 'rgba(0,0,0,0.6)' : 'rgba(76,240,255,' + (0.35 + 0.25 * Math.sin(now / 380)) + ')';
  c.shadowBlur = Rh * 0.6;
  c.fill();
  c.shadowBlur = 0;
  if (!state.reduced && c.createConicGradient) {          // vortex d'accrétion
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
  c.shadowColor = 'rgba(76,240,255,0.9)';
  c.shadowBlur = 10;
  c.fillText('SPIN', 0, Rh * 0.03);
  c.shadowBlur = 0;

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
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowBlur = 8;
  c.fill();
  c.shadowBlur = 0;
  c.strokeStyle = 'rgba(20,22,37,0.7)';
  c.lineWidth = 1.5;
  c.stroke();
  c.beginPath(); c.arc(0, -ph * 0.3, pw * 0.32, 0, TAU);
  c.fillStyle = '#4cf0ff';
  c.shadowColor = '#4cf0ff';
  c.shadowBlur = 8;
  c.fill();
  c.shadowBlur = 0;
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

function layoutFxCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
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

function drawFx(now, dt) {
  const hasWork = confetti.length || sparks.length || waves.length || rays.length;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!state.reduced) drawCage(fctx, now, true);
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
  if (f > 0 && state.suspense === 0) riserStart();
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
    layoutFxCanvas(els.fx);
    layoutFxCanvas(els.bg);
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
function frame(now) {
  const dt = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;
  updateSpin(now, dt);
  drawBg(now, dt);
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

  layoutFxCanvas(els.fx);
  layoutFxCanvas(els.bg);
  initMotes();
  buildPlanet();
  layoutWheel();

  bindEditor();
  bindImportExport();
  bindGlobal();

  requestAnimationFrame(frame);
}

init();
