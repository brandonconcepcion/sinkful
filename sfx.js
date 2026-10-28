// Synthesized sound effects (Web Audio). No audio files: everything is built
// from noise and oscillators so it stays tiny and tweakable.

const MUTE_KEY = 'sinkful.muted';
const VOLUME = 0.9;
let ctx, master, noiseBuf;
let muted = localStorage.getItem(MUTE_KEY) === '1';

// Browsers only allow audio after a user gesture; call this from one.
export function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  if (master) master.gain.setTargetAtTime(m ? 0 : VOLUME, ctx.currentTime, 0.05);
}

const ready = () => ctx && ctx.state === 'running';
const SILENT = { set() {}, stop() {} };

function noise() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  return src;
}
function filter(type, frequency, Q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
}
// Gain node with an attack/decay envelope starting at t.
function envelope(t, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}
function tone(freq, { type = 'sine', at = 0, peak = 0.1, attack = 0.005, decay = 0.3, to } = {}) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  o.connect(envelope(t, peak, attack, decay)).connect(master);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}
function burst({ type = 'bandpass', freq = 1500, to, Q = 1, peak = 0.15, attack = 0.01, decay = 0.25, at = 0 } = {}) {
  const t = ctx.currentTime + at;
  const src = noise();
  const f = filter(type, freq, Q);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  src.connect(f).connect(envelope(t, peak, attack, decay)).connect(master);
  src.start(t, Math.random());
  src.stop(t + attack + decay + 0.05);
}

// --- Continuous layers: return { set(level), stop() } ----------------------

export function water() {
  if (!ready()) return SILENT;
  const src = noise();
  const body = filter('bandpass', 1100, 0.7);
  const lfo = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  lfo.frequency.value = 6.5;
  lfoDepth.gain.value = 380;
  lfo.connect(lfoDepth).connect(body.frequency);
  const hiss = ctx.createGain();
  hiss.gain.value = 0.3;
  const out = ctx.createGain();
  out.gain.value = 0;
  src.connect(body).connect(out);
  src.connect(filter('highpass', 3800)).connect(hiss).connect(out);
  out.connect(master);
  src.start();
  lfo.start();
  out.gain.setTargetAtTime(0.22, ctx.currentTime, 0.08);
  return {
    set(v) { out.gain.setTargetAtTime(v, ctx.currentTime, 0.05); },
    stop() {
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
      src.stop(ctx.currentTime + 0.8);
      lfo.stop(ctx.currentTime + 0.8);
    },
  };
}

// Sponge = soft mid rasp, brush = bright bristly hiss.
export function scrub(kind = 'sponge') {
  if (!ready()) return SILENT;
  const src = noise();
  const f = kind === 'brush' ? filter('bandpass', 5200, 0.9) : filter('bandpass', 1700, 1.4);
  const out = ctx.createGain();
  out.gain.value = 0;
  src.connect(f).connect(out).connect(master);
  src.start();
  return {
    set(v) { out.gain.setTargetAtTime(v * (kind === 'brush' ? 0.16 : 0.12), ctx.currentTime, 0.02); },
    stop() { out.gain.setTargetAtTime(0, ctx.currentTime, 0.05); src.stop(ctx.currentTime + 0.4); },
  };
}

// --- One-shots --------------------------------------------------------------

// Squeaky-clean chirp: a fast upward pitch flick.
export function squeak() {
  if (!ready()) return;
  const f = 1600 + Math.random() * 1100;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(f, t);
  o.frequency.linearRampToValueAtTime(f * 1.4, t + 0.045);
  o.frequency.linearRampToValueAtTime(f * 1.15, t + 0.1);
  o.connect(envelope(t, 0.045, 0.01, 0.1)).connect(master);
  o.start(t);
  o.stop(t + 0.15);
}

// Ceramic is bright and short; metal (pots, pans) rings lower and longer.
export function clink(metal = false) {
  if (!ready()) return;
  const partials = metal ? [740, 1210, 1980, 2890] : [2093, 3389, 5011, 7040];
  const decay = metal ? 0.7 : 0.22;
  partials.forEach((p, i) => tone(p * (0.98 + Math.random() * 0.04), { peak: 0.08 / (i + 1), decay: decay / (1 + i * 0.3) }));
}

export function squirt() {
  if (!ready()) return;
  burst({ type: 'lowpass', freq: 1400, to: 250, Q: 4, peak: 0.2, decay: 0.2 });
  [0.12, 0.27, 0.4].forEach((at) => tone(900 + Math.random() * 200, { at, to: 420, peak: 0.06, decay: 0.08 }));
}

export function whoosh() {
  if (!ready()) return;
  burst({ freq: 300, to: 1800, Q: 1.5, peak: 0.12, attack: 0.15, decay: 0.3 });
}

// A dish dropping into the soaking tub.
export function plop() {
  if (!ready()) return;
  tone(240, { to: 70, peak: 0.28, decay: 0.16 });
  burst({ type: 'lowpass', freq: 1200, to: 300, peak: 0.14, decay: 0.3, at: 0.02 });
}

export function splash() {
  if (!ready()) return;
  burst({ freq: 1300, to: 500, Q: 0.8, peak: 0.18, decay: 0.3 });
}

export function pop() {
  if (!ready()) return;
  tone(260, { to: 1100, peak: 0.25, decay: 0.07 });
}

export function ding() {
  if (!ready()) return;
  tone(1318, { peak: 0.18, decay: 0.6 });
  tone(1760, { at: 0.09, peak: 0.18, decay: 0.6 });
}

export function fanfare() {
  if (!ready()) return;
  [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
    tone(f, { at: i * 0.09, peak: 0.13, decay: 0.5, type: 'triangle' });
    tone(f * 2, { at: i * 0.09, peak: 0.04, decay: 0.4 });
  });
}

// Drain gurgle: resonant low noise that wobbles, with bloops, ending in a slurp.
export function gurgle(duration) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const src = noise();
  const f = filter('lowpass', 400, 9);
  for (let s = 0; s < duration; s += 0.07) f.frequency.setValueAtTime(160 + Math.random() * 520, t + s);
  f.frequency.setValueAtTime(900, t + duration - 0.5);
  f.frequency.exponentialRampToValueAtTime(90, t + duration);
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.35, t + 0.3);
  out.gain.setValueAtTime(0.35, t + duration - 0.4);
  out.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.1);
  src.connect(f).connect(out).connect(master);
  src.start(t);
  src.stop(t + duration + 0.2);
  for (let s = 0.2; s < duration - 0.3; s += 0.18 + Math.random() * 0.25) {
    tone(200 + Math.random() * 160, { at: s, to: 80, peak: 0.12, decay: 0.12 });
  }
}

// --- Counter props ------------------------------------------------------------

// Pepper mill: a run of crunchy little cracks.
export function grind() {
  if (!ready()) return;
  for (let i = 0; i < 9; i++) burst({ type: 'highpass', freq: 2500 + Math.random() * 2000, Q: 2, peak: 0.08, attack: 0.003, decay: 0.04, at: i * 0.07 + Math.random() * 0.02 });
}

// Salt shaker: grains rattling against the glass.
export function shake() {
  if (!ready()) return;
  for (let i = 0; i < 4; i++) burst({ freq: 6000, Q: 1.2, peak: 0.07, attack: 0.02, decay: 0.08, at: i * 0.14 });
}

// Plant leaves brushing together.
export function rustle() {
  if (!ready()) return;
  burst({ freq: 3200, to: 1800, Q: 0.7, peak: 0.09, attack: 0.05, decay: 0.35 });
  burst({ freq: 4200, to: 2600, Q: 0.9, peak: 0.05, attack: 0.04, decay: 0.25, at: 0.18 });
}

// Wooden knock (cutting board, knife block).
export function knock() {
  if (!ready()) return;
  [0, 0.12].forEach((at) => {
    tone(320, { at, to: 180, peak: 0.22, decay: 0.08, type: 'triangle' });
    burst({ type: 'bandpass', freq: 900, Q: 3, peak: 0.08, decay: 0.05, at });
  });
}

// Oil bottle: a few glugs, each a little lower.
export function glug() {
  if (!ready()) return;
  [0, 0.16, 0.34].forEach((at, i) => tone(380 - i * 50, { at, to: 160 - i * 20, peak: 0.16, attack: 0.02, decay: 0.1 }));
}

// Lemon or sponge squeeze: a soft wet squish.
export function squish() {
  if (!ready()) return;
  burst({ type: 'lowpass', freq: 2200, to: 400, Q: 2, peak: 0.16, attack: 0.03, decay: 0.22 });
}

// A ghostly "ooOOoo" for the jack-o'-lantern.
export function boo() {
  if (!ready()) return;
  tone(260, { type: 'triangle', to: 390, peak: 0.12, attack: 0.18, decay: 0.45 });
  tone(390, { type: 'triangle', to: 220, at: 0.4, peak: 0.12, attack: 0.1, decay: 0.7 });
  tone(523, { to: 784, peak: 0.04, attack: 0.2, decay: 0.4 });
}
