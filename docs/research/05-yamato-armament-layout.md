# 05 — Yamato 2199 hull form and armament layout

Sourced specification for the ship model. Written because the user reviewed the
demo and said the hull and the weapon layout were "明显不对" — and they were
right. This file is the reference the generator is now built against.

**Sources**
- English Wikipedia, *Space Battleship Yamato* — the UNCF *Yamato* vehicle
  infobox, which carries the full remake (2199/2202) armament list.
  <https://en.wikipedia.org/wiki/Space_Battleship_Yamato>
- Japanese Wikipedia, *ヤマト (宇宙戦艦ヤマト)* — 艦体解説 / 兵装 / 機関, which
  gives the hull structure and where things sit.
  <https://ja.wikipedia.org/wiki/ヤマト_(宇宙戦艦ヤマト)>
- Official 2199 mechanic page <https://www.yamato2199.net/about/mechanic_page.php>

Everything below is quoted or paraphrased from those; nothing is inferred from
merchandise photos or fan art.

---

## 1. What we had wrong

| Item | Our model | Canon (remake) |
|---|---|---|
| Secondary guns | **4 triple wing turrets** | **2 triple 20 cm**, centreline |
| Torpedo tubes | modelled as turret groups | **hull openings**: 6 fore, 6 aft, 8 per side |
| Missile launchers | none | **10 bottom tubes + 1 eight-barrel launcher + funnel missiles** |
| AA / CIWS | 6 mounts | **40 pulse-laser mounts** of five different types |
| Third bridge | absent | **protrudes from the BOTTOM of the hull** |
| Auxiliary engines | absent | **2**, used to start the wave motion engine |
| Aft catapult | absent | present, at the real Yamato's seaplane catapult position |
| Funnel | decorative | **a missile launcher** (煙突ミサイル) |

The two that matter most visually are the **secondary battery** (two centreline
triples, not four wing turrets) and the **sheer number of AA mounts** — the 2199
Yamato bristles with them, and a hull with six reads as under-armed.

---

## 2. Hull form (艦型)

- Built over the wreck of the battleship *Yamato*, so it **looks like a surface
  warship**: a battleship hull with a raked clipper bow, sheer, and a keel.
- **Wave motion gun in the bow**, with **missile launch ports flanking it** on
  either side of the bow face.
- **Every weapon other than the wave motion gun and the bow/stern missiles is
  concentrated on the UPPER part of the hull** (艦体上部に集中配置).
- **Rocket anchors** (ロケットアンカー): one each side of the bow, usable as
  weapons to grapple an enemy hull.
- **Retractable delta wings** (収納式の巨大なデルタ翼型主翼) on both sides, for
  atmospheric stability. Large, delta-form, and they fold.
- **Aft aircraft deck** with an elevator into a stern/bottom hangar.

### The command tower (大司令塔)

A single large tower amidships, carrying command, search and communications.
Stacked, from the top down:

1. **艦長室** — captain's cabin, at the very top
2. **第一艦橋** — first (main) bridge, **10 m below the captain's cabin**
3. **第二艦橋** — second bridge, specialised for route planning and navigation
4. **第三艦橋** — third bridge, which **protrudes from the BOTTOM of the hull**,
   directly beneath the command tower. It is the sub-bridge / backup for the
   first bridge.

The third bridge is the single most distinctive silhouette feature and it is the
one we were missing entirely: it hangs below the hull as a pod.

Internally the ship is built **top/bottom symmetric**, on the assumption that a
gravity failure could leave it inverted.

### Engines (機関)

- **One main wave motion engine**, driving the wave motion gun directly.
- **Two auxiliary engines** (補助エンジン), which double as secondary thrusters
  and are used to *start* the wave motion engine. The ship can cruise on the
  auxiliaries alone but cannot warp on them.
- Firing the wave motion gun drops wave-engine output to zero, so restart energy
  has to be reserved.

---

## 3. Armament (兵装) — remake, complete list

| # | Weapon | Notes |
|---|---|---|
| 1 | **200 cm wave motion gun** | bow, the fleet-decisive weapon |
| 3 | **triple 48 cm positron shock cannon** | main battery |
| 2 | **triple 20 cm positron shock cannon** | secondary battery |
| 6 | forward torpedo launch tubes | hull openings, bow |
| 6 | aft torpedo launch tubes | hull openings, stern |
| 16 | torpedo launch tubes | **8 per side**, broadside |
| 10 | bottom missile launch tubes | ventral |
| 1 | **eight-barrel missile launcher** | |
| 2 | Type 94 depth charge launchers | |
| 8 | **12.7 cm quadruple** high-angle rapid-fire pulse laser turrets | AA |
| 2 | 8.8 cm triple high-angle rapid-fire pulse laser turrets | AA |
| 8 | 12.7 cm twin high-angle rapid-fire pulse laser turrets | AA |
| 18 | 7.5 cm twin high-angle rapid-fire pulse laser turrets | AA |
| 4 | 7.5 cm triple rapid-fire machine pulse laser turret | AA |
| 2 | conning tower close-defence firearms | **on the bridge tower itself** |
| — | **funnel missiles** (煙突ミサイル) | launched from the funnel |
| — | bow missiles / stern missiles / broadside missiles | |
| — | 2 rocket anchors | bow, both sides |

### Pulse-laser AA total

8 + 2 + 8 + 18 + 4 = **40 mounts**, plus 2 on the tower. In the 1974 original
this was far smaller (pulse lasers unspecified); the remake is what we model.

### Placement rules we can rely on

- **Main battery**: 3 triples — **two forward, superfiring**, one aft. The
  forward pair is the silhouette signature.
- **Secondary battery**: 2 triples on the **centreline**.
- **AA**: distributed along both sides of the hull and the superstructure, in
  sponsons, at several heights — not in a single row.
- **Torpedoes**: **hull openings, not turrets.** Bow, stern, and a broadside
  battery of 8 per side. They must be modelled as ports in the hull plating.
- **Missiles**: ventral tubes plus the funnel launcher plus an eight-barrel box.
- **Everything else on the upper hull**, clustered around the command tower.

---

## 4. What this means for tools/gen_models.py

Group vocabulary changes (SPEC §5 rule 3 still applies to anything traversable):

- `turret_main_1..3` — triple 48 cm, two forward superfiring + one aft *(have)*
- `turret_secondary_1..2` — triple 20 cm **centreline** *(was 4 wing mounts)*
- `ciws_1..N` — pulse laser mounts. **N should be large** (~20+ on the Yamato);
  they do not all need to be individually traversable, but they must be visible.
- `torpedo_tube_fore_1..6`, `torpedo_tube_aft_1..6`, `torpedo_tube_p1..8`,
  `torpedo_tube_s1..8` — **hull ports**, authored flush with the plating.
- `missile_launcher_1..N` — ventral tubes, the eight-barrel box, the funnel.
- `third_bridge` — the ventral pod. **New, and load-bearing for the silhouette.**
- `engine_nozzle` — the main wave motion engine
- `aux_engine_1..2` — the two auxiliary engines
- `catapult` — the aft catapult
- `rocket_anchor_1..2` — bow, both sides
- `wing` — the retractable delta wings *(have)*
- `bridge` — the command tower, now with the captain's cabin on top and the
  first/second bridge tiers below

Detail budget: the AA battery is what will cost triangles. Model the small
mounts as a shared low-poly form (a base ring, a rotating drum, one or two
barrels — 30-60 triangles each) and place ~20 of them. 20 x 50 = 1000 triangles,
which fits under the 12 000 ceiling comfortably.

---

## 5. Confidence

- Armament counts and calibres: **high** — directly from the Wikipedia vehicle
  infobox for the remake, cross-checked against the 2199 official mechanic page.
- Third bridge position (ventral), tower stacking, auxiliary engine count, delta
  wings, funnel missiles: **high** — stated explicitly in the JA 艦体解説.
- Exact station positions along the hull (which frame each AA mount sits on):
  **medium**. The sources say "distributed along the sides" without giving
  frames. Our placements are therefore *plausible reconstructions*, chosen to
  match the published side profiles, not measured. This is recorded honestly
  rather than presented as canon.
- We still have no licensed orthographic drawing. If one is obtained, this file
  should be revised and the model re-derived from it.
