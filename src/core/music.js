/**
 * music.js — procedural score.
 *
 * WHY THIS IS SYNTHESISED RATHER THAN SHIPPED AS AUDIO FILES
 * ----------------------------------------------------------
 * The repository's asset policy (README "Assets", SPEC §8) is that it contains
 * no third-party art or audio at all: every mesh comes from tools/gen_models.py
 * and every sound is generated at runtime from oscillators and noise. Music is
 * no different. The obvious temptation — the actual Yamato theme, or a public
 * domain march grabbed from the internet — is refused on purpose:
 *
 *   - the Yamato score is copyrighted (Hiroshi Miyagawa) and is exactly the kind
 *     of third-party asset the policy exists to keep out;
 *   - public-domain *compositions* are safe, but most recordings of them are
 *     separately copyrighted, and the licences are easy to get wrong.
 *
 * So the score below is original: a martial minor-key ostinato for battle, a
 * major-key fanfare for victory, a slow descent for defeat, and an ambient drone
 * for the boot screen. It is written from intervals and a chord progression, not
 * transcribed from anything.
 *
 * IF YOU DO WANT REAL RECORDINGS
 * ------------------------------
 * `tools/fetch_audio.mjs` downloads verified public-domain / CC0 tracks into
 * `assets/audio/`, which is gitignored so they never enter the repository. Drop
 * a `manifest.json` there and this engine will prefer those files over the
 * synthesised score. See assets/audio/README.md.
 *
 * CONTRACT
 * --------
 *   const m = new MusicEngine();
 *   m.attach(audioEngine);          // shares the AudioContext, optional
 *   m.update(dt, world);            // picks a cue from world.state / world.wave
 *   m.setVolume(v);                 // 0..1, usually CONFIG.audio.music
 *   m.cue                           // 'boot' | 'battle' | 'victory' | 'defeat'
 *
 * Every public method is safe to call before a user gesture (nothing is created
 * until the context is running) and never throws.
 */

import { CONFIG } from './config.js';

const num = (v, d) => (Number.isFinite(v) ? v : d);
const AC = typeof window !== 'undefined'
  ? (window.AudioContext || window.webkitAudioContext)
  : null;

/** Semitone offsets from A4 (440 Hz) for a note name. */
const NOTE = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
const hz = (name, octave) => {
  const n = NOTE[name[0]];
  const sharp = name[1] === '#' ? 1 : 0;
  return 440 * Math.pow(2, (n + sharp + (octave - 4) * 12) / 12);
};

/**
 * The score. `bass` and `chords` are scale-degree indices into D minor for the
 * battle cue and D major for the victory cue; `lead` is an optional melodic
 * line in note names so the fanfare is readable rather than a wall of numbers.
 */
const CUES = {
  boot: {
    bpm: 60,
    beatsPerBar: 4,
    bars: 8,
    // A slow swell on a bare fifth: expectant, no rhythm yet.
    pad: [[0, 2, 4], [0, 2, 4], [-3, -1, 1], [-3, -1, 1], [0, 2, 4], [0, 2, 4], [-5, -3, -1], [-5, -3, -1]],
    bass: [[0], [0], [-3], [-3], [0], [0], [-5], [-5]],
    drums: 'none',
    root: 'D', minor: true, gain: 0.5,
  },
  battle: {
    bpm: 104,
    beatsPerBar: 4,
    bars: 16,
    // i - VI - III - VII, the workhorse martial minor progression.
    pad: [[0, 2, 4], [-4, -1, 2], [-7, -4, -1], [-2, 1, 4]],
    bass: [[0], [0], [-4], [-4], [-7], [-7], [-2], [-2]],
    // Ostinato on the root, one push per beat.
    drums: 'march',
    root: 'D', minor: true, gain: 0.62,
  },
  victory: {
    bpm: 112,
    beatsPerBar: 4,
    bars: 12,
    pad: [[0, 4, 7], [-5, -1, 2], [-3, 1, 4], [0, 4, 7]],
    bass: [[0], [-5], [-3], [0]],
    drums: 'march',
    lead: [
      ['D', 5, 1], ['F#', 5, 1], ['A', 5, 2],
      ['A', 5, 1], ['G', 5, 1], ['F#', 5, 2],
      ['G', 5, 1], ['A', 5, 1], ['B', 5, 2],
      ['A', 5, 4],
    ],
    root: 'D', minor: false, gain: 0.66,
  },
  defeat: {
    bpm: 52,
    beatsPerBar: 4,
    bars: 8,
    pad: [[0, 2, 4], [-1, 1, 3], [-3, -1, 1], [-5, -3, -1]],
    bass: [[0], [-1], [-3], [-5]],
    drums: 'none',
    root: 'D', minor: true, gain: 0.46,
  },
};

export class MusicEngine {
  constructor(opts = {}) {
    this.audio = null;
    this.ctx = null;
    this.bus = null;              // music gain, feeds the sfx master
    this.volume = num(opts.volume, num(CONFIG?.audio?.music, 0));
    this.cue = 'boot';
    this._pending = 'boot';
    this._nextNoteTime = 0;       // ctx time of the next scheduled beat
    this._step = 0;               // 16th-note counter through the cue
    this._cueStart = 0;
    this._failed = false;
    this._disposed = false;
    this._noise = null;
    this._external = null;        // { el, tracks, idx } once real files exist
    this._externalTried = false;
    this._useExternal = false;
    this._gainTrim = 1;
  }

  /**
   * Share an AudioEngine's context and master bus. Optional: without it the
   * engine stays silent (the caller may never have unlocked audio).
   */
  attach(audio) {
    this.audio = audio || null;
    return this;
  }

  /** Lazily build the graph, once the context is actually running. */
  _ensure() {
    if (this._disposed || this._failed) return null;
    if (this.ctx && this.bus) return this.ctx;
    const a = this.audio;
    if (!a) return null;
    // Ask the audio engine to build its graph; it is a no-op if already built.
    let ctx = null;
    try {
      ctx = typeof a._ensure === 'function' ? a._ensure() : a.ctx;
    } catch (_) { ctx = null; }
    if (!ctx || !a.master) return null;
    if (ctx.state !== 'running') return null;   // wait for the user gesture
    this.ctx = ctx;
    try {
      const bus = ctx.createGain();
      bus.gain.value = this.volume * this._gainTrim;
      bus.connect(a.master);
      this.bus = bus;
    } catch (err) {
      this._failed = true;
      this.ctx = null;
      this.bus = null;
      return null;
    }
    this._nextNoteTime = this.ctx.currentTime + 0.08;
    this._step = 0;
    return this.ctx;
  }

  /* ------------------------------------------------------------------ */
  /* Voices                                                              */
  /* ------------------------------------------------------------------ */

  _noiseBuffer(ctx) {
    if (this._noise && this._noise.sampleRate === ctx.sampleRate) return this._noise;
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }

  /** Two detuned saws through a lowpass: a brass-ish section. */
  _brass(t, freq, dur, gain, cutoff) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.max(180, cutoff * 0.5), t);
    lp.frequency.linearRampToValueAtTime(Math.max(240, cutoff), t + Math.min(0.22, dur * 0.4));
    lp.Q.value = 1.1;
    lp.connect(out);
    out.connect(this.bus);
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g); g.connect(lp);
      o.start(t); o.stop(t + dur + 0.1);
    }
    const a = Math.min(0.09, dur * 0.25);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain, t + a);
    out.gain.setTargetAtTime(gain * 0.72, t + a, 0.18);
    out.gain.setTargetAtTime(0, t + dur, 0.08);
    return out;
  }

  /** Detuned saw stack with a slow filter sweep: the string/synth pad. */
  _pad(t, freqs, dur, gain) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    lp.Q.value = 0.8;
    lp.connect(out); out.connect(this.bus);
    for (const f of freqs) {
      for (const det of [-5, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.34 / Math.max(1, freqs.length * 0.5);
        o.connect(g); g.connect(lp);
        o.start(t); o.stop(t + dur + 0.2);
      }
    }
    const a = Math.min(0.5, dur * 0.35);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain, t + a);
    out.gain.setTargetAtTime(0, t + dur, 0.3);
    return out;
  }

  /** Square bass with a short filter envelope. */
  _bass(t, freq, dur, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.setTargetAtTime(240, t + 0.05, 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.setTargetAtTime(0, t + dur * 0.8, 0.09);
    o.connect(lp); lp.connect(g); g.connect(this.bus);
    o.start(t); o.stop(t + dur + 0.1);
    return g;
  }

  /** Timpani: a pitched sine with a fast downward bend plus a skin transient. */
  _timpani(t, freq, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.7, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.75);
    o.connect(g); g.connect(this.bus);
    o.start(t); o.stop(t + 0.8);
    // skin
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass'; hp.frequency.value = 180; hp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    src.connect(hp); hp.connect(ng); ng.connect(this.bus);
    src.start(t); src.stop(t + 0.2);
  }

  /** Military snare: filtered noise with a short body. */
  _snare(t, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx);
    src.playbackRate.value = 1.4;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.13);
    src.connect(bp); bp.connect(g); g.connect(this.bus);
    src.start(t); src.stop(t + 0.16);
  }

  /* ------------------------------------------------------------------ */
  /* Scheduling                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Schedule every beat that falls inside the lookahead window. Standard
   * WebAudio pattern: the timer is coarse, the SCHEDULING is sample-accurate.
   */
  _schedule() {
    const ctx = this._ensure();
    if (!ctx) return;
    const cue = CUES[this.cue] || CUES.battle;
    const spb = 60 / cue.bpm;              // seconds per beat
    const stepDur = spb / 4;               // 16th notes
    const horizon = ctx.currentTime + 0.35;
    let guard = 0;
    while (this._nextNoteTime < horizon && guard++ < 96) {
      this._playStep(cue, this._step, this._nextNoteTime, stepDur, spb);
      this._nextNoteTime += stepDur;
      this._step = (this._step + 1) % (cue.bars * 16);
    }
  }

  _playStep(cue, step, t, stepDur, spb) {
    const root = hz(cue.root, 2);
    const beat = Math.floor(step / 4);
    const bar = Math.floor(step / 16) % cue.bars;
    const inBar = step % 16;
    const semis = (n) => root * Math.pow(2, n / 12);

    // Chords: one pad per bar, and a brass hit on the downbeat.
    if (inBar === 0) {
      const chord = cue.pad[bar % cue.pad.length] || [0, 2, 4];
      const barLen = spb * cue.beatsPerBar;
      this._pad(t, chord.map((n) => semis(n) * 2), barLen * 0.98, 0.16 * cue.gain);
      this._brass(t, semis(chord[0]) * 2, spb * 0.9, 0.10 * cue.gain, 2400);
    }
    // Bass ostinato: every beat, with a lift on beat 3.
    const bassDeg = (cue.bass[bar % cue.bass.length] || [0])[0];
    if (inBar % 4 === 0) {
      const oct = beat === 2 ? 1 : 0;
      this._bass(t, semis(bassDeg) * (oct ? 2 : 1), stepDur * 3.2, 0.22 * cue.gain);
    }
    // Percussion.
    if (cue.drums === 'march') {
      if (inBar === 0 || inBar === 8) this._timpani(t, semis(bassDeg) * 0.5, 0.5 * cue.gain);
      if (inBar === 4) this._snare(t, 0.14 * cue.gain);
      if (inBar === 12) this._snare(t, 0.10 * cue.gain);
      if (inBar === 6 || inBar === 14) this._snare(t, 0.05 * cue.gain);
    }
    // Lead line (victory fanfare): walk the note list against the bar clock.
    if (cue.lead) {
      const lead = cue.lead;
      const total = lead.reduce((a, n) => a + n[2], 0);
      const pos = (bar * cue.beatsPerBar + beat) % total;
      let acc = 0;
      for (const [name, oct, len] of lead) {
        if (pos === acc) {
          this._brass(t, hz(name, oct), spb * len * 0.95, 0.17 * cue.gain, 3200);
          break;
        }
        acc += len;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Optional real recordings                                            */
  /* ------------------------------------------------------------------ */

  /**
   * If tools/fetch_audio.mjs has put a manifest in assets/audio/, prefer those
   * recordings over the synthesised score. Checked once, lazily, and every
   * failure is silent: a missing or broken manifest just means the synth score
   * keeps playing, which is the default and needs no files at all.
   */
  async _tryExternal() {
    if (this._externalTried) return;
    this._externalTried = true;
    if (typeof fetch !== 'function' || typeof Audio === 'undefined') return;
    try {
      // An UNCLEARED playlist (copyrighted, downloaded for private local
      // evaluation) is only ever used when explicitly asked for with
      // `?uncleared=1`. It is never the default, it is gitignored, and a fresh
      // clone has no such directory — so the shippable build always plays either
      // the cleared recordings or the synthesised score. See THIRD_PARTY_AUDIO.md.
      const wantUncleared = typeof location !== 'undefined'
        && new URLSearchParams(location.search).has('uncleared');
      const paths = wantUncleared
        ? ['./assets/audio/uncleared/manifest.json', './assets/audio/manifest.json']
        : ['./assets/audio/manifest.json'];
      let man = null;
      for (const path of paths) {
        try {
          const res = await fetch(path, { cache: 'no-store' });
          if (!res.ok) continue;
          const parsed = await res.json();
          if (parsed && Array.isArray(parsed.tracks) && parsed.tracks.length) { man = parsed; break; }
        } catch (_) { /* try the next one */ }
      }
      if (!man) return;
      if (man.uncleared) {
        console.warn('[music] playing UNCLEARED, copyrighted audio for local evaluation only — '
          + 'never redistribute. See THIRD_PARTY_AUDIO.md.');
      }
      const tracks = Array.isArray(man?.tracks) ? man.tracks.filter((t) => t && t.file) : [];
      if (!tracks.length) return;
      const el = new Audio();
      el.loop = false;
      el.preload = 'auto';
      el.volume = Math.max(0, Math.min(1, this.volume));
      el.addEventListener('ended', () => this._nextExternal());
      this._external = { el, tracks, idx: 0, uncleared: !!man.uncleared };
      this._useExternal = true;
      this._nextExternal(true);
      console.info(`[music] using ${tracks.length} local recording(s) from assets/audio/manifest.json`);
    } catch (_) {
      // No manifest, bad JSON, autoplay refusal — all fine, synth score continues.
    }
  }

  _nextExternal(first = false) {
    const x = this._external;
    if (!x) return;
    if (!first) x.idx = (x.idx + 1) % x.tracks.length;
    const t = x.tracks[x.idx];
    try {
      const base = x.uncleared ? './assets/audio/uncleared/' : './assets/audio/';
      x.el.src = base + encodeURIComponent(t.file);
      const pr = x.el.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Public                                                              */
  /* ------------------------------------------------------------------ */

  /** Switch cue. Restarts the bar clock so a cue always begins on a downbeat. */
  setCue(name) {
    if (!CUES[name] || name === this.cue) return;
    this.cue = name;
    if (this._useExternal) this._nextExternal();
    this._step = 0;
    if (this.ctx) this._nextNoteTime = this.ctx.currentTime + 0.06;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, num(v, 0)));
    if (this._external && this._external.el) {
      try { this._external.el.volume = this.volume; } catch (_) { /* ignore */ }
    }
    if (this.bus && this.ctx) {
      try {
        this.bus.gain.setTargetAtTime(this.volume * this._gainTrim, this.ctx.currentTime, 0.08);
      } catch (_) {
        try { this.bus.gain.value = this.volume * this._gainTrim; } catch (__) { /* ignore */ }
      }
    }
  }

  /**
   * Drive the score from the world state. Called once per frame.
   * Picks the cue from the match state, then schedules ahead.
   */
  update(dt, world) {
    if (this._disposed || this._failed) return;
    const w = (world && typeof world === 'object') ? world : {};

    // Track the configured music volume live, so the mute key works.
    const want = num(CONFIG?.audio?.music, 0);
    if (Math.abs(want - this.volume) > 0.001) this.setVolume(want);
    if (this.volume <= 0.0001) { this._nextNoteTime = 0; return; }

    let cue = 'battle';
    if (w.state === 'boot') cue = 'boot';
    else if (w.state === 'victory') cue = 'victory';
    else if (w.state === 'defeat') cue = 'defeat';
    else if (w.state === 'paused') cue = this.cue === 'boot' ? 'boot' : this.cue;
    if (cue !== this.cue) this.setCue(cue);

    const ctx = this._ensure();
    if (!ctx) return;
    if (!this._externalTried) this._tryExternal();
    // Real recordings take precedence; the synthesised score is the fallback.
    if (this._useExternal) {
      const x = this._external;
      if (x && x.el.paused && !x.el.ended && this.volume > 0) {
        const pr = x.el.play();
        if (pr && typeof pr.catch === 'function') pr.catch(() => {});
      }
      return;
    }
    if (!this._nextNoteTime) this._nextNoteTime = ctx.currentTime + 0.06;
    this._schedule();
  }

  dispose() {
    this._disposed = true;
    try { this._external?.el?.pause?.(); } catch (_) { /* ignore */ }
    this._external = null;
    this._useExternal = false;
    try { this.bus?.disconnect?.(); } catch (_) { /* ignore */ }
    this.bus = null;
    this.ctx = null;
  }
}

/** No-op music, used when audio is unavailable. */
export class NullMusic {
  constructor() { this.cue = 'boot'; this.volume = 0; }
  attach() { return this; }
  setCue() {}
  setVolume() {}
  update() {}
  dispose() {}
}

export default MusicEngine;
