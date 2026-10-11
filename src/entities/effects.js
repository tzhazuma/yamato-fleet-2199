/**
 * src/entities/effects.js — GPU-light visual effects: explosions, impacts,
 * trails, muzzle flashes, shockwaves and the wave motion beam.
 *
 * One Points cloud carries every particle (pooled, CPU-integrated), and small
 * pools of sprites/meshes cover the volumetric bits. No textures are loaded
 * from disk — the glow/ring textures are generated on a canvas at boot.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { makeGlowTexture } from '../core/scene.js';
import { Rng } from '../core/rng.js';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Ring texture for shockwaves. */
function makeRingTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.30, size / 2, size / 2, size * 0.5);
  g.addColorStop(0.00, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.35)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Flat white star sprite — research 03 measured the reference's explosions as
 * pure #ffffff star shapes fading over ~0.4 s, with no orange and no smoke.
 * One additive quad with this alpha texture reproduces the whole effect.
 */
function makeStarTexture(points = 6, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  // Spikes.
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2 + Math.PI / 2;
    const w = size * 0.035;
    const len = size * (i % 2 === 0 ? 0.48 : 0.30);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a + Math.PI / 2) * w, cy + Math.sin(a + Math.PI / 2) * w);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.lineTo(cx + Math.cos(a - Math.PI / 2) * w, cy + Math.sin(a - Math.PI / 2) * w);
    ctx.closePath();
    ctx.fill();
  }
  // Hot core.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.72)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.rng = new Rng(0xf00d);
    this.max = CONFIG.fx.maxParticles;

    this._buildParticles();
    this._buildShockwaves();
    this._buildBeams();
    this._buildFlashes();
    this._buildStarFlashes();
  }

  /* ---------------------------------------------------------------------- */

  _buildParticles() {
    const n = this.max;
    this.pPos = new Float32Array(n * 3);
    this.pCol = new Float32Array(n * 3);
    this.pSize = new Float32Array(n);
    this.pAlpha = new Float32Array(n);
    this.pVel = new Float32Array(n * 3);
    this.pLife = new Float32Array(n);
    this.pMaxLife = new Float32Array(n);
    this.pDrag = new Float32Array(n);
    this.pGrow = new Float32Array(n);
    this._cursor = 0;
    this._aliveCount = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1));
    geo.setDrawRange(0, n);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CONFIG.world.boundsRadius * 4);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makeGlowTexture(64) },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uScale: { value: 900.0 },
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uPixelRatio;
        uniform float uScale;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, aSize * uPixelRatio * uScale / max(1.0, -mv.z));
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          vec4 t = texture2D(uMap, gl_PointCoord);
          float a = t.a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(geo, mat);
    this.particles.name = 'fx-particles';
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
    this._particleGeo = geo;
  }

  _buildShockwaves() {
    this.shockwaves = [];
    const tex = makeRingTexture();
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.frustumCulled = false;
      this.scene.add(sp);
      this.shockwaves.push({ sprite: sp, life: 0, maxLife: 1, from: 1, to: 2 });
    }
  }

  _buildBeams() {
    this.beams = [];
    const geo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
    geo.rotateX(Math.PI / 2);          // align along -Z
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.beams.push({ mesh, life: 0, maxLife: 1 });
    }
  }

  _buildStarFlashes() {
    this.starFlashes = [];
    const tex = makeStarTexture();
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.frustumCulled = false;
      this.scene.add(sp);
      this.starFlashes.push({ sprite: sp, life: 0, maxLife: 1, from: 1, to: 2, spin: 0 });
    }
  }

  _buildFlashes() {
    this.flashes = [];
    const tex = makeGlowTexture(64);
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.frustumCulled = false;
      this.scene.add(sp);
      this.flashes.push({ sprite: sp, life: 0, maxLife: 1, from: 1, to: 2 });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Particle spawner                                                       */
  /* ---------------------------------------------------------------------- */

  _emit(x, y, z, vx, vy, vz, color, size, life, drag = 1.6, grow = 0) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.max;

    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    this.pVel[i3] = vx; this.pVel[i3 + 1] = vy; this.pVel[i3 + 2] = vz;

    const c = _v.set(color);
    // THREE.Color#set accepts a hex number; copy channels directly.
    const col = new THREE.Color(color);
    this.pCol[i3] = col.r; this.pCol[i3 + 1] = col.g; this.pCol[i3 + 2] = col.b;

    this.pSize[i] = size;
    this.pAlpha[i] = 1;
    this.pLife[i] = life;
    this.pMaxLife[i] = life;
    this.pDrag[i] = drag;
    this.pGrow[i] = grow;
    return i;
  }

  /** A spherical detonation with a shockwave and debris. */
  explosion(position, radius = 60, color = 0xffb060) {
    const n = radius > 220 ? CONFIG.fx.explosionParticles.huge
      : radius > 120 ? CONFIG.fx.explosionParticles.large
        : radius > 45 ? CONFIG.fx.explosionParticles.medium
          : CONFIG.fx.explosionParticles.small;

    const speed = radius * 2.4;
    for (let i = 0; i < n; i++) {
      const u = this.rng.range(-1, 1);
      const th = this.rng.range(0, Math.PI * 2);
      const s = Math.sqrt(1 - u * u);
      const mag = speed * this.rng.range(0.25, 1.0);
      // Reference explosions are flat white, not orange (research 03).
      const tint = this.rng.next() < 0.7 ? 0xffffff : 0xdfefff;
      this._emit(
        position.x, position.y, position.z,
        Math.cos(th) * s * mag, u * mag, Math.sin(th) * s * mag,
        tint,
        radius * this.rng.range(0.35, 0.9),
        this.rng.range(0.45, 1.5),
        this.rng.range(1.1, 2.4),
        radius * 0.25,
      );
    }
    this.shockwave(position, radius * 2.1, 0xffffff);
    this.starFlash(position, radius * 1.9, 0.42);
  }

  /** Small hit spark. */
  impact(position, color = 0xffe0a0, size = 12) {
    for (let i = 0; i < 8; i++) {
      this._emit(
        position.x, position.y, position.z,
        this.rng.jitter(size * 4), this.rng.jitter(size * 4), this.rng.jitter(size * 4),
        color, size * this.rng.range(0.5, 1.2), this.rng.range(0.12, 0.3), 3.0, 0,
      );
    }
    this.flash(position, size * 1.6, color, 0.14);
  }

  /** Missile/torpedo smoke trail puff. */
  trail(position, color = 0xffcf7a, size = 3, life = 0.8) {
    this._emit(
      position.x, position.y, position.z,
      this.rng.jitter(1.5), this.rng.jitter(1.5), this.rng.jitter(1.5),
      color, size, life, 1.0, size * 1.4,
    );
  }

  /** Brief bright sprite, used for muzzle flashes and secondary explosions. */
  flash(position, size, color, life = 0.18) {
    const slot = this.flashes.find((f) => f.life <= 0) || this.flashes[0];
    slot.sprite.position.copy(position);
    slot.sprite.material.color = new THREE.Color(color);
    slot.sprite.material.opacity = 0.95;
    slot.sprite.visible = true;
    slot.from = size * 0.35;
    slot.to = size;
    slot.maxLife = life;
    slot.life = life;
    slot.sprite.scale.setScalar(slot.from);
  }

  /** Flat white star burst — the reference's explosion signature. */
  starFlash(position, size, life = 0.42) {
    const slot = this.starFlashes.find((f) => f.life <= 0) || this.starFlashes[0];
    slot.sprite.position.copy(position);
    slot.sprite.material.color = new THREE.Color(0xffffff);
    slot.sprite.material.opacity = 1;
    slot.sprite.material.rotation = this.rng.range(0, Math.PI * 2);
    slot.sprite.visible = true;
    slot.from = size * 0.25;
    slot.to = size;
    slot.maxLife = life;
    slot.life = life;
    slot.spin = this.rng.jitter(0.8);
    slot.sprite.scale.setScalar(slot.from);
    return slot;
  }

  /** Muzzle flash along a firing direction. */
  muzzleFlash(position, direction, size, color) {
    this.flash(position, size * 2.4, color, 0.12);
    for (let i = 0; i < 6; i++) {
      this._emit(
        position.x, position.y, position.z,
        direction.x * size * 6 + this.rng.jitter(size * 2),
        direction.y * size * 6 + this.rng.jitter(size * 2),
        direction.z * size * 6 + this.rng.jitter(size * 2),
        color, size * this.rng.range(0.4, 1.0), this.rng.range(0.08, 0.2), 3.5, 0,
      );
    }
  }

  /** Expanding ring. */
  shockwave(position, radius, color = 0xffffff) {
    const slot = this.shockwaves.find((s) => s.life <= 0) || this.shockwaves[0];
    slot.sprite.position.copy(position);
    slot.sprite.material.color = new THREE.Color(color);
    slot.sprite.material.opacity = 0.8;
    slot.sprite.visible = true;
    slot.from = radius * 0.12;
    slot.to = radius;
    slot.maxLife = 0.85;
    slot.life = 0.85;
    slot.sprite.scale.setScalar(slot.from);
  }

  /**
   * The wave motion gun: a huge additive beam that sweeps forward, plus a
   * muzzle bloom and a line of secondary detonations along its length.
   */
  waveMotionBeam(origin, direction, spec, power = 1) {
    const slot = this.beams.find((b) => b.life <= 0) || this.beams[0];
    const length = spec.range * 0.85;
    const radius = (spec.beamRadius || 24) * (0.7 + power * 0.6);

    slot.mesh.position.copy(origin).addScaledVector(direction, length * 0.5);
    _v.copy(origin).add(direction);
    _m.lookAt(origin, _v, new THREE.Vector3(0, 1, 0));
    slot.mesh.quaternion.setFromRotationMatrix(_m);
    slot.mesh.scale.set(radius, radius, length);
    slot.mesh.material.color = new THREE.Color(spec.color || 0xcfefff);
    slot.mesh.material.opacity = 0.55;
    slot.mesh.visible = true;
    slot.maxLife = 0.5;
    slot.life = 0.5;

    // Muzzle bloom + a chain of detonations down the beam's path.
    this.flash(origin, radius * 3.2, 0xffffff, 0.30);
    this.shockwave(origin, radius * 5, spec.color || 0xcfefff);
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      _v.copy(origin).addScaledVector(direction, length * t);
      this.explosion(_v.clone(), radius * this.rng.range(0.5, 1.2), spec.color || 0xcfefff);
    }
  }

  /* ---------------------------------------------------------------------- */

  update(dt) {
    // --- Particles --------------------------------------------------------
    const pos = this.pPos, vel = this.pVel, life = this.pLife;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) { this.pAlpha[i] = 0; continue; }
      life[i] -= dt;
      if (life[i] <= 0) { this.pAlpha[i] = 0; this.pSize[i] = 0; continue; }
      alive++;

      const i3 = i * 3;
      const drag = Math.exp(-this.pDrag[i] * dt);
      vel[i3] *= drag; vel[i3 + 1] *= drag; vel[i3 + 2] *= drag;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      const t = life[i] / this.pMaxLife[i];          // 1 → 0
      this.pAlpha[i] = t * t;
      if (this.pGrow[i]) this.pSize[i] += this.pGrow[i] * dt;
    }
    this._aliveCount = alive;

    this._particleGeo.attributes.position.needsUpdate = true;
    this._particleGeo.attributes.aColor.needsUpdate = true;
    this._particleGeo.attributes.aSize.needsUpdate = true;
    this._particleGeo.attributes.aAlpha.needsUpdate = true;

    // --- Shockwaves -------------------------------------------------------
    for (const s of this.shockwaves) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const t = 1 - Math.max(0, s.life) / s.maxLife;    // 0 → 1
      const scale = s.from + (s.to - s.from) * (1 - Math.pow(1 - t, 2.2));
      s.sprite.scale.setScalar(scale);
      s.sprite.material.opacity = 0.85 * (1 - t) * (1 - t);
      if (s.life <= 0) { s.sprite.visible = false; s.sprite.material.opacity = 0; }
    }

    // --- Flashes ----------------------------------------------------------
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = 1 - Math.max(0, f.life) / f.maxLife;
      f.sprite.scale.setScalar(f.from + (f.to - f.from) * Math.min(1, t * 2.5));
      f.sprite.material.opacity = 0.95 * (1 - t);
      if (f.life <= 0) { f.sprite.visible = false; f.sprite.material.opacity = 0; }
    }

    // --- Star bursts ------------------------------------------------------
    for (const f of this.starFlashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = 1 - Math.max(0, f.life) / f.maxLife;
      // Instant to full size, then fade — matches the measured timing.
      f.sprite.scale.setScalar(f.from + (f.to - f.from) * Math.min(1, t * 4.5));
      f.sprite.material.rotation += f.spin * dt;
      f.sprite.material.opacity = Math.max(0, 1 - t * t);
      if (f.life <= 0) { f.sprite.visible = false; f.sprite.material.opacity = 0; }
    }

    // --- Beams ------------------------------------------------------------
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const t = 1 - Math.max(0, b.life) / b.maxLife;
      b.mesh.material.opacity = 0.55 * (1 - t) * (1 - t);
      const r = b.mesh.scale.x * (1 + dt * 0.6);
      b.mesh.scale.x = r; b.mesh.scale.y = r;
      if (b.life <= 0) { b.mesh.visible = false; b.mesh.material.opacity = 0; }
    }
  }

  get particleCount() { return this._aliveCount; }

  clear() {
    this.pLife.fill(0);
    this.pAlpha.fill(0);
    this.pSize.fill(0);
    for (const s of this.shockwaves) { s.life = 0; s.sprite.visible = false; }
    for (const f of this.flashes) { f.life = 0; f.sprite.visible = false; }
    for (const f of this.starFlashes) { f.life = 0; f.sprite.visible = false; }
    for (const b of this.beams) { b.life = 0; b.mesh.visible = false; }
    this._particleGeo.attributes.aAlpha.needsUpdate = true;
    this._particleGeo.attributes.aSize.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.particles);
    this._particleGeo.dispose();
    this.particles.material.dispose();
    for (const s of this.shockwaves) { this.scene.remove(s.sprite); s.sprite.material.dispose(); }
    for (const f of this.flashes) { this.scene.remove(f.sprite); f.sprite.material.dispose(); }
    for (const f of this.starFlashes) { this.scene.remove(f.sprite); f.sprite.material.dispose(); }
    for (const b of this.beams) { this.scene.remove(b.mesh); b.mesh.material.dispose(); }
  }
}

export default Effects;
