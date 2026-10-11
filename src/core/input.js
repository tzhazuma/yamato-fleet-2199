/**
 * src/core/input.js — keyboard + mouse state (SPEC §6.9).
 *
 * Edge-triggered queries (`consumePressed`) are how weapons fire, so holding a
 * key never auto-repeats a salvo. Continuous queries (`isDown`) drive flight.
 */

import { CONFIG } from './config.js';

export class Input {
  constructor(targetEl = window) {
    this.target = targetEl;
    this.keys = new Set();
    this.pressed = new Set();       // consumed once per physical press
    this.mouse = { dx: 0, dy: 0, left: false, right: false, wheel: 0, x: 0, y: 0 };
    this._pressedLeft = false;
    this._pressedRight = false;
    this._enabled = true;
    this._bound = [];
    this._install();
  }

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this._bound.push([el, type, fn, opts]);
  }

  _install() {
    const keyDown = (e) => {
      if (!this._enabled) return;
      // Never swallow browser devtools / reload shortcuts.
      if (e.ctrlKey || e.metaKey) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    };
    const keyUp = (e) => { this.keys.delete(e.code); };
    const blur = () => { this.keys.clear(); this.mouse.left = false; this.mouse.right = false; };

    this._on(window, 'keydown', keyDown);
    this._on(window, 'keyup', keyUp);
    this._on(window, 'blur', blur);

    const el = this.target === window ? window : this.target;
    this._on(el, 'mousemove', (e) => {
      if (!this._enabled) return;
      if (document.pointerLockElement) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      } else if (e.buttons) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    });
    this._on(el, 'mousedown', (e) => {
      if (e.button === 0) { this.mouse.left = true; this._pressedLeft = true; }
      if (e.button === 2) { this.mouse.right = true; this._pressedRight = true; }
    });
    this._on(window, 'mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    this._on(el, 'contextmenu', (e) => e.preventDefault());
    this._on(el, 'wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    // Pointer lock: click the canvas to capture the mouse for turret look.
    this._on(document, 'pointerlockchange', () => { this.pointerLocked = !!document.pointerLockElement; });
  }

  requestPointerLock(el) {
    if (el && el.requestPointerLock && !document.pointerLockElement) {
      const p = el.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  releasePointerLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  setEnabled(v) { this._enabled = !!v; if (!v) this.keys.clear(); }

  isDown(code) { return this.keys.has(code); }

  /** Any of the key codes bound to `action` currently held. */
  actionDown(action) {
    const codes = CONFIG.keys[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** True once per physical press of any code bound to `action`. */
  consumeAction(action) {
    const codes = CONFIG.keys[action];
    if (!codes) return false;
    let hit = false;
    for (const c of codes) if (this.pressed.delete(c)) hit = true;
    return hit;
  }

  /** True once per physical press of an explicit key code. */
  consumePressed(code) { return this.pressed.delete(code); }

  consumeMouse(button = 'left') {
    if (button === 'left') { const v = this._pressedLeft; this._pressedLeft = false; return v; }
    const v = this._pressedRight; this._pressedRight = false; return v;
  }

  /** Read and reset the accumulated mouse delta (call once per frame). */
  takeMouseDelta() {
    const d = { dx: this.mouse.dx, dy: this.mouse.dy, wheel: this.mouse.wheel };
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    return d;
  }

  /** Drop unconsumed edge state at the end of a frame. */
  endFrame() { this.pressed.clear(); }

  dispose() {
    for (const [el, type, fn, opts] of this._bound) el.removeEventListener(type, fn, opts);
    this._bound.length = 0;
    this.keys.clear(); this.pressed.clear();
  }
}

export default Input;
