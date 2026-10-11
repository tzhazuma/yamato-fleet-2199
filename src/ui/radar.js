/**
 * YAMATO FLEET 2199 — src/ui/radar.js  (owner: engine-dev)
 *
 * Top-down tactical plot on a 2D canvas.
 *
 * Frozen interface (SPEC §6.6):
 *   class Radar {
 *     constructor(canvasEl, world)
 *     update(dt, world): void
 *     dispose(): void
 *   }
 *
 * The plot is PLAYER-CENTRED and rotated so the player's bow always points up.
 * Range rings are labelled, contacts are colour-coded by faction, the player's
 * current target is highlighted, and out-of-range contacts are clamped to the
 * plot edge with an outward chevron.
 *
 * Extras (additive, safe to ignore): setRange(m), toggleZoom(), getRange(),
 * constructor 3rd arg opts = { range, size }.
 *
 * Everything is defensive: a missing field, a zero-sized canvas, a missing 2D
 * context or a dead player must never throw.
 */

import { CONFIG } from '../core/config.js';
import { clamp, clamp01, formatDistance } from '../core/math.js';

/** Faction → plot colour. Overridable from CONFIG.radar.factionColors. */
const DEFAULT_FACTION_COLORS = {
  uncf: '#7fe4ff',
  garmillas: '#ffb04a',
  bolar: '#c08cff',
  neutral: '#9fb3c8',
};

const MONO = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const isVec = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Largest weapon range in CONFIG — used to derive a sensible plot range. */
function maxWeaponRange() {
  let m = 0;
  const w = CONFIG && CONFIG.weapons;
  if (w && typeof w === 'object') {
    for (const key of Object.keys(w)) {
      const r = w[key] && w[key].range;
      if (Number.isFinite(r) && r > m) m = r;
    }
  }
  return m;
}

/** Rotate (x,y,z) by quaternion q. */
function rotate(q, x, y, z, out) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.w)) {
    out.x = x; out.y = y; out.z = z;
    return out;
  }
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  // t = 2 * (q_vec × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

export class Radar {
  /**
   * @param {HTMLCanvasElement} canvasEl
   * @param {object} world
   * @param {object} [opts] { range, size }
   */
  constructor(canvasEl, world, opts = {}) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const cfgRadar = (CONFIG && CONFIG.radar && typeof CONFIG.radar === 'object') ? CONFIG.radar : {};

    this.canvas = canvasEl || null;
    this.ctx = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.disposed = false;
    this._warned = new Set();

    // Plot range: explicit opts > CONFIG.radar.range > 1.25 × longest weapon
    // range, clamped to the battle-space so a long-range outlier cannot squash
    // every contact into the middle of the plot.
    const arena = Number.isFinite(CONFIG?.world?.boundsRadius) ? CONFIG.world.boundsRadius : 20000;
    const derived = clamp(maxWeaponRange() * 1.25, arena * 0.5, arena * 1.5);
    this.baseRange = Math.max(1000, Number.isFinite(o.range) ? o.range
      : (Number.isFinite(cfgRadar.range) ? cfgRadar.range : (derived > 0 ? derived : arena * 1.5)));
    this.range = this.baseRange;
    this.zoomLevels = Array.isArray(cfgRadar.zoomLevels) && cfgRadar.zoomLevels.length
      ? cfgRadar.zoomLevels.filter((z) => Number.isFinite(z) && z > 0)
      : [1, 0.5, 0.25];
    if (!this.zoomLevels.length) this.zoomLevels = [1];
    this._zoomIndex = 0;

    this.factionColors = Object.assign({}, DEFAULT_FACTION_COLORS, cfgRadar.factionColors || {});
    this.ringFractions = Array.isArray(cfgRadar.rings) && cfgRadar.rings.length
      ? cfgRadar.rings.filter((f) => Number.isFinite(f) && f > 0 && f <= 1)
      : [0.25, 0.5, 0.75, 1];
    if (!this.ringFractions.length) this.ringFractions = [0.5, 1];
    this.maxContacts = Math.max(8, Math.floor(Number.isFinite(cfgRadar.maxContacts) ? cfgRadar.maxContacts : 160));

    this._sweep = 0;
    this._sizeCheck = 0;
    this._fallbackSize = clamp(Number.isFinite(o.size) ? o.size : 220, 80, 900);

    this._tmp = { x: 0, y: 0, z: 0 };
    this._basis = { fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0 };
    this._center = { x: 0, y: 0, z: 0 };
    this._resizeObserver = null;
    this._onWindowResize = null;

    if (this.canvas && typeof this.canvas.getContext === 'function') {
      try { this.ctx = this.canvas.getContext('2d'); } catch (err) { this.ctx = null; }
    }
    if (!this.ctx) this._warn('ctx', 'radar canvas has no 2D context — radar disabled');

    this._measure(true);
    this._applyLayout();
    this._observeResize();

    // Seed the basis immediately so the first frame is already oriented.
    this._updateBasis(world);
  }

  // ──────────────────────────────────────────────────────────── lifecycle ──

  /**
   * Inset the canvas from the viewport edge. main.js appends the canvas to
   * `#hud` with only width/height set, so without this it lands flush at [0,0]
   * and the canvas-drawn "FWD / range" labels get clipped by the screen edge.
   * A caller that has already positioned the canvas keeps its own layout.
   */
  _applyLayout() {
    const cv = this.canvas;
    if (!cv || !cv.style) return;
    try {
      let pos = cv.style.position || '';
      if (!pos && typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(cv);
        pos = (cs && cs.position) || '';
      }
      if (pos && pos !== 'static') return;
      const inset = Math.max(0, Number.isFinite(CONFIG?.radar?.inset) ? CONFIG.radar.inset : 14);
      cv.style.position = 'absolute';
      cv.style.left = inset + 'px';
      cv.style.top = inset + 'px';
    } catch (_) { /* cosmetic only */ }
  }

  _warn(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[radar] ' + msg); } catch (_) { /* ignore */ }
  }

  _observeResize() {
    if (this.canvas && typeof ResizeObserver !== 'undefined') {
      try {
        this._resizeObserver = new ResizeObserver(() => { this._measure(); });
        this._resizeObserver.observe(this.canvas);
      } catch (_) { this._resizeObserver = null; }
    }
    if (!this._resizeObserver && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this._onWindowResize = () => this._measure();
      try { window.addEventListener('resize', this._onWindowResize); } catch (_) { this._onWindowResize = null; }
    }
  }

  /** Read the CSS box and resize the backing store (DPR aware). */
  _measure(force) {
    if (!this.canvas || this.disposed) return;
    let cssW = 0, cssH = 0;
    try {
      cssW = this.canvas.clientWidth || 0;
      cssH = this.canvas.clientHeight || 0;
      if (!cssW) cssW = Number(this.canvas.width) || 0;
      if (!cssH) cssH = Number(this.canvas.height) || 0;
    } catch (_) { cssW = 0; cssH = 0; }
    if (!cssW || !cssH) { cssW = cssW || this._fallbackSize; cssH = cssH || this._fallbackSize; }

    const dpr = clamp(
      (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)) ? window.devicePixelRatio : 1,
      1, 3,
    );
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (!force && w === this.width && h === this.height && dpr === this.dpr) return;

    this.width = w;
    this.height = h;
    this.dpr = dpr;
    try {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    } catch (err) {
      this._warn('resize', 'radar resize failed: ' + (err && err.message ? err.message : err));
    }
    try {
      if (this.ctx && typeof this.ctx.setTransform === 'function') {
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    } catch (_) { /* ignore */ }
  }

  /** Plot range in metres. */
  setRange(m) {
    if (Number.isFinite(m) && m > 0) this.range = clamp(m, 500, 500000);
  }

  getRange() { return this.range; }

  /** Step through CONFIG.radar.zoomLevels (KeyZ). */
  toggleZoom() {
    this._zoomIndex = (this._zoomIndex + 1) % this.zoomLevels.length;
    this.range = clamp(this.baseRange * this.zoomLevels[this._zoomIndex], 500, 500000);
    return this.range;
  }

  // ─────────────────────────────────────────────────────────────── update ──

  update(dt, world) {
    if (this.disposed || !this.ctx) return;
    const w = (world && typeof world === 'object') ? world : {};
    try {
      this._sizeCheck += Number.isFinite(dt) ? dt : 0;
      if (this._sizeCheck > 0.5) { this._sizeCheck = 0; this._measure(); }

      const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
      this._sweep = (this._sweep + step * 1.5) % (Math.PI * 2);

      this._updateBasis(w);
      this._draw(w);
    } catch (err) {
      this._warn('update', 'radar frame failed: ' + (err && err.message ? err.message : err));
    }
  }

  /** Player-centred, player-heading-aligned basis in the XZ plane. */
  _updateBasis(world) {
    const player = world ? world.player : null;
    const p = player && isVec(player.position) ? player.position : null;
    this._center.x = p ? p.x : 0;
    this._center.y = p ? p.y : 0;
    this._center.z = p ? p.z : 0;

    const f = rotate(player ? player.quaternion : null, 0, 0, -1, this._tmp);
    let fx = f.x, fz = f.z;
    const len = Math.hypot(fx, fz);
    if (len < 1e-5) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
    // right = forward × up  =>  (-fz, 0, fx)
    this._basis.fx = fx; this._basis.fz = fz;
    this._basis.rx = -fz; this._basis.rz = fx;
  }

  _ships(world) {
    const s = world ? world.ships : null;
    if (Array.isArray(s)) return s;
    if (s && typeof s.values === 'function') { try { return Array.from(s.values()); } catch (_) { return []; } }
    return [];
  }

  // ─────────────────────────────────────────────────────────────── drawing ──

  _draw(world) {
    const ctx = this.ctx;
    const W = this.width, H = this.height;
    const cx = W / 2, cy = H / 2;
    // 16px margin so the "FWD" label and the outermost ring never touch the
    // canvas edge (and therefore can never be clipped by the viewport).
    const radius = Math.max(8, Math.min(W, H) / 2 - 16);

    ctx.clearRect(0, 0, W, H);

    // backdrop
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 14, 24, 0.62)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // grid: range rings + labels
    ctx.font = MONO;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.ringFractions.length; i++) {
      const frac = this.ringFractions[i];
      const r = radius * frac;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(120, 190, 255, ' + (i === this.ringFractions.length - 1 ? 0.28 : 0.16) + ')';
      ctx.stroke();
      const label = formatDistance(this.range * frac);
      if (label) {
        ctx.fillStyle = 'rgba(196, 224, 248, 0.82)';
        ctx.fillText(label, cx + 4, cy - r + 8);
      }
    }

    // cross hairs
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.10)';
    ctx.stroke();

    // sweep
    this._drawSweep(ctx, cx, cy, radius);

    // "bow up" marker
    ctx.fillStyle = 'rgba(206, 238, 255, 0.95)';
    ctx.textAlign = 'center';
    ctx.fillText('FWD', cx, cy - radius + 9);

    // contacts
    const ships = this._ships(world);
    const player = world ? world.player : null;
    const target = player ? player.target : (world ? world.target : null);
    let drawn = 0;
    for (let i = 0; i < ships.length && drawn < this.maxContacts; i++) {
      const ship = ships[i];
      if (!ship || ship === player) continue;
      if (ship.alive === false) continue;
      if (!isVec(ship.position)) continue;
      drawn++;
      this._drawContact(ctx, cx, cy, radius, ship, ship === target, player);
    }

    // player marker at the centre (always points up = player's bow)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    const playerDead = !!(player && player.alive === false);
    ctx.fillStyle = playerDead ? '#ff6b6b' : '#e8f6ff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(10, 20, 30, 0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // footer: contact count + range
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(196, 224, 248, 0.82)';
    ctx.fillText('CONTACTS ' + drawn, 6, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText('R ' + formatDistance(this.range), W - 6, H - 6);
    ctx.restore();
  }

  _drawSweep(ctx, cx, cy, radius) {
    const segs = 26;
    const span = Math.PI * 0.55;
    for (let i = 0; i < segs; i++) {
      const a0 = this._sweep - span * (i / segs);
      const a1 = this._sweep - span * ((i + 1) / segs);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, a1, a0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(110, 210, 255, ' + (0.055 * (1 - i / segs)).toFixed(4) + ')';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this._sweep) * radius, cy + Math.sin(this._sweep) * radius);
    ctx.strokeStyle = 'rgba(140, 230, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawContact(ctx, cx, cy, radius, ship, isTarget, player) {
    const pos = ship.position;
    const dx = pos.x - this._center.x;
    const dy = pos.y - this._center.y;
    const dz = pos.z - this._center.z;

    // project into the player-relative plot frame (forward = up)
    const fwd = dx * this._basis.fx + dz * this._basis.fz;
    const right = dx * this._basis.rx + dz * this._basis.rz;
    const dist = Math.hypot(dx, dy, dz);

    const k = radius / this.range;
    let px = right * k;
    let py = -fwd * k;
    const r = Math.hypot(px, py);
    const clamped = r > radius;
    if (clamped && r > 1e-6) {
      const s = radius / r;
      px *= s; py *= s;
    }

    const x = cx + px;
    const y = cy + py;

    const faction = (typeof ship.faction === 'string' && ship.faction) ? ship.faction : 'neutral';
    const color = this.factionColors[faction] || this.factionColors.neutral || '#9fb3c8';

    const role = (ship.def && ship.def.role) || ship.role || '';
    const big = role === 'battleship' || role === 'flagship' || role === 'carrier';
    const size = big ? 4.2 : (role === 'cruiser' ? 3.4 : 2.6);

    ctx.save();
    ctx.globalAlpha = clamped ? 0.55 : 1;

    if (isTarget) {
      // target bracket
      const b = size + 4;
      ctx.beginPath();
      ctx.moveTo(x - b, y - b + 3); ctx.lineTo(x - b, y - b); ctx.lineTo(x - b + 3, y - b);
      ctx.moveTo(x + b - 3, y - b); ctx.lineTo(x + b, y - b); ctx.lineTo(x + b, y - b + 3);
      ctx.moveTo(x + b, y + b - 3); ctx.lineTo(x + b, y + b); ctx.lineTo(x + b - 3, y + b);
      ctx.moveTo(x - b + 3, y + b); ctx.lineTo(x - b, y + b); ctx.lineTo(x - b, y + b - 3);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (clamped) {
      // outward chevron so the direction of an off-plot contact is readable
      const a = Math.atan2(py, px);
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(4, 0); ctx.lineTo(-2, -3.4); ctx.lineTo(-2, 3.4);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, size * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8, 14, 22, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // elevation tick: up = above the player's plane, down = below
      const elev = Math.abs(dy) > 60 ? (dy > 0 ? -1 : 1) : 0;
      if (elev !== 0) {
        ctx.beginPath();
        ctx.moveTo(x, y + elev * (size * 0.62 + 1));
        ctx.lineTo(x, y + elev * (size * 0.62 + 3.4));
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (isTarget) {
      const label = (typeof ship.callsign === 'string' && ship.callsign)
        ? ship.callsign
        : ((ship.def && ship.def.displayName) || 'TARGET');
      ctx.globalAlpha = 1;
      ctx.font = MONO;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(235, 245, 255, 0.9)';
      ctx.fillText(String(label).slice(0, 16) + '  ' + formatDistance(dist), x + size + 6, y);
    }

    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────── dispose ──

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this._resizeObserver) this._resizeObserver.disconnect(); } catch (_) { /* ignore */ }
    this._resizeObserver = null;
    if (this._onWindowResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      try { window.removeEventListener('resize', this._onWindowResize); } catch (_) { /* ignore */ }
    }
    this._onWindowResize = null;
    try {
      if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.width, this.height);
    } catch (_) { /* ignore */ }
    this.ctx = null;
    this.canvas = null;
  }
}

export default Radar;
