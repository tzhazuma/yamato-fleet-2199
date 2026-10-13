/**
 * YAMATO FLEET 2199 — src/ui/hud.js  (owner: engine-dev)
 *
 * DOM/CSS heads-up display (SPEC §6.5). Builds its whole subtree inside the
 * root element supplied by index.html (`<div id="hud">`) and injects its own
 * stylesheet once. Deliberately not canvas: crisp text, cheap updates, and the
 * browser handles layout.
 *
 * Frozen interface (SPEC §6.5):
 *   class Hud {
 *     constructor(rootEl, world)
 *     update(dt, world): void       // called every frame after simulation
 *     pushEvent(evt): void          // 'kill'|'hit'|'wave'|'warning'|'info'
 *     dispose(): void
 *   }
 *
 * Extras (additive, safe to ignore): setPaused(bool), setOutcome('victory'|
 * 'defeat'|null), showBanner(title, sub, ms), showWarning(text, ms),
 * setVisible(bool).
 *
 * Layout (all non-interactive, pointer-events:none):
 *   top-left      tactical radar (owned by src/ui/radar.js)
 *   top-centre    mission strip
 *   top-right     target panel
 *   centre        small bow crosshair + wave-motion-gun charge ring
 *   on target     projected target marker (brackets + callsign + range)
 *   bottom-left   ship status + WEAPONS panel (key, name, live state)
 *   bottom-centre controls legend (auto-dims in combat)
 *   bottom-right  kill feed (hidden entirely while empty)
 *
 * Every read is defensive: a missing field, a missing camera, a dead player or
 * a garbage event must never throw.
 */

import { CONFIG } from '../core/config.js';
import { clamp, clamp01, damp, ema, formatDistance, formatTime } from '../core/math.js';
import { projectToScreen } from '../core/scene.js';

const STYLE_ID = 'yfh-style';

/* ───────────────────────────────────────────────────────────── stylesheet ── */

const CSS = `
.yfh, .yfh * { box-sizing: border-box; }
.yfh {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans JP", monospace;
  color: #eaf4ff; font-size: 12px; line-height: 1.25;
  --c-cyan: #8fe8ff; --c-amber: #ffc06a; --c-red: #ff6b6b; --c-green: #9dffae;
  --c-dim: #b9d2ea; --c-faint: rgba(185, 210, 234, 0.62);
  --panel-bg: linear-gradient(180deg, rgba(6, 14, 26, 0.80), rgba(4, 9, 18, 0.66));
  --panel-line: rgba(140, 205, 255, 0.34);
  text-shadow: 0 1px 2px #000, 0 0 6px rgba(0, 0, 0, 0.9);
  user-select: none; -webkit-user-select: none;
}
.yfh-panel {
  position: absolute; padding: 9px 11px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-line);
  border-radius: 3px;
}
.yfh-panel::before {
  content: ''; position: absolute; left: -1px; top: -1px; width: 16px; height: 2px;
  background: var(--c-cyan); opacity: .95;
}
.yfh-label { font-size: 10px; letter-spacing: .2em; color: var(--c-dim); text-transform: uppercase; }
.yfh-value { font-variant-numeric: tabular-nums; }
.yfh-hint { font-size: 9.5px; letter-spacing: .12em; color: var(--c-faint); }

/* ── centre reticle: small, reads as "where the bow points" ──────────── */
.yfh-reticle { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px 0 0 -29px; }
.yfh-ret-dot { position: absolute; left: 50%; top: 50%; width: 3px; height: 3px; margin: -1.5px 0 0 -1.5px; border-radius: 50%; background: rgba(225, 244, 255, 0.9); }
.yfh-ret-cross { position: absolute; left: 50%; top: 50%; width: 17px; height: 1px; margin: -0.5px 0 0 -8.5px; background: rgba(200, 232, 255, 0.55); }
.yfh-ret-cross.v { width: 1px; height: 17px; margin: -8.5px 0 0 -0.5px; }
.yfh-ret-tick { position: absolute; background: rgba(200, 232, 255, 0.45); }
.yfh-ret-tick.t { left: 50%; top: 0; width: 1px; height: 6px; margin-left: -.5px; }
.yfh-ret-tick.b { left: 50%; bottom: 0; width: 1px; height: 6px; margin-left: -.5px; }
.yfh-ret-tick.l { top: 50%; left: 0; height: 1px; width: 6px; margin-top: -.5px; }
.yfh-ret-tick.r { top: 50%; right: 0; height: 1px; width: 6px; margin-top: -.5px; }
.yfh-reticle.is-locked .yfh-ret-dot { background: var(--c-red); box-shadow: 0 0 5px rgba(255, 90, 90, .9); }
.yfh-reticle.is-locked .yfh-ret-cross,
.yfh-reticle.is-locked .yfh-ret-tick { background: rgba(255, 150, 150, 0.75); }
.yfh-ret-charge {
  position: absolute; inset: -9px; border-radius: 50%; opacity: 0;
  background: conic-gradient(from -90deg, var(--c-cyan) calc(var(--p, 0) * 1%), rgba(120, 190, 255, 0.10) 0);
  -webkit-mask: radial-gradient(circle, transparent 0 44%, #000 46% 55%, transparent 57%);
  mask: radial-gradient(circle, transparent 0 44%, #000 46% 55%, transparent 57%);
  transition: opacity .15s ease;
}
.yfh-ret-charge.on { opacity: .9; }
.yfh-ret-charge.is-ready { filter: drop-shadow(0 0 6px rgba(150, 235, 255, .95)); }

/* ── projected target marker ─────────────────────────────────────────── */
.yfh-tmark { position: absolute; left: -999px; top: -999px; width: 46px; height: 46px; margin: -23px 0 0 -23px; opacity: 0; transition: opacity .12s ease; }
.yfh-tmark.show { opacity: 1; }
.yfh-tmark.is-edge { width: 34px; height: 34px; margin: -17px 0 0 -17px; }
.yfh-tmark .yfh-tm-box { position: absolute; inset: 0; }
.yfh-tmark .yfh-tm-box i { position: absolute; width: 11px; height: 11px; border: 1.6px solid var(--c-red); }
.yfh-tmark .yfh-tm-box i:nth-child(1) { left: 0; top: 0; border-right: 0; border-bottom: 0; }
.yfh-tmark .yfh-tm-box i:nth-child(2) { right: 0; top: 0; border-left: 0; border-bottom: 0; }
.yfh-tmark .yfh-tm-box i:nth-child(3) { right: 0; bottom: 0; border-left: 0; border-top: 0; }
.yfh-tmark .yfh-tm-box i:nth-child(4) { left: 0; bottom: 0; border-right: 0; border-top: 0; }
.yfh-tmark.is-edge .yfh-tm-box { display: none; }
.yfh-tmark .yfh-tm-arrow {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0; margin: -8px 0 0 -7px; display: none;
  border-left: 7px solid transparent; border-right: 7px solid transparent; border-bottom: 13px solid var(--c-red);
  transform: rotate(var(--rot, 0deg));
}
.yfh-tmark.is-edge .yfh-tm-arrow { display: block; }
.yfh-tmark .yfh-tm-label {
  position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 3px;
  white-space: nowrap; font-size: 10.5px; letter-spacing: .08em; color: #ffd9d9;
  padding: 1px 4px; background: rgba(6, 14, 26, 0.78);
  border: 1px solid rgba(255, 130, 130, 0.4); border-radius: 2px;
}
.yfh-tmark.is-edge .yfh-tm-label { top: auto; bottom: 100%; margin: 0 0 3px; }

/* ── left column: status + weapons ───────────────────────────────────── */
.yfh-bottomleft {
  position: absolute; left: 18px; bottom: 18px; width: 286px;
  display: flex; flex-direction: column-reverse; gap: 8px;
}
.yfh-bottomleft .yfh-panel { position: static; }
.yfh-name { font-size: 14px; letter-spacing: .12em; color: #f2f8ff; margin-bottom: 1px; }
.yfh-name span { font-size: 10px; letter-spacing: .1em; color: var(--c-faint); }
.yfh-bar { margin-top: 6px; }
.yfh-bar-head { display: flex; justify-content: space-between; font-size: 10px; letter-spacing: .16em; color: var(--c-dim); }
.yfh-bar-track { position: relative; height: 6px; margin-top: 2px; background: rgba(4, 10, 20, 0.92); border: 1px solid rgba(140, 205, 255, 0.26); }
.yfh-bar-fill { position: absolute; inset: 0 auto 0 0; width: 0%; transition: width .12s linear; }
.yfh-bar-fill.shield { background: linear-gradient(90deg, #2f8fd0, #8fe8ff); }
.yfh-bar-fill.armor { background: linear-gradient(90deg, #b07a2a, #ffd489); }
.yfh-bar-fill.hull { background: linear-gradient(90deg, #2f9c5a, #9dffae); }
.yfh-bar-fill.hull.warn { background: linear-gradient(90deg, #b0702a, #ffc06a); }
.yfh-bar-fill.hull.crit { background: linear-gradient(90deg, #a02424, #ff6b6b); }
.yfh-pips { display: flex; gap: 5px; margin-top: 9px; flex-wrap: wrap; }
.yfh-pip {
  padding: 2px 5px; font-size: 9px; letter-spacing: .1em;
  border: 1px solid rgba(140, 205, 255, 0.34); color: var(--c-dim);
}
.yfh-pip.ok { border-color: rgba(157, 255, 174, 0.55); color: #ccffd6; }
.yfh-pip.hurt { border-color: rgba(255, 192, 106, 0.7); color: #ffe0b4; }
.yfh-pip.down { border-color: rgba(255, 107, 107, 0.85); color: #ffc4c4; background: rgba(120, 20, 20, 0.42); }
.yfh-readout { display: flex; justify-content: space-between; margin-top: 9px; font-size: 10.5px; color: var(--c-dim); }
.yfh-readout b { color: #f2f8ff; font-weight: 500; }

/* ── weapons panel ───────────────────────────────────────────────────── */
.yfh-wrow { display: grid; grid-template-columns: auto 1fr; gap: 1px 7px; align-items: center; margin-top: 8px; }
.yfh-wrow:first-of-type { margin-top: 6px; }
.yfh-key { grid-row: 1; grid-column: 1; }
.yfh-key {
  display: inline-block; min-width: 34px; padding: 1px 4px; text-align: center;
  font-size: 9.5px; letter-spacing: .06em; color: #06121f;
  background: linear-gradient(180deg, #dff1ff, #a9cbe6);
  border: 1px solid rgba(255, 255, 255, 0.55); border-radius: 2px;
  text-shadow: none;
}
.yfh-key.none { background: none; border-color: rgba(140, 205, 255, 0.3); color: var(--c-faint); }
.yfh-wname { grid-row: 1; grid-column: 2; font-size: 10px; letter-spacing: .03em; color: #eef7ff; }
.yfh-wstate { grid-row: 2; grid-column: 1 / -1; font-size: 9.5px; letter-spacing: .08em; color: var(--c-dim); text-align: right; white-space: nowrap; }
.yfh-wstate i { font-style: normal; color: var(--c-faint); }
.yfh-wstate b { font-weight: 400; }
.yfh-wrow.ready .yfh-wstate { color: var(--c-green); }
.yfh-wrow.cool .yfh-wstate { color: var(--c-dim); }
.yfh-wrow.charge .yfh-wstate { color: var(--c-cyan); }
.yfh-wrow.down .yfh-wstate { color: var(--c-red); }
.yfh-wrow.down .yfh-wname { color: rgba(255, 160, 160, 0.75); }
.yfh-wbar { grid-row: 3; grid-column: 1 / -1; height: 3px; background: rgba(4, 10, 20, 0.92); border: 1px solid rgba(140, 205, 255, 0.2); }
.yfh-wbar i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #2f8fd0, #8fe8ff); transition: width .1s linear; }
.yfh-wrow.down .yfh-wbar i { background: #7a2a2a; }
.yfh-wrow.charge .yfh-wbar i { background: linear-gradient(90deg, #4fc3ff, #e8fbff); }
.yfh-wrow.is-wmg { margin-top: 9px; padding-top: 7px; border-top: 1px solid rgba(140, 205, 255, 0.22); }
.yfh-wrow.is-wmg .yfh-wbar { height: 6px; }
.yfh-wrow.is-wmg .yfh-wbar i { background: linear-gradient(90deg, #2f8fd0, #bff0ff); box-shadow: 0 0 6px rgba(150, 235, 255, .5); }

/* ── firing-direction indicator ──────────────────────────────────────────
   DO NOT go back to a full-viewport <div> with an "opacity" transition
   wrapping a full-viewport child with "clip-path". That combination promotes
   the element to its own compositing layer, and in Chrome it blanked the WebGL
   canvas underneath across the whole layer bounds — a large black rectangle
   over the scene, which the user reported as "莫名其妙的黑色遮挡" and which
   also hid the enemy ships. It is now an SVG whose polygon is repainted each
   frame: no clip-path anywhere, and no opacity on a full-screen element, so
   nothing is promoted and the canvas composites normally.
   ─────────────────────────────────────────────────────────────────────── */
.yfh-arc { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
.yfh-arc.show { visibility: visible; }
.yfh-arc-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.yfh-arc-wedge { fill: var(--c-arc-in); }
.yfh-arc.is-out .yfh-arc-wedge { fill: var(--c-arc-out); }
.yfh-arc-edge { stroke: var(--c-arc-in); stroke-width: 1.5; }
.yfh-arc.is-out .yfh-arc-edge { stroke: var(--c-arc-out); }
.yfh-arc-axis { stroke: var(--c-arc-axis); stroke-width: 1; opacity: .55; }
/* Weapon-range ring: the WoW-style "this is how far this weapon reaches" circle. */
.yfh-range { fill: none; stroke: var(--c-arc-in); stroke-width: 1.2; opacity: .38; }
.yfh-arc.is-out .yfh-range { stroke: var(--c-arc-out); opacity: .30; }
.yfh-range-far { fill: none; stroke: var(--c-arc-axis); stroke-width: 1; opacity: .22; }
.yfh-mounts { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transition: opacity .18s ease; }
.yfh-mounts.show { opacity: 1; }
.yfh-tick {
  position: absolute; left: 0; top: 0; width: 2px; height: 7px; border-radius: 1px;
  background: var(--c-mount-blocked); transform: translate(-50%, -50%) rotate(0deg) translateY(-38px);
}
.yfh-tick.is-slew { background: var(--c-mount-slew); }
.yfh-tick.is-ready { background: var(--c-mount-ready); }
.yfh-tick-ghost {
  position: absolute; left: 0; top: 0; width: 1px; height: 5px;
  background: var(--c-mount-ghost); transform: translate(-50%, -50%) rotate(0deg) translateY(-38px);
}
.yfh-lead { position: absolute; left: -999px; top: -999px; width: 24px; height: 24px; margin: -12px 0 0 -12px; opacity: 0; transition: opacity .12s ease; }
.yfh-lead.show { opacity: 1; }
.yfh-lead i { position: absolute; inset: 2px; border: 1.4px solid var(--c-lead); transform: rotate(45deg); }
.yfh-lead b { position: absolute; left: 50%; top: 50%; width: 3px; height: 3px; margin: -1.5px 0 0 -1.5px; border-radius: 50%; background: var(--c-lead); }

/* ── firing-mode chip ────────────────────────────────────────────────── */
.yfh-mode {
  position: absolute; left: 50%; top: calc(50% + 56px); transform: translateX(-50%);
  display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px;
  border: 1px solid rgba(140, 205, 255, 0.42); border-radius: 3px;
  background: rgba(6, 14, 26, 0.78); opacity: 0; transition: opacity .2s ease;
  white-space: nowrap;
}
.yfh-mode.show { opacity: 1; }
.yfh-mode .yfh-mode-name { font-size: 12.5px; letter-spacing: .2em; color: var(--c-dim); }
.yfh-mode .yfh-mode-ja { font-size: 9.5px; letter-spacing: .1em; color: var(--c-faint); }
.yfh-mode.is-auto { border-color: rgba(120, 255, 170, 0.8); background: rgba(10, 38, 26, 0.88); }
.yfh-mode.is-auto .yfh-mode-name { color: #b6ffd0; text-shadow: 0 0 8px rgba(120, 255, 170, .5); }
.yfh-mode.is-auto .yfh-mode-ja { color: #8fe8b0; }
.yfh-mode.is-auto::after {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--c-green); box-shadow: 0 0 7px var(--c-green);
  animation: yfh-pulse 1.3s ease-in-out infinite;
}
@keyframes yfh-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }

/* ── weapons panel: mode row + bearing chip ──────────────────────────── */
.yfh-moderow {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  margin-top: 6px; padding-bottom: 6px; border-bottom: 1px solid rgba(140, 205, 255, 0.22);
}
.yfh-moderow .yfh-mode-value { font-size: 10.5px; letter-spacing: .12em; color: var(--c-dim); }
.yfh-moderow.is-auto .yfh-mode-value { color: #b6ffd0; }
.yfh-moderow .yfh-mode-value u { text-decoration: none; font-size: 9px; color: var(--c-faint); }
.yfh-wbarrow { grid-row: 3; grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; }
.yfh-wbar { flex: 1 1 auto; min-width: 40px; height: 3px; background: rgba(4, 10, 20, 0.92); border: 1px solid rgba(140, 205, 255, 0.2); }
.yfh-wbear { flex: none; font-size: 9px; letter-spacing: .06em; color: var(--c-faint); white-space: nowrap; }
.yfh-wbear.ok { color: #b6ffd0; }
.yfh-wbear.part { color: #ffd9a8; }
.yfh-wbear.none { color: #ffb0b0; }
.yfh-wrow.is-aim { background: linear-gradient(90deg, rgba(140, 205, 255, 0.12), transparent); }
.yfh-wrow.is-aim .yfh-wname { color: #ffffff; }

/* ── controls legend (auto-dims in combat) ───────────────────────────── */
.yfh-legend {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  width: max(320px, min(650px, calc(100vw - 620px)));
  display: flex; flex-wrap: wrap; justify-content: center; gap: 3px 12px;
  padding: 6px 12px; opacity: .62; transition: opacity .3s ease;
  background: linear-gradient(180deg, rgba(6, 14, 26, 0.62), rgba(4, 9, 18, 0.5));
  border: 1px solid rgba(140, 205, 255, 0.24); border-radius: 3px;
}
.yfh-leg { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.yfh-leg .k {
  display: inline-block; min-width: 15px; padding: 0 4px; text-align: center;
  font-size: 9.5px; color: #06121f; background: linear-gradient(180deg, #e6f4ff, #b6d4ea);
  border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 2px; text-shadow: none;
}
.yfh-leg .a { font-size: 9.5px; letter-spacing: .08em; color: #dbe9f8; }
@media (max-width: 900px) { .yfh-legend { display: none; } }

/* ── target panel (top right) ────────────────────────────────────────── */
.yfh-target { right: 18px; top: 18px; width: 252px; }
.yfh-target .yfh-t-name { font-size: 13px; letter-spacing: .1em; color: #fff2e2; margin-top: 3px; }
.yfh-target .yfh-t-class { font-size: 10px; color: var(--c-faint); letter-spacing: .08em; }
.yfh-target .yfh-t-dist { font-size: 17px; color: var(--c-amber); margin-top: 4px; font-variant-numeric: tabular-nums; }
.yfh-target .yfh-t-none { font-size: 10.5px; color: var(--c-faint); margin-top: 4px; letter-spacing: .08em; }
.yfh-target .yfh-bar-fill { transition: width .12s linear; }

/* ── kill feed (hidden while empty) ──────────────────────────────────── */
.yfh-feed { right: 18px; bottom: 18px; width: 274px; text-align: right; display: none; }
.yfh-feed.show { display: block; }
.yfh-feed-item { font-size: 11px; letter-spacing: .05em; color: #e2eefb; opacity: 0; transform: translateY(4px); animation: yfh-in .25s ease forwards; }
.yfh-feed-item.kill { color: #ffd489; }
.yfh-feed-item.warning { color: #ffc4c4; }
.yfh-feed-item.info { color: #c3d8ec; }
@keyframes yfh-in { to { opacity: 1; transform: none; } }

/* ── banner + warning ────────────────────────────────────────────────── */
.yfh-banner {
  position: absolute; left: 50%; top: 13%; transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity .35s ease; width: 90%;
}
.yfh-banner.show { opacity: 1; }
.yfh-banner-title { font-size: clamp(18px, 3.4vw, 34px); letter-spacing: .22em; color: #f4faff; text-shadow: 0 0 22px rgba(120, 200, 255, .6), 0 2px 4px #000; }
.yfh-banner-sub { margin-top: 5px; font-size: 11.5px; letter-spacing: .28em; color: var(--c-cyan); }
.yfh-warn {
  position: absolute; left: 50%; top: 62%; transform: translateX(-50%);
  padding: 5px 14px; font-size: 12px; letter-spacing: .18em; color: #ffe0e0;
  background: rgba(130, 22, 22, 0.55); border: 1px solid rgba(255, 130, 130, 0.7);
  opacity: 0; transition: opacity .2s ease; white-space: nowrap;
}
.yfh-warn.show { opacity: 1; }

/* ── vignette + mission strip ────────────────────────────────────────── */
.yfh-vig {
  position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse at center, rgba(255, 0, 0, 0) 42%, rgba(190, 20, 20, 0.62) 100%);
  mix-blend-mode: screen;
}
.yfh-hitdir { position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse at 50% 120%, rgba(255, 90, 60, 0.55), rgba(0,0,0,0) 60%); }
.yfh-mission { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); font-size: 10.5px; letter-spacing: .28em; color: var(--c-dim); }

/* ── overlays ────────────────────────────────────────────────────────── */
.yfh-overlay { position: absolute; inset: 0; display: none; place-items: center; background: rgba(4, 8, 16, 0.55); }
.yfh-overlay.show { display: grid; }
.yfh-card { text-align: center; padding: 26px 34px; border: 1px solid var(--panel-line); background: rgba(6, 14, 26, 0.85); }
.yfh-card h1 { margin: 0; font-size: clamp(22px, 4vw, 42px); letter-spacing: .26em; font-weight: 700; }
.yfh-card p { margin: 10px 0 0; font-size: 11.5px; letter-spacing: .18em; color: var(--c-dim); }
.yfh-card.victory h1 { color: #c2ffd8; text-shadow: 0 0 26px rgba(120, 255, 170, .5); }
.yfh-card.defeat h1 { color: #ffc4c4; text-shadow: 0 0 26px rgba(255, 90, 90, .5); }
.yfh-card.pause h1 { color: #f2f8ff; }
`;

/* ──────────────────────────────────────────────────────────── helpers ── */

function ensureStyle(doc) {
  try {
    if (!doc || !doc.head) return;
    if (doc.getElementById(STYLE_ID)) return;
    const s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    doc.head.appendChild(s);
  } catch (_) { /* styling is cosmetic — never fatal */ }
}

function make(doc, tag, cls, parent, text) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

function setText(el, str) {
  if (!el) return;
  if (el._yfh === str) return;
  el._yfh = str;
  el.textContent = str;
}

function setClass(el, cls, on) {
  if (!el) return;
  const key = '_yfh_' + cls;
  if (el[key] === on) return;
  el[key] = on;
  try { el.classList.toggle(cls, on); } catch (_) { /* ignore */ }
}

function setStyle(el, prop, val) {
  if (!el) return;
  const key = '_yfh_s_' + prop;
  if (el[key] === val) return;
  el[key] = val;
  try { el.style.setProperty(prop, val); } catch (_) { /* ignore */ }
}

function fmtInt(v) {
  const n = Number.isFinite(v) ? Math.round(v) : 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const pct = (v) => Math.round(clamp01(Number.isFinite(v) ? v : 0) * 100);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const hasVec3 = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

const SUBSYS_LABEL = {
  wmgun: 'WMG', engine: 'ENG', turret_main: 'MAIN',
  turret_secondary: 'SEC', ciws: 'CIWS', point_defense: 'PD', bridge: 'BRIDGE',
};

const OUTCOME_WORDS = {
  victory: 'victory', won: 'victory', win: 'victory', complete: 'victory', cleared: 'victory',
  defeat: 'defeat', lost: 'defeat', lose: 'defeat', dead: 'defeat', gameover: 'defeat', failed: 'defeat',
};

/** KeyboardEvent.code → short keycap label. */
function prettyKey(code) {
  if (typeof code !== 'string' || !code) return '—';
  const named = {
    Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL',
    AltLeft: 'ALT', AltRight: 'ALT', Tab: 'TAB', Enter: 'ENTER', Escape: 'ESC', Backspace: 'BKSP',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', CapsLock: 'CAPS',
  };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'NUM' + code.slice(6);
  return code.replace(/^(Left|Right)/, '').toUpperCase();
}

/**
 * Weapon id → the CONFIG.keys action that fires it. Prefer an explicit id hint,
 * then the weapon's own `kind`. Never hardcodes a key: the binding itself is
 * always read out of CONFIG.keys.
 */
const WEAPON_KEY_ACTIONS = {
  wmgun: ['waveMotionGun', 'wmgun'],
  shock_cannon: ['fireMain', 'shockCannon'],
  secondary_battery: ['fireSecondary', 'secondaryBattery'],
  torpedo: ['fireTorpedo', 'torpedo'],
  missile: ['fireMissile', 'missile', 'fireTorpedo'],
};
const KIND_KEY_ACTIONS = {
  wmgun: ['waveMotionGun'], torpedo: ['fireTorpedo'], missile: ['fireTorpedo'],
  shell: ['fireMain'], beam: ['fireMain'], pd: [],
};

/** Bilingual label from CONFIG.weapons[id].displayName ("Shock Cannon (主砲)"). */
function weaponLabel(spec, id) {
  const name = (spec && typeof spec.displayName === 'string' && spec.displayName) || String(id || '');
  const m = /^(.*?)\s*[（(]([^)）]*)[)）]\s*$/.exec(name);
  if (!m) return { main: name.toUpperCase(), ja: '' };
  const outside = m[1].trim();
  const inside = m[2].trim();
  const hasCjk = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(inside);
  if (hasCjk) return { main: outside.toUpperCase(), ja: inside };
  return { main: name.toUpperCase(), ja: '' };
}

/** Rotate (x,y,z) by quaternion q into `out`. */
function rotateVec(q, x, y, z, out) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.w)) {
    out.x = x; out.y = y; out.z = z; return out;
  }
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}


/** Bilingual labels for the engine's fire modes (values come from CONFIG). */
const MODE_LABEL = {
  auto: { en: 'AUTO', ja: '自動射撃' },
  manual: { en: 'MANUAL', ja: '手動射撃' },
};

/** Flight/utility legend groups: pairs render as "W/S". */
const LEGEND_GROUPS = [
  ['throttleUp', 'throttleDown'], ['yawLeft', 'yawRight'], ['rollLeft', 'rollRight'],
  ['pitchUp', 'pitchDown'], ['boost'], ['brake'],
  ['cycleTarget'], ['toggleFireMode'], ['cycleAimWeapon'],
  ['cycleCamera'], ['toggleRadarZoom'], ['pause'], ['mute'],
];
const ACTION_LABEL = {
  throttleUp: ['加速', 'THR'], throttleDown: ['減速', 'THR'],
  yawLeft: ['旋回', 'YAW'], yawRight: ['旋回', 'YAW'],
  rollLeft: ['ロール', 'ROLL'], rollRight: ['ロール', 'ROLL'],
  pitchUp: ['ピッチ', 'PITCH'], pitchDown: ['ピッチ', 'PITCH'],
  boost: ['ブースト', 'BOOST'], brake: ['ブレーキ', 'BRAKE'],
  cycleTarget: ['目標切替', 'TARGET'],
  toggleFireMode: ['射撃モード', 'FIRE MODE'], cycleAimWeapon: ['照準兵器', 'AIM GUN'],
  cycleCamera: ['視点', 'CAMERA'],
  toggleRadarZoom: ['レーダー', 'RADAR'], pause: ['一時停止', 'PAUSE'], mute: ['消音', 'MUTE'],
};

/* ─────────────────────────────────────────────────────────────── class ── */

export class Hud {
  /**
   * @param {HTMLElement} rootEl  the `#hud` element
   * @param {object} world
   */
  constructor(rootEl, world) {
    this.disposed = false;
    this._warned = new Set();
    this.root = rootEl || null;

    const doc = (this.root && this.root.ownerDocument)
      || (typeof document !== 'undefined' ? document : null);
    this.doc = doc;

    if (!this.root && doc) this.root = doc.getElementById('hud') || doc.body || null;
    if (!this.root || !doc) {
      this._warn('root', 'no HUD root element — HUD disabled');
      return;
    }

    ensureStyle(doc);

    this._vig = 0;
    this._hitDir = 0;
    this._fps = 60;
    this._elapsed = 0;
    this._feed = [];
    this._timers = new Set();
    this._bannerUntil = 0;
    this._warnUntil = 0;
    this._paused = false;
    this._outcome = null;
    this._wave = 0;
    this._combatUntil = 0;
    this._legendActive = 0;
    this._weaponsFor = null;
    this._wrows = {};
    this._marker = { x: -999, y: -999, on: false, edge: false };
    this._lead = { x: -999, y: -999, on: false };
    this._mode = null;                 // last rendered fire mode
    this._tickEls = {};                // hardpoint name -> { tick, ghost }
    this._aimWeapon = null;            // selected/aimed weapon id (optional engine field)

    // Optional CONFIG.ui colour overrides, exposed as CSS variables so the
    // stylesheet owns the state switching.
    const cfgUi = (CONFIG && CONFIG.ui && typeof CONFIG.ui === 'object') ? CONFIG.ui : {};
    const cfgColors = (cfgUi.colors && typeof cfgUi.colors === 'object') ? cfgUi.colors : {};
    const col = (v, d) => (typeof v === 'string' && v) ? v : d;
    this.colors = {
      arcIn: col(cfgColors.arcIn, 'rgba(120, 255, 170, 0.17)'),
      arcOut: col(cfgColors.arcOut, 'rgba(255, 150, 90, 0.16)'),
      arcAxis: col(cfgColors.arcAxis, 'rgba(200, 235, 255, 0.5)'),
      lead: col(cfgColors.lead, 'rgba(150, 235, 255, 0.95)'),
      mountReady: col(cfgColors.mountReady, 'rgba(120, 255, 170, 0.95)'),
      mountSlew: col(cfgColors.mountSlew, 'rgba(255, 200, 110, 0.95)'),
      mountBlocked: col(cfgColors.mountBlocked, 'rgba(255, 110, 110, 0.8)'),
      mountGhost: col(cfgColors.mountGhost, 'rgba(180, 215, 240, 0.45)'),
    };
    // Display clamp for very wide arcs (a 150° half-angle fan would fill the
    // screen); the real arc is still whatever the engine reports.
    this.arcMaxDisplayDeg = clamp(num(cfgUi.arcMaxDisplayDeg, 70), 5, 89);

    this._build(world);
    this._sync(world);
  }

  // ────────────────────────────────────────────────────────────── build ──

  _build(world) {
    const doc = this.doc;
    const root = make(doc, 'div', 'yfh', this.root);

    this.el = {
      root,
      vig: make(doc, 'div', 'yfh-vig', root),
      hitdir: make(doc, 'div', 'yfh-hitdir', root),
    };

    // CONFIG-driven indicator colours, as CSS variables.
    setStyle(root, '--c-arc-in', this.colors.arcIn);
    setStyle(root, '--c-arc-out', this.colors.arcOut);
    setStyle(root, '--c-arc-axis', this.colors.arcAxis);
    setStyle(root, '--c-lead', this.colors.lead);
    setStyle(root, '--c-mount-ready', this.colors.mountReady);
    setStyle(root, '--c-mount-slew', this.colors.mountSlew);
    setStyle(root, '--c-mount-blocked', this.colors.mountBlocked);
    setStyle(root, '--c-mount-ghost', this.colors.mountGhost);

    // firing-arc cone — behind the reticle so it can never hide the crosshair
    const arc = make(doc, 'div', 'yfh-arc', root);
    this.el.arc = arc;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'yfh-arc-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    const svgEl = (tag, cls) => {
      const e = doc.createElementNS(NS, tag);
      if (cls) e.setAttribute('class', cls);
      svg.appendChild(e);
      return e;
    };
    // Draw order: the two range rings, then the cone, then its edges and axis.
    this.el.rangeFar = svgEl('polygon', 'yfh-range-far');
    this.el.range = svgEl('polygon', 'yfh-range');
    this.el.arcWedge = svgEl('polygon', 'yfh-arc-wedge');
    this.el.arcEdgeL = svgEl('line', 'yfh-arc-edge');
    this.el.arcEdgeR = svgEl('line', 'yfh-arc-edge');
    this.el.arcAxis = svgEl('line', 'yfh-arc-axis');
    arc.appendChild(svg);

    // centre reticle — small, bow-pointing crosshair
    const ret = make(doc, 'div', 'yfh-reticle', root);
    this.el.reticle = ret;
    this.el.retCharge = make(doc, 'div', 'yfh-ret-charge', ret);
    make(doc, 'div', 'yfh-ret-tick t', ret);
    make(doc, 'div', 'yfh-ret-tick b', ret);
    make(doc, 'div', 'yfh-ret-tick l', ret);
    make(doc, 'div', 'yfh-ret-tick r', ret);
    make(doc, 'div', 'yfh-ret-cross', ret);
    make(doc, 'div', 'yfh-ret-cross v', ret);
    make(doc, 'div', 'yfh-ret-dot', ret);

    // per-mount traverse ticks (around the reticle) + lead-point marker
    this.el.mounts = make(doc, 'div', 'yfh-mounts', root);
    const lead = make(doc, 'div', 'yfh-lead', root);
    make(doc, 'i', '', lead);
    make(doc, 'b', '', lead);
    this.el.lead = lead;

    // firing-mode chip, just below the reticle
    const mode = make(doc, 'div', 'yfh-mode', root);
    this.el.mode = mode;
    this.el.modeKey = make(doc, 'span', 'yfh-key', mode, '—');
    this.el.modeName = make(doc, 'span', 'yfh-mode-name', mode, 'MANUAL');
    this.el.modeJa = make(doc, 'span', 'yfh-mode-ja', mode, '手動射撃');

    // projected target marker
    const tm = make(doc, 'div', 'yfh-tmark', root);
    const box = make(doc, 'div', 'yfh-tm-box', tm);
    for (let i = 0; i < 4; i++) make(doc, 'i', '', box);
    this.el.tmArrow = make(doc, 'div', 'yfh-tm-arrow', tm);
    this.el.tmLabel = make(doc, 'div', 'yfh-tm-label', tm, '');
    this.el.tmark = tm;

    // mission strip
    this.el.mission = make(doc, 'div', 'yfh-mission', root, 'MISSION —');

    // ── bottom-left column: status (bottom) + weapons (above) ──────────
    const col = make(doc, 'div', 'yfh-bottomleft', root);
    const st = make(doc, 'div', 'yfh-panel yfh-status', col);
    const nameRow = make(doc, 'div', 'yfh-name', st, '');
    this.el.name = make(doc, 'span', 'yfh-callsign', nameRow, '');
    this.el.nameSub = make(doc, 'span', '', nameRow, '');
    this.el.bars = {};
    for (const [key, label] of [['shield', 'SHIELD'], ['armor', 'ARMOR'], ['hull', 'HULL']]) {
      const bar = make(doc, 'div', 'yfh-bar', st);
      const head = make(doc, 'div', 'yfh-bar-head', bar);
      make(doc, 'span', '', head, label);
      const val = make(doc, 'span', 'yfh-value', head, '0');
      const track = make(doc, 'div', 'yfh-bar-track', bar);
      const fill = make(doc, 'div', 'yfh-bar-fill ' + key, track);
      this.el.bars[key] = { fill, val };
    }
    this.el.pips = make(doc, 'div', 'yfh-pips', st);
    const ro = make(doc, 'div', 'yfh-readout', st);
    this.el.speed = make(doc, 'b', '', make(doc, 'span', '', ro, 'SPD '), '0 m/s');
    this.el.throttle = make(doc, 'b', '', make(doc, 'span', '', ro, 'THR '), '0%');
    this.el.fps = make(doc, 'b', '', make(doc, 'span', '', ro, 'FPS '), '60');

    // weapons panel (built from ship.weaponIds once the player is known)
    const wp = make(doc, 'div', 'yfh-panel yfh-weapons', col);
    this.el.weaponsPanel = wp;
    const whead = make(doc, 'div', 'yfh-bar-head', wp);
    make(doc, 'span', 'yfh-label', whead, 'WEAPONS');
    this.el.weaponsHint = make(doc, 'span', 'yfh-hint', whead, '');
    // fire-mode row (key binding read from CONFIG.keys.toggleFireMode)
    const modeRow = make(doc, 'div', 'yfh-moderow', wp);
    this.el.modeRow = modeRow;
    make(doc, 'span', 'yfh-label', modeRow, 'FIRE MODE');
    const modeRight = make(doc, 'span', '', modeRow);
    this.el.modeRowKey = make(doc, 'span', 'yfh-key', modeRight, '—');
    this.el.modeRowValue = make(doc, 'span', 'yfh-mode-value', modeRight, '—');
    this.el.weaponsBody = make(doc, 'div', '', wp);
    this._buildWeapons(world);

    // ── target panel (top right) ───────────────────────────────────────
    const tg = make(doc, 'div', 'yfh-panel yfh-target', root);
    make(doc, 'div', 'yfh-label', tg, 'TARGET');
    this.el.tName = make(doc, 'div', 'yfh-t-name', tg, 'NO TARGET');
    this.el.tClass = make(doc, 'div', 'yfh-t-class', tg, '');
    this.el.tDist = make(doc, 'div', 'yfh-t-dist', tg, '—');
    this.el.tNone = make(doc, 'div', 'yfh-t-none', tg, '[TAB] CYCLE TARGET');
    this.el.tBars = {};
    for (const [key, label] of [['hull', 'HULL'], ['shield', 'SHIELD'], ['armor', 'ARMOR']]) {
      const bar = make(doc, 'div', 'yfh-bar', tg);
      const head = make(doc, 'div', 'yfh-bar-head', bar);
      make(doc, 'span', '', head, label);
      const val = make(doc, 'span', 'yfh-value', head, '—');
      const track = make(doc, 'div', 'yfh-bar-track', bar);
      const fill = make(doc, 'div', 'yfh-bar-fill ' + key, track);
      this.el.tBars[key] = { fill, val, bar };
    }

    // kill feed (hidden until it has an entry) + banner + warning
    this.el.feed = make(doc, 'div', 'yfh-panel yfh-feed', root);
    this.el.banner = make(doc, 'div', 'yfh-banner', root);
    this.el.bannerTitle = make(doc, 'div', 'yfh-banner-title', this.el.banner, '');
    this.el.bannerSub = make(doc, 'div', 'yfh-banner-sub', this.el.banner, '');
    this.el.warn = make(doc, 'div', 'yfh-warn', root, '');

    // controls legend
    this._buildLegend();

    // overlays
    this.el.overlay = make(doc, 'div', 'yfh-overlay', root);
    this.el.card = make(doc, 'div', 'yfh-card', this.el.overlay);
    this.el.cardTitle = make(doc, 'h1', '', this.el.card, '');
    this.el.cardSub = make(doc, 'p', '', this.el.card, '');

    this._buildPips(world);
  }

  /** One pip per subsystem kind present on the player's hull (or CONFIG table). */
  _buildPips(world) {
    const kinds = new Set();
    const hp = (CONFIG && CONFIG.damage && CONFIG.damage.subsystemHp) || {};
    for (const k of Object.keys(hp)) kinds.add(k);
    const ship = world ? world.player : null;
    if (ship && ship.subsystems) {
      for (const s of Object.values(ship.subsystems)) if (s && s.kind) kinds.add(s.kind);
    }
    this.el.pips.textContent = '';
    this.el.pipEls = {};
    for (const kind of kinds) {
      const label = SUBSYS_LABEL[kind] || String(kind).slice(0, 6).toUpperCase();
      const pip = make(this.doc, 'div', 'yfh-pip', this.el.pips, label);
      this.el.pipEls[kind] = pip;
    }
  }

  /**
   * Weapons panel: one row per weapon the player actually carries
   * (`ship.weaponIds`), key binding from CONFIG.keys, name from
   * CONFIG.weapons[id].displayName. Rebuilt only when the hull changes.
   */
  _buildWeapons(world) {
    const doc = this.doc;
    const body = this.el.weaponsBody;
    if (!body) return;
    const ship = world ? world.player : null;
    if (ship && this._weaponsFor === ship) return;

    body.textContent = '';
    this._wrows = {};
    this._weaponsFor = ship || null;

    const ids = (ship && Array.isArray(ship.weaponIds) && ship.weaponIds.length)
      ? ship.weaponIds.slice()
      : Object.keys((CONFIG && CONFIG.weapons) || {});
    if (!ids.length) return;

    const keys = (CONFIG && CONFIG.keys) || {};
    for (const id of ids) {
      const spec = (CONFIG && CONFIG.weapons && CONFIG.weapons[id]) || null;
      const row = make(doc, 'div', 'yfh-wrow', body);

      const action = this._keyActionFor(id, spec, keys);
      const code = (action && Array.isArray(keys[action]) && keys[action].length) ? keys[action][0] : null;
      make(doc, 'span', 'yfh-key' + (code ? '' : ' none'), row, code ? prettyKey(code) : '—');

      const { main, ja } = weaponLabel(spec, id);
      make(doc, 'span', 'yfh-wname', row, (ja ? ja + ' ' : '') + main);

      // Range lives with the live state so long weapon names never wrap.
      const stateCell = make(doc, 'span', 'yfh-wstate', row);
      const range = num(spec && spec.range, null);
      if (range) make(doc, 'i', '', stateCell, formatDistance(range) + ' · ');
      const stateEl = make(doc, 'b', '', stateCell, '—');
      // bar + "n/m BEARING" chip (mount count from the model, bearing from the engine)
      const barRow = make(doc, 'span', 'yfh-wbarrow', row);
      const bar = make(doc, 'span', 'yfh-wbar', barRow);
      const fill = make(doc, 'i', '', bar);
      const bear = make(doc, 'span', 'yfh-wbear', barRow, '');

      if (spec && spec.kind === 'wmgun') {
        try { row.classList.add('is-wmg'); } catch (_) { /* ignore */ }
        setText(this.el.weaponsHint, 'HOLD ' + (code ? prettyKey(code) : '—') + ' = 波動砲');
      }
      this._wrows[id] = { row, stateEl, fill, spec, bear };
    }
  }

  _keyActionFor(id, spec, keys) {
    const candidates = (WEAPON_KEY_ACTIONS[id] || []).concat(
      (spec && KIND_KEY_ACTIONS[spec.kind]) || [],
    );
    for (const a of candidates) if (keys && Array.isArray(keys[a])) return a;
    // Last resort: any CONFIG.keys action whose name mentions the weapon id.
    for (const a of Object.keys(keys || {})) {
      if (a.toLowerCase().includes(String(id).toLowerCase())) return a;
    }
    return null;
  }

  /** Compact flight/utility legend, all key names read from CONFIG.keys. */
  _buildLegend() {
    const doc = this.doc;
    const keys = (CONFIG && CONFIG.keys) || {};
    const legend = make(doc, 'div', 'yfh-legend', this.el.root);
    this.el.legend = legend;
    for (const group of LEGEND_GROUPS) {
      const actions = group.filter((a) => Array.isArray(keys[a]) && keys[a].length);
      if (!actions.length) continue;
      const item = make(doc, 'span', 'yfh-leg', legend);
      const caps = [];
      for (const a of actions) {
        const code = keys[a][0];
        if (code) caps.push(prettyKey(code));
      }
      for (let i = 0; i < caps.length; i++) {
        if (i) make(doc, 'span', 'a', item, '/');
        make(doc, 'span', 'k', item, caps[i]);
      }
      const label = ACTION_LABEL[actions[0]];
      const text = label ? label[0] + ' ' + label[1] : actions[0].toUpperCase();
      make(doc, 'span', 'a', item, text);
    }
  }

  // ───────────────────────────────────────────────────────────── update ──

  update(dt, world) {
    if (this.disposed || !this.el) return;
    const w = (world && typeof world === 'object') ? world : {};
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    try {
      this._elapsed += step;
      if (step > 0) this._fps = ema(this._fps, 1 / step, 0.06);
      this._sync(w, step);
    } catch (err) {
      this._warn('update', 'HUD frame failed: ' + (err && err.message ? err.message : err));
    }
  }

  _sync(world, dt = 0) {
    const now = this._now();
    const player = world.player || null;

    // ── damage vignette ────────────────────────────────────────────────
    this._vig = damp(this._vig, 0, 3.2, dt || 0.016);
    this._hitDir = damp(this._hitDir, 0, 4.5, dt || 0.016);
    const hullRatio = this._ratio(player, 'hull');
    const lowHull = player && player.alive !== false ? Math.max(0, (0.3 - hullRatio) / 0.3) * 0.55 : 0;
    setStyle(this.el.vig, 'opacity', clamp(Math.max(this._vig, lowHull), 0, 1).toFixed(3));
    setStyle(this.el.hitdir, 'opacity', clamp(this._hitDir * 0.8, 0, 1).toFixed(3));

    // ── ship status ────────────────────────────────────────────────────
    const callsign = (player && (player.callsign || player.displayName)) || 'NO SHIP';
    const sub = (player && (player.shipClass || (player.def && player.def.shipClass))) || '';
    setText(this.el.name, String(callsign).toUpperCase());
    setText(this.el.nameSub, sub ? '  ' + sub : '');

    this._bar('shield', player, 'shield', 'shieldMax', 'shieldRatio');
    this._bar('armor', player, 'armor', 'armorMax', 'armorRatio');
    const hullState = this._bar('hull', player, 'hull', 'hullMax', 'healthRatio');
    setClass(this.el.bars.hull.fill, 'warn', hullState < 0.6 && hullState >= 0.25);
    setClass(this.el.bars.hull.fill, 'crit', hullState < 0.25);

    this._pips(player);

    const speed = player
      ? (Number.isFinite(player.speed) ? player.speed
        : (player.velocity ? Math.hypot(player.velocity.x || 0, player.velocity.y || 0, player.velocity.z || 0) : 0))
      : 0;
    setText(this.el.speed, Math.round(speed) + ' m/s');
    setText(this.el.throttle, Math.round(clamp(Number.isFinite(player && player.throttle) ? player.throttle : 0, -1, 1) * 100) + '%');
    setText(this.el.fps, String(Math.round(this._fps)));
    setText(this.el.mission, 'MISSION  WAVE ' + (this._wave || 1) + '  ·  T+' + formatTime(this._elapsed));

    // ── weapons panel + WMG charge ring ────────────────────────────────
    this._buildWeapons(world);
    this._syncWeapons(player, world);

    const wm = this._wrows ? this._wrows.wmgun : null;
    const wmRatio = wm && wm._state ? wm._state.charge : 0;
    setStyle(this.el.retCharge, '--p', String(Math.round(wmRatio * 100)));
    setClass(this.el.retCharge, 'on', wmRatio > 0.005);
    setClass(this.el.retCharge, 'is-ready', wmRatio >= 0.999);

    // ── reticle lock state + projected target marker ───────────────────
    const target = player && player.target ? player.target : null;
    const sol = this._solution(world);
    const locked = !!(target && player
      && ((sol && typeof sol.inArc === 'boolean') ? sol.inArc : this._inArc(player, target)));
    setClass(this.el.reticle, 'is-locked', locked);
    this._syncTargetMarker(world, player, target, locked);
    this._syncFiringDirection(world, player, target);
    this._syncMode(world);

    // ── target panel ───────────────────────────────────────────────────
    if (target) {
      const tName = target.callsign || target.displayName || (target.def && target.def.displayName) || 'UNKNOWN';
      const tClass = target.shipClass || (target.def && target.def.shipClass) || (target.role || '');
      const d = (player && player.position && target.position)
        ? Math.hypot(target.position.x - player.position.x, target.position.y - player.position.y, target.position.z - player.position.z)
        : NaN;
      setText(this.el.tName, String(tName).toUpperCase());
      setText(this.el.tClass, tClass ? String(tClass) : '');
      setText(this.el.tDist, Number.isFinite(d) ? formatDistance(d) : '—');
      // Driven by the engine's own solution so the label can never disagree
      // with what the guns actually do. The off-axis bearing tells the player
      // how far to turn to bring the target into the arc.
      const inArcT = (sol && typeof sol.inArc === 'boolean') ? sol.inArc : locked;
      const inRangeT = (sol && typeof sol.inRange === 'boolean') ? sol.inRange : true;
      const off = num(sol && sol.bearingDeg, NaN);
      const offTxt = (!inArcT && Number.isFinite(off)) ? ' · ' + Math.round(off) + '° OFF' : '';
      setText(this.el.tNone, target.alive === false ? 'TARGET DESTROYED'
        : (!inRangeT ? 'OUT OF RANGE' : (inArcT ? 'IN FIRING ARC' : 'OUT OF ARC')) + offTxt);
      this._tbar('hull', target, 'hull', 'hullMax', 'healthRatio');
      this._tbar('shield', target, 'shield', 'shieldMax', 'shieldRatio');
      this._tbar('armor', target, 'armor', 'armorMax', 'armorRatio');
    } else {
      setText(this.el.tName, 'NO TARGET');
      setText(this.el.tClass, '');
      setText(this.el.tDist, '—');
      setText(this.el.tNone, '[TAB] CYCLE TARGET');
      for (const k of Object.keys(this.el.tBars)) {
        setText(this.el.tBars[k].val, '—');
        setStyle(this.el.tBars[k].fill, 'width', '0%');
      }
    }

    // ── kill feed: fully hidden while empty ────────────────────────────
    if (this._feed.length) {
      const life = num(CONFIG?.hud?.feedTime, 7);
      for (let i = this._feed.length - 1; i >= 0; i--) {
        const item = this._feed[i];
        if (now - item.t0 > life) {
          try { if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el); } catch (_) { /* ignore */ }
          this._feed.splice(i, 1);
        }
      }
    }
    setClass(this.el.feed, 'show', this._feed.length > 0);

    // ── banner / warning expiry ────────────────────────────────────────
    if (this._bannerUntil && now > this._bannerUntil) {
      this._bannerUntil = 0;
      setClass(this.el.banner, 'show', false);
    }
    if (this._warnUntil && now > this._warnUntil) {
      this._warnUntil = 0;
      setClass(this.el.warn, 'show', false);
    }

    // ── legend auto-dim ────────────────────────────────────────────────
    this._syncLegend(world, player, target, dt);

    // ── pause / outcome overlays ───────────────────────────────────────
    const paused = this._resolvePaused(world);
    // The world's own state wins; a pushEvent('victory'|'defeat') is only a
    // fallback for worlds that do not expose one.
    const outcome = this._resolveOutcome(world) || this._outcome;
    if (outcome) {
      const isVictory = outcome === 'victory';
      setClass(this.el.overlay, 'show', true);
      setClass(this.el.card, 'victory', isVictory);
      setClass(this.el.card, 'defeat', !isVictory);
      setClass(this.el.card, 'pause', false);
      setText(this.el.cardTitle, isVictory ? 'VICTORY' : 'SHIP LOST');
      setText(this.el.cardSub, isVictory
        ? 'ALL WAVES CLEARED — 地球連邦宇宙海軍'
        : 'YAMATO LOST WITH ALL HANDS — [R] TO RESTART');
    } else if (paused) {
      setClass(this.el.overlay, 'show', true);
      setClass(this.el.card, 'victory', false);
      setClass(this.el.card, 'defeat', false);
      setClass(this.el.card, 'pause', true);
      setText(this.el.cardTitle, 'PAUSED');
      setText(this.el.cardSub, '[P] RESUME');
    } else {
      setClass(this.el.overlay, 'show', false);
    }
  }

  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() / 1000 : this._elapsed;
  }

  /** Per-weapon live state: READY / cooldown / CHARGING / DISABLED. */
  _syncWeapons(player, world) {
    const rows = this._wrows;
    if (!rows) return;
    const dead = !!(player && player.alive === false);
    const aimId = this._aimWeaponId(world, player);

    for (const id of Object.keys(rows)) {
      const r = rows[id];
      const spec = r.spec;
      const ws = (player && player.weaponState) ? player.weaponState[id] : null;
      const isWmg = !!(spec && spec.kind === 'wmgun');
      const disabled = dead || this._weaponDisabled(player, spec);
      const charge = clamp01(num(ws && ws.chargeRatio, 0));
      const cooldown = Math.max(0, num(ws && ws.cooldown, 0));
      const cdMax = Math.max(0.001, num(spec && spec.cooldown, 1));

      let cls = 'ready';
      let text = 'READY';
      let fill = 1;
      if (disabled) {
        cls = 'down'; text = dead ? 'OFFLINE' : 'DISABLED'; fill = 0;
      } else if (isWmg) {
        fill = charge;
        if (charge >= 0.999) { cls = 'charge'; text = 'READY ' + pct(charge) + '%'; }
        else if (charge > 0.005 || (ws && ws.charging === true)) { cls = 'charge'; text = 'CHARGING ' + pct(charge) + '%'; }
        else if (cooldown > 0) { cls = 'cool'; text = 'RELOAD ' + cooldown.toFixed(0) + 's'; fill = 0; }
        else { cls = 'ready'; text = 'CHARGE READY'; fill = 0; }
      } else if (cooldown > 0) {
        cls = 'cool'; text = 'RELOAD ' + cooldown.toFixed(1) + 's'; fill = 1 - cooldown / cdMax;
      }

      r._state = { charge, cooldown, disabled, cls, text };
      setClass(r.row, 'is-aim', !!aimId && aimId === id);
      setClass(r.row, 'ready', cls === 'ready');
      setClass(r.row, 'cool', cls === 'cool');
      setClass(r.row, 'charge', cls === 'charge');
      setClass(r.row, 'down', cls === 'down');
      setText(r.stateEl, text);
      setStyle(r.fill, 'width', (clamp01(fill) * 100).toFixed(1) + '%');

      // How many of this weapon's mounts can actually bear on the target —
      // this is what explains "I pressed fire and nothing happened".
      if (r.bear) {
        const total = this._mountTotal(player, id, spec);
        const canBear = this._mountsBearing(player, id);
        if (total > 0 && canBear !== null && !dead) {
          // Defensive: the engine's per-mount list can outnumber the hull's
          // declared mounts, so never render an impossible "9/3".
          const bearing = Math.min(canBear, total);
          setText(r.bear, bearing + '/' + total + ' BEARING');
          const state = bearing >= total ? 'ok' : (bearing > 0 ? 'part' : 'none');
          setClass(r.bear, 'ok', state === 'ok');
          setClass(r.bear, 'part', state === 'part');
          setClass(r.bear, 'none', state === 'none');
        } else {
          setText(r.bear, '');
          setClass(r.bear, 'ok', false);
          setClass(r.bear, 'part', false);
          setClass(r.bear, 'none', false);
        }
      }
    }
  }

  /** Total rotatable mounts for a weapon (CONFIG.ships[*].mounts, then model). */
  _mountTotal(player, id, spec) {
    if (!player) return 0;
    const fromStats = num(player.stats && player.stats.mounts && player.stats.mounts[id], NaN);
    if (Number.isFinite(fromStats) && fromStats > 0) return fromStats;
    const prefix = spec && spec.mountPrefix;
    if (!prefix) return 0;
    try {
      const model = player.model;
      if (model && typeof model.mountsFor === 'function') {
        const list = model.mountsFor(prefix);
        if (Array.isArray(list)) return list.length;
      }
      const hp = model && model.hardpoints;
      if (hp && typeof hp.keys === 'function') {
        let n = 0;
        for (const k of hp.keys()) if (String(k).startsWith(prefix)) n++;
        return n;
      }
      if (hp && typeof hp === 'object') {
        let n = 0;
        for (const k of Object.keys(hp)) if (String(k).startsWith(prefix)) n++;
        return n;
      }
      const ta = player.turretAim;
      if (ta && typeof ta === 'object') {
        let n = 0;
        for (const k of Object.keys(ta)) if (String(k).startsWith(prefix)) n++;
        return n;
      }
    } catch (_) { /* ignore */ }
    return 0;
  }

  /** `ship.mountsBearing(id)` guarded; null when the engine does not provide it. */
  _mountsBearing(player, id) {
    if (!player || typeof player.mountsBearing !== 'function') return null;
    try {
      const v = player.mountsBearing(id);
      return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
    } catch (_) { return null; }
  }

  _weaponDisabled(player, spec) {
    if (!player || !spec) return false;
    const kind = spec.subsystemKind;
    if (!kind) return false;
    if (typeof player.hasWorkingSubsystem === 'function') {
      try { return !player.hasWorkingSubsystem(kind); } catch (_) { /* fall through */ }
    }
    if (!player.subsystems) return false;
    const list = Object.values(player.subsystems).filter((s) => s && s.kind === kind);
    if (!list.length) return true;                     // subsystem gone entirely
    return !list.some((s) => !s.disabled);
  }

  /** Target marker: project the locked ship's position into screen space. */
  _syncTargetMarker(world, player, target, locked) {
    const tm = this.el.tmark;
    if (!tm) return;
    const ok = !!(target && target.alive !== false && target.position && world.camera && player);
    if (!ok) {
      if (this._marker.on) {
        this._marker.on = false;
        setClass(tm, 'show', false);
      }
      return;
    }

    const size = this._screenSize(world);
    const p = this._project(target.position, world.camera, size.w, size.h);
    if (!p) {
      setClass(tm, 'show', false);
      this._marker.on = false;
      return;
    }

    const pad = 34;
    let x = p.x, y = p.y, edge = false;
    if (!p.visible) {
      edge = true;
      // Clamp to the screen border, keeping the direction from the centre.
      const cx = size.w / 2, cy = size.h / 2;
      let dx = x - cx, dy = y - cy;
      if (p.behind) { dx = -dx; dy = -dy; }            // behind the camera: mirror
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) { dx = 0; dy = 1; }
      const sx = dx === 0 ? Infinity : (size.w / 2 - pad) / Math.abs(dx);
      const sy = dy === 0 ? Infinity : (size.h / 2 - pad) / Math.abs(dy);
      const s = Math.min(sx, sy);
      x = cx + dx * s;
      y = cy + dy * s;
      setStyle(tm, '--rot', (Math.atan2(dy, dx) * 180 / Math.PI + 90).toFixed(1) + 'deg');
    }

    const nx = Math.round(clamp(x, edge ? 84 : pad, size.w - (edge ? 84 : pad)));
    const ny = Math.round(clamp(y, pad, size.h - pad));
    if (this._marker.x !== nx) { setStyle(tm, 'left', nx + 'px'); this._marker.x = nx; }
    if (this._marker.y !== ny) { setStyle(tm, 'top', ny + 'px'); this._marker.y = ny; }
    setClass(tm, 'is-edge', edge);
    if (!this._marker.on) { setClass(tm, 'show', true); this._marker.on = true; }

    const name = target.callsign || target.displayName || 'TARGET';
    const d = (player.position && target.position)
      ? Math.hypot(target.position.x - player.position.x, target.position.y - player.position.y, target.position.z - player.position.z)
      : NaN;
    setText(this.el.tmLabel, String(name).toUpperCase()
      + (Number.isFinite(d) ? '  ' + formatDistance(d) : '')
      + (locked ? '  ◆' : ''));
  }

  // ─────────────────────────────────────── firing direction + fire mode ──

  /** world.firingSolution, or null when the engine has not provided it yet. */
  _solution(world) {
    const s = world && world.firingSolution;
    return (s && typeof s === 'object') ? s : null;
  }

  /** Selected/aimed weapon id — an optional engine field, guarded everywhere. */
  _aimWeaponId(world, player) {
    const cands = [
      world && world.aimWeaponId, world && world.aimWeapon, world && world.selectedWeapon,
      player && player.aimWeaponId, player && player.aimWeapon,
    ];
    for (const c of cands) if (typeof c === 'string' && c) return c;
    return null;
  }

  /** Weapon spec whose arc the indicator draws (engine's aimed weapon first). */
  _aimSpec(world, player) {
    const weapons = (CONFIG && CONFIG.weapons) || {};
    const ids = Array.isArray(player && player.weaponIds) ? player.weaponIds : [];
    const sol = this._solution(world);
    const sel = (sol && typeof sol.weaponId === 'string' && sol.weaponId) || this._aimWeaponId(world, player);
    if (sel && weapons[sel]) return weapons[sel];
    let best = null, bestArc = -1;
    for (const id of ids) {
      const spec = weapons[id];
      if (!spec) continue;
      const a = num(spec.arcDeg, 0);
      if (a > bestArc) { bestArc = a; best = spec; }
    }
    return best;
  }

  /** Widest weapon arc on the hull — fallback when firingSolution is absent. */
  _arcDegFor(player) {
    const weapons = (CONFIG && CONFIG.weapons) || {};
    const ids = Array.isArray(player && player.weaponIds) ? player.weaponIds : [];
    let arc = 0;
    for (const id of ids) {
      const a = num(weapons[id] && weapons[id].arcDeg, 0);
      if (a > arc) arc = a;
    }
    return arc || 180;
  }

  /**
   * Turret traverse angles → degrees for display. The engine stores radians
   * (ship-local, 0 = trained fore/aft, matching three.js rotation.y), so 'rad'
   * is the default; CONFIG.turrets.angleUnit can override if that ever changes.
   */
  _turretDeg(v, fallback = 0) {
    if (!Number.isFinite(v)) return Number.isFinite(fallback) ? fallback : 0;
    const unit = (CONFIG && CONFIG.turrets && typeof CONFIG.turrets.angleUnit === 'string')
      ? CONFIG.turrets.angleUnit : 'rad';
    return unit === 'deg' ? v : (v * 180) / Math.PI;
  }

  /** Position + rotate a 1px line element between two screen points. */
  /** Set an SVG attribute, guarding against a missing element. */
  _attr(el, name, value) {
    if (el && el.setAttribute) el.setAttribute(name, value);
  }

  /** Position an SVG <line> from a to b, in screen pixels. */
  _svgLine(el, a, b) {
    if (!el || !a || !b) return;
    this._attr(el, 'x1', a.x.toFixed(1));
    this._attr(el, 'y1', a.y.toFixed(1));
    this._attr(el, 'x2', b.x.toFixed(1));
    this._attr(el, 'y2', b.y.toFixed(1));
  }

  /**
   * Project a horizontal circle of `radius` around `centre` into screen space
   * and set it as an SVG polygon. `radius <= 0` clears the ring.
   */
  /**
   * In-plane basis at the ship: `f` is the ship's forward projected onto the
   * plane perpendicular to `up`, `r` is starboard (f x up). Returns null if the
   * forward vector is degenerate against up.
   */
  _planeBasis(forward, up) {
    const ux = num(up && up.x, 0), uy = num(up && up.y, 1), uz = num(up && up.z, 0);
    let fx = num(forward && forward.x, 0), fy = num(forward && forward.y, 0), fz = num(forward && forward.z, -1);
    const d = fx * ux + fy * uy + fz * uz;
    fx -= ux * d; fy -= uy * d; fz -= uz * d;             // remove the out-of-plane part
    const fl = Math.hypot(fx, fy, fz);
    if (!(fl > 1e-6)) return null;
    fx /= fl; fy /= fl; fz /= fl;
    // r = f x up
    const rx = fy * uz - fz * uy;
    const ry = fz * ux - fx * uz;
    const rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz) || 1;
    return { fx, fy, fz, rx: rx / rl, ry: ry / rl, rz: rz / rl };
  }

  /**
   * A weapon's firing sector, drawn ON THE SHIP'S PLANE rather than fanned into
   * screen space — the World of Warships torpedo-indicator idea.
   *
   * This matters for correctness, not just looks: a 150 deg traverse arc drawn
   * as a screen-space fan from a point becomes a flat wash across the viewport,
   * whereas the same arc projected onto the plane reads as a wide pie slice
   * around the ship, which is what it actually is. A 3 deg wave-motion-gun arc
   * becomes a narrow spike. Both are then honest.
   *
   * @param el      SVG polygon to fill with the sector
   * @param centre  world-space apex (usually the ship)
   * @param forward ship forward, world space
   * @param up      ship up, world space
   * @param radius  sector radius in world units
   * @param half    half-angle in RADIANS
   * @returns {{mid:object, left:object, right:object}|null} screen-space rim points
   */
  _svgSector(el, centre, forward, up, radius, half, camera, size) {
    if (!el) return null;
    if (!(radius > 0) || !centre || !camera) { this._attr(el, 'points', ''); return null; }
    const B = this._planeBasis(forward, up);
    if (!B) { this._attr(el, 'points', ''); return null; }
    const N = 24;
    const at = (ang) => {
      const c = Math.cos(ang), sn = Math.sin(ang);
      return {
        x: centre.x + (B.fx * c + B.rx * sn) * radius,
        y: centre.y + (B.fy * c + B.ry * sn) * radius,
        z: centre.z + (B.fz * c + B.rz * sn) * radius,
      };
    };
    const pts = [];
    for (let i = 0; i <= N; i++) pts.push(at(-half + (2 * half * i) / N));
    const rim = pts.map((w) => this._project(w, camera, size.w, size.h));
    const apex = this._project(centre, camera, size.w, size.h);
    if (!apex || apex.behind || rim.some((q) => !q || q.behind)) {
      this._attr(el, 'points', '');
      return null;
    }
    this._attr(el, 'points',
      [apex, ...rim].map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '));
    return { mid: rim[Math.floor(N / 2)], left: rim[0], right: rim[N], apex };
  }

  _svgRing(el, centre, up, radius, camera, size) {
    if (!el) return;
    if (!(radius > 0) || !centre || !camera) { this._attr(el, 'points', ''); return; }
    const N = 40;
    // Build two in-plane axes from the ship's up vector.
    const ux = num(up && up.x, 0), uy = num(up && up.y, 1), uz = num(up && up.z, 0);
    const ax = -uz, az = ux;                       // horizontal, perpendicular to up
    const al = Math.hypot(ax, az) || 1;
    const e1x = ax / al, e1z = az / al;
    const e2x = -uy * e1z, e2y = uz * e1x - ux * e1z, e2z = uy * e1x;
    const out = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      const c = Math.cos(t) * radius, sn = Math.sin(t) * radius;
      const p = this._project({
        x: centre.x + e1x * c + e2x * sn,
        y: centre.y + e2y * sn,
        z: centre.z + e1z * c + e2z * sn,
      }, camera, size.w, size.h);
      if (!p || p.behind) { this._attr(el, 'points', ''); return; }
      out.push(p);
    }
    this._attr(el, 'points', out.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '));
  }

  _line(el, a, b) {
    if (!el) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    setStyle(el, 'left', a.x.toFixed(1) + 'px');
    setStyle(el, 'top', a.y.toFixed(1) + 'px');
    setStyle(el, 'width', Math.max(1, len).toFixed(1) + 'px');
    setStyle(el, 'transform', 'rotate(' + ang.toFixed(2) + 'deg)');
  }

  /**
   * Firing-direction indicator: a projected wedge for the aimed weapon's arc
   * (green in arc, amber/red out of arc), plus the per-mount traverse ticks and
   * the lead-point marker. Fades out entirely when nothing is locked.
   */
  _syncFiringDirection(world, player, target) {
    const arcEl = this.el.arc;
    const mountsEl = this.el.mounts;
    if (!arcEl) return;
    const sol = this._solution(world);
    const live = !!(target && target.alive !== false && hasVec3(target.position) && player && hasVec3(player.position));
    const hasTarget = sol && typeof sol.hasTarget === 'boolean' ? sol.hasTarget : live;

    if (!live || !hasTarget || !world.camera) {
      setClass(arcEl, 'show', false);
      setClass(mountsEl, 'show', false);
      setClass(this.el.lead, 'show', false);
      this._lead.on = false;
      return;
    }

    const S = this._scratch || (this._scratch = {
      fwd: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 },
    });

    const size = this._screenSize(world);
    const fwd = rotateVec(player.quaternion, 0, 0, -1, S.fwd);
    const up = rotateVec(player.quaternion, 0, 1, 0, S.up);
    // The sector radiates from the SHIP, not from a bow-offset apex: it is a
    // firing envelope, so it belongs centred on the hull, the way the World of
    // Warships torpedo indicator is centred on the launcher.

    const spec = this._aimSpec(world, player);
    const arcDeg = Math.abs(num(sol && sol.arcDeg, this._arcDegFor(player)));
    const half = (Math.min(arcDeg, this.arcMaxDisplayDeg) * Math.PI) / 180;
    const maxRange = Math.max(400, num(spec && spec.range, num(CONFIG?.weapons?.shock_cannon?.range, 2000)));
    let dist = num(sol && sol.distance, NaN);
    if (!Number.isFinite(dist) || dist <= 0) {
      dist = Math.hypot(target.position.x - player.position.x, target.position.y - player.position.y, target.position.z - player.position.z);
    }
    dist = clamp(Number.isFinite(dist) ? dist : maxRange * 0.5, 300, maxRange);

    const inArc = (sol && typeof sol.inArc === 'boolean') ? sol.inArc : this._inArc(player, target);
    const inRange = (sol && typeof sol.inRange === 'boolean') ? sol.inRange : true;

    // The sector is drawn at the weapon's TRUE arc, on the ship's plane. The old
    // screen-space fan had to be clamped (CONFIG.ui.arcMaxDisplayDeg) because a
    // 150 deg fan from a point covers the viewport; projected onto the plane it
    // does not, so the clamp is no longer needed for the fill.
    const sector = this._svgSector(
      this.el.arcWedge, player.position, fwd, up, dist, half, world.camera, size);
    if (!sector) {
      setClass(arcEl, 'show', false);
      setClass(mountsEl, 'show', false);
      setClass(this.el.lead, 'show', false);
      this._lead.on = false;
      return;
    }
    setClass(arcEl, 'is-out', !(inArc && inRange));
    setClass(arcEl, 'show', true);
    this._svgLine(this.el.arcEdgeL, sector.apex, sector.left);
    this._svgLine(this.el.arcEdgeR, sector.apex, sector.right);
    this._svgLine(this.el.arcAxis, sector.apex, sector.mid);
    // Range rings, WoW-style: the circle the SELECTED weapon can reach, drawn on
    // the ship's plane, plus the wave motion gun's far ring for scale.
    this._svgRing(this.el.range, player.position, up, maxRange, world.camera, size);
    const wmRange = num(CONFIG?.weapons?.wmgun?.range, 0);
    this._svgRing(this.el.rangeFar, player.position, up,
      wmRange > maxRange * 1.2 ? wmRange : 0, world.camera, size);

    this._syncMounts(player);
    this._syncLead(world, sol);
  }

  /** Small ticks around the reticle: one per rotatable mount, from ship.turretAim. */
  _syncMounts(player) {
    const box = this.el.mounts;
    if (!box) return;
    const ta = (player && player.turretAim && typeof player.turretAim === 'object') ? player.turretAim : null;
    const names = ta ? Object.keys(ta) : [];
    if (!names.length) {
      setClass(box, 'show', false);
      for (const k of Object.keys(this._tickEls)) {
        setStyle(this._tickEls[k].tick, 'display', 'none');
        setStyle(this._tickEls[k].ghost, 'display', 'none');
      }
      return;
    }
    setClass(box, 'show', true);
    const tol = num(CONFIG?.turrets?.settleToleranceDeg, 5);
    // A capital ship can carry 13+ mounts; drawing all of them turns the ring
    // into noise. Prefer mounts that belong to a weapon the player carries,
    // then the ones that can bear or are slewing, and cap the rest.
    const prefixes = [];
    for (const id of (Array.isArray(player.weaponIds) ? player.weaponIds : [])) {
      const pfx = (CONFIG && CONFIG.weapons && CONFIG.weapons[id] && CONFIG.weapons[id].mountPrefix) || null;
      if (pfx && prefixes.indexOf(pfx) === -1) prefixes.push(pfx);
    }
    const relevant = (n) => prefixes.some((p) => n.startsWith(p));
    const rank = (n) => {
      const m = ta[n] || {};
      return (relevant(n) ? 4 : 0) + (m.canBear === true ? 2 : 0) + (m.inArc === true ? 1 : 0);
    };
    const maxTicks = Math.max(1, Math.floor(num(CONFIG && CONFIG.ui && CONFIG.ui.maxMountTicks, 8)));
    const shown = names.slice()
      .sort((a, b) => rank(b) - rank(a) || (a < b ? -1 : (a > b ? 1 : 0)))
      .slice(0, maxTicks);
    for (const name of shown) {
      let entry = this._tickEls[name];
      if (!entry) {
        entry = {
          tick: make(this.doc, 'div', 'yfh-tick', box),
          ghost: make(this.doc, 'div', 'yfh-tick-ghost', box),
        };
        this._tickEls[name] = entry;
      }
      const m = ta[name] || {};
      const cur = this._turretDeg(m.angle, 0);
      const tgt = this._turretDeg(m.targetAngle, cur);
      const canBear = m.canBear === true;
      const inArc = m.inArc === true;
      setClass(entry.tick, 'is-ready', canBear);
      setClass(entry.tick, 'is-slew', !canBear && inArc);
      setStyle(entry.tick, 'display', '');
      setStyle(entry.tick, 'transform', 'translate(-50%, -50%) rotate(' + cur.toFixed(1) + 'deg) translateY(-38px)');
      const slew = Math.abs(((tgt - cur + 540) % 360) - 180);
      const showGhost = slew > tol;
      setStyle(entry.ghost, 'display', showGhost ? '' : 'none');
      if (showGhost) {
        setStyle(entry.ghost, 'transform', 'translate(-50%, -50%) rotate(' + tgt.toFixed(1) + 'deg) translateY(-38px)');
      }
    }
    for (const k of Object.keys(this._tickEls)) {
      if (shown.indexOf(k) >= 0) continue;
      setStyle(this._tickEls[k].tick, 'display', 'none');
      setStyle(this._tickEls[k].ghost, 'display', 'none');
    }
  }

  /** Lead/aim point marker — deliberately distinct from the target bracket. */
  _syncLead(world, sol) {
    const el = this.el.lead;
    if (!el) return;
    const lp = sol && sol.leadPoint;
    if (!lp || !Number.isFinite(lp.x) || !Number.isFinite(lp.y) || !world.camera) {
      setClass(el, 'show', false);
      this._lead.on = false;
      return;
    }
    const size = this._screenSize(world);
    const p = this._project(lp, world.camera, size.w, size.h);
    if (!p) {
      setClass(el, 'show', false);
      this._lead.on = false;
      return;
    }
    const pad = 18;
    const nx = Math.round(clamp(p.x, pad, size.w - pad));
    const ny = Math.round(clamp(p.y, pad, size.h - pad));
    if (this._lead.x !== nx) { setStyle(el, 'left', nx + 'px'); this._lead.x = nx; }
    if (this._lead.y !== ny) { setStyle(el, 'top', ny + 'px'); this._lead.y = ny; }
    setClass(el, 'show', true);
    this._lead.on = true;
  }

  /**
   * Firing-mode chip + weapons-panel row. A missing `world.fireMode` is treated
   * as CONFIG.fireModes.default (manual), never as an error.
   */
  _syncMode(world) {
    const keys = (CONFIG && CONFIG.keys) || {};
    const codes = Array.isArray(keys.toggleFireMode) ? keys.toggleFireMode : [];
    const keyLabel = codes.length ? prettyKey(codes[0]) : '—';
    const cfg = (CONFIG && CONFIG.fireModes && typeof CONFIG.fireModes === 'object') ? CONFIG.fireModes : {};
    const order = Array.isArray(cfg.order) && cfg.order.length
      ? cfg.order.map((m) => String(m).toLowerCase())
      : ['manual', 'auto'];
    const fallback = (typeof cfg.default === 'string' && cfg.default) ? cfg.default.toLowerCase() : 'manual';
    const raw = (world && typeof world.fireMode === 'string') ? world.fireMode.toLowerCase() : '';
    const mode = order.indexOf(raw) >= 0 ? raw : (order.indexOf(fallback) >= 0 ? fallback : 'manual');
    const label = MODE_LABEL[mode] || { en: mode.toUpperCase(), ja: '' };
    const isAuto = mode === 'auto';

    if (this.el.mode) {
      setClass(this.el.mode, 'show', true);
      setClass(this.el.mode, 'is-auto', isAuto);
      setText(this.el.modeKey, keyLabel);
      setText(this.el.modeName, label.en);
      setText(this.el.modeJa, label.ja);
    }
    if (this.el.modeRow) {
      setClass(this.el.modeRow, 'is-auto', isAuto);
      setText(this.el.modeRowKey, keyLabel);
      setText(this.el.modeRowValue, label.ja ? label.en + ' ' + label.ja : label.en);
    }
    this._mode = mode;
    return mode;
  }

  _screenSize(world) {
    const el = world && world.renderer ? world.renderer.domElement : null;
    const w = num(el && el.clientWidth, 0) || num(this.root && this.root.clientWidth, 0)
      || (typeof window !== 'undefined' ? num(window.innerWidth, 0) : 0) || 1280;
    const h = num(el && el.clientHeight, 0) || num(this.root && this.root.clientHeight, 0)
      || (typeof window !== 'undefined' ? num(window.innerHeight, 0) : 0) || 720;
    return { w, h };
  }

  /** world → screen. Uses the Lead's helper, with a local matrix fallback. */
  _project(worldPos, camera, w, h) {
    if (typeof projectToScreen === 'function') {
      try {
        const p = projectToScreen(worldPos, camera, w, h);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          return { x: p.x, y: p.y, visible: !!p.visible, behind: num(p.depth, 0) > 1 };
        }
      } catch (_) { /* fall through to the local solve */ }
    }
    try {
      const vm = camera.matrixWorldInverse && camera.matrixWorldInverse.elements;
      const pm = camera.projectionMatrix && camera.projectionMatrix.elements;
      if (!vm || !pm) return null;
      const x = num(worldPos.x, 0), y = num(worldPos.y, 0), z = num(worldPos.z, 0);
      const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12];
      const vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
      const vz = vm[2] * x + vm[6] * y + vm[10] * z + vm[14];
      const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15];
      if (!Number.isFinite(cw) || cw === 0) return null;
      const ndcX = (pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12]) / cw;
      const ndcY = (pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13]) / cw;
      const ndcZ = (pm[2] * vx + pm[6] * vy + pm[10] * vz + pm[14]) / cw;
      if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;
      return {
        x: (ndcX * 0.5 + 0.5) * w,
        y: (-ndcY * 0.5 + 0.5) * h,
        visible: cw > 0 && ndcX >= -1.4 && ndcX <= 1.4 && ndcY >= -1.4 && ndcY <= 1.4,
        behind: ndcZ > 1 || cw <= 0,
      };
    } catch (_) { return null; }
  }

  /** Legend stays readable but never competes with combat. */
  _syncLegend(world, player, target, dt) {
    const legend = this.el.legend;
    if (!legend) return;
    const keysDown = (world.input && world.input.keys && typeof world.input.keys.size === 'number')
      ? world.input.keys.size : 0;
    if (keysDown > 0) this._legendActive = 3;
    this._legendActive = Math.max(0, this._legendActive - (dt || 0.016));

    let combat = false;
    if (this._combatUntil > this._now()) combat = true;
    // "Engaged" = actively reloading a mount, or an enemy at knife range. A
    // distant target does NOT dim the legend, so the hints stay readable early.
    if (!combat && player && player.weaponState) {
      for (const k of Object.keys(player.weaponState)) {
        const ws = player.weaponState[k];
        if (ws && num(ws.cooldown, 0) > 0) { combat = true; break; }
      }
    }
    if (!combat && player && player.position && target && target.position) {
      const d = Math.hypot(target.position.x - player.position.x, target.position.y - player.position.y, target.position.z - player.position.z);
      if (Number.isFinite(d) && d < 1200) combat = true;
    }
    const opacity = this._legendActive > 0 ? 0.95 : (combat ? 0.34 : 0.62);
    setStyle(legend, 'opacity', opacity.toFixed(2));
  }

  _bar(key, ship, field, maxField, ratioGetter) {
    const entry = this.el.bars[key];
    const ratio = this._ratio(ship, key, ratioGetter);
    const val = ship && Number.isFinite(ship[field]) ? ship[field] : null;
    const max = ship && Number.isFinite(ship[maxField]) ? ship[maxField] : null;
    setStyle(entry.fill, 'width', (ratio * 100).toFixed(1) + '%');
    setText(entry.val, val != null && max != null ? fmtInt(val) + ' / ' + fmtInt(max) : (val != null ? fmtInt(val) : '—'));
    return ratio;
  }

  _tbar(key, ship, field, maxField, ratioGetter) {
    const entry = this.el.tBars[key];
    const ratio = this._ratio(ship, key, ratioGetter);
    const val = ship && Number.isFinite(ship[field]) ? ship[field] : null;
    const max = ship && Number.isFinite(ship[maxField]) ? ship[maxField] : null;
    setStyle(entry.fill, 'width', (ratio * 100).toFixed(1) + '%');
    setText(entry.val, val != null && max != null ? pct(ratio) + '%' : '—');
    return ratio;
  }

  _ratio(ship, key, ratioGetter) {
    if (!ship) return 0;
    const getter = ratioGetter || (key + 'Ratio');
    if (typeof ship[getter] === 'function') { try { return clamp01(ship[getter]()); } catch (_) { /* fall through */ } }
    if (Number.isFinite(ship[getter])) return clamp01(ship[getter]);
    if (key === 'hull' && Number.isFinite(ship.healthRatio)) return clamp01(ship.healthRatio);
    const val = ship[key];
    const max = ship[key === 'hull' ? 'hullMax' : key + 'Max'];
    if (Number.isFinite(val) && Number.isFinite(max) && max > 0) return clamp01(val / max);
    return 0;
  }

  /** Worst state per subsystem kind → coloured pip. */
  _pips(player) {
    const pips = this.el.pipEls || {};
    const kinds = Object.keys(pips);
    if (!kinds.length) return;
    if (!player || !player.subsystems) {
      for (const k of kinds) { setClass(pips[k], 'ok', false); setClass(pips[k], 'hurt', false); setClass(pips[k], 'down', false); }
      return;
    }
    const worst = {};
    for (const s of Object.values(player.subsystems)) {
      if (!s || !s.kind) continue;
      const ratio = Number.isFinite(s.max) && s.max > 0 ? clamp01((Number.isFinite(s.hp) ? s.hp : 0) / s.max) : 0;
      const state = s.disabled ? 2 : (ratio < 0.5 ? 1 : 0);
      worst[s.kind] = Math.max(worst[s.kind] ?? -1, state);
    }
    for (const k of kinds) {
      const st = worst[k];
      setClass(pips[k], 'ok', st === 0);
      setClass(pips[k], 'hurt', st === 1);
      setClass(pips[k], 'down', st === 2 || st === undefined);
    }
  }

  _hasSubsystem(player, kind) {
    if (!player || !player.subsystems) return true;
    const list = Object.values(player.subsystems).filter((s) => s && s.kind === kind);
    if (!list.length) return true;
    return list.some((s) => !s.disabled);
  }

  /** Does any weapon on the player currently bear on `target`? */
  _inArc(player, target) {
    if (!player || !target || !target.position || typeof player.inFiringArc !== 'function') return false;
    try {
      const ids = Array.isArray(player.weaponIds) ? player.weaponIds : [];
      let arc = 0;
      for (const id of ids) {
        const spec = (CONFIG && CONFIG.weapons && CONFIG.weapons[id]) || null;
        if (spec && Number.isFinite(spec.arcDeg) && spec.arcDeg > arc) arc = spec.arcDeg;
      }
      if (!arc) arc = 180;
      return !!player.inFiringArc(target.position, arc);
    } catch (_) { return false; }
  }

  // ───────────────────────────────────────────────────────────── events ──

  /**
   * @param {object|string} evt  { type:'kill'|'hit'|'wave'|'warning'|'info', ... }
   */
  pushEvent(evt) {
    if (this.disposed || !this.el) return;
    try {
      const e = (evt && typeof evt === 'object') ? evt : { type: 'info', text: evt };
      const type = String(e.type || e.kind || 'info').toLowerCase();

      if (type === 'hit' || type === 'damage') {
        const intensity = Number.isFinite(e.intensity) ? e.intensity : 1;
        this._vig = Math.max(this._vig, clamp(0.35 * intensity, 0.15, 1));
        this._hitDir = Math.max(this._hitDir, 1);
        this._combatUntil = this._now() + 6;
        if (e.text || e.message) this._feedItem(this._text(e), 'info');
        return;
      }
      if (type === 'kill' || type === 'destroyed') {
        const killer = e.killer ? String(e.killer) : '';
        const victim = e.victim ? String(e.victim) : '';
        const text = this._text(e) || (killer && victim ? killer + ' ▸ ' + victim : (victim || 'TARGET DESTROYED'));
        this._feedItem(text, 'kill');
        return;
      }
      if (type === 'wave') {
        this._wave = Number.isFinite(e.index) ? e.index + 1 : (Number.isFinite(e.wave) ? e.wave + 1 : this._wave);
        // main.js sends { text: <banner>, subtitle: <name>, index }.
        const title = e.banner || e.title || e.text || e.name || ('WAVE ' + (this._wave || 1));
        const sub = e.subtitle || ((e.name && e.name !== title) ? e.name : '') || '';
        const ms = Number.isFinite(e.duration) ? e.duration * 1000
          : (Number.isFinite(CONFIG?.progression?.waveBannerTime) ? CONFIG.progression.waveBannerTime * 1000 : 4000);
        this.showBanner(title, sub, ms);
        return;
      }
      if (type === 'victory' || type === 'defeat' || type === 'gameover') {
        this.setOutcome(type === 'victory' ? 'victory' : 'defeat');
        if (e.text) this._feedItem(String(e.text), type === 'victory' ? 'info' : 'warning');
        return;
      }
      if (type === 'warning' || type === 'warn' || type === 'alarm') {
        this.showWarning(this._text(e) || 'WARNING', Number.isFinite(e.duration) ? e.duration * 1000 : 2500);
        this._combatUntil = this._now() + 4;
        return;
      }
      const text = this._text(e);
      if (text) this._feedItem(text, 'info');
    } catch (err) {
      this._warn('event', 'HUD event failed: ' + (err && err.message ? err.message : err));
    }
  }

  _text(e) {
    return String(e.text || e.message || e.msg || e.label || e.detail || '');
  }

  _feedItem(text, cls) {
    if (!text || !this.el || !this.el.feed) return;
    const el = make(this.doc, 'div', 'yfh-feed-item ' + cls, this.el.feed, text);
    this._feed.push({ el, t0: this._now() });
    const max = num(CONFIG?.hud?.feedMax, 6);
    while (this._feed.length > max) {
      const old = this._feed.shift();
      try { if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el); } catch (_) { /* ignore */ }
    }
    setClass(this.el.feed, 'show', true);
  }

  /** Big centred wave/announcement banner. */
  showBanner(title, sub, ms) {
    if (!this.el || !this.el.banner) return;
    setText(this.el.bannerTitle, String(title || ''));
    setText(this.el.bannerSub, String(sub || ''));
    setClass(this.el.banner, 'show', true);
    this._bannerUntil = this._now() + clamp(Number.isFinite(ms) ? ms : 4000, 200, 20000) / 1000;
  }

  /** Small red strip for warnings ("WAVE MOTION GUN CHARGING"). */
  showWarning(text, ms) {
    if (!this.el || !this.el.warn) return;
    setText(this.el.warn, String(text || ''));
    setClass(this.el.warn, 'show', true);
    this._warnUntil = this._now() + clamp(Number.isFinite(ms) ? ms : 2500, 150, 20000) / 1000;
  }

  // ────────────────────────────────────────────────────────────── extras ──

  setPaused(on) { this._paused = !!on; }

  setOutcome(kind) {
    const k = (kind == null) ? null : OUTCOME_WORDS[String(kind).toLowerCase()] || null;
    this._outcome = k;
  }

  setVisible(on) {
    if (!this.el || !this.el.root) return;
    setStyle(this.el.root, 'display', on === false ? 'none' : '');
  }

  _resolvePaused(world) {
    if (this._paused) return true;
    if (!world) return false;
    if (world.paused === true || world.isPaused === true) return true;
    const s = world.state || world.gameState || world.status || world.phase;
    return typeof s === 'string' && s.toLowerCase() === 'paused';
  }

  _resolveOutcome(world) {
    if (!world) return null;
    if (world.victory === true) return 'victory';
    if (world.defeat === true) return 'defeat';
    for (const key of ['outcome', 'state', 'gameState', 'status', 'phase', 'result']) {
      const v = world[key];
      if (typeof v === 'string') {
        const mapped = OUTCOME_WORDS[v.toLowerCase()];
        if (mapped) return mapped;
      }
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────── dispose ──

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this._timers) { try { clearTimeout(id); } catch (_) { /* ignore */ } }
    this._timers.clear();
    this._feed.length = 0;
    try {
      if (this.el && this.el.root && this.el.root.parentNode) this.el.root.parentNode.removeChild(this.el.root);
    } catch (_) { /* ignore */ }
    this.el = null;
    this._wrows = {};
    this.root = null;
  }

  _warn(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[hud] ' + msg); } catch (_) { /* ignore */ }
  }
}

export default Hud;
