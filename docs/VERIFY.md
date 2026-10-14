# VERIFY.md — independent verification of YAMATO FLEET 2199

> Owner: **verifier-2** (task-10). I wrote `tests/**`, `evidence/**` and this file
> and nothing else. I did not modify `src/**`, `tools/**`, `assets/**` or
> `index.html` at any point — `git status` at the end of the run shows only
> `evidence/**` (re-shot), `evidence/revision.json` (regenerated) and
> `tests/make_revision.mjs` (new).
>
> **§1–§8 below verify the tree at `d864fb9`.** §9 is the **re-verification at
> `83d2039`**, the commit that fixed the defects reported here, and it carries
> the current closed/open status of every finding. Read §9 first for the state
> of the tree today.
>
> **Verdict at `83d2039`: the three gates PASS; both geometry defects are
> confirmed fixed; one finding (`HUD-ARC-1`) is only HALF fixed** — the `hud.js`
> comment was corrected, the `config.js` comment was not, and still carries the
> false claim. See [§9](#9-re-verification-at-83d2039).

---

## 0. Revision verified

| | |
|---|---|
| `gitHead` | `d864fb951acdb1afeef32bb359ed649d96112b47` |
| commit | `d864fb9` — *Firing indicator: a true arc sector on the ship's plane* |
| captured | 2026-10-13T07:24:04Z (15:24 Asia/Shanghai) |
| files hashed | 95 (`evidence/revision.json`) |
| working tree | clean apart from this verification's own files |

`evidence/revision.json` was **stale when I started** — it recorded `06d3ade`,
three commits behind HEAD. It is now regenerated at `d864fb9` by
[`tests/make_revision.mjs`](../tests/make_revision.mjs), which is committed so
the snapshot is reproducible:

```bash
node tests/make_revision.mjs     # rewrites evidence/revision.json
```

The tree moved once during the run: the Lead landed the firing-indicator rework
(`d864fb9`) while I was reading the models. I stopped, asked, and re-ran every
gate against the frozen revision rather than reporting results from a tree that
no longer existed. **One gate result from the pre-freeze revision was discarded
for this reason** (the first `node --test` run, at `25ea8cf`).

### Environment, stated up front because it limits what the numbers mean

* **Host load average 114–158** throughout. An unrelated `qemu-system-aarch64`
  Android emulator was pinning ~133 % CPU and `WindowServer` ~83 %. The machine
  was not idle and I did not control it.
* The shared browser window reported **`document.hidden === true` for the whole
  session**, which suspends `requestAnimationFrame`. The demo therefore had to
  be driven through the deterministic stepper in
  [`evidence/loop-probe.html`](../evidence/loop-probe.html).
* Consequence: **the trustworthy performance number is CPU milliseconds per
  frame, not FPS** (see [§5](#5-performance)). I do not publish a wall-clock FPS
  figure, because at load 158 it would measure the host.

---

## 1. The three gates

All three were run at `d864fb9`, after the freeze.

### 1.1 `node --test tests/` — **PASS, 116/116**

```
ℹ tests 116
ℹ suites 0
ℹ pass 116
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1514.432875
```

Run twice (once early, once after adding `tests/make_revision.mjs`) — 116/116
both times. The new file does not match `node --test`'s discovery patterns, so
it does not enter the count.

### 1.2 `tools/validate_models.py assets/models` — **PASS, exit 0**

```
summary: 8 ships, 65836 triangles total, 211 hardpoints total
warning: andromeda: 6 missile_launcher hardpoint(s) but no CONFIG weapon reads that family - inert data, or a CONFIG weapon missing
warning: kirishima: 2 missile_launcher hardpoint(s) but no CONFIG weapon reads that family - inert data, or a CONFIG weapon missing
warning: yukikaze: 1 missile_launcher hardpoint(s) but no CONFIG weapon reads that family - inert data, or a CONFIG weapon missing
OK - all 8 models satisfy the SPEC section 4/5 asset contract
```

**The fleet is 65 836 triangles, not 62 432.** The task brief states 62 432 and
the previous VERIFY.md's scope warning repeats it, but the brief's own per-hull
figures (11 668 + 11 202 + 9 902 + 9 800 + 7 752 + 6 936 + 4 700 + 3 876) sum to
**65 836**, which is what the validator and the OBJ files both report. The
per-hull numbers in the brief are all correct; only the total is wrong.

### 1.3 `tools/gen_models.py` determinism — **PASS, and stronger than asked**

Three runs into scratch directories, then compared against each other *and*
against the shipped files:

```
README.md                  a=6bcf4200cea87f50 b=6bcf4200cea87f50 c=6bcf4200cea87f50 shipped=6bcf4200cea87f50
andromeda.obj              a=01c02d27eb4b1f2b b=01c02d27eb4b1f2b c=01c02d27eb4b1f2b shipped=01c02d27eb4b1f2b
bolar_carrier.obj          a=f690f0c4f4bf71f3 b=f690f0c4f4bf71f3 c=f690f0c4f4bf71f3 shipped=f690f0c4f4bf71f3
garmillas_dessler.obj      a=884f4d8769860ee6 b=884f4d8769860ee6 c=884f4d8769860ee6 shipped=884f4d8769860ee6
garmillas_gaiderol.obj     a=607439c2e6bcc86e b=607439c2e6bcc86e c=607439c2e6bcc86e shipped=607439c2e6bcc86e
garmillas_kelkapia.obj     a=01984efff969cfad b=01984efff969cfad c=01984efff969cfad shipped=01984efff969cfad
kirishima.obj              a=e86346c2dbcba92d b=e86346c2dbcba92d c=e86346c2dbcba92d shipped=e86346c2dbcba92d
manifest.json              a=0dfd7a2fc664a1cc b=0dfd7a2fc664a1cc c=0dfd7a2fc664a1cc shipped=0dfd7a2fc664a1cc
yamato.obj                 a=07a7b7ccd33c53cf b=07a7b7ccd33c53cf c=07a7b7ccd33c53cf shipped=07a7b7ccd33c53cf
yukikaze.obj               a=10b1bb0e2a7a934b b=10b1bb0e2a7a934b c=10b1bb0e2a7a934b shipped=10b1bb0e2a7a934b
… (all 17 .obj/.mtl/manifest files identical in all four columns)
```

Three runs byte-identical to each other is what the gate asked for. That they
are *also* byte-identical to the shipped `assets/models/**` is the stronger
result: **the committed assets are exactly what the generator produces** — no
hand-editing, no drift between the generator and what ships. I generated into
scratch directories rather than over `assets/models` so the check could not
itself perturb the artifact it was checking.

---

## 2. The rebuilt models, adversarially

The question here is not "is there geometry" but "is the geometry *right*". All
checks below read the OBJ and `manifest.json` directly and are independent of
`tools/validate_models.py`.

### 2.1 What holds up

**The third bridge is genuinely below the keel — PASS.**

```
yamato  third_bridge y [-27.52 .. -11.32]  z [-63.00 .. -33.00]  x [-11.00 .. 11.00]
        hull keel at that station y = -14.46  (global hull min -14.82)
        -> protrudes 13.06 m below the local keel / 12.70 m below the global keel
```

The pod's bottom sits 12.70 m below the lowest point of the hull and its top
(−11.32) is *above* the keel, so it is attached and hanging, not floating. Only
the Yamato has one, which is correct — no other hull in this fleet carries a
third bridge.

**Indexed mounts are authored pivot-local, so they orbit the right point — PASS.**
This is the check that matters most, because `src/core/assets.js` places every
group matching `^(turret_main|turret_secondary|ciws|missile_launcher|torpedo_tube)_\d+$`
at its hardpoint with `mesh.position.copy(pivotHp.pos)`. If the generator had
authored those groups in world space, every indexed mount would be offset by
*twice* its pivot and fly off the ship.

The decisive evidence is that `turret_main_1` and `turret_main_2` — 30 m apart
on the hull — have **identical** local geometry centres `(0, 6.83, −8.12)`, and
`turret_main_3` is the mirror `(0, 6.83, +8.12)`. World-space authoring would
have made those centres differ by the hardpoint delta. The largest local centre
offset anywhere is 11.76 m on the 444 m Andromeda, i.e. the size of the turret,
not a position.

Confirmed live as well: the three meshes named `turret_main_1` (the OBJ group is
split per material) all carry pivot `(0.00, 17.47, −124.00)` and traverse in
perfect unison — identical `rotation.y` before and after a 90-frame traverse.

**Torpedo ports are flush with the plating — PASS.**

Distance from each weapon hardpoint to the nearest hull triangle:

| hull | weapon hardpoints | max distance | median | buried or floating |
|---|---|---|---|---|
| yamato | 47 | 0.20 m | 0.01 m | none |
| andromeda | 23 | 0.39 m | 0.02 m | none |
| kirishima | 13 | 0.06 m | 0.02 m | none |
| yukikaze | 3 | 0.07 m | 0.05 m | none |
| garmillas_kelkapia | 10 | 0.11 m | 0.02 m | none |

An earlier binary inside/outside test appeared to show 25 of 47 Yamato
hardpoints "inside the hull". That was **my test being wrong, not the model**:
a point sitting *on* a surface is a coin-flip for a parity test. Measuring the
distance instead shows every port within 0.20 m of the plating. I record the
false alarm because the corrected method is the reason to believe the PASS.

**No mount interpenetrates another on seven of the eight hulls.** A full
pairwise sweep (sample each mount's surface, test each sample for being inside
the other mount's closed mesh) found **zero** interpenetrating pairs on
andromeda, kirishima, yukikaze, dessler, kelkapia, gaiderol and bolar.

### 2.2 What does not hold up — two defects

Both are on the Yamato foredeck, and they share one root cause: **the foredeck
stations are laid out by gunhouse pivot, and barrel overhang is not accounted
for.** The generator's own comment at `tools/gen_models.py:2553` says *"The
stations are set so the gun houses CLEAR each other"* — the gun houses do; the
barrels do not.

#### `YAMATO-BARREL-1` — MEDIUM — the forward secondary turret's barrels are buried inside main turret #2

```
turret_main_2       pivot (0, 24.00, -94.00)   world bbox z [-124.94 .. -79.30]
turret_secondary_1  pivot (0, 24.00, -73.00)   world bbox z [ -88.70 .. -66.70]

turret_secondary_1 surface samples: 14720;  inside turret_main_2: 2294 (15.6 %)
  intruding region: x ±6.6, y 34.46..37.67, z -88.68..-80.45
CONTROL: turret_main_2 samples inside turret_secondary_1: 29 / 15040 (0.19 %)
```

`turret_secondary_1` sits at z = −73 and trains forward (−Z). Its 12 m barrels
reach z = −88.7, which is **inside** `turret_main_2`'s gunhouse volume
(z −108 … −80). About 8.2 m of the secondary's barrel length is inside the main
turret — roughly two thirds of it. Both mounts sit at y = 24.00, so the
secondary's gun axis (y ≈ 36.1) is inside the main turret's gunhouse
(y 24.00 … 37.67) rather than above it.

The control matters: the aft turret's surface returns 0/4000 against turret #1,
so the test is not simply reporting "everything intersects everything".

#### `YAMATO-BARREL-2` — LOW/MEDIUM — main turret #2's muzzles penetrate main turret #1's roof

```
turret_main_2 barrel-region surface samples: 3120
  inside turret_main_1: 100 (3.21 %)
  intruding region: x ±10.2, y 30.35..31.14, z -124.88..-122.02
  deepest sample 0.80 m below turret_main_1's roof top (y = 31.14)
CONTROL: turret_main_3 (aft) samples inside turret_main_1: 0 / 4000
```

The *axes* of #2's barrels do clear #1's roof — the barrel axis is at y ≈ 32.88
against a roof at 31.14, a 1.7 m margin, so the superfiring arrangement is
sound in principle. But the modelled barrels are chunky stylised cylinders of
~2.97 m radius, so the **underside** of each muzzle dips to y ≈ 29.91 and passes
through #1's roof plate. All three barrels are affected across a 2.9 m band.

Honest scale: 0.80 m on a 333 m hull is not visible from the chase camera. I
report it because it is exactly the class of defect the brief asked for —
geometry that is *present but wrong*, which a static render at normal range
would not reveal — and because it is the same root cause as `YAMATO-BARREL-1`,
which *is* visible.

**The validator cannot see either one.** `validate_models.py` reports
`superfiring 6.53m (>= 6.0m), #2 aft` — a pivot-rise proxy. Turret #2 is indeed
raised 6.53 m, and that proxy passes while both interpenetrations exist. The
proxy is not wrong about what it measures; it just cannot substitute for
checking whether the barrels actually clear.

---

## 3. The CONFIG-derived mount rule can fail — proven, not asserted

The brief was explicit: a rule that cannot fail is not a check. So I broke it on
purpose. Everything ran on a **copy** under `/tmp`; `assets/**` was never
touched.

| # | mutation on the scratch copy | expected | observed |
|---|---|---|---|
| — | control, unmodified | exit 0 | **exit 0** |
| A | yamato `turret_main` hardpoints 3 → 2 | FAIL | **exit 1** — `CONFIG fires 3 mount(s) from turret_main but the model has 2 - a mount would fire from nothing` |
| B | yamato `turret_secondary` hardpoints removed entirely | FAIL | **exit 1** — `CONFIG carries a turret_secondary weapon but the model has no turret_secondary hardpoint to fire it from` |
| C | yamato `ciws` 4 → 3 (CONFIG `pdMounts` 4) | FAIL | **exit 1** — `3 ciws_* hardpoints for pdMounts = 4 point-defence channels` |
| D | yamato `turret_main` 3 → 4 (extra) | WARN | **WARN** `model has 4 turret_main hardpoints, CONFIG says 3 - CONFIG needs updating if the model is right (canon count)`, plus a FAIL from the *separate* canon-count table: `layout: 4 turret_main mounts, canon has 3` |
| E | kirishima `missile_launcher` hardpoints removed | warning for kirishima disappears, others stay | **exactly that** — andromeda and yukikaze still warn, kirishima no longer does |

**Conclusion: the rule is load-bearing and falsifiable.** Three independent
breaks each turn it red. Case E also shows the inert-hardware warning tracks
reality rather than being boilerplate.

Case D is worth reading twice: an extra mount produces a *warning* from the
CONFIG rule and a *failure* from the frozen canon-count table. Those are two
different checks doing two different jobs, and both behaved correctly.

### 3.1 One weakness in the rule's plumbing — LOW

`config_mix()` resolves the config as `<root>/../../src/core/config.js`. If the
tool is pointed anywhere other than `<project>/assets/models`, it cannot find
`config.js` and **the whole derived rule is skipped with a warning**:

```
# same broken yamato (turret_main 3 -> 2), models dir outside the project layout:
warning: manifest: required-mix checks SKIPPED: src/core/config.js not found
FAIL - 2 contract violation(s):
  - yamato: indexed group 'turret_main_3' has no hardpoint of the same name …
  - yamato: layout: 2 turret_main mounts, canon has 3

# identical break, models dir in the canonical place:
FAIL - 3 contract violation(s):
  - yamato: indexed group 'turret_main_3' has no hardpoint of the same name …
  - yamato: layout: 2 turret_main mounts, canon has 3
  - yamato: CONFIG fires 3 mount(s) from turret_main but the model has 2 …   <-- the derived rule
```

The skip is deliberate and documented in the tool ("a missing tool must never
look like a broken model"), and in this case two other checks still caught the
break. But pointing the validator at a copy is precisely what a reviewer does,
and it is exactly then that the CONFIG↔model reconciliation goes quiet. The tool
exits non-zero either way here; a break that *only* the derived rule catches
would not be caught at all.

### 3.2 The inert-hardware warnings — PASS, and accurate

Three hulls warn, not two: **andromeda 6**, kirishima 2, yukikaze 1
`missile_launcher` hardpoints with no CONFIG weapon reading that family. The
brief names only kirishima and yukikaze; andromeda is the third. They **warn**
(the validator still exits 0), which is correct — the geometry is deliberate
canon hardware per `docs/research/05` §6, and deleting it would be worse than
leaving it inert. Case E above proves the warning is not boilerplate: removing
the hardware removes exactly that hull's warning.

---

## 4. Browser end-to-end, at `d864fb9`

Driven through [`evidence/loop-probe.html`](../evidence/loop-probe.html), which
captures `src/main.js`'s real frame callback and re-invokes it with synthetic,
exactly-spaced timestamps. Product code is untouched; only the clock source
changes.

### Item 1 — boot, state, console cleanliness — **PASS**

```
{"title":"[100%] 準備完了 / ready","hasWorld":true,"state":"playing","ships":6,
 "bootDisplay":"none","bootOpacity":"0","consoleErrors":0,"consoleWarnings":0,
 "windowErrors":0,"unhandledRejections":0}
```

**The boot screen clears.** `#boot` computes to `display:none` with `opacity:0`,
so the `display:none` fallback the Lead added for the throttled-tab case is
doing its job — the fade did not stall.

### Item 2 — models — **PASS**

```
yamato 11668 | yukikaze 3876 ×2 | garmillas_kelkapia 7752 ×3
all placeholder:false, all triangles === manifest triangles
uniqueObject3D 6 | scene groups: yamato, yukikaze ×2, garmillas_kelkapia ×3 | shieldBubbles 6
```

`uniqueObject3D === 6` for 6 ships is the regression check for the old
`SHARED-OBJ3D-1` defect (one `Object3D` shared per class, so 4 of 6 ships were
never drawn). **It has not come back.** One shield bubble per ship, six groups
in the scene.

### Item 3 — movement — **PASS**

Real `KeyboardEvent`s at `window`, read back through the real `Input` and
`simulate()`:

```
throttle (KeyW)  : throttle 0.988, moved 31.70 m, speed 20.89 m/s
yaw      (KeyA)  : forward Δ 11.218°, up Δ  0.000°   -> pure yaw about local +Y
pitch    (KeyI)  : forward Δ  6.310°, up Δ  6.310°   -> pure pitch
roll     (KeyQ)  : forward Δ  0.000°, up Δ 28.045°   -> pure roll
```

The rotation-axis assertions are the strong part: yaw leaves `up` untouched,
roll leaves `forward` untouched, pitch moves both.

### Item 4 — weapons — **PASS**

All five Yamato weapons fire, and each spawns exactly `mounts × salvo`:

| weapon | mounts | salvo | expected | shotsFired Δ | pool Δ |
|---|---|---|---|---|---|
| shock_cannon | 3 | 1 | 3 | **3** | 3 |
| secondary_battery | 2 | 2 | 4 | **4** | 4 |
| torpedo | 1 | 4 | 4 | **4** | 4 |
| missile *(new)* | 1 | 6 | 6 | **6** | 6 |
| wmgun | 1 | 1 | 1 | **1** | 1 |

Refusals, each with a positive control so the test cannot pass by refusing
everything:

```
shock_cannon @2500 m  refused   |  @1900 m  fires (3)     [range 2000]
shock_cannon @170°    refused   |  @140°    fires (3)     [arc 150]
torpedo      @ 90°    refused   |  @ 30°    fires (4)     [arc 45]
wmgun        @  0°    fires (1) |  @  2.5°  fires (1)     [arc 3]
wmgun        @  5° / 45° / 90° / 180°  refused
wmgun        @13 km   refused
```

This is the `WMG-ARC-1` fix (a wave motion gun that once fired 90° off the bow)
holding at the frozen revision.

### Item 5 — point defence — **PASS**, and measured exactly

PD **focus-fires on the nearest** hostile, so a measurement is only meaningful
with a clean sky: I zeroed every other ship's `pdMounts` and cleared the
projectile pool before each trial. Without that, a parked missile sometimes took
38.67 DP and sometimes 0, purely because another projectile was nearer.

```
hostile missile, 554 m inside the aura, 1.00 s : lost 80.00 DP
hostile missile, 554 m, 0.50 s                 : lost 40.00 DP  (= 20 dps/mount x 4 mounts, linear)
hostile torpedo, 554 m, 1.00 s                 : lost 80.00 DP
shell,          554 m, 1.00 s                  : lost  0.00 DP  (not in targetKinds)
friendly missile,554 m, 1.00 s                 : lost  0.00 DP  (faction filter)
hostile missile, 1200 m (aura is 900 m)        : lost  0.00 DP
```

`PD-1` (the old bug where every projectile received `dps / engagementCap`
instead of the full suite output) is fixed and the concentration is exact.

### Item 6 — damage model — **PASS**

```
pools: shield 2400 / armor 2200 / hull 4400

11 x 100 DP into full shields
  shield 2400 -> 1300; armor 2200 unchanged; hull 4400 unchanged
  hits touching a subsystem: 0;  subsystems byte-identical: true

300 DP x 8 (shield strip)
  shield 2100/1800/1500/1200/900/600/300/0, armor never touched

overflow in one hit, 3000 DP
  shieldHit 2400 + armorHit 600, hullHit 0, hull still 4400   -> strict order holds

deep overflow, shield 2400 + armor 2200 + hull layer 5400
  subsystemShare 810  == exactly 15 % of 5400
  hullHit 4590;  hullHit + share == 5400 exactly  (taken OUT of hull, not added)

crit (Math.random -> 0)
  subsystemShare 1620 == 30 % (2x);  hullHit 3780;  sum 5400
```

Subsystem damage arises **only** in the hull branch, which is why the
fully-shielded trials leave every subsystem byte-identical.

### Item 7 — kills, stats, feed — **PASS**

Kills are emitted by `src/entities/projectile.js` when a projectile lands the
killing blow, not by `applyDamage`. My first attempt called `applyDamage`
directly and saw no kill events and `stats.kills` frozen at 0; that was **my
test bypassing the real path**, not a defect. Killing through real weapons:

```
victim KELKAPIA-1 (shield 1200 / armor 1000 / hull 2000)
672 frames = 11.2 s of shock_cannon fire -> destroyed
'kill' events: {ship: KELKAPIA-3, from: YAMATO}, {ship: KELKAPIA-1, from: YAMATO}
world.stats.kills 0 -> 2 ;  player.kills 0 -> 2 ;  world.stats.losses 0
DOM kill feed: "KELKAPIA-3 撃沈 — sunk by YAMATO", "KELKAPIA-1 撃沈 — sunk by YAMATO"
```

### Item 8 — waves, victory, defeat — **PASS**

```
wave 1 -> 2 : lull 9.983 s  (CONFIG.waveLull = 10 s)
              composition [garmillas_gaiderol, garmillas_kelkapia]  == CONFIG.waves[1]
wave 2 -> 3 : lull 9.983 s
              composition [bolar_carrier, garmillas_kelkapia, garmillas_kelkapia] == CONFIG.waves[2]
victory     : state 'victory' after the last enemy died; 'gameover' emitted;
              overlay class "yfh-overlay show", opacity 1
              card "VICTORY / ALL WAVES CLEARED — 地球連邦宇宙海軍"
defeat      : player killed -> state 'defeat'; overlay opacity 1
              card "SHIP LOST / YAMATO LOST WITH ALL HANDS — [R] TO RESTART"
              every weapon OFFLINE, SHIELD 0/2400 ARMOR 0/2200 HULL 0/4400
```

The 9.983 s rather than 10.000 s is one frame of quantisation at 1/60 s, not
drift.

### Item 9 — HUD, fire modes, and the swallowed-throw hazard — **PASS**

The Lead flagged a recurring hazard: a throw inside the HUD update path is
swallowed by `main.js`'s `catch { console.warn('[main] UI update threw') }`, so
the HUD silently stops updating with no visible error. **A check that only looks
for the warning is not enough** — the HUD could also be frozen for another
reason — so I measured both:

```
1800 frames = 30 s of continuous combat, firing every 40 frames
  new console warnings : 0
  new console errors   : 0
  "UI update threw"    : 0
  window errors        : 0
  unhandled rejections : 0
  HUD text changed across all 6 samples : true
    (SHOCK CANNON "READY" -> "RELOAD 1.0s" -> "RELOAD 1.7s";
     torpedo bearing "0/1" -> "1/1"; FIRE MODE toggling)
```

Zero swallowed throws **and** a demonstrably live HUD. On this revision the
hazard is not present.

Fire modes and the weapons panel:

```
KeyT : manual -> auto -> manual          (CONFIG.keys.toggleFireMode)
firingSolution : weaponId, hasTarget, inArc, inRange, distance, bearingDeg,
                 arcDeg, leadPoint, mountsBearing, mountsTotal, wmgun{...}
weapons panel  : 主砲 SHOCK CANNON | 副砲 SECONDARY BATTERY | 魚雷 TORPEDO |
                 ミサイル MISSILE  | 波動砲 WAVE MOTION GUN      <- all five, missile row present
```

### Item 10 — the firing sector does **not** always show the true arc — DEFECT

The firing-indicator rework raised `CONFIG.ui.arcMaxDisplayDeg` from 26 to 85,
and the CONFIG comment now says the sector *"is now drawn at its true value. The
clamp only guards against a degenerate arc in the data."* I instrumented the
HUD's own `_svgSector` call to read the half-angle it is actually handed:

| weapon | true half-angle `arcDeg` | drawn half-angle | true? |
|---|---|---|---|
| shock_cannon | 150° | **85°** | no — clamped |
| secondary_battery | 120° | **85°** | no — clamped |
| torpedo | 45° | 45° | yes |
| missile | 120° | **85°** | no — clamped |
| wmgun | 3° | 3° | yes |

`hud.js:1351` is `const half = (Math.min(arcDeg, this.arcMaxDisplayDeg) * Math.PI) / 180;`
so the clamp still bites for **three of the five** Yamato weapons. The rework
genuinely improved things — the sector is projected onto the ship's plane and a
±3° wave-motion-gun arc now reads as a narrow spike — but the claim that the
drawn arc is the weapon's true arc holds only for torpedo and wmgun.

This is display-only and it never hides whether a shot will leave the barrel:
the weapons panel still reports `3/3 BEARING` and the target panel still says
IN FIRING ARC / OUT OF ARC, both computed from the true value. It is the
comment, and the belief behind it, that are wrong.

---

## 5. Performance

Measured from scratch, with the fleet actually on screen. This matters: the
previous figure of 30 588 triangles was taken while a defect made 4 of 6 ships
invisible, so it described a frame that did not contain the fleet.

Scenario: wave 1 — yamato, 2× yukikaze, 3× garmillas_kelkapia, all six inside
the camera frustum, plus 32 live projectiles. `renderer.info.autoReset = false`
with `info.reset()` around a single frame, so every composer pass counts.

```
calls 278   triangles 42 894   points 11 600
geometries 145   textures 16   programs 15
```

Sanity check that the fleet is really being drawn: the six hulls' manifest
triangles sum to 11 668 + 2×3 876 + 3×7 752 = **42 676**, and the frame reports
42 894 — the fleet plus ~218 triangles of tracers and effects. Every hull is in
the count.

**CPU cost per frame** (blocks of 25–60 frames, median of the block means):

```
with 6 ships + 32 live projectiles in frame : median 5.776 ms   min 4.896 ms
simulation only (render path stubbed)       :        0.852 ms
render share                                :       ~4.92 ms
implied CPU-bound ceiling                   :      ~173 FPS
```

**Observed FPS: NOT MEASURED, deliberately.** The shared browser window reported
`document.hidden === true` for the entire session, which suspends
`requestAnimationFrame` — the app's own loop never ran, and a count of rAF
callbacks returned 0 over 3 s. Combined with a host load average of 114–158 from
an unrelated emulator, any wall-clock FPS I could produce would be a measurement
of the host, not of the demo. The demo's own HUD readout showed **53–60 FPS**
across captures; I record that as an observation with the caveat attached rather
than as a result. **The CPU-per-frame figure is the number to trust.**

---

## 6. Defects and observations

Reported, not fixed — all of these are in `src/**`, `tools/**` or `assets/**`.

### Defects

| id | severity | what |
|---|---|---|
| `YAMATO-BARREL-1` | **MEDIUM** | Yamato `turret_secondary_1`'s barrels are buried inside `turret_main_2`'s gunhouse — 15.6 % of its surface, ~8.2 m of barrel length. Visible. |
| `YAMATO-BARREL-2` | LOW/MED | Yamato `turret_main_2`'s muzzles penetrate `turret_main_1`'s roof plate by up to 0.80 m. Not visible at chase-camera range, but it is present-but-wrong geometry. |
| `HUD-ARC-1` | LOW | `arcMaxDisplayDeg = 85` still clamps the drawn sector for shock_cannon (150°), secondary_battery (120°) and missile (120°). The CONFIG comment claiming the true arc is drawn is inaccurate. |
| `VALIDATE-CFG-1` | LOW | The CONFIG-derived rule is skipped (warning only) when the models directory is not at `<project>/assets/models`. |
| `DOC-TOTAL-1` | LOW | The fleet total is stated as 62 432 in the task brief and in the previous VERIFY.md; it is **65 836**. The per-hull figures were all correct. |
| `DOC-INERT-1` | LOW | The brief names kirishima and yukikaze as carrying inert `missile_launcher` hardware. **Andromeda warns too (6 hardpoints)** — three ships, not two. |

### Observations (not defects)

* **During passive play, nothing but your own ship is on screen.** After 120 s
  of AI-flown combat with no player input, the nearest enemy was 999 m away and
  **56.8° off the camera axis** while the horizontal half-FOV is 39.9°; the other
  two enemies were at 79.7° and 108.2°, and **both escorts were behind the camera
  at 116.4° and 141.6°**. The chase camera pitches ~39° down at the player, so
  contacts beyond roughly 800 m at the same altitude fall outside the 27.5°
  vertical half-FOV. This is not a correctness defect — the radar, target
  brackets and target panel still convey the fight, and a player who manoeuvres
  brings ships into frame — but the demo's headline visual is not what a passive
  viewer sees.
* **Marginal port recessions.** By the same distance test that passed the
  torpedo ports, a few mounts sit slightly inside the plating: bolar
  `anti_air_3/4/9/13/14/19` at 0.38–0.74 m, dessler `wave_motion_gun` at 0.41 m,
  gaiderol `wave_motion_gun` at 0.54 m. These are small enough to be deliberate
  (a wave-motion emitter set into the bow face), so I record them for the
  author's judgement rather than calling them defects.
* **`ship.turrets` holds 23 entries for 9 physical mounts.** OBJ groups are
  split per material, so `turret_main_1` yields three meshes (gun_metal,
  hull_grey, deck_dark). All share one pivot and traverse in unison, so the
  behaviour is correct — but the traverse integration runs two to three times per
  physical mount.
* **The validator's superfiring check is a proxy.** `superfiring 6.53m (>= 6.0m)`
  measures pivot rise and cannot detect the two `YAMATO-BARREL-*` defects. It is
  not wrong, but it should not be read as "the superfiring pair works".

---

## 7. How to reproduce everything

```bash
cd yamato-fleet
node tools/serve.mjs --port 8177          # serve the demo
node --test tests/                        # 116 pure-logic tests, must all pass
python3 tools/validate_models.py assets/models    # must exit 0
node tests/make_revision.mjs              # refresh evidence/revision.json

# generator determinism, WITHOUT writing into assets/:
for d in a b c; do python3 tools/gen_models.py --out /tmp/ygen/$d --quiet; done
for f in /tmp/ygen/a/*; do n=$(basename $f); \
  shasum -a 256 /tmp/ygen/{a,b,c}/$n assets/models/$n; done   # four identical columns
```

The bundled interpreter used throughout:
`/Users/azuma/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`

For the browser side, open
`http://127.0.0.1:8177/evidence/loop-probe.html`, set `window.__MANUAL__ = true`
to stop the real `rAF` double-stepping, then drive
`window.__RUN__(frames, dtMs)`. **Once `__MANUAL__` is set, the app's own loop
stops permanently** — a later `__MANUAL__ = false` will not restart it, so any
wall-clock FPS measurement must be taken on a page where it was never set.

The model analysis in [§2](#2-the-rebuilt-models-adversarially) is self-contained
Python: parse the OBJ into triangles, sample points on one group's surface, and
test each sample for being inside another group's closed mesh by ray-casting
along +X and counting crossings. Every such test in this file is reported with a
control (a group that should *not* intersect), because a point-in-mesh test that
returns "everything intersects everything" would otherwise look like a finding.

### What is in `evidence/`

| file | what it shows |
|---|---|
| [01-loaded-hud.jpg](../evidence/01-loaded-hud.jpg) | Loaded demo. **The weapons panel with all five Yamato weapons, including the new ミサイル MISSILE row**; FIRE MODE T MANUAL; radar `CONTACTS 5 R 9.00km`; target panel `KELKAPIA-1 427m IN FIRING ARC`; ship panel with subsystem pips WMG/ENG/MAIN/SEC/BRIDGE/CIWS |
| [02-combat.jpg](../evidence/02-combat.jpg) | Combat at ~250 m: a Garmillas hull in frame with the blue shield bubble, live reload timers, `FIRE MODE AUTO 自動射撃`, WMG `CHARGING 15%` |
| [04-wmgun-firing.jpg](../evidence/04-wmgun-firing.jpg) | Wave motion gun fired: weapons panel reads `波動砲 WAVE MOTION GUN 12.0km · RELOAD 60s`, target destroyed. Yamato in profile — turrets, deck, red waterline, twin blue nozzles |
| [07-victory.jpg](../evidence/07-victory.jpg) | **Victory overlay** `VICTORY / ALL WAVES CLEARED — 地球連邦宇宙海軍`, `MISSION WAVE 3 · T+2:28`, `CONTACTS 8`, surviving fleet and the Yamato in frame |
| [09-defeat.jpg](../evidence/09-defeat.jpg) | **Defeat overlay** `SHIP LOST / YAMATO LOST WITH ALL HANDS — [R] TO RESTART`, every weapon `OFFLINE`, SHIELD 0/2 400 ARMOR 0/2 200 HULL 0/4 400, kill feed `艦船喪失 / YAMATO LOST` |

**Four images were deleted rather than replaced**: `03-shared-model-instances`,
`05-explosion`, `06-closeup-enemy` and `08-yamato-hero`. Every one of them showed
pre-rebuild hulls, and leaving them in place would have presented obsolete
geometry as current evidence. The defect `03` documented (`SHARED-OBJ3D-1`) is
re-verified numerically instead — `uniqueObject3D === 6` in item 2 — which is
the stronger check anyway, since it cannot be satisfied by a lucky camera angle.

---

## 8. Known gaps / not verified

Stated plainly, because a comfortable false PASS is worth less than an honest
PARTIAL.

1. **No wall-clock FPS.** The window reported `document.hidden === true`
   throughout and the host was at load 114–158. I report CPU ms/frame instead
   and decline to publish an FPS number.
2. **Screenshot capture of DOM overlays is unreliable while the window is
   hidden.** The compositor can serve a stale layer: one defeat capture came
   back as the *victory* frame (55 differing pixels), and a later fleet capture
   still showed a `SHIP LOST` overlay after the game had returned to `playing`.
   Both were detected by diffing captures pixel-wise and were re-shot after
   forcing a repaint; a third attempt was discarded. **Every image in
   `evidence/` was checked this way** — by reading it and by pixel-diffing it
   against its neighbours — rather than trusted by file size.
3. **Audio is verified structurally, not audibly.** I confirmed the real
   `AudioEngine` and a running `AudioContext` on an earlier revision but did not
   re-establish the full audio matrix at `d864fb9`, and I cannot judge whether
   the procedural score sounds right. `src/core/music.js` and
   `assets/audio/manifest.json` are **not** covered by this verification.
4. **Chromium only.** Everything was verified in the harness browser. SPEC §2
   targets "current Chrome/Safari"; Safari and Firefox are untested.
5. **Model silhouette fidelity is not verified.** Whether a hull *looks like* the
   ship it claims to be is a design judgement. §2 checks placement, pivots,
   flushness and interpenetration — structural properties — and deliberately
   does not score resemblance.
6. **No sustained unattended run.** The longest single session was 1 800 frames
   (30 s) plus the wave run to victory. Object-pool or memory growth over a
   multi-minute unattended session is not measured. The projectile pool did show
   a healthy add/recycle cycle (`active` growing and shrinking, 58 children in
   the group) while I was measuring, but that is not a leak test.
7. **The pre-freeze revision was not fully verified.** My first `node --test`
   run (116/116) and the first `validate_models.py` run were taken at `25ea8cf`
   before the Lead froze the tree at `d864fb9`. Both were re-run at the frozen
   revision and both results are reported from there; the earlier run is
   discarded, not inherited.
