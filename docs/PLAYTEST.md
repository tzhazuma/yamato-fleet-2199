# PLAYTEST — measured results

Scripted fast-forward runs against the real simulation, executed in the browser
through the `world.tick(dt)` hook (SPEC §7 / `src/main.js`). Using `tick` rather
than waiting in real time means a full 3-wave battle is exercised
deterministically in a few seconds of wall clock, and every number below is a
measurement, not an estimate.

The harness steers the player at the nearest hostile, fires the main and
secondary batteries inside 1950 m, torpedoes inside 1450 m, and fires the wave
motion gun whenever it is off cooldown and the bow is within 0.05 rad of the
solution. **It is therefore a perfect-aim upper bound on player performance** —
a human will do worse on every axis, especially the ±3° wave motion gun.

---

## Run 1 — full battle (final integration)

All fixes in place: AI targeting published, fleet array held by reference,
capsule hull collision, canon-length models.

| Metric | Value |
|---|---|
| Simulated time | **294.8 s** |
| Outcome | **victory** |
| Kills | 8 |
| Player EHP at end | **2656 / 9000 (30%)** |
| Player pools at end | shield 0 · armor 0 · hull 2656 / 4400 |
| Lowest EHP reached | 2656 (never below 30%) |
| Total damage taken | 9881 |
| Damage dealt | 29 018 |
| Wave motion gun shots | 3 |
| Ally losses | 0 |
| Peak live projectiles | 42 |
| Console errors/warnings | **0** |

**This lands exactly on the research target** of "the player finishes on ~20–35%
of pools remaining" (`docs/research/02-combat-mechanics.md` §9.4), and it does so
with the armor layer fully stripped — so hull damage, and therefore the
subsystem mechanic, is genuinely in play at the end.

For comparison, the same harness before the AI targeting fix finished on
**8982 / 9000 (99.8%)** — the enemies were firing blind.

### Progression

| t | wave | hostiles | allies | player EHP | kills |
|---|---|---|---|---|---|
| 24 s | 1 | 3 | 2 | 8118 | 0 |
| 54 s | 1 | 1 | 2 | 7128 | 2 |
| 84 s | 1 | 1 | 2 | 6589 | 2 |
| 114 s | 2 | 2 | 5 | 8211 | 3 |
| 144 s | 2 | 1 | 5 | 6348 | 4 |
| 174 s | 3 | 3 | 8 | 6205 | 5 |
| 294 s | 3 | 0 | 8 | 2656 | 8 |

Note the shield recovering between waves (6589 → 8211) and being stripped again
in each engagement. That is the intended pressure curve: armor loss is permanent,
shields are the safety valve.

---

## Run 2 — passive defence: enemy offence in isolation

Player holds station at throttle 10%, **not shooting back**, 120 s, wave 1 only
(3 Garmillas Kelkapia-class cruisers).

| Metric | Value |
|---|---|
| Enemy weapon pulls | 97 |
| Hits on the player | 242 |
| Damage landed on the player | 4275 |
| **Effective enemy DPS** | **35.6** |
| Player EHP | 9000 → **4434 (49% lost in one wave)** |
| Player pools at end | shield 0 · armor 0 · hull 4013 |
| Player subsystems disabled | none |

Target acquisition is correct throughout — all three cruisers hold `YAMATO` as
their target, close to ~1500 m (their `preferredRangeFactor` 0.80 × the 1800 m
beam range) and cycle their weapons on cooldown. Hits exceed pulls because one
pull throws `mounts × salvo` projectiles (2 mounts × 2 = 4 bolts per Kelkapia).

Before the AI targeting fix, the equivalent run produced **136 pulls for 2 hits
(1.5%) and 0 net damage**.

---

## Difficulty: what the numbers actually say

The two runs bracket the real experience, and the gap between them is the point.

| Play style | Outcome |
|---|---|
| **Passive / poor gunnery** (run 2) | 49% of EHP lost in wave 1 alone; 35.6 DPS incoming |
| **Perfect aimbot, aggressive** (run 1) | victory at 30% of pools |
| **Perfect aimbot, patient kiter** | victory at 74–93% of pools |
| **Perfect aimbot that never lines up the WM gun** | victory at 3% of pools — a razor-thin win |

So the demo is **genuinely demanding for a normal player** and comfortable only
for a perfect aimbot. Three design choices drive that spread, and all three are
deliberate:

1. **The 200 m standoff band.** Shock cannon 2000 m vs Garmillas beams 1800 m.
   A player who manages range takes far less damage — which is why the patient
   harness finishes at 74–93% while a passive one loses half its pools in a
   single wave.
2. **The wave motion gun's ±3° arc.** It is the single largest damage source in
   the game and it cannot be used while manoeuvring. A harness that never lines
   the bow up finishes on 3%; one that stops to aim clears waves comfortably.
   That gradient *is* the weapon's design.
3. **Escorts absorb fire.** UNCF escorts soak a large share of the opening
   exchange, which is what makes the battle read as a fleet action — but it also
   means the researched solo TTK model (`docs/research/02-combat-mechanics.md`
   §9.4, "20–35% of pools remaining") is an upper bound on difficulty, not a
   prediction, once escorts are on the field.

**No further balance tuning was applied.** The researched baseline
(`accuracy` 0.55 / 0.50) is in force; a temporary bump to 0.62 was reverted once
the AI targeting defect that justified it was fixed.

---

## Defects found by playtesting (all fixed)

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | Pooled missiles/torpedoes inherited a stale `hp`, so point defence destroyed them on the first tick — torpedoes never landed | torpedoes spawned with `hp ≈ -6.5e-13` and died within 0.5 s | initialise `hp` in `Projectile.reset()` and from `spec.hp` in `spawn()` |
| 2 | Arena boundary damped a ship's *whole* velocity every frame, pinning anything that reached 6000 m at ~0 m/s permanently | 2 cruisers and the player frozen at 11 883 m apart, speed 2.5 m/s, `distDelta` 0 over 8 s | cancel only the outward velocity component + a gentle inward pull |
| 3 | Enemy fleet fired blind: `ship.target` was never set, so `canFire` skipped the range/arc checks and returned true | 136 pulls, 2 hits (1.5%), `ship.target === null` on every hostile while `aiState === 'engaging'` | refuse blind AI fire; pass an explicit target through `world.fireWeapon(ship, id, target)`; backfill `ship.target` after the AI update |
| 4 | `FleetAI` snapshotted its ship array at construction, so it never saw ships spawned after it was built | `world.ai.garmillas.ships.length === 0` while `world.fleets.garmillas.length === 3` | `world.refreshAI()` rebuilds the instances after every wave spawn |
| 5 | Every wave announced twice | two `'wave'` events with the same index and `spawned` count | de-duplicate: the orchestrator only emits if the spawner stayed silent |
| 6 | Shock cannon and torpedoes refused to fire at 3125 m | `canFire` false; range guard working as designed at a 2000 m envelope | not a defect — recorded here because it looked like one |
| 7 | Projectile collision used a sphere at the ship's centre, so shots fore and aft of amidships missed — and on the 638 m Desler flagship the sphere (r 100 m) was **smaller than the ship's own half-beam** (122.5 m) | flagged by asset-forge from the validator's bbox output | replaced with a **hull capsule** (bow→stern segment + a radius from `beamM`), using an allocation-free segment-to-segment distance test |
| 8 | The wave motion gun ignored its own ±3° bow arc: `fireWeapon` short-circuited to `fireWaveMotionGun` before `canFire`, and `requiresArc` was read nowhere | verifier: a cruiser **90° off the bow** was destroyed by one shot; `canFire` said false while `fireWeapon` returned true | range + arc gates enforced inside `fireWaveMotionGun`, gated on `spec.requiresArc`, keeping the 0.35 partial-charge release separate from `canFire`'s full-charge rule |
| 9 | Point defence divided its output by the engagement **cap**, not the targets actually engaged — a 4-mount suite dealt 10 dps per missile instead of 80 | verifier: 6 missiles parked in the envelope for 1.00 s each took exactly 10 hp; **0 of 6** destroyed where research §1.4 predicts 1.5 | PD now focuses fire on the nearest hostile: measured **80.0 hp in 1.00 s** and 1 of 6 destroyed with a second on ~22 hp |
| 10 | The wave motion gun subsystem was created **twice** (1800 hp instead of 900), and killing one copy left the gun firing | verifier: `[['wave_motion_gun',900],['wave_motion_gun_1',900]]`; destroying the first left `hasWorkingSubsystem('wmgun') === true` | the mounts loop skips `kind === 'wmgun'`, since the explicit bow-mount subsystem already owns it |

---

## Balance changes made in response

| Change | From | To | Why |
|---|---|---|---|
| `arcDeg` semantics | ship-level forward cone | **per-mount traverse half-angle** (turrets 150°, wave motion gun 3°) | research §6; the old model made turrets unable to bear while broadside, contradicting the AI's own doctrine |
| `broadsideBias` (uncf) | 0.80 | **0.20** | research §6: Yamato's three main turrets are all on the centreline, so bow-on is strongest |
| Garmillas `accuracy` | 0.55 | **0.62** | 42% measured hit rate left the player untouched; this is the first lever in the research's tuning order |
| Bolar `accuracy` | 0.50 | **0.58** | same |
| `chaseDistance` / `chaseHeight` | 430 / 120 | **355 / 150** | research §4 item 15: the reference frames ships filling 40–60% of frame width |
| `render.nebula` | on | **off** | research §4: 51–91% of every reference frame is literally `#000000` |
| Beam colours | invented | **measured** (`#6ce9fc` UNCF, `#6ab86a` Bolar) | research §4 |
| Explosions | orange particles | **white star sprites** | research §4: the reference's explosions are 16 732 px of exactly `#ffffff` |
| Shield bubble | opaque additive sphere | **fresnel rim shader** | it rendered as a flat blue disc that hid the ship |
| Wave motion gun beam | 30 m / 26 m radius, opacity 0.95 | **16 m / 12 m, opacity 0.55** | washed out the entire frame |
| Projectile collision | sphere at ship centre | **hull capsule** (segment + `beamM`-derived radius) | a sphere is a poor fit for a 638 m hull and missed everything fore and aft |
| `CONFIG.ai.targetPriority.player` | absent | **0.55** | enemies chased escorts and ignored the Yamato |
| Enemy `accuracy` | temporarily 0.62 | **back to the researched 0.55 / 0.50** | the bump only compensated for the broken AI targeting; once that was fixed it made the demo harder than the research intends |
| Point defence allocation | `dps / maxTargets` (cap) | **focus fire on the nearest hostile** | the cap divisor made PD 8× too weak; a 6-missile salvo landed 6/6 hits |

---

## Known gaps

- **The harness is an aimbot.** Every difficulty number above is an upper bound
  on player performance — a human will do worse, especially with the ±3° wave
  motion gun. No human playtest has been run; the research's ranked tuning levers
  (`docs/research/02-combat-mechanics.md` §9.4) remain available.
- **No subsystem was disabled in run 1** even though hull damage occurred
  (1744 hull damage × 15% redirect ≈ 262 spread across subsystems, against
  900–1200 HP pools). The mechanic is implemented and unit-tested but has not
  yet been observed triggering organically. Its routing rule *is* verified: see
  `docs/VERIFY.md`.
- **Escorts survived every wave** (`allyLosses: 0`), so they currently read as
  free damage sponges rather than as losses with weight.
- **Radar zoom** is bound to `Z` but the radar still auto-ranges.
- The 60 Hz fixed timestep means the numbers above are frame-rate independent;
  they were produced at a simulated 60 Hz, not at the browser's ~120 fps.
