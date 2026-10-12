# 01 — YAMATO 2199 / 2202 / 2205 Ship Canon Reference

> **Purpose.** This file exists so `tools/gen_models.py` (owner: **asset-forge**) can
> build *recognisable silhouettes* from written notes alone. Every ship entry has a
> **SILHOUETTE NOTES** block written as build instructions (proportions, station
> positions as fractions of length, turret placement, nozzle counts) and a
> **PALETTE** block of hex approximations.
>
> **Licensing.** We copy **no** third-party art, model data, or textures. Numbers and
> shapes are *described* here in our own words; the generated OBJ/MTL is our own work.
> See `docs/research/04-asset-licensing.md`.
>
> **Convention.** All station positions are given as a fraction of overall length
> `L`, measured **from the bow (0.00) to the stern (1.00)**, matching SPEC §4 local
> space where the bow points `−Z`. So `z_local = (0.5 − station) × L`.
> "Beam" = maximum width; "height" = keel-to-mast unless stated.
>
> **Source quality tiers** used below:
> - **[OFFICIAL]** — `yamato2202.net` official mechanic pages. Highest confidence.
> - **[WIKI]** — ja.wikipedia article text mirrored on Weblio. Good confidence.
> - **[DERIVED]** — my own geometric derivation from the above. Explicitly marked.
> - **[UNVERIFIED]** — plausible but I could not confirm it against a source. **Do not
>   ship these numbers as canon.** They are flagged inline.

---

## 0. Master ship table

### 0.1 SPEC §5 ships — canon values vs SPEC

| id (SPEC) | JA name | EN name | Class | Faction | Role | **Canon length** | SPEC says | Source |
|---|---|---|---|---|---|---|---|---|
| `yamato` | ヤマト | Yamato | Yamato-class 宇宙戦艦 (第一次改装型) | UNCF | battleship | **333 m** | 333 m ✅ | [OFFICIAL][^yamato] |
| `andromeda` | アンドロメダ | Andromeda | 前衛武装宇宙艦 AAA-1 (Andromeda-class) | UNCF | battleship | **444 m** | 444 m ✅ | [OFFICIAL][^andromeda] |
| `kirishima` | キリシマ | Kirishima | 金剛型宇宙戦艦 (Kongo-class) | UNCF | cruiser/battleship | **205 m** | 222 m ❌ | [OFFICIAL][^kongo][^kirishima] |
| `yukikaze` | ユキカゼ | Yukikaze | 磯風型突撃宇宙駆逐艦 (Isokaze-class) | UNCF | destroyer | **80 m** | 80 m ✅ | [OFFICIAL][^isokaze][^yukikaze] |
| `garmillas_dessler` | デウスーラII世 | Deusura II | 特一等航宙戦闘艦 | Garmillas | flagship | **638 m** | 400 m ❌ | [WIKI][^deusura2] |
| `garmillas_kelkapia` | ケルカピア | Kelkapia | ケルカピア級航宙高速巡洋艦 | Garmillas | cruiser | **240 m** | 250 m ❌ | [WIKI][^kelkapia] |
| `garmillas_gaiderol` | ガイデロール | Gaiderol | ガイデロール級航宙戦艦 | Garmillas | battleship | **350 m** | 390 m ❌ | [WIKI][^gaiderol] |
| `bolar_carrier` | ガノンダ型航宙母艦 | Ganonda-class carrier | ガノンダ型航宙母艦 (28号計画) | Bolar | carrier | **400 m** | 380 m ⚠️ | [WIKI][^ganonda] |

> ### ⚠️ SPEC DELTA — action required by the Lead + asset-forge
>
> Four of the eight SPEC §5 lengths disagree with canon. Recommendation, in priority
> order:
>
> 1. **`kirishima`: change 222 m → 205 m.** Both the 2199 Kongo-class *Kirishima*
>    and the 2202 Kongo-Kai-class are officially **205 m** [OFFICIAL]. SPEC's 222 m
>    appears nowhere in the sources I checked. **This is a clear factual error.**
> 2. **`garmillas_gaiderol`: 390 m → 350 m**, **`garmillas_kelkapia`: 250 m → 240 m.**
>    Both are Wikipedia-sourced exact figures; SPEC's numbers are close but wrong.
> 3. **`garmillas_dessler`: 400 m → 638 m.** This is the big one. The 2199 Desler
>    flagship is the **Deusura II at 638 m** — it is *deliberately* larger than the
>    Gaiderol (350 m), and "bigger than everything else on screen" is the entire
>    visual point of a Desler flagship. If 638 m breaks the demo's camera/formation
>    tuning, the honest alternative is to keep 400 m **and rename the ship** so the
>    manifest does not claim to be a Deusura II. Do not ship a 638 m hull while the
>    manifest says 400 m — formation code reads `lengthM`.
> 4. **`bolar_carrier`: 380 m → 400 m** (Ganonda-class, official 2205/3199 spec).
>    Only a 5% delta; either value is defensible.
>
> **Length is the only dimension the demo depends on** (`lengthM` in the manifest
> drives scaling and formation spacing). Beam/height are documentation only.

### 0.2 Bonus ships (not in SPEC §5, cheap fleet-filler variety)

| JA name | EN | Faction | Class | Length | Beam | Height | Source |
|---|---|---|---|---|---|---|---|
| ゼルグート級 | Zelguut-class | Garmillas | 一等航宙戦闘艦 | **730 m** | — | — | [WIKI][^zelguut] |
| ハイゼラード級 | Haizerad-class | Garmillas | 航宙戦艦 | **392 m** | — | — | [WIKI][^haizerad] |
| デストリア級 | Destoria-class | Garmillas | 航宙重巡洋艦 | **270 m** | 63 m | 68 m | [WIKI][^destoria] |
| メルトリア級 | Meltoria-class | Garmillas | 航宙巡洋戦艦 | **283 m** | — | — | [WIKI][^meltoria] |
| クリピテラ級 | Kripitera-class | Garmillas | 航宙駆逐艦 | **160 m** | 37 m | 37 m | [WIKI][^kripitera] |
| ポルメリア級 | Polmeria-class | Garmillas | 強襲航宙母艦 | **383.8 m** | **291.3 m** | 50 m | [WIKI][^polmeria] |
| ガイペロン級 | Gaiperon-class | Garmillas | 多層式航宙母艦 | **410 m** | — | — | [WIKI][^gaiperon] |
| 村雨改型 | Murasame-Kai-class | UNCF | 宇宙巡洋艦 | **152 m** | — | — | [OFFICIAL][^murasame] |
| パトロール艦 | Patrol ship | UNCF | 軽装甲巡洋艦 | **188 m** | 42.2 m | — | [OFFICIAL][^patrol] |
| 護衛艦 | Frigate | UNCF | フリゲート艦 | **113.3 m** | 18.5 m | — | [OFFICIAL][^frigate] |
| クロトガ型 | Krotoga-class | Bolar | 標準戦艦 (戦艦A型) | **320 m** | — | — | [WIKI][^krotoga] |
| アマンガ型 | Amanga-class | Bolar | ミサイル戦艦 (戦艦B型) | **300 m** | — | — | [WIKI][^amanga] |
| デストロイヤー艦 | Destroyer | Bolar | 駆逐艦 | ~168 m ⚠️ | — | — | [WIKI][^bolar_dd] |

> **Free silhouette variety for waves 1–2.** A wave of `gaiderol` (350 m, tall) +
> `kelkapia` (240 m, slim) + `kripitera` (160 m, small, numerous) + one `haizerad`
> (392 m) reads as a *real* fleet with a clear size hierarchy from four distinct
> silhouettes. The **Polmeria disc carrier** is the most "alien" Garmillas shape
> available if you want one memorable oddity.

---

## 1. Earth Federation (UNCF) — 地球連邦 / 国連宇宙海軍

**UNCF design language, in one sentence a modeller can use:** *naval battleships in
space* — long slender wedge hulls, a distinct **red-to-orange lower "waterline"
band**, a **dark grey/near-black upper deck**, grey-white superstructure, a tall
pagoda-style bridge tower set **forward of amidships**, and — the single most
important silhouette marker — a **short, wide, blunt wave-motion-gun muzzle recessed
into a chisel-shaped bow**.

### 1.1 `yamato` — ヤマト / Yamato (BBY-01)

| Field | Value |
|---|---|
| Official name | ヤマト型一番艦ヤマト（第一次改装型） [OFFICIAL][^yamato] |
| Class | Yamato-class 宇宙戦艦 |
| Faction | UNCF |
| Role | battleship, **player ship** |
| Length | **333 m** [OFFICIAL][^yamato] |
| Beam | ≈48.6 m — **[UNVERIFIED]**, no primary source found. Treat as approximate. |
| Main engine | 次元波動エンジン ×1 [OFFICIAL][^yamato] |

**Armament (official 2202 listing)** [OFFICIAL][^yamato]
- **次元波動爆縮放射機（通称：波動砲）** — the Wave Motion Gun, ×1, bow-mounted.
- **48サンチ三連装陽電子衝撃砲塔 ×3** — three triple 48 cm positron shock-cannon
  turrets (the classic two-forward / one-aft layout).
- **20サンチ三連装陽電子衝撃砲塔 ×2** — two triple 20 cm secondary turrets.
- **魚雷発射管 ×12** — twelve torpedo tubes.
- **8連装ミサイル発射塔 ×1** — one eight-cell missile launcher.
- **94式爆雷投射機 ×2** — two depth-charge projectors.
- **対空パルスレーザー砲塔 多数** — numerous AA pulse-laser turrets.

**SILHOUETTE NOTES (build instructions)**
- **Overall proportion: L : B ≈ 6.9 : 1** (333 / 48.6). Hull height (keel → main
  deck) ≈ **0.11 × L** (~37 m). She should read *long, low and heavy*.
- **Hull is a wedge, not a box.** Cross-section starts as a narrow vertical blade at
  the bow and widens **linearly** to full beam at about **station 0.55**, then tapers
  gently to the stern. In side profile the deck line is **flat and level from station
  0.12 to 0.88**; below it the hull sides flare outward by about **3° from vertical**.
  That 3° flare is what makes it read as a *ship* rather than a slab — do not omit it.
- **Bow (stations 0.00–0.12) — the signature.** A chisel. The very front is a **blunt
  vertical face** carrying a recessed circular/oval **wave motion gun muzzle**,
  diameter ≈ **0.055 × L** (~18 m), centred ≈ **0.045 × L** above the keel. Behind it
  the deck rises to a low "brow" ridge. **Do not make the bow a sharp point** — the
  flat WM-gun face is the most recognisable Yamato feature in the entire franchise.
- **Bridge tower at station ≈ 0.30 from the bow** (forward of amidships). Stacked,
  tapering pagoda: base width ≈ **0.10 × L**, narrowing to a small bridge/radar top.
  Height above main deck ≈ **0.085 × L** (~28 m). Add a **funnel/mast cluster
  immediately abaft the bridge** with 2 angled exhaust stacks.
- **Main turrets — three triples on the centreline:**

  | turret | station | note |
  |---|---|---|
  | A | **0.12** | superfiring, one deck up |
  | B | **0.28** | at main-deck level, abaft/below A |
  | C | **0.78** | facing aft |

  Each: barbette cylinder radius ≈ 0.028 × L; turret body ≈ 0.06 × L long; **three**
  barrels each ≈ 0.10 × L, projecting forward, **elevated ~5°** at rest.
- **Secondary 20 cm triples at station ≈ 0.42**, offset **±0.38 × beam** on
  bridge-flank sponsons.
- **Aft (stations 0.80–1.00):** hull narrows and drops; a **flight deck / catapult**
  occupies 0.86–0.96 on the centreline; stern ends in a flat transom.
- **Engine nozzles: 2 large + 4 small.** Two big circular main bells side-by-side at
  the stern, radius ≈ **0.035 × L**, centred at **±0.20 × beam**; four smaller
  verniers outboard/above. Recess them slightly into a stern housing so they read as
  *bells*, not flat discs.
- **Cheap detail that sells it:** a row of rectangular deck hatches along the
  centreline, and anchor recesses near the bow.

**PALETTE**

| Material (SPEC §5.5 palette) | Hex | Where |
|---|---|---|
| `hull_grey` | `#8a8f96` | main hull sides, superstructure |
| `hull_red` | `#a8342c` | lower hull "waterline" band — lowest ~22% of hull side |
| `deck_dark` | `#3a3f45` | main deck plating, upper surfaces |
| `glass_blue` | `#2b4a63` | bridge window band |
| `engine_glow` | `#6fd0ff` | nozzle interiors (emissive) |
| `gun_metal` | `#5a5f66` | barrels, turret faces |
| `accent_gold` | `#c9a227` | trim line, hull number, small fittings |

**Suggested hardpoints** (ship local space, metres; bow at −Z; origin at centre).
Derived with `z = (0.5 − station) × 333` [DERIVED] — asset-forge should re-derive
from the actual generated geometry, but this is the right neighbourhood and ordering.

| name | kind | pos (x, y, z) | dir |
|---|---|---|---|
| `wave_motion_gun` | wmgun | `(0, 2, −158)` | `(0,0,−1)` |
| `turret_main_1` | turret | `(0, 13, −126)` | `(0,0,−1)` |
| `turret_main_2` | turret | `(0, 9, −73)` | `(0,0,−1)` |
| `turret_main_3` | turret | `(0, 9, 93)` | `(0,0,1)` |
| `turret_sec_p` | turret | `(−18, 20, −27)` | `(0,0,−1)` |
| `turret_sec_s` | turret | `(18, 20, −27)` | `(0,0,−1)` |
| `torpedo_bow` | torpedo | `(0, 0, −160)` | `(0,0,−1)` |
| `engine_1` | thruster | `(−10, 0, 163)` | `(0,0,1)` |
| `engine_2` | thruster | `(10, 0, 163)` | `(0,0,1)` |

### 1.2 `andromeda` — アンドロメダ / Andromeda (AAA-1)

> **Station conflict (recorded 2026-10, during the armament rebuild).** The
> published stations for Andromeda's citadel (0.32) and her forward main turret B
> (0.30) cannot both hold: her citadel base is 49 m wide by 34 m long, and at
> 0.32 its forward top corner runs into turret B's gun house. The model resolves
> this by moving the **citadel aft to 0.37** and **B to 0.29**, on the rule that
> when two features compete for the same volume the more visible one keeps its
> station. Do not "fix" this back without re-checking the volumes.

| Field | Value |
|---|---|
| Official name | 前衛武装宇宙艦AAA-1 アンドロメダ [OFFICIAL][^andromeda] |
| Class | Andromeda-class 前衛武装宇宙艦 (vanguard armed space vessel) |
| Faction | UNCF |
| Role | battleship; **fleet flagship** of the Earth Federation space fleet |
| Length | **444 m** [OFFICIAL][^andromeda] |
| Beam | ≈60.8 m — **[UNVERIFIED]**, no primary source found |
| Main engine | 次元波動エンジン ×1 |
| Auxiliary | **ケルビンインパルスエンジン ×4** [OFFICIAL][^andromeda] |

**Armament (official 2202 listing)** [OFFICIAL][^andromeda]
- **二連装次元波動爆縮放射機（通称：拡散波動砲）** — a **twin-barrelled** wave
  motion gun in the bow. Fires either a **concentrated single-line shot** or a
  **拡散放射 (dispersal)** that spreads the wave energy to hit **many targets at
  once**. This twin-muzzle bow is the ship's whole identity.
- **40.6サンチ三連装収束圧縮型衝撃波砲塔 ×4** — four triple 40.6 cm
  convergence-compression shock-wave turrets.
- 速射魚雷発射管 ×4 (rapid-fire torpedo tubes)
- 重力子スプレッド発射機 ×4 (graviton spread launchers)
- 四連装対艦グレネード投射機 ×2 (quad anti-ship grenade projectors)
- 亜空間魚雷発射機 ×4 (subspace torpedo launchers)
- 司令塔防護ショックフィールド砲 ×3 (bridge-tower defensive shock-field guns)
- 近接戦闘用六連装側方光線投射砲 ×2 (six-barrel close-combat lateral beam
  projectors)
- **Crew note:** automation was pushed hard, so the crew is **much smaller than
  Yamato's** despite the far larger hull [OFFICIAL][^andromeda].
- **Sister ships:** AAA-2 アルデバラン, AAA-4 アキレス (battleship type); AAA-3
  アポロノーム, AAA-5 アンタレス (**carrier type, 484 m**, up to 180 Cosmo Tiger II,
  launched from **24 ports, 12 per side**) [OFFICIAL][^andromeda]

**SILHOUETTE NOTES (build instructions)**
- **The "bigger, meaner Yamato".** L : B ≈ 7.3 : 1 (444 / 60.8) — proportionally
  *slightly more slender* than Yamato, which makes it read as newer and faster even
  though it is 33% longer. Keep Yamato's overall vocabulary so the two are obviously
  the same navy, then push three things: **a wider bow face, a squarer hull, and a
  much bigger superstructure**.
- **Bow (0.00–0.13) — twin muzzles.** A **broad, flat, slightly raked bow face**
  carrying **two wave motion gun muzzles side by side**, each diameter ≈ **0.045 × L**
  (~20 m), centres at **±0.055 × L** from the centreline (so ≈ ±24 m), both centred
  ≈ 0.05 × L above the keel. Between them, a raised centre rib. **This twin-muzzle
  bow is the single feature that distinguishes Andromeda from Yamato at a glance —
  get it right before anything else.**
- **Hull:** wedge like Yamato but with a **flatter, squarer cross-section**. Full beam
  reached earlier, at **station 0.45**; near-parallel sides from 0.45 to 0.80; then a
  short taper to a **broad, flat transom**. Side-profile deck line level from 0.10 to
  0.90. Hull height ≈ **0.105 × L** (~47 m).
- **Bridge tower at station ≈ 0.32.** Taller and *blockier* than Yamato's — more of a
  slab-sided citadel than a pagoda. Base width ≈ **0.11 × L**; height above main deck
  ≈ **0.10 × L** (~44 m). The **司令塔防護ショックフィールド砲 ×3** are a great
  detail: three small emitters **ringing the bridge tower**, evenly spaced.
- **Main turrets — four triples, all centreline:**

  | turret | station | note |
  |---|---|---|
  | A | **0.13** | superfiring |
  | B | **0.30** | superfiring, abaft A |
  | C | **0.62** | facing aft |
  | D | **0.80** | facing aft, superfiring over C |

  Barrels longer and thinner than Yamato's (40.6 cm vs 48 cm, but more of them).
  Turret bodies slightly **boxier** than Yamato's rounded ones.
- **Lateral beam projectors:** the **六連装側方光線投射砲 ×2** sit as two
  **six-barrel clusters on the flanks at station ≈ 0.50**, offset ±0.45 × beam,
  angled slightly outboard. Nice asymmetric detail vs Yamato.
- **Engine nozzles: 1 large + 4 medium.** One central main bell, radius ≈ **0.045 ×
  L** (~20 m), with **four Kelvin impulse nozzles** arranged in a square around it at
  ±0.16 × beam, ±0.08 × L vertically, radius ≈ 0.022 × L each. [OFFICIAL] confirms
  the 1 + 4 arrangement.
- **Carrier variant (アポロノーム / アンタレス, 484 m):** if you ever need a UNCF
  carrier, this is free — same hull, **hangar and launch/recovery block added abaft
  the bridge**, with **24 launch ports (12 per side)** on the flanks.

**PALETTE** — same UNCF family as Yamato; Andromeda is slightly cooler and cleaner.

| Material | Hex | Where |
|---|---|---|
| `hull_grey` | `#8f949b` | main hull — a touch lighter/cooler than Yamato |
| `hull_red` | `#9e3230` | waterline band — slightly darker, less orange |
| `deck_dark` | `#343a41` | deck plating |
| `glass_blue` | `#2f5570` | bridge windows |
| `engine_glow` | `#7fdcff` | nozzle interiors — brighter cyan than Yamato |
| `gun_metal` | `#565b62` | turrets, barrels |
| `accent_gold` | `#c9a227` | flagship trim (use more of it than on Yamato) |

### 1.3 `kirishima` — キリシマ / Kirishima (Kongo-class)

| Field | Value |
|---|---|
| Class | 金剛型宇宙戦艦 (Kongo-class space battleship); 2202 refit = **金剛改型** |
| Faction | UNCF |
| Role | battleship / cruiser — fleet flagship of 連合宇宙艦隊・第一艦隊 in 2199 |
| Length | **205 m** [OFFICIAL][^kongo]; the 2199 *Kirishima* is also **205 m**, hull number **BBS-555** [WIKI][^kirishima] |
| Captain | 山南修 [WIKI][^kirishima] |
| Note | 旧沖田艦 — this is the refit of Okita's old ship [WIKI][^kirishima] |

**Armament — 2202 Kongo-Kai-class (タイコンデロガ / ゆうなぎ)** [OFFICIAL][^kongo]
- **46サンチ陽電子衝撃砲 ×1** — a **fixed forward-firing bow gun**, the enlarged
  version of the original fixed bow positron cannon.
- **36サンチ三連装陽電子衝撃砲塔 ×4** — four triple 36 cm positron shock turrets.
- 魚雷発射管 ×8 (torpedo tubes)
- ミサイル発射管 ×16 (missile tubes)
- 波動コア入り新型エンジン搭載、超空間航行可能 (wave core engine, hyperspace capable).
- 2202 note: the Kongo-Kai is the **mainstay battleship of the reorganised Earth
  Federation fleet** [OFFICIAL][^kongo].

**SILHOUETTE NOTES (build instructions)**
- **The "compact Yamato".** L : B ≈ 6.3 : 1 — proportionally **stubbier** than Yamato
  and Andromeda. It should read as a *smaller, denser, older* hull that has been
  rebuilt. Hull height ≈ 0.12 × L (~25 m) — **relatively tall for its length**.
- **Bow (0.00–0.15) — the fixed bow gun is the identity.** Unlike Yamato's recessed
  circular WM-gun muzzle, the Kongo's bow carries a **protruding, fixed forward
  positron cannon**: a **rectangular/cylindrical barrel shroud** projecting ≈ **0.06 ×
  L** (~12 m) ahead of the bow face, diameter ≈ **0.035 × L** (~7 m), on the
  centreline at ≈ 0.45 hull height. **A barrel sticking out of the bow, not a hole in
  it.** This is the clearest way to tell a Kongo from a Yamato.
- **Hull:** wedge, full beam at **station 0.50**, then a fairly quick taper to a
  **narrow transom**. Deck line level 0.15–0.85. No waterline flare as pronounced as
  Yamato's — 2° is enough.
- **Bridge tower at station ≈ 0.35** — noticeably **further aft** than Yamato's 0.30,
  and **shorter**: height above main deck ≈ **0.09 × L** (~18 m). A compact, blunt
  tower rather than a tall pagoda. This aft-shifted, squat bridge is a good "older
  ship" tell.
- **Main turrets — four triples** (2202 fit) on the centreline:

  | turret | station | note |
  |---|---|---|
  | A | **0.16** | superfiring |
  | B | **0.32** | superfiring |
  | C | **0.66** | facing aft |
  | D | **0.82** | facing aft |

  For a 2199-era Kirishima, **drop C and D to two turrets** — the earlier Kongo fit
  is visually lighter. Either reads correctly; pick one and be consistent.
- **Missile tubes:** the **16 missile tubes** are best expressed as **two blocks of 8
  rectangular cell hatches** on the flanks at **station 0.45**, offset ±0.40 × beam,
  angled slightly upward. Very cheap triangles, very readable.
- **Torpedo tubes:** 8 tubes as **two rows of 4 circular ports** on the bow flanks,
  stations 0.08–0.18.
- **Engine nozzles: 3.** One central + two outboard, radius ≈ 0.045 × L (~9 m), at
  ±0.22 × beam. Smaller and more clustered than Yamato's.

**PALETTE**

| Material | Hex | Where |
|---|---|---|
| `hull_grey` | `#82878e` | main hull — slightly darker/greener than Yamato |
| `hull_red` | `#a8342c` | waterline band |
| `deck_dark` | `#3d4249` | deck plating |
| `glass_blue` | `#2b4a63` | bridge windows |
| `engine_glow` | `#5fc4f5` | nozzle interiors — dimmer than Yamato's |
| `gun_metal` | `#5a5f66` | turrets, bow gun |
| `accent_gold` | `#c9a227` | trim |

### 1.4 `yukikaze` — ユキカゼ / Yukikaze (DDS-117, Isokaze-class)

| Field | Value |
|---|---|
| Class | 磯風型突撃宇宙駆逐艦 (Isokaze-class assault space destroyer); 2202 = **磯風改型** |
| Faction | UNCF |
| Role | destroyer — small, fast, high-attack **corvette** |
| Length | **80 m** [OFFICIAL][^isokaze][WIKI][^yukikaze] |
| Crew | unknown, **at least 24** [WIKI][^yukikaze] |
| Hull number | **DDS-117** [WIKI][^yukikaze] |
| Captain (2199) | 古代守 [WIKI][^yukikaze] |
| Design lineage | inherits the pre-Garmillas-war **宙雷艇 (space torpedo boat)** concept [WIKI][^yukikaze] |

**Armament**
- 2199 fit [WIKI][^yukikaze]: **12.7サンチ三連装高圧増幅光線砲 ×2** (two triple
  12.7 cm high-pressure amplified beam guns) / **12.7サンチ対艦砲 ×2** (two 12.7 cm
  **fixed forward** anti-ship guns, upper bow) / **魚雷発射管 ×3** (three torpedo
  tubes; the *Yukikaze* herself carried the **試製空間魚雷**, an experimental space
  torpedo) / **ミサイル発射管 ×8** (eight missile tubes, aft of the bridge).
- 2202 磯風改型 fit [OFFICIAL][^isokaze]: **12.7サンチ三連装陽電子衝撃砲塔 ×2** /
  12.7サンチ対艦砲 ×2 / 魚雷発射管 ×3 / ミサイル発射管 ×8. Engine swapped to a
  **次元波動エンジン**, making it far more agile.
- **No inertial control** — the interior is zero-g and the crew wear magnetic boots
  [WIKI][^yukikaze]. (Not a modelling concern, but great flavour for HUD/audio.)

**SILHOUETTE NOTES (build instructions)**
- **A space fighter crossed with a submarine.** This is the one UNCF hull that should
  **not** look like a naval ship. Proportions: **L : B ≈ 3.3 : 1** (80 / 24) — short
  and chunky. Height ≈ 23 m [WIKI, kit-derived].
- **The bow plate is the identity: 「艦首装甲翼」 (bow armour wing).** A **flat,
  plate-like structure spreading left and right at the bow** — like a hammerhead or a
  manta's cephalic fins. It exists to shield the bridge and torpedo tubes
  [WIKI][^yukikaze]. Build it as a **thin horizontal slab spanning ≈ 1.6 × hull beam
  at station 0.10–0.22**, with **six small triangular fins** (three per side) attached
  at its outer edges, angled up / down / outboard. If you build only one feature of
  this ship, build this.
- **Bow forward of the plate (0.00–0.10):** a blunt, rounded nose carrying the **two
  fixed 12.7 cm anti-ship guns** as short parallel barrels on the upper surface.
- **Bridge: extremely low and faired into the hull.** Shaped like a **WWII heavy
  bomber canopy** — a shallow, elongated bubble, not a tower [WIKI][^yukikaze]. Sits
  at **station ≈ 0.45**, height above hull ≈ only **0.06 × L** (~5 m).
- **Body:** a fat, rounded, almost cylindrical fuselage with a slight taper aft.
  Cross-section ≈ **1.3 : 1** wide-to-tall — wider than tall, like an aircraft.
- **Tail assembly (stations 0.75–1.00) — very distinctive:**
  - **Horizontal stabilisers** on both sides at station ≈ 0.82, spanning ≈ 0.8 × beam.
  - **Vertical stabilisers** above *and* below at the root of each horizontal tail
    (four small fins total) [WIKI].
  - The stern narrows to a single **main propulsion nozzle** [WIKI].
- **Ventral drop tanks:** **two 増槽 (drop tanks)** slung under the hull at stations
  0.30 and 0.55, each a rounded capsule ≈ 0.12 × L long [WIKI]. A lovely, cheap,
  instantly-recognisable silhouette break.
- **Engine nozzles: 1 main + 3 small.** One main at the stern; small verniers: **one
  each side at the root of the bow plate** (station ≈ 0.24) and **one under the hull**
  (station ≈ 0.40) [WIKI].
- **Weapon mounts:** the two triple 12.7 cm turrets sit **one just abaft the bridge
  (station ≈ 0.52) and one directly opposite it on the hull's underside (station ≈
  0.52, mirrored in Y)** [WIKI]. The **8 missile tubes** are a block of cells
  immediately **behind the bridge**.

**PALETTE — Yukikaze is the colourful one.** The original scheme is yellow / red /
white [WIKI][^yukikaze]. This is a *gift* for the demo: a bright destroyer is trivially
readable against dark space and against the grey fleet.

| Material | Hex | Where |
|---|---|---|
| `accent_gold` | `#d8b23a` | **mid-hull to rear, beam-turret front faces, drop tanks** — the dominant yellow |
| `hull_red` | `#b8322a` | **bow plate, its six fins, beam-turret rear, rear hull + a lengthwise stripe on the drop tanks, horizontal and vertical tail fins** |
| `hull_white` | `#dfe3e6` | **forward hull / around the bridge** |
| `deck_dark` | `#2f3338` | recesses, intakes, sensor housings |
| `glass_blue` | `#33556e` | canopy |
| `gun_metal` | `#4e535a` | gun barrels |
| `engine_glow` | `#6fd0ff` | nozzle interiors |

> **2199 paint variants (free faction variety).** Twelve Isokaze-class appear in
> episode 1 in **three different paint schemes** [WIKI][^yukikaze]:
> **yellow-led** (アヤナミ, シキナミ, **ユキカゼ**, シマカゼ), **grey-led**
> (イソカゼ, フユツキ, ミナツキ, カゲロウ, タチカゼ), **red-led** (アヤセ,
> シラヌイ, ハツシマ). If the demo ever needs allied escorts, this gives three
> distinct colourways from one mesh — a very cheap way to make a fleet look varied.

### 1.5 Other notable UNCF ships (bonus)

| JA name | EN | Class | Length | Beam | Armament (official 2202) |
|---|---|---|---|---|---|
| 村雨改型宇宙巡洋艦 | Murasame-Kai-class cruiser | 宇宙巡洋艦 | **152 m** | — | 28 cm positron shock gun ×1 / 20 cm twin positron shock turrets ×3 / torpedo tubes ×4 [^murasame] |
| パトロール艦 | Patrol ship | 軽装甲巡洋艦 (patrol fit) | **188 m** | **42.2 m** | small wave motion gun ×1 (bow) / twin turrets ×3 / triple torpedo tubes ×4 / missile launchers ×8 [^patrol] |
| 護衛艦 | Frigate | フリゲート艦 | **113.3 m** | **18.5 m** | small wave motion gun ×1 (bow) / twin turrets ×3 / twin AA pulse-laser turrets ×4 (aft) / triple torpedo tubes ×4 / large torpedo tubes ×2 (lower bow) / quad missile launchers ×2 / quad anti-ship grenade launchers ×2 [^frigate] |
| ドレッドノート級 | Dreadnought-class | 前衛航宙艦 | (not stated) | — | wave motion gun armed; used as the time-rupture factory control ship *Prometheus* [^prometheus] |
| アンドロメダ級空母型 | Andromeda-class carrier type | 前衛武装宇宙艦 (carrier) | **484 m** | — | twin dispersal wave motion gun / 40.6 cm triple turrets ×2 / **180 Cosmo Tiger II, 24 launch ports** [^andromeda] |

---

## 2. Garmillas Empire (ガミラス帝国)

**Garmillas design language, in one sentence:** *organic, angular, insect/crustacean
hulls* — flattened teardrops and arrowheads with pronounced **dorsal and ventral
fins**, a **green-to-olive** body with **darker olive** panel accents, and gun turrets
sitting **on top of the hull in a row** rather than in naval barbettes. Where UNCF
ships are grey slabs with a red waterline, Garmillas ships are **green blades with
fins**.

### 2.1 `garmillas_dessler` — デウスーラII世 / Deusura II (Desler flagship)

| Field | Value |
|---|---|
| Class | 特一等航宙戦闘艦 (special first-class space combat ship) |
| Faction | Garmillas |
| Role | flagship (Desler's seat of command) |
| Length | **638 m** [WIKI][^deusura2] |
| Structure | **Outer shell unit + a separable "core ship" (コアシップ)** docked into it |
| Core ship | 独立戦闘指揮艦, **252 m** — separates and fights independently [WIKI][^deusura2] |

**Armament / features** [WIKI][^deusura2]
- **デスラー砲 (Desler Cannon)** in the bow — the Garmillas answer to the wave motion
  gun; a large forward-firing beam emitter.
- A **launch aperture on the dorsal surface** for Gamiloid (ガミロイド) drones.
- Normally docked to the **第二バレラス (Second Baleras)** space station's special gun
  mount as part of the capital's defences.

**SILHOUETTE NOTES (build instructions)**
- **A wide, flattened arrowhead — a fortress that moves.** The 2199 Deusura II is
  explicitly *wider* and *larger* than the original-series Desler ship [WIKI].
  Plan-form proportion roughly **L : B ≈ 2.6 : 1** — far stubbier than any UNCF ship.
  That stubbiness *is* the design; do not "fix" it into a slender hull.
- **Plan-form:** sharp prow at station 0.00 widening to **maximum beam at station ≈
  0.35**, then a long straight taper to a **broad flat stern at 1.00**, with **two
  swept-back tail fins** angled ~30° outboard and ~20° up. In top view the outline
  should read as a **swept delta with a notched trailing edge**.
- **Vertical profile: very flat.** Hull thickness ≈ **0.045 × L** (~29 m) at the
  centre, thinning to a blade at the wingtips and tail. The **dorsal surface is the
  dominant plane** — put the detail there.
- **Bow (0.00–0.10):** a vertical, slightly concave prow face with the **Desler
  Cannon** as a large recessed emitter, diameter ≈ **0.06 × L** (~38 m), at ≈ 0.5
  hull thickness above the keel.
- **Command core — the visual signature.** A **separate raised superstructure block**
  on the dorsal surface at **stations 0.30–0.55**, sitting *above* the shell so the
  **seam between shell and core is visible**. Build it as a **stepped ziggurat, 3
  tiers**; the top tier is the bridge with a narrow vertical fin/mast ≈ 0.09 × L tall.
  That docking seam is what tells the viewer "this is the Deusura II, not a generic
  Garmillas battleship" — it is worth the triangles.
- **Dorsal launch aperture:** an oval opening ≈ 0.10 L × 0.05 L at **station ≈ 0.62**
  on the centreline. Model as a recessed dark oval.
- **Weaponry:** Garmillas-style **dorsal beam turret row** — 4–6 low-profile domed
  mounts in two rows flanking the core, at stations **0.20 / 0.45 / 0.70**, offset
  ±0.22 × B. Plus ventral mounts mirrored below at stations 0.30 / 0.60.
- **Engine nozzles: 3 large in a horizontal row** at the stern (centre + two
  outboard), radius ≈ **0.030 × L** (~19 m), plus 2 small uppers. Garmillas nozzles
  read as **short, wide, flared bells**, not long cylinders.

**PALETTE**

| Material | Hex | Where |
|---|---|---|
| `hull_green` | `#4a5c3a` | main shell body |
| `hull_olive` | `#6b7a4a` | panel accents, upper deck, fin leading edges |
| `deck_dark` | `#23281f` | recesses, launch aperture, panel gaps |
| `gun_metal` | `#4a4a46` | turret bodies, barrel shrouds |
| `accent_gold` | `#b08d3a` | Dessler-house trim, core-ship banding |
| `engine_glow` | `#ffd27a` | Garmillas drive glow (**warm amber**) |

> **Renderer note:** Garmillas glow is **amber/warm**, UNCF glow is **cyan/blue**.
> In a crowded fleet battle that alone tells the player which side is which. Keep it.

### 2.2 `garmillas_kelkapia` — ケルカピア / Kelkapia (high-speed cruiser)

| Field | Value |
|---|---|
| Class | ケルカピア級航宙高速巡洋艦 (high-speed space cruiser) |
| Faction | Garmillas |
| Role | cruiser — **commerce raider** (星間通商破壊) [WIKI][^kelkapia] |
| Rating | 二等航宙装甲艦 (second-class space armoured ship) |
| Length | **240 m** [WIKI][^kelkapia] |
| Beam | **47 m** [WIKI][^kelkapia] |
| Height | **50 m** [WIKI][^kelkapia] |
| Lineage | redesign of the original series' 高速巡洋型クルーザー |

**SILHOUETTE NOTES (build instructions)**
- **The "long knife" of the Garmillas fleet.** Proportions **L : B ≈ 5.1 : 1**,
  **L : H ≈ 4.8 : 1** — noticeably *slimmer* than the Gaiderol battleship. It should
  look fast. Height ≈ 0.21 × L, so it is tall relative to its width.
- **Plan-form:** elongated teardrop. Narrow prow at 0.00, max beam at **station ≈
  0.45**, tapering to a **pointed / narrow stern** at 1.00. There is **no broad
  transom** — the stern comes to a wedge. This is the clearest way to tell a Kelkapia
  from a Destoria at distance.
- **Vertical profile:** a **dorsal fin ridge** running from station 0.30 to 0.75,
  peaking at ≈ **0.20 × H** above the hull body. The bridge is a small **low blister
  at station ≈ 0.52** — essentially amidships, i.e. **aft of where a UNCF bridge
  sits**. That asymmetry is a good faction tell.
- **Bow:** a smooth, **curved** prow (not chiselled) with **two forward beam
  emitters** recessed on either side of the centreline at ≈ 0.3 H.
- **Weaponry:** Garmillas **dorsal beam turret row** — 3 low domed mounts at stations
  **0.25 / 0.50 / 0.75** on the centreline, each with twin short barrels. Ventral: 2
  mounts mirrored at 0.35 / 0.65. Small anti-air clusters around the bridge blister.
- **Engine nozzles: 2 flared bells** side by side, radius ≈ **0.045 × L** (~11 m)
  each, centred at ±0.22 × B, plus a single small dorsal vernier.

**PALETTE**

| Material | Hex | Where |
|---|---|---|
| `hull_green` | `#46583a` | main body |
| `hull_olive` | `#66744a` | dorsal fin ridge, panel accents |
| `deck_dark` | `#20261c` | recesses, emitter housings |
| `gun_metal` | `#47473f` | turret domes, barrels |
| `engine_glow` | `#ffc861` | drive glow |

### 2.3 `garmillas_gaiderol` — ガイデロール / Gaiderol (space battleship)

| Field | Value |
|---|---|
| Class | ガイデロール級航宙戦艦 (space battleship) |
| Faction | Garmillas |
| Role | battleship (line of battle) |
| Rating | 二等航宙戦闘艦 (second-class space combat ship) |
| Length | **350 m** [WIKI][^gaiderol] |
| Beam | **42 m** [WIKI][^gaiderol] |
| Height | **70 m** [WIKI][^gaiderol] |
| Lineage | redesign of the original シュルツ艦 (Schulz's ship) |
| Named ships | シュバリエル (Schulz, Pluto front flagship), ゲルガメッシュ (Gehl) |

**Armament (from source)** [WIKI][^gaiderol]
- **多数の魚雷発射管** — many torpedo tubes.
- **ビーム砲塔** — multiple beam turrets.
- **艦橋周囲に近接防御火器を多数配置** — a dense ring of close-in defensive weapons
  *around the bridge*, explicitly to raise the bridge's survivability. This is a
  stated design note and an excellent silhouette cue.

**SILHOUETTE NOTES (build instructions)**
- **The tall one.** L : B ≈ 8.3 : 1 and **H : B ≈ 1.67 : 1** — the Gaiderol is
  *unusually tall for its beam* [WIKI]. That height is the identity: build a **narrow,
  deep-bladed hull with a very tall dorsal structure**, not a fat battleship.
- **Plan-form:** narrow, almost constant width. Prow at 0.00, widening quickly to full
  beam by **station 0.20**, then **parallel-sided** to station 0.75, then a short
  taper to a squared stern. Near-parallel sides distinguish it from the teardrop
  Kelkapia.
- **Vertical profile (the key):** the hull body itself is only ≈ **0.35 × H** thick (a
  vertical blade). The remaining **0.65 × H is dorsal superstructure** — a tall,
  narrow **bridge citadel at station ≈ 0.40**, plus a **prominent dorsal fin/spine**
  running aft from it to station 0.80. In side view the silhouette is a **knife with
  a tower on it**.
- **Bow:** a sharp, straight-edged wedge — more angular than the Kelkapia. Model the
  **torpedo tube banks** as two rows of 4–6 recessed circular ports on the **flank of
  the prow**, stations 0.06–0.18, at ≈ 0.5 hull thickness.
- **Beam turrets:** dorsal row of **4 mounts** at stations **0.18 / 0.35 / 0.58 /
  0.78**, centreline, twin short barrels. Ventral row of 3 mirrored at 0.25 / 0.50 /
  0.72.
- **Bridge CIWS ring — do not skip this.** A **ring of 8–12 tiny mounts** encircling
  the bridge citadel at its base: small cylinders with stubby barrels, evenly spaced
  on a ring of radius ≈ **0.09 × L**. It reads instantly as "Garmillas battleship" and
  costs very few triangles (instance one small cylinder).
- **Engine nozzles: 4 bells in a 2×2 arrangement**, radius ≈ **0.032 × L** (~11 m),
  centred at ±0.18 × B, ±0.10 × H.

**PALETTE**

| Material | Hex | Where |
|---|---|---|
| `hull_green` | `#43553a` | main hull blade |
| `hull_olive` | `#5f6d45` | dorsal spine, citadel panels |
| `deck_dark` | `#1e241b` | torpedo ports, recesses |
| `gun_metal` | `#45453d` | turrets, CIWS ring, barrels |
| `accent_gold` | `#a8862f` | citadel trim |
| `engine_glow` | `#ffbe55` | drive glow |

### 2.4 Other notable Garmillas ships (bonus — wave variety)

All figures [WIKI] from the Weblio Wikipedia mirror.

| JA name | EN | Class | Length | Beam | Height | Notes |
|---|---|---|---|---|---|---|
| ゼルグート級 | Zelguut-class | 一等航宙戦闘艦 | **730 m** | — | — | 超弩級戦艦; 3 hulls: ゼルグートII世 (red, Zerik), デウスーラI世 (blue, Desler), ドメラーズIII世 (grey, Domel) [^zelguut] |
| ハイゼラード級 | Haizerad-class | 航宙戦艦 | **392 m** | — | — | Gaiderol successor, uprated guns/engines; シャングリ・ラー (pale purple), キルメナイム (blue) [^haizerad] |
| メルトリア級 | Meltoria-class | 航宙巡洋戦艦 | **283 m** | — | — | 二等航宙装甲艦, battlecruiser [^meltoria] |
| デストリア級 | Destoria-class | 航宙重巡洋艦 | **270 m** | **63 m** | **68 m** | Beam-armed Garmillas **mainstay**; original 駆逐型デストロイヤー艦 [^destoria] |
| クリピテラ級 | Kripitera-class | 航宙駆逐艦 | **160 m** | **37 m** | **37 m** | Torpedo-attack destroyer, **most numerous** Garmillas hull [^kripitera] |
| ポルメリア級 | Polmeria-class | 強襲航宙母艦 | **383.8 m** | **291.3 m** | **50 m** | **Disc-shaped** carrier — extremely distinctive; ventral beam armament [^polmeria] |
| ガイペロン級 | Gaiperon-class | 多層式航宙母艦 | **410 m** | — | — | Old three-deck carrier; バルグレイ (green), ランベア (light purple) [^gaiperon] |

**Garmillas paint variants worth knowing** — the same class appears in several
colourways, and using them is the cheapest possible way to make a fleet look varied
[WIKI]:
- **Zelguut-class:** ゼルグートII世 **red** (Zerik), デウスーラI世 **blue** (Desler),
  ドメラーズIII世 **grey** (Domel).
- **Haizerad-class:** シャングリ・ラー **pale purple** (Celestella), キルメナイム
  **blue** (Gimleh).
- **Gaiperon-class:** バルグレイ **green**, ランベア **light purple**.
- Flagship hulls across factions tend to be **red** (see also Bolar, §3).

---

## 3. Bolar Federation (ボラー連邦)

**Bolar design language, in one sentence:** *a deep-sea fish crossed with a
submarine* — **purple-to-blue** hulls with **white line accents**, **countless fine
surface bumps with anti-air guns hidden in the grooves**, and — the defining
feature — **retractable ("隠顕式") armament that folds flush into the hull**. Main
guns are **concentrated forward**; secondary and AA are not.

**Canon notes that matter for the model** [WIKI][^bolar]:
- **Retractable armament ("隠顕式") is the faction signature.** In the 2205 redesign
  the weapons also became **rotatable/traversable**, which the originals were not.
  (In-universe rationale: hulls are streamlined because they cruise through dense
  interstellar medium.) *In the demo this is a gift: Bolar turrets can visibly
  **unfold before firing** — a free telegraph animation that no other faction has.*
- **Surface texture:** the hull is covered in **innumerable small bumps and grooves**
  [WIKI]. Model this cheaply as a low-frequency panel grid plus a dark recess
  material — do not try to model individual bumps.
- **Colour:** **purple → blue** hulls with **white line accents** as the common
  thread; **individual classes vary a lot** in exact hue. **Flagships are painted
  red** (exceptions exist — e.g. the Balcom is not red) [WIKI].
- **No official lengths exist for the original designs** — only a rough size
  comparison chart. The 2205/3199 remake designs *do* have official lengths, which is
  why the demo should use a **remake** design for `bolar_carrier` [WIKI].
- **Design lineage:** originally by the studio **Submarine** — deliberately
  **curve-dominant**, in explicit contrast to Ibashi's straight-line
  Galman-Garmillas mecha. Later ships (デストロイヤー艦, ハーキンス艦) switched to
  straight lines [WIKI]. **So: early Bolar = curves; late Bolar = angles.** Pick
  curves for a "classic Bolar" look.

### 3.1 `bolar_carrier` — ガノンダ型航宙母艦 / Ganonda-class space carrier

| Field | Value |
|---|---|
| Class | ガノンダ型航宙母艦 (Ganonda-class space carrier), **28号計画** |
| Faction | Bolar |
| Role | carrier; **frequently used as a fleet flagship** [WIKI][^ganonda] |
| Length | **400 m** [WIKI][^ganonda] |
| Main engine | コグダール機関 (Kogudahl engine) |
| Air wing | **レブート (Reboot)** [WIKI][^ganonda] |
| Design | 明貴美加 (Akiki Mika), for 2205 — the *only* Bolar design in the remake era |

**Armament (2205/3199 listing)** [WIKI][^ganonda]
- **ボラー砲（横型）×1** — one **horizontally-mounted** Bolar cannon (the wide,
  slab-like main gun characteristic of Bolar ships).
- **隠顕式四連装陽電子砲 ×3** — three retractable quad positron guns.
- **隠顕式対空・対艦兵器群 ×10（両舷）** — ten retractable dual-purpose AA/anti-ship
  mounts **per side**.
- **隠顕式対空機銃 ×2（艦橋基部両舷）** — two retractable AA machine guns, one each
  side at the bridge base.
- **空間魚雷発射管 ×6（両舷）** — six space torpedo tubes per side.

**SILHOUETTE NOTES (build instructions)**
- **The "glowing red runway".** The single most important and most demo-friendly
  feature: the Ganonda has a **full-length flight deck (全通甲板)** with a
  **landing aperture at the stern**, and **the flight-deck surface glows red**
  [WIKI][^ganonda]. Hull colour is **pale purple with white lines**. Build the deck
  as a distinct flat slab running most of the ship's length, assigned to
  `engine_glow` or a dedicated emissive so the renderer can make it pulse.
- **Overall plan-form:** derived from the original 大型空母, whose signature is
  **fins spread out to left and right** ("左右にヒレを広げたような艦容")
  [WIKI][^bolar]. So: a **central spindle hull** with **large swept lateral fins**
  projecting on both sides at about **station 0.35–0.60**. These fins are the
  silhouette; everything else is secondary.
- **Proportions [DERIVED]:** L : B ≈ 3.2 : 1 overall *including* the lateral fins
  (the bare hull is much narrower, ≈ 6 : 1). Height ≈ 0.13 × L.
- **Bow (0.00–0.12):** a **rounded, blunt** prow — Bolar hulls are curve-dominant.
  Carries the **ボラー砲（横型）**: a **wide, flat, horizontally-oriented emitter
  slab**, not a circular muzzle. Width ≈ **0.20 × L**, height ≈ 0.04 × L. This
  horizontal slab muzzle is the Bolar visual signature — mirror it on every Bolar
  ship.
- **Flight deck:** a flat slab at ≈ 0.10 × L above the keel, running from **station
  0.15 to 0.95** on the centreline, width ≈ **0.25 × L**. **Glowing red surface.**
  The **stern landing aperture** is a rectangular recess at station 0.92–0.98.
- **Bridge:** **at the very stern**, station ≈ 0.86–0.94 [WIKI, from the 大型空母
  lineage: "艦橋が艦最後尾に位置し"]. Small and low — a **flat-topped block**, height
  above deck ≈ 0.05 × L. The two **retractable AA machine guns** sit at its base,
  one each side.
- **Weaponry placement (per the source, turrets go on the FORWARD deck)** [WIKI]:
  - **3 × retractable quad positron guns** on the **forward deck** at stations
    **0.20 / 0.30 / 0.40**, centreline, folded flush at rest.
  - **10 retractable AA/anti-ship mounts per side** in **two rows along the flanks**
    at stations 0.15–0.85, offset ±0.42 × beam. At rest they are *closed*; animate
    them unfolding.
  - **6 space torpedo tubes per side**, stations 0.45–0.75, offset ±0.38 × beam.
- **Engine nozzles [DERIVED]: 4 flared bells in a row** across the stern below the
  flight deck, radius ≈ 0.028 × L, at ±0.10 × B and ±0.28 × B.

**PALETTE**

| Material | Hex | Where |
|---|---|---|
| `bolar_blue` | `#4a4a7a` | main hull — **purple-blue**; the faction's base tone |
| `hull_olive` | `#5c5c8c` | lighter panel accents / upper surfaces (violet) |
| `hull_white` | `#d9dce4` | **white line accents** — the Bolar common thread |
| `deck_dark` | `#22223a` | grooves, recesses, folded weapon bays |
| `engine_glow` | `#ff3b30` | **flight-deck glow (red) AND drive glow** — Bolar runs hot/red |
| `gun_metal` | `#3f3f55` | retractable turret bodies |
| `accent_gold` | `#b0342c` | flagship red trim (use only on a flagship variant) |

> **Demo synergy:** a Bolar carrier with a **red-glowing runway**, **red drive glow**,
> and **weapons that unfold before firing** is visually distinct from both UNCF
> (grey/cyan, fixed turrets) and Garmillas (green/amber, exposed turrets) at a
> single glance. That is exactly what wave 3 needs.

### 3.2 Other notable Bolar ships (bonus)

| JA name | EN | Class | Length | Armament | Notes |
|---|---|---|---|---|---|
| クロトガ型標準戦艦 | Krotoga-class standard battleship | 標準戦艦 (**戦艦A型**) | **320 m** | ボラー砲×1 / 隠顕式四連装陽電子砲×4 / 隠顕式三連装小型陽電子砲×12 / 隠顕式二連装空間機銃×14 / 後方対応兵器群×4 / 空間魚雷発射管×6 [^krotoga] | 13号計画; **the Bolar mainstay**, a "masterpiece" still in production. Blue-purple hull with white lines. Silhouette resembles the B-type. **Original A-type** was ~176.4 m, **pointed** bow tip, thick short hull, small simple bridge at the **stern**, retractable turrets in a row **in front of** the bridge [^bolar] |
| アマンガ型ミサイル戦艦 | Amanga-class missile battleship | ミサイル戦艦 (**戦艦B型**) | **300 m** | 隠顕式砲塔（上甲板）×2 / 隠顕式砲塔（舷側部）×6 / **下部大型ミサイル×1** [^bolar] | **Flat** bow tip, rounder corners than A-type. Carries **one enormous missile under the lower bow, roughly half the hull's length** — an unmissable silhouette feature and a perfect "telegraphed heavy attack" for the demo [^bolar] |
| デストロイヤー艦 | Destroyer | 駆逐艦 | ~168 m ⚠️ [UNVERIFIED] | 6連装スペースロック発射管×2 / 連装格納式砲塔×4 / 連装大型格納式砲塔×1 / 爆雷発射口×8 / 格納式対空砲座多数 [^bolar_dd] | **The odd one out:** slim, sharp, angular, **blue** — deliberately *not* the rounded deep-sea-fish shape. Soviet-style VLS "Space Rock" launcher on the forward deck. Designed by Ibashi (the straight-line phase) [^bolar_dd] |
| ハーキンス艦 | Hawkins | 大型戦艦 | not stated | 大口径砲（ボラー砲）×2 / 格納式砲塔×6 / ~30 missile tubes [^bolar] | **Near-cuboid main hull with a DISC-shaped hull underneath** — very distinctive stacked geometry [^bolar] |
| バルコム艦 | Balcom | 大型戦艦 | not stated | 伸縮式砲×2 / 大型ミサイル発射口×2 (両舷) [^bolar] | **Flat, deep-sea-fish hull** — closer to a carrier than a battleship; **bow opening is an aircraft launch port**. Not painted red. Best hull if you want a Bolar "carrier that fights" [^bolar] |
| ゴルサコフ艦 | Gorsakov | 大型戦艦 | not stated | 大口径砲（ボラー砲）×1 / 格納式砲塔×3 / many missile tubes [^bolar] | Horizontally-spreading bridge structure; **thick exposed pipes around the main propulsion nozzles** — a nice greeble cue [^bolar] |
| ラジェンドラ号 / アーコフ型 | Rajendora / Arkoff | 80号計画試験艦 強襲戦艦 | **360 m** (3199 remake) | 新型ボラー砲×1 (bow) / ボラー砲×1 (lower bow) / 隠顕式四連装陽電子砲×3 / 隠顕式三連装小型陽電子砲×6×2 / 隠顕式二連装空間機銃×11×2 / 前方魚雷発射管×3×2 / 対艦ミサイルランチャー×6+6 / 後部攻撃装置×8 / 前方近接防御兵器群×9×2 [^rajendora] | The 3199 remake's **新型ボラー砲 is stated to be 波動砲-equivalent in performance** — i.e. Bolar has a wave-motion-gun-class weapon. **Excellent for the demo's wave-3 boss** [^rajendora] |
| 大型空母 | Large carrier | 大型空母 | not stated | — | Bolar's **main carrier**: **fins spread left and right**, **bow aircraft launch aperture**, **bridge at the very stern**, turrets on the forward deck. **Painted red when serving as a fleet flagship.** The direct ancestor of the Ganonda's shape [^bolar] |

> **Wave-3 design suggestion.** Wave 3 currently gets only `bolar_carrier`. Consider
> adding `bolar_krotoga` (320 m, the Bolar *mainstay* — the hull the player should see
> most of) and one `bolar_amanga` (300 m) whose **half-hull-length under-slung
> missile** makes a superb telegraphed heavy attack. Three Bolar silhouettes —
> glowing-runway carrier, slab-sided standard battleship, and giant-missile ship —
> would give wave 3 a completely different feel from waves 1–2.

---

## 4. Cross-faction cheat sheet for the modeller

**How to tell them apart at 200 m in a dark frame — in priority order:**

| Cue | UNCF | Garmillas | Bolar |
|---|---|---|---|
| **Base hue** | grey `#8a8f96` | green `#4a5c3a` | purple-blue `#4a4a7a` |
| **Accent** | red waterline band | olive panels, gold trim | **white line accents** |
| **Drive glow** | **cyan** `#6fd0ff` | **amber** `#ffd27a` | **red** `#ff3b30` |
| **Bow weapon** | recessed **circular** WM-gun muzzle (Yamato) or **twin** muzzles (Andromeda) | recessed **Desler cannon** oval | **wide horizontal slab** (ボラー砲) |
| **Hull plan** | long slender wedge | **arrowhead / teardrop / blade** | **rounded deep-sea fish** |
| **Fins** | none (flat decks) | **prominent dorsal + tail fins** | **large swept lateral fins** |
| **Turret style** | naval barbettes, rounded, **3 barrels** | **low domed mounts in a dorsal row**, twin barrels | **retractable, fold flush, then unfold** |
| **Proportion feel** | long & low | **tall** (Gaiderol) or **stubby-wide** (Deusura II) | short & thick |

**Triangle budget guidance** (SPEC §5.6 caps every ship at 12 000 tris):
- The **silhouette-critical** spend is: bow geometry, bridge tower, and turret count.
  Get those three right and a ship is recognisable even at 3 000 triangles.
- **Do not model** hull bumps (Bolar), individual CIWS (use instanced low-poly
  cylinders), or window strips (use one `glass_blue` band).
- **Do model** the one weird feature per faction: Yamato's flat WM-gun bow face,
  Andromeda's twin bow muzzles, Yukikaze's bow armour wing, the Deusura II's visible
  shell/core seam, the Gaiderol's bridge CIWS ring, the Ganonda's glowing red
  runway. Those are what make each ship *itself* rather than generic.

---

## 5. Source list

[^yamato]: ヤマト型一番艦ヤマト（第一次改装型）全長333m; 主機 次元波動エンジン×1; 48サンチ三連装陽電子衝撃砲塔×3; 20サンチ三連装陽電子衝撃砲塔×2; 魚雷発射管×12; 8連装ミサイル発射塔×1; 94式爆雷投射機×2 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^andromeda]: 前衛武装宇宙艦AAA-1 アンドロメダ 全長444m; 補機 ケルビンインパルスエンジン×4; 二連装次元波動爆縮放射機（拡散波動砲）; 40.6センチ三連装収束圧縮型衝撃波砲塔×4; 司令塔防護ショックフィールド砲×3; 近接戦闘用六連装側方光線投射砲×2; 姉妹艦・空母型484m/180機/24発艦口 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^kongo]: 金剛改型宇宙戦艦 タイコンデロガ・ゆうなぎ 全長205m; 46センチ陽電子衝撃砲×1（艦首固定）; 36センチ三連装陽電子衝撃砲塔×4; 魚雷発射管×8; ミサイル発射管×16 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^isokaze]: 磯風改型突撃宇宙駆逐艦 全長80m; 12.7センチ三連装陽電子衝撃砲塔×2; 12.7センチ対艦砲×2; 魚雷発射管×3; ミサイル発射管×8 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^murasame]: 村雨改型宇宙巡洋艦 サラトガ 全長152m; 28センチ陽電子衝撃砲×1; 20センチ連装陽電子衝撃砲塔×3; 魚雷発射管×4 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^patrol]: パトロール艦 全長188m / 全幅42.2m / 乗員 士官9・下士官46; 小型波動砲×1; 連装砲塔×3; 三連装魚雷発射管×4; ミサイル発射機×8 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^frigate]: 護衛艦 全長113.3m / 全幅18.5m / 乗員 士官6・下士官38; 小型波動砲×1; 連装砲塔×3; 二連装対空パルスレーザー砲塔×4; 三連装魚雷発射管×4; 大型魚雷発射管×2; 四連装ミサイル発射機×2; 四連装対艦グレネード発射機×2 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^prometheus]: 時間断層制御艦プロメテウス; ドレッドノート級戦艦を断層内工場の制御機として転用; 艦橋は通常型より拡張、艦橋窓は塞がれ映像表示 — [宇宙戦艦ヤマト2202 公式 MECHANIC](https://www.yamato2202.net/sp/character_mechanic/mecha1.html) **[OFFICIAL]**
[^kirishima]: 金剛型宇宙戦艦キリシマ 全長205m; 識別番号 BBS-555; 連合宇宙艦隊・第一艦隊旗艦; 艦長 山南修; 旧沖田艦 — [金剛型宇宙戦艦キリシマ（Weblio / ja.wikipedia ミラー）](https://www.weblio.jp/content/%E9%87%91%E5%89%9B%E5%9E%8B%E5%AE%87%E5%AE%99%E6%88%A6%E8%89%A6%E3%82%AD%E3%83%AA%E3%82%B7%E3%83%9E) **[WIKI]**
[^yukikaze]: 磯風型突撃宇宙駆逐艦 全長80m; 乗員 最低24名以上; 12.7サンチ三連装高圧増幅光線砲×2; 12.7サンチ対艦砲×2（艦首固定）; 魚雷発射管×3（ユキカゼは試製空間魚雷）; ミサイル発射管×8; 識別番号 DDS-117; 艦首装甲翼と6枚のフィン; 水平/垂直尾翼; 増槽2基; 推進ノズル1基+小型3基; 塗装 黄/赤/白; 3パターンの塗装 — [ゆきかぜ (宇宙戦艦ヤマト)（Weblio / ja.wikipedia ミラー）](https://www.weblio.jp/content/%E3%82%86%E3%81%8D%E3%81%8B%E3%81%9C+%28%E5%AE%87%E5%AE%99%E6%88%A6%E8%89%A6%E3%83%A4%E3%83%9E%E3%83%88%29) **[WIKI]**
[^deusura2]: デウスーラII世 特一等航宙戦闘艦 全長638m; コアシップ 全長252m; 艦首にデスラー砲; 艦体上面にガミロイド発進開口部; 第二バレラス特殊砲架に接続 — [ガミラス軍艦艇（Weblio / ja.wikipedia ミラー）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^kelkapia]: ケルカピア級航宙高速巡洋艦 全長240m / 全幅47m / 全高50m; 二等航宙装甲艦; 星間通商破壊目的 — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^gaiderol]: ガイデロール級航宙戦艦 全長350m / 全幅42m / 全高70m; 二等航宙戦闘艦; 多数の魚雷発射管とビーム砲塔; 艦橋周囲に近接防御火器を多数配置; シュバリエル/ゲルガメッシュ — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^zelguut]: ゼルグート級一等航宙戦闘艦 全長730m; ゼルグートII世（赤・ゼーリック）/デウスーラI世（青・デスラー）/ドメラーズIII世（灰・ドメル） — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^haizerad]: ハイゼラード級航宙戦艦 全長392m; ガイデロール級の後継艦; シャングリ・ラー/キルメナイム — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^meltoria]: メルトリア級航宙巡洋戦艦 全長283m; 二等航宙装甲艦 — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^destoria]: デストリア級航宙重巡洋艦 全長270m / 全幅63m / 全高68m; ビーム艦砲主体; ガミラス主力艦艇 — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^kripitera]: クリピテラ級航宙駆逐艦 全長160m / 全幅37m / 全高37m; 建造数最多; 雷撃戦主体 — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^polmeria]: ポルメリア級強襲航宙母艦 全長383.8m / 全幅291.3m / 全高50m; 円盤型; 艦底部にビーム砲 — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^gaiperon]: ガイペロン級多層式航宙母艦 全長410m; バルグレイ（緑）/ランベア（薄紫） — [ガミラス軍艦艇（Weblio）](https://www.weblio.jp/content/%E3%82%AC%E3%83%9F%E3%83%A9%E3%82%B9%E8%BB%8D%E8%89%A6%E8%89%A6) **[WIKI]**
[^bolar]: ボラー連邦の戦闘艦 — 格納式（隠顕式）武装と青紫色の艦体色; 艦表面の無数の凹凸と溝に隠れた対空火器; 旗艦は赤塗装（例外あり）; 主砲は艦首方向に集中配置; 全長設定なし（寸法対比図のみ）; デザイン サブマリン（曲線主体）→板橋克己（直線）; 2205 明貴美加リデザインで旋回可能に; 紫〜青系統+白ライン; 大型空母/戦闘空母/バルコム艦/ハーキンス艦/ゴルサコフ艦/ベムラーゼ艦/デストロイヤー艦 — [ボラー連邦の戦闘艦（Weblio / ja.wikipedia ミラー）](https://www.weblio.jp/content/%E3%83%9C%E3%83%A9%E3%83%BC%E9%80%A3%E9%82%A6%E3%81%AE%E6%88%A6%E9%97%98%E8%89%A6) **[WIKI]**
[^ganonda]: ガノンダ型航宙母艦 全長400m; 主機 コグダール機関; ボラー砲（横型）×1; 隠顕式四連装陽電子砲×3; 隠顕式対空・対艦兵器群×10（両舷）; 隠顕式対空機銃×2; 空間魚雷発射管×6（両舷）; 艦載機レブート; 全通甲板; 飛行甲板が赤く発光; 艦体色 薄紫+白ライン; 28号計画; 明貴美加 — [ボラー連邦の戦闘艦（Weblio）](https://www.weblio.jp/content/%E3%83%9C%E3%83%A9%E3%83%BC%E9%80%A3%E9%82%A6%E3%81%AE%E6%88%A6%E9%97%98%E8%89%A6) **[WIKI]**
[^krotoga]: クロトガ型標準戦艦 全長320m; ボラー砲×1; 隠顕式四連装陽電子砲×4; 隠顕式三連装小型陽電子砲×12; 隠顕式二連装空間機銃×14; 後方対応兵器群×4; 空間魚雷発射管×6; 13号計画; 青紫+白ライン; 戦艦A型 — [ボラー連邦の戦闘艦（Weblio）](https://www.weblio.jp/content/%E3%83%9C%E3%83%A9%E3%83%BC%E9%80%A3%E9%82%A6%E3%81%AE%E6%88%A6%E9%97%98%E8%89%A6) **[WIKI]**
[^amanga]: アマンガ型ミサイル戦艦 全長300m; 戦艦B型; 下部大型ミサイル×1（船体の約半分のサイズ）; 先端部が平ら — [ボラー連邦の戦闘艦（Weblio）](https://www.weblio.jp/content/%E3%83%9C%E3%83%A9%E3%83%BC%E9%80%A3%E9%82%A6%E3%81%AE%E6%88%A6%E9%97%98%E8%89%A6) **[WIKI]**
[^bolar_dd]: デストロイヤー艦 全長不明（約168m）; 6連装スペースロック発射管×2; 連装格納式砲塔×4; 連装大型格納式砲塔×1; 爆雷発射口×8; 細長く鋭角的; 艦体色ブルー — [ボラー連邦の戦闘艦（Weblio）](https://www.weblio.jp/content/%E3%83%9C%E3%83%A9%E3%83%BC%E9%80%A3%E9%82%A6%E3%81%AE%E6%88%A6%E9%97%98%E8%89%A6) **[WIKI]**
[^rajendora]: 80号計画試験艦アーコフ型強襲戦艦 ラ＝ジェンドラ 全長360m; 新型ボラー砲（波動砲に匹敵）; 多数の隠顕式兵装 — [ボラー連邦の戦闘艦（Weblio）](https://www.weblio.jp/content/%E3%83%9C%E3%83%A9%E3%83%BC%E9%80%A3%E9%82%A6%E3%81%AE%E6%88%A6%E9%97%98%E8%89%A6) **[WIKI]**

### Source-access notes (for whoever verifies this later)

- **ja.wikipedia.org was unreachable** from this environment (`web_fetch` → `fetch
  failed`; browser navigation → CDP timeout). All Wikipedia-derived facts above were
  therefore taken from **Weblio's Wikipedia mirrors**, which reproduce the same
  article text and cite the same revision dates. Where a fact matters for the
  manifest, re-verify against ja.wikipedia directly from a normal network.
- **`srw.wingzero.tw` and `pedia.3rd-in.co.jp` are behind Cloudflare** and returned
  a "Just a moment…" interstitial. Not used.
- **`yamato2202.net` (official)** loaded fine and is the highest-confidence source in
  this document — prefer it wherever it covers a ship.
- Every **[UNVERIFIED]** tag marks a number I could not source. **Beam figures for
  `yamato` (48.6 m) and `andromeda` (60.8 m) fall in this category** — they are
  plausible and commonly repeated in fandom, but I did not find a citable source, so
  do not present them as canon.
