# YAMATO FLEET 2199 - generated fleet assets

**Do not hand-edit anything in this directory.** Every file here is written by
`tools/gen_models.py` and consumed through `manifest.json` (`src/core/assets.js`).

## Regenerate

```
python3 tools/gen_models.py --out assets/models
```

Regeneration is deterministic - fixed seeds, insertion-ordered data and
4-decimal coordinates - so re-running produces byte-identical files:

```
shasum -a 256 assets/models/*     # run twice, compare
```

`--only <id>` rebuilds one ship and merges it into the existing manifest.
`--selftest` checks the primitive library (face winding, volumes, polygon
clipping) without writing anything.

## Validate

```
python3 tools/validate_models.py assets/models
```

Exit code 0 means the SPEC section 4/5 contract holds: manifest schema, group
names, palette names, triangle/quad faces, `vn` normals, Z extent == `lengthM`,
X extent == `beamM`, the 12 000-triangle budget and the hardpoint rules.

## Contract (docs/SPEC.md sections 4 and 5)

| Item | Value |
|---|---|
| Units | 1 unit = 1 metre |
| Ship local space | bow **-Z**, up **+Y**, origin at the ship's centre (mid-length, centreline, mid-height of the hull) |
| Files | one `<id>.obj` + one `<id>.mtl` per ship, ASCII, no textures |
| Faces | triangles and quads only; `vn` normals written (per face when flat, per vertex when smooth) |
| Groups | fixed: `hull`, `superstructure`, `bridge`, `wave_motion_gun`, `engine_nozzle`, `wing`, `radiator`; merged 2199 parts: `anti_air`, `torpedo_tube`, `missile_launcher`, `third_bridge`, `catapult`, `rocket_anchor`, `aux_engine`, `depth_charge`; indexed mounts: `turret_main_1..N`, `turret_secondary_1..N`, `ciws_1..N` (SPEC §5 rule 3) |
| Mount pivots | an indexed group's name IS its manifest hardpoint name and its geometry is authored **centred on its own pivot** - x = z = 0 on the traverse axis, y = 0 at the deck line where the barbette meets the hull. The renderer does `mesh.position = hardpoint.pos` then `mesh.rotation.y = <traverse>` (0 = trained fore-and-aft), so the turrets traverse individually |
| Merged groups | a part that does NOT rotate takes a merged group, never an indexed one: a torpedo port is a hole in the plating, and naming it `torpedo_tube_3` would drag it into the pivot contract (and correctly fail it). Its direction lives in the hardpoint `dir` |
| Materials | names are the frozen SPEC section 5.5 palette; the *values* are per-ship faction colours taken from `docs/research/01-yamato-ships.md` |
| Budget | under 12 000 triangles per ship |

## Ships

| id | name | JA | faction | class | lengthM | beamM | triangles | groups | hardpoints |
|---|---|---|---|---|---|---|---|---|---|
| `yamato` | Yamato (BBY-01) | ヤマト | uncf | Yamato-class | 333 | 48 | 11668 | 24 | 58 |
| `andromeda` | Andromeda (AAA-01) | アンドロメダ | uncf | Andromeda-class | 444 | 62 | 9800 | 20 | 32 |
| `kirishima` | Kirishima (CCV-05) | 霧島 | uncf | Kongo-class (refit) | 205 | 34 | 6920 | 14 | 20 |
| `yukikaze` | Yukikaze (DD-117) | 雪風 | uncf | Isokaze-class | 80 | 38 | 4020 | 13 | 14 |
| `garmillas_dessler` | Desler flagship | デスラー旗艦 | garmillas | Desler flagship | 638 | 245 | 9334 | 21 | 20 |
| `garmillas_kelkapia` | Kelkapia-class cruiser | ケルカピア型 | garmillas | Kelkapia-class | 240 | 48 | 5912 | 16 | 14 |
| `garmillas_gaiderol` | Gaiderol-class battleship | ガイデロル型 | garmillas | Gaiderol-class | 350 | 46 | 8162 | 18 | 16 |
| `bolar_carrier` | Bolar carrier | ボラー空母 | bolar | Bolar carrier | 400 | 110 | 4056 | 14 | 14 |

Lengths are canon per `docs/research/01-yamato-ships.md` section 0.1 and were
accepted by the Lead into docs/SPEC.md section 5: `kirishima` 205 m (was 222),
`garmillas_dessler` 638 m (Deusura II, was 400), `garmillas_kelkapia` 240 m
(was 250), `garmillas_gaiderol` 350 m (was 390), `bolar_carrier` 400 m (was 380).
`yamato` 333 m, `andromeda` 444 m and `yukikaze` 80 m are unchanged.
`lengthM` is what fleet formation spacing reads, so it is the one number every
consumer must take from the manifest rather than hardcoding.

## Hardpoints

`hardpoints[]` are ship-local: `pos` in metres, `dir` normalised. Kinds:

| kind | meaning |
|---|---|
| `wmgun` | bow wave-motion-gun / heavy beam emitter (named `wave_motion_gun`) |
| `turret` | main and secondary gun mounts (`turret_main_*`, `turret_secondary_*`) |
| `thruster` | stern engine bells and the auxiliary engines (`engine_*`, `aux_engine_*`, dir +Z) |
| `anti_air` | pulse-laser mounts (`ciws_*`, individually traversable) |
| `torpedo` | hull torpedo tubes (`torpedo_tube_*`), openings in the plating |
| `missile` | missile launchers (`missile_launcher_*`), ventral tubes and box/funnel cells |

Every ship carries a bow `wave_motion_gun` emitter, centreline `turret_main`
mounts, at least two `turret_secondary` and two `anti_air` mounts, and stern
`engine_*` bells.

### Yamato armament layout (task-9 rebuild)

`yamato` is rebuilt against `docs/research/05-yamato-armament-layout.md`, and
`tools/validate_models.py` now asserts the counts from the file itself:

* **3** triple 48 cm main turrets - two forward superfiring, one aft.
* **2** triple 20 cm secondary turrets, both on the **centreline**.  The old
  model carried four triple WING mounts, which is what made the ship read as
  the wrong ship.
* **40** pulse-laser mounts of five types plus the two conning-tower firearms:
  4 ship as the traversable `ciws_1..4` (that is `CONFIG.ships.yamato.pdMounts`,
  a balance number) and the other 38 as the merged `anti_air` battery.
* **28** torpedo tubes as hull openings: 6 fore, 6 aft, 8 per side.
* **12** missile launchers: 10 ventral tubes in the keel, the eight-barrel box on
  the aft deckhouse, and the funnel launcher (煙突ミサイル).
* the **third bridge** (第三艦橋) hangs BELOW the hull under the command tower,
  the two auxiliary engines flank the main bells, and the aft aircraft deck
  carries the catapult and its elevator.
* the main wings are modelled **folded** against the flanks: SPEC §5 rule 7 pins
  the model's X extent to `beamM`, so a deployed 60 m delta wing would break the
  contract for every consumer that reads `beamM`.

## Surface detail (task-7 pass)

Each hull carries a detail pass applied after the silhouette is built:

* **Transverse seams** - raised ribs wrapping the hull every ~10-14% of length,
  plus **longitudinal strakes** that follow the hull taper, and a **raised armour
  belt** framed by two ribs so it reads as an inset plate.
* **Window rows** - evenly spaced `glass_blue` windows along both hull sides and
  glazed grids on the bridge tiers, deckhouses and island faces.
* **Fittings** - deck hatches, lifeboat/vehicle bays, deck cranes, sensor domes,
  vent banks, cable runs, antenna clusters and navigation lights.
* **Machinery** - turrets have a barbette ring (so they sit *into* the deck), a
  flared skirt, a sloped gun house, an inset roof plate and a mantlet; barrels
  are stepped with a breech jacket and a muzzle step; engine bells have an inner
  throat, a vane ring, an actuator ring and a glow disc.

**Legibility floor.** The chase camera sits ~355 m behind the ship, where one
pixel is roughly 0.17 m, so the helpers clamp every feature up to a minimum
relief and size (`RELIEF = 1.022`, `MIN_SEAM`, `MIN_WINDOW`, ...).  Enlarging a
box or a ribbon costs no extra triangles, which is why the detail reads without
blowing the 12 000-triangle budget.  The hull loft is inset by `RELIEF` so the
painted band and the raised seams - not the bare hull - land exactly on
`beamM / 2`.

## Faction identity (what to look for)

* **UNCF** - grey hulls with a red waterline band and cyan drive glow. Yamato
  (2199 rebuild): raked clipper bow with the WM-gun muzzle proud of it and
  missile ports flanking it, rocket anchors either side, three triple 48 cm
  turrets (2 fore superfiring / 1 aft), **two centreline 20 cm triples**, a
  pagoda tower whose **third bridge hangs below the hull**, a funnel that is
  itself a missile launcher, 28 torpedo ports flush in the plating, the 40-mount
  pulse-laser battery in sponsons along both flanks, folded delta main wings,
  two auxiliary engine bells and the aft aircraft deck with its catapult.
  Andromeda: broad flat bow
  with **twin** WM-gun muzzles, four triple turrets, one large + four medium
  nozzles. Kirishima: a fixed gun **barrel protruding** from the bow, squat
  bridge at station 0.35. Yukikaze: the 艦首装甲翼 bow armour wing - a flat plate
  with six triangular fins - plus drop tanks, yellow/red/white paint.
* **Garmillas** - green/olive faceted hulls, amber drive glow, domed dorsal gun
  mounts, fin banks. Dessler (Deusura II): wide flattened arrowhead with a
  recessed Desler cannon, separable core ship with a visible docking seam.
  Kelkapia: slim teardrop with a dorsal fin ridge and a pointed stern. Gaiderol:
  the tall one - a vertical blade hull under a very tall citadel ringed by CIWS.
* **Bolar** - purple-blue hulls with white line accents and **red** drive glow.
  Ganonda carrier: spindle hull with large swept lateral fins, a full-length
  red-glowing flight deck with a stern landing aperture, island at the very
  stern, wide horizontal Bolar cannon slab in the bow.

## Provenance

Every file in this directory is named by `manifest.json` (`obj` / `mtl`), except
`manifest.json` itself and this README.
