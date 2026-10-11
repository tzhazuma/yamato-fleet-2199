/**
 * YAMATO FLEET 2199 — src/core/audio.js  (owner: engine-dev)
 *
 * 100% procedural WebAudio synthesis. No audio files are ever fetched.
 * Everything is oscillators + generated noise buffers + biquad filters +
 * envelopes, bussed through a master gain into a limiter-ish compressor.
 *
 * Frozen interface (SPEC §6.8):
 *   class AudioEngine {
 *     constructor(); resume(): Promise<void>; setMasterVolume(v): void
 *     play(name, opts): void
 *     startEngineLoop(ship): void; stopEngineLoop(): void
 *     update(dt, world): void
 *   }
 *
 * Sound names (SPEC §6.8):
 *   shock_cannon | wmgun_charge | wmgun_fire | explosion_small | explosion_big
 *   torpedo | engine_loop | alarm | ui_click | shield_hit
 *
 * Extras (safe to ignore, additive only): stop(name), stopCharge(), dispose(),
 * setListener(pos, forward, right), getMasterVolume(), available.
 *
 * Every entry point is defensive: a missing CONFIG field, a missing AudioContext,
 * a suspended context or a garbage `opts` must never throw. If audio cannot run
 * (headless / no WebAudio), the engine silently becomes a no-op.
 */

import { CONFIG } from '../core/config.js';

const AC = (typeof globalThis !== 'undefined')
  ? (globalThis.AudioContext || globalThis.webkitAudioContext || null)
  : null;

/** Sound-name aliases so weapon-spec `sound` fields from src/weapons/weapons.js
 *  (and any sensible spelling) always land on a real synth. */
const ALIASES = {
  wmgun: 'wmgun_fire',
  wave_motion_gun: 'wmgun_fire',
  wave_motion_gun_charge: 'wmgun_charge',
  wave_motion_gun_fire: 'wmgun_fire',
  charge: 'wmgun_charge',
  beam: 'garmillas_beam',
  garmillas_beam: 'garmillas_beam',
  bolar_beam: 'bolar_beam',
  heavy_beam: 'heavy_beam',
  garmillas_heavy_beam: 'heavy_beam',
  secondary: 'secondary',
  secondary_battery: 'secondary',
  pd: 'pd',
  point_defense: 'pd',
  ciws: 'pd',
  missile: 'missile',
  torpedo_launch: 'torpedo',
  salvo: 'torpedo',
  explosion: 'explosion_big',
  explosion_medium: 'explosion_big',
  hit: 'shield_hit',
  shield: 'shield_hit',
  impact: 'shield_hit',
  alarm_warning: 'alarm',
  warning: 'alarm',
  click: 'ui_click',
  ui: 'ui_click',
  engine: 'engine_loop',
  thruster: 'engine_loop',
};

/** Canonical synth table. Anything not listed here (after alias resolution)
 *  falls back to a soft generic thud instead of throwing. */
const CANONICAL = new Set([
  'shock_cannon', 'secondary', 'wmgun_charge', 'wmgun_fire', 'explosion_small',
  'explosion_big', 'torpedo', 'engine_loop', 'alarm', 'ui_click',
  'shield_hit', 'garmillas_beam', 'bolar_beam', 'heavy_beam', 'pd', 'missile',
  'generic',
]);

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const EPS = 0.0001;

export class AudioEngine {
  /**
   * @param {object} [opts] { volume, noiseSeconds, maxVoices }
   */
  constructor(opts = {}) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const cfgAudio = (CONFIG && typeof CONFIG === 'object' && CONFIG.audio && typeof CONFIG.audio === 'object')
      ? CONFIG.audio : {};

    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.available = !!AC;
    // CONFIG.audio = { master, music, sfx } — the engine bus is master × sfx.
    const cfgMaster = num(cfgAudio.master, 0.7);
    const cfgSfx = num(cfgAudio.sfx, 0.85);
    this.volume = clamp(num(o.volume, cfgMaster * cfgSfx), 0, 4);
    this.noiseSeconds = clamp(num(o.noiseSeconds, 2.0), 0.25, 8);
    this.maxVoices = Math.max(4, Math.floor(num(o.maxVoices, num(cfgAudio.maxVoices, 40))));
    this.maxSame = Math.max(1, Math.floor(num(cfgAudio.maxSameVoices, 4)));

    this._noise = new Map();      // kind -> AudioBuffer
    this._voices = [];            // { name, end }
    this._voiceSeq = 0;
    this._engine = null;          // continuous engine-loop node bundle
    this._engineShip = null;
    this._charge = null;          // active wmgun_charge bundle (stoppable)
    this._listener = null;        // { pos:{x,y,z}, forward:{...}, right:{...} }
    this._warned = new Set();
    this._lastPlayAt = new Map(); // name -> ctx time (spam guard)
    this._disposed = false;
    this._failed = false;         // hard failure => permanent no-op
  }

  // ─────────────────────────────────────────────────────────── lifecycle ──

  /** Create the context on demand (avoids the autoplay-blocked warning at load). */
  _ensure() {
    if (this._disposed || this._failed) return null;
    if (this.ctx) return this.ctx;
    if (!AC) { this._failed = true; return null; }
    try {
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;

      // limiter-ish compressor, then master gain in front of it
      let tail = ctx.destination;
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = num(CONFIG?.audio?.limiterThreshold, -8);
        comp.knee.value = 6;
        comp.ratio.value = 14;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        comp.connect(ctx.destination);
        this.limiter = comp;
        tail = comp;
      } catch (_) { this.limiter = null; }

      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(tail);
      this.master = master;
      return ctx;
    } catch (err) {
      this._failed = true;
      this.ctx = null;
      this.master = null;
      this._warn('context', 'AudioContext unavailable: ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  /** Resume after a user gesture. Always resolves (never rejects). */
  resume() {
    const ctx = this._ensure();
    if (!ctx) return Promise.resolve();
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        return Promise.resolve(ctx.resume()).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return Promise.resolve();
  }

  setMasterVolume(v) {
    this.volume = clamp(num(v, this.volume), 0, 4);
    if (this.master) {
      try {
        const t = this.ctx ? this.ctx.currentTime : 0;
        this.master.gain.cancelScheduledValues(t);
        this.master.gain.setTargetAtTime(this.volume, t, 0.02);
      } catch (_) {
        try { this.master.gain.value = this.volume; } catch (__) { /* ignore */ }
      }
    }
  }

  getMasterVolume() { return this.volume; }

  get running() {
    return !!(this.ctx && this.ctx.state === 'running');
  }

  // ──────────────────────────────────────────────────────────────── play ──

  /**
   * Fire a one-shot (or start/stop a loop).
   * @param {string} name
   * @param {object} [opts] { volume, position, distance, rate, duration,
   *                          intensity, delay, repeat, ship, force, stop }
   */
  play(name, opts) {
    if (this._disposed || this._failed) return;
    const o = (opts && typeof opts === 'object') ? opts : {};

    // Tolerate an object being passed as the name ({ sound: 'x' } / { id: 'x' }).
    let key = name;
    if (key && typeof key === 'object') key = key.sound || key.id || key.name;
    if (typeof key !== 'string' || !key) return;
    key = key.toLowerCase().trim();

    if (o.stop === true) { this.stop(key); return; }
    if (key === 'engine_loop' || key === 'engine' || key === 'thruster') {
      this.startEngineLoop(o.ship || this._engineShip || null);
      return;
    }

    const resolved = ALIASES[key] || key;
    const ctx = this._ensure();
    if (!ctx) return;
    // Don't queue a pile of sounds while the tab is suspended — they'd all
    // detonate at once on resume.
    if (ctx.state !== 'running' && o.force !== true) return;

    const synth = this['_snd_' + resolved];
    const fn = (typeof synth === 'function') ? synth : this._snd_generic;
    if (typeof synth !== 'function') {
      this._warn('name:' + resolved, 'unknown sound "' + resolved + '" — using generic');
    }

    const t0 = ctx.currentTime + clamp(num(o.delay, 0), 0, 10) + 0.001;
    const end = t0 + num(o.duration, this._nominalDuration(resolved));

    // Voice budget + per-name spam guard.
    this._prune(t0);
    if (this._voices.length >= this.maxVoices) return;
    let same = 0;
    for (let i = 0; i < this._voices.length; i++) if (this._voices[i].name === resolved) same++;
    if (same >= this.maxSame && o.force !== true) return;
    this._voices.push({ name: resolved, end });

    try {
      fn.call(this, t0, o, resolved);
    } catch (err) {
      this._warn('synth:' + resolved, 'synth "' + resolved + '" failed: ' + (err && err.message ? err.message : err));
    }
  }

  /** Force-stop a looping/sustained sound ('wmgun_charge', 'engine_loop', ...). */
  stop(name) {
    const key = (typeof name === 'string' && name) ? (ALIASES[name.toLowerCase()] || name.toLowerCase()) : '';
    if (key === 'wmgun_charge' || key === 'charge' || key === '' ) this.stopCharge();
    if (key === 'engine_loop' || key === 'engine' || key === '') this.stopEngineLoop();
  }

  stopCharge() {
    const bundle = this._charge;
    this._charge = null;
    if (!bundle) return;
    this._fadeOutBundle(bundle, 0.08);
  }

  // ─────────────────────────────────────────────────────── engine loop ──

  startEngineLoop(ship) {
    if (this._disposed || this._failed) return;
    if (ship) this._engineShip = ship;
    const ctx = this._ensure();
    if (!ctx || ctx.state !== 'running') return;
    if (this._engine) return;                    // already running
    try {
      const t = ctx.currentTime;
      const out = ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = num(CONFIG?.audio?.engineCutoff, 420);
      lp.Q.value = 2.5;
      lp.connect(out);

      const oscs = [];
      const base = num(CONFIG?.audio?.engineBaseHz, 44);
      const ratios = [1, 1.5, 2.02];
      for (let i = 0; i < ratios.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = i === 2 ? 'triangle' : 'sawtooth';
        osc.frequency.value = base * ratios[i];
        const g = ctx.createGain();
        g.gain.value = i === 0 ? 0.5 : (i === 1 ? 0.28 : 0.12);
        osc.connect(g); g.connect(lp);
        osc.start(t);
        oscs.push(osc);
      }

      // rumble bed
      const noise = this._noiseSource('brown');
      if (noise) {
        const nlp = ctx.createBiquadFilter();
        nlp.type = 'lowpass';
        nlp.frequency.value = 180;
        const ng = ctx.createGain();
        ng.gain.value = 0.35;
        noise.connect(nlp); nlp.connect(ng); ng.connect(lp);
        noise.start(t);
        oscs.push(noise);
      }

      this._engine = { out, lp, oscs, nodes: [out, lp], gain: 0 };
      out.gain.setTargetAtTime(this._engineGain(), t, 0.4);
    } catch (err) {
      this._warn('engineLoop', 'engine loop failed: ' + (err && err.message ? err.message : err));
      this._engine = null;
    }
  }

  stopEngineLoop() {
    const e = this._engine;
    this._engine = null;
    this._engineShip = null;
    if (!e) return;
    this._fadeOutBundle({ out: e.out, nodes: e.nodes, stop: e.oscs }, 0.25);
  }

  _engineGain() {
    const ship = this._engineShip;
    const throttle = ship ? Math.abs(num(ship.throttle, 0)) : 0;
    const base = num(CONFIG?.audio?.engineIdleGain, 0.05);
    const span = num(CONFIG?.audio?.engineThrottleGain, 0.16);
    return clamp(base + span * throttle, 0, 0.6);
  }

  // ────────────────────────────────────────────────────────────── update ──

  update(dt, world) {
    if (this._disposed || this._failed) return;
    const w = (world && typeof world === 'object') ? world : {};
    this._updateListener(w);

    if (this._engine && this.ctx) {
      if (!this._engineShip || this._engineShip.alive === false) {
        // Player died / loop owner gone: keep it but idle it out.
        if (this._engineShip && this._engineShip.alive === false) this.stopEngineLoop();
      }
      const e = this._engine;
      if (e) {
        const target = this._engineGain();
        try { e.out.gain.setTargetAtTime(target, this.ctx.currentTime, 0.15); } catch (_) { /* ignore */ }
      }
    }

    if (this.ctx) this._prune(this.ctx.currentTime);
  }

  _updateListener(world) {
    const cam = world.camera;
    const player = world.player;
    let px = null, py = null, pz = null, fx = 0, fy = 0, fz = -1;

    const readPos = (obj) => {
      const p = obj && obj.position ? obj.position : obj;
      if (!p) return null;
      const x = num(p.x, NaN), y = num(p.y, NaN), z = num(p.z, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      return { x, y, z };
    };

    const cp = readPos(cam);
    if (cp) { px = cp.x; py = cp.y; pz = cp.z; }
    else {
      const pp = readPos(player);
      if (pp) { px = pp.x; py = pp.y; pz = pp.z; }
    }
    if (px === null) { this._listener = null; return; }

    // forward vector: camera world matrix > player quaternion > default -Z.
    // A camera looks down its local -Z, i.e. the negated 3rd column of
    // matrixWorld — plain arithmetic, so no THREE import is needed here.
    let f = null;
    try {
      const e = (cam && cam.matrixWorld && cam.matrixWorld.elements) ? cam.matrixWorld.elements : null;
      if (e && e.length >= 11) {
        const bx = e[8], by = e[9], bz = e[10];
        const l = Math.hypot(bx, by, bz);
        if (l > 1e-6) f = { x: -bx / l, y: -by / l, z: -bz / l };
      }
    } catch (_) { f = null; }
    if (!f && player && player.quaternion) {
      const q = player.quaternion;
      if (Number.isFinite(q.x) && Number.isFinite(q.w)) {
        // rotate (0,0,-1) by q
        const x = q.x, y = q.y, z = q.z, wq = q.w;
        f = {
          x: -2 * (x * z + wq * y),
          y: -2 * (y * z - wq * x),
          z: -(1 - 2 * (x * x + y * y)),
        };
      }
    }
    if (f) { fx = f.x; fy = f.y; fz = f.z; }
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // right = forward × up(0,1,0)
    const rx = -fz, ry = 0, rz = fx;

    this._listener = { pos: { x: px, y: py, z: pz }, forward: { x: fx, y: fy, z: fz }, right: { x: rx, y: ry, z: rz } };
  }

  // ──────────────────────────────────────────────────────────────── utils ──

  _warn(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[audio] ' + msg); } catch (_) { /* ignore */ }
  }

  _prune(now) {
    const v = this._voices;
    for (let i = v.length - 1; i >= 0; i--) if (v[i].end <= now) v.splice(i, 1);
  }

  _nominalDuration(name) {
    switch (name) {
      case 'wmgun_charge': return 3.0;
      case 'wmgun_fire': return 3.0;
      case 'explosion_big': return 3.0;
      case 'explosion_small': return 0.8;
      case 'alarm': return 1.2;
      case 'engine_loop': return 1.0;
      case 'torpedo': case 'missile': return 1.0;
      default: return 0.6;
    }
  }

  _noiseBuffer(kind) {
    const key = kind || 'white';
    if (this._noise.has(key)) return this._noise.get(key);
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      const len = Math.max(64, Math.floor(this.noiseSeconds * ctx.sampleRate));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      if (key === 'brown') {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const white = Math.random() * 2 - 1;
          last = (last + 0.02 * white) / 1.02;
          d[i] = clamp(last * 3.5, -1, 1);
        }
      } else if (key === 'pink') {
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          d[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11, -1, 1);
          b6 = white * 0.115926;
        }
      } else {
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      this._noise.set(key, buf);
      return buf;
    } catch (err) {
      this._warn('noise', 'noise buffer failed: ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  _noiseSource(kind) {
    const ctx = this.ctx;
    const buf = this._noiseBuffer(kind);
    if (!ctx || !buf) return null;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      return src;
    } catch (_) { return null; }
  }

  /** Per-voice output chain: envelope gain -> [stereo pan] -> master. */
  _out(t0, opts, peak) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    let pan = null;
    try { pan = this._panFor(opts); } catch (_) { pan = null; }
    try {
      if (pan !== null && typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        g.connect(p); p.connect(this.master);
        this._release(p, t0 + 8);
      } else {
        g.connect(this.master);
      }
    } catch (_) {
      try { g.connect(this.master); } catch (__) { /* ignore */ }
    }
    const att = this._distanceGain(opts);
    const vol = clamp(num(opts.volume, 1), 0, 4) * att * clamp(num(peak, 1), 0, 4);
    g._yfPeak = Math.max(vol, EPS);
    return g;
  }

  /** -1..1 stereo position of a world-space source relative to the listener. */
  _panFor(opts) {
    const L = this._listener;
    if (!L) return null;
    const p = opts && opts.position;
    if (!p || !Number.isFinite(p.x)) return null;
    const dx = p.x - L.pos.x, dy = p.y - L.pos.y, dz = p.z - L.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return 0;
    const r = (dx * L.right.x + dy * L.right.y + dz * L.right.z) / dist;
    const f = (dx * L.forward.x + dy * L.forward.y + dz * L.forward.z) / dist;
    // Sources behind the listener stay centred-ish; hard-pan only to the sides.
    return clamp(r * (0.35 + 0.65 * Math.max(0, f + 1) * 0.5), -1, 1);
  }

  /** Inverse-ish distance attenuation, 1.0 when no position/listener is known. */
  _distanceGain(opts) {
    const L = this._listener;
    const p = opts && opts.position;
    if (!L || !p || !Number.isFinite(p.x)) return 1;
    const d = Math.hypot(p.x - L.pos.x, p.y - L.pos.y, p.z - L.pos.z);
    const ref = num(CONFIG?.audio?.refDistance, 600);
    const maxAudible = num(CONFIG?.audio?.maxDistance, num(CONFIG?.world?.boundsRadius, 60000));
    if (d >= maxAudible) return 0;
    return clamp(ref / (ref + d), 0, 1);
  }

  /** Distance in metres from the listener to opts.position, or null. */
  _distanceTo(opts) {
    const L = this._listener;
    const p = opts && opts.position;
    if (typeof opts?.distance === 'number' && Number.isFinite(opts.distance)) return Math.max(0, opts.distance);
    if (!L || !p || !Number.isFinite(p.x)) return null;
    return Math.hypot(p.x - L.pos.x, p.y - L.pos.y, p.z - L.pos.z);
  }

  /** AD envelope on a gain node; returns the end time. */
  _env(g, t0, peak, attack, decay, hold) {
    const a = Math.max(0.001, num(attack, 0.005));
    const d = Math.max(0.01, num(decay, 0.2));
    const h = Math.max(0, num(hold, 0));
    const pk = Math.max(EPS, peak);
    try {
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(EPS, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + a);
      if (h > 0) g.gain.setValueAtTime(pk, t0 + a + h);
      g.gain.exponentialRampToValueAtTime(EPS, t0 + a + h + d);
    } catch (_) { try { g.gain.value = pk; } catch (__) { /* ignore */ } }
    return t0 + a + h + d;
  }

  _osc(type, freq, detune) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = Math.max(0.01, num(freq, 440));
    if (detune) o.detune.value = num(detune, 0);
    return o;
  }

  _filter(type, freq, q) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    f.frequency.value = Math.max(10, num(freq, 1000));
    if (typeof q === 'number') f.Q.value = q;
    return f;
  }

  _sweep(param, t0, from, to, dur, exp) {
    try {
      const a = Math.max(0.01, num(from, 200));
      const b = Math.max(0.01, num(to, 200));
      param.cancelScheduledValues(t0);
      param.setValueAtTime(a, t0);
      if (exp === false) param.linearRampToValueAtTime(b, t0 + Math.max(0.01, dur));
      else param.exponentialRampToValueAtTime(b, t0 + Math.max(0.01, dur));
    } catch (_) { /* ignore */ }
  }

  _start(node, t0, stopAt) {
    try {
      if (node && typeof node.start === 'function') node.start(t0);
      if (node && typeof node.stop === 'function' && stopAt) node.stop(stopAt + 0.05);
    } catch (_) { /* ignore */ }
  }

  _release(node, at) {
    try {
      if (node && typeof node.disconnect === 'function') {
        const delay = Math.max(0, (at - (this.ctx ? this.ctx.currentTime : 0)) * 1000);
        if (typeof setTimeout === 'function' && delay < 60000) setTimeout(() => { try { node.disconnect(); } catch (_) { /* ignore */ } }, delay);
      }
    } catch (_) { /* ignore */ }
  }

  _fadeOutBundle(bundle, time) {
    if (!bundle) return;
    const ctx = this.ctx;
    const t = ctx ? ctx.currentTime : 0;
    try {
      if (bundle.out) {
        bundle.out.gain.cancelScheduledValues(t);
        bundle.out.gain.setValueAtTime(Math.max(EPS, bundle.out.gain.value), t);
        bundle.out.gain.exponentialRampToValueAtTime(EPS, t + Math.max(0.02, time));
      }
    } catch (_) { /* ignore */ }
    const stopAt = t + Math.max(0.05, time) + 0.05;
    const kill = () => {
      try { if (bundle.stop) for (const n of bundle.stop) { try { n.stop(); } catch (_) { /* ignore */ } } } catch (_) { /* ignore */ }
      try { if (bundle.nodes) for (const n of bundle.nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } } } catch (_) { /* ignore */ }
      try { if (bundle.out) bundle.out.disconnect(); } catch (_) { /* ignore */ }
    };
    if (typeof setTimeout === 'function') setTimeout(kill, Math.max(0, (stopAt - t) * 1000));
    else kill();
  }

  // ──────────────────────────────────────────────────────────── synths ──

  _snd_shock_cannon(t0, opts) {
    const ctx = this.ctx;
    const dur = 0.45;

    // body: bandpassed noise punch
    const n = this._noiseSource('white');
    if (n) {
      const bp = this._filter('bandpass', 1600, 1.1);
      this._sweep(bp.frequency, t0, 2200, 380, 0.18);
      const g = this._out(t0, opts, 0.55);
      n.connect(bp); bp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.004, 0.2);
      this._start(n, t0, end);
      this._release(g, end + 0.2);
    }
    // sub thump
    {
      const o = this._osc('sine', 260);
      this._sweep(o.frequency, t0, 300, 62, 0.22);
      const g = this._out(t0, opts, 0.6);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.003, 0.26);
      this._start(o, t0, end);
      this._release(g, end + 0.2);
    }
    // metallic click transient
    {
      const o = this._osc('square', 1250);
      const hp = this._filter('highpass', 900, 0.7);
      const g = this._out(t0, opts, 0.14);
      o.connect(hp); hp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.001, 0.035);
      this._start(o, t0, end);
      this._release(g, end + 0.2);
    }
    this._tail(t0 + dur);
  }

  _snd_wmgun_charge(t0, opts) {
    const ctx = this.ctx;
    const cfgCharge = num(CONFIG?.weapons?.wmgun?.chargeTime, 3.0);
    const dur = clamp(num(opts.duration, cfgCharge), 0.4, 12);

    const out = ctx.createGain();
    out.gain.value = 0;
    try { out.connect(this.master); } catch (_) { return; }

    const nodes = [];
    const lp = this._filter('lowpass', 400, 6);
    lp.connect(out);
    this._sweep(lp.frequency, t0, 320, 5200, dur * 0.95);

    // rising whine (two detuned saws)
    for (let i = 0; i < 2; i++) {
      const o = this._osc('sawtooth', 55 + i * 1.5, i ? 9 : -7);
      this._sweep(o.frequency, t0, 55, 330, dur, true);
      const g = ctx.createGain();
      g.gain.value = i ? 0.3 : 0.55;
      o.connect(g); g.connect(lp);
      this._start(o, t0, t0 + dur + 0.2);
      nodes.push(o, g);
    }
    // shimmer partial
    {
      const o = this._osc('triangle', 880);
      this._sweep(o.frequency, t0, 660, 1760, dur, true);
      const g = ctx.createGain();
      g.gain.value = 0.1;
      o.connect(g); g.connect(lp);
      this._start(o, t0, t0 + dur + 0.2);
      nodes.push(o, g);
    }
    // noise bed swelling
    const n = this._noiseSource('pink');
    if (n) {
      const nbp = this._filter('bandpass', 500, 0.9);
      this._sweep(nbp.frequency, t0, 240, 2600, dur, true);
      const ng = ctx.createGain();
      ng.gain.value = 0.0;
      try {
        ng.gain.setValueAtTime(0.02, t0);
        ng.gain.linearRampToValueAtTime(0.3, t0 + dur * 0.92);
      } catch (_) { /* ignore */ }
      n.connect(nbp); nbp.connect(ng); ng.connect(out);
      this._start(n, t0, t0 + dur + 0.2);
      nodes.push(n, nbp, ng);
    }

    // tremolo on the master of this voice (charging capacitor feel).
    // Wiring order matters: amp -> out is established BEFORE lp is rerouted,
    // so a failure here can never orphan the voice into silence.
    try {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(4, t0);
      lfo.frequency.linearRampToValueAtTime(18, t0 + dur);
      const lg = ctx.createGain();
      lg.gain.value = 0.25;
      lfo.connect(lg);
      const amp = ctx.createGain();
      amp.gain.value = 1;
      lg.connect(amp.gain);
      amp.connect(out);
      try { lp.disconnect(); } catch (_) { /* ignore */ }
      lp.connect(amp);
      this._start(lfo, t0, t0 + dur + 0.2);
      nodes.push(lfo, lg, amp);
    } catch (_) { /* tremolo is optional */ }

    // overall envelope: swell then hold near full
    const vol = clamp(num(opts.volume, 1), 0, 4) * this._distanceGain(opts) * 0.5;
    try {
      out.gain.setValueAtTime(EPS, t0);
      out.gain.linearRampToValueAtTime(Math.max(EPS, vol), t0 + dur * 0.9);
      out.gain.setValueAtTime(Math.max(EPS, vol), t0 + dur);
    } catch (_) { /* ignore */ }

    this._charge = { out, nodes, stop: nodes.filter((x) => typeof x.stop === 'function'), until: t0 + dur + 0.2 };
  }

  _snd_wmgun_fire(t0, opts) {
    const ctx = this.ctx;
    this.stopCharge();                       // firing always kills the charge whine

    // 1) sub-bass drop
    {
      const o = this._osc('sine', 90);
      this._sweep(o.frequency, t0, 120, 21, 1.1);
      const g = this._out(t0, opts, 1.0);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.006, 2.2);
      this._start(o, t0, end);
      this._release(g, end + 0.3);
    }
    // 2) body: brown noise through a closing lowpass
    const n = this._noiseSource('brown');
    if (n) {
      const lp = this._filter('lowpass', 2400, 0.9);
      this._sweep(lp.frequency, t0, 3000, 110, 1.5);
      const g = this._out(t0, opts, 0.85);
      n.connect(lp); lp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.01, 2.4);
      this._start(n, t0, end);
      this._release(g, end + 0.3);
    }
    // 3) initial crack
    const c = this._noiseSource('white');
    if (c) {
      const hp = this._filter('highpass', 2600, 0.7);
      const g = this._out(t0, opts, 0.4);
      c.connect(hp); hp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.002, 0.3);
      this._start(c, t0, end);
      this._release(g, end + 0.3);
    }
    // 4) long shockwave tail
    const s = this._noiseSource('pink');
    if (s) {
      const bp = this._filter('bandpass', 320, 0.6);
      this._sweep(bp.frequency, t0, 520, 90, 2.6);
      const g = this._out(t0, opts, 0.42);
      s.connect(bp); bp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.35, 2.8);
      this._start(s, t0, end);
      this._release(g, end + 0.3);
    }
  }

  _snd_explosion_small(t0, opts) {
    const d = this._distanceTo(opts);
    const distant = d !== null && d > num(CONFIG?.audio?.muffleDistance, 1800);
    const cut = distant ? 260 : 1300;
    const decay = distant ? 1.0 : 0.4;

    const n = this._noiseSource('white');
    if (n) {
      const lp = this._filter('lowpass', cut, 0.9);
      if (!distant) this._sweep(lp.frequency, t0, 1800, 300, decay);
      const g = this._out(t0, opts, distant ? 0.35 : 0.5);
      n.connect(lp); lp.connect(g);
      const end = this._env(g, t0, g._yfPeak, distant ? 0.08 : 0.004, decay);
      this._start(n, t0, end);
      this._release(g, end + 0.3);
    }
    const o = this._osc('sine', 180);
    this._sweep(o.frequency, t0, 200, distant ? 40 : 48, 0.3);
    const g2 = this._out(t0, opts, 0.4);
    o.connect(g2);
    const end2 = this._env(g2, t0, g2._yfPeak, distant ? 0.06 : 0.003, distant ? 1.1 : 0.35);
    this._start(o, t0, end2);
    this._release(g2, end2 + 0.3);
  }

  _snd_explosion_big(t0, opts) {
    const d = this._distanceTo(opts);
    const muffleAt = num(CONFIG?.audio?.muffleDistance, 1800);
    const distant = d !== null && d > muffleAt;
    const decay = distant ? 3.6 : 2.1;
    const preDelay = distant ? 0.12 : 0;

    // 1) low rumble
    const n = this._noiseSource('brown');
    if (n) {
      const lp = this._filter('lowpass', distant ? 200 : 900, 0.8);
      if (!distant) this._sweep(lp.frequency, t0, 1400, 160, decay * 0.8);
      const g = this._out(t0, opts, 0.85);
      n.connect(lp); lp.connect(g);
      const end = this._env(g, t0 + preDelay, g._yfPeak, distant ? 0.12 : 0.008, decay);
      this._start(n, t0, end);
      this._release(g, end + 0.4);
    }
    // 2) sub thump
    {
      const o = this._osc('sine', 70);
      this._sweep(o.frequency, t0, 90, 20, 0.9);
      const g = this._out(t0, opts, 0.6);
      o.connect(g);
      const end = this._env(g, t0 + preDelay, g._yfPeak, 0.006, distant ? 2.0 : 1.2);
      this._start(o, t0, end);
      this._release(g, end + 0.4);
    }
    // 3) crack (mostly gone at distance)
    if (!distant) {
      const c = this._noiseSource('white');
      if (c) {
        const hp = this._filter('highpass', 2200, 0.7);
        const g = this._out(t0, opts, 0.32);
        c.connect(hp); hp.connect(g);
        const end = this._env(g, t0, g._yfPeak, 0.002, 0.35);
        this._start(c, t0, end);
        this._release(g, end + 0.3);
      }
    }
    // 4) delayed secondary rumble (echo-ish)
    const s = this._noiseSource('pink');
    if (s) {
      const lp = this._filter('lowpass', distant ? 160 : 420, 0.7);
      const g = this._out(t0, opts, distant ? 0.3 : 0.22);
      s.connect(lp); lp.connect(g);
      const end = this._env(g, t0 + 0.28 + preDelay, g._yfPeak, 0.2, decay * 0.9);
      this._start(s, t0, end);
      this._release(g, end + 0.4);
    }
  }

  _snd_torpedo(t0, opts) {
    // launch thunk
    {
      const o = this._osc('triangle', 300);
      this._sweep(o.frequency, t0, 340, 88, 0.22);
      const g = this._out(t0, opts, 0.34);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.004, 0.24);
      this._start(o, t0, end);
      this._release(g, end + 0.2);
    }
    // whoosh: bandpass sweeping up then down
    const n = this._noiseSource('white');
    if (n) {
      const bp = this._filter('bandpass', 500, 1.4);
      this._sweep(bp.frequency, t0, 380, 2400, 0.35);
      try { bp.frequency.exponentialRampToValueAtTime(520, t0 + 0.95); } catch (_) { /* ignore */ }
      const g = this._out(t0, opts, 0.4);
      n.connect(bp); bp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.05, 0.95);
      this._start(n, t0, end);
      this._release(g, end + 0.2);
    }
    // fizz tail
    const f = this._noiseSource('pink');
    if (f) {
      const hp = this._filter('highpass', 1500, 0.6);
      const g = this._out(t0, opts, 0.16);
      f.connect(hp); hp.connect(g);
      const end = this._env(g, t0 + 0.1, g._yfPeak, 0.12, 0.7);
      this._start(f, t0, end);
      this._release(g, end + 0.2);
    }
  }

  _snd_missile(t0, opts) {
    const o = this._osc('sawtooth', 220);
    this._sweep(o.frequency, t0, 180, 900, 0.3);
    const bp = this._filter('bandpass', 900, 3.0);
    const g = this._out(t0, opts, 0.3);
    o.connect(bp); bp.connect(g);
    const end = this._env(g, t0, g._yfPeak, 0.02, 0.45);
    this._start(o, t0, end);
    this._release(g, end + 0.2);

    const n = this._noiseSource('white');
    if (n) {
      const hp = this._filter('highpass', 1800, 0.7);
      const g2 = this._out(t0, opts, 0.22);
      n.connect(hp); hp.connect(g2);
      const end2 = this._env(g2, t0, g2._yfPeak, 0.03, 0.5);
      this._start(n, t0, end2);
      this._release(g2, end2 + 0.2);
    }
  }

  _snd_garmillas_beam(t0, opts) {
    const o = this._osc('sawtooth', 900);
    this._sweep(o.frequency, t0, 1100, 180, 0.4);
    const bp = this._filter('bandpass', 1200, 4.5);
    const g = this._out(t0, opts, 0.45);
    o.connect(bp); bp.connect(g);
    const end = this._env(g, t0, g._yfPeak, 0.006, 0.4);
    this._start(o, t0, end);
    this._release(g, end + 0.2);

    const n = this._noiseSource('white');
    if (n) {
      const hp = this._filter('highpass', 2200, 0.8);
      const g2 = this._out(t0, opts, 0.2);
      n.connect(hp); hp.connect(g2);
      const end2 = this._env(g2, t0, g2._yfPeak, 0.004, 0.28);
      this._start(n, t0, end2);
      this._release(g2, end2 + 0.2);
    }
  }

  _snd_bolar_beam(t0, opts) {
    const o = this._osc('square', 420);
    this._sweep(o.frequency, t0, 320, 1500, 0.35);
    const bp = this._filter('bandpass', 700, 6.0);
    const g = this._out(t0, opts, 0.4);
    o.connect(bp); bp.connect(g);
    const end = this._env(g, t0, g._yfPeak, 0.01, 0.42);
    this._start(o, t0, end);
    this._release(g, end + 0.2);

    // ring-modulated shimmer
    const o2 = this._osc('sine', 2100);
    const g2 = this._out(t0, opts, 0.16);
    o2.connect(g2);
    const end2 = this._env(g2, t0, g2._yfPeak, 0.02, 0.35);
    this._start(o2, t0, end2);
    this._release(g2, end2 + 0.2);
  }

  _snd_alarm(t0, opts) {
    const repeat = clamp(Math.floor(num(opts.repeat, num(CONFIG?.audio?.alarmBeeps, 2))), 1, 8);
    const step = 0.34;
    const o = this._osc('square', 620);
    const bp = this._filter('bandpass', 950, 2.2);
    const g = this._out(t0, opts, 0.3);
    o.connect(bp); bp.connect(g);

    try {
      const now = t0;
      for (let i = 0; i < repeat; i++) {
        const s = now + i * step;
        o.frequency.setValueAtTime(660, s);
        o.frequency.setValueAtTime(440, s + step * 0.5);
      }
    } catch (_) { /* ignore */ }

    const end = this._env(g, t0, g._yfPeak, 0.02, repeat * step + 0.25, repeat * step);
    this._start(o, t0, end);
    this._release(g, end + 0.2);
  }

  _snd_ui_click(t0, opts) {
    {
      const o = this._osc('sine', 1400);
      this._sweep(o.frequency, t0, 1500, 900, 0.05);
      const g = this._out(t0, opts, 0.14);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.001, 0.045);
      this._start(o, t0, end);
      this._release(g, end + 0.1);
    }
    const n = this._noiseSource('white');
    if (n) {
      const hp = this._filter('highpass', 4200, 0.7);
      const g = this._out(t0, opts, 0.07);
      n.connect(hp); hp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.001, 0.02);
      this._start(n, t0, end);
      this._release(g, end + 0.1);
    }
  }

  _snd_shield_hit(t0, opts) {
    const intensity = clamp(num(opts.intensity, 1), 0.1, 3);
    // metallic partials
    const partials = [780, 1173, 1561];
    for (let i = 0; i < partials.length; i++) {
      const o = this._osc('sine', partials[i] * (1 + (i - 1) * 0.004));
      const g = this._out(t0, opts, (0.2 - i * 0.045) * intensity);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.003, 0.5 - i * 0.08);
      this._start(o, t0, end);
      this._release(g, end + 0.2);
    }
    // shimmer hiss
    const n = this._noiseSource('white');
    if (n) {
      const bp = this._filter('bandpass', 2600, 3.0);
      this._sweep(bp.frequency, t0, 3600, 1500, 0.25);
      const g = this._out(t0, opts, 0.2 * intensity);
      n.connect(bp); bp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.002, 0.22);
      this._start(n, t0, end);
      this._release(g, end + 0.2);
    }
    // low "clang" body
    const o2 = this._osc('triangle', 180);
    this._sweep(o2.frequency, t0, 220, 110, 0.2);
    const g2 = this._out(t0, opts, 0.25 * intensity);
    o2.connect(g2);
    const end2 = this._env(g2, t0, g2._yfPeak, 0.002, 0.25);
    this._start(o2, t0, end2);
    this._release(g2, end2 + 0.2);
  }

  /** CONFIG.weapons.secondary_battery.sound === 'secondary' */
  _snd_secondary(t0, opts) {
    const n = this._noiseSource('white');
    if (n) {
      const bp = this._filter('bandpass', 2600, 1.3);
      this._sweep(bp.frequency, t0, 3000, 900, 0.1);
      const g = this._out(t0, opts, 0.3);
      n.connect(bp); bp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.003, 0.12);
      this._start(n, t0, end);
      this._release(g, end + 0.15);
    }
    {
      const o = this._osc('sine', 420);
      this._sweep(o.frequency, t0, 460, 130, 0.14);
      const g = this._out(t0, opts, 0.32);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.002, 0.16);
      this._start(o, t0, end);
      this._release(g, end + 0.15);
    }
  }

  /** CONFIG.weapons.garmillas_heavy_beam.sound === 'heavy_beam' */
  _snd_heavy_beam(t0, opts) {
    {
      const o = this._osc('sawtooth', 620);
      this._sweep(o.frequency, t0, 760, 130, 0.5);
      const lp = this._filter('lowpass', 3000, 3.5);
      this._sweep(lp.frequency, t0, 3200, 280, 0.55);
      const g = this._out(t0, opts, 0.55);
      o.connect(lp); lp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.008, 0.6);
      this._start(o, t0, end);
      this._release(g, end + 0.25);
    }
    {
      const o = this._osc('sine', 95);
      this._sweep(o.frequency, t0, 120, 38, 0.6);
      const g = this._out(t0, opts, 0.4);
      o.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.01, 0.7);
      this._start(o, t0, end);
      this._release(g, end + 0.25);
    }
    const n = this._noiseSource('white');
    if (n) {
      const hp = this._filter('highpass', 1200, 0.8);
      const g = this._out(t0, opts, 0.26);
      n.connect(hp); hp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.005, 0.4);
      this._start(n, t0, end);
      this._release(g, end + 0.25);
    }
  }

  /** CONFIG.weapons.point_defense.sound === 'pd' — short, quiet, high tick. */
  _snd_pd(t0, opts) {
    {
      const o = this._osc('square', 1900);
      this._sweep(o.frequency, t0, 2100, 1200, 0.03);
      const hp = this._filter('highpass', 800, 0.7);
      const g = this._out(t0, opts, 0.1);
      o.connect(hp); hp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.001, 0.035);
      this._start(o, t0, end);
      this._release(g, end + 0.1);
    }
    const n = this._noiseSource('white');
    if (n) {
      const hp = this._filter('highpass', 5200, 0.7);
      const g = this._out(t0, opts, 0.06);
      n.connect(hp); hp.connect(g);
      const end = this._env(g, t0, g._yfPeak, 0.001, 0.022);
      this._start(n, t0, end);
      this._release(g, end + 0.1);
    }
  }

  _snd_generic(t0, opts) {
    const o = this._osc('sine', 220);
    this._sweep(o.frequency, t0, 240, 90, 0.15);
    const g = this._out(t0, opts, 0.25);
    o.connect(g);
    const end = this._env(g, t0, g._yfPeak, 0.005, 0.18);
    this._start(o, t0, end);
    this._release(g, end + 0.2);
  }

  /** No-op hook kept for symmetry with the synth table (never used). */
  _tail() { /* voices self-prune in update() */ }

  // ───────────────────────────────────────────────────────────── dispose ──

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this.stopEngineLoop(); } catch (_) { /* ignore */ }
    try { this.stopCharge(); } catch (_) { /* ignore */ }
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this._voices.length = 0;
    this._noise.clear();
    if (ctx && typeof ctx.close === 'function') {
      try { Promise.resolve(ctx.close()).catch(() => {}); } catch (_) { /* ignore */ }
    }
  }
}

export default AudioEngine;
