# 02 — Combat Mechanics & Balance Research

> Owner: **researcher-gameplay** · Status: v1 (numbers frozen enough to implement)
> Consumer: `src/core/config.js` (Lead), `src/weapons/weapons.js` (Lead),
> `src/ai/fleetai.js` (engine-dev)
>
> **§1 is the deliverable the Lead is blocked on.** Everything after it is the
> justification, the survey of how other games solve the same problems, and the
> canon notes. Web sources are cited inline as `[n]` and listed in §12.
> All web content was treated as untrusted data.

---

## 1. RECOMMENDED NUMBERS (paste-ready)

### 1.0 Units & fire-rate convention — read this first

| Quantity | Unit | Convention |
|---|---|---|
| Distance, range, projectile speed | **metres** (and m/s) | SPEC §4: `1 world unit = 1 metre`, `SHIP_SCALE = 1.0` |
| Time | **seconds** | |
| Damage / shield / armor / hull | **DP** ("damage points") | 1 DP = 1 point off one pool. Pools are pure numbers, not tonnes. |
| Angles | **radians** | SPEC §4 |
| `spread` | **radians**, half-angle of a cone | 0.010 rad ≈ 0.57° |

**Fire rate (this is the whole damage model, keep it this simple):**

```
sustainedDPS = damage * salvo / cooldown        // per mount, assuming every shot hits
```

* `damage` is **per projectile**.
* `salvo` projectiles leave the mount **simultaneously** on one trigger pull.
* `cooldown` is seconds **between trigger pulls**, timed from the previous pull
  (no extra "recovery" term). So `cooldown = 2.0, salvo = 3` means a 3-shell
  volley every 2 s.
* A mount only fires when the target is inside `range` **and** inside the
  turret's firing arc (§7).

> **Beams are pulsed, not continuous.** SPEC §6.4 gives every weapon a discrete
> `damage`/`salvo`/`cooldown`, so `garmillas_beam` and `bolar_beam` fire
> discrete bolts. Nebulous models beams as continuous 5-tick/s DPS streams [1],
> and we deliberately do **not** — one damage model for all seven weapons is
> worth more than beam fidelity here, and it keeps `applyDamage` a pure function
> the verifier can unit-test.

---

### 1.1 Ship pools — `CONFIG.ships[id]`

`totalEHP = shield + armor + hull`. Shield is the only renewable layer.

| id | role | length | shield | armor | hull | **totalEHP** | shield regen |
|---|---|---|---|---|---|---|---|
| `yamato` (player) | battleship | 333 m | 2400 | 2200 | 4400 | **9000** | 120 /s after 4 s |
| `andromeda` | battleship | 444 m | 3000 | 2600 | 5400 | **11000** | 120 /s after 4 s |
| `kirishima` | cruiser | 222 m | 1100 | 1000 | 1900 | **4000** | 80 /s after 4 s |
| `yukikaze` | destroyer | 80 m | 300 | 250 | 450 | **1000** | 60 /s after 4 s |
| `garmillas_dessler` | flagship | 400 m | 2600 | 2400 | 4600 | **9600** | 100 /s after 5 s |
| `garmillas_kelkapia` | cruiser | 250 m | 1200 | 1000 | 2000 | **4200** | 80 /s after 5 s |
| `garmillas_gaiderol` | battleship | 390 m | 2200 | 2000 | 4000 | **8200** | 100 /s after 5 s |
| `bolar_carrier` | carrier | 380 m | 1900 | 1700 | 3400 | **7000** | 90 /s after 5 s |

**Global damage rules** (`CONFIG.damage`):

| key | value | meaning |
|---|---|---|
| `layering` | `['shield','armor','hull']` | strict order; overflow carries to the next layer in the **same** hit |
| `shieldRegenDelay` | 4.0 s (player) / 5.0 s (AI) | seconds since last damage taken before regen starts |
| `shieldRegenRate` | see table | DP/s, clamped to `shieldMax` |
| `armorRegen` | 0 | armor never regenerates |
| `hullRegen` | 0 | hull never regenerates |
| `subsystemDamageFraction` | 0.15 | 15 % of every **hull-layer** hit is redirected to one subsystem (§6) |
| `critChance` | 0.08 | chance a hit that reaches the hull also rolls a critical (2× subsystem share) |

> **Design argument for `armorRegen = 0`:** armor is the "chip damage" layer.
> Making it permanent is what produces the demo's pressure curve — by wave 3 the
> player is flying on hull and *knows* it. Shields regenerating between waves is
> the safety valve that makes "survive 3 waves" achievable (§9.4).

---

### 1.2 Player weapons — `WEAPONS` entries

| id | kind | damage | salvo | cooldown | **DPS** | speed | **effective range** | spread | shieldMult |
|---|---|---|---|---|---|---|---|---|---|
| `shock_cannon` | shell | 90 | 3 | 2.0 s | **135.0** | 900 m/s | **2000 m** (6.0 × L) | 0.010 | 1.00 |
| `secondary` | shell | 22 | 4 | 1.5 s | **58.7** | 800 m/s | **1200 m** (3.6 × L) | 0.020 | 1.00 |
| `torpedo` | torpedo | 260 | 4 | 12.0 s | **86.7** (burst) | 300 m/s | **1500 m** (4.5 × L) | — (homing) | 0.60 |
| `wmgun` | wmgun | 4800 | 1 | 60.0 s | — (one shot) | 4000 m/s | **12000 m** (36 × L) | 0.002 | 1.25 |

* Player all-guns DPS (shock + secondary, 100 % hits) = **193.7 DP/s**.
* Plus a torpedo salvo = **280.4 DP/s** while the salvo is in flight.
* `L` = Yamato length = 333 m (SPEC §5).
* `torpedo.shieldMultiplier = 0.60` — torpedoes are poor against shields, strong
  against armor/hull. This is the classic naval-wargame split and it gives the
  player a reason to strip shields with guns *first*, then torpedo.

**Wave motion gun** (`wmgun`) — the numbers the brief asked for:

| field | value | check |
|---|---|---|
| `chargeTime` | **8.0 s** | inside the 6–10 s target ✔ |
| `cooldown` | **60.0 s** | inside the 45–70 s target ✔ |
| full cycle | 68 s | ~4 shots across a 300 s demo |
| `chargeDamage` | 4800 | |
| `range` | 12000 m | effectively arena-wide |
| `speed` | 4000 m/s | 3 s to cross 12 km — reads as instant |
| firing arc | **±3° (±0.0524 rad)** | "narrow": the bow must be pointed at the target |
| `shieldMultiplier` | 1.25 | wave-motion energy partly bypasses shields |
| `life` | 1.0 s | long enough to sweep a line of enemies |

Damage sanity checks (these are the acceptance tests for the number):

| target | totalEHP | after one WMG hit | verdict |
|---|---|---|---|
| `garmillas_kelkapia` | 4200 | **destroyed** (600 overkill) | one-shots a cruiser ✔ |
| `bolar_carrier` | 7000 | 2200 left = 31 % | gutted ✔ |
| `garmillas_gaiderol` | 8200 | 3400 left = 41 % | gutted ✔ |
| `garmillas_dessler` | 9600 | 4800 left = 50 % | gutted ✔ |
| `yamato` (if an enemy ever had one) | 9000 | 4200 left = 47 % | **cannot** one-shot the player ✔ |

---

### 1.3 Enemy weapons — `WEAPONS` entries

| id | kind | damage | salvo | cooldown | **DPS / mount** | speed | effective range | spread | shieldMult |
|---|---|---|---|---|---|---|---|---|---|
| `garmillas_beam` | beam | 18 | 2 | 3.0 s | **12.0** | 1200 m/s | **1800 m** (5.4 × L) | 0.028 | 1.00 |
| `missile` | missile | 60 | 6 | 10.0 s | **36.0** (burst) | 400 m/s | **2500 m** (7.5 × L) | — (homing) | 1.00 |
| `bolar_beam` | beam | 21 | 2 | 2.5 s | **16.8** | 1100 m/s | **1700 m** (5.1 × L) | 0.030 | 1.00 |

**Missile / torpedo durability** (so point-defence has something to chew on):

| projectile | hp | note |
|---|---|---|
| `missile` | **120** | needs ~6 PD hits |
| `torpedo` | **150** | needs ~8 PD hits |

**Mount counts per ship** (`CONFIG.ships[id].mounts`) — this is how one weapon
spec produces different threat levels:

| ship | `garmillas_beam` | `missile` | `bolar_beam` | **raw gun DPS** |
|---|---|---|---|---|
| `garmillas_kelkapia` | 2 | 0 | — | **24.0** |
| `garmillas_gaiderol` | 4 | 1 | — | **48.0** (+36 missile raw) |
| `garmillas_dessler` | 4 | 1 | — | **48.0** (+36 missile raw) |
| `bolar_carrier` | — | 0 | 3 | **50.4** |
| `andromeda` (friendly) | 4 | 0 | — | 48.0 |
| `kirishima` (friendly) | 2 | 0 | — | 24.0 |
| `yukikaze` (friendly) | 1 | 0 | — | 12.0 |

> Garmillas ships deliberately **out-range nobody**: `garmillas_beam` 1800 m <
> `shock_cannon` 2000 m. The player therefore has a ~200 m standoff band. That
> single number is what makes "back off and repair your shields" a real tactic
> instead of a fantasy, and it rewards the Yamato's higher top speed.

---

### 1.4 Point defence — `CONFIG.pointDefence`

Point defence is **not** in the SPEC §6.4 `WEAPONS` list, so it does not need to
be a `WEAPONS` entry. Recommended home: `CONFIG.pointDefence`, consumed by
`updateWeaponMounts()` and by the projectile update loop. *(Lead's call — adding
`point_defence` to `WEAPONS` would also work and costs nothing.)*

| field | value |
|---|---|
| `range` | **900 m** (2.7 × L) |
| `damage` | 5 (vs missiles/torpedoes only — **no** ship damage) |
| `cooldown` | 0.25 s |
| `salvo` | 1 |
| **DPS per mount** | **20.0** |
| `tracking` | only engages `missile` / `torpedo` projectiles |
| mounts — `yamato` | **4** (→ 80 DPS) |
| mounts — `garmillas_gaiderol` | 4 (→ 80 DPS) |
| mounts — `garmillas_kelkapia` | 2 (→ 40 DPS) |
| mounts — `bolar_carrier` | 3 (→ 60 DPS) |
| mounts — `kirishima` / `yukikaze` | 2 / 1 |

**Leak-rate check** (this is the number that decides whether missiles feel
scary). A Garmillas missile flies at 400 m/s, so it spends `900 / 400 = 2.25 s`
inside the 900 m PD envelope:

| defender | PD DPS in the 2.25 s window | damage dealt | missiles killed (120 hp) | of a 6-missile salvo | leaking |
|---|---|---|---|---|---|
| `yamato` (4 mounts) | 80 | 180 | 1.50 | 6 | **4.5 leak** → **270 DP** |
| `garmillas_gaiderol` (4) | 80 | 180 | 1.50 | 6 | 4.5 leak → 270 DP |
| `garmillas_kelkapia` (2) | 40 | 90 | 0.75 | 6 | **5.25 leak** → 315 DP |
| `bolar_carrier` (3) | 60 | 135 | 1.13 | 6 | 4.88 leak → 292 DP |

So a Garmillas missile salvo vs the player lands ≈ **270 DP** (3.0 % of the
player's 9000 EHP) — a sting, not a death sentence, and it *rewards the player
for killing PD-heavy escorts first*. Tune `range` first if missiles feel weak;
tune `damage` first if they feel strong.

**The same check from the other side** (the player's torpedoes, 300 m/s, 150 hp,
against enemy PD): a torpedo spends `900 / 300 = 3.0 s` in the envelope.

| defender | PD damage | torpedoes killed | of a 4-torpedo salvo | leaking |
|---|---|---|---|---|
| `garmillas_gaiderol` (4) | 240 | 1.60 | 4 | 2.4 leak → **624 DP** |
| `garmillas_kelkapia` (2) | 120 | 0.80 | 4 | 3.2 leak → **832 DP** |

So a torpedo salvo is worth ~624–832 DP of real damage rather than the nominal
1040 DP — a ~25–40 % tax. That is the right size: torpedoes are still the best
burst in the game, but not a free win.

---

### 1.5 TTK table — the two targets the brief specified

**Target A: player → `garmillas_kelkapia` (4200 EHP), shock cannon only = 25–40 s.**

| weapon set | DPS | **TTK** |
|---|---|---|
| `shock_cannon` only | 135.0 | **31.1 s** ✔ (dead centre of 25–40 s) |
| `shock_cannon` + `secondary` | 193.7 | 21.7 s |
| + one `torpedo` salvo (no PD) | 280.4 | 15.0 s |

**Full player → enemy TTK table** (100 % hits, no PD, target not manoeuvring):

| target | totalEHP | shock only (135) | all guns (193.7) | + torpedo (280.4) | one WMG |
|---|---|---|---|---|---|
| `yukikaze` | 1000 | 7.4 s | 5.2 s | 3.6 s | overkill |
| `kirishima` | 4000 | 29.6 s | 20.6 s | 14.3 s | overkill |
| `garmillas_kelkapia` | 4200 | **31.1 s** | 21.7 s | 15.0 s | **kill** |
| `bolar_carrier` | 7000 | 51.9 s | 36.1 s | 25.0 s | 31 % left |
| `garmillas_gaiderol` | 8200 | 60.7 s | 42.3 s | 29.2 s | 41 % left |
| `garmillas_dessler` | 9600 | 71.1 s | 49.6 s | 34.2 s | 50 % left |
| `andromeda` | 11000 | 81.5 s | 56.8 s | 39.2 s | 56 % left |

**Target B: enemy → player, 90–150 s of combined fire.**

`TTK = 9000 / rawAggregateDPS`, where `rawAggregateDPS` assumes every mount is in
arc and every shot connects. **This is a ceiling, not an expectation** — the AI's
`accuracy` (§1.7) and firing arcs mean the real rate is roughly half.

| wave | composition | raw gun DPS | missile contribution | **raw total** | **TTK vs player** |
|---|---|---|---|---|---|
| 1 | 3 × `garmillas_kelkapia` | 72.0 | 0 | **72.0** | **125 s** ✔ |
| 2 | 1 × `garmillas_gaiderol` + 1 × `garmillas_kelkapia` | 72.0 | +11 (post-PD) | **83.0** | **108 s** ✔ |
| 3 | 1 × `bolar_carrier` + 2 × `garmillas_kelkapia` | 98.4 | 0 | **98.4** | **91.5 s** ✔ (hottest — it is the finale) |

All three waves sit inside the 90–150 s band, and they ramp monotonically.
**Wave 3 is intentionally the most dangerous.**

---

### 1.6 Wave definitions — `CONFIG.waves`

| wave | spawns | banner |
|---|---|---|
| 1 | `garmillas_kelkapia` × 3 | "GARMILAS PATROL — WAVE 1" |
| 2 | `garmillas_gaiderol` × 1, `garmillas_kelkapia` × 1 | "GARMILAS BATTLE GROUP — WAVE 2" |
| 3 | `bolar_carrier` × 1, `garmillas_kelkapia` × 2 | "BOLAR FEDERATION — WAVE 3" |

| key | value |
|---|---|
| `waveLull` | 10 s between waves (this is the shield-regen window) |
| `spawnDistance` | 3500 m from player, random bearing within ±60° of the player's forward |
| `spawnSpread` | 400 m between ships in a wave |
| `spawnDelayPerShip` | 0.6 s |
| `arenaRadius` | 6000 m soft boundary (AI turns back; player gets a HUD warning) |
| `wave1Delay` | 8 s after scene load (lets the player read the HUD) |

> **Why wave 3 reuses `garmillas_kelkapia`:** SPEC §5 ships exactly one Bolar
> hull (`bolar_carrier`). Reusing the Kelkapia as a "Bolar-allied conscript"
> keeps the wave populated without inventing an asset outside the frozen
> manifest. If `asset-forge` later adds a `bolar_escort`, swap it in 1:1 — the
> numbers above are per-hull and do not change.

---

### 1.7 AI aggression values — `CONFIG.ai[doctrine]`

| key | `garmillas` | `bolar` | `uncf` (friendly) | meaning |
|---|---|---|---|---|
| `accuracy` | **0.55** | **0.50** | 0.60 | probability an in-arc shot connects |
| `aggression` | 0.60 | 0.75 | 0.50 | 0 = hold range, 1 = charge in |
| `preferredRangeFactor` | 0.80 | 0.75 | 0.85 | × own weapon range |
| `broadsideBias` | 0.70 | 0.60 | 0.80 | 0 = bow-on, 1 = pure broadside |
| `focusFire` | `true` | `true` | `true` | all ships may share one target |
| `focusFireSwitchCooldown` | 8 s | 6 s | 8 s | min time on a target before re-picking |
| `reactionTime` | 1.2 s | 1.0 s | 1.0 s | delay before responding to a new threat |
| `retreatHullThreshold` | 0.25 | 0.15 | 0.30 | hull fraction at which it breaks off |
| `retreatShieldThreshold` | 0.0 | 0.0 | 0.0 | (unused; kept for tuning) |
| `formationSlotRadius` | 1.5 × own length | 1.2 × own length | 1.5 × own length | station-keeping box |
| `formationSlotCount` | 6 | 6 | 6 | slots per fleet |
| `missileFireMinRange` | 800 m | — | — | don't waste missiles in knife range |
| `missileFireMaxRange` | 2400 m | — | — | |
| `torpedoFireMinRange` | — | — | 400 m | player-side doctrine |
| `wmgunTelegraphTime` | 2.5 s | — | — | warning before an enemy WMG fires |
| `dodgeWMGChance` | 0.60 | 0.60 | 0.70 | chance a ship tries to evade a telegraphed WMG |
| `dodgeWMGThrust` | 1.0 (full throttle) | 1.0 | 1.0 | |
| `targetPriority.threat` | 0.45 | 0.45 | 0.45 | weight on "who is hurting me" |
| `targetPriority.role` | 0.30 | 0.30 | 0.30 | weight on ship-class value |
| `targetPriority.proximity` | 0.25 | 0.25 | 0.25 | weight on "who is closest" |

`roleValue` used by `targetPriority.role`:

| role | value |
|---|---|
| `flagship` | 1.00 |
| `battleship` | 0.90 |
| `carrier` | 0.80 |
| `cruiser` | 0.60 |
| `destroyer` | 0.40 |

**Threat score formula** (recommend exactly this — it is pure logic and testable):

```
score(target) =
    threatWeight    * (recentDamageDealtByTarget / max(1, myMaxHull))
  + roleWeight      * roleValue[target.role]
  + proximityWeight * (1 - clamp(dist(target) / 4000, 0, 1))
```
Re-pick only when `timeSinceLastPick > focusFireSwitchCooldown`, or when the
current target dies / leaves `range * 1.2`.

---

### 1.8 Movement & engagement scale — `CONFIG.ships[id].movement`

| ship | `maxSpeed` | `boostSpeed` | `reverseSpeed` | `yawRate` | `pitchRate` | `rollRate` | `accel` |
|---|---|---|---|---|---|---|---|
| `yamato` | 90 m/s | 180 m/s | 30 m/s | 0.20 rad/s | 0.15 | 0.50 | 25 m/s² |
| `andromeda` | 85 | 170 | 28 | 0.17 | 0.13 | 0.45 | 22 |
| `kirishima` | 120 | 240 | 40 | 0.40 | 0.28 | 0.80 | 40 |
| `yukikaze` | 200 | 400 | 70 | 0.80 | 0.55 | 1.40 | 80 |
| `garmillas_dessler` | 85 | 170 | 28 | 0.18 | 0.14 | 0.45 | 22 |
| `garmillas_kelkapia` | 110 | 220 | 38 | 0.35 | 0.26 | 0.75 | 38 |
| `garmillas_gaiderol` | 80 | 160 | 26 | 0.18 | 0.14 | 0.45 | 20 |
| `bolar_carrier` | 70 | 140 | 24 | 0.15 | 0.12 | 0.40 | 18 |

> **Why these speeds:** the primary engagement range is 2000 m. At the Yamato's
> 90 m/s cruise, crossing the full shock-cannon envelope takes ~22 s — long
> enough that range control is a decision, short enough that the player is not
> bored. Boost at 180 m/s closes 2000 m in 11 s, which is the "get me out of
> here" button. A Yukikaze at 200 m/s is 2.2× the Yamato — it *feels* like a
> destroyer.

---

### 1.9 Subsystems — `CONFIG.subsystems[id]`

15 % of every hull-layer hit is redirected to one random surviving subsystem
(`subsystemDamageFraction`, §1.1).

| subsystem | hp | effect when `disabled` |
|---|---|---|
| `wave_motion_gun` | 900 | WMG cannot charge; charge meter greys out; `wmgun` unusable |
| `engine_1`, `engine_2` | 1200 each | 1 dead → `maxSpeed × 0.5`; both dead → throttle forced to 0 |
| `turret_main_1..3` | 600 each | that mount stops firing (⅓ of shock-cannon DPS lost each) |
| `turret_secondary_1..2` | 400 each | that mount stops firing (½ of secondary DPS lost each) |
| `bridge` | 700 | `reactionTime × 2`, `accuracy × 0.75` |
| `pd_1..4` (yamato) | 200 each | that PD mount stops (25 % of PD DPS lost each) |

Subsystem HP values are ~14–20 % of the parent ship's `hullMax`, so a
subsystem kill takes a meaningful slice of a fight but never a whole one.

---

### 1.10 Ranges relative to ship length (sanity check for SPEC §4)

Yamato length **L = 333 m**. Everything below is a multiple of L.

| system | range | × L | comment |
|---|---|---|---|
| point defence | 900 m | **2.7 ×** | CIWS / Type-3-shell envelope |
| `secondary` | 1200 m | **3.6 ×** | |
| `torpedo` | 1500 m | **4.5 ×** | brawling weapon, as in canon |
| `bolar_beam` | 1700 m | **5.1 ×** | |
| `garmillas_beam` | 1800 m | **5.4 ×** | |
| **`shock_cannon`** | **2000 m** | **6.0 ×** | ← the brief's anchor number |
| `shock_cannon` hard cut-off | 2400 m | 7.2 × | damage falls to 0 |
| `missile` | 2500 m | **7.5 ×** | longest ranged non-WMG weapon |
| `wmgun` | 12000 m | **36 ×** | arena-wide |
| arena radius | 6000 m | 18 × | |

**Cross-check against reality:** the historical *Yamato*'s 46 cm guns had a
~42 km maximum range — about **126 × L**. Our 6 × L is ~21× shorter. That is
deliberate and it is the single most important decision in this document: at
126 × L the enemy is a sub-pixel dot and there is no demo. **6 × L is the
largest multiple at which a 333 m ship is still a legible object on a chase
camera.** World of Warships makes the same compromise (engagement ranges of
~10–25 km against ~250 m hulls ≈ 40–100 × L) but keeps ships legible by using a
forced high camera; we cannot, because SPEC §1 fixes a third-person chase camera.
So we compress to 6 × L.

---

### 1.11 Paste-ready `config.js` fragment

```js
// ---- balance -------------------------------------------------------------
// Units: metres, seconds, radians, "DP" damage points. SPEC §4: 1 unit = 1 m.
// sustainedDPS = damage * salvo / cooldown   (per mount, 100% hits)
const CONFIG = {
  ships: {
    yamato:             { shield:2400, armor:2200, hull:4400, shieldRegen:120, shieldRegenDelay:4,
                          maxSpeed:90,  boostSpeed:180, reverseSpeed:30, yawRate:0.20, pitchRate:0.15, rollRate:0.50, accel:25,
                          mounts:{ shock_cannon:3, secondary:2, torpedo:1, pd:4 } },
    andromeda:          { shield:3000, armor:2600, hull:5400, shieldRegen:120, shieldRegenDelay:4,
                          maxSpeed:85,  boostSpeed:170, reverseSpeed:28, yawRate:0.17, pitchRate:0.13, rollRate:0.45, accel:22,
                          mounts:{ garmillas_beam:4, pd:4 } },
    kirishima:          { shield:1100, armor:1000, hull:1900, shieldRegen:80,  shieldRegenDelay:4,
                          maxSpeed:120, boostSpeed:240, reverseSpeed:40, yawRate:0.40, pitchRate:0.28, rollRate:0.80, accel:40,
                          mounts:{ garmillas_beam:2, pd:2 } },
    yukikaze:           { shield:300,  armor:250,  hull:450,  shieldRegen:60,  shieldRegenDelay:4,
                          maxSpeed:200, boostSpeed:400, reverseSpeed:70, yawRate:0.80, pitchRate:0.55, rollRate:1.40, accel:80,
                          mounts:{ garmillas_beam:1, pd:1 } },
    garmillas_dessler:  { shield:2600, armor:2400, hull:4600, shieldRegen:100, shieldRegenDelay:5,
                          maxSpeed:85,  boostSpeed:170, reverseSpeed:28, yawRate:0.18, pitchRate:0.14, rollRate:0.45, accel:22,
                          mounts:{ garmillas_beam:4, missile:1, pd:4 } },
    garmillas_kelkapia: { shield:1200, armor:1000, hull:2000, shieldRegen:80,  shieldRegenDelay:5,
                          maxSpeed:110, boostSpeed:220, reverseSpeed:38, yawRate:0.35, pitchRate:0.26, rollRate:0.75, accel:38,
                          mounts:{ garmillas_beam:2, pd:2 } },
    garmillas_gaiderol: { shield:2200, armor:2000, hull:4000, shieldRegen:100, shieldRegenDelay:5,
                          maxSpeed:80,  boostSpeed:160, reverseSpeed:26, yawRate:0.18, pitchRate:0.14, rollRate:0.45, accel:20,
                          mounts:{ garmillas_beam:4, missile:1, pd:4 } },
    bolar_carrier:      { shield:1900, armor:1700, hull:3400, shieldRegen:90,  shieldRegenDelay:5,
                          maxSpeed:70,  boostSpeed:140, reverseSpeed:24, yawRate:0.15, pitchRate:0.12, rollRate:0.40, accel:18,
                          mounts:{ bolar_beam:3, pd:3 } },
  },

  damage: {
    layering: ['shield','armor','hull'],
    subsystemDamageFraction: 0.15,
    critChance: 0.08,
  },

  pointDefence: { range:900, damage:5, cooldown:0.25, salvo:1, speed:1500, spread:0.05,
                  targetKinds:['missile','torpedo'] },

  ai: {
    garmillas: { accuracy:0.55, aggression:0.60, preferredRangeFactor:0.80, broadsideBias:0.70,
                 focusFire:true, focusFireSwitchCooldown:8, reactionTime:1.2,
                 retreatHullThreshold:0.25, formationSlotRadius:1.5, formationSlotCount:6,
                 missileFireMinRange:800, missileFireMaxRange:2400,
                 wmgunTelegraphTime:2.5, dodgeWMGChance:0.60 },
    bolar:     { accuracy:0.50, aggression:0.75, preferredRangeFactor:0.75, broadsideBias:0.60,
                 focusFire:true, focusFireSwitchCooldown:6, reactionTime:1.0,
                 retreatHullThreshold:0.15, formationSlotRadius:1.2, formationSlotCount:6,
                 wmgunTelegraphTime:2.5, dodgeWMGChance:0.60 },
    uncf:      { accuracy:0.60, aggression:0.50, preferredRangeFactor:0.85, broadsideBias:0.80,
                 focusFire:true, focusFireSwitchCooldown:8, reactionTime:1.0,
                 retreatHullThreshold:0.30, formationSlotRadius:1.5, formationSlotCount:6,
                 dodgeWMGChance:0.70 },
    targetPriority: { threat:0.45, role:0.30, proximity:0.25 },
    roleValue: { flagship:1.00, battleship:0.90, carrier:0.80, cruiser:0.60, destroyer:0.40 },
    threatRange: 4000,
  },

  waves: [
    { id:1, banner:'GARMILAS PATROL — WAVE 1',
      ships:[ {id:'garmillas_kelkapia', count:3} ] },
    { id:2, banner:'GARMILAS BATTLE GROUP — WAVE 2',
      ships:[ {id:'garmillas_gaiderol', count:1}, {id:'garmillas_kelkapia', count:1} ] },
    { id:3, banner:'BOLAR FEDERATION — WAVE 3',
      ships:[ {id:'bolar_carrier', count:1}, {id:'garmillas_kelkapia', count:2} ] },
  ],
  waveLull: 10, spawnDistance: 3500, spawnSpread: 400, spawnDelayPerShip: 0.6,
  arenaRadius: 6000, wave1Delay: 8,
};
```

Weapon specs go in `src/weapons/weapons.js` (§1.2/§1.3 tables map 1:1 onto the
SPEC §6.4 fields).

---

## 2. Hit resolution: projectile vs hitscan

| Model | Used by | Pros | Cons |
|---|---|---|---|
| **Travelling projectile** | Homeworld 1/2/3 (most weapons), Empire at War, Nebulous shells | Dodgeable, PD-interceptable, reads beautifully with tracers, naturally produces "leads" and misses | Costs an entity per shot; needs sub-stepping to avoid tunnelling |
| **Hitscan** | World of Warships (shells resolve instantly, dispersion applied to the impact point), Nebulous **beams** (continuous ray) | Zero tunnelling, trivial cost, dispersion is exact | Cannot be dodged, cannot be intercepted, no visual travel |
| **Hybrid: fast projectile + cone dispersion** | Battlefleet Gothic: Armada (battery fire resolved as dice on a table, rendered as bolts) | Best of both for a demo | Slightly more code |

**Recommendation: travelling projectile for everything, with cone dispersion
resolved at fire time.** Concretely, on fire:

1. Compute the mount's world direction.
2. Draw a random unit vector inside a cone of half-angle `spread` around it.
3. Spawn a projectile with that direction and `speed`.

`wmgun` uses `spread = 0.002` (effectively a line) and `speed = 4000 m/s`, so it
behaves like a hitscan beam visually while remaining a projectile in code — one
code path, no special case.

**Why not true hitscan for beams:** SPEC §6.4 gives beams a `speed` field, and
`world.spawnProjectile` is the only spawn API. Keeping beams as projectiles
means the PD loop, the effects loop, and the tracer renderer all see one shape.

**Tunnelling guard (important at 4000 m/s):** at 60 fps, `wmgun` moves 66.7 m
per frame. Step projectile collision at a fixed `dt` sub-step of **≤ 1/240 s**
(16.7 m at 4000 m/s) and do a segment-vs-sphere test against each ship's
bounding sphere, not a point test. Ship bounding spheres are ~120–250 m in
radius so this is safe.

---

## 3. Shield / armor / hull layering

Three broad approaches in the surveyed games:

| Game | Model | Lesson for us |
|---|---|---|
| Nebulous: Fleet Command | No shields. **Armor is a thickness in cm**, penetration is a depth budget; components are individually hit and destroyed; `Damage Reduction` (DR) and `Damage Threshold` (DT) make small munitions ineffective against capital ships [1] | Deepest model of the lot. Its *DT* idea — "a killing hit must exceed DT or the component merely disables" — is the elegant part. Too much for a 5-minute demo, but its DR/DT insight is what our **armor layer** stands in for. |
| Homeworld 1/2/3 | Shields (regenerating) + armor + hull; subsystem modules on capital ships; weapons have a damage-type multiplier table | Confirms the 3-layer stack + subsystems is the readable minimum |
| Battlefleet Gothic: Armada | Shields (regenerating, "shields down" is a dramatic beat) + hull; **critical damage table** on hull hits (engine, weapons, bridge) | The "shields down!" moment is the demo's best beat — we get it for free with the 3-layer stack |
| Star Wars: Empire at War | Shields + hull, shield facing matters on some units, hardpoints | Facing-dependent shields are a nice-to-have; out of scope for v0.1 |
| Sins of a Solar Empire | Shields + armor + hull with **armor as a damage-reduction percentage by damage type** | The percentage model is the simplest thing that produces "small guns can't hurt battleships" |

**Recommendation: strict ordered pools, `shield → armor → hull`, overflow
carries in the same hit, plus a `shieldMultiplier` per weapon.** This is the
minimum that produces the three beats the demo needs:

1. *Shield phase* — the enemy is visibly untouched, shots flare blue, the HUD
   bar is cyan. Player learns "keep shooting".
2. *Armor phase* — shots spark orange, the HUD bar goes amber, **and it never
   comes back**. Player learns "this is permanent".
3. *Hull phase* — shots hit metal, smoke/fire VFX, the HUD bar goes red and
   starts flashing. Player learns "I am about to die".

`shieldMultiplier` (SPEC §6.4 already has the field) is what makes weapons feel
different without a penetration system: torpedoes at 0.60 are shield-poor,
the WMG at 1.25 is shield-rich.

**What we deliberately drop from Nebulous:** per-component hitboxes, penetration
depth budgets, overpenetration, interior density, damage thresholds. All of them
need a real 3D damage mesh; SPEC §1 puts "real physics collision mesh" out of
scope, and our ships are single-hull OBJ groups, not compartmented. Our
**subsystems** (§1.9) are the cheap 80 %-of-the-feel version.

---

## 4. Subsystem damage and its gameplay effect

Nebulous gives every surface mount and internal compartment its own HP pool, and
destroyed components grey out permanently [1]. Homeworld gives capital ships
discrete destructible modules (engines, weapon batteries, hangar). BFG:A rolls on
a critical table when the hull is hit.

**Recommendation:** `Ship.subsystems` (already in SPEC §6.3) is a flat
`Record<string, {hp,max,disabled}>`. Effects (§1.9) are:

| Subsystem dead | Gameplay consequence | Why it is the right choice |
|---|---|---|
| `wave_motion_gun` | The player's signature weapon is gone | Maximum drama; a genuine "oh no" moment |
| `engine_*` | Speed halves, then to zero | Makes "crippled" legible from the chase camera |
| `turret_main_*` | ⅓ of shock-cannon DPS lost per turret | Gradual, readable power loss — not a cliff |
| `bridge` | Slower reactions, worse accuracy | Rare, but a huge swing |

Routing: `subsystemDamageFraction = 0.15` of every hull-layer hit, distributed
to one random surviving subsystem. **Never route shield- or armor-layer damage
to subsystems** — otherwise the player loses the WMG before the fight has
started and the demo's best mechanic is dead on arrival.

`DamageResult.subsystemHit` (SPEC §6.3) should carry the subsystem **name**, so
the HUD can print `"WAVE MOTION GUN DAMAGED"` and the audio engine can play
`alarm`.

---

## 5. Point defence vs missiles and torpedoes

Nebulous is the reference here: PD is a *separate weapon class* with its own
tracking, RPF shells have an explicit anti-missile blast radius (110 m for
120 mm, 200 m for 250 mm) and a flat 50 % chance to damage missiles in it [1].
That "area" model is more expensive than we need.

**Recommendation: PD is a short-range rapid-fire gun that targets projectile
entities, not ships.**

* PD projectiles are cheap: no homing, no tracer bloom, `life` ~0.4 s.
* A PD mount engages the **nearest** hostile `missile`/`torpedo` inside 600 m.
* Damage applies to `projectile.hp` (§1.3); the projectile dies at 0 hp.
* PD never damages ships — this prevents accidental "PD shreds a destroyer".
* **Frustration guard:** PD *must* leak. The §1.4 table shows 4 of 6 missiles
  leaking through the Yamato's 4 mounts. If PD ever reaches a 100 % intercept
  rate, missiles stop being a mechanic and become a light show. Tune `range`
  first (it shrinks the engagement window quadratically in effect).

Torpedoes vs missiles — the demo's two flavours:

| | `torpedo` (player) | `missile` (Garmillas) |
|---|---|---|
| speed | 300 m/s | 400 m/s |
| range | 1500 m | 2500 m |
| hp | 150 | 120 |
| salvo / cooldown | 4 / 12 s | 6 / 10 s |
| shieldMult | 0.60 | 1.00 |
| flight time to max range | 5.0 s | 6.25 s |
| role | short-range shield-poor hammer | long-range shield-neutral pressure |

---

## 6. Turret firing arcs and broadside doctrine

**How the surveyed games do it:**

* **Nebulous** mounts have explicit firing cones; a ship's DPS depends entirely
  on how it is oriented, which is why the game is about *positioning* rather
  than shooting [1][2].
* **Battlefleet Gothic** (tabletop, and Armada after it) uses **fire arcs** —
  `L`/`F`/`R`/`A` — printed per weapon, and the whole tactical game is lining up
  the arcs. Broadsides are the default because most batteries are `L`/`R` [3].
* **World of Warships** makes turret traverse the limiting factor: turning a
  battleship's turrets takes ~30–45 s, so the ship must *pre-aim* [4].
* **Homeworld** uses a simpler "turret tracks the target, fires if within
  range" model and gets away with it because the camera is far away.

**Recommendation for the demo — a two-tier model:**

1. **Turret-level arcs (cheap, per-mount).** Each mount has a local-space
   `arc` (half-angle) around its rest direction and a `traverseRate` (rad/s).
   Fire only if the target is inside both. `turret_main_*` on the Yamato:
   `arc = 150°` (broad), `traverseRate = 0.8 rad/s`. This produces the classic
   "the turret is still swinging" delay.
2. **Ship-level doctrine (the AI).** `broadsideBias` (§1.7) is the *only* new
   concept the AI needs: given `0.70`, the AI steers to a heading that puts the
   target at ~`70°` off its bow rather than straight ahead, so more mounts bear.

Why broadside doctrine matters for *this* demo: the Yamato's three main turrets
are all on the centreline, so a bow-on Yamato can bring **all** of them to bear
— there is no reason to turn broadside. The *Garmillas* ships are the ones with
the broadside incentive, and that is exactly what makes them look alien and
menacing: they slide sideways across the player's view, all guns blazing, rather
than nose-in like the hero ship. **Set `broadsideBias` high for Garmillas, low
for UNCF.**

---

## 7. TTK targets and the 5-minute budget

The brief fixes two anchors: player→cruiser **25–40 s** of shock-cannon fire,
enemy→player **90–150 s** of combined fire. Both are satisfied in §1.5.

**Time budget for the 300 s demo** (player kills a Kelkapia in ~22 s using all
guns, ~15 s with torpedoes):

| phase | duration | running |
|---|---|---|
| load + wave-1 delay + HUD read | 8 s | 8 s |
| wave 1: 3 × Kelkapia (kill every ~22 s) | 66 s | 74 s |
| lull (shield regen) | 10 s | 84 s |
| wave 2: Gaiderol (WMG + guns, ~42 s) + Kelkapia (~22 s) | 64 s | 148 s |
| lull | 10 s | 158 s |
| wave 3: Bolar carrier (~36 s) + 2 × Kelkapia (~44 s) | 80 s | 238 s |
| travel / approach / overshoot slack | ~50 s | **~288 s ≈ 5 min** ✔ |

**Damage-taken model** (does the player survive?). Two bounds are given
because they bracket the truth. Both multiply raw DPS by `accuracy = 0.55`
(§1.7) and assume the player fights competently.

*Bound A — decay model (optimistic).* The player kills at the theoretical rate
(4200 / 193.7 = 21.7 s per cruiser), so the aggregate DPS falls as ships die:

| wave | engagement profile | damage taken |
|---|---|---|
| 1 | 72 DPS × 21.7 s + 48 × 21.7 + 24 × 21.7 | ~1 720 |
| 2 | 108 DPS × 28 s (WMG guts the Gaiderol at t≈8 s, then guns) + 24 × 21.7 | ~1 950 |
| 3 | 98.4 DPS × 8 s (WMG one-shots a Kelkapia) + 74.4 × 21.7 + 50.4 × 36 | ~2 320 |
| **total** | | **~6 000** |

*Bound B — flat model (pessimistic).* Every enemy stays alive and in arc for the
whole wave, at full aggregate DPS:

| wave | raw DPS | eff DPS (×0.55) | seconds exposed | damage taken |
|---|---|---|---|---|
| 1 | 72.0 | 39.6 | 66 | ~2 610 |
| 2 | 83.0 | 45.7 | 64 | ~2 920 |
| 3 | 98.4 | 54.1 | 80 | ~4 330 |
| **total** | | | | **~9 860** |

Player pool = 9000, plus two shield recharges between waves. A 10 s lull at
120 DP/s recovers 1200 DP of shield (capped at `shieldMax` 2400), and the player
can also disengage mid-wave to trigger regen. Effective survivable ≈
**9000 + ~2 000 ≈ 11 000**.

> **Verdict.** Bound A leaves the player on ~46 % of their pools; Bound B leaves
> them on ~9 %. Real play lands between the two — roughly **20–35 % remaining**
> once missed shots, travel time, target switching and imperfect positioning are
> counted. That is the brief's *"survive all 3 waves but feel pressure"*: the
> player wins, but only if they use the WMG well and take their lulls.
>
> **Tuning levers, in the order to try them if playtesting disagrees:**
> 1. `ai.garmillas.accuracy` 0.55 → 0.50 (the single most direct knob)
> 2. `ships.yamato.shieldRegen` 120 → 160 (kinder without changing TTK)
> 3. `ships.yamato.hull` 4400 → 5000
> 4. Wave 1 from 3 Kelkapias → 2 (for a first-time player only)

**Why 25–40 s is the right player TTK window:** under ~20 s and the enemy dies
before the player has read its silhouette or heard the shield-collapse audio
beat; over ~40 s and a 3-ship wave takes 2 minutes, which blows the 5-minute
budget. 31 s leaves room for exactly one full shield→armor→hull read per kill.

**Why 90–150 s is the right enemy TTK window:** under 90 s and the player dies
in wave 1 while still learning the controls; over 150 s and there is no tension
at all, because the player can simply out-DPS three waves without ever
retreating. 125 / 108 / 91.5 s across the three waves ramps the pressure correctly.

---

## 8. Canon *Yamato* specifics

> Fan-researched behaviour only. **No assets, no audio, no model data** is taken
> from the show — see `04-asset-licensing.md`. Sources for this section are
> community wikis and encyclopaedias and are treated as unreliable-but-useful
> flavour, not as specification.

### 8.1 Wave Motion Gun

In *Space Battleship Yamato 2199*, the wave motion gun is the Yamato's
bow-mounted main weapon: it draws on the wave motion engine, requires a visible
**charging sequence** (the bow aperture iris opens and the barrel glows), and
fires a white-blue beam of enormous power that can annihilate a fleet
concentration in one shot. It is explicitly a **strategic**, not tactical,
weapon — firing it drains the engine, and the ship is left vulnerable during and
shortly after the charge [5][6].

What we take from that:

| Canon behaviour | Our number | Justification |
|---|---|---|
| Long, obvious charge | `chargeTime = 8.0 s` | Inside the brief's 6–10 s. 8 s is long enough to be a commitment and short enough to use ~4× per demo. |
| Fires from the **bow**, fixed forward | arc = ±3° | Canon: the gun is in the bow and the whole ship must be aimed. This is why the arc is narrow. |
| Devastating single shot | `damage = 4800` | One-shots a cruiser, guts a battleship (§1.2) |
| Cannot be spammed | `cooldown = 60 s` | Inside the brief's 45–70 s. ~4 shots in 300 s. |
| Engine drain / vulnerability | *recommended addition:* `CONFIG.wmgun.postFireSpeedFactor = 0.6` for 4 s after firing | Free drama, one line of code, directly from canon |
| The ship must be pointed at the target | the ±3° arc **is** the cost | The player must stop manoeuvring to line up — that is the trade |

**Audio/visual beats to wire up (engine-dev / Lead):** `wmgun_charge` loop for
the full 8 s (pitch rising), a HUD charge meter that goes amber → white, a
screen-shake + bloom flash on release, and `wmgun_fire` as a low-frequency
impact. The 8 s charge is a *gift* to the audio engine — it is the only 8-second
window in the demo where the player is not shooting anything else.

### 8.2 Shock cannons

The Yamato's main battery in 2199 is the **48 cm triple shock cannon** turret,
with secondary shock cannon turrets. They fire rapidly in bursts and are
effective against both ships and (in the anti-air role) craft [7].

| Canon behaviour | Our number |
|---|---|
| 3-gun centreline turrets | `salvo = 3` |
| Rapid burst fire | `cooldown = 2.0 s` |
| Main battery dominates | `shock_cannon` DPS 135 vs `secondary` DPS 58.7 |
| All turrets on the centreline → bow-on is strongest | Yamato `broadsideBias` low (§6) |

### 8.3 Torpedoes and missiles

Canon Yamato carries **Type 3 shells** (anti-air/anti-missile "flak" shells),
**torpedoes**, and anti-ship missiles; Garmillas ships use **missile** batteries
and beam turrets, with the Desler flagship carrying heavy beam armament [5][7].

| Canon element | Our mapping |
|---|---|
| Type 3 shells (flak / anti-missile) | **→ our `pointDefence`** (§1.4). Canon Type 3 is literally an anti-missile shell; making PD the Type 3 equivalent is faithful *and* free. |
| Ship-killing torpedoes | `torpedo`, 4-round salvo, shield-poor (`shieldMult 0.60`) |
| Garmillas missile batteries | `missile`, 6-round salvo, homing, shield-neutral |
| Garmillas beam turrets | `garmillas_beam` — and per §1.3 the Garmillas ships **out-range nobody**, which is our invention, not canon |

### 8.4 Shields and the "wave motion shield"

Garmillas ships are depicted with visible defensive shields that flare on
impact; the Yamato's own defences are its armor and the wave motion shield
generated by the engine [5]. In canon the wave motion gun is shown punching
*through* Garmillas shields.

| Canon element | Our mapping |
|---|---|
| Shields flare and fail, then recover | Our `shield` layer + `shieldRegenDelay`/`shieldRegenRate` (§1.1) |
| WMG defeats shields | `wmgun.shieldMultiplier = 1.25` (§1.2) |
| Armor is permanent, hull is the last line | `armorRegen = 0`, `hullRegen = 0` |

**Honest caveat:** we are not modelling the "wave motion shield" as a distinct
mechanic. It would need either a second shield pool or a directional shield, and
SPEC §1 puts that complexity out of scope for v0.1. The 1.25 multiplier on the
WMG is the cheap nod to canon.

---

## 9. AI fleet behaviour

### 9.1 Formation slots

Homeworld keeps ships in a formation with per-slot offsets and a "return to
station" behaviour. Nebulous instead gives each ship an **independent** order
and lets the player's formation emerge [2].

**Recommendation:** a hybrid. Each fleet has `formationSlotCount = 6` slots laid
out in a **V** (or line-abreast for Garmillas, since they fight broadside) at
`formationSlotRadius = 1.5 × ship length` spacing, **anchored to the fleet
leader** (the highest-`roleValue` surviving ship). Each ship steers toward its
slot with a simple seek, and *breaks formation* only when:

* its hull < `retreatHullThreshold` (it flees), or
* it has no valid target (it holds station), or
* a WMG telegraph is active and it rolled `dodgeWMGChance` (it evades).

This gives visible fleet structure without a full order system.

### 9.2 Target selection

See the score formula in §1.7. Three properties worth calling out:

* **Threat term decays.** Track `recentDamage` per attacker with a 6 s half-life.
  Without decay the AI locks onto whoever shot first and never re-evaluates.
* **`focusFireSwitchCooldown = 8 s`** prevents the classic AI failure where the
  whole fleet oscillates between two targets and effectively shoots neither.
* **Focus fire must be *partial*.** All 3 Kelkapias shooting the same target is
  correct; all 3 *also* ignoring the player's wingmen is not. Recommend: 70 % of
  a fleet picks the top-scoring target, 30 % picks independently.

### 9.3 Fire discipline

* Hold fire until the target is inside `range × 0.95` and inside the mount arc.
* Don't fire missiles below `missileFireMinRange` (800 m) — a 6.25 s flight time
  inside a PD envelope that the target has already closed is wasted.
* Don't fire missiles above `missileFireMaxRange` (2400 m) — the missile will
  run out of `life`.
* `reactionTime` (1.0–1.2 s) is a deliberate handicap: it gives the player a
  window to break line of sight or reposition before the AI responds.

### 9.4 Retreat

`retreatHullThreshold`: Garmillas 0.25, Bolar 0.15 (Bolar are fanatics), UNCF
0.30 (allies are cautious). On retreat, the ship turns away at full throttle
and, if it survives 15 s outside 3000 m, despawns. **Despawn rather than flee
forever** — a straggler circling the arena for 2 minutes ruins the pacing.

---

## 10. Open questions / risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | 3 Kelkapias in wave 1 may overwhelm a first-time player | `wave1Delay = 8 s`; consider 2 cruisers for the very first run |
| 2 | `wmgun` 60 s cooldown may be *too* long for a 300 s demo | 4 shots is enough; if playtesting says otherwise, 50 s |
| 3 | PD leak rate is analytically 4/6 but depends on the projectile update loop's tick rate | Verifier should assert intercept count in `tests/` |
| 4 | Enemy TTK assumes all mounts bear; in practice arcs cut it ~40 % | That is *why* the raw TTK is set at the fast end of the band |
| 5 | Ship speeds are 70–200 m/s; at 200 m/s the Yukikaze crosses the arena in 60 s | Fine for an escort, but AI must not let it outrun its own fleet |
| 6 | `wmgun` at 4000 m/s needs sub-stepped collision | §2 tunnelling guard |

---

## 11. Summary of the key design arguments

1. **6 × L engagement range** — the largest multiple at which a capital ship is
   still legible on a third-person chase camera. Everything else scales from it.
2. **One damage model for all seven weapons** — pulsed projectiles with cone
   dispersion. Beams are not special-cased.
3. **`sustainedDPS = damage × salvo / cooldown`** — stated once, used everywhere,
   trivially unit-testable by the verifier.
4. **Three ordered pools with overflow** — produces the shield/armor/hull read
   the HUD needs, with `shieldMultiplier` as the only weapon-flavour knob.
5. **Armor and hull never regenerate; shields do** — this is the entire pressure
   curve of the demo in one line.
6. **Garmillas out-range nobody** — the player's 200 m standoff band is what
   makes retreat-and-recharge a real tactic.
7. **The WMG's cost is the aim, not the cooldown** — a ±3° arc forces the player
   to stop manoeuvring, which is the interesting decision.

---

## 12. Sources

| # | Source | Used for |
|---|---|---|
| [1] | [Nebulous: Fleet Command Official Wiki — Component Damage](https://wiki.hoodedhorse.com/NEBULOUS_Fleet_Command/index.php?title=Component_Damage) | DR/DT, penetration depth, overpenetration, interior density, beam behaviour (5 ticks/s, 150 m pendepth, 5 %/50 % range falloff), HE/AP/RPF/plasma/HEI damage types, structure break, PD blast radii |
| [2] | [Nebulous: Fleet Command Official Wiki — Armor](https://wiki.hoodedhorse.com/NEBULOUS_Fleet_Command/index.php?title=Armor) | Armor as a thickness budget; hull interior density table |
| [3] | [Battlefleet Gothic — basic rules (PDF)](https://tesera.ru/images/items/1811176/1BFGbasicrules.pdf) | Fire arcs (L/F/R/A), battery dice, shields-then-hull, critical damage table |
| [4] | [World of Warships Wiki — gunnery & dispersion](https://wiki.worldofwarships.com/) | Dispersion ellipse, sigma, turret traverse as the real limiter |
| [5] | [Space Battleship Yamato — Wikipedia](https://en.wikipedia.org/wiki/Space_Battleship_Yamato) | Wave motion engine/gun premise, ship role, franchise overview |
| [6] | [Wave Motion Gun — Yamato Wiki (Fandom)](https://yamato.fandom.com/wiki/Wave_Motion_Gun) | Charge sequence, bow mounting, fleet-killing power, engine drain |
| [7] | [Shock cannon — ショックカノン (weblio)](https://www.weblio.jp/content/%E3%82%B7%E3%83%A7%E3%83%83%E3%82%AF%E3%82%AB%E3%83%8E%E3%83%B3) | 48 cm triple shock cannon, burst fire, secondary turrets |
| [8] | [Homeworld Wiki — Ion Cannon Frigate (HW2)](https://homeworld.fandom.com/wiki/Ion_Cannon_Frigate_(Homeworld_2)) | Capital-ship weapon stats, subsystem modules, damage-type multipliers |

> **Access note:** `wiki.hoodedhorse.com` sits behind a Cloudflare interstitial.
> `[1]` and `[2]` were read through the shared browser after the challenge
> cleared; a plain `web_fetch` returns HTTP 403. `yamato.fandom.com` was not
> reachable from this environment — the canon notes in §8 are marked as
> community-sourced flavour and should not be treated as verified.
