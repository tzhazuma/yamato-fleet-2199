/**
 * src/core/scene.js — renderer, post-processing, sky, lighting and the camera rig.
 *
 * Owns everything that is not simulation: the WebGL context, the bloom chain,
 * the procedural starfield/nebula, and the chase camera with shake.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from './config.js';
import { clamp, damp, lerp } from './math.js';
import { Rng } from './rng.js';

/* -------------------------------------------------------------------------- */
/* Procedural textures (no image files are shipped)                           */
/* -------------------------------------------------------------------------- */

/** Soft radial dot used for stars, engine glow and explosion sparks. */
export function makeGlowTexture(size = 64, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Blobby additive texture for nebula clouds. */
function makeNebulaTexture(seed) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const rng = new Rng(seed);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {
    const x = rng.range(size * 0.2, size * 0.8);
    const y = rng.range(size * 0.2, size * 0.8);
    const r = rng.range(size * 0.08, size * 0.32);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = rng.range(0.03, 0.11);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 1x1 white texture so additive materials never sample undefined. */
export function makeWhiteTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

const _camDir = new THREE.Vector3();

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x03040a);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      window.innerWidth / Math.max(1, window.innerHeight),
      CONFIG.camera.near,
      CONFIG.camera.far,
    );
    this.camera.position.set(0, 120, 500);

    this._buildLights();
    this._buildSky();
    this._buildComposer();

    this.clock = new THREE.Clock();
    this.shake = 0;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  /**
   * DO NOT ADD A PMREM ENVIRONMENT MAP HERE.
   *
   * An earlier revision built one with `PMREMGenerator.fromEquirectangular()`
   * and assigned it to `scene.environment`. It looked correct in isolation and
   * broke the demo: with a PMREM environment present, `EffectComposer` rendered
   * the ENTIRE 3D scene black — the sky, the player's ship and every enemy were
   * all invisible, while the DOM HUD kept working, so it read as "the ships are
   * missing". Verified by isolation: composer ON + environment NULL renders
   * everything; composer ON + environment set renders nothing; composer OFF
   * renders everything either way.
   *
   * The darkness that motivated it is fixed properly instead, by keeping
   * `metalness` low in src/render/materials.js — without an environment map a
   * high-metalness surface has nothing to reflect and goes black, which is the
   * real reason the hulls looked unlit.
   */
  _buildLights() {
    // Key light from above/front — gives the hull its readable top faces.
    const key = new THREE.DirectionalLight(0xfff2e0, 3.05);
    key.position.set(0.45, 1, 0.35).multiplyScalar(1000);
    key.name = 'keyLight';
    this.scene.add(key);
    this.keyLight = key;

    // Cool rim from behind-left separates silhouettes from the black sky.
    const rim = new THREE.DirectionalLight(0x5f8fd0, 1.15);
    rim.position.set(-0.7, -0.25, -0.8).multiplyScalar(1000);
    rim.name = 'rimLight';
    this.scene.add(rim);

    const fill = new THREE.HemisphereLight(0x24365c, 0x05070c, 0.50);
    fill.name = 'fillLight';
    this.scene.add(fill);

    // Camera-locked fill: a chase camera looks at the ship's stern, which the
    // fixed key light leaves in shadow. This keeps the visible hull readable
    // from every camera mode without flattening the key/rim contrast.
    this.camLight = new THREE.DirectionalLight(0xb4cfff, 1.55);
    this.camLight.name = 'cameraFill';
    this.camLight.target = new THREE.Object3D();
    this.scene.add(this.camLight);
    this.scene.add(this.camLight.target);

    this.scene.add(new THREE.AmbientLight(0x33436a, 0.42));
  }

  _buildSky() {
    const rng = new Rng(0x2199);

    // --- Stars -------------------------------------------------------------
    const n = CONFIG.render.starCount;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // Uniform on a sphere shell.
      const u = rng.range(-1, 1);
      const theta = rng.range(0, Math.PI * 2);
      const s = Math.sqrt(1 - u * u);
      const r = CONFIG.render.starRadius * rng.range(0.85, 1.0);
      pos[i * 3] = Math.cos(theta) * s * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = Math.sin(theta) * s * r;
      // Mostly white/blue-white with a few warm ones.
      const t = rng.next();
      if (t < 0.12) c.setHSL(0.07, 0.55, rng.range(0.6, 0.85));
      else if (t < 0.45) c.setHSL(0.58, rng.range(0.1, 0.4), rng.range(0.7, 0.95));
      else c.setHSL(0.6, rng.range(0, 0.12), rng.range(0.8, 1.0));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = rng.range(320, 1500);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

    const glow = makeGlowTexture(64);
    const starMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: glow }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: `
        attribute float aSize;
        varying vec3 vColor;
        uniform float uPixelRatio;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uPixelRatio / max(1.0, -mv.z) * 60.0, 1.0, 12.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          if (t.a < 0.02) discard;
          gl_FragColor = vec4(vColor * t.a, t.a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.stars.name = 'starfield';
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // --- Nebula ------------------------------------------------------------
    if (CONFIG.render.nebula) {
      this.nebula = new THREE.Group();
      this.nebula.name = 'nebula';
      const tints = [0x2a4a8f, 0x6a2a6f, 0x1f5a6a, 0x8f4a2a];
      for (let i = 0; i < 4; i++) {
        const tex = makeNebulaTexture(0x1000 + i);
        const mat = new THREE.SpriteMaterial({
          map: tex, transparent: true, depthWrite: false, depthTest: false,
          blending: THREE.AdditiveBlending, color: tints[i], opacity: 0.34,
        });
        const sp = new THREE.Sprite(mat);
        const ang = (i / 4) * Math.PI * 2 + 0.6;
        const dist = CONFIG.render.starRadius * 0.8;
        sp.position.set(Math.cos(ang) * dist, rng.range(-0.25, 0.25) * dist, Math.sin(ang) * dist);
        sp.scale.setScalar(CONFIG.render.starRadius * rng.range(0.55, 0.95));
        this.nebula.add(sp);
      }
      this.scene.add(this.nebula);
    }
  }

  _buildComposer() {
    const { bloom } = CONFIG.render;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio));

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // The resolution argument is a placeholder: `composer.setSize()` below
    // resizes every pass to the device-pixel resolution.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      bloom.strength, bloom.radius, bloom.threshold,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.useComposer = true;

    // A bloom pass whose render targets do not match the composer's is the one
    // configuration observed to black out the WHOLE scene (it cost a long
    // debugging session). `UnrealBloomPass.setSize()` resizes renderTargetBright
    // and the mip chain but never updates `.resolution`, so that is what we
    // check. Expected relationship: bright RT == composer RT / 2.
    this.checkComposerSizing();
  }

  /**
   * Sanity-check that the bloom pass and the composer agree on resolution.
   * A mismatch renders the entire 3D scene black while the DOM HUD keeps
   * working, which reads as "the ships have disappeared".
   * @returns {{ok:boolean, composer?:number[], bloom?:number[], reason?:string}}
   */
  checkComposerSizing() {
    const rt = this.composer?.renderTarget1;
    const bright = this.bloomPass?.renderTargetBright;
    if (!rt || !bright) return { ok: true, reason: 'no bloom pass' };
    const expectedW = Math.round(rt.width / 2);
    const expectedH = Math.round(rt.height / 2);
    const ok = Math.abs(bright.width - expectedW) <= 2 && Math.abs(bright.height - expectedH) <= 2;
    if (!ok) {
      console.warn('[scene] bloom/composer size mismatch — the scene may render black',
        { composer: [rt.width, rt.height], bloomBright: [bright.width, bright.height], expected: [expectedW, expectedH] });
    }
    return { ok, composer: [rt.width, rt.height], bloom: [bright.width, bright.height] };
  }

  resize() {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    // ONLY the composer may size its passes. `EffectComposer.setSize(w, h)`
    // already forwards the DEVICE-pixel size (w * pixelRatio) to every pass;
    // calling `bloomPass.setSize(w, h)` afterwards with CSS pixels left
    // UnrealBloomPass at half the composer's render-target size, and in that
    // state it rendered the entire scene black.
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    if (this.stars?.material?.uniforms?.uPixelRatio) {
      this.stars.material.uniforms.uPixelRatio.value = pr;
    }
  }

  /** Sky and nebula follow the camera so the backdrop never runs out. */
  followCamera() {
    if (this.stars) this.stars.position.copy(this.camera.position);
    if (this.nebula) this.nebula.position.copy(this.camera.position);
    if (this.camLight) {
      this.camLight.position.copy(this.camera.position);
      this.camera.getWorldDirection(_camDir);
      this.camLight.target.position.copy(this.camera.position).addScaledVector(_camDir, 500);
      this.camLight.target.updateMatrixWorld();
    }
  }

  addShake(amount) { this.shake = Math.min(3.5, this.shake + amount); }

  updateShake(dt) {
    this.shake = damp(this.shake, 0, CONFIG.camera.shakeDecay, dt);
    return this.shake;
  }

  render() {
    if (this.useComposer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.envRT?.dispose?.();
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* Camera rig                                                                 */
/* -------------------------------------------------------------------------- */

export class CameraRig {
  constructor(sceneManager) {
    this.sm = sceneManager;
    this.mode = 'chase';
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this._desired = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmpF = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._currentLookAt = new THREE.Vector3();
  }

  cycleMode() {
    const modes = CONFIG.camera.modes;
    this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
    return this.mode;
  }

  addOrbit(dx, dy) {
    this.orbitYaw += dx * CONFIG.camera.orbitSpeed;
    this.orbitPitch = clamp(this.orbitPitch + dy * CONFIG.camera.orbitSpeed, -0.85, 0.85);
  }

  /** Snap straight behind the ship (used on spawn / respawn). */
  snapTo(ship) {
    this._computeDesired(ship);
    this.sm.camera.position.copy(this._desired);
    this._currentLookAt.copy(this._lookAt);
    this.sm.camera.lookAt(this._currentLookAt);
  }

  _computeDesired(ship) {
    const c = CONFIG.camera;
    const offset = this._tmp.set(0, c.chaseHeight, c.chaseDistance);

    if (this.mode === 'chase') {
      offset.applyQuaternion(this._tmpQ.copy(ship.quaternion));
      // Damp the roll so the horizon does not spin with the ship.
      const e = new THREE.Euler().setFromQuaternion(this._tmpQ, 'YXZ');
      e.z *= 0.25;
      this._tmpQ.setFromEuler(e);
      offset.set(0, c.chaseHeight, c.chaseDistance).applyQuaternion(this._tmpQ);
      // Free-look offset.
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
      offset.applyAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitPitch * 0.6);
    } else if (this.mode === 'orbit') {
      offset.set(0, c.chaseHeight * 1.4, c.chaseDistance * 1.5);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw + performance.now() * 0.00004);
      offset.applyAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitPitch);
    } else {
      // Cinematic: low, wide, slightly ahead of the beam.
      offset.set(0, c.chaseHeight * 0.35, c.chaseDistance * 1.9);
      offset.applyQuaternion(this._tmpQ.copy(ship.quaternion));
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
    }

    this._desired.copy(ship.position).add(offset);

    // NOTE: `offset` IS `this._tmp`, so the forward vector must use a DIFFERENT
    // scratch — reusing `_tmp` here silently overwrote the offset before the
    // final addScaledVector below.
    const forward = this._tmpF.set(0, 0, -1).applyQuaternion(ship.quaternion);
    this._lookAt.copy(ship.position).addScaledVector(forward, c.lookAhead * 0.08);
  }

  update(dt, ship) {
    if (!ship) return;
    this._computeDesired(ship);
    const lag = CONFIG.camera.chaseLag * (this.mode === 'cinematic' ? 0.6 : 1);
    this.sm.camera.position.lerp(this._desired, 1 - Math.exp(-lag * dt));

    const lookLag = 1 - Math.exp(-(lag * 1.5) * dt);
    this._currentLookAt.lerp(this._lookAt, lookLag);
    this.sm.camera.lookAt(this._currentLookAt);

    // Shake: applied after lookAt so it is pure positional noise.
    const s = this.sm.updateShake(dt);
    if (s > 0.001) {
      const t = performance.now() * 0.001;
      this.sm.camera.position.x += Math.sin(t * 43.1) * s * 5;
      this.sm.camera.position.y += Math.sin(t * 57.7) * s * 5;
      this.sm.camera.position.z += Math.sin(t * 61.3) * s * 5;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Projection helper for the DOM HUD                                          */
/* -------------------------------------------------------------------------- */

const _proj = new THREE.Vector3();

/**
 * Project a world position to CSS pixels.
 * @returns {{x:number,y:number,visible:boolean,depth:number}}
 */
export function projectToScreen(worldPos, camera, width, height) {
  _proj.copy(worldPos).project(camera);
  const behind = _proj.z > 1;
  return {
    x: (_proj.x * 0.5 + 0.5) * width,
    y: (-_proj.y * 0.5 + 0.5) * height,
    depth: _proj.z,
    visible: !behind && _proj.x >= -1.4 && _proj.x <= 1.4 && _proj.y >= -1.4 && _proj.y <= 1.4,
  };
}

export { lerp };
